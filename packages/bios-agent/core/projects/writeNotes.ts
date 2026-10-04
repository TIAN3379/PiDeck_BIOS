/**
 * 领域写入结果的**事实汇总**（R28-1）。
 *
 * 存储层已经如实返回"提交成功但有遗留"的信号：`warnings`（临时文件/锁目录没清干净）、
 * `journal.state = needs-recovery`（数据已提交但终态没记账）、`lockRelease` 不等于 `released`。
 *
 * 领域层**不能**把这些丢掉：一旦丢了，调用方看到的是"干净的 bound / confirmed"，
 * 而磁盘上其实留着 prepared journal 或者没释放的锁。这里做的是**搬运**，
 * 不是新建事务/恢复框架——收口仍然走既有的 journal 巡检与 reconcile。
 */
import type { LockReleaseOutcome } from "../storage/index.ts";
import type { WriteJournalOutcome } from "../storage/journal/index.ts";

/** 一次写入的底层结果里与"事实完整性"有关的部分。 */
export type WriteOutcomeSource = {
	readonly cleanup: "ok" | "failed";
	readonly lockRelease: LockReleaseOutcome;
	readonly journal: WriteJournalOutcome;
	readonly warnings?: readonly string[];
};

export type WriteOutcomeNotes = {
	/** 有界的"提交成立但有遗留"诊断（透传存储层的 `warnings`，可能为空）。 */
	readonly warnings: readonly string[];
	/** 需要人工/巡检核对的原因：数据已落盘，但记账或清理没有完成。 */
	readonly needsReview: readonly string[];
	/** 本次写入的 journal 状态（`null` 表示这次调用没有产生 journal，例如只读路径）。 */
	readonly journalState: "committed" | "needs-recovery" | null;
	readonly operationId: string | null;
	readonly cleanup: "ok" | "failed" | null;
	readonly lockRelease: LockReleaseOutcome | null;
};

export const EMPTY_WRITE_NOTES: WriteOutcomeNotes = { warnings: [], needsReview: [], journalState: null, operationId: null, cleanup: null, lockRelease: null };

/**
 * 把一个存储层写入结果折叠成受控事实。
 *
 * `label` 只用于文案前缀（例如"registry 绑定"），不参与判定。
 */
export function collectWriteNotes(result: WriteOutcomeSource, label: string): WriteOutcomeNotes {
	const warnings = [...(result.warnings ?? [])];
	const needsReview: string[] = [];
	if (result.journal.state === "needs-recovery") {
		// 数据确实提交了，但 journal 终态没写成 ⇒ 不能报"干净成功"，也不能让调用方重试同一 revision。
		needsReview.push(`${label}：内容已提交（revision 已生效），但 journal 终态未写入（${result.journal.relativePath}）；请用既有巡检/核对收口，不要重复提交同一 revision。`);
	}
	if (result.cleanup === "failed" && !warnings.some((warning) => warning.includes("临时"))) {
		// 存储层通常已经把它放进 warnings；这里只兜底，避免"清理失败"两种来源口径不一。
		needsReview.push(`${label}：临时文件清理未完成，需要人工确认后清理。`);
	}
	if (result.lockRelease !== "released") {
		needsReview.push(`${label}：跨进程锁未正常释放（${result.lockRelease}），下一次写入可能等待超时。`);
	}
	return {
		warnings,
		needsReview,
		journalState: result.journal.state,
		operationId: result.journal.operationId,
		cleanup: result.cleanup,
		lockRelease: result.lockRelease,
	};
}

/** 合并多步写入的事实（顺序保留：先发生的先列出）。 */
export function mergeWriteNotes(notes: readonly WriteOutcomeNotes[]): WriteOutcomeNotes {
	const warnings: string[] = [];
	const needsReview: string[] = [];
	let journalState: WriteOutcomeNotes["journalState"] = null;
	let operationId: string | null = null;
	let cleanup: WriteOutcomeNotes["cleanup"] = null;
	let lockRelease: LockReleaseOutcome | null = null;
	for (const note of notes) {
		for (const warning of note.warnings) if (!warnings.includes(warning)) warnings.push(warning);
		for (const reason of note.needsReview) if (!needsReview.includes(reason)) needsReview.push(reason);
		if (note.journalState !== null) journalState = note.journalState;
		if (note.operationId !== null) operationId = note.operationId;
		if (note.cleanup !== null) cleanup = note.cleanup;
		if (note.lockRelease !== null) lockRelease = note.lockRelease;
	}
	return { warnings, needsReview, journalState, operationId, cleanup, lockRelease };
}
