/**
 * BM-03 B4：**每工作区快照与证据复验**（R28-2/R28-4 后重写过的版本）。
 *
 * 快照按工作区**分别**采集：availability、branch/HEAD/capturedAt。
 * 调查一个项目有两个 worktree 时，"HEAD 是哪一个检出的"必须能回答；
 * 把两份检出混成一份 branch/HEAD 会让证据复核张冠李戴。
 *
 * Git 纪律（设计 §3.2.4）：
 * - 固定 argv，不经 shell（不用字符串拼接，避免把目录名变成命令）；
 * - 固定已授权 cwd，不 fetch、不执行项目脚本、不读认证信息；
 * - 限时、限输出、支持取消，并回收子进程与监听器（`execFile` 的 `timeout`/`signal` 负责）；
 * - 远端 URL **不自动采集**（`null`），因此没有凭证泄漏面；
 * - 非 Git 目录**省略** `vcs`，不写空字符串伪装成 Git。
 *
 * R28-2 后的三处硬要求：
 * 1. **实际字节上限**：`stat` 只用于分类，真正的上限由有界读取执行（文件在 stat 之后长大也不会越额）；
 * 2. **取消在异步边界传播**：每个 await 之后都复查，句柄在 `finally` 关闭；
 * 3. **两类独立预算**：文件数（真读文件）与检查条目数（含不可复验的声明）各自有界，
 *    命中即计入 `uncheckedCount` 并让整体不完整——没看过不等于"有效"。
 *
 * 复验纪律：只读比较，**不**改档案。证据变 stale/unavailable 时不会自动删掉证据、
 * 更不会覆盖人工确认值——那属于显式动作。
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { open as openFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EvidenceRef } from "../contracts/common.ts";
import type { ProjectProfile, WorkspaceAvailability, WorkspaceVcs } from "../contracts/records.ts";
import { isStorageError, readRecord, updateRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { authorizeWorkspacePath, isWithinAuthorizedRoot } from "./authorization.ts";
import { assertSafeRelativePath, invalidArgument, notAuthorized, optionalAbsolutePath, ProjectServiceError, requireBoundedText, resolveProjectLimits, type ProjectServiceErrorCode, type ProjectServiceLimits } from "./contract.ts";
import { collectWriteNotes } from "./writeNotes.ts";

const execFileAsync = promisify(execFile);

/** 远端 URL 默认不采集（要显示必须先过凭证清理，不在本批范围）。 */
export const COLLECT_REMOTE_URL = false;

/** 有界读取的块大小（同时决定取消检查的最坏延迟）。 */
const READ_CHUNK_BYTES = 64 * 1024;

export type GitSnapshot = {
	readonly isGit: boolean;
	/** detached HEAD 时为 null（不是空串：空串会看起来像一个叫 "" 的分支）。 */
	readonly branch: string | null;
	readonly head: string | null;
	readonly remoteUrl: string | null;
	readonly problems: readonly string[];
};

export type GitProbeOptions = {
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly limits?: Partial<ProjectServiceLimits>;
};

function isAbortError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError";
}

function fsCode(error: unknown): string {
	return typeof error === "object" && error !== null && "code" in error ? String((error as { code?: unknown }).code) : "";
}

/** 取消检查的唯一入口：只在**异步等待点之后**调用才有意义。 */
function assertNotCancelled(signal: AbortSignal | undefined, message: string): void {
	if (signal?.aborted) throw new ProjectServiceError("cancelled", message);
}

/**
 * 一条固定 argv 的 git 命令。
 *
 * `maxBuffer` 同时限制 stdout 与 stderr：即使命令输出失控也不会把内存吃满。
 * `windowsHide` 避免在 Windows 上弹出控制台窗口。
 */
async function runGit(args: readonly string[], options: GitProbeOptions & { limits: ProjectServiceLimits }): Promise<{ ok: true; stdout: string } | { ok: false; code: string; message: string }> {
	try {
		const { stdout } = await execFileAsync("git", ["-C", options.cwd, ...args], {
			encoding: "utf8",
			timeout: options.limits.gitTimeoutMs,
			maxBuffer: options.limits.maxGitOutputBytes,
			windowsHide: true,
			...(options.signal === undefined ? {} : { signal: options.signal }),
		});
		return { ok: true, stdout: stdout ?? "" };
	} catch (error) {
		if (isAbortError(error)) throw new ProjectServiceError("cancelled", "Git 快照采集已取消", { cause: error });
		const killed = typeof error === "object" && error !== null && "killed" in error && (error as { killed?: unknown }).killed === true;
		if (killed) return { ok: false, code: "git-timeout", message: `git 超过 ${options.limits.gitTimeoutMs}ms 未返回，已终止` };
		return { ok: false, code: fsCode(error) || "unknown", message: error instanceof Error ? error.message : String(error) };
	}
}

/** 采集一个工作区的 Git 快照；非 Git 目录返回 `isGit: false` 而**不是**错误。 */
export async function probeGitSnapshot(options: GitProbeOptions): Promise<GitSnapshot> {
	const limits = resolveProjectLimits(options.limits);
	const inside = await runGit(["rev-parse", "--is-inside-work-tree"], { ...options, limits });
	if (!inside.ok) {
		// git 不在 PATH、或目录不是仓库：都归到"没有 Git 信息"，但把原因写清楚。
		return { isGit: false, branch: null, head: null, remoteUrl: null, problems: [`git 不可用或该目录不是 Git 仓库（${inside.code}）`] };
	}
	if (inside.stdout.trim() !== "true") return { isGit: false, branch: null, head: null, remoteUrl: null, problems: [] };

	const problems: string[] = [];
	const head = await runGit(["rev-parse", "HEAD"], { ...options, limits });
	const headValue = head.ok ? head.stdout.trim() : null;
	if (!head.ok) problems.push(`读取 HEAD 失败：${head.message}`);

	const branchResult = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], { ...options, limits });
	let branch: string | null = null;
	if (branchResult.ok) {
		const value = branchResult.stdout.trim();
		// detached HEAD 时 `--abbrev-ref` 输出字面量 `HEAD`：这是"没有分支"，不是"分支叫 HEAD"。
		branch = value === "" || value === "HEAD" ? null : value;
		if (branch === null) problems.push("当前处于 detached HEAD，分支按未知处理");
	} else {
		problems.push(`读取分支失败：${branchResult.message}`);
	}

	return { isGit: true, branch, head: headValue === "" ? null : headValue, remoteUrl: null, problems };
}

/* ------------------------------------------------------------------ 有界读取 */

export type BoundedReadResult = { readonly ok: true; readonly bytes: Buffer } | { readonly ok: false; readonly code: "too-large" | "read-failed"; readonly detail: string };

/**
 * **实际字节**有界的读取（不是"先 stat 再整文件读"）。
 *
 * 逐块读取并在每块之后检查取消；一旦累计超过 `maxBytes` 立即停止（不会为了报错而读完整个文件），
 * 句柄一定在 `finally` 关闭。这样"文件在 stat 之后长大了"也不会被越额读进内存。
 */
export async function readFileBounded(absolute: string, maxBytes: number, signal: AbortSignal | undefined, cancelMessage: string): Promise<BoundedReadResult> {
	let handle: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		handle = await openFile(absolute, "r");
		assertNotCancelled(signal, cancelMessage);
		const chunks: Buffer[] = [];
		let total = 0;
		for (;;) {
			assertNotCancelled(signal, cancelMessage);
			const room = maxBytes + 1 - total;
			if (room <= 0) return { ok: false, code: "too-large", detail: `实际字节数超过单文件预算 ${maxBytes}` };
			const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, room));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
			assertNotCancelled(signal, cancelMessage);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) return { ok: false, code: "too-large", detail: `实际字节数超过单文件预算 ${maxBytes}` };
			chunks.push(chunk.subarray(0, bytesRead));
		}
		return { ok: true, bytes: Buffer.concat(chunks, total) };
	} catch (error) {
		if (error instanceof ProjectServiceError) throw error;
		return { ok: false, code: "read-failed", detail: `读取失败（${fsCode(error) || "unknown"}）` };
	} finally {
		// 句柄必须在所有路径关闭；重复关闭只忽略"已经关闭"这一类预期错误。
		await handle?.close().catch(() => undefined);
	}
}

/* ------------------------------------------------------------------ 快照 */

export type WorkspaceSnapshot = {
	readonly workspaceId: string;
	readonly path: string;
	readonly availability: WorkspaceAvailability;
	readonly vcs: WorkspaceVcs | null;
	readonly capturedAt: number;
	readonly problems: readonly string[];
};

export type CaptureWorkspaceInput = {
	readonly workspacePath: string;
	readonly workspaceId: string;
	/** 本次会话的授权范围（必填）：访问工作区前先判定（R28-4）。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	readonly now?: number;
	readonly signal?: AbortSignal;
	readonly limits?: Partial<ProjectServiceLimits>;
	/** 是否调用 Git（默认 true；纯可达性核对时可关掉）。 */
	readonly probeVcs?: boolean;
};

/**
 * 工作区路径的授权判定（R28-4 的唯一实现）。
 *
 * 每个会**访问工作区内容**的公开入口都必须先过这里；不可达要如实报告成 unreachable，
 * 但"不在授权范围内"必须是拒绝，不能因为目录恰好离线就变成"无法判定所以放行"。
 */
export function assertWorkspaceAuthorized(input: { cwd: string; authorizedRoots?: readonly string[]; workspacePath: string; context: string }): void {
	const authorization = authorizeWorkspacePath({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, path: input.workspacePath });
	if (!authorization.authorized) {
		throw notAuthorized(`${input.context}：工作区 ${input.workspacePath} 不在本次会话的授权范围内`, "workspace-not-authorized");
	}
}

export async function captureWorkspaceSnapshot(input: CaptureWorkspaceInput): Promise<WorkspaceSnapshot> {
	const workspacePath = optionalAbsolutePath(input.workspacePath, "工作区路径");
	if (workspacePath === undefined) throw invalidArgument("必须显式指定工作区路径");
	const workspaceId = requireBoundedText(input.workspaceId, "工作区 ID", 64);
	const capturedAt = input.now ?? Date.now();
	assertWorkspaceAuthorized({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, workspacePath, context: "采集工作区快照" });
	assertNotCancelled(input.signal, "快照采集已取消");

	const problems: string[] = [];
	let availability: WorkspaceAvailability = "unknown";
	try {
		const stats = await stat(workspacePath);
		assertNotCancelled(input.signal, "快照采集已取消");
		availability = stats.isDirectory() ? "reachable" : "missing";
		if (!stats.isDirectory()) problems.push("绑定路径当前不是目录");
	} catch (error) {
		if (error instanceof ProjectServiceError) throw error;
		const code = fsCode(error);
		availability = code === "ENOENT" ? "missing" : "permission-denied";
		problems.push(`工作区目录当前${availability === "missing" ? "不存在" : "不可访问"}（${code || "unknown"}）；绑定保留`);
	}

	let vcs: WorkspaceVcs | null = null;
	if (availability === "reachable" && input.probeVcs !== false) {
		const snapshot = await probeGitSnapshot({ cwd: workspacePath, signal: input.signal, limits: input.limits });
		assertNotCancelled(input.signal, "快照采集已取消");
		problems.push(...snapshot.problems);
		// 非 Git ⇒ 省略 `vcs`（不写空串伪装）。
		if (snapshot.isGit) vcs = { kind: "git", branch: snapshot.branch, head: snapshot.head, remoteUrl: snapshot.remoteUrl };
	}

	return { workspaceId, path: workspacePath, availability, vcs, capturedAt, problems };
}

export type RefreshWorkspaceInput = {
	readonly root: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly expectedProfileRevision: number;
	/** 本次会话的授权范围（必填）：访问档案里保存的工作区路径前重新判定（R28-4）。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type RefreshWorkspaceResult = {
	readonly status: "refreshed" | "revision-conflict" | "not-found" | "unchanged";
	readonly revision: number | null;
	readonly actualRevision: number | null;
	readonly snapshot: WorkspaceSnapshot | null;
	readonly problems: readonly string[];
	/** 存储层报告的"提交成立但有遗留"诊断（透传，不吞）。 */
	readonly warnings: readonly string[];
	/** 需要人工/巡检核对的原因（已提交但记账/清理未完成）。 */
	readonly needsReview: readonly string[];
};

/**
 * 刷新**一个**工作区的快照（availability + vcs + capturedAt），CAS 保护。
 *
 * 只替换该 `workspaceId` 的那一条：其它工作区、身份字段、构建目标、资料缺口与
 * 已有的证据引用都原样保留。刷新快照与"修改人工确认值"是两个不同的动作。
 */
export async function refreshWorkspaceSnapshot(input: RefreshWorkspaceInput): Promise<RefreshWorkspaceResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("刷新参数必须是对象");
	const root = requireBoundedText(input.root, "知识根", 4096);
	const projectId = requireBoundedText(input.projectId, "项目 ID", 64);
	const workspaceId = requireBoundedText(input.workspaceId, "工作区 ID", 64);
	const expected = input.expectedProfileRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedProfileRevision 必须是安全非负整数");
	// 参数形态与授权都在读取档案之前判定。
	const cwd = requireBoundedText(input.cwd, "会话工作目录", 4096);

	const read = await readRecord({ root, kind: "project-profile", id: projectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const profile: ProjectProfile = read.record;
	const target = profile.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
	if (target === undefined) throw new ProjectServiceError("inconsistent", `工作区 ${workspaceId} 不在项目 ${projectId} 的已绑定工作区里`, { detail: "workspace-not-in-profile" });

	if (profile.revision !== expected) {
		return { status: "revision-conflict", revision: profile.revision, actualRevision: profile.revision, snapshot: null, problems: [`期望 revision=${expected}，实际 revision=${profile.revision}；未写入任何内容。`], warnings: [], needsReview: [] };
	}

	// 授权针对的是**档案里保存的路径**：它可能早就离线/被别人改过，因此每次都要重新判定。
	const snapshot = await captureWorkspaceSnapshot({ workspacePath: target.path, workspaceId, cwd, authorizedRoots: input.authorizedRoots, now: input.now, signal: input.signal, limits: input.limits });

	const unchanged = snapshot.availability === target.availability && (snapshot.vcs?.head ?? null) === (target.vcs?.head ?? null) && (snapshot.vcs?.branch ?? null) === (target.vcs?.branch ?? null);
	if (unchanged) return { status: "unchanged", revision: profile.revision, actualRevision: profile.revision, snapshot, problems: snapshot.problems, warnings: [], needsReview: [] };

	const workspaces = profile.workspaces.map((workspace) => {
		if (workspace.workspaceId !== workspaceId) return workspace;
		return {
			workspaceId: workspace.workspaceId,
			path: workspace.path,
			availability: snapshot.availability,
			...(snapshot.vcs === null ? {} : { vcs: snapshot.vcs }),
			capturedAt: snapshot.capturedAt,
		};
	});

	try {
		const written = await updateRecord({
			kind: "project-profile",
			id: projectId,
			data: { identity: profile.identity, workspaces, buildTargets: profile.buildTargets, keyEntryPoints: profile.keyEntryPoints, gaps: profile.gaps },
			expectedRevision: profile.revision,
			root,
			now: input.now ?? Date.now(),
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		const notes = collectWriteNotes(written, "项目档案");
		return { status: "refreshed", revision: written.revision, actualRevision: written.revision, snapshot, problems: snapshot.problems, warnings: notes.warnings, needsReview: notes.needsReview };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			return { status: "revision-conflict", revision: null, actualRevision: null, snapshot, problems: [error.message], warnings: [], needsReview: [] };
		}
		const code: ProjectServiceErrorCode = isStorageError(error) && error.code === "cancelled" ? "cancelled" : "io-error";
		throw new ProjectServiceError(code, `刷新工作区快照失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
}

/* ------------------------------------------------------------------ 证据复验 */

export type EvidenceCheckStatus = "valid" | "changed" | "missing" | "unreadable" | "not-verifiable" | "not-checked";

/** 未复验的原因分类（有界枚举，供汇总与测试断言）。 */
export type EvidenceUncheckedReason = "entry-budget" | "file-budget" | "file-too-large";

export type EvidenceCheck = {
	/** 调用方的分组键（例如事实键）：结果必须还给**它所属的那个事实**，不能跨字段串用。 */
	readonly key: string;
	readonly relativePath: string | null;
	readonly status: EvidenceCheckStatus;
	readonly expectedHash: string | null;
	readonly actualHash: string | null;
	readonly detail: string;
};

export type EvidenceVerificationEntry = {
	/** 分组键（事实键 / 字段名）。只用于归属，不参与 IO 判定。 */
	readonly key: string;
	readonly evidence: EvidenceRef;
};

export type VerifyEvidenceInput = {
	readonly workspacePath: string;
	/** 本次会话的授权范围（必填）：读取工作区文件前先判定（R28-4）。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	readonly entries: readonly EvidenceVerificationEntry[];
	readonly signal?: AbortSignal;
	readonly limits?: Partial<ProjectServiceLimits>;
};

export type VerifyEvidenceResult = {
	readonly checks: readonly EvidenceCheck[];
	/** 因预算/超限未复验的条数（> 0 时必须如实报告，不能当成"全部有效"）。 */
	readonly uncheckedCount: number;
	readonly truncated: boolean;
	/**
	 * 按**文件预算**计费并通过的条数。
	 *
	 * 同一个相对路径被多条证据引用时磁盘只读一次（内容相同，重复读没有信息量），
	 * 但每一条都占一次预算：预算管的是"这次复验愿意处理多少条证据"，
	 * 不是"磁盘被打开几次"。因此这里的值 = 通过预算的条数。
	 */
	readonly budgetedEntries: number;
	/** 真正打开并读取文件的次数（≤ budgetedEntries；命中缓存时更少）。 */
	readonly fileReads: number;
	readonly uncheckedReasons: readonly EvidenceUncheckedReason[];
};

function sha256(bytes: Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 按工作区 + 相对路径重新读取并比较内容 hash，结果**按调用方的分组键返回**。
 *
 * 只有"有相对路径 + 内容 hash 的 source-file 证据"可以复验；
 * `commit` 类证据没有可比较的字节，一律 `not-verifiable`（不猜、不当作有效）。
 * 两类预算独立：`maxEvidenceFiles`（真读文件）与 `maxEvidenceEntries`（检查条目，含不可复验的声明）。
 */
export async function verifyEvidenceRefs(input: VerifyEvidenceInput): Promise<VerifyEvidenceResult> {
	const workspacePath = optionalAbsolutePath(input.workspacePath, "工作区路径");
	if (workspacePath === undefined) throw invalidArgument("必须显式指定工作区路径");
	if (!Array.isArray(input.entries)) throw invalidArgument("entries 必须是数组");
	const limits = resolveProjectLimits(input.limits);
	assertWorkspaceAuthorized({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, workspacePath, context: "证据复验" });
	assertNotCancelled(input.signal, "证据复验已取消");

	let workspaceReal: string;
	try {
		workspaceReal = await realpath(workspacePath);
	} catch {
		throw new ProjectServiceError("not-found", `工作区目录不可访问：${workspacePath}`, { detail: "workspace-unavailable" });
	}
	assertNotCancelled(input.signal, "证据复验已取消");

	const checks: EvidenceCheck[] = [];
	const uncheckedReasons: EvidenceUncheckedReason[] = [];
	let uncheckedCount = 0;
	let budgetedEntries = 0;
	let fileReads = 0;
	/**
	 * 同一路径只读一次（省文件预算），但缓存的是**观察到的事实**而不是判定结果：
	 * 不同字段用同一文件、但期望 hash 不同时，各自的 valid/changed 必须各自算（R28-2）。
	 */
	const readCache = new Map<string, { readonly actualHash: string | null; readonly failure: { status: EvidenceCheckStatus; detail: string } | null; readonly bytes: number }>();

	const markUnchecked = (reason: EvidenceUncheckedReason): void => {
		uncheckedCount += 1;
		if (!uncheckedReasons.includes(reason)) uncheckedReasons.push(reason);
	};

	for (const entry of input.entries) {
		assertNotCancelled(input.signal, "证据复验已取消");
		const evidence = entry.evidence;
		const relativePath = evidence.relativePath === undefined ? null : evidence.relativePath;
		// 条目上限先于任何分类：不可复验的声明同样要有界（20 条 human-note 不能没有上限）。
		// 命中后**不再产出检查条目**（否则"输出"本身没有上限），只计数并给出原因。
		if (checks.length >= limits.maxEvidenceEntries) {
			markUnchecked("entry-budget");
			continue;
		}

		if (relativePath === null || evidence.contentHash === undefined || evidence.contentHash === null || evidence.contentHash.trim() === "") {
			checks.push({ key: entry.key, relativePath, status: "not-verifiable", expectedHash: evidence.contentHash ?? null, actualHash: null, detail: evidence.type === "commit" ? "commit 证据没有可比较的文件字节" : "缺少相对路径或内容 hash，无法按字节复验" });
			continue;
		}

		let safe: string;
		try {
			safe = assertSafeRelativePath(relativePath);
		} catch {
			checks.push({ key: entry.key, relativePath, status: "not-verifiable", expectedHash: evidence.contentHash, actualHash: null, detail: "相对路径形态非法（绝对路径或含 ..），拒绝读取" });
			continue;
		}

		// 文件预算按**条数**计费（先于缓存与 IO）：预算管的是这次复验愿意处理多少条证据。
		if (budgetedEntries >= limits.maxEvidenceFiles) {
			markUnchecked("file-budget");
			checks.push({ key: entry.key, relativePath: safe, status: "not-checked", expectedHash: evidence.contentHash, actualHash: null, detail: `已达到文件预算 ${limits.maxEvidenceFiles}，未读取` });
			continue;
		}
		budgetedEntries += 1;

		const cached = readCache.get(safe);
		if (cached !== undefined) {
			if (cached.failure !== null) {
				if (cached.failure.status === "not-checked") markUnchecked("file-too-large");
				checks.push({ key: entry.key, relativePath: safe, status: cached.failure.status, expectedHash: evidence.contentHash, actualHash: null, detail: cached.failure.detail });
				continue;
			}
			// 判定按**本条证据自己的期望 hash** 计算，不套用别人算出来的结论。
			const status: EvidenceCheckStatus = cached.actualHash === evidence.contentHash ? "valid" : "changed";
			checks.push({ key: entry.key, relativePath: safe, status, expectedHash: evidence.contentHash, actualHash: cached.actualHash, detail: status === "valid" ? `内容 hash 与采集时一致（${cached.bytes} 字节）` : `内容 hash 已变化（${cached.bytes} 字节）` });
			continue;
		}

		const absolute = join(workspaceReal, ...safe.split("/"));
		let resolved: string;
		try {
			resolved = await realpath(absolute);
		} catch (error) {
			assertNotCancelled(input.signal, "证据复验已取消");
			const missing = fsCode(error) === "ENOENT";
			checks.push({ key: entry.key, relativePath: safe, status: missing ? "missing" : "unreadable", expectedHash: evidence.contentHash, actualHash: null, detail: missing ? "文件当前不存在" : `读取失败（${fsCode(error) || "unknown"}）` });
			continue;
		}
		assertNotCancelled(input.signal, "证据复验已取消");
		if (!isWithinAuthorizedRoot(workspaceReal, resolved)) {
			checks.push({ key: entry.key, relativePath: safe, status: "not-verifiable", expectedHash: evidence.contentHash, actualHash: null, detail: "真实路径落在工作区之外，拒绝读取" });
			continue;
		}

		let stats: Awaited<ReturnType<typeof stat>>;
		try {
			stats = await stat(resolved);
		} catch (error) {
			assertNotCancelled(input.signal, "证据复验已取消");
			const missing = fsCode(error) === "ENOENT";
			checks.push({ key: entry.key, relativePath: safe, status: missing ? "missing" : "unreadable", expectedHash: evidence.contentHash, actualHash: null, detail: missing ? "文件当前不存在" : `读取失败（${fsCode(error) || "unknown"}）` });
			continue;
		}
		assertNotCancelled(input.signal, "证据复验已取消");
		if (!stats.isFile()) {
			checks.push({ key: entry.key, relativePath: safe, status: "missing", expectedHash: evidence.contentHash, actualHash: null, detail: "路径当前不是常规文件" });
			continue;
		}

		// 预算的**实际**执行点是这里：即使 stat 报的很小、文件随后长大，也不会越额读入。
		const bounded = await readFileBounded(resolved, limits.maxEvidenceFileBytes, input.signal, "证据复验已取消");
		fileReads += 1;
		if (!bounded.ok) {
			const detail = bounded.code === "too-large" ? `${bounded.detail}，未比较` : bounded.detail;
			const status: EvidenceCheckStatus = bounded.code === "too-large" ? "not-checked" : "unreadable";
			if (status === "not-checked") markUnchecked("file-too-large");
			readCache.set(safe, { actualHash: null, failure: { status, detail }, bytes: 0 });
			checks.push({ key: entry.key, relativePath: safe, status, expectedHash: evidence.contentHash, actualHash: null, detail });
			continue;
		}
		const actual = sha256(bounded.bytes);
		const status: EvidenceCheckStatus = actual === evidence.contentHash ? "valid" : "changed";
		const detail = status === "valid" ? `内容 hash 与采集时一致（${bounded.bytes.byteLength} 字节）` : `内容 hash 已变化（${bounded.bytes.byteLength} 字节）`;
		readCache.set(safe, { actualHash: actual, failure: null, bytes: bounded.bytes.byteLength });
		checks.push({ key: entry.key, relativePath: safe, status, expectedHash: evidence.contentHash, actualHash: actual, detail });
	}

	return { checks, uncheckedCount, truncated: uncheckedCount > 0, budgetedEntries, fileReads, uncheckedReasons };
}

/** 证据复验后的结论汇总（供消费视图使用，不改档案）。 */
export function summarizeEvidenceChecks(result: VerifyEvidenceResult): { readonly worst: EvidenceCheckStatus; readonly changedCount: number; readonly missingCount: number; readonly uncheckedCount: number; readonly blocked: boolean } {
	const changedCount = result.checks.filter((check) => check.status === "changed").length;
	const missingCount = result.checks.filter((check) => check.status === "missing" || check.status === "unreadable").length;
	const worst: EvidenceCheckStatus = result.checks.some((check) => check.status === "changed")
		? "changed"
		: result.checks.some((check) => check.status === "missing")
			? "missing"
			: result.checks.some((check) => check.status === "unreadable")
				? "unreadable"
				: result.checks.some((check) => check.status === "not-checked")
					? "not-checked"
					: result.checks.some((check) => check.status === "not-verifiable")
						? "not-verifiable"
						: "valid";
	return { worst, changedCount, missingCount, uncheckedCount: result.uncheckedCount, blocked: result.truncated };
}

/** 按分组键取回某个事实自己的检查结果（字段之间不串用）。 */
export function checksForKey(checks: readonly EvidenceCheck[], key: string): EvidenceCheck[] {
	return checks.filter((check) => check.key === key);
}
