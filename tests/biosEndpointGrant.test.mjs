/**
 * D4（`docs/bios-agent/test_checklist.md`（历史编号保留））：**具名端点许可**的宿主侧正式回归。
 *
 * 复现的问题：原来的 `endpoint: "allowed"` 只表达"允许外发"，没有绑定**具体的** provider/model/API
 * 服务——用户换模型或改 baseUrl 后旧许可仍然有效（§13.3 的缺口）。这里的断言覆盖：
 * - 归一化只接受**完整**身份，且只接受 HTTP(S) 源的写法（拒绝把路径/凭据/query 写进配置）；
 * - 撤权（策略不是 allowed）时许可必须一并清掉；
 * - 子进程 env 里 `BIOS_ENDPOINT_GRANT` 与可信配置同源（缺省写空串，不继承旧值）；
 * - 接入确认**必须**核对真实运行态：缺失/不匹配的会话引用一律**不授权**（返回失败，不写 allowed）；
 * - 渲染层伪造身份字段不能进许可（只接受"哪一栏会话"的引用）。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const envMod = () => loadTsCommonJs("src/main/bios/biosProcessEnv.ts");

test("D4：具名许可归一化只接受完整、只含 HTTP(S) 源的身份；撤权时一并清掉", () => {
	const { normalizeBiosHostSettings, normalizeEndpointGrant } = envMod();
	const base = { knowledgeRoot: "D:\\kb", endpoint: "allowed" };
	const complete = { provider: "mock", modelId: "mock-model", origin: "https://api.example.com", version: 2 };
	assert.deepEqual(JSON.parse(JSON.stringify(normalizeBiosHostSettings({ ...base, endpointGrant: complete }).endpointGrant)), complete);
	// 半截身份一律丢弃（看起来已绑定、其实管不住的许可比没有更危险）。
	assert.equal(normalizeEndpointGrant({ provider: "mock", modelId: "mock-model", version: 1 }), null, "缺 origin");
	assert.equal(normalizeEndpointGrant({ provider: "mock", origin: "https://api.example.com", version: 1 }), null, "缺 modelId");
	assert.equal(normalizeEndpointGrant({ provider: "mock", modelId: "m", origin: "https://api.example.com", version: 0 }), null, "版本必须为正");
	// 只接受"源"：带路径 / 凭据 / query / 非 HTTP(S) 一律拒绝。
	assert.equal(normalizeEndpointGrant({ provider: "m", modelId: "m", origin: "https://api.example.com/v1", version: 1 }), null, "带路径");
	assert.equal(normalizeEndpointGrant({ provider: "m", modelId: "m", origin: "https://user:pass@api.example.com", version: 1 }), null, "带凭据");
	assert.equal(normalizeEndpointGrant({ provider: "m", modelId: "m", origin: "https://api.example.com?k=v", version: 1 }), null, "带 query");
	assert.equal(normalizeEndpointGrant({ provider: "m", modelId: "m", origin: "file:///etc/passwd", version: 1 }), null, "非 HTTP(S)");
	// 不变式：策略不是 allowed 时许可无意义 ⇒ 一并清掉（撤权后不残留旧许可）。
	assert.equal(normalizeBiosHostSettings({ ...base, endpoint: "unknown", endpointGrant: complete }).endpointGrant, null);
	assert.equal(normalizeBiosHostSettings({ ...base, endpoint: "denied", endpointGrant: complete }).endpointGrant, null);
});

test("D4：子进程 env 的 BIOS_ENDPOINT_GRANT 与可信配置同源（缺省写空串，清掉继承值）", () => {
	const { biosProcessEnv, applyBiosEnv, BIOS_CONFIG_ENV_KEYS } = envMod();
	assert.ok(BIOS_CONFIG_ENV_KEYS.includes("BIOS_ENDPOINT_GRANT"), "新增配置键必须登记在权威键清单里（否则旧值会继承进来）");
	const settings = {
		knowledgeRoot: "D:\\kb",
		authorizedProjectIds: [],
		allowedFeatureIds: [],
		approvedCustomers: [],
		authorizedRoots: [],
		endpoint: "allowed",
		endpointGrant: { provider: "mock", modelId: "m", origin: "https://api.example.com", version: 4 },
		automation: { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 },
	};
	assert.equal(biosProcessEnv(settings).BIOS_ENDPOINT_GRANT, JSON.stringify(settings.endpointGrant));
	assert.equal(biosProcessEnv({ ...settings, endpointGrant: null }).BIOS_ENDPOINT_GRANT, "");
	const env = { BIOS_ENDPOINT_GRANT: "stale-value-from-previous-run" };
	applyBiosEnv(env, settings);
	assert.equal(env.BIOS_ENDPOINT_GRANT, JSON.stringify(settings.endpointGrant), "必须先清除旧值再写权威值");
	applyBiosEnv(env, { ...settings, endpointGrant: null });
	assert.equal(env.BIOS_ENDPOINT_GRANT, "", "没有绑定时必须显式写空串");
});

/** 造一个可用的接入服务（真实目录 + 可控运行态核对）。 */
async function onboardingFixture(options = {}) {
	const base = await mkdtemp(join(tmpdir(), "bios-endpoint-grant-"));
	const workspace = join(base, "BoardA");
	await mkdir(workspace, { recursive: true });
	const knowledgeRoot = join(base, "kb");
	const settings = { knowledgeRoot: null, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "unknown", endpointGrant: null, automation: { enabled: false, localBookkeeping: false, injectProjectData: false, version: 0 } };
	const patches = [];
	// 注册表/路径解析用桩：本用例只验证"许可绑定与核对"，不重复知识库 IO（那由别的用例覆盖）。
	const { BiosOnboardingService } = loadTsCommonJs("src/main/bios/BiosOnboardingService.ts", {
		stubs: {
			"../../../packages/bios-agent/core/storage/registry.ts": {
				readRegistry: async () => ({ revision: 1, projects: [] }),
				resolveProjectBinding: () => (options.existing ? { status: "resolved", project: { biosProjectId: "existing-project", displayName: "Board A", desktopProjectId: "desktop-1" } } : { status: "unbound" }),
			},
			"../../../packages/bios-agent/core/paths.ts": { requireFullyQualifiedRoot: (value) => value },
		},
	});
	const service = new BiosOnboardingService({
		readSettings: () => settings,
		readConfigurationVersion: () => 1,
		resolveProject: () => ({ name: "Board A", path: workspace }),
		saveAuthorization: async (patch) => {
			patches.push(patch);
			Object.assign(settings, patch);
			return { settings, runtime: { configVersion: patches.length, pendingRestart: false, stoppedRuntimes: [], stopFailures: [], note: null } };
		},
		bindProject: async () => {
			if (options.existing) throw new Error("service-only must not rebind project");
			return { committed: true, guard: { stable: true, staleReason: null }, result: { status: "bound", problems: [] } };
		},
		resolveDefaultKnowledgeRoot: () => knowledgeRoot,
		initializeStore: async () => ({ ok: true, problem: null }),
		resolveService: options.resolveService ?? (async (ref) => (options.stopOnRootSave && patches.some((patch) => patch.knowledgeRoot != null) ? null : ref.agentId === "agent-1" && ref.generation === 7 && ref.sessionId === "s-1" ? { provider: "mock", modelId: "mock-model", origin: "https://api.mock.invalid" } : null)),
	});
	return { base, workspace, knowledgeRoot, settings, patches, service, cleanup: () => rm(base, { recursive: true, force: true }) };
}

const liveRef = { agentId: "agent-1", sessionId: "s-1", generation: 7 };

test("F3: first root save intentionally stops the runtime but keeps the explicitly reviewed grant", async () => {
	const f = await onboardingFixture({ stopOnRootSave: true });
	try {
		const preview = await f.service.prepare("desktop-1", liveRef);
		const result = await f.service.complete({ token: preview.token, confirmed: true, endpointConsent: true, serviceRef: liveRef });
		assert.equal(result.status, "completed", result.problem);
		assert.equal(f.settings.endpointGrant.modelId, "mock-model");
		assert.equal(f.settings.endpointGrant.version, 1);
		assert.equal(f.patches[0].endpoint, "allowed", "root and reviewed grant are saved before intentionally stopping the old runtime");
	} finally {
		await f.cleanup();
	}
});

test("F3: service-only consent cannot expand revoked project/root/automation permissions", async () => {
	const f = await onboardingFixture({ existing: true });
	try {
		const preview = await f.service.prepare("desktop-1", liveRef);
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true, serviceOnly: true, endpointConsent: true, serviceRef: liveRef }), /只适用于已授权项目/);
		assert.equal(f.patches.length, 0);
	} finally {
		await f.cleanup();
	}
});
test("F3: service-only consent preserves project, roots, automation, and never rebinds", async () => {
	const f = await onboardingFixture({ existing: true });
	try {
		Object.assign(f.settings, { knowledgeRoot: f.knowledgeRoot, authorizedProjectIds: ["existing-project"], authorizedRoots: [f.workspace] });
		const before = JSON.stringify([f.settings.authorizedProjectIds, f.settings.authorizedRoots, f.settings.automation]);
		const preview = await f.service.prepare("desktop-1", liveRef);
		const outcome = await f.service.complete({ token: preview.token, confirmed: true, serviceOnly: true, endpointConsent: true, serviceRef: liveRef });
		assert.equal(outcome.status, "completed", outcome.problem);
		assert.equal(outcome.binding, null);
		assert.equal(f.patches.length, 1);
		assert.deepEqual(Object.keys(f.patches[0]).sort(), ["endpoint", "endpointGrant"]);
		assert.equal(JSON.stringify([f.settings.authorizedProjectIds, f.settings.authorizedRoots, f.settings.automation]), before);
	} finally {
		await f.cleanup();
	}
});

test("F3: model changes between preview and confirmation do not authorize unseen service", async () => {
	let modelId = "shown-model";
	const f = await onboardingFixture({ resolveService: async () => ({ provider: "mock", modelId, origin: "https://api.mock.invalid" }) });
	try {
		const preview = await f.service.prepare("desktop-1", liveRef);
		modelId = "unseen-model";
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true, endpointConsent: true, serviceRef: liveRef }), /模型服务已变化/);
		assert.equal(f.settings.endpoint, "unknown");
		assert.equal(f.patches.length, 0);
	} finally {
		await f.cleanup();
	}
});

test("D4：勾选外发时按**真实运行态**核对后写具名许可；版本只增不减", async () => {
	const f = await onboardingFixture();
	try {
		const first = await f.service.prepare("desktop-1", liveRef);
		assert.equal(first.endpoint, "unknown", "空白配置的预览必须如实显示当前策略");
		assert.equal(first.endpointGrant, null);
		const result = await f.service.complete({ token: first.token, confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: "s-1", generation: 7 } });
		assert.equal(result.status, "completed", JSON.stringify(result.problem));
		assert.equal(f.settings.endpoint, "allowed");
		assert.deepEqual(JSON.parse(JSON.stringify(f.settings.endpointGrant)), { provider: "mock", modelId: "mock-model", origin: "https://api.mock.invalid", version: 1 }, "许可必须来自主进程核对出的真实身份");
		// 第二次重新确认：仍是同一个服务 ⇒ 版本 +1（旧代次 runtime 据指纹失效，不会被复活）。
		const second = await f.service.prepare("desktop-1", liveRef);
		await f.service.complete({ token: second.token, confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: "s-1", generation: 7 } });
		assert.equal(f.settings.endpointGrant.version, 2);
	} finally {
		await f.cleanup();
	}
});

test("D4：核对不了运行态就不授权外发（缺引用 / 代次不匹配 / 会话不符）", async () => {
	const f = await onboardingFixture();
	try {
		const cases = [
			{ label: "缺会话引用", confirm: { confirmed: true, endpointConsent: true }, expected: /缺少可核对的会话引用/ },
			{ label: "代次不匹配", confirm: { confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: "s-1", generation: 8 } }, expected: /无法核对当前实际模型端点/ },
			{ label: "会话不符", confirm: { confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: "s-2", generation: 7 } }, expected: /无法核对当前实际模型端点/ },
			{ label: "未知 agent", confirm: { confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-9", sessionId: "s-1", generation: 7 } }, expected: /无法核对当前实际模型端点/ },
		];
		for (const item of cases) {
			const preview = await f.service.prepare("desktop-1");
			await assert.rejects(() => f.service.complete({ token: preview.token, ...item.confirm }), item.expected, item.label);
			assert.equal(f.settings.endpoint, "unknown", `${item.label}：核对不了时不得写 allowed`);
			assert.equal(f.settings.endpointGrant, null, `${item.label}：不得留下半截许可`);
		}
		// 未勾选时完全不碰策略（等价旧行为）。
		const plain = await f.service.prepare("desktop-1");
		const done = await f.service.complete({ token: plain.token, confirmed: true });
		assert.equal(done.status, "completed");
		assert.equal(f.settings.endpoint, "unknown");
		assert.equal(f.settings.endpointGrant, null);
	} finally {
		await f.cleanup();
	}
});

test("D4：接入 IPC 只接受『哪一栏会话』的引用；伪造的 provider/model/地址一律拒绝", async () => {
	const handlers = new Map();
	const calls = [];
	const channels = { biosPrepareOnboarding: "prepare", biosCompleteOnboarding: "complete" };
	const { registerBiosOnboardingIpc } = loadTsCommonJs("src/main/ipc/biosOnboardingIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, callback) => handlers.set(name, callback), removeHandler: (name) => handlers.delete(name) } },
			"../../shared/ipc": { ipcChannels: channels },
		},
	});
	const dispose = registerBiosOnboardingIpc({
		onboarding: {
			prepare: async () => ({ token: "t" }),
			complete: async (request) => {
				calls.push(request);
				return { status: "partial", authorization: null, binding: null };
			},
		},
		appLogger: { info() {} },
		onChanged() {},
	});
	try {
		await handlers.get("complete")({}, { token: "t", confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: null, generation: 7 } });
		assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { token: "t", confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: null, generation: 7 } });
		// 渲染层不能直接提交身份：多余字段必须被拒绝（许可只能由主进程按引用去读）。
		await assert.rejects(() => handlers.get("complete")({}, { token: "t", confirmed: true, endpointConsent: true, serviceRef: { agentId: "agent-1", sessionId: null, generation: 7, provider: "forged", modelId: "forged", origin: "https://evil.example.net" } }), /serviceRef 不接受字段/);
		await assert.rejects(() => handlers.get("complete")({}, { token: "t", confirmed: true, serviceRef: { agentId: "agent-1", sessionId: "s", generation: -1 } }), /serviceRef\.generation/);
		await assert.rejects(() => handlers.get("complete")({}, { token: "t", confirmed: true, serviceRef: { agentId: "agent-1", sessionId: 7, generation: 1 } }), /serviceRef\.sessionId/);
		assert.equal(calls.length, 1, "被拒绝的请求不得进入服务层");
	} finally {
		dispose();
		assert.equal(handlers.size, 0);
	}
});
