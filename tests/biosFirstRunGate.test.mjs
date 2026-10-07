/**
 * C5 正式回归：**不依赖 BIOS 右栏**的首次接入提议。
 *
 * 复现的问题：右栏关闭时接入卡 0 个，接入完全依赖用户先打开 BIOS 抽屉。
 * 这里用真实组件源码 + 桩化的 hook/IPC 断言四件事：
 * 1. 有未绑定项目 ⇒ 出卡；已精确绑定 ⇒ 不出卡（无需再点）；
 * 2. 卡上必须显示**实际目录、知识根、当前端点策略**（端点不静默改成 allowed）；
 * 3. 自动化是勾选项，取消不写入任何东西（取消走 hook 的 cancel）；
 * 4. 确认后必须给出**运行时回执**：待重开时提供一键重开入口。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const jsx = (type, props) => ({ type, props });
const jsxs = jsx;

/** 深度优先找节点（按 testid 或类型标记）。 */
function findNode(node, predicate) {
	if (node === null || node === undefined || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const child of node) {
			const found = findNode(child, predicate);
			if (found !== null) return found;
		}
		return null;
	}
	if (predicate(node)) return node;
	for (const value of Object.values(node.props ?? {})) {
		const found = findNode(value, predicate);
		if (found !== null) return found;
	}
	return null;
}

const byTestId = (id) => (node) => node?.props?.["data-testid"] === id;

/** 收集整棵树的可见文本（桩化 i18n 下就是键名）。 */
function textOf(node, out = []) {
	if (node === null || node === undefined) return out;
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (Array.isArray(node)) {
		for (const child of node) textOf(child, out);
		return out;
	}
	if (typeof node === "object") for (const value of Object.values(node.props ?? {})) textOf(value, out);
	return out;
}

function render(onboarding, settings = { knowledgeRoot: "/synthetic/kb", endpoint: "unknown", automation: { enabled: false } }, extra = {}) {
	const endpointFacts = extra.endpointFacts ?? { provider: null, modelId: null, modelName: null };
	const { BiosFirstRunGate } = loadTsCommonJs("src/renderer/src/components/bios/BiosFirstRunGate.tsx", {
		stubs: {
			react: { useState: (initial) => [typeof initial === "function" ? initial() : initial, () => undefined], useEffect: (effect) => void effect() },
			jotai: { useAtomValue: (atom) => (atom === "onboarding-request" ? null : (endpointFacts.sessionId ?? undefined)), useSetAtom: () => () => undefined },
			"../../atoms/session-atoms": { currentSessionIdAtom: "session-id" },
			"../../atoms/bios-ui-atoms": { biosOnboardingRequestAtom: "onboarding-request" },
			"react/jsx-runtime": { jsx, jsxs, Fragment: "Fragment" },
			"../../i18n": { t: (key) => key },
			"../../desktopApi": { desktopApi: { bios: { getSettings: async () => settings } } },
			"../../hooks/useBiosOnboarding": { useBiosOnboarding: () => onboarding },
			// D4：实际模型端点事实来自渲染层已有的 runtime 快照（桩化，测试不读真实会话）。
			"../../hooks/useBiosEndpointFacts": { useBiosEndpointFacts: () => endpointFacts },
			"../ui-shadcn/button": { Button: "Button" },
			"../ui-shadcn/checkbox": { Checkbox: "Checkbox" },
			"../ui-shadcn/input": { Input: "Input" },
			"../ui-shadcn/dialog": { Dialog: "Dialog", DialogContent: "DialogContent", DialogTitle: "DialogTitle" },
		},
	});
	return BiosFirstRunGate({ desktopProjectId: "desktop-1", desktopProjectName: "Board A", onRestartRuntime: () => undefined, ...extra });
}

const baseForm = (overrides = {}) => ({
	phase: "review",
	name: "Board A",
	automation: true,
	confirmed: false,
	// D4：端点外发授权默认未勾选。
	endpointConsent: false,
	busy: false,
	problem: null,
	result: null,
	preview: null,
	prepare: () => undefined,
	confirm: async () => null,
	cancel: () => undefined,
	setName: () => undefined,
	setConfirmed: () => undefined,
	setAutomation: () => undefined,
	setEndpointConsent: () => undefined,
	hint: "hint",
	...overrides,
});

const newPreview = { token: "t1", desktopProjectId: "desktop-1", biosProjectId: "bios-1", displayName: "Board A", workspacePath: "C:\\synthetic\\BoardA", knowledgeRoot: "C:\\synthetic\\kb", existing: false, rootAction: "reuse", endpoint: "unknown", expiresAt: 0 };

test("F3: legacy unbound allowed policy is described as compatibility, not falsely denied", () => {
	const endpointFacts = { provider: "mock", modelId: "new-model", endpointOrigin: "https://api.mock.invalid", agentId: "a", sessionId: "s", generation: 1 };
	const legacy = { ...newPreview, existing: true, authorized: false, endpoint: "allowed", endpointGrant: null, service: { provider: "mock", modelId: "new-model", origin: "https://api.mock.invalid" } };
	const card = render(baseForm({ preview: legacy }), undefined, { endpointFacts });
	assert.ok(textOf(card).includes("bios.firstRun.endpointLegacyHint"));
	assert.equal(findNode(card, byTestId("bios-first-run-endpoint-not-allowed")), null);
	assert.equal(findNode(card, byTestId("bios-first-run-endpoint-consent")).props.checked, false);
	assert.equal(render(baseForm({ preview: { ...legacy, authorized: true } }), undefined, { endpointFacts }), null, "an already connected legacy policy must not produce duplicate consent prompts");
});

test("F3: an existing project exposes service-only reauthorization after model switch", () => {
	const endpointFacts = { provider: "mock", modelId: "new-model", modelName: "New model", endpointOrigin: "https://api.mock.invalid", agentId: "a", sessionId: "s", generation: 1 };
	const existing = { ...newPreview, existing: true, authorized: true, endpoint: "allowed", endpointGrant: { provider: "mock", modelId: "old-model", origin: "https://api.mock.invalid", version: 1 }, service: { provider: "mock", modelId: "new-model", origin: "https://api.mock.invalid" } };
	const card = render(baseForm({ preview: existing }), undefined, { endpointFacts });
	assert.notEqual(card, null, "existing project binding must not hide changed-service consent");
	assert.ok(findNode(card, byTestId("bios-first-run-endpoint-consent")));
	assert.equal(findNode(card, byTestId("bios-first-run-consent")), null, "do not ask to authorize project again");
	assert.equal(findNode(card, byTestId("bios-first-run-automation")), null, "do not re-grant automation");
	assert.equal(card.type, "Dialog", "service consent uses the same single root modal");
	const receipt = render(baseForm({ result: { status: "completed", preview: existing, binding: null, authorization: null, problem: null } }), undefined, { endpointFacts: { provider: null, modelId: null } });
	assert.equal(findNode(receipt, (node) => node.type === "DialogTitle").props.children, "bios.firstRun.serviceTitle", "saved service receipt must not ask to onboard the project again");
});

test("D4：外发确认文案如实说明许可绑定具体模型服务（不再宣称切换模型后仍有效）", () => {
	const { zhCN } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.zh-CN.ts");
	const { enUS } = loadTsCommonJs("src/renderer/src/i18n/rendererCopy.en-US.ts");
	// §13.4.2：授权从"全局开关"改成"绑定实际 provider/model/API 地址"，
	// 文案必须说清"切换模型或地址后需要重新确认"，不能沿用旧的"全局策略"说法。
	assert.match(zhCN["bios.firstRun.endpointConsent"], /当前实际模型服务/);
	assert.match(zhCN["bios.firstRun.endpointConsent"], /重新确认/);
	assert.doesNotMatch(zhCN["bios.firstRun.endpointConsent"], /切换模型后仍有效/);
	assert.match(enUS["bios.firstRun.endpointConsent"], /current model service/i);
	assert.match(enUS["bios.firstRun.endpointConsent"], /confirming again/i);
	assert.doesNotMatch(enUS["bios.firstRun.endpointConsent"], /still applies after switching models/i);
	// 读不到真实模型服务时不得勾选，卡上要有明确说明。
	assert.ok(typeof zhCN["bios.firstRun.endpointConsentNeedsSession"] === "string" && zhCN["bios.firstRun.endpointConsentNeedsSession"].length > 0);
	assert.ok(typeof enUS["bios.firstRun.endpointConsentNeedsSession"] === "string" && enUS["bios.firstRun.endpointConsentNeedsSession"].length > 0);
	// 旧许可与当前服务不一致时必须明确说明（含占位符）。
	assert.match(zhCN["bios.firstRun.endpointGrantStale"], /\{granted\}/);
	assert.match(zhCN["bios.firstRun.endpointGrantStale"], /\{current\}/);
	assert.match(enUS["bios.firstRun.endpointGrantStale"], /\{granted\}/);
	assert.match(enUS["bios.firstRun.endpointGrantStale"], /\{current\}/);
});

test("C5：未绑定项目 ⇒ 根级出卡；已精确绑定 ⇒ 不出卡", () => {
	const card = render(baseForm({ preview: newPreview }));
	assert.notEqual(card, null, "未绑定项目必须出现接入卡");
	assert.ok(findNode(card, byTestId("bios-first-run-endpoint")) !== null, "卡上必须有端点策略行");

	const bound = render(baseForm({ preview: { ...newPreview, existing: true, authorized: true } }));
	assert.equal(bound, null, "已精确绑定的项目不应再要求确认");

	const idle = render(baseForm());
	assert.equal(idle, null, "没有提议/回执时不应出现浮层");

	assert.equal(card.type, "Dialog", "opening the drawer no longer relocates or duplicates this owner");
	assert.equal(findNode(card, byTestId("bios-first-run")).type, "DialogContent");
});

test("C5：卡上显示实际目录、知识根与**当前**端点策略（不静默改为 allowed）", () => {
	const card = render(baseForm({ preview: newPreview }));
	const text = textOf(card).join("\n");
	assert.ok(text.includes("C:\\synthetic\\BoardA"), `必须显示实际目录：${text}`);
	assert.ok(text.includes("C:\\synthetic\\kb"), "必须显示知识根");
	assert.ok(text.includes("bios.firstRun.endpoint"), "必须有端点策略标题");
	assert.ok(text.includes("bios.firstRun.endpointHint"), "必须说明不会自动改成允许外发");
	// 自动化是勾选项（默认勾选），不是隐含行为。
	const automation = findNode(card, byTestId("bios-first-run-automation"));
	assert.ok(automation !== null, "必须有自动化勾选项");
	assert.equal(automation.props.checked, true, "默认勾选（一次合并授权）");
	// 自动提议 ≠ 自动放行：必要授权必须由人勾选，未勾选时确认按钮不可用。
	const consent = findNode(card, byTestId("bios-first-run-consent"));
	assert.ok(consent !== null, "必须有显式授权勾选");
	assert.equal(consent.props.checked, false, "授权勾选默认必须为未勾选");
	const confirmButton = findNode(card, (node) => node?.type === "Button" && JSON.stringify(node.props?.children) === '"bios.onboarding.confirm"');
	assert.equal(confirmButton?.props?.disabled, true, "未勾选授权时确认按钮必须不可用");
	// 取消按钮存在（可取消，不写任何东西）。
	assert.ok(findNode(card, (node) => node?.type === "Button" && JSON.stringify(node.props?.children) === '"bios.onboarding.cancel"') !== null, "必须有取消入口");
});

test("D4：卡上显示**当前实际模型**（读不到要说读不到），端点外发默认未勾选", () => {
	const withModel = render(baseForm({ preview: newPreview }), undefined, { endpointFacts: { provider: "anthropic", modelId: "claude-synthetic", modelName: "Synthetic", endpointOrigin: "https://api.synthetic.test" } });
	const shown = textOf(findNode(withModel, byTestId("bios-first-run-model"))).join("");
	assert.ok(shown.includes("anthropic"), `必须显示真实 provider：${shown}`);
	assert.ok(shown.includes("claude-synthetic"), `必须显示真实 modelId：${shown}`);
	assert.ok(
		textOf(findNode(withModel, byTestId("bios-first-run-endpoint-origin")))
			.join("")
			.includes("https://api.synthetic.test"),
		"必须展示 Pi 运行时报告的安全端点地址",
	);

	// 没有运行中会话：如实显示"读不到"，不能用策略枚举冒充实际模型。
	const noModel = render(baseForm({ preview: newPreview }));
	assert.ok(
		textOf(findNode(noModel, byTestId("bios-first-run-model")))
			.join("")
			.includes("bios.firstRun.actualModelUnknown"),
		"读不到实际模型时必须如实说明",
	);

	// D4：端点外发是显式勾选，默认**未勾选**；不勾选就不会被改成 allowed。
	const endpointConsent = findNode(withModel, byTestId("bios-first-run-endpoint-consent"));
	assert.ok(endpointConsent !== null, "必须有端点外发显式授权勾选");
	assert.equal(endpointConsent.props.checked, false, "端点外发授权默认必须未勾选");
	// 当前策略 unknown：卡上必须说清"知识能力暂不可用，普通开发继续"。
	assert.ok(textOf(withModel).join("\n").includes("bios.firstRun.endpointNotAllowed"), "未授权外发时必须说明哪些能力不可用");
});

test("D4：回执按真实终结结果区分 completed / 未完成/停止失败", () => {
	const partial = { status: "partial", preview: newPreview, authorization: { settings: {}, runtime: { pendingRestart: false, stopFailures: [{ agentId: "a", error: "synthetic stop failure" }] } }, binding: null, problem: "绑定未提交" };
	const card = render(baseForm({ preview: null, result: partial }));
	const text = textOf(card).join("\n");
	assert.ok(text.includes("bios.firstRun.partial"), `未全部完成时不得显示"已接入"：${text}`);
	assert.ok(!text.includes("bios.firstRun.done"), "未全部完成时不得出现完成文案");
	assert.ok(text.includes("bios.workbench.runtimeStopFailures"), "旧会话停止失败必须如实显示");
	assert.ok(text.includes("binding未提交") || text.includes("绑定未提交"), "必须显示真实问题");
	// 端点被拒绝：必须说明能力边界。
	const denied = render(baseForm({ preview: { ...newPreview, endpoint: "denied" } }));
	assert.ok(textOf(denied).join("\n").includes("bios.firstRun.endpointDenied"), "必须显示真实的拒绝策略");
});

test("C5：确认后给出运行时回执；待重开时提供一键重开入口", () => {
	const result = { status: "completed", preview: newPreview, authorization: { settings: {}, runtime: { pendingRestart: true, stopFailures: [] } }, binding: null, problem: null };
	const card = render(baseForm({ preview: null, result }));
	const text = textOf(card).join("\n");
	assert.ok(text.includes("bios.firstRun.done"), "必须显示接入完成");
	assert.ok(text.includes("bios.firstRun.runtimePending"), `必须如实说明当前会话仍按旧配置运行：${text}`);
	assert.ok(findNode(card, byTestId("bios-first-run-restart")) !== null, "必须提供一键重开入口（不要求用户自己去设置页手工重开）");

	const applied = render(baseForm({ preview: null, result: { ...result, authorization: { settings: {}, runtime: { pendingRestart: false, stopFailures: [] } } } }));
	assert.ok(textOf(applied).join("\n").includes("bios.firstRun.runtimeApplied"), "无需重开时必须如实说明已生效");
});
