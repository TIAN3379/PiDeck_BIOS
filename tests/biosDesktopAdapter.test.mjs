/**
 * BM-07A C1 永久回归：**桌面只读适配服务**（不需要 Electron）。
 *
 * R33 之后这里的接口带**会话身份**（renderer 只能提交 SessionRef + 代次，主进程解析 cwd），
 * 更细的动态边界（末尾撤权、身份闸门、预算硬上限、按会话选择）在 `biosHardening.test.mjs`。
 * 本文件守住 C1 的基本契约：
 * - 缺省即拒绝（缺知识根/空授权 ⇒ 未就绪，不读取）；
 * - 只列**已授权**项目/任务（未授权项目连 ID 都不出现）；
 * - 桌面展示与"模型可发送视图"分开：deny/unknown 时 `maySendToModel=false` 且正文被撤回；
 * - 未授权项目预览直接拒绝；假身份/迟到代次被拒绝；
 * - 注入给 Pi 子进程的环境变量只含权威值，并带**本会话**的选择 ID。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createTask } from "../packages/bios-agent/core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { applyBiosEnv, BIOS_CONFIG_ENV_KEYS, biosProcessEnv, normalizeBiosHostSettings, resolveSessionSelection, currentBiosBootId } from "../src/main/bios/biosProcessEnv.ts";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";

const NOW = 1_700_000_000_000;
const SECRET_TASK = "SECRET-C1-TASK-REQUIREMENT";
const AGENT_ID = "agent-c1";
const GENERATION = 7;

async function sandbox() {
	const sb = await createProjectSandbox("bm07-c1-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceA, displayName: "Authorized synthetic board", now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceA, sb.workspaceB], workspacePath: sb.workspaceB, displayName: "Forbidden board label", now: NOW });
	await createTask({ root: sb.root, projectId: projectA.projectId, taskId: "task-c1", workspaceId: projectA.workspaceId, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], requirement: SECRET_TASK, authorizedProjectIds: [projectA.projectId] });
	return { ...sb, projectA, projectB };
}

const settingsOf = (sb, overrides = {}) => ({ knowledgeRoot: sb.root, authorizedProjectIds: [sb.projectA.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed", ...overrides });

function serviceFor(sb, { settings = settingsOf(sb), cwd = null, receipt = null } = {}) {
	const state = { settings };
	return {
		service: new BiosKnowledgeService({
			readSettings: () => state.settings,
			readSelections: () => state.selections ?? null,
			writeSelections: async (next) => {
				state.selections = next;
			},
			session: {
				resolve(claim) {
					if (claim.sessionRef.agentId !== AGENT_ID) return { error: "会话不存在或已结束：请刷新后重新选择" };
					if (claim.runtimeGeneration !== GENERATION) return { error: "会话运行时代次已变化：请刷新后重试" };
					return { resolution: { agentId: AGENT_ID, sessionId: "session-c1", cwd: cwd ?? sb.workspaceA, generation: GENERATION } };
				},
				async syncSelection() {
					return receipt === null ? { error: "命令通道不可用" } : { receipt };
				},
				listSessions: () => [{ agentId: AGENT_ID, sessionId: "session-c1", generation: GENERATION }],
				pushContextOff: async () => ({ receipt: "已关闭" }),
				stopRuntime: async () => ({ stopped: true, error: null }),
			},
			now: () => NOW,
		}),
		state,
	};
}

const claim = (generation = GENERATION) => ({ sessionRef: { agentId: AGENT_ID, sessionId: "session-c1" }, runtimeGeneration: generation });

test("C1：缺省即拒绝 —— 未配置知识根/未授权任何范围就不读取", () => {
	const none = serviceFor(null === null ? { root: "unused" } : {}, { settings: null }).service;
	assert.equal(none.readiness().ready, false, "没有配置时必须未就绪");
	assert.match(none.readiness().reason ?? "", /知识根/);

	const rootOnly = serviceFor({}, { settings: { knowledgeRoot: "C:/does-not-matter", authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "allowed" } }).service;
	assert.equal(rootOnly.readiness().ready, false, "有根但没有任何授权也必须未就绪");
	assert.match(rootOnly.readiness().reason ?? "", /授权/);

	// 非法值回落：未知端点 → unknown；非字符串条目被丢弃。
	const normalized = normalizeBiosHostSettings({ endpoint: "maybe", authorizedProjectIds: ["a", 42, "  ", null], authorizedRoots: "C:/x" });
	assert.equal(normalized.endpoint, "unknown");
	assert.deepEqual(normalized.authorizedProjectIds, ["a"]);
	assert.deepEqual(normalized.authorizedRoots, []);
});

test("C1：只列已授权项目/任务；未授权项目连 ID 都不出现", async () => {
	const sb = await sandbox();
	try {
		const { service } = serviceFor(sb);
		assert.equal(service.readiness().ready, true);

		const projects = await service.listProjects(claim());
		assert.equal(projects.gap, null);
		assert.deepEqual(
			projects.items.map((project) => project.projectId),
			[sb.projectA.projectId],
			"只能列出已授权项目",
		);
		assert.ok(projects.items[0].workspaces.length >= 1, "应带工作区信息");
		assert.ok(projects.items[0].identity.length >= 1, "应带身份字段");
		assert.equal(projects.items[0].displayName, "Authorized synthetic board");
		assert.ok(!JSON.stringify(projects).includes("Forbidden board label"));

		const unauthorized = await service.listTasks({ ...claim(), projectId: sb.projectB.projectId });
		assert.deepEqual(unauthorized.items, [], "未授权项目不得返回任务");
		assert.match(unauthorized.gap ?? "", /不在授权集合内/);

		const tasks = await service.listTasks({ ...claim(), projectId: sb.projectA.projectId });
		assert.deepEqual(
			tasks.items.map((task) => task.taskId),
			["task-c1"],
		);
		assert.equal(tasks.items[0].requirement, SECRET_TASK, "本地展示可见需求正文");
	} finally {
		await sb.cleanup();
	}
});

test("C1：deny/unknown 端点下预览标 maySendToModel=false 且不输出商业正文；allowed 是正对照", async () => {
	const sb = await sandbox();
	try {
		for (const endpoint of ["denied", "unknown"]) {
			const { service } = serviceFor(sb, { settings: settingsOf(sb, { endpoint }) });
			const preview = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: sb.projectA.workspaceId });
			assert.equal(preview.maySendToModel, false, `${endpoint}：不得标为可发送`);
			assert.ok(!preview.text.includes(SECRET_TASK), `${endpoint}：不得输出任务正文`);
			assert.notEqual(preview.status, "ok", `${endpoint}：不得报 ok`);
		}

		const { service } = serviceFor(sb);
		const allowed = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: sb.projectA.workspaceId });
		assert.equal(allowed.maySendToModel, true);
		assert.ok(allowed.text.includes(SECRET_TASK), "allowed 是正对照：必须真的读到正文");
		assert.ok(allowed.retainedSources.length >= 2, "应报告保留来源");
		assert.ok(allowed.budget.usedChars <= allowed.budget.maxChars, "预算必须守住");
	} finally {
		await sb.cleanup();
	}
});

test("C1：身份闸门 —— 会话目录不在任务工作区授权范围时，预览不给任务正文与工作区路径", async () => {
	const sb = await sandbox();
	try {
		// 授权目录根 = ws-b（所以"目录本身在授权范围内"），但任务绑定在 ws-a ⇒ 身份闸门生效。
		const { service } = serviceFor(sb, { settings: settingsOf(sb, { authorizedRoots: [sb.workspaceB] }), cwd: sb.workspaceB });
		const preview = await service.preview({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: sb.projectA.workspaceId });
		assert.notEqual(preview.status, "ok", "身份不可用时不得报 ok");
		assert.equal(preview.identityUsable, false);
		assert.ok(!preview.text.includes(SECRET_TASK), `不得输出任务正文：${preview.text.slice(0, 300)}`);
		assert.ok(!preview.text.includes(sb.workspaceA), "不得回显未授权工作区绝对路径");
		assert.ok(/身份闸门|授权范围/.test(preview.text), "必须说明身份缺口");
	} finally {
		await sb.cleanup();
	}
});

test("C1：未授权项目预览与假身份/迟到代次都直接拒绝（不静默返回空）", async () => {
	const sb = await sandbox();
	try {
		const { service } = serviceFor(sb);
		await assert.rejects(() => service.preview({ ...claim(), projectId: sb.projectB.projectId, taskId: "task-c1", workspaceId: null }), /不在授权集合内/);
		await assert.rejects(() => service.preview({ sessionRef: { agentId: "ghost", sessionId: null }, runtimeGeneration: GENERATION, projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: null }), /会话不存在/);
		await assert.rejects(() => service.preview({ ...claim(GENERATION + 1), projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: null }), /代次/);
	} finally {
		await sb.cleanup();
	}
});

test("C1/R33-3：注入给 Pi 子进程的环境变量是权威值，并带本会话选择 ID（导入不是授权）", () => {
	const settings = normalizeBiosHostSettings({ knowledgeRoot: "C:/kb", authorizedProjectIds: ["p1", "p2"], allowedFeatureIds: ["f1"], approvedCustomers: ["c1"], authorizedRoots: ["C:/a", "C:/b"], endpoint: "denied" });
	const env = biosProcessEnv(settings, { projectId: "p1", taskId: "t1", workspaceId: "w1", contextEnabled: true });
	assert.equal(env.BIOS_KNOWLEDGE_ROOT, "C:/kb");
	assert.equal(env.BIOS_AUTHORIZED_PROJECTS, "p1,p2");
	assert.equal(env.BIOS_ALLOWED_FEATURE_IDS, "f1");
	assert.equal(env.BIOS_APPROVED_CUSTOMERS, "c1");
	assert.equal(env.BIOS_AUTHORIZED_ROOTS, "C:/a;C:/b", "目录根用 ; 连接");
	assert.equal(env.BIOS_ENDPOINT, "denied");
	assert.equal(env.BIOS_SELECTED_TASK_ID, "t1");
	assert.equal(env.BIOS_CONTEXT_ENABLED, "1");

	// 未配置项不得"什么都不写"（那会继承宿主旧值），而是显式写空/关闭。
	const empty = biosProcessEnv(normalizeBiosHostSettings(null));
	for (const key of BIOS_CONFIG_ENV_KEYS) assert.ok(key in empty, `${key} 必须显式写出`);
	assert.equal(empty.BIOS_ENDPOINT, "unknown");
	assert.equal(empty.BIOS_CONTEXT_ENABLED, "0");
	assert.equal(empty.BIOS_KNOWLEDGE_ROOT, "");

	// 会话选择按 sessionId 归属；重启后（bootId 不同）保守关闭。
	const stored = { bySession: { "session-c1": { projectId: "p1", taskId: "t1", workspaceId: "w1", contextEnabled: true, updatedAt: 1 } }, bootId: currentBiosBootId() };
	const injected = applyBiosEnv({ BIOS_AUTHORIZED_PROJECTS: "stale" }, settings, resolveSessionSelection(stored, currentBiosBootId(), "session-c1"));
	assert.equal(injected.BIOS_SELECTED_TASK_ID, "t1");
	assert.equal(injected.BIOS_AUTHORIZED_PROJECTS, "p1,p2", "旧值必须被权威值覆盖");
	const afterRestart = applyBiosEnv({}, settings, resolveSessionSelection(stored, "another-boot", "session-c1"));
	assert.equal(afterRestart.BIOS_CONTEXT_ENABLED, "0", "重启后不得沿用已打开状态");
});

test("C1：applySelection 只登记 ID 与非敏感开关，未授权项目直接拒绝并给可读回执", async () => {
	const sb = await sandbox();
	try {
		const { service } = serviceFor(sb, { receipt: "已选择任务 task-c1" });
		const ok = await service.applySelection({ ...claim(), projectId: sb.projectA.projectId, taskId: "task-c1", workspaceId: sb.projectA.workspaceId, contextEnabled: true });
		assert.equal(ok.applied, true);
		assert.equal(ok.mode, "rpc");
		assert.equal(ok.currentSessionSynced, true);
		assert.match(ok.receipt, /已同步到当前会话/);

		const rejected = await service.applySelection({ ...claim(), projectId: sb.projectB.projectId, taskId: "task-c1", workspaceId: null, contextEnabled: true });
		assert.equal(rejected.applied, false);
		assert.equal(rejected.reason, "project-unauthorized");
		assert.match(rejected.receipt, /不在授权集合内/);
	} finally {
		await sb.cleanup();
	}
});
