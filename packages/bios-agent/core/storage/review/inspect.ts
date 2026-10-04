/**
 * 审核 journal 的**只读巡检**（BM-02C2B / C2B-3）。
 *
 * 只回答一个问题："有哪些审核操作还没有完成终态，以及 journal 目录里有哪些读不懂的东西。"
 * 它**不修改**任何文件：候选只是"值得用 `reconcileReviewOperation` 去看一眼"的操作，
 * 不是"可以据此下结论"的证据。
 *
 * 与 C1 巡检的分工：
 * - C1 的 `inspectPendingJournal` 只认识 v1，遇到 v2 报 `unsupported-journal-version`（现状即如此，
 *   这正是"旧恢复器拒绝 v2"的实现）；
 * - 本函数只把 **v2** 当审核候选，并把**合法 v1** 单独计数（`ordinaryJournalEntries`）——
 *   两类写入明确区分，绝不因为"读不懂"就降级。
 *
 * 有界：目录条目、候选条数、候选数组的真实 UTF-8 字节、问题条数分别计预算，
 * 并返回 `scanned`/`truncated`/`truncatedBy`；取消在扫描途中立即生效（不返回"看起来完整"的结果）。
 */
import { createStorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { isStorageError } from "../errors.ts";
import type { JournalProblemCode } from "../journal/inspect.ts";
import { journalFileNameToOperationId, journalRelativePath } from "../journal/index.ts";
import type { StorageLimits } from "../limits.ts";
import { knowledgeLayout } from "../registry.ts";
import { readReviewJournalArtifact, type ReviewJournalRead } from "./artifacts.ts";
import { isReviewJournalCandidateFile, readReviewJournalVersion, type ReviewJournalRecord, type ReviewJournalTarget } from "./contract.ts";

/** 一条 journal 最多贡献的诊断字符数（防止坏文件把上下文打满）。 */
const PROBLEM_MESSAGE_MAX_CHARS = 200;

export type ReviewProblemCode = JournalProblemCode | "invalid-v1-journal" | "review-journal-name-mismatch";

export type ReviewInspectProblem = {
	readonly code: ReviewProblemCode;
	readonly relativePath: string;
	readonly message: string;
};

/** 待核对（`prepared`）审核操作的有界摘要（不含理由/标签正文）。 */
export type PendingReviewEntry = {
	readonly operationId: string;
	readonly relativePath: string;
	readonly eventId: string;
	readonly target: ReviewJournalTarget;
	readonly intentName: string;
	readonly intentHash: string;
	readonly before: ReviewJournalRecord["before"];
	readonly after: ReviewJournalRecord["after"];
	readonly preparedAt: number;
};

export type InspectPendingReviewOptions = {
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试）。 */
	ioHooks?: StorageIoHooks;
};

export type InspectPendingReviewResult = {
	/** 实际尝试读取的 `.json` 条目数。 */
	readonly scanned: number;
	readonly truncated: boolean;
	/** 触达的预算维度：`scan` / `entries` / `bytes` / `problems`。 */
	readonly truncatedBy: readonly string[];
	readonly pending: readonly PendingReviewEntry[];
	readonly problems: readonly ReviewInspectProblem[];
	readonly droppedProblems: number;
	/** 非候选条目（`.tmp` 残留、非 `.json`）：跳过、不删除、不报错。 */
	readonly skippedEntries: number;
	/** 合法 **v1**（普通写）的条数：明确区分，不算问题也不算审核候选。 */
	readonly ordinaryJournalEntries: number;
	/** 已有终态的审核条数（观察统计，不代表本次修改过它们）。 */
	readonly finalized: { readonly committed: number; readonly aborted: number; readonly conflicted: number };
};

/** 候选数组的固定信封开销（`[]` 的 UTF-8 字节数）：0 预算连一条都放不进去。 */
const PENDING_ARRAY_ENVELOPE_BYTES = Buffer.byteLength("[]", "utf8");

/** 一条候选在 pending 数组里的**真实** UTF-8 字节数（不估算字段和）。 */
function measureEntryBytes(entry: PendingReviewEntry): number {
	return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/** 加上这一条候选后的数组字节数：分隔符只在"已有候选"时出现。 */
function arrayBytesWith(currentBytes: number, entryBytes: number, count: number): number {
	return currentBytes + entryBytes + (count > 0 ? 1 : 0);
}

/** 巡检能报告的问题码（读取层码 + 审核校验码）；未知码一律归到 `invalid-journal`。 */
const REPORTABLE_READ_CODES: ReadonlySet<string> = new Set(["invalid-json", "too-large", "symlink-rejected", "unreadable", "not-found", "permission-denied", "not-a-file", "unsupported-journal-version", "review-journal-name-mismatch"]);

/**
 * 把读取/校验失败映射成有界、脱敏的诊断（不含正文）。
 *
 * 刻意**保留读取层的真实原因**（坏 JSON / 超限 / 链接）：把它们统一说成"journal 非法"
 * 会让运维分不清"文件被改坏了"和"文件太大"，而这两种情况的处理方式完全不同。
 */
function problemFromRead(read: Exclude<ReviewJournalRead, { ok: true }>): ReviewInspectProblem {
	const code: ReviewProblemCode = read.kind === "unknown" ? "unsupported-journal-version" : REPORTABLE_READ_CODES.has(read.code) ? (read.code as ReviewProblemCode) : "invalid-journal";
	return { code, relativePath: "", message: read.message.slice(0, PROBLEM_MESSAGE_MAX_CHARS) };
}

export async function inspectPendingReviewOperations(options: InspectPendingReviewOptions): Promise<InspectPendingReviewResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const layout = knowledgeLayout(boundary);
	const limits = boundary.limits;

	const truncatedBy = new Set<string>();
	const pending: PendingReviewEntry[] = [];
	const problems: ReviewInspectProblem[] = [];
	const finalized = { committed: 0, aborted: 0, conflicted: 0 };
	let ordinaryJournalEntries = 0;
	let scanned = 0;
	let skippedEntries = 0;
	let droppedProblems = 0;
	let pendingBytes = PENDING_ARRAY_ENVELOPE_BYTES;

	let names: string[] = [];
	try {
		const listing = await boundary.listEntries(layout.journalDir, { filesOnly: true, maxEntries: limits.maxJournalScanEntries, includeSymlinks: true, signal: options.signal });
		names = listing.names;
		if (listing.truncated) truncatedBy.add("scan");
	} catch (error) {
		// journal 目录不存在 = 从没写过 journal（旧库）：空结果，不是错误。
		if (isStorageError(error) && error.code === "not-found") {
			return { scanned: 0, truncated: false, truncatedBy: [], pending: [], problems: [], droppedProblems: 0, skippedEntries: 0, ordinaryJournalEntries: 0, finalized };
		}
		throw error;
	}

	// 预算触顶时"跳过哪些"必须可复现，而不是依赖 readdir 顺序。
	names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

	const pushProblem = (problem: ReviewInspectProblem): void => {
		if (problems.length >= limits.maxJournalProblems) {
			droppedProblems += 1;
			truncatedBy.add("problems");
			return;
		}
		problems.push(problem);
	};

	for (const name of names) {
		if (!isReviewJournalCandidateFile(name)) {
			skippedEntries += 1;
			continue;
		}
		if (scanned >= limits.maxJournalScanEntries) {
			truncatedBy.add("scan");
			break;
		}
		scanned += 1;

		const operationId = journalFileNameToOperationId(name);
		const relativePath = journalRelativePath(operationId);
		const read = await readReviewJournalArtifact(boundary, operationId, options.signal);

		if (!read.ok) {
			// 合法 v1 单独计数（不是问题）；其余按读取结论分类保留原文件。
			if (read.kind === "v1") {
				ordinaryJournalEntries += 1;
				continue;
			}
			pushProblem({ ...problemFromRead(read), relativePath });
			continue;
		}

		const record = read.record;
		if (record.state !== "prepared") {
			if (record.state === "committed") finalized.committed += 1;
			else if (record.state === "aborted") finalized.aborted += 1;
			else finalized.conflicted += 1;
			continue;
		}

		const entry: PendingReviewEntry = {
			operationId: record.operationId,
			relativePath,
			eventId: record.eventId,
			target: record.target,
			intentName: record.intentName,
			intentHash: record.intentHash,
			before: record.before,
			after: record.after,
			preparedAt: record.preparedAt,
		};
		if (pending.length >= limits.maxJournalInspectEntries) {
			truncatedBy.add("entries");
			continue;
		}
		// 逐条计量：**不**先把候选攒齐再截断（否则预算就失去了"限制输出规模"的意义）。
		const nextBytes = arrayBytesWith(pendingBytes, measureEntryBytes(entry), pending.length);
		if (nextBytes > limits.maxJournalInspectBytes) {
			truncatedBy.add("bytes");
			continue;
		}
		pendingBytes = nextBytes;
		pending.push(entry);
	}

	return {
		scanned,
		truncated: truncatedBy.size > 0,
		truncatedBy: [...truncatedBy],
		pending,
		problems,
		droppedProblems,
		skippedEntries,
		ordinaryJournalEntries,
		finalized,
	};
}

/** 巡检结果是否有需要人看的东西（候选、问题或"问题被预算丢弃"）。 */
export function hasPendingReview(result: InspectPendingReviewResult): boolean {
	return result.pending.length > 0 || result.problems.length > 0 || result.droppedProblems > 0;
}

/** 供调用方判断"读到的版本号"，避免各处重复取字段。 */
export { readReviewJournalVersion };
