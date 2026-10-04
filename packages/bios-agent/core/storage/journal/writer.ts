/**
 * journal 的**写入侧**：持久发布 prepared、写终态（BM-02C1）。
 *
 * 为什么单独一个模块：`write.ts` 已经承担"三类入口 + 有效库准入 + 持锁提交"，把
 * "journal 怎么写、写失败怎么记账"塞回去会让那条管线同时负责两套提交语义。
 * 这里只做两件事：把意图落盘、把终态替换上去。
 *
 * 关键约束：
 * - 走 boundary 的**低层提交原语**（完整临时文件 + `sync` + `close` + link/rename），
 *   **不**再调用 `createRecord`/`updateRecord`，否则一次业务写入会递归产生 journal；
 * - prepared 用 `link`（operationId 唯一 ⇒ 天然不覆盖，撞名即报错，绝不覆盖别人）；
 *   终态用 `rename`（替换"自己那一个文件"）；
 * - 写入前自检契约，避免把一个恢复侧无法解释的记录落盘。
 */
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { StorageBoundary } from "../boundary.ts";
import { StorageError } from "../errors.ts";
import { knowledgeLayout } from "../registry.ts";
import { assertJournalRecordValid, buildFinalJournalRecord, buildPreparedJournalRecord, journalFileName, journalRelativePath, type JournalFingerprint, type JournalOperation, type JournalRecord, type JournalSource, type JournalState, type JournalTarget } from "./contract.ts";

/** 已持久化的 prepared 记录句柄（终态写入只需要它 + 新状态）。 */
export type PreparedJournal = {
	operationId: string;
	/** journal 文件绝对路径（受控派生）。 */
	path: string;
	/** 相对知识根的受控路径（日志/结果用，POSIX 分隔符）。 */
	relativePath: string;
	record: JournalRecord;
	/** prepared 发布时临时文件的清理结果（`failed` 说明同目录有 `.tmp` 残留）。 */
	cleanup: "ok" | "failed";
};

export type PrepareJournalOptions = {
	operation: JournalOperation;
	target: JournalTarget;
	before: JournalFingerprint;
	after: JournalFingerprint;
	now: number;
	signal?: AbortSignal;
};

/**
 * 持久发布 prepared 意图。
 *
 * 失败即抛错，且**不提交业务目标**：调用方拿到错误时知识库的数据字节没有变。
 * 这是"意图先于数据"的代价，也是它唯一的价值——没有 prepared 就没有可核对的依据。
 */
export async function prepareJournalEntry(boundary: StorageBoundary, options: PrepareJournalOptions): Promise<PreparedJournal> {
	const operationId = randomUUID();
	const relativePath = journalRelativePath(operationId);
	const fileName = journalFileName(operationId);
	const record = buildPreparedJournalRecord({
		operationId,
		operation: options.operation,
		target: options.target,
		before: options.before,
		after: options.after,
		preparedAt: options.now,
	});
	assertJournalRecordValid(record, fileName);

	// 惰性创建 journal 目录：旧知识库没有这个目录也应能立刻写入，而初始化协议保持不变。
	await boundary.ensureDirectory(knowledgeLayout(boundary).journalDir, options.signal);

	const path = join(knowledgeLayout(boundary).journalDir, fileName);
	const published = await boundary.publishJsonMeasured(path, record, { callSignal: options.signal, maxBytes: boundary.limits.maxJournalBytes });
	if (published.status === "exists") {
		// operationId 由 UUID 生成，撞名只可能来自外部放置的同名文件——绝不覆盖。
		throw new StorageError("invalid-record", `journal 文件名已存在，拒绝覆盖：${relativePath}`, { path: relativePath, detail: "journal-operation-exists" });
	}

	return { operationId, path, relativePath, record, cleanup: published.cleanup };
}

export type FinalizeJournalOptions = {
	state: Exclude<JournalState, "prepared">;
	source: JournalSource;
	now: number;
	/** `committed` 时用实际提交返回的 fingerprint（真相优先于 prepared 里的预测值）。 */
	after?: JournalFingerprint;
	signal?: AbortSignal;
};

export type FinalizeJournalOutcome = { ok: true; record: JournalRecord; cleanup: "ok" | "failed" } | { ok: false; error: unknown };

/**
 * 写终态（`rename` 替换 prepared）。
 *
 * **不抛错**，而是把结果交回调用方：终态写入发生在**数据提交点之后**，
 * 此时"记账失败"与"业务失败"是两件事，必须由调用方按真实状态决定怎么上报（见 write.ts）。
 */
export async function finalizeJournalEntry(boundary: StorageBoundary, prepared: PreparedJournal, options: FinalizeJournalOptions): Promise<FinalizeJournalOutcome> {
	const record = buildFinalJournalRecord({
		prepared: prepared.record,
		state: options.state,
		source: options.source,
		finishedAt: options.now,
		...(options.after === undefined ? {} : { after: options.after }),
	});

	try {
		assertJournalRecordValid(record, journalFileName(prepared.operationId));
		const write = await boundary.replaceJson(prepared.path, record, { maxBytes: boundary.limits.maxJournalBytes, callSignal: options.signal });
		return { ok: true, record, cleanup: write.cleanup };
	} catch (error) {
		return { ok: false, error };
	}
}
