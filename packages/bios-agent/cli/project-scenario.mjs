#!/usr/bin/env node
/**
 * BM-03 **合成端到端演示**（`node cli/project-scenario.mjs`）。
 *
 * 演示的是真实调用链，不是预写字符串：
 * 每一步都用**子进程**跑 `cli/project.mjs`（因此"新进程读取"是真的新进程），
 * 只对合成目录读写，不碰任何真实知识库与客户源码。
 *
 * 场景：初始化 → 绑定 → 检测（身份字段仍未知 + 真实候选）→ 工程师确认 →
 * 新进程读回同一 ID/revision/确认值 → 改证据文件并切换 Git HEAD →
 * 再读提示变化但**不覆写**确认值 → 切到第二工作区不串快照。
 *
 * 输出：一段可解析 JSON（`status` + `steps`），任一步不符合预期则 exit 1。
 * 临时目录在结束时清理；输出里只保留相对标签，不把临时绝对路径当产品身份。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeKnowledgeStore } from "../core/storage/index.ts";

const CLI = fileURLToPath(new URL("./project.mjs", import.meta.url));

/**
 * CLI JSON 输出里**本演示实际使用**的字段（结构化声明，避免 `any`）。
 *
 * @typedef {{
 *   status?: string, code?: string, projectId?: string, workspaceId?: string,
 *   registryRevision?: number | null, profileRevision?: number | null,
 *   steps?: Array<{ step?: string, status?: string, revision?: number }>,
 *   scannedFiles?: number, wroteToProfile?: boolean,
 *   candidates?: Array<{ field: string, value: string, rule: string }>,
 *   gaps?: Array<{ field: string }>,
 *   decision?: { status?: string, dropped?: number, items: Array<{ factKey: string | null, family: string, class: string, reasons: string[] }> } | null,
 *   revisions?: { profile: number | null, registry: number | null },
 *   workspaceVcs?: { branch: string | null, head: string | null } | null,
 *   headChanged?: boolean,
 *   evidenceChecks?: Array<{ status: string }>,
 *   changedFields?: string[], operatorLabel?: string | null, revision?: number | null
 * }} CliPayload
 */

/** @type {Array<Record<string, unknown>>} */
const steps = [];
/** @type {string[]} */
const failures = [];

/**
 * 跑真实 CLI 子进程；返回退出码与解析后的 JSON（stdout 必须恰好一个对象）。
 * @param {string[]} args @returns {{ code: number, json: CliPayload | null, stderr: string }}
 */
function runCli(args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 });
		return { code: 0, json: JSON.parse(stdout.trim()), stderr: "" };
	} catch (error) {
		const failure = /** @type {{ status?: number, stdout?: string, stderr?: string }} */ (error);
		let json = null;
		try {
			json = JSON.parse(typeof failure.stdout === "string" ? failure.stdout.trim() : "");
		} catch {
			json = null;
		}
		return { code: typeof failure.status === "number" ? failure.status : 1, json, stderr: typeof failure.stderr === "string" ? failure.stderr : "" };
	}
}

/** @param {string} name @param {Record<string, unknown>} detail @param {boolean} ok */
function record(name, detail, ok) {
	steps.push({ name, ok, ...detail });
	if (!ok) failures.push(name);
}

/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function assert(condition, message) {
	if (!condition) throw new Error(message);
}

/** @param {CliPayload | null} payload @param {string} label @returns {CliPayload} */
function requirePayload(payload, label) {
	if (payload === null) throw new Error(`${label}：CLI 没有输出可解析的 JSON`);
	return payload;
}

/**
 * 按**记录族 + 事实键**取条目。
 *
 * 只按事实键取会串：人工确认的 `project-profile.buildTargets` 与检测到的
 * `detected-candidate` 候选**故意**共用同一个业务事实键（这样它们才能形成待确认差异）。
 *
 * @param {CliPayload | null} payload @param {string} family @param {string} factKey
 */
function pickItem(payload, family, factKey) {
	return (payload?.decision?.items ?? []).find((item) => item.family === family && item.factKey === factKey);
}

/** @param {string} text @returns {string} */
function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

/** @param {string} platformName @param {string[]} [extra] @returns {string} */
function dscText(platformName, extra = []) {
	return ["# synthetic EDK II platform description", "[Defines]", `  PLATFORM_NAME = ${platformName}`, "  SUPPORTED_ARCHITECTURES = X64", "", "[Components]", ...extra, "  SamplePkg/Sample.inf", ""].join("\n");
}

/** @param {string} dir @param {string[]} args @returns {string} */
function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_AUTHOR_NAME: "scenario", GIT_AUTHOR_EMAIL: "scenario@example.invalid", GIT_COMMITTER_NAME: "scenario", GIT_COMMITTER_EMAIL: "scenario@example.invalid", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" },
	});
}

function gitAvailable() {
	try {
		execFileSync("git", ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

const base = await mkdtemp(join(tmpdir(), "bm03-scenario-"));
const root = join(base, "knowledge");
const wsA = join(base, "ws-a");
const wsB = join(base, "ws-b");
const dscRelative = "Platform/SamplePkg/Sample.dsc";

try {
	await mkdir(join(wsA, "Platform", "SamplePkg"), { recursive: true });
	await mkdir(join(wsB, "Platform", "SamplePkg"), { recursive: true });
	const dscA = join(wsA, dscRelative);
	await writeFile(dscA, dscText("SamplePlatformA"));
	await writeFile(join(wsB, dscRelative), dscText("SamplePlatformB"));
	const useGit = gitAvailable();
	if (useGit) {
		for (const dir of [wsA, wsB]) {
			git(dir, ["init", "-q"]);
			git(dir, ["add", "-A"]);
			git(dir, ["commit", "-q", "-m", "init"]);
		}
	}

	const initialized = await initializeKnowledgeStore({ root });
	record("初始化合成知识库", { status: initialized.status, createdDirectories: initialized.createdDirectories.length }, initialized.status === "created" || initialized.status === "existing");

	const common = ["--root", root, "--cwd", wsA, "--authorized-root", wsA, "--authorized-root", wsB, "--json"];

	// ---- 1) 绑定（未确认写入必须被拒绝） ----
	const refused = runCli([...common, "bind", "--workspace", wsA]);
	record("未确认写入被拒绝", { exitCode: refused.code, code: refused.json?.code ?? null }, refused.code === 3 && refused.json?.code === "write-not-confirmed");

	const bound = runCli([...common, "bind", "--workspace", wsA, "--write", "--display-name", "Synthetic A"]);
	assert(bound.code === 0, `bind 失败：${bound.code} ${bound.stderr}`);
	const boundPayload = requirePayload(bound.json, "bind");
	assert(typeof boundPayload.projectId === "string" && typeof boundPayload.workspaceId === "string", "bind 必须返回项目与工作区 ID");
	const projectId = boundPayload.projectId;
	const workspaceAId = boundPayload.workspaceId;
	record(
		"绑定工作区到新项目",
		{ status: boundPayload.status, registryRevision: boundPayload.registryRevision ?? null, profileRevision: boundPayload.profileRevision ?? null, steps: (boundPayload.steps ?? []).map((step) => `${step.step}:${step.status}`) },
		boundPayload.status === "bound" && (boundPayload.steps ?? []).every((step) => step.status !== "failed"),
	);

	// ---- 2) 检测：身份仍未知，但平台名/包名是真实候选 ----
	const detected = runCli([...common, "detect", "--workspace", wsA]);
	assert(detected.code === 0, `detect 失败：${detected.code}`);
	const detectedPayload = requirePayload(detected.json, "detect");
	const platformCandidate = (detectedPayload.candidates ?? []).find((candidate) => candidate.rule === "edk2-dsc-platform-name");
	assert(platformCandidate !== undefined, "检测必须从文件内容得到平台名候选");
	record(
		"有限检测（只读，未写档案）",
		{
			scannedFiles: detectedPayload.scannedFiles ?? null,
			candidates: (detectedPayload.candidates ?? []).map((candidate) => `${candidate.field}=${candidate.value}`),
			boardNameGap: (detectedPayload.gaps ?? []).some((gap) => gap.field === "boardName"),
			wroteToProfile: detectedPayload.wroteToProfile ?? null,
		},
		platformCandidate.field === "buildTargets" && platformCandidate.value === "SamplePlatformA" && detectedPayload.wroteToProfile === false,
	);

	const beforeConfirm = runCli([...common, "read", "--workspace", wsA, "--detect"]);
	assert(beforeConfirm.code === 0, `read 失败：${beforeConfirm.code}`);
	const beforeItems = requirePayload(beforeConfirm.json, "read").decision?.items ?? [];
	record("确认前读取：身份字段仍未知（只有检测候选待确认）", { status: beforeConfirm.json?.status ?? null, items: beforeItems.map((item) => `${item.class}:${item.factKey}`), gapCount: (beforeConfirm.json?.gaps ?? []).length }, beforeItems.length > 0 && beforeItems.every((item) => item.class !== "current"));

	// ---- 3) 工程师确认（独立写动作 + 文件证据） ----
	const hashBefore = sha256(await readFile(dscA, "utf8"));
	const confirmed = runCli([
		...common,
		"confirm",
		"--project-id",
		projectId,
		"--workspace-id",
		workspaceAId,
		"--revision",
		String(boundPayload.profileRevision ?? 0),
		"--set",
		"boardName=SyntheticBoardA",
		"--set",
		"buildTargets=SamplePlatformA",
		"--evidence",
		`boardName=${dscRelative}@${hashBefore}`,
		"--operator",
		"engineer-scenario",
		"--write",
	]);
	assert(confirmed.code === 0, `confirm 失败：${confirmed.code} ${JSON.stringify(confirmed.json)}`);
	const confirmedPayload = requirePayload(confirmed.json, "confirm");
	const confirmedRevision = confirmedPayload.revision ?? null;
	record(
		"人工确认（独立写动作 + CAS）",
		{ status: confirmedPayload.status ?? null, revision: confirmedRevision, changedFields: confirmedPayload.changedFields ?? [], operatorLabel: confirmedPayload.operatorLabel ?? null },
		confirmedPayload.status === "confirmed" && confirmedRevision === (boundPayload.profileRevision ?? 0) + 1,
	);

	// ---- 4) 采集初始快照：档案里记下"确认时的检出状态"（之后才有对照物） ----
	const initialOpen = runCli([...common, "open", "--workspace", wsA]);
	assert(initialOpen.code === 0, `open 失败：${initialOpen.code}`);
	const initialRefresh = runCli([...common, "refresh", "--project-id", projectId, "--workspace-id", workspaceAId, "--revision", String(initialOpen.json?.profileRevision ?? 0), "--write"]);
	assert(initialRefresh.code === 0, `refresh 失败：${initialRefresh.code} ${JSON.stringify(initialRefresh.json)}`);
	record("采集初始工作区快照", { status: initialRefresh.json?.status ?? null }, initialRefresh.json?.status === "refreshed");
	// 写回者报告的 revision 就是"下一次读取必须看到"的那一版。
	const expectedRevision = initialRefresh.json?.revision ?? null;

	// ---- 5) 新进程读取：同一 ID / revision / 确认值 ----
	const reread = runCli([...common, "read", "--workspace", wsA, "--probe-vcs", "--verify-evidence"]);
	assert(reread.code === 0, `read 失败：${reread.code}`);
	const rereadPayload = requirePayload(reread.json, "read");
	const rereadBoard = pickItem(rereadPayload, "project-profile", "project-profile.boardName");
	record(
		"新进程读回同一身份与确认值",
		{
			sameProject: rereadPayload.projectId === projectId,
			sameWorkspace: rereadPayload.workspaceId === workspaceAId,
			profileRevision: rereadPayload.revisions?.profile ?? null,
			expectedRevision,
			boardNameClass: rereadBoard?.class ?? null,
			head: rereadPayload.workspaceVcs?.head?.slice(0, 8) ?? null,
			headChanged: rereadPayload.headChanged ?? null,
		},
		rereadPayload.projectId === projectId && rereadPayload.workspaceId === workspaceAId && rereadPayload.revisions?.profile === expectedRevision && rereadBoard?.class === "current" && rereadPayload.headChanged === false,
	);

	// ---- 5) 改证据文件 + 切换 Git HEAD：提示变化，但不覆写确认值 ----
	await writeFile(dscA, dscText("SamplePlatformARenamed", ["  SamplePkg/Extra.inf"]));
	if (useGit) {
		git(wsA, ["add", "-A"]);
		git(wsA, ["commit", "-q", "-m", "change evidence"]);
	}

	const afterChange = runCli([...common, "read", "--workspace", wsA, "--detect", "--verify-evidence", "--probe-vcs"]);
	assert(afterChange.code === 0, `read 失败：${afterChange.code}`);
	const afterPayload = requirePayload(afterChange.json, "read");
	const boardAfter = pickItem(afterPayload, "project-profile", "project-profile.boardName");
	const targetAfter = pickItem(afterPayload, "project-profile", "project-profile.buildTargets");
	const stored = JSON.parse(await readFile(join(root, "projects", projectId, "profile.json"), "utf8"));
	record(
		"证据变化 / HEAD 变化：结论退回待复核，确认值未被覆写",
		{
			boardNameClass: boardAfter?.class ?? null,
			boardNameReasons: boardAfter?.reasons ?? [],
			buildTargetsClass: targetAfter?.class ?? null,
			buildTargetsReasons: targetAfter?.reasons ?? [],
			headChanged: afterPayload.headChanged ?? null,
			evidence: (afterPayload.evidenceChecks ?? []).map((check) => check.status),
			storedBoardName: { value: stored.identity.boardName.value, status: stored.identity.boardName.status },
		},
		boardAfter?.class === "needs-review" &&
			(boardAfter.reasons ?? []).includes("verification-drift") &&
			targetAfter?.class === "needs-review" &&
			(targetAfter.reasons ?? []).includes("needs-confirmation") &&
			stored.identity.boardName.value === "SyntheticBoardA" &&
			stored.identity.boardName.status === "confirmed" &&
			(useGit ? afterPayload.headChanged === true : true),
	);

	// ---- 6) 刷新快照后漂移消失（显式动作，不是自动修复） ----
	const currentOpen = runCli([...common, "open", "--workspace", wsA]);
	assert(currentOpen.code === 0, `open 失败：${currentOpen.code}`);
	const refreshed = runCli([...common, "refresh", "--project-id", projectId, "--workspace-id", workspaceAId, "--revision", String(currentOpen.json?.profileRevision ?? 0), "--write"]);
	assert(refreshed.code === 0, `refresh 失败：${refreshed.code} ${JSON.stringify(refreshed.json)}`);
	const afterRefresh = runCli([...common, "read", "--workspace", wsA, "--probe-vcs"]);
	const boardRefreshed = pickItem(afterRefresh.json, "project-profile", "project-profile.boardName");
	record("显式刷新快照后漂移消失", { status: refreshed.json?.status ?? null, headChanged: afterRefresh.json?.headChanged ?? null, boardNameClass: boardRefreshed?.class ?? null }, boardRefreshed?.class === "current" && afterRefresh.json?.headChanged === false);

	// ---- 7) 第二个工作区：显式绑定，且不串快照 ----
	const boundB = runCli([...common, "bind", "--workspace", wsB, "--project-id", projectId, "--write"]);
	assert(boundB.code === 0, `bind ws-b 失败：${boundB.code} ${JSON.stringify(boundB.json)}`);
	const workspaceBId = boundB.json?.workspaceId;
	assert(typeof workspaceBId === "string", "bind 必须返回工作区 ID");
	assert(workspaceBId !== workspaceAId, "两个工作区必须有不同的 workspaceId");
	const openB = runCli([...common, "open", "--project-id", projectId, "--workspace", wsB]);
	assert(openB.code === 0, `open ws-b 失败：${openB.code}`);
	const refreshedB = runCli([...common, "refresh", "--project-id", projectId, "--workspace-id", workspaceBId, "--revision", String(openB.json?.profileRevision ?? 0), "--write"]);
	assert(refreshedB.code === 0, `refresh ws-b 失败：${refreshedB.code} ${JSON.stringify(refreshedB.json)}`);
	const readB = runCli([...common, "read", "--workspace", wsB, "--probe-vcs", "--detect"]);
	assert(readB.code === 0, `read ws-b 失败：${readB.code}`);
	const profileAfterBoth = JSON.parse(await readFile(join(root, "projects", projectId, "profile.json"), "utf8"));
	const entryA = profileAfterBoth.workspaces.find((/** @type {{ workspaceId: string }} */ workspace) => workspace.workspaceId === workspaceAId);
	const entryB = profileAfterBoth.workspaces.find((/** @type {{ workspaceId: string }} */ workspace) => workspace.workspaceId === workspaceBId);
	assert(entryA !== undefined && entryB !== undefined, "两个工作区都必须入档");
	record(
		"第二工作区独立快照，不与第一工作区互串",
		{
			workspaceA: { availability: entryA.availability, head: entryA.vcs?.head?.slice(0, 8) ?? null },
			workspaceB: { availability: entryB.availability, head: entryB.vcs?.head?.slice(0, 8) ?? null },
			readBHead: readB.json?.workspaceVcs?.head?.slice(0, 8) ?? null,
			readBWorkspace: readB.json?.workspaceId ?? null,
		},
		(entryA.vcs?.head ?? "") !== (entryB.vcs?.head ?? "") && readB.json?.workspaceId === workspaceBId,
	);

	// ---- 8) 越权路径：在 IO 之前被拒绝 ----
	const outside = runCli([...common, "bind", "--workspace", base, "--write"]);
	record("未授权路径在 IO 之前被拒绝", { exitCode: outside.code, code: outside.json?.code ?? null }, outside.code === 3 && outside.json?.code === "not-authorized");

	const summary = {
		scenario: "bm03-project-facts",
		status: failures.length === 0 ? "ok" : "failed",
		gitProbed: useGit,
		projectId,
		workspaces: { a: workspaceAId, b: workspaceBId },
		steps,
		failures,
		notes: ["全部数据是合成 EDK II 形状的临时目录；没有读取任何真实知识库或客户源码。", "“新进程读取”是真的子进程：每一步都重新启动 cli/project.mjs。", "项目/工作区 ID 每次运行都不同（稳定 UUID 按运行生成），因此本输出不能当成固定身份。"],
	};
	process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
	if (failures.length > 0) process.exitCode = 1;
} catch (error) {
	process.stdout.write(`${JSON.stringify({ scenario: "bm03-project-facts", status: "failed", error: error instanceof Error ? error.message : String(error), steps, failures }, null, 2)}\n`);
	process.exitCode = 1;
} finally {
	await rm(base, { recursive: true, force: true });
}
