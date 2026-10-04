/**
 * journal 的**只读巡检**（BM-02C1 §2.3 / §3.1）。
 *
 * 只回答一个问题："有哪些写入意图还没有终态，以及 journal 目录里有哪些读不懂的东西。"
 *
 * 硬约束：
 * - **不修改** 目标 / journal / 锁，不清理任何文件（包括本目录里的 `.tmp` 残留）；
 * - 有界：目录条目、候选条数、输出字符、问题条数分别计预算，返回 `scanned`/`truncated`/`truncatedBy`；
 * - 坏文件、未来版本、ID 与文件名不符、超限、链接一律**保留原文件**并进入 `problems`；
 * - 取消在扫描途中立即生效（不返回"看起来完整"的结果）。
 */
import { basename, join } from "node:path";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { isCancelledError, isStorageError, StorageError } from "../errors.ts";
import type { StorageLimits } from "../limits.ts";
import { knowledgeLayout } from "../registry.ts";
import { isJournalCandidateFile, journalFileNameToOperationId, journalRelativePath, validateJournalRecord, type JournalFingerprint, type JournalIssueCode, type JournalOperation, type JournalRecord, type JournalTarget } from "./contract.ts";

/** 一条 journal 最多贡献的诊断字符数（防止坏文件把上下文打满）。 */
const PROBLEM_MESSAGE_MAX_CHARS = 200;

export type JournalProblemCode = "invalid-json" | "invalid-journal" | "unsupported-journal-version" | "journal-name-mismatch" | "symlink-rejected" | "too-large" | "unreadable";

export type JournalProblem = {
	readonly code: JournalProblemCode;
	/** 相对知识根的受控路径（POSIX 分隔符）。 */
	readonly relativePath: string;
	readonly message: string;
};

/** 待核对（`prepared`）候选的有界摘要。 */
export type PendingJournalEntry = {
	readonly operationId: string;
	readonly relativePath: string;
	readonly operation: JournalOperation;
	readonly target: JournalTarget;
	readonly before: JournalFingerprint;
	readonly after: JournalFingerprint;
	readonly preparedAt: number;
};

export type InspectPendingJournalOptions = {
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试）。 */
	ioHooks?: StorageIoHooks;
};

export type InspectPendingJournalResult = {
	/** 实际尝试读取的 `.json` 条目数。 */
	readonly scanned: number;
	readonly truncated: boolean;
	/** 触达的预算维度：`scan` / `entries` / `bytes` / `problems`。 */
	readonly truncatedBy: readonly string[];
	readonly pending: readonly PendingJournalEntry[];
	readonly problems: readonly JournalProblem[];
	/** 因问题预算被丢弃的问题数（如实计数，不静默）。 */
	readonly droppedProblems: number;
	/** 非候选条目（`.tmp` 残留、非 `.json`）：跳过、不删除、不报错。 */
	readonly skippedEntries: number;
	/** 已有终态的条数（观察统计，不代表本次修改过它们）。 */
	readonly finalized: { readonly committed: number; readonly aborted: number; readonly conflicted: number };
};

export type JournalReadResult = { ok: true; record: JournalRecord } | { ok: false; code: JournalProblemCode; message: string; missing: boolean };

/** 把读取/校验失败映射成有界、脱敏的诊断（不含记录正文）。 */
export function journalProblemFromError(error: unknown, maxChars = PROBLEM_MESSAGE_MAX_CHARS): { code: JournalProblemCode; message: string } {
	const message = (text: string): string => text.slice(0, maxChars);
	if (!isStorageError(error)) return { code: "unreadable", message: message(error instanceof Error ? error.message : String(error)) };

	switch (error.code) {
		case "invalid-json":
			return { code: "invalid-json", message: message("不是合法 JSON（已保留原文件）") };
		case "too-large":
			return { code: "too-large", message: message(`超过 journal 字节上限：${error.detail ?? ""}`) };
		case "symlink-rejected":
			return { code: "symlink-rejected", message: message("是链接，按策略不读取也不删除") };
		case "not-a-file":
		case "not-found":
		case "permission-denied":
			// 明确的"读不动"与"并发消失"都归入不可读：不猜、不改、继续扫下一条。
			return { code: "unreadable", message: message(`${error.code}：无法读取该 journal 条目`) };
		default:
			return { code: "unreadable", message: message(`${error.code}：无法解释该 journal 条目`) };
	}
}

function issueToProblemCode(issueCode: JournalIssueCode | undefined): JournalProblemCode {
	if (issueCode === "unsupported-journal-version") return "unsupported-journal-version";
	if (issueCode === "journal-name-mismatch") return "journal-name-mismatch";
	return "invalid-journal";
}

/**
 * 读取并校验一条 journal（inspect 与 reconcile 共用）。
 *
 * 取舍：读取用**有界读取**（`readJson`）而不是新增 `readFile`——
 * journal 是外部可放置的文件，不受限额的读取等于给"一个大文件"开了一条无界内存入口。
 */
export async function readJournalEntry(boundary: StorageBoundary, absolutePath: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<JournalReadResult> {
	const maxBytes = options.maxBytes ?? boundary.limits.maxJournalBytes;
	let value: unknown;
	try {
		({ value } = await boundary.readJson(absolutePath, maxBytes, options.signal));
	} catch (error) {
		// 取消必须穿透：巡检被取消时不能返回"看起来完整"的结果。
		if (isCancelledError(error)) throw error;
		// `missing` 单独暴露：巡检只把它当一条不可读条目，而 reconcile 必须能区分
		// "这条操作不存在"（确定事实，抛 not-found）与"存在但读不懂"（需要人看）。
		return { ok: false, ...journalProblemFromError(error), missing: isStorageError(error) && error.code === "not-found" };
	}

	const fileName = basename(absolutePath);
	const outcome = validateJournalRecord(value, fileName);
	if (outcome.ok) return { ok: true, record: outcome.value };
	const first = outcome.issues[0];
	return { ok: false, code: issueToProblemCode(first?.code), message: (first ? `${first.path || "/"} ${first.message}` : "不符合 journal 契约").slice(0, PROBLEM_MESSAGE_MAX_CHARS), missing: false };
}

/**
 * 候选数组的**固定信封开销**：`[]` 的 UTF-8 字节数。
 *
 * 它解释了"0 预算为什么不返回候选"：预算覆盖的是 pending 数组的序列化字节，
 * 空数组也要占 2 字节，所以 0 预算下连一条都放不进去（而不是"0 等于不限"）。
 */
const PENDING_ARRAY_ENVELOPE_BYTES = Buffer.byteLength("[]", "utf8");

/**
 * 一条候选在 pending 数组里的**真实 UTF-8 字节数**。
 *
 * 为什么不用"字段长度加起来估算"（BM-02C1R / J4）：估算漏算字段名、`before` 哈希、
 * 结构与逗号分隔符，会把一个 363 字节的数组报成"远低于 300 字节预算"，让可注入的小预算
 * 形同虚设。这里直接序列化同一条候选来计量——它与调用方最终 `JSON.stringify(result.pending)`
 * 看到的是同一份字节（同一对象、同一属性顺序）。
 */
function measureEntryBytes(entry: PendingJournalEntry): number {
	return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/** 加上这一条候选后 pending 数组的序列化字节数：分隔符只在"已有候选"时出现。 */
function arrayBytesWith(currentBytes: number, entryBytes: number, count: number): number {
	return currentBytes + entryBytes + (count > 0 ? 1 : 0);
}

export async function inspectPendingJournal(options: InspectPendingJournalOptions): Promise<InspectPendingJournalResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const layout = knowledgeLayout(boundary);
	const limits = boundary.limits;

	const truncatedBy = new Set<string>();
	const pending: PendingJournalEntry[] = [];
	const problems: JournalProblem[] = [];
	const finalized = { committed: 0, aborted: 0, conflicted: 0 };
	let scanned = 0;
	let skippedEntries = 0;
	let droppedProblems = 0;
	// 预算从"空数组 `[]`"开始计：这样 0 预算天然一条也放不进去。
	let pendingBytes = PENDING_ARRAY_ENVELOPE_BYTES;

	let names: string[] = [];
	try {
		const listing = await boundary.listEntries(layout.journalDir, { filesOnly: true, maxEntries: limits.maxJournalScanEntries, includeSymlinks: true, signal: options.signal });
		names = listing.names;
		if (listing.truncated) truncatedBy.add("scan");
	} catch (error) {
		// journal 目录不存在 = 从没写过 journal（旧库）：空结果，不是错误。
		if (isStorageError(error) && error.code === "not-found") {
			return { scanned: 0, truncated: false, truncatedBy: [], pending: [], problems: [], droppedProblems: 0, skippedEntries: 0, finalized };
		}
		throw error;
	}

	// 排序：预算触顶时"跳过哪些"必须可复现，而不是依赖 readdir 顺序。
	names.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

	const pushProblem = (problem: JournalProblem): void => {
		if (problems.length >= limits.maxJournalProblems) {
			droppedProblems += 1;
			truncatedBy.add("problems");
			return;
		}
		problems.push(problem);
	};

	for (const name of names) {
		if (!isJournalCandidateFile(name)) {
			skippedEntries += 1;
			continue;
		}
		// 扫描预算：`listEntries` 已按条目数截断，这里再守一次，避免"预算=0 仍读文件"。
		if (scanned >= limits.maxJournalScanEntries) {
			truncatedBy.add("scan");
			break;
		}
		scanned += 1;

		const operationId = journalFileNameToOperationId(name);
		const relativePath = journalRelativePath(operationId);
		const absolutePath = join(layout.journalDir, name);
		const read = await readJournalEntry(boundary, absolutePath, { maxBytes: limits.maxJournalBytes, signal: options.signal });
		if (!read.ok) {
			pushProblem({ code: read.code, relativePath, message: read.message });
			continue;
		}

		const record = read.record;
		if (record.state !== "prepared") {
			if (record.state === "committed") finalized.committed += 1;
			else if (record.state === "aborted") finalized.aborted += 1;
			else finalized.conflicted += 1;
			continue;
		}

		const entry: PendingJournalEntry = {
			operationId: record.operationId,
			relativePath,
			operation: record.operation,
			target: record.target,
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

	const truncated = truncatedBy.size > 0;
	return { scanned, truncated, truncatedBy: [...truncatedBy], pending, problems, droppedProblems, skippedEntries, finalized };
}

/** 巡检结果是否有需要人看的东西（候选、问题或"问题被预算丢弃"）。 */
export function hasPendingJournal(result: InspectPendingJournalResult): boolean {
	return result.pending.length > 0 || result.problems.length > 0 || result.droppedProblems > 0;
}

/** 便于上层构造 `relativePath`（与写入侧同源）。 */
export { journalRelativePath };

/** 便于上层把错误转成 `StorageError`（保留 code/detail 语义）。 */
export function asJournalNotFound(relativePath: string): StorageError {
	return new StorageError("not-found", `journal 不存在：${relativePath}`, { path: relativePath });
}
