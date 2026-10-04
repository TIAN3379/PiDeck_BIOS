#!/usr/bin/env node
/**
 * BM-03 人工入口：**薄** CLI（`node cli/project.mjs <command>`）。
 *
 * 这个文件只做三件事：解析参数 → 调用 `core/projects` 的领域 API → 打印受控结果。
 * 领域规则（授权、CAS、检测规则、预算）都在 core 里；这里**不**复制任何一条。
 *
 * 纪律（R28-4 收紧后的版本）：
 * - **显式路径**：`--root` 必填，绝不回退到真实知识根；工作区必须显式给出；
 * - **每命令参数白名单**：未知/拼错/重复的单值参数在**任何 IO 之前**拒绝（退出 2）；
 * - **授权透传**：每个命令都把 `--cwd` 与 `--authorized-root` 传给领域入口，
 *   领域层再对"档案里保存的工作区路径"重新判定一次授权；
 * - **离线**：只碰本地文件系统与本地 git，没有任何网络调用；
 * - **写入确认**：`bind`/`confirm`/`refresh` 必须带 `--write`，否则 exit 3 并给出"本来会做什么"；
 * - **JSON/退出码**：`--json` 时 stdout 恰好一个可解析对象，且**每个**结果都带 `code` 与 `exitCode`；
 * - **取消**：Ctrl+C 转成 AbortSignal 传给文件与 Git 子进程；如果已经写入，如实报告发布事实。
 */
import process from "node:process";
import { bindProjectWorkspace, confirmProfileFields, describeBindResult, detectProjectCandidates, openProjectProfile, readProjectView, refreshWorkspaceSnapshot } from "../core/projects/index.ts";
import { readAuthorizedRootsFromEnv } from "../core/projects/authorization.ts";
// 参数解析、退出码与受控输出与 `cli/business.mjs` 共用同一份实现（见 cliArgs.mjs）。
import { EXIT, outcome, parseArgv, parseSafeInt, refuseWrite, reportError, resolveCommand, setExit, short, takeBool, takeInt, takeList, takeString, UsageError, writeJson } from "./cliArgs.mjs";

const USAGE = `用法：node cli/project.mjs <命令> [选项]（命令与选项顺序无关）

命令：
  open       只读打开项目档案（registry ↔ profile ↔ 工作区一致性 + 工作区授权）
  bind       绑定工作区到知识项目（需要 --write）
  detect     对工作区做有限检测，输出候选与资料缺口（只读）
  confirm    人工确认档案字段（需要 --write，CAS）
  refresh    刷新**一个**工作区快照（需要 --write，CAS）
  read       生成受预算限制的读取视图（调用 M1 决策）
  help       显示本帮助

通用选项：
  --root <绝对路径>           知识根（必填；不会回退到任何默认知识根）
  --cwd <绝对路径>            会话工作目录（默认：进程 cwd），是默认授权根
  --authorized-root <绝对路径> 额外授权根（可重复；等价于环境变量 BIOS_AUTHORIZED_ROOTS）
  --workspace <绝对路径>      目标工作区（bind/detect/read 必填）
  --json                      stdout 输出单个 JSON 对象
  --write                     确认执行写入（缺失时拒绝并 exit 3）

bind：
  --project-id <uuid>         复用已有知识项目（省略则新建稳定 UUID）
  --workspace-id <uuid>       显式指定工作区身份（等于"路径迁移"）
  --desktop-project-id <id>   桌面端项目 ID（可选）
  --display-name <文本>       显示名（只是标签）

confirm：
  --project-id <uuid>         目标项目（必填）
  --workspace-id <uuid>       证据归属的工作区（提供 --evidence 时必填）
  --revision <非负整数>       期望的 profile revision（必填，CAS 前置条件）
  --set <字段>=<值>           要确认的字段（可重复；值写 null 表示显式回到"未知"）
  --evidence <字段>=<相对路径>@<sha256>  该字段的确认依据（可重复）
  --operator <标签>           执行者标签（只是声明，不是身份认证）

refresh：
  --project-id <uuid> --workspace-id <uuid> --revision <非负整数>

read：
  --project-id / --workspace  定位项目与工作区
  --detect                    同时执行检测（默认不扫源码）
  --verify-evidence           复验档案里的文件证据（会读取工作区文件）
  --probe-vcs                 现场采集 Git 快照（会启动本地 git 子进程）
  --max-output-bytes <整数>   **M1 条目数组**的 UTF-8 字节预算（不是整个视图 JSON 的预算；
                              视图外壳 problems/gaps/evidenceChecks 另有独立上限）

每个命令只接受上面列出的选项：未知或拼错的选项在读取任何文件之前报用法错误（exit 2）。
退出码：0 成功｜2 用法错误｜3 被拒绝（缺 --write / 未授权）｜4 revision 冲突｜5 不一致或不可用｜
6 未找到（知识库/绑定/记录缺失）｜7 取消、IO 失败或结果不完整｜8 已写入/部分完成但需要人工核对`;

/* ------------------------------------------------------------------ 参数解析 */

/**
 * 选项表：`value: true` 表示必须带值，`repeatable: true` 表示可重复出现。
 *
 * 这张表同时是**白名单**：不在表里、或者不属于当前命令的选项一律拒绝。
 * 拼错的 `--verify-evidnce` 不能被"静默忽略后照常读库"（R28-4）。
 */
const OPTION_SPEC = {
	help: { value: false, repeatable: false },
	json: { value: false, repeatable: false },
	write: { value: false, repeatable: false },
	root: { value: true, repeatable: false },
	cwd: { value: true, repeatable: false },
	"authorized-root": { value: true, repeatable: true },
	workspace: { value: true, repeatable: false },
	"project-id": { value: true, repeatable: false },
	"workspace-id": { value: true, repeatable: false },
	"desktop-project-id": { value: true, repeatable: false },
	"display-name": { value: true, repeatable: false },
	revision: { value: true, repeatable: false },
	set: { value: true, repeatable: true },
	evidence: { value: true, repeatable: true },
	operator: { value: true, repeatable: false },
	detect: { value: false, repeatable: false },
	"verify-evidence": { value: false, repeatable: false },
	"probe-vcs": { value: false, repeatable: false },
	"max-output-bytes": { value: true, repeatable: false },
};

const COMMON_READ_OPTIONS = ["help", "json", "root", "cwd", "authorized-root", "workspace", "project-id", "desktop-project-id"];

const COMMAND_OPTIONS = {
	help: ["help", "json"],
	open: COMMON_READ_OPTIONS,
	bind: [...COMMON_READ_OPTIONS, "write", "workspace-id", "display-name"],
	detect: ["help", "json", "root", "cwd", "authorized-root", "workspace", "project-id"],
	confirm: ["help", "json", "root", "cwd", "authorized-root", "project-id", "workspace-id", "revision", "set", "evidence", "operator", "write"],
	refresh: ["help", "json", "root", "cwd", "authorized-root", "project-id", "workspace-id", "revision", "write"],
	read: [...COMMON_READ_OPTIONS, "detect", "verify-evidence", "probe-vcs", "max-output-bytes"],
};

/**
 * @typedef {{ flags: Map<string, string | true>, repeated: Map<string, Array<string | true>>, positionals: string[] }} ParsedArgs
 * @typedef {{ field: string, value: string | null, evidence?: Array<{ relativePath: string, contentHash: string }> }} ConfirmValue
 * @typedef {{ root: string, cwd: string, authorizedRoots: string[], workspacePath?: string, projectId?: string, workspaceId?: string }} LocationInput
 * @typedef {(args: ParsedArgs, asJson: boolean, signal: AbortSignal) => Promise<void>} CommandHandler
 */

/**
 * `--set field=value`：值显式写 `null` 表示"回到未知"，与"空字符串"区分。
 * @param {ParsedArgs} args @returns {ConfirmValue[]}
 */
function parseSetFlags(args) {
	return takeList(args, "set").map((entry) => {
		const eq = entry.indexOf("=");
		if (eq <= 0) throw new UsageError(`--set 需要 <字段>=<值> 形式，实际：${short(entry)}`);
		return { field: entry.slice(0, eq), value: entry.slice(eq + 1) === "null" ? null : entry.slice(eq + 1) };
	});
}

/**
 * `--evidence field=relpath@sha256`。
 * @param {ParsedArgs} args @param {ConfirmValue[]} values @returns {ConfirmValue[]}
 */
function parseEvidenceFlags(args, values) {
	/** @type {Map<string, Array<{ relativePath: string, contentHash: string }>>} */
	const byField = new Map();
	for (const entry of takeList(args, "evidence")) {
		const eq = entry.indexOf("=");
		const at = entry.lastIndexOf("@");
		if (eq <= 0 || at <= eq) throw new UsageError(`--evidence 需要 <字段>=<相对路径>@<sha256> 形式，实际：${short(entry)}`);
		const field = entry.slice(0, eq);
		const relativePath = entry.slice(eq + 1, at);
		const contentHash = entry.slice(at + 1);
		if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new UsageError("--evidence 的 sha256 必须是 64 位小写十六进制");
		const list = byField.get(field);
		if (list === undefined) byField.set(field, [{ relativePath, contentHash }]);
		else list.push({ relativePath, contentHash });
	}
	const unknown = [...byField.keys()].filter((field) => !values.some((value) => value.field === field));
	if (unknown.length > 0) throw new UsageError(`--evidence 指向了没有 --set 的字段：${unknown.map((field) => short(field)).join("、")}`);
	return values.map((value) => {
		const evidence = byField.get(value.field);
		return evidence === undefined ? { ...value } : { ...value, evidence };
	});
}

/* ------------------------------------------------------------------ 命令 */

/** @param {ParsedArgs} args @returns {string[]} */
function authorizedRoots(args) {
	return [...readAuthorizedRootsFromEnv(process.env), ...takeList(args, "authorized-root")];
}

/** @param {ParsedArgs} args @param {{ requireWorkspace?: boolean }} [options] @returns {LocationInput} */
function locationInput(args, { requireWorkspace = false } = {}) {
	const workspacePath = takeString(args, "workspace", { required: requireWorkspace });
	const projectId = takeString(args, "project-id");
	const workspaceId = takeString(args, "workspace-id");
	return {
		root: /** @type {string} */ (takeString(args, "root", { required: true })),
		cwd: takeString(args, "cwd") ?? process.cwd(),
		authorizedRoots: authorizedRoots(args),
		...(workspacePath === undefined ? {} : { workspacePath }),
		...(projectId === undefined ? {} : { projectId }),
		...(workspaceId === undefined ? {} : { workspaceId }),
	};
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandOpen(args, asJson, signal) {
	const input = locationInput(args);
	const opened = await openProjectProfile({
		root: input.root,
		cwd: input.cwd,
		authorizedRoots: input.authorizedRoots,
		...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
		...(input.projectId === undefined ? {} : { biosProjectId: input.projectId }),
		signal,
	});
	// missing 不是成功：必须用退出码表达（R28-4）。
	const exitCode = opened.status === "usable" ? EXIT.ok : opened.status === "missing" ? EXIT.notFound : opened.status === "not-authorized" ? EXIT.refused : EXIT.inconsistent;
	const info = outcome(opened.status === "usable" ? "ok" : opened.status, exitCode);
	const payload = {
		...info,
		status: opened.status,
		usable: opened.usable,
		projectId: opened.projectId,
		workspaceId: opened.workspaceId,
		workspacePath: opened.workspacePath,
		registryRevision: opened.registryRevision,
		profileRevision: opened.profileRevision,
		workspaceAvailability: opened.workspaceAvailability,
		problems: opened.problems,
	};
	if (asJson) writeJson(payload);
	else {
		process.stdout.write(`打开：${opened.status}（usable=${opened.usable}）\n`);
		if (opened.projectId !== null) process.stdout.write(`  项目 ${opened.projectId} / 工作区 ${opened.workspaceId}\n`);
		if (opened.workspacePath !== null) process.stdout.write(`  工作区路径 ${opened.workspacePath}（${opened.workspaceAvailability}）\n`);
		process.stdout.write(`  registry rev ${opened.registryRevision ?? "-"} / profile rev ${opened.profileRevision ?? "-"}\n`);
		for (const problem of opened.problems) process.stdout.write(`  问题 ${problem.code}: ${problem.detail}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandBind(args, asJson, signal) {
	const input = locationInput(args, { requireWorkspace: true });
	const projectId = input.projectId;
	const workspaceId = input.workspaceId;
	const displayName = takeString(args, "display-name");
	const desktopProjectId = takeString(args, "desktop-project-id");
	if (!takeBool(args, "write")) {
		return refuseWrite("bind", asJson, [`在 ${input.root} 写入/补齐 registry 绑定`, `为工作区 ${input.workspacePath} 写入或补齐项目档案${projectId === undefined ? "（新项目用稳定 UUID）" : `（复用项目 ${projectId}）`}`]);
	}
	const result = await bindProjectWorkspace({
		root: input.root,
		cwd: input.cwd,
		authorizedRoots: input.authorizedRoots,
		workspacePath: /** @type {string} */ (input.workspacePath),
		...(projectId === undefined ? {} : { biosProjectId: projectId }),
		...(workspaceId === undefined ? {} : { workspaceId }),
		...(desktopProjectId === undefined ? {} : { desktopProjectId }),
		...(displayName === undefined ? {} : { displayName }),
		signal,
	});
	// 部分完成/需要人工核对都不是"干净成功"：退出码要如实反映。
	const exitCode = result.status === "bound" || result.status === "already-bound" ? EXIT.ok : result.status === "failed" ? EXIT.failed : EXIT.needsReview;
	const info = outcome(result.status === "bound" || result.status === "already-bound" ? "ok" : result.status, exitCode);
	if (asJson) writeJson({ ...result, ...info });
	else {
		process.stdout.write(`${describeBindResult(result)}\n`);
		process.stdout.write(`  项目 ${result.projectId} / 工作区 ${result.workspaceId}\n`);
		for (const problem of result.problems) process.stdout.write(`  问题 ${problem}\n`);
		for (const reason of result.needsReview) process.stdout.write(`  需人工核对：${reason}\n`);
		for (const hint of result.resume) process.stdout.write(`  接续：${hint}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandDetect(args, asJson, signal) {
	const input = locationInput(args, { requireWorkspace: true });
	// 走 open：工作区路径与授权都由领域层判定，检测本身不再接受未经验证的路径。
	const opened = await openProjectProfile({
		root: input.root,
		cwd: input.cwd,
		authorizedRoots: input.authorizedRoots,
		workspacePath: /** @type {string} */ (input.workspacePath),
		...(input.projectId === undefined ? {} : { biosProjectId: input.projectId }),
		signal,
	});
	if (!opened.usable || opened.workspaceId === null || opened.workspacePath === null) {
		const exitCode = opened.status === "missing" ? EXIT.notFound : opened.status === "not-authorized" ? EXIT.refused : EXIT.inconsistent;
		const payload = { ...outcome(opened.status === "missing" ? "not-found" : opened.status, exitCode), status: "not-usable", open: { status: opened.status, problems: opened.problems }, detection: null };
		if (asJson) writeJson(payload);
		else process.stderr.write(`检测不可用（${opened.status}）：${opened.problems.map((problem) => `${problem.code}: ${problem.detail}`).join("；")}\n`);
		setExit(exitCode);
		return;
	}
	const detection = await detectProjectCandidates({ workspacePath: opened.workspacePath, workspaceId: opened.workspaceId, cwd: input.cwd, authorizedRoots: input.authorizedRoots, signal });
	const exitCode = detection.truncated ? EXIT.failed : EXIT.ok;
	const payload = { ...outcome(detection.truncated ? "incomplete" : "ok", exitCode), status: detection.truncated ? "incomplete" : "ok", ...detection, projectId: opened.projectId, wroteToProfile: false };
	if (asJson) writeJson(payload);
	else {
		process.stdout.write(`检测：${payload.status}（扫过 ${detection.scannedFiles} 个文件、${detection.totalBytes} 字节；未写档案）\n`);
		for (const candidate of detection.candidates) process.stdout.write(`  候选 ${candidate.field} = ${candidate.value}（${candidate.rule} @ ${candidate.evidence.relativePath}:${candidate.evidence.line}）\n`);
		for (const gap of detection.gaps.slice(0, 6)) process.stdout.write(`  缺口 ${gap.field}：${gap.reason}\n`);
		for (const problem of detection.problems) process.stdout.write(`  问题 ${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandConfirm(args, asJson, signal) {
	const input = locationInput(args);
	const projectId = /** @type {string} */ (takeString(args, "project-id", { required: true }));
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	const operator = takeString(args, "operator");
	// 字段与证据形态都在这里（IO 之前）判定。
	const values = parseEvidenceFlags(args, parseSetFlags(args));
	if (values.length === 0) throw new UsageError("confirm 至少需要一个 --set <字段>=<值>");
	if (!takeBool(args, "write")) {
		return refuseWrite("confirm", asJson, [`把 ${values.map((value) => value.field).join("、")} 以 confirmed 写入项目 ${projectId}（期望 revision=${revision}）`]);
	}
	const result = await confirmProfileFields({
		root: input.root,
		projectId,
		expectedProfileRevision: revision,
		values,
		...(input.workspaceId === undefined ? {} : { workspaceId: input.workspaceId }),
		...(operator === undefined ? {} : { operatorLabel: operator }),
		signal,
	});
	const baseExit = result.status === "revision-conflict" ? EXIT.conflict : result.status === "not-found" ? EXIT.notFound : EXIT.ok;
	const exitCode = baseExit === EXIT.ok && result.needsReview.length > 0 ? EXIT.needsReview : baseExit;
	const info = outcome(exitCode === EXIT.needsReview ? "needs-review" : result.status === "confirmed" || result.status === "no-change" ? "ok" : result.status, exitCode);
	if (asJson) writeJson({ ...result, ...info, status: result.status, projectId });
	else {
		process.stdout.write(`确认：${result.status}（revision=${result.revision ?? "-"}）\n`);
		if (result.changedFields.length > 0) process.stdout.write(`  变更字段 ${result.changedFields.join("、")}\n`);
		process.stdout.write(`  执行者标签 ${result.operatorLabel ?? "（未提供）"}（只是声明，不是身份认证）\n`);
		for (const reason of result.needsReview) process.stdout.write(`  需人工核对：${reason}\n`);
		for (const problem of result.problems) process.stdout.write(`  问题 ${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandRefresh(args, asJson, signal) {
	const input = locationInput(args);
	const projectId = /** @type {string} */ (takeString(args, "project-id", { required: true }));
	const workspaceId = /** @type {string} */ (takeString(args, "workspace-id", { required: true }));
	const revision = /** @type {number} */ (takeInt(args, "revision", { required: true }));
	if (!takeBool(args, "write")) {
		return refuseWrite("refresh", asJson, [`重新采集工作区 ${workspaceId} 的 availability/branch/HEAD 并写回项目 ${projectId}（期望 revision=${revision}）`]);
	}
	// cwd/授权根必须传下去：领域层要按它们重新判定档案里保存的工作区路径。
	const result = await refreshWorkspaceSnapshot({ root: input.root, cwd: input.cwd, authorizedRoots: input.authorizedRoots, projectId, workspaceId, expectedProfileRevision: revision, signal });
	const baseExit = result.status === "revision-conflict" ? EXIT.conflict : result.status === "not-found" ? EXIT.notFound : EXIT.ok;
	const exitCode = baseExit === EXIT.ok && result.needsReview.length > 0 ? EXIT.needsReview : baseExit;
	const info = outcome(exitCode === EXIT.needsReview ? "needs-review" : result.status === "refreshed" || result.status === "unchanged" ? "ok" : result.status, exitCode);
	if (asJson) writeJson({ ...result, ...info, status: result.status, projectId, workspaceId });
	else {
		process.stdout.write(`刷新：${result.status}（revision=${result.revision ?? "-"}）\n`);
		if (result.snapshot !== null) process.stdout.write(`  ${result.snapshot.availability} / branch=${result.snapshot.vcs?.branch ?? "-"} / head=${result.snapshot.vcs?.head ?? "-"}\n`);
		for (const reason of result.needsReview) process.stdout.write(`  需人工核对：${reason}\n`);
		for (const problem of result.problems) process.stdout.write(`  提示 ${problem}\n`);
	}
	setExit(exitCode);
}

/** @param {ParsedArgs} args @param {boolean} asJson @param {AbortSignal} signal */
async function commandRead(args, asJson, signal) {
	const input = locationInput(args);
	const maxOutputBytes = takeInt(args, "max-output-bytes");
	const view = await readProjectView({
		root: input.root,
		cwd: input.cwd,
		authorizedRoots: input.authorizedRoots,
		...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
		...(input.projectId === undefined ? {} : { biosProjectId: input.projectId }),
		detect: takeBool(args, "detect"),
		verifyEvidence: takeBool(args, "verify-evidence"),
		probeVcs: takeBool(args, "probe-vcs"),
		...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
		signal,
	});
	const exitCode = view.status === "ok" ? EXIT.ok : view.status === "incomplete" ? EXIT.failed : view.open.status === "missing" ? EXIT.notFound : view.open.status === "not-authorized" ? EXIT.refused : EXIT.inconsistent;
	const info = outcome(view.status === "ok" ? "ok" : view.status === "incomplete" ? "incomplete" : view.open.status === "missing" ? "not-found" : view.open.status, exitCode);
	const payload = {
		...info,
		status: view.status,
		projectId: view.open.projectId,
		workspaceId: view.open.workspaceId,
		workspacePath: view.open.workspacePath,
		revisions: view.revisions,
		workspaceVcs: view.workspaceVcs,
		headChanged: view.headChanged,
		branchChanged: view.branchChanged,
		decision: view.decision === null ? null : { status: view.decision.status, dropped: view.decision.dropped, items: view.decision.items },
		detectedCandidates: view.detection === null ? null : view.detection.candidates.map((candidate) => ({ field: candidate.field, value: candidate.value, rule: candidate.rule, relativePath: candidate.evidence.relativePath })),
		detectionTruncated: view.detection === null ? null : view.detection.truncated,
		evidenceChecks: view.evidenceChecks,
		evidenceUnchecked: view.evidenceUnchecked,
		evidenceUnverifiedFacts: view.evidenceUnverifiedFacts,
		shellTruncated: view.shellTruncated,
		gaps: view.gaps,
		problems: view.problems,
	};
	if (asJson) writeJson(payload);
	else {
		process.stdout.write(`读取：${view.status}（registry rev ${view.revisions.registry ?? "-"} / profile rev ${view.revisions.profile ?? "-"}）\n`);
		if (view.workspaceVcs !== null) process.stdout.write(`  工作区 branch=${view.workspaceVcs.branch ?? "-"} head=${view.workspaceVcs.head ?? "-"}${view.headChanged ? "（与档案记录不同，需复核）" : ""}\n`);
		for (const item of view.decision?.items ?? []) process.stdout.write(`  ${item.class} ${item.family}/${item.factKey ?? item.recordId} rev${item.revision}${item.reasons.length > 0 ? ` [${item.reasons.join(",")}]` : ""}\n`);
		if (view.decision !== null && view.decision.dropped > 0) process.stdout.write(`  因条目预算丢弃 ${view.decision.dropped} 条（--max-output-bytes 只约束 M1 条目数组）\n`);
		for (const check of view.evidenceChecks) process.stdout.write(`  证据 [${check.key}] ${check.relativePath ?? "?"}：${check.status}\n`);
		if (view.evidenceUnchecked > 0) process.stdout.write(`  未复验 ${view.evidenceUnchecked} 条（${view.evidenceUncheckedReasons.join("、")}）\n`);
		for (const problem of view.problems) process.stdout.write(`  提示 ${problem}\n`);
		for (const gap of view.gaps.slice(0, 8)) process.stdout.write(`  缺口 ${gap.field}：${gap.reason}\n`);
	}
	setExit(exitCode);
}

const COMMANDS = {
	open: commandOpen,
	bind: commandBind,
	detect: commandDetect,
	confirm: commandConfirm,
	refresh: commandRefresh,
	read: commandRead,
};

async function main() {
	const { command, rest } = resolveCommand(process.argv.slice(2), OPTION_SPEC);
	const allowed = command === undefined ? ["help", "json"] : (COMMAND_OPTIONS[/** @type {keyof typeof COMMAND_OPTIONS} */ (command)] ?? null);

	let args;
	try {
		// 未知命令必须**先**解析出 `--json` 才能按 JSON 报错：这里只在允许集未知时放宽到全表。
		args = parseArgv(rest, allowed ?? Object.keys(OPTION_SPEC), OPTION_SPEC);
	} catch (error) {
		const asJson = rest.includes("--json");
		reportError(error, asJson, { command: command === undefined ? null : short(command) });
		return;
	}
	const asJson = takeBool(args, "json");

	if (command === undefined || command === "help" || takeBool(args, "help")) {
		if (asJson) writeJson({ ...outcome("ok", EXIT.ok), status: "ok", command: "help", usage: USAGE });
		else process.stdout.write(USAGE);
		return;
	}
	const handler = /** @type {Record<string, CommandHandler | undefined>} */ (COMMANDS)[command];
	if (handler === undefined) {
		// 未知命令：受控 JSON（不回显无关的长参数）。
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
		reportError(error, asJson, interrupted ? { cancelled: true, detail: "信号中断，已把取消传给文件与 Git 子进程" } : {});
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
}

await main();
