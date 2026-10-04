/**
 * 审核提交序列里**提交点之后**的步骤：事件的发布/认领、终态记账、有界文案（BM-02C2B / C2B-2）。
 *
 * 为什么从 `writer.ts` 抽出来：`writer.ts` 的职责是"取锁 → 组装 → 按顺序调用"，而这一组函数
 * 面对的是**另一套错误语义**——它们全部运行在业务提交点**之后**，因此：
 *
 * - 这里的失败**不能**变成异常（那会让调用方以为整次审核失败并重复提交同一 revision）；
 * - 事件必须**先**发布/认领，完成终态**只能**在它之后（第十轮 A1 的核心）；
 * - 已有事件一律通过纯比较（`compareAuditAssociation`）裁决：一致就**认领**并保留其原始
 *   `publication`/`recordedAt`，不一致就如实报"事件待补"，绝不覆盖。
 *
 * 这些函数都要求调用方**已持有目标锁**；它们自己不取锁（锁的语义只有一处，见 writer/reconcile）。
 */
import { AUDIT_SCHEMA_VERSION, compareAuditAssociation, type AuditEvent, type AuditIntent, type AuditPublication } from "../../contracts/index.ts";
import type { StorageBoundary } from "../boundary.ts";
import { isCancelledError, isStorageError } from "../errors.ts";
import { artifactCleanupFailure, attachArtifactCleanupNote, cleanupFailureFromError, finalizeReviewJournalEntry, publishReviewEventArtifact, readReviewEventArtifact, reviewEventRelativePath, type ArtifactCleanupFailure, type PreparedReviewJournal } from "./artifacts.ts";
import { toReviewProjection, type ReviewAuditFact, type ReviewJournalRecord } from "./contract.ts";

/**
 * 事件发布/认领的结果。
 *
 * `artifactCleanup` 只在**真的发生过**工件临时文件清理失败时出现：它必须在所有分支
 * （成功 / 撞名认领 / 失败 / 迟到取消）都能传回调用方，否则"事件目录里留了 .tmp"
 * 只会在某一条路径上可见（C2BR / R4）。
 */
export type PublishOrClaimOutcome = { ok: true; audit: ReviewAuditFact; artifactCleanup?: ArtifactCleanupFailure } | { ok: false; warning: string; artifactCleanup?: ArtifactCleanupFailure };

type PublishOrClaimInput = { intent: AuditIntent; prepared: PreparedReviewJournal; intentHash: string; now: number; signal?: AbortSignal };

/**
 * 事件发布/认领（**提交点之后**的唯一入口）。
 *
 * 判定完全交给纯比较：不存在事件 ⇒ `publish`（由本次路径生成发布事实）；
 * 已有事件 ⇒ 逐项比较稳定决定字段后 `claim`，**原样保留**其发布事实。
 * 冲突或不可解释一律不覆盖、不写终态，只如实返回"事件待补"。
 */
export async function publishOrClaimReviewEvent(boundary: StorageBoundary, input: PublishOrClaimInput): Promise<PublishOrClaimOutcome> {
	// 失败路径上"已经发生的工件残留"必须被取回来：把错误转成结果的那一刻，
	// 挂在错误消息里的清理诊断会随之消失（R4）。
	const eventRelativePath = reviewEventRelativePath(input.intent.target.recordId, input.intent.eventId);
	try {
		return await publishOrClaimReviewEventInner(boundary, input);
	} catch (error) {
		const artifactCleanup = cleanupFailureFromError(error, "event", eventRelativePath);
		// 提交点已过：这里的任何失败（含迟到取消）都不能再变成异常，否则调用方会重复提交同一 revision。
		if (isCancelledError(error)) return { ok: false, warning: "取消发生在业务提交之后：记录已提交，但审计事件未发布；请用 reconcileReviewOperation 补发（不要重复提交）", ...(artifactCleanup === undefined ? {} : { artifactCleanup }) };
		const code = isStorageError(error) ? error.code : "unexpected";
		return { ok: false, warning: `审计事件发布/认领失败（${code}）；记录已提交，事件待补发，请用 reconcileReviewOperation 核对`, ...(artifactCleanup === undefined ? {} : { artifactCleanup }) };
	}
}

async function publishOrClaimReviewEventInner(boundary: StorageBoundary, input: PublishOrClaimInput): Promise<PublishOrClaimOutcome> {
	const existing = await inspectBoundEvent(boundary, input.prepared.record, input.intent, input.signal);
	if (existing.kind === "unreadable" || existing.kind === "conflict") return { ok: false, warning: `${existing.reason}；未发布、未覆盖，交人工判断` };
	if (existing.kind === "claim") return { ok: true, audit: existing.fact };

	const published = await publishReviewEventArtifact(boundary, buildReviewEvent(input.intent, "writer", input.now), input.signal);
	// `exists` 分支同样会产生并尝试清理一个临时文件：它的清理结果不能丢（R4）。
	const eventCleanup = published.cleanup === "failed" ? artifactCleanupFailure("event", published.relativePath) : undefined;
	if (published.status === "exists") {
		// 持锁时不该出现；只有外部写者绕过协议才会。此时**不覆盖**，按认领规则重读一次。
		let raced: ExistingEventOutcome;
		try {
			raced = await inspectBoundEvent(boundary, input.prepared.record, input.intent, input.signal);
		} catch (error) {
			// 提前退出（取消 / 读取失败）：已经取得的清理事实必须留在错误里（C2BR2 / F2），
			// 否则调用方只看得到"取消"，磁盘上的 `.tmp` 从此无人可知。
			throw eventCleanup === undefined ? error : attachArtifactCleanupNote(error, "event", published.relativePath);
		}
		if (raced.kind !== "claim") return { ok: false, warning: "事件在发布瞬间已存在且与本次决定不一致，未覆盖；请人工核对", ...(eventCleanup === undefined ? {} : { artifactCleanup: eventCleanup }) };
		return { ok: true, audit: raced.fact, ...(eventCleanup === undefined ? {} : { artifactCleanup: eventCleanup }) };
	}
	return { ok: true, audit: { eventId: input.intent.eventId, relativePath: published.relativePath, publication: "writer", recordedAt: input.now }, ...(eventCleanup === undefined ? {} : { artifactCleanup: eventCleanup }) };
}

export type ExistingEventOutcome =
	| { kind: "claim"; fact: ReviewAuditFact }
	| { kind: "missing" }
	/** 有文件但读不懂（坏 JSON / 未来版本 / 链接 / 超限）：保留原文件，不覆盖。 */
	| { kind: "unreadable"; reason: string }
	/** 读得懂但与本次决定不一致：属于冲突，既不认领也不覆盖。 */
	| { kind: "conflict"; reason: string };

/**
 * 绑定路径上已有事件的裁决（**认领判定的唯一入口**，writer 与 recovery 共用）。
 *
 * - `missing`：这条事件确实不存在（唯一允许"生成新发布事实"的前置条件）；
 * - `claim`：已存在**完整合法且稳定决定字段一致**的事件 ⇒ 调用方原样保留其发布事实；
 * - `unreadable` / `conflict`：不可解释（坏 JSON/未来版本/链接/超限）或与本次决定不一致
 *   ⇒ 不认领、不覆盖（调用方按自己的阶段语义把它映射成"事件待补"或"矛盾现场"）。
 *
 * 为什么把"读事件 + 纯比较"合成一步：writer 与恢复器都必须**先认领已有事实**，
 * 而不是先构造/序列化一个新候选再去撞名——后者会让"认领"反过来依赖新候选的合法性
 * （恢复时钟回拨时新候选本身不合法，已有事实反而认领不了）。
 */
export async function inspectBoundEvent(boundary: StorageBoundary, record: ReviewJournalRecord, intent: AuditIntent, signal?: AbortSignal): Promise<ExistingEventOutcome> {
	const event = await readReviewEventArtifact(boundary, record.target.id, record.eventId, signal);
	if (!event.ok) {
		if (event.missing) return { kind: "missing" };
		return { kind: "unreadable", reason: `已有审计事件无法解释（${event.code}），未覆盖也未发布新事件：${event.message}` };
	}
	const association = compareAuditAssociation({ intent, projection: toReviewProjection(record), existingEvent: event.value, intentBytesHash: record.intentHash });
	if (!association.ok) return { kind: "conflict", reason: `已有事件与本次决定不一致（${association.code}）：${association.issues[0]?.message ?? ""}` };
	if (association.kind !== "claim") return { kind: "conflict", reason: "关联判定未返回认领（内部不一致）" };
	return { kind: "claim", fact: claimFact(association.event) };
}

/**
 * 恢复事件的记录时间策略（C2BR / R3）。
 *
 * `recordedAt` 是**发布事实**：宁可拒绝，也不把回拨的时钟"归一化"成决定时间——
 * 那等于伪造一条"事件恰好在决定时刻落盘"的结论（`recordedAt >= decidedAt` 与 writer 共用同一份判定）。
 *
 * 认领已有事件**不需要**新的 recordedAt，因此本函数只用在"确实要新发布"的路径上：
 * 本机时钟早于决定时间时返回拒绝理由，由调用方按"可重试的待补"上报。
 */
export function recoveryRecordedAt(now: number, decidedAt: number): { ok: true; recordedAt: number } | { ok: false; reason: string } {
	if (now < decidedAt) {
		return { ok: false, reason: `恢复时钟（${now}）早于决定时间（${decidedAt}）：拒绝发布一条记录时间早于决定的事件（不伪造发布事实），未发布、未写终态；请校准时钟后重试核对` };
	}
	return { ok: true, recordedAt: now };
}

/** 认领已有事件时返回的审计事实：**原样保留**其 publication/recordedAt。 */
export function claimFact(event: AuditEvent): ReviewAuditFact {
	return { eventId: event.eventId, relativePath: reviewEventRelativePath(event.target.recordId, event.eventId), publication: event.publication, recordedAt: event.recordedAt };
}

/** 由意图 + 实际发布路径/时间构造事件（`publication` 只由调用方按真实路径给出）。 */
export function buildReviewEvent(intent: AuditIntent, publication: AuditPublication, recordedAt: number): AuditEvent {
	return {
		auditVersion: AUDIT_SCHEMA_VERSION,
		eventId: intent.eventId,
		operationId: intent.operationId,
		target: intent.target,
		action: intent.action,
		fromStatus: intent.fromStatus,
		toStatus: intent.toStatus,
		operatorLabel: intent.operatorLabel,
		decidedAt: intent.decidedAt,
		reason: intent.reason,
		before: intent.before,
		after: intent.after,
		evidence: intent.evidence,
		publication,
		recordedAt,
	};
}

/** 提交前失败的**尽力**记账：写 `aborted`，失败则保留 prepared（与 C1 同一取舍：原错误优先）。 */
export async function abortPreparedReview(boundary: StorageBoundary, prepared: PreparedReviewJournal, now: number, signal: AbortSignal | undefined): Promise<{ note: string | null; artifactCleanup?: ArtifactCleanupFailure }> {
	const finalized = await finalizeReviewJournalEntry(boundary, prepared, { state: "aborted", source: "writer-confirmed", now: Math.max(now, prepared.record.preparedAt), signal });
	if (finalized.ok) {
		// 记账写成了，但临时文件没删掉：这条残留同样必须传回调用方（R4）。
		return finalized.cleanup === "failed" ? { note: null, artifactCleanup: artifactCleanupFailure("review-journal", prepared.relativePath) } : { note: null };
	}
	const reason = isCancelledError(finalized.error) ? "已取消" : "写入失败";
	// 记账失败时留下的临时文件同样必须可见（否则这条路径上的残留只存在于错误消息里）。
	const artifactCleanup = cleanupFailureFromError(finalized.error, "review-journal", prepared.relativePath);
	return {
		note: `审核 journal 终态未写入（${reason}，原错误优先）；本次留下 prepared 记录 ${prepared.relativePath}，可用 reconcileReviewOperation 核对后收口`,
		...(artifactCleanup === undefined ? {} : { artifactCleanup }),
	};
}

/** 数据已提交但审核 journal 终态未写入时的固定文案（含 operationId，便于直接核对）。 */
export function reviewNeedsRecoveryNote(operationId: string, reason: string): string {
	return `本次审核已提交（提交点已过），但审核 journal 终态未写入（${reason}）；operationId=${operationId}，请用 reconcileReviewOperation 核对后收口，不要重复提交同一 revision`;
}
