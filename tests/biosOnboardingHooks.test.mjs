import test from "node:test";
import assert from "node:assert/strict";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const preview = { token: "preview-a", desktopProjectId: "desktop-a", displayName: "Detected name" };
const result = { status: "completed", preview };

test("F3 hook: selecting a new cold session prepares once even with the same empty service", async () => {
	let prepares = 0;
	const initial = { desktopProjectId: "desktop-a", sessionId: undefined, serviceKey: "", autoPrepare: true };
	const h = biosHookHarness("src/renderer/src/hooks/useBiosOnboarding.ts", "useBiosOnboarding", initial, {
		prepareOnboarding: async () => {
			prepares++;
			return preview;
		},
	});
	await h.flush();
	assert.equal(prepares, 1);
	h.setProps({ ...initial, sessionId: "s-a" });
	await h.flush();
	assert.equal(prepares, 2);
	assert.equal(h.current.preview, preview);
	h.current.cancel();
	await h.flush();
	assert.equal(prepares, 2, "cancelled consent must not immediately reopen");
});

test("F3 hook: own runtime stop preserves the save receipt, but another session invalidates it", async () => {
	for (const switched of [false, true]) {
		const pending = deferred();
		const initial = { desktopProjectId: "desktop-a", sessionId: "s-a", serviceKey: "model-a", serviceRef: { agentId: "a", sessionId: "s-a", generation: 1 } };
		const h = biosHookHarness("src/renderer/src/hooks/useBiosOnboarding.ts", "useBiosOnboarding", initial, { prepareOnboarding: async () => preview, completeOnboarding: () => pending.promise });
		await h.flush();
		await h.current.prepare();
		await h.flush();
		h.current.setConfirmed(true);
		await h.flush();
		const completing = h.current.confirm();
		h.setProps({ ...initial, sessionId: switched ? "s-b" : "s-a", serviceKey: "", serviceRef: null });
		await h.flush();
		pending.resolve(result);
		assert.equal(await completing, switched ? null : result);
		await h.flush();
		assert.equal(h.current.result, switched ? null : result);
		assert.equal(h.current.confirmed, false);
		assert.equal(h.current.preview, null);
	}
});

test("F3 hook: service changes clear checked consent and reject stale preview/completion", async () => {
	const pending = deferred();
	const firstRef = { agentId: "a", sessionId: "s", generation: 1 };
	const h = biosHookHarness(
		"src/renderer/src/hooks/useBiosOnboarding.ts",
		"useBiosOnboarding",
		{ desktopProjectId: "desktop-a", autoPrepare: true, serviceRef: firstRef, serviceKey: "model-a" },
		{
			prepareOnboarding: async (request) => {
				assert.equal(request.serviceRef.agentId, "a");
				return preview;
			},
			completeOnboarding: () => pending.promise,
		},
	);
	await h.flush();
	await h.flush();
	h.current.setEndpointConsent(true);
	h.current.setConfirmed(true);
	await h.flush();
	const completing = h.current.confirm();
	h.setProps({ desktopProjectId: "desktop-a", autoPrepare: true, serviceRef: firstRef, serviceKey: "model-b" });
	await h.flush();
	pending.resolve(result);
	assert.equal(await completing, null, "late save receipt must not claim a different service is allowed");
	await h.flush();
	assert.equal(h.current.endpointConsent, false);
	assert.equal(h.current.result, null);
});

test("F3 hook: service-only confirmation omits automation and project reauthorization", async () => {
	let request;
	const existing = { ...preview, existing: true, authorized: true };
	const h = harness({
		prepareOnboarding: async () => existing,
		completeOnboarding: async (input) => {
			request = input;
			return result;
		},
	});
	await h.flush();
	await h.current.prepare();
	await h.flush();
	h.current.setEndpointConsent(true);
	await h.flush();
	await h.current.confirm();
	assert.equal(request.serviceOnly, true);
	assert.equal(request.automation, undefined);
	assert.equal(request.endpointConsent, true);
});

test("AW 接入回执：迟到的同配置通知不抹掉成功；撤权、切项目和迟到读取不保留旧回执", async () => {
	const settings = { knowledgeRoot: "D:\\Synthetic", endpoint: "allowed", authorizedProjectIds: ["bios-a"] };
	const completed = { ...result, authorization: { settings } };
	let readSettings = async () => settings;
	const h = harness({ prepareOnboarding: async () => preview, completeOnboarding: async () => completed, getSettings: () => readSettings() });
	await h.flush();
	await h.current.prepare();
	await h.flush();
	h.current.setConfirmed(true);
	await h.flush();
	await h.current.confirm();
	await h.flush();
	h.changed();
	await h.flush();
	assert.equal(h.current.result, completed, "通知晚于 IPC 回应到达，仍应显示本次保存回执");
	const pending = deferred();
	readSettings = () => pending.promise;
	h.changed();
	readSettings = async () => ({ ...settings, endpoint: "denied" });
	h.changed();
	await h.flush();
	assert.equal(h.current.result, null, "真正撤权不能继续显示旧配置回执");
	pending.resolve(settings);
	await h.flush();
	assert.equal(h.current.result, null, "较早的相同配置读取不能恢复已失效回执");
	await h.current.prepare();
	await h.flush();
	h.current.setConfirmed(true);
	await h.flush();
	await h.current.confirm();
	await h.flush();
	const other = deferred();
	readSettings = () => other.promise;
	h.changed();
	h.setProps({ desktopProjectId: "desktop-b" });
	other.resolve(settings);
	await h.flush();
	assert.equal(h.current.result, null, "不能把旧项目的回执带入新项目");
});
function harness(api) {
	return biosHookHarness("src/renderer/src/hooks/useBiosOnboarding.ts", "useBiosOnboarding", { desktopProjectId: "desktop-a" }, api);
}

test("UX-03 hook: prefill is not consent; cancel does not complete; double submit is suppressed", async () => {
	let writes = 0;
	const pending = deferred();
	const h = harness({
		prepareOnboarding: async () => preview,
		completeOnboarding: async (request) => {
			writes++;
			// AW-01：主确认按钮默认同时提交自动化许可（受限普通记账 + 本项目资料注入）；
			// 取消勾选后退化为旧请求体（见下一个用例）。
			assert.deepEqual(JSON.parse(JSON.stringify(request)), { token: preview.token, confirmed: true, displayName: "Edited", automation: { localBookkeeping: true, injectProjectData: true } });
			return pending.promise;
		},
	});
	await h.flush();
	await h.current.prepare();
	await h.flush();
	assert.equal(h.current.name, "Detected name");
	assert.equal(h.current.confirmed, false);
	await h.current.confirm();
	assert.equal(writes, 0);
	h.current.cancel();
	await h.flush();
	assert.equal(h.current.preview, null);
	await h.current.prepare();
	await h.flush();
	h.current.setName("Edited");
	h.current.setConfirmed(true);
	await h.flush();
	const first = h.current.confirm();
	await h.current.confirm();
	assert.equal(writes, 1);
	h.changed(); // own save broadcasts before IPC returns
	pending.resolve(result);
	await first;
	await h.flush();
	assert.equal(h.current.result, result);
	assert.equal(h.current.preview, null);
	h.changed();
	await h.flush();
	assert.equal(h.current.result, null);
});

test("R2 hook: autoPrepare 打开后宿主自动提议一次（不需要用户点预览），取消后不反复弹", async () => {
	let prepares = 0;
	const auto = biosHookHarness(
		"src/renderer/src/hooks/useBiosOnboarding.ts",
		"useBiosOnboarding",
		{ desktopProjectId: "desktop-a", autoPrepare: true },
		{
			prepareOnboarding: async () => {
				prepares++;
				return preview;
			},
			completeOnboarding: async () => result,
		},
	);
	await auto.flush();
	await auto.flush();
	assert.equal(prepares, 1, "项目打开后应自动提议一次");
	assert.equal(auto.current.preview?.token, preview.token, "提议应直接进入 review 状态");
	assert.equal(auto.current.confirmed, false, "自动提议不等于已授权：确认必须由人来做");
	// 取消后不得再自动弹（用户已明确拒绝这次提议）。
	auto.current.cancel();
	await auto.flush();
	await auto.flush();
	assert.equal(prepares, 1, "用户取消后不得反复自动提议");
	assert.equal(auto.current.preview, null);
	auto.changed();
	await auto.flush();
	assert.equal(prepares, 1, "配置/撤权通知不能把用户刚取消的接入提议重新弹出");
	await auto.current.prepare();
	await auto.flush();
	assert.equal(prepares, 2, "用户仍能从唯一入口显式重试");

	const manual = biosHookHarness("src/renderer/src/hooks/useBiosOnboarding.ts", "useBiosOnboarding", { desktopProjectId: "desktop-a" }, { prepareOnboarding: async () => preview, completeOnboarding: async () => result });
	await manual.flush();
	await manual.flush();
	assert.equal(manual.current.preview, null, "未开启 autoPrepare 时保持旧行为（等待用户点预览）");
});

test("AW-01 hook: 取消勾选自动化后退化到旧请求体（只接入、不开启自动记忆）", async () => {
	let captured = null;
	const h = harness({
		prepareOnboarding: async () => preview,
		completeOnboarding: async (request) => {
			captured = JSON.parse(JSON.stringify(request));
			return result;
		},
	});
	await h.flush();
	await h.current.prepare();
	await h.flush();
	assert.equal(h.current.automation, true, "默认应勾选自动化（一次合并授权）");
	h.current.setAutomation(false);
	h.current.setConfirmed(true);
	await h.flush();
	await h.current.confirm();
	await h.flush();
	assert.deepEqual(captured, { token: preview.token, confirmed: true, displayName: "Detected name" });
});

test("UX-03 analysis callback: protects existing input and wrong project/session; only prepares a draft", () => {
	const sessionAtoms = { currentSessionIdAtom: "session", sessionRecordsAtom: "records" };
	const draftAtoms = { sessionDraftByIdAtom: "drafts", setSessionDraftAtom: "set" };
	const values = new Map([
		["session", "s-a"],
		["records", { "s-a": { projectId: "desktop-a" } }],
		["drafts", {}],
	]);
	const writes = [];
	let hint;
	const jsx = (type, props) => ({ type, props });
	const Button = "SyntheticButton";
	const { BiosAnalysisDraftButton } = loadTsCommonJs("src/renderer/src/components/bios/BiosAnalysisDraftButton.tsx", {
		stubs: {
			react: {
				useState: () => [
					null,
					(next) => {
						hint = next;
					},
				],
			},
			"react/jsx-runtime": { jsx, jsxs: jsx },
			jotai: { useStore: () => ({ get: (key) => values.get(key), set: (key, payload) => writes.push({ key, payload: JSON.parse(JSON.stringify(payload)) }) }) },
			"../../atoms/session-atoms": sessionAtoms,
			"../../atoms/composer-atoms": draftAtoms,
			"../ui-shadcn/button": { Button },
			"../../i18n": { t: (key, data) => (data ? `${key}:${data.projectId}` : key) },
		},
	});
	const tree = BiosAnalysisDraftButton({ desktopProjectId: "desktop-a", biosProjectId: "bios-a" });
	const click = tree.props.children.find((child) => child?.type === Button).props.onClick;
	values.set("drafts", { "s-a": "User text" });
	click();
	assert.equal(writes.length, 0);
	assert.match(hint, /DraftBusy/);
	values.set("drafts", {});
	values.set("records", { "s-a": { projectId: "another-project" } });
	click();
	assert.equal(writes.length, 0);
	assert.match(hint, /NoSession/);
	values.set("session", undefined);
	click();
	assert.equal(writes.length, 0);
	values.set("session", "s-a");
	values.set("records", { "s-a": { projectId: "desktop-a" } });
	click();
	assert.deepEqual(writes, [{ key: "set", payload: { sessionId: "s-a", value: 'bios.onboarding.analysisPrompt:"bios-a"' } }]);
	assert.match(hint, /Prepared/);
});

test("UX-03 labels: human names are presentation only; legacy entries fall back to short ID", () => {
	const { biosProjectLabel } = loadTsCommonJs("src/renderer/src/utils/biosProjectLabel.ts");
	assert.equal(biosProjectLabel({ projectId: "12345678-legacy", displayName: " Board A " }), "Board A");
	assert.equal(biosProjectLabel({ projectId: "12345678-legacy" }), "12345678");
	assert.equal(biosProjectLabel({ projectId: "12345678-legacy", displayName: " " }), "12345678");
});

test("UX-03 hook: late preview after project/config changes cannot appear in new scope", async () => {
	for (const mode of ["project", "config", "unmount"]) {
		const pending = deferred();
		const h = harness({ prepareOnboarding: () => pending.promise });
		await h.flush();
		const action = h.current.prepare();
		if (mode === "project") h.setProps({ desktopProjectId: "desktop-b" });
		if (mode === "config") h.changed();
		if (mode === "unmount") h.unmount();
		pending.resolve(preview);
		await action;
		await h.flush();
		assert.equal(h.current.preview, null);
	}
});

test("UX-03 hook: late completion after project switch is not shown as another project's success", async () => {
	const pending = deferred();
	const h = harness({ prepareOnboarding: async () => preview, completeOnboarding: () => pending.promise });
	await h.flush();
	await h.current.prepare();
	await h.flush();
	h.current.setConfirmed(true);
	await h.flush();
	const action = h.current.confirm();
	h.setProps({ desktopProjectId: "desktop-b" });
	pending.resolve(result);
	assert.equal(await action, null);
	await h.flush();
	assert.equal(h.current.result, null);
});
