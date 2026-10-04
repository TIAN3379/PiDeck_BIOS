/**
 * 写入管线与 journal 的**接线层**（BM-02C1）。
 *
 * 为什么单独成文件：`write.ts` 的职责是"三类入口 + 校验 + 持锁提交"，journal 接线是
 * "意图 → 数据 → 终态"的另一套时序与错误语义。两者混在一起会让那个文件同时承担
 * 两种提交语义，也把行数推过 600 的红线。
 *
 * 这里的每条规则都直接对应 bm02c1_development_plan.md §2.2：
 * 1. **数据提交点是 `commit()` 成功返回**，不是终态写成功；
 * 2. 提交前失败/取消：保留原错误，尽力记 `aborted`，写不进去就留 `prepared` + 有界诊断；
 * 3. 成功结果带 `journal`，让调用方知道要不要去核对。
 */
import type { StorageBoundary } from "../boundary.ts";
import { attachCleanupNote, CLEANUP_FAILED_NOTE } from "../commit.ts";
import { isStorageErrorCode } from "../errors.ts";
import type { LockReleaseOutcome, StorageLockHandle } from "../lock.ts";
import type { JournalFingerprint, WriteJournalOutcome } from "./contract.ts";
import { finalizeJournalEntry, type PreparedJournal } from "./writer.ts";

/** 锁未正常释放的**固定、有界**文案（成功路径进 warnings，失败路径附到原错误上，两者共用）。 */
export function lockReleaseNote(outcome: LockReleaseOutcome): string {
	return `本次写入的锁未正常释放（${outcome}）；锁目录可能残留，后续写入可能因此等待超时，需要人工确认`;
}

/**
 * 释放本次调用自己拿到的锁，并把结果收敛成可上报的枚举。
 *
 * **忽略取消**是刻意的：锁没有回收器，一次"用户取消了写入"若导致不释放，
 * 这个目标此后所有写者都会超时。`release()` 内部读取元数据走 `readJsonForCleanup`
 * （不受 signal 影响），这里的 catch 只是把"释放抛错"变成 `failed` 而不是继续传播——
 * 释放结果要以**数据**形态交给调用方决定怎么上报，而不是变成新的异常。
 */
export async function releaseOwnLock(lock: StorageLockHandle): Promise<LockReleaseOutcome> {
	return lock.release().catch((): LockReleaseOutcome => "failed");
}

/** 数据已提交但 journal 终态未写入时的固定文案（含 operationId，便于直接核对）。 */
export function needsRecoveryNote(operationId: string, reason: string): string {
	return `本次写入已提交（提交点已过），但 journal 终态未写入（${reason}）；operationId=${operationId}，请用 reconcileJournalOperation 核对后收口，不要重复提交同一 revision`;
}

/**
 * 数据未提交时的**尽力**记账：写 `aborted`，失败就保留 `prepared` 并返回一句有界诊断。
 *
 * 为什么"尽力"而不是"必须"：写终态本身要 IO，而此刻我们正在传播首个错误（可能是取消）。
 * 用一次记账失败去覆盖真实的失败原因，比留下一条 `prepared` 更糟——后者本来就是
 * `inspectPendingJournal` / `reconcileJournalOperation` 存在的理由。
 */
export async function recordAbortedBestEffort(boundary: StorageBoundary, prepared: PreparedJournal, now: number, signal: AbortSignal | undefined): Promise<string | null> {
	const finalized = await finalizeJournalEntry(boundary, prepared, { state: "aborted", source: "writer-confirmed", now: Math.max(now, prepared.record.preparedAt), signal });
	if (finalized.ok) return null;
	const reason = isStorageErrorCode(finalized.error, "cancelled") ? "已取消" : "写入失败";
	return `journal 终态未写入（${reason}，原错误优先）；本次留下 prepared 记录 ${prepared.relativePath}，可用 inspectPendingJournal / reconcileJournalOperation 核对后收口`;
}

export type JournaledCommit = {
	bytes: number;
	cleanup: "ok" | "failed";
	journal: WriteJournalOutcome;
	/** 提交已成立但有遗留时的有界诊断（journal 清理失败 / 终态未写入）。 */
	journalWarnings?: readonly string[];
};

/**
 * 「prepared 意图 → 数据提交 → 终态记账」的唯一顺序（BM-02C1 §2.3）。
 *
 * 三条语义必须同时成立，任何重构都不能破坏：
 * 1. **数据提交点是 `commit()` 成功返回**，不是终态写成功；终态失败**绝不**把结果改成"未提交"；
 * 2. 提交前失败/取消：保留原错误，尽力记 `aborted`（写不进去就留 `prepared` + 有界诊断）；
 * 3. 成功结果带 `journal`，调用方据此知道要不要去核对。
 */
export async function commitUnderJournal(boundary: StorageBoundary, prepared: PreparedJournal, options: { signal?: AbortSignal; now: number }, commit: () => Promise<{ bytes: number; cleanup: "ok" | "failed"; fingerprint: string }>): Promise<JournaledCommit> {
	let committed: { bytes: number; cleanup: "ok" | "failed"; fingerprint: string };
	try {
		committed = await commit();
	} catch (error) {
		const note = await recordAbortedBestEffort(boundary, prepared, options.now, options.signal);
		throw note === null ? error : attachCleanupNote(error, note);
	}

	// 提交点已过：终态记账用**实际提交返回的** fingerprint（真相优先于 prepared 里的预测值）。
	const after: JournalFingerprint = { revision: prepared.record.after.revision, hash: committed.fingerprint };
	const finalized = await finalizeJournalEntry(boundary, prepared, { state: "committed", source: "writer-confirmed", now: Math.max(options.now, prepared.record.preparedAt), after, signal: options.signal });

	const journalWarnings: string[] = [];
	if (prepared.cleanup === "failed") journalWarnings.push(CLEANUP_FAILED_NOTE);
	if (!finalized.ok) {
		const reason = isStorageErrorCode(finalized.error, "cancelled") ? "已取消" : "写入失败";
		journalWarnings.push(needsRecoveryNote(prepared.operationId, reason));
	} else if (finalized.cleanup === "failed") {
		journalWarnings.push(CLEANUP_FAILED_NOTE);
	}

	return {
		bytes: committed.bytes,
		cleanup: committed.cleanup,
		journal: {
			operationId: prepared.operationId,
			state: finalized.ok ? "committed" : "needs-recovery",
			relativePath: prepared.relativePath,
		},
		...(journalWarnings.length > 0 ? { journalWarnings } : {}),
	};
}
