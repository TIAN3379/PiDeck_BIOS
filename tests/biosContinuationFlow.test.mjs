/**
 * BM-07B B-06 永久回归：**任务沉淀分步**、**交接预览**与**上下文清单保存/重验**（生产 IPC）。
 *
 * 最关键的断言是"服务端重读来源"：清单保存时**伪造的 revision / profileRevision 会被拒**，
 * 也就是说 renderer 提交的 sources 不是事实来源。另有：
 * - 沉淀的 card/link 两步：回链冲突后**再存一次会变成 card-conflict**（证明"只补回链"是唯一正解）；
 * - 清单重验在来源 revision 变化后必须报 `stale` 且逐来源给状态。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createBiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { createBiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const NOW = 1_700_000_000_000;
const AGENT = "agent-b06";
const SESSION = "deck-b06";

const handlers = new Map();
const ipcStubs = { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} } };
const { registerBiosBusinessIpc } = loadTsCommonJs("src/main/ipc/biosBusinessIpc.ts", { stubs: ipcStubs });
const { registerBiosIpc } = loadTsCommonJs("src/main/ipc/biosIpc.ts", { stubs: { ...ipcStubs, "../bios/BiosKnowledgeService": { normalizeBiosHostSettings: (value) => value } } });

const call = (channel, payload) => {
	const handler = handlers.get(channel);
	assert.ok(handler, `channel 未注册：${channel}`);
	return handler(null, payload);
};
const claim = () => ({ sessionRef: { agentId: AGENT, sessionId: SESSION }, runtimeGeneration: 3 });

async function setup() {
	const sb = await createProjectSandbox("bm07-b06-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	const projectA = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, authorizedRoots: [sb.workspaceA], workspacePath: sb.workspaceA, now: NOW });
	assert.equal(projectA.status, "bound");
	const state = { settings: { knowledgeRoot: sb.root, authorizedProjectIds: [projectA.projectId], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [sb.workspaceA], endpoint: "allowed" } };
	const port = {
		resolve: () => ({ resolution: { agentId: AGENT, sessionId: SESSION, cwd: sb.workspaceA, generation: 3 } }),
		listSessions: () => [],
		pushContextOff: async () => ({ receipt: "ok" }),
		stopRuntime: async () => ({ stopped: true, error: null }),
		syncSelection: async () => ({ receipt: "synthetic ACK" }),
	};
	const business = createBiosBusinessService({ readSettings: () => state.settings, session: port, now: () => NOW });
	const knowledge = createBiosKnowledgeService({ readSettings: () => state.settings, readSelections: () => null, writeSelections: async () => undefined, session: port, now: () => NOW });
	const unregisterBusiness = registerBiosBusinessIpc({ business, appLogger: { info() {} } });
	const unregisterRead = registerBiosIpc({ biosService: knowledge, readBiosSettings: () => state.settings, updateBiosSettings: async () => undefined, readBiosSelections: () => null, updateBiosSelections: async () => undefined, appLogger: { info() {} }, onChanged: () => undefined });
	return {
		sb,
		projectA,
		state,
		unregister: () => {
			unregisterBusiness();
			unregisterRead();
		},
	};
}

async function createTask(projectA, overrides = {}) {
	const created = await call("bios:create-task", {
		...claim(),
		projectId: projectA.projectId,
		taskId: "task-a",
		workspaceId: projectA.workspaceId,
		requirement: "PXE 选项菜单超时",
		decisions: ["不改客户定制区"],
		relatedFiles: ["Platform/SamplePkg/Sample.dsc"],
		validations: [{ kind: "compile", scope: "SamplePlatformA", result: "passed", performedAt: NOW, performedBy: "tester" }],
		...overrides,
	});
	assert.equal(created.result.status, "created", `建任务失败：${JSON.stringify(created.result.problems)}`);
	return created;
}

test("B-06：沉淀预填只来自已保存的任务；card/link 分步且回链冲突不撤销草稿", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const created = await createTask(projectA);
		const prefill = await call("bios:prepare-draft", { ...claim(), projectId: projectA.projectId, taskId: "task-a" });
		assert.equal(prefill.result.status, "ok");
		assert.equal(prefill.result.prefill.suggested.requirement, "PXE 选项菜单超时");
		assert.deepEqual([...prefill.result.prefill.suggested.decisions], ["不改客户定制区"]);
		assert.deepEqual([...prefill.result.prefill.suggested.relatedFiles], ["Platform/SamplePkg/Sample.dsc"]);
		assert.equal(prefill.result.prefill.suggested.validations.length, 1);
		assert.ok([...prefill.result.prefill.requiredHumanFields].includes("rootCause"), "根因必须是人工字段");

		// 故意用旧的任务 revision 回链：草稿应已建立，回链失败，两步事实都要给出。
		const saved = await call("bios:save-draft", {
			...claim(),
			projectId: projectA.projectId,
			taskId: "task-a",
			expectedTaskRevision: created.result.revision + 5,
			experience: { experienceId: "exp-sediment", problem: "PXE 选项菜单超时", rootCause: "PXE_DELAY 过小", solution: "调大 PXE_DELAY" },
		});
		assert.equal(saved.result.experienceId, "exp-sediment");
		const cardStep = saved.result.steps.find((step) => step.step === "card");
		assert.equal(cardStep.status, "created", "第一步必须真的建卡");
		assert.equal(saved.committed, true);
		assert.equal(saved.result.status, "link-conflict");
		assert.match(saved.result.problems.join("；"), /revision|冲突/);
		// 第一步与第二步的结果必须分别给出（不能只给一个总状态）。
		assert.deepEqual(
			[...saved.result.steps].map((step) => `${step.step}:${step.status}`),
			["card:created", "link:revision-conflict"],
		);

		// 草稿确实落盘了。
		const detail = await call("bios:read-experience-detail", { ...claim(), experienceId: "exp-sediment" });
		assert.equal(detail.result.status, "ok");
		assert.equal(detail.result.card.status, "draft", "沉淀出来的必须是草稿，不是已审核");

		// 再存一次同一 ID ⇒ card-conflict：这正说明"再存一次"不是修回链的办法。
		const again = await call("bios:save-draft", {
			...claim(),
			projectId: projectA.projectId,
			taskId: "task-a",
			expectedTaskRevision: created.result.revision + 5,
			experience: { experienceId: "exp-sediment", problem: "PXE 选项菜单超时", rootCause: "PXE_DELAY 过小", solution: "调大 PXE_DELAY" },
		});
		assert.equal(again.result.status, "card-conflict");

		// 正确的修法：只补"参考经验 ID"这一处（走任务 CAS）。
		const task = await call("bios:read-task-detail", { ...claim(), projectId: projectA.projectId, taskId: "task-a" });
		const linked = await call("bios:update-task", { ...claim(), projectId: projectA.projectId, taskId: "task-a", expectedRevision: task.result.revision, changes: { sourceExperienceIds: ["exp-sediment"] } });
		assert.equal(linked.result.status, "updated");
		const after = await call("bios:read-task-detail", { ...claim(), projectId: projectA.projectId, taskId: "task-a" });
		assert.deepEqual([...after.result.task.sourceExperienceIds], ["exp-sediment"]);
		assert.equal(after.result.task.requirement, "PXE 选项菜单超时", "只补回链，正文不变");
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-06：清单保存不采信 renderer 的 sources（伪造 revision / profileRevision 必须被拒）", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const created = await createTask(projectA);
		const preview = await call("bios:preview", { ...claim(), projectId: projectA.projectId, taskId: "task-a", workspaceId: projectA.workspaceId });
		// `bios:preview` 不返回 profileRevision（它只描述本次交接）；界面从项目摘要
		// （`BiosProjectSummary.profileRevision`）取，这里用同一个可信来源的等价物：新建后的档案版本 0。
		const profileRevision = 0;

		const base = {
			...claim(),
			manifestId: "manifest-a",
			targetProjectId: projectA.projectId,
			taskId: "task-a",
			workspaceId: projectA.workspaceId,
			profileRevision,
			generatedAt: NOW,
			expiredSources: [...preview.expiredSources],
			budget: { maxChars: preview.budget.maxChars, maxBytes: preview.budget.maxBytes, usedChars: preview.budget.usedChars, truncated: preview.budget.truncated },
		};

		// 伪造来源 revision（比真实高很多）⇒ 必须被 core 复核拒绝。
		const forged = await call("bios:save-manifest", {
			...base,
			sources: [
				{ recordKind: "project-profile", recordId: projectA.projectId, revision: 99, reason: "forged" },
				{ recordKind: "task-record", recordId: "task-a", revision: 99, reason: "forged" },
			],
		});
		assert.equal(forged.result.status, "invalid-sources");
		assert.equal(forged.committed, false);
		assert.match(forged.result.problems.join("；"), /revision|不一致/);

		// 伪造 profileRevision ⇒ 拒绝保存过期来源清单。
		const wrongProfile = await call("bios:save-manifest", { ...base, profileRevision: profileRevision + 7, sources: [{ recordKind: "project-profile", recordId: projectA.projectId, revision: profileRevision, reason: "x" }] });
		assert.equal(wrongProfile.result.status, "invalid-sources");

		// 身份守卫：任务来源必须是**所选任务**。
		const wrongTask = await call("bios:save-manifest", { ...base, sources: [{ recordKind: "task-record", recordId: "task-other", revision: 0, reason: "x" }] });
		assert.equal(wrongTask.result.status, "invalid-sources");

		// 真实 revision ⇒ 保存成功（第一次是 saved，同 ID 再存必须带 expectedRevision）。
		const saved = await call("bios:save-manifest", {
			...base,
			sources: [
				{ recordKind: "project-profile", recordId: projectA.projectId, revision: profileRevision, reason: "profile" },
				{ recordKind: "task-record", recordId: "task-a", revision: created.result.revision, reason: "task" },
			],
		});
		assert.equal(saved.result.status, "saved", `应保存成功：${JSON.stringify(saved.result.problems)}`);
		const revision = saved.result.revision;
		const realSources = [
			{ recordKind: "project-profile", recordId: projectA.projectId, revision: profileRevision, reason: "profile" },
			{ recordKind: "task-record", recordId: "task-a", revision: created.result.revision, reason: "task" },
		];
		const replayed = await call("bios:save-manifest", { ...base, sources: realSources });
		assert.equal(replayed.result.status, "revision-conflict", `同 ID 不带 expectedRevision 不得覆盖：${JSON.stringify(replayed.result)}`);
		assert.equal(replayed.committed, false);
		// 带上正确的 expectedRevision ⇒ 允许替换。
		const replaced = await call("bios:save-manifest", { ...base, sources: realSources, expectedRevision: revision });
		assert.equal(replaced.result.status, "replaced");
		assert.equal(replaced.result.revision, revision + 1);
	} finally {
		unregister();
		await sb.cleanup();
	}
});

test("B-06：清单重验按当前事实逐来源判定；来源变化后必须 stale", async () => {
	const { sb, projectA, unregister } = await setup();
	try {
		const created = await createTask(projectA);
		const preview = await call("bios:preview", { ...claim(), projectId: projectA.projectId, taskId: "task-a", workspaceId: projectA.workspaceId });
		const profileRevision = preview.profileRevision ?? 0;
		const saved = await call("bios:save-manifest", {
			...claim(),
			manifestId: "manifest-b",
			targetProjectId: projectA.projectId,
			taskId: "task-a",
			workspaceId: projectA.workspaceId,
			profileRevision,
			generatedAt: NOW,
			sources: [
				{ recordKind: "project-profile", recordId: projectA.projectId, revision: profileRevision, reason: "profile" },
				{ recordKind: "task-record", recordId: "task-a", revision: created.result.revision, reason: "task" },
			],
			budget: { maxChars: preview.budget.maxChars, maxBytes: preview.budget.maxBytes, usedChars: preview.budget.usedChars, truncated: preview.budget.truncated },
			expiredSources: [],
		});
		assert.equal(saved.result.status, "saved");

		const verified = await call("bios:verify-manifest", { ...claim(), manifestId: "manifest-b", projectId: projectA.projectId });
		assert.equal(verified.result.status, "ok", `应通过：${JSON.stringify(verified.result.problems)}`);
		// v1 没有耐久来源指纹：revision 一致也只到 `unproven`，**不会**被说成"内容完全一致"。
		assert.equal(
			verified.result.sources.every((source) => source.state === "current" || source.state === "unproven"),
			true,
			`逐来源状态：${JSON.stringify(verified.result.sources.map((source) => [source.recordKind, source.state, source.reason]))}`,
		);
		assert.ok(
			verified.result.sources.some((source) => source.state === "unproven" && /指纹/.test(source.reason)),
			"必须如实说明 v1 无法证明历史字节一致",
		);

		// 更新任务 ⇒ 来源 revision 变化 ⇒ 重验必须报 stale，且逐来源指出 changed。
		const updated = await call("bios:update-task", { ...claim(), projectId: projectA.projectId, taskId: "task-a", expectedRevision: created.result.revision, changes: { todos: ["继续验证"] } });
		assert.equal(updated.result.status, "updated");
		const reverified = await call("bios:verify-manifest", { ...claim(), manifestId: "manifest-b", projectId: projectA.projectId });
		assert.equal(reverified.result.status, "stale", "来源变化后旧清单不得再当作当前事实");
		const taskSource = reverified.result.sources.find((source) => source.recordKind === "task-record");
		assert.equal(taskSource.state, "changed");
		assert.equal(taskSource.expectedRevision, created.result.revision);
		assert.equal(taskSource.actualRevision, updated.result.revision);

		// 撤权后重验不得再返回来源状态。
		const denied = await call("bios:verify-manifest", { ...claim(), manifestId: "manifest-b", projectId: "11111111-1111-1111-1111-111111111111" });
		assert.equal(denied.result.status, "not-authorized");
	} finally {
		unregister();
		await sb.cleanup();
	}
});
