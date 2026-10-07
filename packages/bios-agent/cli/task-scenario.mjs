#!/usr/bin/env node
/**
 * BM-05 **任务 / 交接闭环演示**（`node cli/task-scenario.mjs`）。
 *
 * 每一步都用**真实 CLI 子进程**（`cli/project.mjs` 绑定，`cli/business.mjs` 经验，`cli/task.mjs` 任务/交接），
 * 因此"新进程读回""旧清单失效""一成一败的 CAS"都是真的；只对合成临时目录读写，不读任何真实客户资料。
 *
 * 对应 bm05_development_plan.md §4 C3 的 7 条：
 * 1. 同项目两个工作区 + 另一个项目的同裸 taskId ⇒ 独立任务；
 * 2. 更新决定/待办/阻塞、引用已 reviewed 经验、保存验证声明；
 * 3. 生成并保存有界交接包来源清单，新进程重验同任务/revision/工作区；
 * 4. 工程师标 done 后显式重开；旧 Manifest stale，新交接是 in_progress；
 * 5. 修改经验/缩小授权/deny 端点；重验不会恢复旧结论；
 * 6. 任务经验沉淀只得到 draft，新进程读回，未自动审核；关联回任务的第二步 CAS 冲突保留半完成事实；
 * 7. 预算不足、journal 终态故障（预加载注入）、并发同 revision 一成一败都有受控结果。
 *
 * 输出：一段可解析 JSON（`status` + `steps`），任一步不符合预期则 exit 1。
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initializeKnowledgeStore } from "../core/storage/index.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PROJECT_CLI = join(PACKAGE_ROOT, "cli", "project.mjs");
const BUSINESS_CLI = join(PACKAGE_ROOT, "cli", "business.mjs");
const TASK_CLI = join(PACKAGE_ROOT, "cli", "task.mjs");
const FAULT_PRELOAD = pathToFileURL(join(PACKAGE_ROOT, "tests", "helpers", "journalFaultPreload.mjs")).href;

/**
 * @typedef {{
 *   status?: string, code?: string, exitCode?: number, revision?: number | null, changedFields?: string[], referenceGaps?: string[],
 *   task?: { requirement?: string, status?: string, decisions?: string[], todos?: string[], blockers?: string[], sourceExperienceIds?: string[], workspace?: { workspaceId?: string }, validations?: Array<{ kind: string }> } | null,
 *   references?: Array<{ experienceId: string, usableAsBasis: boolean, reason: string | null }>,
 *   text?: string, budget?: { truncated?: boolean }, sources?: Array<{ recordKind: string, state: string }>,
 *   status_after?: string, stateAfter?: string, card?: { status?: string, status_after?: string } | null, needsReview?: string[],
 *   from?: string | null, to?: string, workspaceId?: string | null, projectId?: string, taskId?: string | null
 * }} Payload
 */

/** @type {Array<Record<string, unknown>>} */
const steps = [];
/** @type {string[]} */
const failures = [];

/**
 * 跑真实 CLI 子进程。
 * @param {string} cli @param {string[]} args @param {{ preload?: string }} [options] @returns {{ code: number, json: Payload | null, stdout: string }}
 */
function runCli(cli, args, options = {}) {
	const nodeArgs = [...(options.preload === undefined ? [] : ["--import", options.preload]), cli, ...args];
	try {
		const stdout = execFileSync(process.execPath, nodeArgs, { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
		return { code: 0, json: parseJson(stdout), stdout };
	} catch (error) {
		const failure = /** @type {{ status?: number, stdout?: string }} */ (error);
		const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
		return { code: typeof failure.status === "number" ? failure.status : 1, json: parseJson(stdout), stdout };
	}
}

/** @param {string} stdout @returns {Payload | null} */
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

/**
 * 记录一步。
 * @param {string} name @param {Record<string, unknown>} detail @param {boolean} ok
 */
function record(name, detail, ok) {
	steps.push({ name, ok, ...detail });
	if (!ok) failures.push(name);
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

const base = await mkdtemp(join(tmpdir(), "bm05-scenario-"));
const root = join(base, "knowledge");
const wsA = join(base, "ws-a");
const wsB = join(base, "ws-b");
const wsC = join(base, "ws-c");

/** @param {string} platformName @returns {string} */
const dsc = (platformName) => ["[Defines]", `  PLATFORM_NAME = ${platformName}`, "", "[Components]", "  Sample.inf", ""].join("\n");
/** @param {string} workspace @returns {string[]} */
const accessArgs = (workspace) => ["--root", root, "--cwd", workspace, "--authorized-root", wsA, "--authorized-root", wsB, "--authorized-root", wsC, "--json"];
const businessArgs = ["--root", root, "--json"];
const taskBase = ["--root", root, "--json"];

try {
	for (const workspace of [wsA, wsB, wsC]) {
		await mkdir(join(workspace, "Platform"), { recursive: true });
		await writeFile(join(workspace, "Platform", "P.dsc"), dsc(`Platform-${workspace.slice(-1)}`));
	}
	await initializeKnowledgeStore({ root });

	// ---- 0) 绑定两个项目，并给项目 A 绑定第二个工作区 ----
	const boundA = runCli(PROJECT_CLI, ["bind", ...accessArgs(wsA), "--workspace", wsA, "--write"]);
	const boundB = runCli(PROJECT_CLI, ["bind", ...accessArgs(wsB), "--workspace", wsB, "--write"]);
	assert(boundA.code === 0 && boundB.code === 0, `绑定失败：${boundA.stdout} / ${boundB.stdout}`);
	const projectA = /** @type {string} */ (boundA.json?.projectId);
	const projectB = /** @type {string} */ (boundB.json?.projectId);
	const workspaceA = /** @type {string} */ (boundA.json?.workspaceId);
	const boundC = runCli(PROJECT_CLI, ["bind", ...accessArgs(wsC), "--workspace", wsC, "--project-id", projectA, "--write"]);
	assert(boundC.code === 0, `为项目 A 绑定第二工作区失败：${boundC.stdout}`);
	const workspaceC = /** @type {string} */ (boundC.json?.workspaceId);

	// ---- 1) 同项目两个工作区 + 另一个项目的同裸 taskId ----
	const createA = runCli(TASK_CLI, [
		"task-create",
		...taskBase,
		"--project-id",
		projectA,
		"--task-id",
		"task-shared",
		"--workspace-id",
		workspaceA,
		"--cwd",
		wsA,
		"--authorized-root",
		wsA,
		"--authorized-root",
		wsC,
		"--authorized-project",
		projectA,
		"--requirement",
		"关闭 PXE 缩短启动时间",
		"--todo",
		"复现 PXE 引导",
		"--blocker",
		"缺少目标板",
		"--write",
	]);
	const createB = runCli(TASK_CLI, ["task-create", ...taskBase, "--project-id", projectB, "--task-id", "task-shared", "--workspace-id", boundB.json?.workspaceId ?? "", "--cwd", wsB, "--authorized-root", wsB, "--authorized-project", projectB, "--requirement", "另一个项目的同名任务", "--write"]);
	const createC = runCli(TASK_CLI, ["task-create", ...taskBase, "--project-id", projectA, "--task-id", "task-second", "--workspace-id", workspaceC, "--cwd", wsC, "--authorized-root", wsC, "--authorized-project", projectA, "--requirement", "同项目另一个工作区的任务", "--write"]);
	assert(createA.code === 0 && createB.code === 0 && createC.code === 0, `创建任务失败：${createA.stdout} / ${createB.stdout} / ${createC.stdout}`);
	const showA = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--authorized-project", projectA]);
	const showB = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectB, "--task-id", "task-shared", "--authorized-project", projectB]);
	record(
		"同裸 taskId 跨项目独立、同项目双工作区独立",
		{ projectA, projectB, firstRequirement: showA.json?.task?.requirement ?? null, secondRequirement: showB.json?.task?.requirement ?? null, workspaceA: showA.json?.task?.workspace?.workspaceId ?? null, workspaceC },
		showA.json?.task?.requirement === "关闭 PXE 缩短启动时间" && showB.json?.task?.requirement === "另一个项目的同名任务" && showA.json?.task?.workspace?.workspaceId === workspaceA,
	);

	// ---- 2) 引入一条已审核经验，更新决定/待办/阻塞、引用与验证 ----
	const createdExp = runCli(BUSINESS_CLI, [
		"experience-create",
		...businessArgs,
		"--experience-id",
		"exp-pxe",
		"--problem",
		"PXE 默认开启导致启动变慢",
		"--root-cause",
		"平台默认值未关闭 PXE",
		"--solution",
		"在平台 DSC 里关闭 PXE 默认值",
		"--source-project",
		projectA,
		"--authorized-project",
		projectA,
		"--reuse-level",
		"current-project",
		"--write",
	]);
	assert(createdExp.code === 0, `录入经验失败:${createdExp.stdout}`);
	const reviewedExp = runCli(BUSINESS_CLI, ["review", ...businessArgs, "--experience-id", "exp-pxe", "--revision", "0", "--action", "submit-review", "--operator", "engineer-scenario", "--reason", "可复用", "--authorized-project", projectA, "--write"]);
	assert(reviewedExp.code === 0, `审核经验失败:${reviewedExp.stdout}`);
	const updateTask = runCli(TASK_CLI, [
		"task-update",
		...taskBase,
		"--project-id",
		projectA,
		"--task-id",
		"task-shared",
		"--revision",
		"0",
		"--authorized-project",
		projectA,
		"--decision",
		"先在 DSC 关闭默认值",
		"--todo",
		"复现 PXE 引导",
		"--todo",
		"关闭默认值并回归",
		"--blocker",
		"缺少目标板",
		"--source-experience",
		"exp-pxe",
		"--validation",
		"compile:Platform-A:passed:1700000000000:engineer-scenario",
		"--write",
	]);
	assert(updateTask.code === 0, `更新任务失败:${updateTask.stdout}`);
	const showUpdated = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--authorized-project", projectA]);
	const expRef = (showUpdated.json?.references ?? []).find((reference) => reference.experienceId === "exp-pxe");
	record(
		"更新决定/待办/阻塞、引用已审核经验并保存验证声明",
		{ changedFields: updateTask.json?.changedFields ?? [], referenceGaps: updateTask.json?.referenceGaps ?? [], usableAsBasis: expRef?.usableAsBasis ?? null, validations: (showUpdated.json?.task?.validations ?? []).map((validation) => validation.kind) },
		updateTask.json?.status === "updated" && expRef?.usableAsBasis === true && (showUpdated.json?.task?.validations ?? []).length === 1 && (showUpdated.json?.task?.validations ?? [])[0]?.kind === "compile",
	);

	// ---- 3) 组装并保存交接清单，新进程重验 ----
	const taskRevision = showUpdated.json?.revision ?? 1;
	const build1 = runCli(TASK_CLI, ["context-build", ...taskBase, "--target-project", projectA, "--task-id", "task-shared", "--workspace-id", workspaceA, "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "allowed"]);
	const save1 = runCli(TASK_CLI, ["context-save", ...taskBase, "--write", "--manifest-id", "manifest-1", "--target-project", projectA, "--task-id", "task-shared", "--workspace-id", workspaceA, "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "allowed"]);
	const verify1 = runCli(TASK_CLI, ["context-verify", ...taskBase, "--manifest-id", "manifest-1", "--project-id", projectA, "--authorized-project", projectA, "--endpoint", "allowed", "--cwd", wsA, "--authorized-root", wsA]);
	record(
		"生成并保存有界交接来源清单；新进程重验同任务/revision/工作区",
		{
			buildStatus: build1.json?.status ?? null,
			saveStatus: save1.json?.status ?? null,
			verifyStatus: verify1.json?.status ?? null,
			sourceKinds: (verify1.json?.sources ?? []).map((source) => source.recordKind),
			textHasTask: typeof build1.json?.text === "string" && build1.json.text.includes("关闭 PXE 缩短启动时间"),
			textHasHead: typeof build1.json?.text === "string" && /当前可观察 HEAD/.test(build1.json.text),
		},
		build1.json?.status !== undefined && save1.json?.status === "saved" && verify1.json?.status === "ok" && (verify1.json?.sources ?? []).some((source) => source.recordKind === "task-record") && (verify1.json?.sources ?? []).some((source) => source.state === "unproven"),
	);

	// ---- 4) done 后显式重开；旧清单 stale，新交接是 in_progress ----
	const started = runCli(TASK_CLI, ["task-status", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--revision", String(taskRevision), "--to", "in_progress", "--reason", "开工", "--authorized-project", projectA, "--write"]);
	const done = runCli(TASK_CLI, ["task-status", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--revision", String(started.json?.revision ?? taskRevision), "--to", "done", "--reason", "工程师声明完成", "--authorized-project", projectA, "--write"]);
	const staleAfterDone = runCli(TASK_CLI, ["context-verify", ...taskBase, "--manifest-id", "manifest-1", "--project-id", projectA, "--authorized-project", projectA, "--endpoint", "allowed", "--cwd", wsA, "--authorized-root", wsA]);
	const reopened = runCli(TASK_CLI, ["task-status", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--revision", String(done.json?.revision ?? taskRevision), "--to", "in_progress", "--reason", "发现问题继续", "--authorized-project", projectA, "--write"]);
	const rebuild = runCli(TASK_CLI, ["context-build", ...taskBase, "--target-project", projectA, "--task-id", "task-shared", "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "allowed"]);
	record(
		"done 后显式重开：旧清单 stale，新交接为 in_progress",
		{ doneStatus: done.json?.from ?? null, reopenedFrom: reopened.json?.from ?? null, reopenedTo: reopened.json?.to ?? null, staleStatus: staleAfterDone.json?.status ?? null, newHandoffHasInProgress: typeof rebuild.json?.text === "string" && rebuild.json.text.includes("状态：in_progress") },
		done.json?.status === "changed" && reopened.json?.status === "changed" && staleAfterDone.json?.status === "stale" && typeof rebuild.json?.text === "string" && rebuild.json.text.includes("状态：in_progress"),
	);

	// ---- 5) 修改经验 / 缩小授权 / deny 端点：重验不恢复旧结论 ----
	const save2 = runCli(TASK_CLI, ["context-save", ...taskBase, "--write", "--manifest-id", "manifest-2", "--target-project", projectA, "--task-id", "task-shared", "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "allowed"]);
	assert(save2.json?.status === "saved", `保存 manifest-2 失败：${save2.stdout}`);
	const changedExp = runCli(BUSINESS_CLI, ["review", ...businessArgs, "--experience-id", "exp-pxe", "--revision", String(reviewedExp.json?.revision ?? 1), "--action", "request-changes", "--operator", "engineer-scenario", "--reason", "需要修订", "--authorized-project", projectA, "--write"]);
	const staleAfterExp = runCli(TASK_CLI, ["context-verify", ...taskBase, "--manifest-id", "manifest-2", "--project-id", projectA, "--authorized-project", projectA, "--endpoint", "allowed", "--cwd", wsA, "--authorized-root", wsA]);
	const narrowed = runCli(TASK_CLI, ["context-verify", ...taskBase, "--manifest-id", "manifest-2", "--project-id", projectA, "--authorized-project", projectB]);
	const deniedBuild = runCli(TASK_CLI, ["context-build", ...taskBase, "--target-project", projectA, "--task-id", "task-shared", "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "denied"]);
	record(
		"来源变化/缩小授权/deny 端点：重验与组装都不恢复旧结论",
		{
			experienceChangeStatus: changedExp.json?.stateAfter ?? null,
			staleStatus: staleAfterExp.json?.status ?? null,
			staleSourceStates: (staleAfterExp.json?.sources ?? []).map((source) => source.state),
			narrowedStatus: narrowed.json?.status ?? null,
			deniedLeaksBody: typeof deniedBuild.json?.text === "string" && deniedBuild.json.text.includes("平台默认值"),
		},
		changedExp.code === 0 && staleAfterExp.json?.status === "stale" && narrowed.json?.status === "not-authorized" && !(typeof deniedBuild.json?.text === "string" && deniedBuild.json.text.includes("平台默认值")),
	);

	// ---- 6) 任务经验沉淀只得到 draft；关联回任务的第二步 CAS 冲突保留半完成事实 ----
	const beforeDraft = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--authorized-project", projectA]);
	const draftSaved = runCli(TASK_CLI, [
		"task-save-draft",
		...taskBase,
		"--write",
		"--project-id",
		projectA,
		"--task-id",
		"task-shared",
		"--authorized-project",
		projectA,
		"--experience-id",
		"exp-from-task",
		"--problem",
		"从任务沉淀的现象",
		"--root-cause",
		"人工确认的根因",
		"--solution",
		"人工确认的方案",
		"--link-task-revision",
		String(beforeDraft.json?.revision ?? 0),
	]);
	const readBack = runCli(BUSINESS_CLI, ["experience-show", ...businessArgs, "--experience-id", "exp-from-task", "--authorized-project", projectA]);
	const linkedTask = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-shared", "--authorized-project", projectA]);
	const conflictDraft = runCli(TASK_CLI, [
		"task-save-draft",
		...taskBase,
		"--write",
		"--project-id",
		projectA,
		"--task-id",
		"task-shared",
		"--authorized-project",
		projectA,
		"--experience-id",
		"exp-from-task-2",
		"--problem",
		"第二条沉淀",
		"--root-cause",
		"r",
		"--solution",
		"s",
		"--link-task-revision",
		String(beforeDraft.json?.revision ?? 0),
	]);
	const orphan = runCli(BUSINESS_CLI, ["experience-show", ...businessArgs, "--experience-id", "exp-from-task-2", "--authorized-project", projectA]);
	record(
		"任务→经验草稿：只得到 draft、不自动审核；第二步 CAS 冲突保留半完成事实",
		{
			savedStatus: draftSaved.json?.status ?? null,
			cardStatus: draftSaved.json?.card?.status_after ?? null,
			readBackStatus: readBack.json?.card?.status ?? null,
			taskHasLink: (linkedTask.json?.task?.sourceExperienceIds ?? []).includes("exp-from-task"),
			conflictStatus: conflictDraft.json?.status ?? null,
			orphanStatus: orphan.json?.card?.status ?? null,
			taskHasOrphan: (linkedTask.json?.task?.sourceExperienceIds ?? []).includes("exp-from-task-2"),
		},
		draftSaved.json?.status === "draft-saved" &&
			draftSaved.json?.card?.status_after === "draft" &&
			readBack.json?.card?.status === "draft" &&
			(linkedTask.json?.task?.sourceExperienceIds ?? []).includes("exp-from-task") &&
			conflictDraft.json?.status === "link-conflict" &&
			orphan.json?.card?.status === "draft" &&
			!(linkedTask.json?.task?.sourceExperienceIds ?? []).includes("exp-from-task-2"),
	);

	// ---- 7) 预算不足 / journal 终态故障 / 同 revision 一成一败 ----
	const tiny = runCli(TASK_CLI, ["context-build", ...taskBase, "--target-project", projectA, "--task-id", "task-shared", "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--endpoint", "allowed", "--budget-chars", "120"]);
	const faulted = runCli(TASK_CLI, ["task-create", ...taskBase, "--write", "--project-id", projectA, "--task-id", "task-fault", "--workspace-id", workspaceA, "--cwd", wsA, "--authorized-root", wsA, "--authorized-project", projectA, "--requirement", "journal 故障下的任务"], { preload: FAULT_PRELOAD });
	const showFault = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-fault", "--authorized-project", projectA]);
	const raceBase = { revision: String(showFault.json?.revision ?? 0) };
	const raceFirst = runCli(TASK_CLI, ["task-update", ...taskBase, "--write", "--project-id", projectA, "--task-id", "task-fault", "--revision", raceBase.revision, "--authorized-project", projectA, "--todo", "第一位写者"]);
	const raceSecond = runCli(TASK_CLI, ["task-update", ...taskBase, "--write", "--project-id", projectA, "--task-id", "task-fault", "--revision", raceBase.revision, "--authorized-project", projectA, "--todo", "第二位写者"]);
	const raceFinal = runCli(TASK_CLI, ["task-show", ...taskBase, "--project-id", projectA, "--task-id", "task-fault", "--authorized-project", projectA]);
	record(
		"预算不足/journa 故障/同 revision 一成一败都有受控结果",
		{
			tinyStatus: tiny.json?.status ?? null,
			tinyExit: tiny.code,
			tinyTruncated: tiny.json?.budget?.truncated ?? null,
			faultExit: faulted.code,
			faultStatus: faulted.json?.status ?? null,
			faultNeedsReview: (faulted.json?.needsReview ?? []).length,
			faultTaskReadable: showFault.json?.status ?? null,
			raceFirst: raceFirst.json?.status ?? null,
			raceSecond: raceSecond.json?.status ?? null,
			raceSecondCode: raceSecond.code,
			raceFinalTodos: raceFinal.json?.task?.todos ?? [],
		},
		tiny.json?.status === "incomplete" &&
			tiny.code === 7 &&
			tiny.json?.budget?.truncated === true &&
			faulted.code === 8 &&
			faulted.json?.status === "created" &&
			(faulted.json?.needsReview ?? []).length > 0 &&
			showFault.json?.status === "ok" &&
			raceFirst.json?.status === "updated" &&
			raceSecond.json?.status === "revision-conflict" &&
			raceSecond.code === 4 &&
			(raceFinal.json?.task?.todos ?? []).length === 1,
	);

	const summary = {
		scenario: "bm05-task-context",
		status: failures.length === 0 ? "ok" : "failed",
		steps,
		failures,
		notes: [
			"全部数据是合成任务/经验与临时目录；不读真实客户库、不执行构建/刷板。",
			"每一步都是真实 CLI 子进程（project/business/task 三个 CLI）；新进程重验与 CAS 竞争都是真的。",
			"journal 终态故障用测试预加载 loader hook 注入（子进程无法传 ioHooks），生产代码不含测试钩子。",
			"任务 done 不等于硬件已验证/经验已审核；经验沉淀只得到 draft，审核仍走 review 命令。",
		],
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (failures.length > 0) process.exitCode = 1;
} catch (error) {
	process.stdout.write(`${JSON.stringify({ scenario: "bm05-task-context", status: "failed", error: error instanceof Error ? error.message : String(error), steps, failures }, null, 2)}\n`);
	process.exitCode = 1;
} finally {
	await rm(base, { recursive: true, force: true });
}
