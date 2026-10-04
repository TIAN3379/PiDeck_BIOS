/**
 * journal 的**持锁核对与收口**（BM-02C1 §2.3 / §3.2）。
 *
 * 这是 C1 里唯一允许修改 journal 终态的入口，因此它的第一条规则是：
 * **只有对同一个受控目标取到"写入方用的那把协作锁"并重新读取之后，才允许下结论。**
 * 只读 `inspect` 的观察**不是**提交归属的证明，也不能据此改任何文件。
 *
 * 保守原则（宁可报"无法判定"也不猜）：
 * - 目标与 `after` 完全一致 → 记 `committed`（`recovery-observed`），**不写目标、不递增 revision**；
 * - 目标与 `before` 完全一致 → 记 `aborted`（未提交），**不自动完成旧操作**；
 * - 与前后都不一致 / revision 更高 / 同 revision 不同 hash → 记 `conflict`，交人工核对；
 * - 目标缺失但 `before` 指向"存在过" → `conflict`（可能被删/被移动，不能谎称未提交）；
 * - 目标坏 JSON / 未知版本 / 非文件 / 链接 / 超限 / 不可读 → `unreadable`：保留证据，不改 journal、不清目标；
 * - 已有终态 → 幂等返回，**不碰业务目标**；
 * - 目标锁被他人持有（超时）→ `busy`：不改文件、不删锁、**不按 PID/mtime/年龄抢占**。
 */
import { join } from "node:path";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { attachCleanupNote, CLEANUP_FAILED_NOTE } from "../commit.ts";
import { isCancelledError, isStorageError, StorageError } from "../errors.ts";
import type { StorageLimits } from "../limits.ts";
import { acquireStorageLock, type LockReleaseOutcome } from "../lock.ts";
import { interpretRecord } from "../records.ts";
import { interpretRegistryValue, knowledgeLayout } from "../registry.ts";
import { ABSENT_JOURNAL_FINGERPRINT, describeJournalFingerprint, fingerprintsEqual, isJournalOperationId, isTerminalJournalState, journalFileName, journalRelativePath, journalTargetKey, journalTargetSegments, type JournalFingerprint, type JournalState, type JournalTarget } from "./contract.ts";
import { journalProblemFromError, readJournalEntry } from "./inspect.ts";
import { finalizeJournalEntry, type PreparedJournal } from "./writer.ts";

/** 终态来源标识：恢复观察（绝不冒充 `writer-confirmed`）。 */
const RECOVERY_SOURCE = "recovery-observed" as const;

/** 锁没删掉时的固定诊断（结论仍然有效，但必须让人看到残留锁）。 */
const LOCK_RELEASE_FAILED_NOTE = "核对使用的锁未正常释放；锁目录可能残留，人工确认后再处理后续写入";

export type ReconcileOutcome = "committed" | "aborted" | "conflict" | "unreadable" | "busy";

export type ReconcileJournalOptions = {
	root: string;
	operationId: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试）。 */
	ioHooks?: StorageIoHooks;
	/** 可注入时钟（测试用）。 */
	now?: number;
	/** 等待目标锁的上限，默认与写入路径一致。 */
	lockTimeoutMs?: number;
	lockPollMs?: number;
};

export type ReconcileJournalResult = {
	readonly operationId: string;
	readonly relativePath: string;
	readonly outcome: ReconcileOutcome;
	/** 收口后读到的状态；`busy`/`unreadable` 时为读到的状态或 `null`。 */
	readonly journalState: JournalState | null;
	/** 持锁复读到的目标指纹；`busy`/`unreadable` 时为 `null`。 */
	readonly observed: JournalFingerprint | null;
	readonly target: JournalTarget | null;
	/** 本次是否写入了 journal 终态（幂等返回时为 false）。 */
	readonly changed: boolean;
	readonly warnings?: readonly string[];
	/** 受控说明（不含任何正文）。 */
	readonly detail?: string;
};

function outcomeForState(state: JournalState): ReconcileOutcome {
	if (state === "committed") return "committed";
	if (state === "aborted") return "aborted";
	if (state === "conflict") return "conflict";
	return "unreadable";
}

function targetMaxBytesFor(boundary: StorageBoundary, target: JournalTarget): number {
	return target.kind === "registry" ? boundary.limits.maxRegistryBytes : boundary.limits.maxRecordBytes;
}

/**
 * 目标当前指纹：`{null,null}` = 不存在（用 `ABSENT_JOURNAL_FINGERPRINT`，与契约同一份定义）。
 *
 * **校验与哈希必须来自同一次有界读取**（BM-02C1R / J2）：`revision`、结构/版本/身份/归属
 * 与真实字节 SHA-256 全部取自同一次 `readJson` 的结果。先验证一份、再读一份算哈希，
 * 会在两者之间留出"校验的是 A、记进哈希的是 B"的窗口。
 *
 * 解释规则与读取路径**同源**：记录复用 `interpretRecord`，registry 复用 `interpretRegistryValue`。
 * 只读 `revision` 是不够的——`schemaVersion: 999`、结构残缺、路径 ID 与内容 ID 不符、
 * 归属不符都会被洗成一次"合法但不同的一版"（`conflict`），把坏数据当成正常判定。
 * 因此这类目标一律抛错 → 调用方报 `unreadable` 并保留原字节。
 */
async function readTargetFingerprint(boundary: StorageBoundary, target: JournalTarget, absolutePath: string, maxBytes: number, signal: AbortSignal | undefined): Promise<JournalFingerprint> {
	let value: unknown;
	let fingerprint: string;
	try {
		({ value, fingerprint } = await boundary.readJson(absolutePath, maxBytes, signal));
	} catch (error) {
		if (isCancelledError(error)) throw error;
		if (isStorageError(error) && error.code === "not-found") return ABSENT_JOURNAL_FINGERPRINT;
		throw error;
	}

	if (target.kind === "registry") {
		const interpreted = interpretRegistryValue(value);
		if (!interpreted.ok) {
			throw new StorageError(interpreted.code, `目标 registry 无法解释：${interpreted.message}`, { path: absolutePath, detail: "invalid-target" });
		}
	} else {
		const interpreted = interpretRecord(target.kind, value, { id: target.id, ...(target.projectId === undefined ? {} : { projectId: target.projectId }) });
		if (!interpreted.ok) {
			throw new StorageError(interpreted.problem.code, `目标记录无法解释：${interpreted.problem.message}`, { path: absolutePath, detail: "invalid-target" });
		}
	}

	const revision = (value as { revision?: unknown } | null)?.revision;
	if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
		// 上面的解释链已经保证 revision 可用；这里再确认一次，是为了让 fingerprint 的类型边界
		// 在**本函数内**闭合，而不是依赖调用方对校验器的假设。
		throw new StorageError("invalid-record", `目标存在但 revision 不可解释：${absolutePath}`, { path: absolutePath, detail: "unreadable-target-revision" });
	}
	return { revision, hash: fingerprint };
}

/**
 * 核对并收口一个 prepared journal。
 *
 * 输入校验：`operationId` 必须是规范 UUID——路径由它派生，不接受调用方给文件名。
 * journal 不存在时抛 `not-found`（"你问的操作不在"是确定事实，不应伪装成 busy/unreadable）。
 */
export async function reconcileJournalOperation(options: ReconcileJournalOptions): Promise<ReconcileJournalResult> {
	if (!isJournalOperationId(options.operationId)) {
		throw new StorageError("invalid-record", `operationId 必须是规范的小写 UUID：${String(options.operationId)}`, { detail: "invalid-operation-id" });
	}
	const relativePath = journalRelativePath(options.operationId);
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const layout = knowledgeLayout(boundary);
	const absolutePath = join(layout.journalDir, journalFileName(options.operationId));
	const now = options.now ?? Date.now();

	const read = await readJournalEntry(boundary, absolutePath, { maxBytes: boundary.limits.maxJournalBytes, signal: options.signal });
	if (!read.ok) {
		if (read.missing) throw new StorageError("not-found", `journal 不存在：${relativePath}`, { path: relativePath });
		// 读不懂：当作"需要人看"，但不抛错（调用方通常在一次巡检后逐条处理）。
		return { operationId: options.operationId, relativePath, outcome: "unreadable", journalState: null, observed: null, target: null, changed: false, detail: read.message };
	}
	if (isTerminalJournalState(read.record.state)) {
		// 幂等：已有终态的操作重复核对时**不碰业务目标**，也不重写 journal。
		return { operationId: read.record.operationId, relativePath, outcome: outcomeForState(read.record.state), journalState: read.record.state, observed: null, target: read.record.target, changed: false };
	}

	const target = read.record.target;
	const targetPath = boundary.resolve(...journalTargetSegments(target));
	const targetMaxBytes = targetMaxBytesFor(boundary, target);

	// 取"写入方用的那把锁"：这是唯一能让观察变成结论的凭据。
	const lock = await acquireStorageLock(boundary, { target: targetPath, timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, signal: options.signal, now }).catch((error: unknown) => {
		if (isCancelledError(error)) throw error;
		if (isStorageError(error) && error.code === "lock-timeout") return null;
		throw error;
	});
	if (lock === null) {
		return {
			operationId: options.operationId,
			relativePath,
			outcome: "busy",
			journalState: read.record.state,
			observed: null,
			target,
			changed: false,
			detail: "目标锁被他人持有（或归属无法证明），不抢占、不修改任何文件；请人工确认后再核对",
		};
	}

	let result: ReconcileJournalResult | undefined;
	let failure: unknown;
	let lockRelease: LockReleaseOutcome = "released";
	try {
		result = await reconcileUnderLock(boundary, {
			operationId: options.operationId,
			relativePath,
			absolutePath,
			target,
			targetKey: journalTargetKey(target),
			targetPath,
			targetMaxBytes,
			prepared: read.record,
			now,
			signal: options.signal,
		});
	} catch (error) {
		failure = error;
	} finally {
		// 释放忽略取消（锁没有回收器）；释放结果如实附加到结论上，绝不吞掉。
		lockRelease = await lock.release().catch((): LockReleaseOutcome => "failed");
	}

	if (failure !== undefined) {
		// **首错优先**（BM-02C1R / J3）：清理失败只作为附加诊断。原来的 `throw failure` 会丢掉
		// "锁没删掉"这个事实——调用方只看到 cancelled，磁盘上却多了一把残留锁，
		// 下一次写入会以"莫名等待超时"的形式重新暴露它。
		throw lockRelease === "released" ? failure : attachCleanupNote(failure, LOCK_RELEASE_FAILED_NOTE);
	}
	if (result === undefined) throw new StorageError("invalid-record", "核对流程未产生结论（内部不一致）", { path: relativePath });
	if (lockRelease !== "released") {
		return { ...result, warnings: [...(result.warnings ?? []), LOCK_RELEASE_FAILED_NOTE] };
	}
	return result;
}

type UnderLockInput = {
	operationId: string;
	relativePath: string;
	absolutePath: string;
	target: JournalTarget;
	/** 持锁目标的受控身份（`journalTargetKey`），用于与持锁复读到的目标比对。 */
	targetKey: string;
	targetPath: string;
	targetMaxBytes: number;
	prepared: PreparedJournal["record"];
	now: number;
	signal?: AbortSignal;
};

/** 持锁阶段：复读 journal → 复读目标 → 判定 → 收口。任何异常都由调用方在释放锁后重抛。 */
async function reconcileUnderLock(boundary: StorageBoundary, input: UnderLockInput): Promise<ReconcileJournalResult> {
	const base = { operationId: input.operationId, relativePath: input.relativePath, target: input.target };

	// 持锁后**重新读取** journal：另一个恢复者可能已经收口，此时必须幂等返回。
	const reread = await readJournalEntry(boundary, input.absolutePath, { maxBytes: boundary.limits.maxJournalBytes, signal: input.signal });
	if (!reread.ok) {
		return { ...base, outcome: "unreadable", journalState: null, observed: null, changed: false, detail: `持锁期间 journal 变为不可读：${reread.message}` };
	}
	if (isTerminalJournalState(reread.record.state)) {
		return { ...base, outcome: outcomeForState(reread.record.state), journalState: reread.record.state, observed: null, changed: false };
	}

	// 持锁复读到的目标必须与**锁的对象**一致（BM-02C1R / J1）：journal 是根内可被外部改写的文件，
	// 在"读 journal"与"创建锁目录"之间存在窗口。若此刻目标已经换成别处，继续下结论等于
	// "拿 A 的锁给 B 记账"——结论是假的，而且 B 没有得到任何保护。
	// 这里不做"追着新目标重新加锁"（那会变成跨目标无界追逐），直接保守报无法判定。
	const rereadKey = journalTargetKey(reread.record.target);
	if (rereadKey !== input.targetKey) {
		return {
			operationId: input.operationId,
			relativePath: input.relativePath,
			// 如实报告 journal 现在说的目标，但**不冒充观测过它**：observed 必须为 null。
			target: reread.record.target,
			outcome: "unreadable",
			journalState: reread.record.state,
			observed: null,
			changed: false,
			detail: `持锁期间 journal 的受控目标发生变化（锁=${input.targetKey}，journal=${rereadKey}）；未修改 journal 与目标，请人工确认后再核对`,
		};
	}

	let observed: JournalFingerprint;
	try {
		observed = await readTargetFingerprint(boundary, input.target, input.targetPath, input.targetMaxBytes, input.signal);
	} catch (error) {
		if (isCancelledError(error)) throw error;
		// 目标坏 JSON / 未知版本 / 结构或归属非法 / 链接 / 非文件 / 超限 / 权限：
		// 一律"无法判定"，保留证据不动手（BM-02C1R / J2）。
		const detail = isStorageError(error) ? `${error.code}${error.detail ? `（${error.detail}）` : ""}` : journalProblemFromError(error).message;
		return { ...base, outcome: "unreadable", journalState: reread.record.state, observed: null, changed: false, detail: `目标不可判定（${detail}）；已保留证据，未修改 journal 与目标` };
	}

	const matchesAfter = fingerprintsEqual(observed, reread.record.after);
	const matchesBefore = fingerprintsEqual(observed, reread.record.before);
	const state: Exclude<JournalState, "prepared"> = matchesAfter ? "committed" : matchesBefore ? "aborted" : "conflict";
	const detail = matchesAfter
		? `目标与 after（${describeJournalFingerprint(reread.record.after)}）一致：视为已提交，不写目标、不递增 revision`
		: matchesBefore
			? `目标与 before（${describeJournalFingerprint(reread.record.before)}）一致：视为未提交，不自动完成旧操作`
			: `目标既不是 before（${describeJournalFingerprint(reread.record.before)}）也不是 after（${describeJournalFingerprint(reread.record.after)}），需人工核对`;

	// 钟可能被注入得更早：终态时间不得早于 preparedAt（契约要求），因此取两者较大值。
	const finishedAt = Math.max(input.now, reread.record.preparedAt);
	const prepared: PreparedJournal = { operationId: reread.record.operationId, path: input.absolutePath, relativePath: input.relativePath, record: reread.record, cleanup: "ok" };
	const finalized = await finalizeJournalEntry(boundary, prepared, { state, source: RECOVERY_SOURCE, now: finishedAt, signal: input.signal });
	if (!finalized.ok) {
		// 收口失败：不谎称已收口。目标未被触碰，下次核对会得到同一结论（幂等）。
		const code = isStorageError(finalized.error) ? finalized.error.code : "未知错误";
		const warnings = [`journal 终态写入失败（${code}）；本次未修改目标，journal 仍是 prepared，可稍后重试核对`];
		// 终态写入自身可能已经带上"临时文件清理失败"的有界诊断（`replaceJson` 的行为）。
		// 这条不能丢：残留 `.tmp` 与"终态没写成功"是两件都要人看的事（BM-02C1R / J3）。
		if (isStorageError(finalized.error) && finalized.error.message.includes(CLEANUP_FAILED_NOTE)) warnings.push(CLEANUP_FAILED_NOTE);
		return {
			...base,
			outcome: outcomeForState(reread.record.state),
			journalState: reread.record.state,
			observed,
			changed: false,
			warnings,
			detail,
		};
	}

	// 收口成功但临时文件没删掉：结果仍然成立，只是有残留要如实说（BM-02C1R / J3）。
	const committedWarnings = finalized.cleanup === "failed" ? [CLEANUP_FAILED_NOTE] : [];
	return { ...base, outcome: outcomeForState(state), journalState: state, observed, changed: true, detail, ...(committedWarnings.length > 0 ? { warnings: committedWarnings } : {}) };
}
