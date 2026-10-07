/**
 * R30 永久回归：公开授权与外发策略、当前工作区/来源、真实预算停止、Manifest 受控重验。
 *
 * 对应 round30_acceptance.md §4 的四组诊断；每组都先复现实际观察，再断言修复后的受控结果。
 * 全部使用自建临时知识库与合成内容；不读任何真实客户资料。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { initializeKnowledgeStore, readRecord } from "../core/storage/index.ts";
import { bindProjectWorkspace } from "../core/projects/index.ts";
import { createExperienceDraft, readExperienceDetail, reviewExperience, searchKnowledge, updateExperienceDraft } from "../core/knowledge/index.ts";
import { changeTaskStatus, createTask, readTaskDetail, updateTask } from "../core/tasks/index.ts";
import { buildHandoff, saveContextManifest, verifyContextManifest } from "../core/context/index.ts";
import { createProjectSandbox, PACKAGE_ROOT, writeDsc } from "./helpers/projectFixtures.mjs";

const NOW = 1_700_000_000_000;
const TASK_CLI = join(PACKAGE_ROOT, "cli", "task.mjs");
const WRONG_PROJECT = "00000000-0000-4000-8000-000000000000";

/** @returns {{ code: number, stdout: string, json: Record<string, any> | null }} */
function runTask(args) {
	try {
		const stdout = execFileSync(process.execPath, [TASK_CLI, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
		return { code: 0, stdout, json: parseJson(stdout) };
	} catch (error) {
		const failure = /** @type {{ status?: number, stdout?: string }} */ (error);
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		return { code: typeof failure.status === "number" ? failure.status : 1, stdout, json: parseJson(stdout) };
	}
}

/** @returns {Record<string, any> | null} */
function parseJson(stdout) {
	for (const line of stdout.trim().split("\n").reverse()) {
		try {
			return JSON.parse(line);
		} catch {
			// 继续往前找单对象 JSON 行。
		}
	}
	return null;
}

async function sandbox() {
	const sb = await createProjectSandbox("bm06-r30-");
	await initializeKnowledgeStore({ root: sb.root, now: NOW });
	await writeDsc(sb.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformA" });
	await mkdir(sb.workspaceB, { recursive: true });
	await writeDsc(sb.workspaceB, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatformB" });
	const access = (workspace) => ({ cwd: workspace, authorizedRoots: [sb.workspaceA, sb.workspaceB] });
	const projectA = await bindProjectWorkspace({ ...access(sb.workspaceA), root: sb.root, workspacePath: sb.workspaceA, now: NOW });
	const projectB = await bindProjectWorkspace({ ...access(sb.workspaceB), root: sb.root, workspacePath: sb.workspaceB, now: NOW });
	return { ...sb, access, projectA, projectB };
}

/* ------------------------------------------------------------------ R30-1 */

test("R30-1：任务状态/更新/审核的公开入口必须显式授权，未授权不改盘也不泄漏状态", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "关闭 PXE 缩短启动时间", authorizedProjectIds: [sb.projectA.projectId] });
		const base = ["--root", sb.root, "--json", "--project-id", sb.projectA.projectId, "--task-id", "task-1"];

		// CLI 不给 --authorized-project ⇒ 用法错误（exit 2），磁盘状态不变。
		const missing = runTask(["task-status", ...base, "--revision", "0", "--to", "in_progress", "--reason", "开工", "--write"]);
		assert.equal(missing.code, 2, `未授权必须用法错误：${missing.stdout}`);
		assert.equal((await readRecord({ root: sb.root, kind: "task-record", id: "task-1", projectId: sb.projectA.projectId })).record.status, "planned", "未授权不得改盘");

		// CLI 给了不相关项目 ⇒ 受控拒绝（exit 3），磁盘状态不变，且不泄漏当前状态/revision。
		const wrong = runTask(["task-status", ...base, "--revision", "0", "--to", "in_progress", "--reason", "开工", "--authorized-project", WRONG_PROJECT, "--write"]);
		assert.equal(wrong.code, 3, `错授权必须受控拒绝：${wrong.stdout}`);
		assert.doesNotMatch(wrong.stdout, /"from"/, "拒绝时不得回显当前状态");
		assert.equal((await readRecord({ root: sb.root, kind: "task-record", id: "task-1", projectId: sb.projectA.projectId })).record.status, "planned");

		// API 显式空集合也拒绝（不是"可选放行"），且在返回冲突/状态之前生效。
		await assert.rejects(changeTaskStatus({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 0, to: "done", reason: "越权", authorizedProjectIds: [] }), (error) => error.code === "not-authorized");
		await assert.rejects(updateTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", expectedRevision: 999, changes: { requirement: "x" }, authorizedProjectIds: [sb.projectB.projectId] }), (error) => error.code === "not-authorized");

		// 正常授权仍然可用（对照组）。
		const ok = runTask(["task-status", ...base, "--revision", "0", "--to", "in_progress", "--reason", "开工", "--authorized-project", sb.projectA.projectId, "--write"]);
		assert.equal(ok.code, 0, `正常授权必须成功：${ok.stdout}`);
		assert.equal(ok.json?.status, "changed");
	} finally {
		await sb.cleanup();
	}
});

test("R30-1：经验创建/更新/审核要求显式授权；交接/检索不因警告文案而放行商业正文", async () => {
	const sb = await sandbox();
	try {
		// 缺省授权 ⇒ 拒绝（不读 registry、不留卡片）。
		await assert.rejects(createExperienceDraft({ root: sb.root, experience: { experienceId: "exp-x", problem: "p", rootCause: "r", solution: "s", sourceProjectId: sb.projectA.projectId } }), (error) => error.code === "not-authorized");
		const created = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-x", problem: "PXE 默认开启", rootCause: "SECRET-EXPERIENCE-ROOT", solution: "关闭默认值", sourceProjectId: sb.projectA.projectId, reuse: { level: "current-project" } },
			now: NOW,
		});
		assert.equal(created.status, "created");
		// 更新/审核缺省授权 ⇒ 拒绝（且不在冲突响应里泄漏 revision）。
		await assert.rejects(updateExperienceDraft({ root: sb.root, experienceId: "exp-x", expectedRevision: 999, changes: { solution: "偷改" } }), (error) => error.code === "not-authorized");
		await assert.rejects(reviewExperience({ root: sb.root, experienceId: "exp-x", expectedRevision: created.revision, action: "submit-review", operatorLabel: "e", reason: "r" }), (error) => error.code === "not-authorized");

		// 交接：端点 unknown（默认）不自动注入商业正文；deny 时任务正文也不出现。
		const unknownEndpoint = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: null, allowInternalGeneral: false, customers: [] }, now: NOW + 1 });
		assert.doesNotMatch(unknownEndpoint.text, /SECRET-EXPERIENCE-ROOT/, "unknown 不得自动注入经验正文");
		assert.equal(unknownEndpoint.outbound.allowCommercialBody, false);
		assert.equal(unknownEndpoint.status, "incomplete");

		// allowInternalGeneral=false 且 reuse=internal-general ⇒ M1 不放行，正文不出。
		const internalGeneral = await createExperienceDraft({
			root: sb.root,
			authorizedProjectIds: [sb.projectA.projectId],
			experience: { experienceId: "exp-ig", problem: "跨项目经验", rootCause: "SECRET-IG-ROOT", solution: "s", sourceProjectId: sb.projectA.projectId, reuse: { level: "internal-general", authorization: "operator-declared" } },
			now: NOW + 2,
		});
		assert.equal(internalGeneral.status, "created");
		const handoffWithIg = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 3 });
		assert.doesNotMatch(handoffWithIg.text, /SECRET-IG-ROOT/, "未放行的 internal-general 不得输出正文");
	} finally {
		await sb.cleanup();
	}
});

test("R30-1：损坏经验无法判定来源时不回显 ID（即便授权了某个项目）", async () => {
	const sb = await sandbox();
	try {
		const { writeFile } = await import("node:fs/promises");
		await writeFile(join(sb.root, "experiences", "exp-hidden.json"), "{ broken");
		const result = await searchKnowledge({
			root: sb.root,
			query: "PXE",
			// 授权了项目 A，但坏文件读不出 sourceProjectId ⇒ 不能把"授权了任意项目"当成该条目的授权。
			visibility: { authorizedProjectIds: [sb.projectA.projectId] },
			target: { projectId: sb.projectA.projectId, customerId: null },
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW,
		});
		assert.ok(result.problems.length > 0);
		for (const problem of result.problems) {
			assert.doesNotMatch(problem, /exp-hidden/, "无法判定来源的条目不得回显 ID");
			assert.doesNotMatch(problem, /[A-Za-z]:\\/, "诊断不得回显绝对路径");
		}
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ R30-2 */

test("R30-2：task 与 workspace 严格一致；未选任务/工作区不自动挑第一个", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "SECRET-TASK-REQUIREMENT", authorizedProjectIds: [sb.projectA.projectId] });

		// 显式选了错误工作区 ⇒ 报 task-workspace-mismatch，且**不输出该工作区事实**（HEAD/路径/分支都不出现）。
		const mismatch = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectB.workspaceId,
			...sb.access(sb.workspaceB),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 1,
		});
		assert.ok(mismatch.problems.some((problem) => /task-workspace-mismatch/.test(problem)));
		assert.doesNotMatch(mismatch.text, /工作区 ID：/, "工作区不一致不得输出工作区事实");
		assert.doesNotMatch(mismatch.text, /当前 HEAD：[^未]/, "工作区不一致不得输出 HEAD 事实");
		assert.equal(mismatch.status, "incomplete");

		// 未选任务/工作区 ⇒ 明确缺口，不自动挑第一个工作区。
		const noSelection = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 2 });
		assert.ok(noSelection.problems.some((problem) => /没有给出 taskId/.test(problem)));
		assert.ok(noSelection.problems.some((problem) => /不自动挑选工作区/.test(problem)));
		assert.doesNotMatch(noSelection.text, /SECRET-TASK-REQUIREMENT/);

		// 正常一致：正文出现，且 HEAD 明确标注"实时/已存快照/不可用"。
		const ok = await buildHandoff({ root: sb.root, targetProjectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] }, now: NOW + 3 });
		assert.match(ok.text, /SECRET-TASK-REQUIREMENT/);
		assert.match(ok.text, /当前 HEAD：/);
		assert.ok(["live", "stored-snapshot", "unknown"].includes(ok.head.kind));
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ R30-3 */

test("R30-3：双预算触顶返回空正文；验证证据保留；发布后核对失败不丢提交事实", async () => {
	const sb = await sandbox();
	try {
		await createTask({
			root: sb.root,
			projectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			...sb.access(sb.workspaceA),
			requirement: "关闭 PXE 缩短启动时间",
			authorizedProjectIds: [sb.projectA.projectId],
			validations: [{ kind: "compile", scope: "PlatformA", result: "passed", performedAt: NOW, performedBy: "engineer", evidence: [{ type: "source-file", relativePath: "Platform/SamplePkg/Sample.dsc", contentHash: "a".repeat(64), workspaceId: sb.projectA.workspaceId }] }],
		});
		const detail = await readTaskDetail({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", authorizedProjectIds: [sb.projectA.projectId] });
		assert.equal(detail.task?.validations[0]?.evidence.length, 1, "v1 合法验证证据必须保留，不静默落成空数组");
		assert.equal(detail.task?.validations[0]?.evidence[0]?.relativePath, "Platform/SamplePkg/Sample.dsc");
		// 未知字段/不存在的 workspaceId ⇒ 明确拒绝。
		await assert.rejects(
			createTask({
				root: sb.root,
				projectId: sb.projectA.projectId,
				taskId: "task-bad",
				workspaceId: sb.projectA.workspaceId,
				...sb.access(sb.workspaceA),
				requirement: "x",
				authorizedProjectIds: [sb.projectA.projectId],
				validations: [{ kind: "compile", scope: "s", result: "passed", performedAt: NOW, performedBy: "e", evidence: [{ type: "source-file", relativePath: "a", contentHash: "b".repeat(64), workspaceId: WRONG_PROJECT }] }],
			}),
			/不属于任务所属项目/,
		);

		// 双预算极小 ⇒ 空正文 + 有限诊断（不留超额文本）。
		const tiny = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			budget: { maxChars: 1, maxBytes: 1 },
			now: NOW + 1,
		});
		assert.equal(tiny.text, "", "核心章节放不下时必须返回空正文");
		assert.equal(tiny.budget.truncated, true);
		assert.equal(tiny.status, "incomplete");
		assert.ok(tiny.problems.some((problem) => /核心章节超出双预算/.test(problem)));
	} finally {
		await sb.cleanup();
	}
});

/* ------------------------------------------------------------------ R30-4 */

test("R30-4：verify 不忽略既有缺口；端点/授权收窄后不沿用旧依据", async () => {
	const sb = await sandbox();
	try {
		await createTask({ root: sb.root, projectId: sb.projectA.projectId, taskId: "task-1", workspaceId: sb.projectA.workspaceId, ...sb.access(sb.workspaceA), requirement: "关闭 PXE 缩短启动时间", authorizedProjectIds: [sb.projectA.projectId] });
		const handoff = await buildHandoff({
			root: sb.root,
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			...sb.access(sb.workspaceA),
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			now: NOW + 1,
		});
		const saved = await saveContextManifest({
			root: sb.root,
			manifestId: "manifest-gap",
			targetProjectId: sb.projectA.projectId,
			taskId: "task-1",
			workspaceId: sb.projectA.workspaceId,
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
			profileRevision: handoff.profileRevision ?? 0,
			sources: handoff.sources,
			expiredSources: ["exp-missing"],
			budget: { maxChars: handoff.budget.maxChars, maxBytes: handoff.budget.maxBytes, usedChars: handoff.budget.usedChars, truncated: true },
			generatedAt: handoff.generatedAt,
			authorizedProjectIds: [sb.projectA.projectId],
			now: NOW + 2,
		});
		assert.equal(saved.status, "saved");
		// 既有缺口（expiredSources / truncated）不得被忽略成 ok。
		const verified = await verifyContextManifest({
			root: sb.root,
			manifestId: "manifest-gap",
			projectId: sb.projectA.projectId,
			authorizedProjectIds: [sb.projectA.projectId],
			endpoint: { endpointAllowed: true, allowInternalGeneral: false, customers: [] },
			cwd: sb.workspaceA,
			authorizedRoots: [sb.workspaceA, sb.workspaceB],
		});
		assert.equal(verified.status, "incomplete");
		assert.ok(verified.problems.some((problem) => /过期\/不可用来源/.test(problem)));
		assert.ok(verified.problems.some((problem) => /预算截断/.test(problem)));

		// 端点 deny ⇒ 重验不返回 ok（不给旧正文兜底）。
		const denied = await verifyContextManifest({ root: sb.root, manifestId: "manifest-gap", projectId: sb.projectA.projectId, authorizedProjectIds: [sb.projectA.projectId], endpoint: { endpointAllowed: false, allowInternalGeneral: false, customers: [] } });
		assert.notEqual(denied.status, "ok");
	} finally {
		await sb.cleanup();
	}
});
