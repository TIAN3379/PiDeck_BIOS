/**
 * 审核工件的**真实字节读写**：意图与审计事件（BM-02C2B / C2B-1）。
 *
 * 工件是两类不可变文件，路径只能由受控 ID 派生：
 *
 * ```text
 * audit/intents/<operationId>.json   审核意图（决定本身，先于业务提交）
 * audit/<recordId>/<eventId>.json    审计事件（已发布的决定，后于业务提交）
 * ```
 *
 * 三条规则，每条都对应一个真实故障：
 *
 * 1. **读取先限字节再解析**（`readJson`）：工件是外部可放置的文件，无界读取等于给
 *    "一个大文件"开无界内存入口；`intentHash` 只能取**同一次有界读取**返回的字节指纹，
 *    不允许"读回来再自己序列化一遍算哈希"——键序/缩进差异会让指纹与实际字节脱钩。
 * 2. **发布非覆盖**（`publishJsonMeasured` → 同目录临时文件 + `link`）：撞名时**绝不覆盖**。
 *    同 `operationId` 且**逐字节相同**才认领为幂等；字节不同即冲突（交人工判断）。
 * 3. **不可解释一律保留原文件**：坏 JSON / 未来版本 / 未知字段 / 超限 / 链接，全部抛错或
 *    进入巡检问题，绝不删除、绝不"当作不存在"（后者会让恢复去补一条与现场冲突的事件）。
 */
import { join } from "node:path";
import { AUDIT_INTENT_PURPOSE, auditIntentFileName, isValidAuditEvent, isValidAuditIntent, validateAuditEvent, validateAuditIntent, type AuditEvent, type AuditIntent } from "../../contracts/index.ts";
import type { StorageBoundary } from "../boundary.ts";
import { attachCleanupFailureNote, hasCleanupFailureMark } from "../commit.ts";
import { isCancelledError, isStorageError, StorageError } from "../errors.ts";
import { JOURNAL_SCHEMA_VERSION, journalRelativeSegments } from "../journal/contract.ts";
import { validateJournalRecord } from "../journal/index.ts";
import {
	assertReviewJournalValid,
	buildFinalReviewJournalRecord,
	readReviewJournalVersion,
	reviewArtifactLimit,
	reviewJournalFileName,
	reviewJournalRelativePath,
	REVIEW_JOURNAL_DIR_NAME,
	REVIEW_JOURNAL_VERSION,
	validateReviewJournalRecord,
	type ReviewJournalRecord,
	type ReviewJournalSource,
	type ReviewJournalState,
} from "./contract.ts";

/** 意图目录名（知识根内，惰性创建）。 */
export const REVIEW_INTENT_DIR_NAME = "intents";

/** `audit/intents/<operationId>.json` 的根内相对片段。 */
export function reviewIntentRelativeSegments(operationId: string): string[] {
	return ["audit", REVIEW_INTENT_DIR_NAME, auditIntentFileName(operationId)];
}

/** `audit/<recordId>/<eventId>.json` 的根内相对片段。 */
export function reviewEventRelativeSegments(recordId: string, eventId: string): string[] {
	return ["audit", recordId, `${eventId}.json`];
}

export function reviewIntentRelativePath(operationId: string): string {
	return reviewIntentRelativeSegments(operationId).join("/");
}

export function reviewEventRelativePath(recordId: string, eventId: string): string {
	return reviewEventRelativeSegments(recordId, eventId).join("/");
}

/**
 * 工件的读取结果。
 *
 * `missing: true` 与其它失败**必须分开**：前者是"确实没有这条工件"（新发布的正常输入），
 * 后者是"有东西但我读不懂"（保守拒绝的依据）。用读取失败推断不存在，会把损坏当成空缺。
 */
export type ReviewArtifactRead<T> = { ok: true; value: T; bytes: number; hash: string } | { ok: false; missing: boolean; code: string; message: string };

function describeReadFailure(error: unknown, label: string, relativePath: string): { missing: boolean; code: string; message: string } {
	if (isStorageError(error)) {
		const missing = error.code === "not-found";
		return { missing, code: error.code, message: `${label} ${missing ? "不存在" : `无法读取（${error.code}）`}：${relativePath}` };
	}
	return { missing: false, code: "unreadable", message: `${label} 无法读取：${relativePath}` };
}

async function readArtifact<T>(boundary: StorageBoundary, absolute: string, relativePath: string, label: string, maxBytes: number, interpret: (value: unknown) => { ok: true; value: T } | { ok: false; message: string }, signal: AbortSignal | undefined): Promise<ReviewArtifactRead<T>> {
	try {
		const { value, bytes, fingerprint } = await boundary.readJson(absolute, maxBytes, signal);
		const interpreted = interpret(value);
		if (!interpreted.ok) return { ok: false, missing: false, code: "invalid-record", message: `${label} 不符合契约（${relativePath}）：${interpreted.message}` };
		// `hash` 是**这次读取实际返回的字节**指纹：调用方只能拿它去和 journal 的声明值比较。
		return { ok: true, value: interpreted.value, bytes, hash: fingerprint };
	} catch (error) {
		if (isCancelledError(error)) throw error;
		return { ok: false, ...describeReadFailure(error, label, relativePath) };
	}
}

/** 读取审核意图（有界 + 完整校验）。 */
export async function readReviewIntentArtifact(boundary: StorageBoundary, operationId: string, signal?: AbortSignal): Promise<ReviewArtifactRead<AuditIntent>> {
	const relativePath = reviewIntentRelativePath(operationId);
	const absolute = boundary.resolve(...reviewIntentRelativeSegments(operationId));
	return readArtifact(
		boundary,
		absolute,
		relativePath,
		"审核意图",
		reviewArtifactLimit(boundary.limits),
		(value) => {
			const outcome = validateAuditIntent(value);
			if (!outcome.ok) return { ok: false, message: `${outcome.issues[0]?.code ?? "invalid-audit-intent"}：${outcome.issues[0]?.message ?? ""}` };
			// 意图的 purpose 与身份都必须落在本次操作上，避免"读到别人的意图"被当成自己的。
			if (outcome.value.purpose !== AUDIT_INTENT_PURPOSE || outcome.value.operationId !== operationId) {
				return { ok: false, message: "意图的 purpose/operationId 与该路径不对应" };
			}
			return { ok: true, value: outcome.value };
		},
		signal,
	);
}

/** 读取审计事件（有界 + 完整校验）。 */
export async function readReviewEventArtifact(boundary: StorageBoundary, recordId: string, eventId: string, signal?: AbortSignal): Promise<ReviewArtifactRead<AuditEvent>> {
	const relativePath = reviewEventRelativePath(recordId, eventId);
	const absolute = boundary.resolve(...reviewEventRelativeSegments(recordId, eventId));
	return readArtifact(
		boundary,
		absolute,
		relativePath,
		"审计事件",
		reviewArtifactLimit(boundary.limits),
		(value) => {
			const outcome = validateAuditEvent(value);
			if (!outcome.ok) return { ok: false, message: `${outcome.issues[0]?.code ?? "invalid-audit"}：${outcome.issues[0]?.message ?? ""}` };
			if (outcome.value.eventId !== eventId || outcome.value.target.recordId !== recordId) {
				return { ok: false, message: "事件的 eventId/target 与该路径不对应" };
			}
			return { ok: true, value: outcome.value };
		},
		signal,
	);
}

/**
 * 一件**已经发生**的工件临时文件清理失败（C2BR / R4）。
 *
 * 为什么单独成字段而不是复用业务 `cleanup`：`cleanup` 只表示"业务提交的临时文件"。
 * 用一句 `cleanup: "ok"` 覆盖整次调用，会让"意图/事件/journal 目录里真的留了 `.tmp`"
 * 变成不可见的事实——第十二轮验收实测的结果正是 `kind=applied、cleanup=ok、warnings=[]`
 * 却真的留下残留。工件必须能被**逐件**报告。
 */
export type ArtifactCleanupFailure = {
	readonly artifact: "intent" | "event" | "review-journal";
	/** 受控相对路径（不含正文）。 */
	readonly relativePath: string;
	/** 有界诊断文案。 */
	readonly note: string;
};

/** 工件残留的固定文案（错误消息与结果警告共用同一份）。 */
export const ARTIFACT_CLEANUP_NOTE = "审核工件的临时文件清理失败：请人工清理同目录下的 .tmp 残留（不自动删除、不靠 GC）";

/** 构造一条工件清理失败记录（文案有界、只带受控路径）。 */
export function artifactCleanupFailure(artifact: ArtifactCleanupFailure["artifact"], relativePath: string): ArtifactCleanupFailure {
	return { artifact, relativePath, note: `${ARTIFACT_CLEANUP_NOTE}（${artifact}：${relativePath}）` };
}

/**
 * 从**失败路径**的错误里取回已经发生的清理失败。
 *
 * `publishJsonMeasured` / `replaceJson` 在失败时会把清理失败作为附加诊断挂在错误消息里
 * （原错误码不变）；调用方若把这个错误转成结果（例如恢复阶段的"待补"），
 * 就必须把它**取回来**，否则这条事实会在转换中消失。
 *
 * 判据是**结构标记**（`attachCleanupFailureNote` 打的 WeakSet 标记），不是比对文案：
 * 底层（`boundary`）附加的是业务文案 `CLEANUP_FAILED_NOTE`，本模块自己的发布路径附加的是
 * 审核专用文案——只认后者会漏掉"事件/意图目录里真的留了 `.tmp`"这一类失败
 * （第十三轮验收 F2 实测：`artifactCleanup=[]` 而磁盘上确有残留）。文案检查保留为兜底，
 * 兼容"错误在别处被重建/重新附加"的历史形状。
 *
 * 归因是安全的：调用点**已知**当前是哪一件工件在发布/替换，而这个错误正是那一次调用抛出的。
 */
export function cleanupFailureFromError(error: unknown, artifact: ArtifactCleanupFailure["artifact"], relativePath: string): ArtifactCleanupFailure | undefined {
	if (!isStorageError(error)) return undefined;
	if (!hasCleanupFailureMark(error) && !error.message.includes(ARTIFACT_CLEANUP_NOTE)) return undefined;
	return artifactCleanupFailure(artifact, relativePath);
}

/**
 * 把"本工件的临时文件清理失败"附加到正在传播的错误上（原错误码保持不变）。
 *
 * 用于**提前退出**的路径：已经取得的 cleanup 事实必须留在错误里，
 * 不能因为随后抛出取消/冲突而消失（C2BR2 / F2）。
 */
export function attachArtifactCleanupNote<T>(error: T, artifact: ArtifactCleanupFailure["artifact"], relativePath: string): T {
	return attachCleanupFailureNote(error, artifactCleanupFailure(artifact, relativePath).note) as T;
}

/** 把清理失败作为附加诊断挂在要抛出的错误上（原错误码保持不变）。 */
function withCleanupNote<T extends StorageError>(error: T, cleanup: "ok" | "failed", artifact: ArtifactCleanupFailure["artifact"], relativePath: string): T {
	return cleanup === "failed" ? attachArtifactCleanupNote(error, artifact, relativePath) : error;
}

/** 发布结果：`created` = 本次真的发布了；`exists-identical` = 已有同字节工件（幂等认领）。 */
export type ReviewPublishResult = {
	readonly status: "created" | "exists-identical";
	readonly relativePath: string;
	/** 实际写下去（或已存在且逐字节相同）的字节指纹。 */
	readonly hash: string;
	readonly bytes: number;
	readonly cleanup: "ok" | "failed";
};

/**
 * 意图发布的冲突判定：同 `operationId` 已有文件，但字节不同。
 *
 * 单独一个错误码（`audit-conflict`）而不是复用 `revision-conflict`：调用方能据此区分
 * "并发改了业务记录，重读再来"（可自动重试）与"审核工件被替换过，必须人工判断"（不可重试）。
 */
function intentConflict(relativePath: string, detail: string): StorageError {
	return new StorageError("audit-conflict", `审核意图已存在且内容不同，拒绝覆盖：${relativePath}（${detail}）`, { path: relativePath, detail: "review-intent-conflict" });
}

/**
 * 发布审核意图（非覆盖）。
 *
 * 撞名时读回**已有文件的真实字节**与本次要写的字节比较：相同 ⇒ 幂等认领；
 * 不同 ⇒ `audit-conflict`。这里刻意不做"解析后比较决定字段"——意图是**原字节**绑定物
 * （journal 里绑的就是它的 hash），字节不同就意味着绑定失效。
 */
export async function publishReviewIntentArtifact(boundary: StorageBoundary, intent: AuditIntent, signal?: AbortSignal): Promise<ReviewPublishResult> {
	const validation = validateAuditIntent(intent);
	if (!validation.ok) {
		throw new StorageError("invalid-record", `拒绝发布无法通过契约的审核意图：${validation.issues[0]?.code ?? ""} ${validation.issues[0]?.message ?? ""}`, { detail: validation.issues[0]?.code ?? "invalid-audit-intent" });
	}
	const relativePath = reviewIntentRelativePath(intent.operationId);
	const absolute = boundary.resolve(...reviewIntentRelativeSegments(intent.operationId));
	// 惰性创建 `audit/intents/`：旧知识库没有这个目录也应能立刻写入，初始化协议保持不变。
	await boundary.ensureDirectory(boundary.resolve("audit", REVIEW_INTENT_DIR_NAME), signal);

	const published = await boundary.publishJsonMeasured(absolute, intent, { callSignal: signal, maxBytes: reviewArtifactLimit(boundary.limits) });
	if (published.status === "created") return { status: "created", relativePath, hash: published.fingerprint, bytes: published.bytes, cleanup: published.cleanup };

	// 已存在：**必须**读回真实字节再判定，不能凭"我这次序列化的结果"猜。
	let existing: ReviewArtifactRead<AuditIntent>;
	try {
		existing = await readReviewIntentArtifact(boundary, intent.operationId, signal);
	} catch (error) {
		// 取消仍然穿透（没有发布任何新事实，不能改写成别的结论），但**本次**已经发生的清理事实
		// 不能随之消失：与事件路径同一要求（C2BR2 / I1）。判据只认本次的 `published.cleanup`，
		// 不把目录里的历史残留归到这一次调用上。
		if (isCancelledError(error)) throw published.cleanup === "failed" ? attachArtifactCleanupNote(error, "intent", relativePath) : error;
		// 竞态下文件可能刚好消失：把清理诊断与冲突一起报出，不做二次发布（避免与别人对撞）。
		throw withCleanupNote(intentConflict(relativePath, "已有意图在读取期间消失或被移动，请人工确认后重试"), published.cleanup, "intent", relativePath);
	}
	if (!existing.ok) throw withCleanupNote(intentConflict(relativePath, existing.message), published.cleanup, "intent", relativePath);
	const expectedHash = published.fingerprint;
	if (existing.hash !== expectedHash) throw withCleanupNote(intentConflict(relativePath, "已有意图的字节与本次决定不同"), published.cleanup, "intent", relativePath);
	return { status: "exists-identical", relativePath, hash: existing.hash, bytes: existing.bytes, cleanup: published.cleanup };
}

/**
 * 事件发布的失败原因（冲突 / 目标已存在但不可解释 / IO 失败）统一在调用方处理。
 *
 * `exists` 分支也**必须**带 `cleanup`：非覆盖发布在撞名时同样创建并试图删除一个临时文件，
 * 丢掉它的清理结果就是"用过一次就再也看不见的残留"（第十二轮验收 R4）。
 */
export type ReviewEventPublishOutcome = { status: "created"; relativePath: string; hash: string; bytes: number; cleanup: "ok" | "failed" } | { status: "exists"; relativePath: string; cleanup: "ok" | "failed" };

/**
 * 发布审计事件（非覆盖）。
 *
 * 与意图不同，事件撞名时**不在本函数里判对错**：是否认领要由
 * `compareAuditAssociation` 按稳定决定字段裁决（发布事实必然不同，字节比较必然失败）。
 */
export async function publishReviewEventArtifact(boundary: StorageBoundary, event: AuditEvent, signal?: AbortSignal): Promise<ReviewEventPublishOutcome> {
	if (!isValidAuditEvent(event)) throw new StorageError("invalid-record", "拒绝发布无法通过契约的审计事件", { detail: "invalid-audit-event" });
	const relativePath = reviewEventRelativePath(event.target.recordId, event.eventId);
	const absolute = boundary.resolve(...reviewEventRelativeSegments(event.target.recordId, event.eventId));
	await boundary.ensureDirectory(boundary.resolve("audit", event.target.recordId), signal);

	const published = await boundary.publishJsonMeasured(absolute, event, { callSignal: signal, maxBytes: reviewArtifactLimit(boundary.limits) });
	if (published.status === "exists") return { status: "exists", relativePath, cleanup: published.cleanup };
	return { status: "created", relativePath, hash: published.fingerprint, bytes: published.bytes, cleanup: published.cleanup };
}

/* ------------------------------------------------------------------ 审核 journal v2 工件 */

/**
 * 审核 journal 的读取结论。
 *
 * `kind` 把三种"不是我们的 v2"分清楚，因为它们要三种不同的处理：
 * - `missing`：确实没有这条操作（`not-found` 是确定事实）；
 * - `v1`：**普通写**的 journal（合法但非审核）——必须明确区分，绝不降级成审核处理；
 * - `unknown` / `broken`：未来版本、坏 JSON、未知字段、超限、链接……一律保留原文件。
 */
export type ReviewJournalRead = { ok: true; record: ReviewJournalRecord; bytes: number } | { ok: false; missing: boolean; kind: "v1" | "unknown" | "broken"; code: string; message: string };

export async function readReviewJournalArtifact(boundary: StorageBoundary, operationId: string, signal?: AbortSignal): Promise<ReviewJournalRead> {
	const relativePath = reviewJournalRelativePath(operationId);
	const absolute = boundary.resolve(...journalRelativeSegments(operationId));
	let value: unknown;
	try {
		({ value } = await boundary.readJson(absolute, reviewArtifactLimit(boundary.limits), signal));
	} catch (error) {
		if (isCancelledError(error)) throw error;
		const failure = describeReadFailure(error, "审核 journal", relativePath);
		return { ok: false, missing: failure.missing, kind: "broken", code: failure.code, message: failure.message };
	}

	const version = readReviewJournalVersion(value);
	if (version === undefined) return { ok: false, missing: false, kind: "broken", code: "invalid-review-journal", message: `审核 journal 缺少合法的 journalVersion：${relativePath}` };
	if (version === JOURNAL_SCHEMA_VERSION) {
		// version=1 有两种情况，必须分开：**合法 v1** 是"另一个类别"（普通写，不是审核 journal），
		// 而**结构坏掉的 v1** 是"读不懂的东西"，要按问题/不可判定保留原文件——
		// 把坏文件当"普通写"计数，等于用一句"这不是审核"掩盖了"它已经坏了"。
		const ordinary = validateJournalRecord(value, reviewJournalFileName(operationId));
		if (ordinary.ok) return { ok: false, missing: false, kind: "v1", code: "not-review-journal", message: `${relativePath} 是普通写（v1）journal，不是审核专用 v2；请使用 reconcileJournalOperation` };
		const first = ordinary.issues[0];
		return { ok: false, missing: false, kind: "broken", code: first?.code ?? "invalid-journal", message: `${relativePath} 是 v1 journal 但内容不合法：${first?.path || "/"} ${first?.message ?? ""}` };
	}
	if (version !== REVIEW_JOURNAL_VERSION) {
		return { ok: false, missing: false, kind: "unknown", code: "unsupported-journal-version", message: `journalVersion=${version} 不是审核支持的 ${REVIEW_JOURNAL_VERSION}，拒绝解释：${relativePath}` };
	}

	const outcome = validateReviewJournalRecord(value, reviewJournalFileName(operationId));
	if (!outcome.ok) {
		const first = outcome.issues[0];
		return { ok: false, missing: false, kind: "broken", code: first?.code ?? "invalid-review-journal", message: `${relativePath}：${first?.path || "/"} ${first?.message ?? ""}` };
	}
	return { ok: true, record: outcome.value, bytes: Buffer.byteLength(JSON.stringify(value), "utf8") };
}

/** 已持久化的 prepared（终态写入只需要它 + 新状态 + 实际提交指纹）。 */
export type PreparedReviewJournal = {
	readonly operationId: string;
	readonly path: string;
	readonly relativePath: string;
	readonly record: ReviewJournalRecord;
	/** prepared 发布时临时文件的清理结果。 */
	readonly cleanup: "ok" | "failed";
};

/**
 * 持久发布 prepared 审核 journal（非覆盖）。
 *
 * 与 v1 的 `prepareJournalEntry` 同一手法：惰性建目录 → 同目录临时文件 → `link`。
 * `operationId` 由本次调用生成，撞名只可能来自外部放置的同名文件——绝不覆盖。
 */
export async function prepareReviewJournalEntry(boundary: StorageBoundary, record: ReviewJournalRecord, signal?: AbortSignal): Promise<PreparedReviewJournal> {
	assertReviewJournalValid(record, reviewJournalFileName(record.operationId));
	const relativePath = reviewJournalRelativePath(record.operationId);
	const dir = boundary.resolve(REVIEW_JOURNAL_DIR_NAME);
	await boundary.ensureDirectory(dir, signal);

	const path = join(dir, reviewJournalFileName(record.operationId));
	const published = await boundary.publishJsonMeasured(path, record, { callSignal: signal, maxBytes: reviewArtifactLimit(boundary.limits) });
	if (published.status === "exists") {
		throw withCleanupNote(new StorageError("audit-conflict", `审核 journal 文件名已存在，拒绝覆盖：${relativePath}`, { path: relativePath, detail: "review-journal-exists" }), published.cleanup, "review-journal", relativePath);
	}
	return { operationId: record.operationId, path, relativePath, record, cleanup: published.cleanup };
}

export type FinalizeReviewJournalOutcome = { ok: true; record: ReviewJournalRecord; cleanup: "ok" | "failed" } | { ok: false; error: unknown };

/**
 * 写审核 journal 终态（`rename` 替换 prepared）。
 *
 * **不抛错**：终态写入发生在业务提交点之后，"记账失败"与"业务失败"是两件事，
 * 必须由调用方按真实状态上报（见 `writer.ts` 的 applied-journal-pending）。
 */
export async function finalizeReviewJournalEntry(boundary: StorageBoundary, prepared: PreparedReviewJournal, options: { state: Exclude<ReviewJournalState, "prepared">; source: ReviewJournalSource; now: number; after?: ReviewJournalRecord["after"]; signal?: AbortSignal }): Promise<FinalizeReviewJournalOutcome> {
	const record = buildFinalReviewJournalRecord({
		prepared: prepared.record,
		state: options.state,
		source: options.source,
		finishedAt: options.now,
		...(options.after === undefined ? {} : { after: options.after }),
	});
	try {
		assertReviewJournalValid(record, reviewJournalFileName(prepared.operationId));
		const write = await boundary.replaceJson(prepared.path, record, { maxBytes: reviewArtifactLimit(boundary.limits), callSignal: options.signal });
		return { ok: true, record, cleanup: write.cleanup };
	} catch (error) {
		return { ok: false, error };
	}
}
