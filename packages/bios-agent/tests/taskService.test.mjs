/**
 * BM-05 B 永久回归：任务事实服务（创建/读取/点名更新/具名状态 CAS/经验草稿沉淀）。
 *
 * 覆盖 bm05_development_plan.md §3 要求：
 * - 项目绑定与工作区归属（同裸 taskId 跨项目独立、同项目双工作区独立）；
 * - 默认 planned、字段/非法输入有界、CAS 冲突不覆盖、同值不制造 revision；
 * - done→in_progress 显式重开、非法迁移受控拒绝；
 * - 经验引用按授权与审核状态核对（缺口只提示）；
 * - 任务→经验草稿：只得到 draft、不自动审核、关联回任务的第二步 CAS 冲突保留半完成事实。
 *
 * 全部自建临时知识库与合成内容；不读任何真实客户资料。
 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/index.ts";
import { changeTaskStatus, createTask, prepareExperienceDraftFromTask, readTaskDetail, saveExperienceDraftFromTask, updateTask } from "../core/tasks/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

async function sandbox() {
	const sb = await createProjectSandbox("bm05-task-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const extra = join(sb.base, "ws-c");
	await mkdir(extra, { recursive: true });
	await writeDsc(extra, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformC" });
	const access = (workspace) => ({ cwd: workspace, authorizedRoots: [sb.workspaceA, sb.workspaceB, extra] });
	const projectA = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ ...access(sb.workspaceB), root: sb.root, workspacePath: sb.workspaceB, now: NOW });
	// 同一个项目 A 的第二个工作区。
	const projectA2 = await bindProjectWorkspace({ ...access(extra), root: sb.root, workspacePath: extra, biosProjectId: projectA.projectId, now: NOW });
	return { ...sb, access, extra, projectA, projectB, projectA2 };
}

function taskInput(sb, overrides = {}) {
	return { root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "关闭 PXE 缩短启动时间", authorizedProjectIds: [sb.projectA.projectId], now: NOW, ...overrides };
}

test("B1：同裸 taskId 跨项目独立；工作区必须属于项目；首建默认 planned", async () => {
	const sb = await sandbox();
	try {
		const a = await createTask(taskInput(sb));
		assert.equal(a.status, "created");
		assert.equal(a.revision, 0);
		const b = await createTask(taskInput(sb, { projectId: sb.projectB.projectId, workspaceId: sb.projectB.workspaceId, requirement: "另一个项目的同名任务", authorizedProjectIds: [sb.projectB.projectId] }));
		assert.equal(b.status, "created");

		// 服务身份 = projectId + taskId：两条互不串。
		const detailA = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		const detailB = await readTaskDetail({ root: sb.root, projectId: sb.projectB.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectB.projectId] });
		assert.equal(detailA.task?.requirement, "关闭 PXE 缩短启动时间");
		assert.equal(detailB.task?.requirement, "另一个项目的同名任务");
		assert.equal(detailA.task?.status, "planned");

		// 首建只接受 planned。
		await assert.rejects(createTask(taskInput(sb, { taskId: "task-done", status: "done" })), /planned/);
		// 工作区必须属于项目。
		await assert.rejects(createTask(taskInput(sb, { taskId: "task-bad", workspaceId: sb.projectB.workspaceId })), /不属于项目/);
		// 缺 cwd 无法判定工作区授权。
		await assert.rejects(createTask({ ...taskInput(sb, { taskId: "task-nocwd" }), cwd: undefined }), /cwd/);

		// 读取缺省拒绝。
		const denied = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1" });
		assert.equal(denied.status, "not-authorized");
		assert.equal(denied.task, null);
	} finally {
		await sb.cleanup();
	}
});

test("B1：同项目双工作区各自独立；点名更新 CAS 不覆盖、同值不制造 revision", async () => {
	const sb = await sandbox();
	try {
		await createTask(taskInput(sb));
		await createTask(taskInput(sb, { taskId: "task-2", workspaceId: sb.projectA2.workspaceId, requirement: "同项目另一个工作区的任务" }));
		const first = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		const second = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-2", authorizedProjectIds: [sb.projectA.projectId] });
		assert.notEqual(first.task?.workspace.workspaceId, second.task?.workspace.workspaceId);

		const updated = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, changes: { todos: ["复现 PXE 引导"], blockers: ["缺少目标板"], decisions: ["先在 DSC 关闭默认值"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 1 });
		assert.equal(updated.status, "updated");
		assert.deepEqual(updated.changedFields.sort(), ["blockers", "decisions", "todos"]);

		// 同值 ⇒ unchanged。
		const same = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: updated.revision, changes: { todos: ["复现 PXE 引导"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 2 });
		assert.equal(same.status, "unchanged");
		assert.equal(same.revision, updated.revision);

		// 过期 revision ⇒ 冲突且不覆盖。
		const conflict = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, changes: { requirement: "被覆盖" }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 3 });
		assert.equal(conflict.status, "revision-conflict");
		assert.equal((await readRecord({ root: sb.root, kind: "task-record", id: "task-1", projectId: sb.projectA.projectId })).record.requirement, "关闭 PXE 缩短启动时间");

		// 未触达字段保留；未知字段拒绝（状态只能走具名动作）。
		await assert.rejects(updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: same.revision, changes: { status: "done" }, authorizedProjectIds: [sb.projectA.projectId] }), /未知字段/);
	} finally {
		await sb.cleanup();
	}
});

test("B2：状态转换表与 done→in_progress 显式重开；验证级别只按声明保存", async () => {
	const sb = await sandbox();
	try {
		await createTask(taskInput(sb));
		const illegal = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, to: "done", reason: "跳步", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 1 });
		assert.equal(illegal.status, "illegal-transition");

		const started = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, to: "in_progress", reason: "开始", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 2 });
		assert.equal(started.status, "changed");
		assert.equal(started.from, "planned");
		const done = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: started.revision, to: "done", reason: "工程师声明完成", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 3 });
		assert.equal(done.status, "changed");
		// 旧 revision 不得覆盖 done。
		const stale = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: started.revision, to: "in_progress", reason: "旧交接想覆盖", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 4 });
		assert.equal(stale.status, "revision-conflict");
		// 显式重开：新 revision 是真相。
		const reopened = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: done.revision, to: "in_progress", reason: "发现问题需要继续", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 5 });
		assert.equal(reopened.status, "changed");
		assert.equal(reopened.from, "done");
		assert.equal(reopened.to, "in_progress");

		// 验证按既有 ValidationRecord 保存，原级别/范围展示。
		const withValidation = await updateTask({
			root: sb.root,
			projectId: sb.projectA.projectId,
			taskId: "task-1",
			expectedRevision: reopened.revision,
			changes: { validations: [{ kind: "compile", scope: "PlatformA", result: "passed", performedAt: NOW, performedBy: "engineer" }] },
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 6,
		});
		assert.deepEqual(withValidation.changedFields, ["validations"]);
		const detail = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		assert.deepEqual(
			detail.task?.validations.map((validation) => validation.kind),
			["compile"],
		);
		assert.equal(detail.task?.status, "in_progress", "写验证记录不等于任务已验证");
	} finally {
		await sb.cleanup();
	}
});

test("B1/B3：经验引用按授权与审核状态核对；任务→草稿只得到 draft 且不自动审核", async () => {
	const sb = await sandbox();
	try {
		const created = await createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: { experienceId: "exp-reviewed", problem: "PXE 默认开启", rootCause: "默认值", solution: "关闭默认值", sourceProjectId: sb.projectA.projectId }, now: NOW });
		await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-reviewed", expectedRevision: created.revision, action: "submit-review", operatorLabel: "engineer", reason: "可复用", now: NOW + 1 });
		await createExperienceDraft({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experience: { experienceId: "exp-draft", problem: "还没审核的经验", rootCause: "x", solution: "y", sourceProjectId: sb.projectA.projectId }, now: NOW + 2 });

		await createTask(taskInput(sb));
		const linked = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-reviewed", "exp-draft"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 3 });
		assert.deepEqual(linked.changedFields, ["sourceExperienceIds"]);
		assert.ok(
			linked.referenceGaps.some((gap) => /exp-draft/.test(gap)),
			"草稿经验引用必须提示缺口",
		);

		const detail = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		const reviewedRef = detail.references.find((reference) => reference.experienceId === "exp-reviewed");
		const draftRef = detail.references.find((reference) => reference.experienceId === "exp-draft");
		assert.equal(reviewedRef?.usableAsBasis, true);
		assert.equal(draftRef?.usableAsBasis, false);
		assert.match(draftRef?.reason ?? "", /草稿/);

		// 预填：可预填任务事实；根因/方案等必须人工提供。
		const prefill = await prepareExperienceDraftFromTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		assert.equal(prefill.status, "ok");
		assert.equal(prefill.prefill?.suggested.sourceProjectId, sb.projectA.projectId);
		assert.equal(prefill.prefill?.suggested.requirement, "关闭 PXE 缩短启动时间");
		assert.deepEqual(prefill.prefill?.requiredHumanFields, ["problem", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen"]);
		assert.deepEqual(prefill.prefill?.suggested.usableExperienceIds, ["exp-reviewed"]);

		// 保存：只得到 draft，不自动审核；第二步把新经验关联回任务。
		const saved = await saveExperienceDraftFromTask({
			root: sb.root,
			projectId: sb.projectA.projectId,
			taskId: "task-1",
			expectedTaskRevision: detail.revision,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-from-task", problem: "从任务沉淀的现象", rootCause: "人工确认的根因", solution: "人工确认的方案", appliesWhen: [], doesNotApplyWhen: [] },
			now: NOW + 4,
		});
		assert.equal(saved.status, "draft-saved");
		assert.equal(saved.card?.status_after, "draft");
		const card = await readRecord({ root: sb.root, kind: "experience-card", id: "exp-from-task" });
		assert.equal(card.record.status, "draft", "任务 done 不能把经验变成 verified；保存也不自动审核");
		const taskAfter = await readRecord({ root: sb.root, kind: "task-record", id: "task-1", projectId: sb.projectA.projectId });
		assert.ok(taskAfter.record.sourceExperienceIds.includes("exp-from-task"), "第二步 CAS 必须真的把新经验关联回任务");

		// 第二步冲突：草稿保留，任务不关联（真实半完成事实）。
		const conflict = await saveExperienceDraftFromTask({
			root: sb.root,
			projectId: sb.projectA.projectId,
			taskId: "task-1",
			expectedTaskRevision: 0,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-from-task-2", problem: "第二条", rootCause: "r", solution: "s", appliesWhen: [], doesNotApplyWhen: [] },
			now: NOW + 5,
		});
		assert.equal(conflict.status, "link-conflict");
		assert.equal(conflict.card?.status, "created", "第二步冲突不得撤销已发布的草稿");
		const orphan = await readRecord({ root: sb.root, kind: "experience-card", id: "exp-from-task-2" });
		assert.equal(orphan.record.status, "draft");
		const taskFinal = await readRecord({ root: sb.root, kind: "task-record", id: "task-1", projectId: sb.projectA.projectId });
		assert.ok(!taskFinal.record.sourceExperienceIds.includes("exp-from-task-2"), "冲突时任务不得被改");
	} finally {
		await sb.cleanup();
	}
});
