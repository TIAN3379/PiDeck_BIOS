/**
 * BM-07B B-04 永久回归：**任务管理**经生产 IPC 的完整链路（合成资料）。
 *
 * 断言边界行为而非源码字符串：
 * 1. 全字段往返（需求/待办/阻塞/决策/相关文件/参考经验/验证记录含证据）；
 * 2. 状态推进与**显式重开**：done→in_progress 必须给理由，且验证记录不被清空；
 * 3. 同 revision 竞争不覆盖，并给出实际 revision；
 * 4. 未授权项目 / 跨项目工作区明确拒绝；
 * 5. 引用了不存在或不可作依据的经验时，引用仍然保存但如实报缺口。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { createBiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const AGENT = "agent-b04";
const SESSION = "deck-b04";

const handlers = new Map();
const ipcStubs = {
	electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} },
};
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", { stubs: ipcStubs });
const { registerBiosIpc } = loadTsCommonJs("src/main/ipc/biosIpc.ts", { stubs: { ...ipcStubs, "../bios/BiosKnowledgeService": { normalizeBiosHostSettings: (value) => value } } });

const call = (channel, payload) => {
	const handler = handlers.get(channel);
	assert.ok(handler, `channel 未注册：${channel}`);
	return handler(null, payload);
};

const claim = () => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 });

async function setup() {
	const sb = await createProjectSandbox("bm07-b04-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceB, authorizedRoots: [sb.workspaceB], workspacePath: sb.workspaceB, now: NOW });
	assert.equal(projectA.status, "bound");
	assert.equal(projectB.status, "bound");
	const settings = { knowledgeRoot: sb.root, authorizedProjectIds: [projectA.projectId, projectB.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA, sb.workspaceB], endpoint: "allowed" };
	const port = {
		resolve: () => ({ resolution: { agentId: AGENT, sessionId: SESSION, cwd: sb.workspaceA, generation: 3 } }),
		listSessions: () => [],
		pushContextOff: async () => ({ receipt: "ok" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
		syncSelection: async () => ({ receipt: "synthetic ACK" }),
	};
	const business = createBiosBusinessService({ readSettings: () => settings, session: port, now: () => NOW });
	// 只读服务也要注册：`bios:list-tasks` 属于它（B-02 之后任务列表仍由只读服务提供）。
	const knowledge = createBiosKnowledgeService({ readSettings: () => settings, readSelections: () => null, writeSelections: async () => undefined, session: port, now: () => NOW });
	const unregister = registerBiosBusinessIpc({ business, appLogger: { info() {} } });
	const unregisterRead = registerBiosIpc({
		biosService: knowledge,
		readBiosSettings: () => settings,
		updateBiosSettings: async () => undefined,
		readBiosSelections: () => null,
		updateBiosSelections: async () => undefined,
		appLogger: { info() {} },
		onChanged: () => undefined,
	});
	return {
		sb,
		projectA,
		projectB,
		settings,
		unregister: () => {
			unregister();
			unregisterRead();
		},
	};
}

const FULL_TASK = (workspaceId) => ({
	...claim(),
	projectId: undefined,
	taskId: "task-b04",
	workspaceId,
	requirement: "PXE 启动失败：选项菜单超时",
	branch: "bios/pxe-fix",
	baseCommit: "abcdef1",
	decisions: ["不修改客户定制区"],
	todos: ["复现", "定位 PXE_DELAY"],
	blockers: ["缺客户板子"],
	relatedFiles: ["Platform/SamplePkg/Sample.dsc"],
	sourceExperienceIds: ["exp-b04-missing"],
	validations: [
		{
			kind: "compile",
			scope: "SamplePlatformA 全量编译",
			result: "passed",
			performedAt: NOW,
			performedBy: "tester-a",
			evidence: [{ type: "commit", commit: "abcdef1", relativePath: "Platform/SamplePkg/Sample.dsc", workspaceId }],
		},
	],
});

test("B-04：全字段新建与回读一致，列表给出需求/状态/工作区/计数", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const created = await call("bios:create-task", { ...FULL_TASK(projectA.workspaceId), projectId: projectA.projectId });
		assert.equal(created.result.status, "created");
		assert.equal(created.committed, true);

		const detail = await call("bios:read-task-detail", { ...claim(), projectId: projectA.projectId, taskId: "task-b04" });
		assert.equal(detail.result.status, "ok");
		const task = detail.result.task;
		assert.equal(task.requirement, "PXE 启动失败：选项菜单超时");
		assert.deepEqual([...task.todos], ["复现", "定位 PXE_DELAY"]);
		assert.deepEqual([...task.blockers], ["缺客户板子"]);
		assert.deepEqual([...task.decisions], ["不修改客户定制区"]);
		assert.deepEqual([...task.relatedFiles], ["Platform/SamplePkg/Sample.dsc"]);
		assert.deepEqual([...task.sourceExperienceIds], ["exp-b04-missing"]);
		assert.equal(task.workspace.branch, "bios/pxe-fix");
		assert.equal(task.workspace.baseCommit, "abcdef1");
		assert.equal(task.validations.length, 1);
		assert.equal(task.validations[0].kind, "compile");
		assert.equal(task.validations[0].result, "passed");
		assert.equal(task.validations[0].scope, "SamplePlatformA 全量编译");
		assert.equal(task.validations[0].performedBy, "tester-a");
		assert.equal(task.validations[0].evidence.length, 1);
		assert.equal(task.validations[0].evidence[0].commit, "abcdef1");
		// 引用不存在 ⇒ 引用保留但如实报缺口（不能当成"可作依据"）。
		assert.equal(detail.result.references.length, 1);
		assert.equal(detail.result.references[0].found, false);
		assert.equal(detail.result.references[0].usableAsBasis, false);

		const listed = await call("bios:list-tasks", { ...claim(), projectId: projectA.projectId });
		assert.equal(listed.gap, null);
		const summary = listed.items.find((entry) => entry.taskId === "task-b04");
		assert.ok(summary, "列表必须含有刚建的任务");
		assert.equal(summary.status, "planned");
		assert.equal(summary.requirement, "PXE 启动失败：选项菜单超时");
		assert.equal(summary.todoCount, 2);
		assert.equal(summary.blockerCount, 1);
		assert.equal(summary.workspaceId, projectA.workspaceId);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-04：状态推进 + 显式重开必须给理由，且重开不清空验证记录", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const projectId = projectA.projectId;
		const created = await call("bios:create-task", { ...FULL_TASK(projectA.workspaceId), projectId });
		let revision = created.result.revision;

		for (const [to, reason] of [
			["in_progress", "开始复现"],
			["blocked", "等客户板子"],
			["in_progress", "板子到了"],
			["done", "验证通过"],
		]) {
			const outcome = await call("bios:change-task-status", { ...claim(), projectId, taskId: "task-b04", expectedRevision: revision, to, reason });
			assert.equal(outcome.result.status, "changed", `推进到 ${to} 失败：${JSON.stringify(outcome.result.problems)}`);
			assert.equal(outcome.result.to, to);
			revision = outcome.result.revision;
		}

		// 重开必须显式给理由（IPC 层就挡住空理由）。
		await assert.rejects(() => call("bios:change-task-status", { ...claim(), projectId, taskId: "task-b04", expectedRevision: revision, to: "in_progress", reason: "   " }), /reason/);

		const reopened = await call("bios:change-task-status", { ...claim(), projectId, taskId: "task-b04", expectedRevision: revision, to: "in_progress", reason: "发现回归，重新打开" });
		assert.equal(reopened.result.status, "changed");
		assert.equal(reopened.result.from, "done");
		assert.equal(reopened.result.to, "in_progress");

		// 关键：重开不是"新任务"——验证记录原样保留。
		const detail = await call("bios:read-task-detail", { ...claim(), projectId, taskId: "task-b04" });
		assert.equal(detail.result.task.validations.length, 1);
		assert.equal(detail.result.task.validations[0].result, "passed");
		assert.equal(detail.result.task.validations[0].scope, "SamplePlatformA 全量编译");
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-04：同 revision 竞争不覆盖；未授权项目与跨项目工作区明确拒绝", async () => {
	const { sb, projectA, projectB, unregister } = await setup();
	try {
		const created = await call("bios:create-task", { ...FULL_TASK(projectA.workspaceId), projectId: projectA.projectId });
		const base = created.result.revision;

		const first = await call("bios:update-task", { ...claim(), projectId: projectA.projectId, taskId: "task-b04", expectedRevision: base, changes: { todos: ["胜者写入"] } });
		assert.equal(first.result.status, "updated");
		const stale = await call("bios:update-task", { ...claim(), projectId: projectA.projectId, taskId: "task-b04", expectedRevision: base, changes: { todos: ["败者写入"] } });
		assert.equal(stale.result.status, "revision-conflict");
		assert.equal(stale.committed, false);
		assert.equal(stale.result.actualRevision, first.result.revision);
		const detail = await call("bios:read-task-detail", { ...claim(), projectId: projectA.projectId, taskId: "task-b04" });
		assert.deepEqual([...detail.result.task.todos], ["胜者写入"], "失败的一方不得覆盖");

		// 状态变更同样受 CAS 保护。
		const statusStale = await call("bios:change-task-status", { ...claim(), projectId: projectA.projectId, taskId: "task-b04", expectedRevision: base, to: "in_progress", reason: "旧版本" });
		assert.notEqual(statusStale.result.status, "changed");

		// 未授权项目：core 返回 not-authorized 判别式（不是"不存在"，也不是抛出）；渲染层必须按状态区分。
		const unauthorized = await call("bios:read-task-detail", { ...claim(), projectId: "11111111-1111-1111-1111-111111111111", taskId: "task-b04" });
		assert.equal(unauthorized.result.status, "not-authorized");
		assert.equal(unauthorized.result.task, null);

		// 跨项目工作区：项目 A 的任务不得绑到项目 B 的工作区。
		await assert.rejects(() => call("bios:create-task", { ...FULL_TASK(projectB.workspaceId), projectId: projectA.projectId, taskId: "task-cross" }), /工作区|workspace|不一致/);
	} finally {
		unregister();
		await sb.cleanup();
	}
});
