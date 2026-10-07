/**
 * BM-05 C 永久回归：有界人工交接包 + `ContextManifest` 保存/新进程重验。
 *
 * 覆盖 bm05_development_plan.md §4：双预算、端点 deny、任务重开使旧清单失效、
 * 来源变化/废弃/缺失、同 ID 替换 CAS、只读不写、v1 无耐久指纹时明确 unproven。
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, listRecords } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, reviewExperience } from "../core/knowledge/index.ts";
import { changeTaskStatus, createTask, readTaskDetail, updateTask } from "../core/tasks/index.ts";
import { buildHandoff, saveContextManifest, verifyContextManifest } from "../core/context/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;

async function sandbox() {
	const sb = await createProjectSandbox("bm05-context-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const access = (workspace) => ({ cwd: workspace, authorizedRoots: [sb.workspaceA, sb.workspaceB] });
	const projectA = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ ...access(sb.workspaceB), root: sb.root, workspacePath: sb.workspaceB, now: NOW });
	return { ...sb, access, projectA, projectB };
}

async function seedReviewed(sb, overrides = {}) {
	const created = await createExperienceDraft({
		root: sb.root,
		authorizedProjectIds: [sb.projectA.projectId],
		experience: { experienceId: "exp-ref", problem: "PXE 默认开启", rootCause: "平台默认值", solution: "关闭默认值", appliesWhen: ["快速启动"], doesNotApplyWhen: [], sourceProjectId: sb.projectA.projectId, ...overrides },
		now: NOW,
	});
	await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: overrides.experienceId ?? "exp-ref", expectedRevision: created.revision, action: "submit-review", operatorLabel: "engineer", reason: "可参考", now: NOW + 1 });
	return created;
}

test("C1：有界组装包含项目身份/任务事实/来源清单；端点 deny 不输出知识正文", async () => {
	const sb = await sandbox();
	try {
		await seedReviewed(sb);
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "关闭 PXE 缩短启动时间", todos: ["复现 PXE"], blockers: [], authorizedProjectIds: [sb.projectA.projectId] });
		await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-ref"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 2 });

		const handoff = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 3,
		});
		assert.equal(handoff.status, "incomplete", "没有 HEAD / 未确认身份等缺口必须如实报 incomplete");
		assert.match(handoff.text, /当前任务/);
		assert.match(handoff.text, /关闭 PXE 缩短启动时间/);
		assert.match(handoff.text, /平台默认值/, "端点允许时应输出参考经验正文");
		assert.ok(
			handoff.sources.some((source) => source.recordKind === "task-record" && source.recordId === "task-1"),
			"来源清单必须含当前任务 revision",
		);
		assert.ok(handoff.sources.some((source) => source.recordKind === "experience-card" && source.recordId === "exp-ref"));
		assert.equal(handoff.workspaceHead, null, "没有 Git 快照时 HEAD 必须为未知，不能伪造");
		assert.ok(handoff.budget.usedChars > 0 && handoff.budget.usedBytes > 0);

		// 端点 deny：只列 ID，不输出正文。
		const denied = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: false, allowInternalGeneral: false, customers: [] },
			now: NOW + 4,
		});
		assert.doesNotMatch(denied.text, /平台默认值/, "端点 deny 不得输出知识正文");
		assert.match(denied.text, /端点策略为 deny/);

		// 双预算：极小 chars 预算 ⇒ truncated + incomplete，状态说明不被改写成"已完成"。
		const tiny = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			budget: { maxChars: 120, maxBytes: 4096 },
			now: NOW + 5,
		});
		assert.equal(tiny.status, "incomplete");
		assert.equal(tiny.budget.truncated, true);
		assert.doesNotMatch(tiny.text, /已完成/);

		// 缺省拒绝：未授权目标项目。
		const unauthorized = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, taskId: "task-1", ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectB.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 6 });
		assert.equal(unauthorized.status, "not-authorized");
		assert.equal(unauthorized.text, "");
	} finally {
		await sb.cleanup();
	}
});

test("C2：保存/新进程重验；任务重开与来源变化使旧清单 stale；同 ID 替换 CAS", async () => {
	const sb = await sandbox();
	try {
		await seedReviewed(sb);
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "关闭 PXE 缩短启动时间", authorizedProjectIds: [sb.projectA.projectId] });
		const linked = await updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, changes: { sourceExperienceIds: ["exp-ref"] }, authorizedProjectIds: [sb.projectA.projectId], now: NOW + 2 });

		const handoff = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 3,
		});
		const saved = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: handoff.profileRevision ?? 0,
			sources: handoff.sources,
			expiredSources: handoff.expiredSources,
			budget: { maxChars: handoff.budget.maxChars, maxBytes: handoff.budget.maxBytes, usedChars: handoff.budget.usedChars, truncated: handoff.budget.truncated },
			generatedAt: handoff.generatedAt,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 4,
		});
		assert.equal(saved.status, "saved");

		// 新进程重验：revision 一致 ⇒ ok（但来源标 unproven，v1 无耐久指纹）。
		const fresh = await verifyContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			projectId: sb.projectA.projectId,
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
		});
		assert.equal(fresh.status, "ok");
		assert.equal(fresh.profileState, "current");
		assert.ok(
			fresh.sources.some((source) => source.state === "unproven"),
			"v1 必须明确 unproven，不宣称内容完全一致",
		);

		// 任务重开（planned → in_progress → done → in_progress）：旧清单 stale。
		const started = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: linked.revision, to: "in_progress", reason: "开工", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 5 });
		assert.equal(started.status, "changed");
		const afterStart = await verifyContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			projectId: sb.projectA.projectId,
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
		});
		assert.equal(afterStart.status, "stale", "任务 revision 变了，旧清单不得继续用");
		const done = await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: started.revision, to: "done", reason: "声明完成", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 5 });
		assert.equal(done.status, "changed");
		const afterDone = await verifyContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			projectId: sb.projectA.projectId,
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
		});
		assert.equal(afterDone.status, "stale");
		const doneDetail = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		await changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: doneDetail.revision, to: "in_progress", reason: "重开", authorizedProjectIds: [sb.projectA.projectId], now: NOW + 6 });
		const afterReopen = await verifyContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			projectId: sb.projectA.projectId,
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
		});
		assert.equal(afterReopen.status, "stale", "旧交接的 done 不得覆盖重开后的 in_progress");

		// 新交接显示 in_progress，不续跑旧 done。
		const newHandoff = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, taskId: "task-1", ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 7 });
		assert.match(newHandoff.text, /状态：in_progress/);

		// 来源变化（经验被 request-changes 回草稿）⇒ stale。
		const detail = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		const manifest2 = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-2",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: newHandoff.profileRevision ?? 0,
			sources: newHandoff.sources,
			budget: { maxChars: 12000, maxBytes: 4096, usedChars: newHandoff.budget.usedChars, truncated: false },
			generatedAt: NOW + 8,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 8,
		});
		assert.equal(manifest2.status, "saved");
		const experienceRevision =
			(await verifyContextManifest({ root: sb.root, manifestId: "manifest-2", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } })).sources.find((source) => source.recordKind === "experience-card")
				?.actualRevision ?? 0;
		await reviewExperience({ root: sb.root, authorizedProjectIds: [sb.projectA.projectId], experienceId: "exp-ref", expectedRevision: experienceRevision, action: "request-changes", operatorLabel: "engineer", reason: "需要修订", now: NOW + 9 });
		const afterExperienceChange = await verifyContextManifest({ root: sb.root, manifestId: "manifest-2", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] } });
		assert.equal(afterExperienceChange.status, "stale");
		assert.ok(afterExperienceChange.sources.some((source) => source.state === "changed"));

		// 同 ID 不给 expectedRevision ⇒ 仍按"创建"处理 ⇒ CAS 冲突（要替换必须显式给 expectedRevision）。
		// 用**当前**来源重建（经验已 request-changes，旧 sources 的 revision 已过期）。
		const freshHandoff = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, taskId: "task-1", ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 10 });
		const replacementSources = freshHandoff.sources.filter((source) => source.recordKind !== "experience-card");
		const duplicate = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: freshHandoff.profileRevision ?? 0,
			sources: replacementSources,
			budget: { maxChars: 12000, maxBytes: 4096, usedChars: 0, truncated: false },
			generatedAt: NOW + 10,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 10,
		});
		assert.equal(duplicate.status, "revision-conflict");
		// R30-4：给出正确 expectedRevision ⇒ 真正**替换**（同一 manifest ID，revision 前进）。
		const replaced = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: freshHandoff.profileRevision ?? 0,
			sources: replacementSources,
			budget: { maxChars: 12000, maxBytes: 4096, usedChars: 0, truncated: false },
			generatedAt: NOW + 10,
			authorizedProjectIds: [sb.projectA.projectId],
			expectedRevision: 0,
			now: NOW + 10,
		});
		assert.equal(replaced.status, "replaced");
		assert.equal(replaced.revision, 1);
		// 错误的 expectedRevision ⇒ 冲突且不覆盖。
		const staleReplace = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-1",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: freshHandoff.profileRevision ?? 0,
			sources: replacementSources,
			budget: { maxChars: 12000, maxBytes: 4096, usedChars: 0, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			expectedRevision: 0,
			now: NOW + 10,
		});
		assert.equal(staleReplace.status, "revision-conflict");
		void detail;

		// 任务来源必须是本次选择的当前任务；不支持的族有界拒绝（返回受控状态，不抛未处理异常）。
		const wrongTask = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-3",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: newHandoff.profileRevision ?? 0,
			sources: [{ recordKind: "task-record", recordId: "task-other", revision: 0, reason: "别的任务" }],
			budget: { maxChars: 1, maxBytes: 1, usedChars: 0, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 11,
		});
		assert.equal(wrongTask.status, "invalid-sources");
		// 身份守卫与 verify 共用（R31-4）：文案是"不是所选当前任务"。
		assert.ok(wrongTask.problems.some((problem) => /不是所选当前任务/.test(problem)));
		const badKind = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-4",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: newHandoff.profileRevision ?? 0,
			sources: [{ recordKind: "session-summary", recordId: "x", revision: 0, reason: "不支持的族" }],
			budget: { maxChars: 1, maxBytes: 1, usedChars: 0, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 12,
		});
		assert.equal(badKind.status, "invalid-sources");
		assert.ok(badKind.problems.some((problem) => /不支持的来源族/.test(problem)));
		// 未授权 Feature 不能手工塞进 sources（R30-4）。
		const unauthorizedFeature = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-5",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			profileRevision: newHandoff.profileRevision ?? 0,
			sources: [{ recordKind: "feature-record", recordId: "feat-hidden", revision: 0, reason: "未授权需求" }],
			budget: { maxChars: 1, maxBytes: 1, usedChars: 0, truncated: false },
			generatedAt: NOW,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 13,
		});
		assert.equal(unauthorizedFeature.status, "invalid-sources");
		assert.ok(unauthorizedFeature.problems.some((problem) => /没有显式授权/.test(problem)));

		// 只读不写：重验/组装不得新增或改动任务与清单。
		const tasks = await listRecords({ root: sb.root, kind: "task-record", projectId: sb.projectA.projectId });
		assert.equal(tasks.entries.length, 1);
		const manifests = await listRecords({ root: sb.root, kind: "context-manifest", projectId: sb.projectA.projectId });
		assert.equal(manifests.entries.length, 2);

		// 缩小授权 ⇒ 重验不再给出结论。
		const narrowed = await verifyContextManifest({ root: sb.root, manifestId: "manifest-2", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectB.projectId] });
		assert.equal(narrowed.status, "not-authorized");

		// 磁盘上确实存在清单文件（不是内存假象）。
		const disk = JSON.parse(await readFile(join(sb.root, "projects", sb.projectA.projectId, "context", "manifest-2.json"), "utf8"));
		assert.equal(disk.targetProjectId, sb.projectA.projectId);
		assert.ok(disk.sources.some((source) => source.recordKind === "task-record"));
	} finally {
		await sb.cleanup();
	}
});
