#!/usr/bin/env node
/**
 * BM-05 人工入口：**簿**任务/交接 CLI（`node cli/task.mjs <命令>`）。
 *
 * 与 `cli/business.mjs` 同一套骨架（参数白名单、退出码、单对象 JSON、SIGINT 取消）。
 * 领域规则都在 `core/tasks` 与 `core/context` 里；这里只做参数解析、调用与受控输出。
 *
 * 纪律：
 * - **显式绑定与授权**：`--project-id`/`--task-id`/`--workspace-id`/`--authorized-project` 必填；
 *   读取任务缺省拒绝（不给授权就不读内容）；
 * - **写确认**：所有写命令都要 `--write`；
 * - **状态是具名动作**：`task-status` 只接受有限转换表里的目标状态（含 done→in_progress 重开）；
 * - **不做模型写工具、不自动审核、不注入 Pi Session**：这是给工程师/验收用的本地人工入口。
 */
import process from "node:process";
import { EXIT, outcome, parseArgv, refuseWrite, reportError, resolveCommand, setExit, short, takeBool, takeInt, takeList, takeString, UsageError, writeJson } from "./cliArgs.mjs";
import { changeTaskStatus, createTask, prepareExperienceDraftFromTask, readTaskDetail, saveExperienceDraftFromTask, updateTask } from "../core/tasks/index.ts";
import { buildHandoff, saveContextManifest, verifyContextManifest } from "../core/context/index.ts";

const USAGE = `用法：node cli/task.mjs <命令> [选项]（命令与选项顺序无关）

命令：
  task-create          创建任务事实（需要 --write；首建恒为 planned）
  task-show            读取任务 + 经验引用核对（需要 --authorized-project）
  task-update          点名更新正文/待办/阻塞/引用/验证（需要 --write，CAS）
  task-status          具名状态变更（含 done→in_progress 显式重开；需要 --write，CAS）
  task-prepare-draft   准备经验草稿（展示可预填事实与待人工填写字段）
  task-save-draft      保存经验草稿（恒为 draft；可再用一步 CAS 关联回任务）
  context-build        组装有界人工交接包（只读，不写库）
  context-save         组装并保存 ContextManifest 来源清单（需要 --write）
  context-verify       新进程重验 ContextManifest 是否仍可用
  help                 显示本帮助

通用选项：
  --root <绝对路径>            知识根（必填）
  --json                       stdout 输出单个 JSON 对象
  --write                      确认执行写入（缺失时拒绝并 exit 3）
  --authorized-project <uuid>  被授权读取的项目（可重复；缺省即拒绝）

任务绑定：
  --project-id <uuid> --task-id <id> --workspace-id <uuid>
  --cwd <绝对路径>             会话工作目录（判定工作区授权；task-create/context-build 必填）
  --authorized-root <绝对路径> 适配层注入的额外授权根（可重复）

内容（task-create/task-update）：
  --requirement <正文> [--todo <文本>（可重复）] [--blocker <文本>（可重复）]
  [--decision <文本>（可重复）] [--related-file <相对路径>（可重复）]
  [--source-experience <经验ID>（可重复）] [--validation <kind>:<scope>:<result>:<performedAt>:<performedBy>（可重复）]

task-status：--revision <非负整数> --to planned|in_progress|blocked|done|archived --reason <理由>

task-save-draft：
  --experience-id <id> --problem <正文> --root-cause <正文> --solution <正文>
  [--symptom <正文>] [--applies-when <文本>（可重复）] [--does-not-apply-when <文本>（可重复）]
  [--evidence-file <相对路径>:<SHA-256>[:<workspaceId>]（可重复）] [--evidence-commit <提交号>（可重复）]
  [--link-task-revision <非负整数>]   给出时用第二步 CAS 把新经验关联回任务

交接上下文（context-build/context-save）：
  --target-project <uuid> [--task-id <id>] [--workspace-id <uuid>]
  --authorized-project <uuid>（可重复） --endpoint allowed|denied|unknown [--allow-internal-general]
  [--budget-chars <正整数>] [--budget-bytes <正整数>]
context-save：--manifest-id <id> [--profile-revision <非负整数>]
context-verify：--manifest-id <id> --project-id <uuid>

退出码：0 成功｜2 用法错误｜3 被拒绝（缺 --write / 未授权）｜4 revision 冲突｜5 不一致或不可用｜
6 未找到｜7 取消、IO 失败或结果不完整/stale｜8 已写入但需要人工核对（journal/审计待收口）`;

/** 选项白名单。 */
const OPTION_SPEC = {
	help: { value: false, repeatable: false },
	json: { value: false, repeatable: false },
	write: { value: false, repeatable: false },
	root: { value: true, repeatable: false },
	"project-id": { value: true, repeatable: false },
	"task-id": { value: true, repeatable: false },
	"workspace-id": { value: true, repeatable: false },
	cwd: { value: true, repeatable: false },
	"authorized-root": { value: true, repeatable: true },
	"authorized-project": { value: true, repeatable: true },
	requirement: { value: true, repeatable: false },
	todo: { value: true, repeatable: true },
	blocker: { value: true, repeatable: true },
	decision: { value: true, repeatable: true },
	"related-file": { value: true, repeatable: true },
	"source-experience": { value: true, repeatable: true },
	validation: { value: true, repeatable: true },
	revision: { value: true, repeatable: false },
	to: { value: true, repeatable: false },
	reason: { value: true, repeatable: false },
	"experience-id": { value: true, repeatable: false },
	problem: { value: true, repeatable: false },
	symptom: { value: true, repeatable: false },
	"root-cause": { value: true, repeatable: false },
	solution: { value: true, repeatable: false },
	"applies-when": { value: true, repeatable: true },
	"does-not-apply-when": { value: true, repeatable: true },
	"evidence-file": { value: true, repeatable: true },
	"evidence-commit": { value: true, repeatable: true },
	"link-task-revision": { value: true, repeatable: false },
	"target-project": { value: true, repeatable: false },
	endpoint: { value: true, repeatable: false },
	"allow-internal-general": { value: false, repeatable: false },
	"budget-chars": { value: true, repeatable: false },
	"budget-bytes": { value: true, repeatable: false },
	"manifest-id": { value: true, repeatable: false },
	"profile-revision": { value: true, repeatable: false },
	"replace-revision": { value: true, repeatable: false },
	"allowed-feature-id": { value: true, repeatable: true },
	query: { value: true, repeatable: false },
};

const COMMON = ["help", "json", "root"];
const COMMAND_OPTIONS = {
	help: ["help", "json"],
	"task-create": [...COMMON, "write", "project-id", "task-id", "workspace-id", "cwd", "authorized-root", "authorized-project", "requirement", "todo", "blocker", "decision", "related-file", "source-experience", "validation"],
	"task-show": [...COMMON, "project-id", "task-id", "cwd", "authorized-root", "authorized-project"],
	"task-update": [...COMMON, "write", "project-id", "task-id", "revision", "authorized-project", "requirement", "todo", "blocker", "decision", "related-file", "source-experience", "validation"],
	"task-status": [...COMMON, "write", "project-id", "task-id", "revision", "to", "reason", "authorized-project"],
	"task-prepare-draft": [...COMMON, "project-id", "task-id", "authorized-project"],
	"task-save-draft": [...COMMON, "write", "project-id", "task-id", "authorized-project", "experience-id", "problem", "symptom", "root-cause", "solution", "applies-when", "does-not-apply-when", "evidence-file", "evidence-commit", "link-task-revision"],
	"context-build": [...COMMON, "target-project", "task-id", "workspace-id", "cwd", "authorized-root", "authorized-project", "allowed-feature-id", "query", "endpoint", "allow-internal-general", "budget-chars", "budget-bytes"],
	"context-save": [...COMMON, "write", "target-project", "task-id", "workspace-id", "cwd", "authorized-root", "authorized-project", "allowed-feature-id", "query", "endpoint", "allow-internal-general", "budget-chars", "budget-bytes", "manifest-id", "profile-revision", "replace-revision"],
	"context-verify": [...COMMON, "manifest-id", "project-id", "authorized-project", "allowed-feature-id", "cwd", "authorized-root", "endpoint", "allow-internal-general"],
};

const TASK_STATUSES = ["planned", "in_progress", "blocked", "done", "archived"];

/** @typedef {{ flags: Map<string, string | true>, repeated: Map<string, Array<string | true>>, positionals: string[] }} ParsedArgs */

/** @param {ParsedArgs} args @returns {boolean | null} */
function endpointPolicy(args) {
	const raw = takeString(args, "endpoint") ?? "unknown";
	if (raw === "allowed") return true;
	if (raw === "denied") return false;
	if (raw === "unknown") return null;
	throw new UsageError("--endpoint 只能是 allowed / denied / unknown");
}

/** @param {ParsedArgs} args */
function endpointOf(args) {
	return { endpointAllowed: endpointPolicy(args), allowInternalGeneral: takeBool(args, "allow-internal-general"), customers: [] };
}

/**
 * 公开入口的授权闸门（R30-1）：`--authorized-project` 必须**显式**给出，缺省即拒绝（用法错误）。
 * 这样"未授权"不会以 `revision-conflict`（带实际 revision）或 `illegal-transition`（带状态）的形式泄漏。
 * @param {ParsedArgs} args @returns {string[]}
 */
function requireAuthorizedProjects(args) {
	const ids = takeList(args, "authorized-project");
	if (ids.length === 0) throw new UsageError("必须显式给出 --authorized-project（项目授权）；缺省即拒绝");
	return ids;
}

/** @param {ParsedArgs} args @returns {string[]} */
function accessRoots(args) {
	return takeList(args, "authorized-root");
}

/** `--validation kind:scope:result:performedAt:performedBy`。 @param {ParsedArgs} args */
function validationsOf(args) {
	return takeList(args, "validation").map((entry) => {
		const parts = entry.split(":");
		if (parts.length < 5) throw new UsageError(`--validation 需要 <kind>:<scope>:<result>:<performedAt>:<performedBy>，实际：${short(entry)}`);
		const kind = /** @type {"code-review" | "compile" | "board-boot" | "stress-loop" | "customer-acceptance"} */ (parts[0] ?? "");
		const scope = parts[1] ?? "";
		const result = /** @type {"passed" | "failed" | "inconclusive"} */ (parts[2] ?? "");
		const performedAt = Number(parts[3]);
		const performedBy = parts.slice(4).join(":");
		if (!Number.isSafeInteger(performedAt) || performedAt < 0) throw new UsageError("--validation 的时间必须是安全非负整数（epoch 毫秒）");
		return { kind, scope, result, performedAt, performedBy };
	});
}

/** @param {ParsedArgs} args @returns {Array<import("../core/knowledge/index.ts").ExperienceEvidenceInput>} */
function evidenceOf(args) {
	/** @type {Array<import("../core/knowledge/index.ts").ExperienceEvidenceInput>} */
	const entries = [];
	for (const raw of takeList(args, "evidence-file")) {
		const parts = raw.split(":");
		const relativePath = parts[0] ?? "";
		const contentHash = parts[1] ?? "";
		const workspaceId = parts.length > 2 ? parts.slice(2).join(":") : "";
		if (relativePath === "" || contentHash === "") throw new UsageError(`--evidence-file 需要 <相对路径>:<SHA-256>[:<workspaceId>]，实际：${short(raw)}`);
		entries.push({ type: "source-file", relativePath, contentHash, ...(workspaceId === "" ? {} : { workspaceId }) });
	}
	for (const commit of takeList(args, "evidence-commit")) entries.push({ type: "commit", commit });
	return entries;
}

/** @param {string} status @param {readonly string[]} okStatuses @param {readonly string[]} needsReview @returns {number} */
function writeExitCode(status, okStatuses, needsReview) {
	if (okStatuses.includes(status)) return needsReview.length > 0 ? EXIT.needsReview : EXIT.ok;
	return status === "revision-conflict" ? EXIT.conflict : EXIT.needsReview;
}

/** @param {string} status @param {number} exitCode @returns {string} */
function writeOutcomeCode(status, exitCode) {
	return exitCode === EXIT.ok ? "ok" : exitCode === EXIT.conflict ? status : "needs-review";
}

/** @param {ParsedArgs} args */
function binding(args) {
	return { projectId: takeString(args, "project-id", { required: true }), taskId: takeString(args, "task-id", { required: true }) };
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskCreate(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const workspaceId = takeString(args, "workspace-id", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("task-create", asJson, [`在项目 ${projectId} 创建工作区 ${workspaceId} 的任务 ${taskId}（首建恒为 planned）`]);
	const result = await createTask({
		root: takeString(args, "root", { required: true }),
		projectId,
		taskId,
		workspaceId,
		cwd: takeString(args, "cwd", { required: true }),
		authorizedRoots: accessRoots(args),
		requirement: takeString(args, "requirement", { required: true }),
		decisions: takeList(args, "decision"),
		todos: takeList(args, "todo"),
		blockers: takeList(args, "blocker"),
		relatedFiles: takeList(args, "related-file"),
		sourceExperienceIds: takeList(args, "source-experience"),
		validations: validationsOf(args),
		authorizedProjectIds: requireAuthorizedProjects(args),
		signal,
	});
	const exitCode = writeExitCode(result.status, ["created"], result.needsReview);
	if (asJson) writeJson({ ...result, ...outcome(writeOutcomeCode(result.status, exitCode), exitCode) });
	else process.stdout.write(`任务：${result.status}（revision=${result.revision ?? "-"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskShow(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const result = await readTaskDetail({ root: takeString(args, "root", { required: true }), projectId, taskId, cwd: takeString(args, "cwd"), authorizedRoots: accessRoots(args), authorizedProjectIds: requireAuthorizedProjects(args), signal });
	const exitCode = result.status === "ok" ? EXIT.ok : result.status === "not-authorized" ? EXIT.refused : EXIT.notFound;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : result.status, exitCode) });
	else if (result.task !== null) {
		process.stdout.write(`任务：${taskId}（revision=${result.revision}，状态 ${result.task.status}）\n`);
		process.stdout.write(`  需求：${result.task.requirement}\n  待办：${result.task.todos.join("；") || "（无）"}\n  阻塞：${result.task.blockers.join("；") || "（无）"}\n`);
		for (const reference of result.references) process.stdout.write(`  引用 ${reference.experienceId}：${reference.usableAsBasis ? "可作依据" : `不可作依据（${reference.reason}）`}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskUpdate(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	if (!takeBool(args, "write")) return refuseWrite("task-update", asJson, [`更新任务 ${taskId}（期望 revision=${revision}）`]);
	/** @type {Record<string, unknown>} */
	const changes = {};
	const requirement = takeString(args, "requirement");
	if (requirement !== undefined) changes.requirement = requirement;
	if (args.repeated.has("todo")) changes.todos = takeList(args, "todo");
	if (args.repeated.has("blocker")) changes.blockers = takeList(args, "blocker");
	if (args.repeated.has("decision")) changes.decisions = takeList(args, "decision");
	if (args.repeated.has("related-file")) changes.relatedFiles = takeList(args, "related-file");
	if (args.repeated.has("source-experience")) changes.sourceExperienceIds = takeList(args, "source-experience");
	const validations = validationsOf(args);
	if (validations.length > 0) changes.validations = validations;
	const taskChanges = /** @type {import("../core/tasks/index.ts").TaskChanges} */ (changes);
	const result = await updateTask({ root: takeString(args, "root", { required: true }), projectId, taskId, expectedRevision: revision, changes: taskChanges, authorizedProjectIds: requireAuthorizedProjects(args), signal });
	const exitCode = writeExitCode(result.status, ["updated", "unchanged"], result.needsReview);
	if (asJson) writeJson({ ...result, ...outcome(writeOutcomeCode(result.status, exitCode), exitCode) });
	else process.stdout.write(`任务：${result.status}（revision=${result.revision ?? "-"}；变更 ${result.changedFields.join("、") || "无"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskStatus(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	const to = takeString(args, "to", { required: true });
	if (!TASK_STATUSES.includes(to)) throw new UsageError(`--to 只能是 ${TASK_STATUSES.join(" / ")}`);
	if (!takeBool(args, "write")) return refuseWrite("task-status", asJson, [`把任务 ${taskId}（期望 revision=${revision}）变更到 ${to}`]);
	const result = await changeTaskStatus({
		root: takeString(args, "root", { required: true }),
		projectId,
		taskId,
		expectedRevision: revision,
		to: /** @type {import("../core/contracts/common.ts").TaskStatus} */ (to),
		reason: takeString(args, "reason", { required: true }),
		authorizedProjectIds: requireAuthorizedProjects(args),
		signal,
	});
	const exitCode = result.status === "changed" || result.status === "unchanged" ? (result.needsReview.length > 0 ? EXIT.needsReview : EXIT.ok) : result.status === "revision-conflict" ? EXIT.conflict : result.status === "illegal-transition" ? EXIT.inconsistent : EXIT.notFound;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else process.stdout.write(`任务状态：${result.status}（${result.from ?? "?"} → ${result.to}，revision=${result.revision ?? "-"}）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskPrepareDraft(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const result = await prepareExperienceDraftFromTask({ root: takeString(args, "root", { required: true }), projectId, taskId, authorizedProjectIds: requireAuthorizedProjects(args), signal });
	const exitCode = result.status === "ok" ? EXIT.ok : result.status === "not-authorized" ? EXIT.refused : EXIT.notFound;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : result.status, exitCode) });
	else if (result.prefill !== null) {
		process.stdout.write(`草稿预填（任务 ${taskId}，revision=${result.prefill.taskRevision ?? "-"}）\n`);
		process.stdout.write(`  来源项目：${result.prefill.suggested.sourceProjectId}\n  需求：${result.prefill.suggested.requirement}\n`);
		process.stdout.write(`  待人工填写：${result.prefill.requiredHumanFields.join("、")}\n`);
		for (const problem of result.prefill.problems) process.stdout.write(`  提示：${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandTaskSaveDraft(args, asJson, signal) {
	const { projectId, taskId } = binding(args);
	const experienceId = takeString(args, "experience-id", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("task-save-draft", asJson, [`为任务 ${taskId} 保存经验草稿 ${experienceId}（状态恒为 draft，需人工审核后才可用）`]);
	const symptom = takeString(args, "symptom");
	const evidence = evidenceOf(args);
	const linkRevision = takeInt(args, "link-task-revision");
	const result = await saveExperienceDraftFromTask({
		root: takeString(args, "root", { required: true }),
		projectId,
		taskId,
		authorizedProjectIds: requireAuthorizedProjects(args),
		...(linkRevision === undefined ? {} : { expectedTaskRevision: linkRevision }),
		experience: {
			experienceId,
			problem: takeString(args, "problem", { required: true }),
			...(symptom === undefined ? {} : { symptom }),
			rootCause: takeString(args, "root-cause", { required: true }),
			solution: takeString(args, "solution", { required: true }),
			appliesWhen: takeList(args, "applies-when"),
			doesNotApplyWhen: takeList(args, "does-not-apply-when"),
			...(evidence.length === 0 ? {} : { evidence }),
		},
		signal,
	});
	const exitCode = result.status === "draft-saved" ? (result.needsReview.length > 0 ? EXIT.needsReview : EXIT.ok) : result.status === "card-conflict" ? EXIT.conflict : result.status === "task-not-authorized" ? EXIT.refused : EXIT.needsReview;
	if (asJson) writeJson({ ...result, ...outcome(exitCode === EXIT.ok ? "ok" : result.status, exitCode) });
	else {
		process.stdout.write(`经验草稿：${result.status}（${experienceId}）\n`);
		for (const step of result.steps) process.stdout.write(`  步骤 ${step.step}：${step.status}\n`);
		for (const problem of result.problems) process.stdout.write(`  提示：${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {AbortSignal} signal @returns {Promise<import("../core/context/index.ts").HandoffResult>} */
async function runHandoff(args, signal) {
	return buildHandoff({
		root: takeString(args, "root", { required: true }),
		targetProjectId: takeString(args, "target-project", { required: true }),
		...(takeString(args, "task-id") === undefined ? {} : { taskId: takeString(args, "task-id") }),
		...(takeString(args, "workspace-id") === undefined ? {} : { workspaceId: takeString(args, "workspace-id") }),
		cwd: takeString(args, "cwd", { required: true }),
		authorizedRoots: accessRoots(args),
		authorizedProjectIds: requireAuthorizedProjects(args),
		endpoint: endpointOf(args),
		allowedFeatureIds: takeList(args, "allowed-feature-id"),
		...(takeString(args, "query") === undefined ? {} : { query: takeString(args, "query") }),
		...(takeInt(args, "budget-chars") === undefined && takeInt(args, "budget-bytes") === undefined
			? {}
			: { budget: { ...(takeInt(args, "budget-chars") === undefined ? {} : { maxChars: /** @type {number} */ (takeInt(args, "budget-chars")) }), ...(takeInt(args, "budget-bytes") === undefined ? {} : { maxBytes: /** @type {number} */ (takeInt(args, "budget-bytes")) }) } }),
		signal,
	});
}

/** @param {import("../core/context/index.ts").HandoffResult} handoff @returns {number} */
function handoffExit(handoff) {
	return handoff.status === "ok" ? EXIT.ok : handoff.status === "not-authorized" ? EXIT.refused : handoff.status === "not-found" ? EXIT.notFound : EXIT.failed;
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandContextBuild(args, asJson, signal) {
	const handoff = await runHandoff(args, signal);
	const exitCode = handoffExit(handoff);
	if (asJson) writeJson({ ...handoff, ...outcome(handoff.status === "ok" ? "ok" : handoff.status, exitCode) });
	else process.stdout.write(`${handoff.text}\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandContextSave(args, asJson, signal) {
	const manifestId = takeString(args, "manifest-id", { required: true });
	if (!takeBool(args, "write")) return refuseWrite("context-save", asJson, [`组装并保存上下文清单 ${manifestId}`]);
	const handoff = await runHandoff(args, signal);
	if (handoff.status !== "ok" && handoff.status !== "incomplete") {
		const exitCode = handoffExit(handoff);
		if (asJson) writeJson({ ...handoff, ...outcome(handoff.status, exitCode) });
		else process.stderr.write(`交接组装未成功（${handoff.status}）：不保存清单\n`);
		setExit(exitCode);
		return;
	}
	const saved = await saveContextManifest({
		root: takeString(args, "root", { required: true }),
		manifestId,
		targetProjectId: handoff.targetProjectId,
		...(handoff.taskId === null ? {} : { taskId: handoff.taskId }),
		...(handoff.workspaceId === null ? {} : { workspaceId: handoff.workspaceId }),
		cwd: takeString(args, "cwd", { required: true }),
		authorizedRoots: accessRoots(args),
		profileRevision: takeInt(args, "profile-revision") ?? handoff.profileRevision ?? 0,
		sources: handoff.sources,
		expiredSources: handoff.expiredSources,
		budget: { maxChars: handoff.budget.maxChars, maxBytes: handoff.budget.maxBytes, usedChars: handoff.budget.usedChars, truncated: handoff.budget.truncated },
		generatedAt: handoff.generatedAt,
		authorizedProjectIds: requireAuthorizedProjects(args),
		expectedRevision: takeInt(args, "replace-revision") ?? null,
		allowedFeatureIds: takeList(args, "allowed-feature-id"),
		endpoint: endpointOf(args),
		signal,
	});
	const exitCode =
		saved.status === "saved" || saved.status === "replaced"
			? saved.needsReview.length > 0
				? EXIT.needsReview
				: handoff.status === "incomplete"
					? EXIT.failed
					: EXIT.ok
			: saved.status === "revision-conflict"
				? EXIT.conflict
				: saved.status === "invalid-sources"
					? EXIT.inconsistent
					: saved.status === "not-authorized"
						? EXIT.refused
						: EXIT.notFound;
	const payload = { ...saved, handoffStatus: handoff.status, sources: handoff.sources, problems: [...saved.problems, ...handoff.problems], ...outcome(exitCode === EXIT.ok ? "ok" : exitCode === EXIT.failed ? "incomplete" : saved.status, exitCode) };
	if (asJson) writeJson(payload);
	else process.stdout.write(`上下文清单：${saved.status}（revision=${saved.revision ?? "-"}，来源 ${handoff.sources.length} 条）\n`);
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandContextVerify(args, asJson, signal) {
	const result = await verifyContextManifest({
		root: takeString(args, "root", { required: true }),
		manifestId: takeString(args, "manifest-id", { required: true }),
		projectId: takeString(args, "project-id", { required: true }),
		authorizedProjectIds: requireAuthorizedProjects(args),
		endpoint: endpointOf(args),
		allowedFeatureIds: takeList(args, "allowed-feature-id"),
		...(takeString(args, "cwd") === undefined ? {} : { cwd: takeString(args, "cwd") }),
		authorizedRoots: accessRoots(args),
		signal,
	});
	const exitCode = result.status === "ok" ? EXIT.ok : result.status === "not-authorized" ? EXIT.refused : result.status === "not-found" ? EXIT.notFound : EXIT.failed;
	if (asJson) writeJson({ ...result, ...outcome(result.status === "ok" ? "ok" : result.status, exitCode) });
	else {
		process.stdout.write(`上下文清单重验：${result.status}（档案 ${result.profileState}）\n`);
		for (const source of result.sources) process.stdout.write(`  来源 ${source.recordKind}/${source.recordId}：${source.state}（${source.reason}）\n`);
		for (const problem of result.problems) process.stdout.write(`  提示：${problem}\n`);
	}
	setExit(exitCode);
}

const COMMANDS = {
	"task-create": commandTaskCreate,
	"task-show": commandTaskShow,
	"task-update": commandTaskUpdate,
	"task-status": commandTaskStatus,
	"task-prepare-draft": commandTaskPrepareDraft,
	"task-save-draft": commandTaskSaveDraft,
	"context-build": commandContextBuild,
	"context-save": commandContextSave,
	"context-verify": commandContextVerify,
};

async function main() {
	const { command, rest } = resolveCommand(process.argv.slice(2), OPTION_SPEC);
	const allowed = command === undefined ? ["help", "json"] : (COMMAND_OPTIONS[/** @type {keyof typeof COMMAND_OPTIONS} */ (command)] ?? null);
	let args;
	try {
		args = parseArgv(rest, allowed ?? Object.keys(OPTION_SPEC), OPTION_SPEC);
	} catch (error) {
		reportError(error, rest.includes("--json"), { command: command === undefined ? null : short(command) });
		return;
	}
	const asJson = takeBool(args, "json");

	if (command === undefined || command === "help" || takeBool(args, "help")) {
		if (asJson) writeJson({ ...outcome("ok", EXIT.ok), status: "ok", command: "help", usage: USAGE });
		else process.stdout.write(USAGE);
		return;
	}
	const handler = /** @type {Record<string, ((args: ParsedArgs, asJson: boolean, signal: AbortSignal) => Promise<void>) | undefined>} */ (COMMANDS)[command];
	if (handler === undefined) {
		reportError(new UsageError(`未知命令：${short(command)}（可用：${Object.keys(COMMANDS).join("、")}、help）`), asJson, { command: short(command) });
		return;
	}

	const controller = new AbortController();
	let interrupted = false;
	const onSignal = () => {
		interrupted = true;
		controller.abort();
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);
	try {
		await handler(args, asJson, controller.signal);
	} catch (error) {
		reportError(error, asJson, interrupted ? { cancelled: true, detail: "信号中断，已把取消传给领域层" } : {});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

await main();
