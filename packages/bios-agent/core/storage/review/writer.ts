/**
 * 一次经验卡审核的**领域写入口**（BM-02C2B / C2B-2）。
 *
 * 顺序是这一轮的核心（C2AR 修正后的唯一版本，任何重构都不能换位）：
 *
 * ```text
 * 取 ExperienceCard 的原目标协作锁（与 updateRecord 同一把、同一路径）
 * → 同源复读 + expectedRevision 校验 + 动作/状态解析（组装唯一 after）
 * → 意图 link            （audit/intents/<operationId>.json，非覆盖）
 * → v2 prepared link     （journal/<operationId>.json，非覆盖）
 * → 记录 rename          ★ 唯一业务提交点
 * → 事件发布/认领         （audit/<recordId>/<eventId>.json，非覆盖）
 * → v2 完成终态          （只能发生在事件之后）
 * → 释放自有锁
 * ```
 *
 * 三条被刻意固定的语义：
 *
 * 1. **完成终态永远在事件之后**：先写终态的恢复器会让"提交点已过、事件未发布"的窗口
 *    永久失去审计依据（第十轮 A1）。因此本文件里 `finalizeReviewJournalEntry` 只出现在
 *    事件发布/认领成功之后。
 * 2. **提交点已过就不再改口**：事件失败 / 终态失败 / 迟到取消，返回的是
 *    `applied-audit-pending` / `applied-journal-pending`，**不**假称"未提交"，
 *    也**不**提供虚假的发布事实（审计未发布时 `audit = null`）。
 * 3. **提交前失败不留半成品**：尽力把 v2 记成 `aborted`；记不进去就留下 `prepared`
 *    与有界诊断（交给 `reconcileReviewOperation`）。意图已发布而 v2 失败时**不删**意图：
 *    那是"人做过这个决定"的证据，交人工判断。
 *
 * 明确不做：通用 N 文件事务、批量审核、跨项目修改、自动后台恢复、重放/回滚、
 * 身份认证（`operatorLabel` 是声明）、迁移。
 */
import { randomUUID } from "node:crypto";
import { AUDIT_INTENT_PURPOSE, AUDIT_INTENT_SCHEMA_VERSION, AUDIT_LABEL_MAX_CHARS, AUDIT_REASON_MAX_CHARS, auditIntentFileName, validateAuditIntent, type AuditAction, type AuditEvidenceRef, type AuditIntent } from "../../contracts/index.ts";
import type { ExperienceCard } from "../../contracts/records.ts";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { assertPayloadWithinLimits, attachCleanupNote, CLEANUP_FAILED_NOTE, payloadFingerprint, serializeJsonPayload } from "../commit.ts";
import { isCancelledError, isStorageError, isStorageErrorCode, StorageError } from "../errors.ts";
import { lockReleaseNote, releaseOwnLock } from "../journal/index.ts";
import type { StorageLimits } from "../limits.ts";
import { acquireStorageLock, resolveLockTiming, type LockReleaseOutcome } from "../lock.ts";
import { interpretRecord, recordRelativeSegments } from "../records.ts";
import { knowledgeLayout, readRegistryWithBoundary } from "../registry.ts";
import { assertExpectedRevisionShape, assertSafeRevision, describeValue } from "../revision.ts";
import { artifactCleanupFailure, cleanupFailureFromError, finalizeReviewJournalEntry, prepareReviewJournalEntry, publishReviewIntentArtifact, reviewIntentRelativePath, type ArtifactCleanupFailure, type PreparedReviewJournal } from "./artifacts.ts";
import { abortPreparedReview, publishOrClaimReviewEvent, reviewNeedsRecoveryNote } from "./commitSteps.ts";
import { buildPreparedReviewJournalRecord, reviewJournalRelativePath, type ReviewAuditFact, type ReviewJournalRecord } from "./contract.ts";
import { assertEvidenceList, assertReviewAction, buildReviewedRecord, collectEvidenceIndexIssues, nextReviewerLabel, resolveReviewTransition } from "./decisions.ts";

/**
 * 入口结果：判别联合，把"业务是否提交""审计是否存在""journal 是否收口"三件事分开表达。
 *
 * - `applied`：三者齐备；
 * - `applied-audit-pending`：业务已提交，**审计待补**（`audit = null`，不预支发布事实）；
 * - `applied-journal-pending`：业务已提交、事件已发布/认领，只有完成终态待收口。
 */
export type ReviewDecisionResult = {
	readonly kind: "applied" | "applied-audit-pending" | "applied-journal-pending";
	readonly recordId: string;
	/** 本次提交后的 revision（只增 1；未提交时本函数不会走到这里）。 */
	readonly revision: number;
	readonly record: ExperienceCard;
	readonly operationId: string;
	readonly eventId: string;
	readonly intentRelativePath: string;
	/** 持久意图的**真实字节**指纹（v2 绑定的就是它）。 */
	readonly intentHash: string;
	readonly journal: { readonly operationId: string; readonly relativePath: string; readonly state: "committed" | "prepared" };
	readonly audit: ReviewAuditFact | null;
	readonly bytes: number;
	/**
	 * **业务提交**（记录文件）的临时文件清理结果。
	 *
	 * 刻意只表示业务：工件（意图/事件/v2）的清理结果在 `artifactCleanup` 里逐件列出，
	 * 不能用一句 `cleanup: "ok"` 覆盖整次调用——那会把"审核目录里留了 .tmp"藏起来（C2BR / R4）。
	 */
	readonly cleanup: "ok" | "failed";
	/** 已经发生的**工件**临时文件清理失败（空数组 = 本次没有任何工件残留）。 */
	readonly artifactCleanup: readonly ArtifactCleanupFailure[];
	readonly renameAttempts: number;
	readonly lockAttempts: number;
	readonly lockRelease: LockReleaseOutcome;
	readonly warnings?: readonly string[];
};

export type RecordReviewDecisionOptions = {
	root: string;
	/** 目标经验卡 ID（路径只由它派生）。 */
	recordId: string;
	/** 读到的 revision；审核是 update，**不接受** `null`。 */
	expectedRevision: number;
	action: AuditAction;
	/** 声明的人工标签，不是身份认证。 */
	operatorLabel: string;
	reason: string;
	/** 证据关联（只存引用与短说明，**不复制正文**）。 */
	evidence?: readonly AuditEvidenceRef[];
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试；见 boundary.ts）。 */
	ioHooks?: StorageIoHooks;
	/** 可注入时钟（测试用），默认 `Date.now()`。 */
	now?: number;
	lockTimeoutMs?: number;
	lockPollMs?: number;
};

/* ------------------------------------------------------------------ 入口 */

/** 审核一次经验卡：一次状态变更 + 一条不可变审计事件。 */
export async function recordReviewDecision(options: RecordReviewDecisionOptions): Promise<ReviewDecisionResult> {
	// 参数校验全部发生在**取锁之前**：参数错误不该占用别人的锁。
	const action = assertReviewAction(options.action);
	const timing = resolveLockTiming({ timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, now: options.now });
	const label = `experience-card/${describeValue(options.recordId)}`;
	const expected = assertExpectedRevisionShape(options.expectedRevision, label, false);
	if (expected === null) {
		// `allowNull: false` 已经排除了 null，这里只是让类型收窄显式化（入口语义：审核只针对已存在记录）。
		throw new StorageError("revision-conflict", `${label} 的审核必须给出读到的 revision（不接受 null）`, { detail: "review-with-null-revision" });
	}
	// 证据关联在**取锁之前**按同一份 schema 校验：非法输入不该占用别人的锁，也不该走到解引用。
	const evidence = assertEvidenceList(options.evidence, label);
	const operatorLabel = assertBoundedText(options.operatorLabel, "operatorLabel", 1, AUDIT_LABEL_MAX_CHARS, label);
	const reason = assertBoundedText(options.reason, "reason", 1, AUDIT_REASON_MAX_CHARS, label);

	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	await assertStoreReady(boundary);

	const segments = recordRelativeSegments("experience-card", options.recordId);
	const absolute = boundary.resolve(...segments);
	const relativePath = segments.join("/");

	// 与 `updateRecord` 用**同一把、同一路径**的锁：审核不是第二套写入通道，
	// 它必须和普通写、恢复、巡检串行化在同一个互斥点上。
	const lock = await acquireStorageLock(boundary, { target: absolute, timeoutMs: options.lockTimeoutMs, pollMs: options.lockPollMs, signal: options.signal, now: timing.now });

	let committed: ReviewCommitResult | undefined;
	let failure: unknown;
	let lockRelease: LockReleaseOutcome = "released";
	try {
		committed = await reviewUnderLock(boundary, { action, evidence, recordId: options.recordId, expected, operatorLabel, reason, now: timing.now, relativePath, signal: options.signal });
	} catch (error) {
		failure = error;
	} finally {
		// 释放忽略取消（锁没有回收器）；释放结果如实上报，绝不吞掉。
		lockRelease = await releaseOwnLock(lock);
	}

	if (failure !== undefined) throw lockRelease === "released" ? failure : attachCleanupNote(failure, lockReleaseNote(lockRelease));
	if (committed === undefined) throw new StorageError("invalid-record", "审核流程未产生结论（内部不一致）", { path: relativePath });
	// 锁事实由**入口**填写：提交序列本身不认识锁，它只回答"提交到哪一步"。
	const result: ReviewDecisionResult = { ...committed, lockAttempts: lock.attempts, lockRelease };
	return lockRelease === "released" ? result : { ...result, warnings: [...(result.warnings ?? []), lockReleaseNote(lockRelease)] };
}

/** 文本字段的**入口级**长度守卫（最终仍由 `validateAuditIntent` 按同一份规则判定）。 */
function assertBoundedText(value: unknown, field: string, min: number, max: number, label: string): string {
	if (typeof value !== "string" || value.length < min) {
		throw new StorageError("invalid-record", `${label} 的 ${field} 必须是长度 ${min}..${max} 的字符串（收到 ${describeValue(value)}）`, { detail: `invalid-${field}` });
	}
	if (value.length > max) {
		throw new StorageError("invalid-record", `${label} 的 ${field} 长度超过上限 ${max}（收到 ${value.length}），审核不接受截断`, { detail: `invalid-${field}` });
	}
	return value;
}

/* ------------------------------------------------------------------ 准入守卫 */

/** 写入必须发生在**有效**知识库里（与普通写同一准入：registry 读不动就不写）。 */
async function assertStoreReady(boundary: StorageBoundary): Promise<void> {
	const layout = knowledgeLayout(boundary);
	try {
		await readRegistryWithBoundary(boundary);
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) {
			throw new StorageError("not-found", `知识库尚未初始化（缺少 registry.json），拒绝审核：${layout.registryPath}`, { path: layout.registryPath, detail: "store-not-initialized" });
		}
		throw error;
	}
}

function revisionConflict(label: string, relativePath: string, expected: number, actual: number | null, hint: string): StorageError {
	const actualText = actual === null ? "不存在" : `revision=${actual}`;
	return new StorageError("revision-conflict", `${label} 审核冲突：期望 revision=${expected}，实际 ${actualText}（${relativePath}）。${hint}`, { path: relativePath, expected, actual });
}

/* ------------------------------------------------------------------ 持锁阶段 */

/** 提交序列的返回值：锁事实（`lockAttempts`/`lockRelease`）由入口填写，不在这里编造。 */
type ReviewCommitResult = Omit<ReviewDecisionResult, "lockAttempts" | "lockRelease">;

type UnderLockInput = {
	action: AuditAction;
	evidence: readonly AuditEvidenceRef[];
	recordId: string;
	expected: number;
	operatorLabel: string;
	reason: string;
	now: number;
	relativePath: string;
	signal?: AbortSignal;
};

async function reviewUnderLock(boundary: StorageBoundary, input: UnderLockInput): Promise<ReviewCommitResult> {
	const label = `experience-card/${input.recordId}`;
	const { record: current, fingerprint: currentFingerprint } = await readExperienceForReview(boundary, input.recordId, input.signal);

	assertSafeRevision(current.revision, label, input.relativePath);
	if (current.revision !== input.expected) {
		throw revisionConflict(label, input.relativePath, input.expected, current.revision, "目标已被其他写入者改过，请重新读取后再决定。");
	}
	// 审核是 update：必须能**真的**递增一版（与 `nextRecordHeader` 同一上界规则）。
	// 到顶的记录不能再审核——否则 `revision + 1` 等于自身，乐观并发控制就此失效。
	if (current.revision >= Number.MAX_SAFE_INTEGER) {
		throw new StorageError("revision-conflict", `${label} 的 revision 已达可表示上限，无法继续递增：${input.relativePath}`, { path: input.relativePath, detail: "revision-overflow" });
	}

	const toStatus = resolveReviewTransition(input.action, current.status);
	const indexIssues = collectEvidenceIndexIssues(input.evidence, current);
	if (indexIssues.length > 0) {
		throw new StorageError("invalid-record", `${label} 的证据引用无法复核：${indexIssues.join("；")}`, { detail: "review-evidence-index" });
	}

	const reviewer = nextReviewerLabel(input.action, input.operatorLabel, current.reviewer);
	const after = buildReviewedRecord(current, toStatus, reviewer, input.now, label);
	// **同一份序列化**既用于指纹又用于真正提交：`replaceJson` 内部用同一个 `serializeJsonPayload`，
	// 因此"写入的字节"和"意图里绑定的 hash"必然一致；不一致时下面会显式报出来，不改写意图。
	const afterPayload = serializeJsonPayload(after);
	assertPayloadWithinLimits(boundary.resolve(...recordRelativeSegments("experience-card", input.recordId)), afterPayload, boundary.limits.maxRecordBytes, boundary.limits.maxJsonChars);
	const afterHash = payloadFingerprint(afterPayload);

	return await commitReview(boundary, { ...input, current, currentFingerprint, after, afterHash });
}

/* ------------------------------------------------------------------ 提交序列 */

type CommitInput = UnderLockInput & {
	current: ExperienceCard;
	currentFingerprint: string;
	after: ExperienceCard;
	afterHash: string;
};

async function commitReview(boundary: StorageBoundary, input: CommitInput): Promise<ReviewCommitResult> {
	const operationId = randomUUID();
	const eventId = randomUUID();
	const intent = buildReviewIntent(input, operationId, eventId);
	const intentValidation = validateAuditIntent(intent);
	if (!intentValidation.ok) {
		const first = intentValidation.issues[0];
		throw new StorageError("invalid-record", `审核意图不符合契约：${first?.code ?? ""} ${first?.path ?? ""} ${first?.message ?? ""}`, { detail: first?.code ?? "invalid-audit-intent" });
	}

	// 工件清理失败的**逐件**账本（R4）：业务 `cleanup` 只管记录文件，工件残留必须有单独字段，
	// 否则"意图/事件/journal 目录里真的留了 .tmp"会被一句 cleanup:ok 掩盖。
	const artifactCleanup: ArtifactCleanupFailure[] = [];
	const recordCleanup = (failure: ArtifactCleanupFailure | undefined): void => {
		if (failure !== undefined) artifactCleanup.push(failure);
	};
	/** 提交前失败时把已发生的工件残留附加到原错误上（**原错误码不变**）。 */
	const rethrowWithArtifacts = (error: unknown): never => {
		throw artifactCleanup.length === 0 ? error : attachCleanupNote(error, artifactCleanup.map((entry) => entry.note).join("；"));
	};

	// ① 意图先落盘：崩溃后才有"人做过这个决定"的依据。
	//    意图/事件/v2 是**独立工件**：它们的临时文件清理失败必须逐件记下来（R4）。
	const intentPublished = await publishReviewIntentArtifact(boundary, intent, input.signal).catch((error: unknown) => {
		recordCleanup(cleanupFailureFromError(error, "intent", reviewIntentRelativePath(operationId)));
		return rethrowWithArtifacts(error);
	});
	const intentHash = intentPublished.hash;
	recordCleanup(intentPublished.cleanup === "failed" ? artifactCleanupFailure("intent", intentPublished.relativePath) : undefined);

	// ② v2 prepared：绑定事件身份 + 意图原字节指纹（不能只靠"意图文件存在"）。
	const prepared = await prepareReviewJournalEntry(
		boundary,
		buildPreparedReviewJournalRecord({
			operationId,
			eventId,
			intentName: auditIntentFileName(operationId),
			intentHash,
			target: { kind: "experience-card", id: input.recordId },
			before: { revision: input.current.revision, hash: input.currentFingerprint },
			after: { revision: input.after.revision, hash: input.afterHash },
			preparedAt: input.now,
		}),
		input.signal,
	).catch((error: unknown) => {
		recordCleanup(cleanupFailureFromError(error, "review-journal", reviewJournalRelativePath(operationId)));
		return rethrowWithArtifacts(error);
	});
	recordCleanup(prepared.cleanup === "failed" ? artifactCleanupFailure("review-journal", prepared.relativePath) : undefined);

	// ③ 业务提交点（唯一）。
	const absolute = boundary.resolve(...recordRelativeSegments("experience-card", input.recordId));
	let committed: { bytes: number; cleanup: "ok" | "failed"; fingerprint: string; renameAttempts: number };
	try {
		const write = await boundary.replaceJson(absolute, input.after, { maxBytes: boundary.limits.maxRecordBytes, callSignal: input.signal });
		committed = { bytes: write.bytes, cleanup: write.cleanup, fingerprint: write.fingerprint, renameAttempts: write.renameAttempts };
	} catch (error) {
		// 提交前失败/取消：尽力记 aborted（写不进去就留下 prepared + 有界诊断），原错误优先。
		const aborted = await abortPreparedReview(boundary, prepared, input.now, input.signal);
		recordCleanup(aborted.artifactCleanup);
		const notes = [...artifactCleanup.map((entry) => entry.note), ...(aborted.note === null ? [] : [aborted.note])];
		throw notes.length === 0 ? error : attachCleanupNote(error, notes.join("；"));
	}

	const base = {
		recordId: input.recordId,
		revision: input.after.revision,
		record: input.after,
		operationId,
		eventId,
		intentRelativePath: reviewIntentRelativePath(operationId),
		intentHash,
		bytes: committed.bytes,
		cleanup: committed.cleanup,
		artifactCleanup,
		renameAttempts: committed.renameAttempts,
	};
	const journalPath = prepared.relativePath;

	/** 结果警告 = 业务清理失败 + 逐件工件残留（两者都不能被"某一项 ok"掩盖）。 */
	const resultWarnings = (): string[] => {
		const list = committed.cleanup === "failed" ? [CLEANUP_FAILED_NOTE] : [];
		for (const entry of artifactCleanup) list.push(entry.note);
		return list;
	};

	// 提交已成立，但实际字节与 prepared 绑定不一致：**不发布事件**，也不改写意图掩盖它。
	if (committed.fingerprint !== input.afterHash) {
		return {
			...base,
			kind: "applied-audit-pending",
			journal: { operationId, relativePath: journalPath, state: "prepared" },
			audit: null,
			warnings: ["提交返回的字节指纹与 prepared 意图不一致（记录已提交，事件未发布）；请人工核对后决定是否补发审计", ...resultWarnings()],
		};
	}

	// ④ 事件发布或认领（必须在完成终态之前）。
	const auditOutcome = await publishOrClaimReviewEvent(boundary, { intent, prepared, intentHash, now: input.now, signal: input.signal });
	recordCleanup(auditOutcome.artifactCleanup);
	if (!auditOutcome.ok) {
		return {
			...base,
			kind: "applied-audit-pending",
			journal: { operationId, relativePath: journalPath, state: "prepared" },
			audit: null,
			warnings: [auditOutcome.warning, ...resultWarnings()],
		};
	}

	// ⑤ 完成终态：只可能在事件之后。
	const finalized = await finalizeReviewJournalEntry(boundary, prepared, {
		state: "committed",
		source: "writer-confirmed",
		now: Math.max(input.now, prepared.record.preparedAt),
		after: { revision: input.after.revision, hash: committed.fingerprint },
		signal: input.signal,
	});
	recordCleanup(cleanupFailureFromError(finalized.ok ? undefined : finalized.error, "review-journal", journalPath));
	// 终态写成了但临时文件没删掉：同样是"工件残留"，必须进 artifactCleanup（不能只留一句业务 warning）。
	if (finalized.ok && finalized.cleanup === "failed") recordCleanup(artifactCleanupFailure("review-journal", journalPath));
	const warnings = resultWarnings();
	if (!finalized.ok) {
		warnings.push(reviewNeedsRecoveryNote(operationId, isCancelledError(finalized.error) ? "已取消" : "写入失败"));
		return { ...base, kind: "applied-journal-pending", journal: { operationId, relativePath: journalPath, state: "prepared" }, audit: auditOutcome.audit, ...(warnings.length > 0 ? { warnings } : {}) };
	}
	return { ...base, kind: "applied", journal: { operationId, relativePath: journalPath, state: "committed" }, audit: auditOutcome.audit, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** 组装审核意图（决定本身；**不含** publication/recordedAt——那是发布事实）。 */
function buildReviewIntent(input: CommitInput, operationId: string, eventId: string): AuditIntent {
	const from = input.current.status;
	return {
		intentVersion: AUDIT_INTENT_SCHEMA_VERSION,
		purpose: AUDIT_INTENT_PURPOSE,
		eventId,
		operationId,
		target: { kind: "experience-card", recordId: input.recordId },
		action: input.action,
		fromStatus: from,
		toStatus: input.after.status,
		operatorLabel: input.operatorLabel,
		decidedAt: input.now,
		reason: input.reason,
		before: { revision: input.current.revision, hash: input.currentFingerprint },
		after: { revision: input.after.revision, hash: input.afterHash },
		evidence: [...input.evidence],
	};
}

/** 读目标经验卡（持锁后调用；"不存在"是确定结论，不当成可新建）。 */
async function readExperienceForReview(boundary: StorageBoundary, recordId: string, signal: AbortSignal | undefined): Promise<{ record: ExperienceCard; fingerprint: string }> {
	const absolute = boundary.resolve(...recordRelativeSegments("experience-card", recordId));
	let value: unknown;
	let fingerprint: string;
	try {
		({ value, fingerprint } = await boundary.readJson(absolute, boundary.limits.maxRecordBytes, signal));
	} catch (error) {
		if (isStorageErrorCode(error, "not-found")) throw new StorageError("not-found", `目标经验卡不存在：experience-card/${recordId}`, { path: absolute });
		throw error;
	}
	const interpreted = interpretRecord("experience-card", value, { id: recordId });
	if (!interpreted.ok) {
		// 存在但解释不了：不能当"不存在"，也不能当"可审核"。
		throw new StorageError(interpreted.problem.code, `experience-card/${recordId} 已存在但无法解释，拒绝审核：${interpreted.problem.message}`, { path: absolute });
	}
	return { record: interpreted.record, fingerprint };
}

/** 便于调用方做类型收窄（与 storage 其它结果类型同风格）。 */
export type ReviewDecisionRecord = ReviewJournalRecord;
export type { PreparedReviewJournal };
