/**
 * 审核操作的**只读核对与显式收口**（BM-02C2B / C2B-3）。
 *
 * 这是审核路径上唯一允许改文件的入口，因此第一条规则与 C1 相同：
 * **只有对同一个受控目标取到"写入方用的那把协作锁"并重新读取之后，才允许下结论。**
 * 只读巡检（`inspect.ts`）的观察**不是**提交归属的证明。
 *
 * 顺序（C2AR 修正后的唯一版本）：
 *
 * ```text
 * 锁前只读定位 → 取目标锁 → 持锁复读 journal + 目标
 * → 先验证关联（意图原字节指纹 + 事件绑定）
 * → 目标 = after：发布或认领事件 → 再写完成终态
 * → 目标 = before：aborted（**不发事件**）
 * → 既非 before 也非 after：conflict（不改业务、不发事件、不猜补完）
 * → 释放自有锁
 * ```
 *
 * 保守原则（宁可报"无法判定"也不猜）：意图/事件缺失或不可解释、关联不一致、
 * 目标坏 JSON/未来版本/链接/超限 → **不发布、不收口**，保留证据交人工；
 * 锁被他人持有 → `busy`，不抢锁、不删锁、不按 PID/mtime/年龄回收。
 *
 * 与 C1 的分工：本入口只认 **v2**；拿到合法 v1 时明确返回 `not-review`，
 * 既不按 v1 收口，也不"读不懂就当审核处理"。旧 `reconcileJournalOperation` 对 v2
 * 继续按未知版本拒绝（现状即如此），两个入口并存、互不越界。
 */
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { attachCleanupNote, CLEANUP_FAILED_NOTE } from "../commit.ts";
import { AUDIT_MAX_DATE_MS, compareAuditAssociation, type AuditIntent } from "../../contracts/index.ts";
import { isCancelledError, isStorageError, StorageError } from "../errors.ts";
import { isJournalOperationId, journalRelativePath, journalRelativeSegments } from "../journal/index.ts";
import { acquireStorageLock, type LockReleaseOutcome } from "../lock.ts";
import type { StorageLimits } from "../limits.ts";
import { interpretRecord, recordRelativeSegments } from "../records.ts";
import {
	artifactCleanupFailure,
	attachArtifactCleanupNote,
	cleanupFailureFromError,
	finalizeReviewJournalEntry,
	publishReviewEventArtifact,
	readReviewEventArtifact,
	readReviewIntentArtifact,
	readReviewJournalArtifact,
	reviewEventRelativePath,
	type ArtifactCleanupFailure,
	type PreparedReviewJournal,
	type ReviewEventPublishOutcome,
} from "./artifacts.ts";
import { buildReviewEvent, inspectBoundEvent, recoveryRecordedAt, type ExistingEventOutcome } from "./commitSteps.ts";
import { toReviewProjection, type ReviewAuditFact, type ReviewJournalRecord, type ReviewJournalState, type ReviewJournalTarget } from "./contract.ts";

/** 终态写入的观察来源（绝不冒充 `writer-confirmed`）。 */
const RECOVERY_SOURCE = "recovery-observed" as const;
/** 锁没删掉时的固定诊断（结论仍然有效，但必须让人看到残留锁）。 */
const LOCK_RELEASE_FAILED_NOTE = "核对使用的锁未正常释放；锁目录可能残留，人工确认后再处理后续写入";

/**
 * 核对结论。
 *
 * - `committed` / `aborted` / `conflict`：三种终态（`conflict` 也需要人看）；
 * - `unreadable`：读不懂（journal／意图／事件／目标），**未改任何文件**；
 * - `inconsistent`：读得懂但**对不上**（完成终态缺事件、关联不一致、目标与事件矛盾），需要人工判断；
 * - `pending`：**阶段真相**（C2BR / R3）——业务已被观察为 `after`，但审计事件或完成终态还没写成；
 *   现场未改动、可重试（`audit`/`observed` 如实给出当时已知的事实）。它在语义上**不是**失败：
 *   用一个普通异常或 `committed` 表示它，都会让调用方误判"业务没提交"或"已经全部完成"。
 * - `busy`：目标锁被他人持有；
 * - `not-review`：这不是审核 v2（例如普通写 v1），请用对应入口。
 */
export type ReconcileReviewOutcome = "committed" | "aborted" | "conflict" | "unreadable" | "inconsistent" | "pending" | "busy" | "not-review";

export type ReconcileReviewOptions = {
	root: string;
	operationId: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试）。 */
	ioHooks?: StorageIoHooks;
	/** 可注入时钟（测试用）。 */
	now?: number;
	lockTimeoutMs?: number;
	lockPollMs?: number;
};

export type ReconcileReviewResult = {
	readonly operationId: string;
	readonly relativePath: string;
	readonly outcome: ReconcileReviewOutcome;
	/** 收口后读到的状态；不可判定时为读到的状态或 `null`。 */
	readonly journalState: ReviewJournalState | null;
	/** 持锁复读到的目标指纹；不可判定时为 `null`。 */
	readonly observed: { readonly revision: number | null; readonly hash: string | null } | null;
	readonly target: ReviewJournalTarget | null;
	/** 本次是否写入了终态（幂等返回时为 false）。 */
	readonly changed: boolean;
	/** 本次确认/发布的审计事实；`null` 表示这次没有可报告的事件（不是"事件一定不存在"）。 */
	readonly audit: ReviewAuditFact | null;
	/** 已经发生的**工件**临时文件清理失败（空数组 = 本次没有任何工件残留，逐件列出，见 C2BR / R4）。 */
	readonly artifactCleanup: readonly ArtifactCleanupFailure[];
	readonly warnings?: readonly string[];
	/** 受控说明（不含正文）。 */
	readonly detail?: string;
};

export async function reconcileReviewOperation(options: ReconcileReviewOptions): Promise<ReconcileReviewResult> {
	if (!isJournalOperationId(options.operationId)) {
		throw new StorageError("invalid-record", `operationId 必须是规范的小写 UUID：${String(options.operationId)}`, { detail: "invalid-operation-id" });
	}
	const relativePath = journalRelativePath(options.operationId);
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	const now = options.now ?? Date.now();
	// 恢复时钟是**参数**：非法值属于调用方错误，可以结构化抛出（与"现场不可信"区分）。
	if (!Number.isSafeInteger(now) || now < 0 || now > AUDIT_MAX_DATE_MS) {
		throw new StorageError("invalid-record", `核对时钟必须是 Date 可表示范围内的安全整数（epoch ms）：${String(options.now)}`, { detail: "invalid-review-clock" });
	}

	const read = await readReviewJournalArtifact(boundary, options.operationId, options.signal);
	if (!read.ok) {
		if (read.missing) throw new StorageError("not-found", `审核 journal 不存在：${relativePath}`, { path: relativePath });
		// v1 / 未知版本 / 坏文件：一律**不动作**（保留原文件），用 outcome 说清是哪一种。
		return {
			operationId: options.operationId,
			relativePath,
			outcome: read.kind === "v1" ? "not-review" : "unreadable",
			journalState: null,
			observed: null,
			target: null,
			changed: false,
			audit: null,
			artifactCleanup: [],
			detail: read.message,
		};
	}

	if (read.record.state !== "prepared") {
		return await verifyTerminalState(boundary, read.record, relativePath, options.signal);
	}

	const targetPath = boundary.resolve(...recordRelativeSegments("experience-card", read.record.target.id));
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
			target: read.record.target,
			changed: false,
			audit: null,
			artifactCleanup: [],
			detail: "目标锁被他人持有（或归属无法证明），不抢占、不修改任何文件；请人工确认后再核对",
		};
	}

	let result: ReconcileReviewResult | undefined;
	let failure: unknown;
	let lockRelease: LockReleaseOutcome = "released";
	try {
		result = await reconcileUnderLock(boundary, {
			operationId: options.operationId,
			relativePath,
			target: read.record.target,
			targetKey: read.record.target.id,
			targetPath,
			now,
			signal: options.signal,
		});
	} catch (error) {
		failure = error;
	} finally {
		lockRelease = await lock.release().catch((): LockReleaseOutcome => "failed");
	}

	// **首错优先**（与 C1R/J3 同规则）：清理失败只作为附加诊断，绝不覆盖真实失败原因。
	if (failure !== undefined) throw lockRelease === "released" ? failure : attachCleanupNote(failure, LOCK_RELEASE_FAILED_NOTE);
	if (result === undefined) throw new StorageError("invalid-record", "核对流程未产生结论（内部不一致）", { path: relativePath });
	if (lockRelease !== "released") return { ...result, warnings: [...(result.warnings ?? []), LOCK_RELEASE_FAILED_NOTE] };
	return result;
}

/* ------------------------------------------------------------------ 终态：只核对，不重放 */

/**
 * 已有终态时的**无条件成功**是被禁止的：必须核对它所绑定的意图与事件。
 *
 * 刻意**不**要求"当前业务仍停在旧 after"：后续合法更新不应让一次历史审核失效，
 * 审核事实属于那一刻的 revision（这一点与 C1 的"目标必须等于 after"不同）。
 */
async function verifyTerminalState(boundary: StorageBoundary, record: ReviewJournalRecord, relativePath: string, signal: AbortSignal | undefined): Promise<ReconcileReviewResult> {
	const base = { operationId: record.operationId, relativePath, target: record.target, changed: false, artifactCleanup: [] as readonly ArtifactCleanupFailure[] };

	if (record.state === "aborted") {
		// 未提交的操作**不该**有事件；异常存在时必须说明不一致，而不是静默成功。
		const event = await readReviewEventArtifact(boundary, record.target.id, record.eventId, signal);
		if (event.ok) {
			return { ...base, outcome: "inconsistent", journalState: "aborted", observed: null, audit: null, detail: "journal 记为未提交，但同 eventId 的事件存在：需要人工判断是否删除或收口" };
		}
		if (event.missing) return { ...base, outcome: "aborted", journalState: "aborted", observed: null, audit: null };
		return { ...base, outcome: "unreadable", journalState: "aborted", observed: null, audit: null, detail: `未提交的操作存在无法解释的事件文件：${event.message}` };
	}

	if (record.state === "conflict") {
		return { ...base, outcome: "conflict", journalState: "conflict", observed: null, audit: null, detail: "journal 已记为冲突，需人工核对后再决定" };
	}

	const binding = await verifyReviewBinding(boundary, record, signal);
	if (!binding.ok) return { ...base, outcome: "inconsistent", journalState: "committed", observed: null, audit: null, detail: `完成终态与审计工件不一致：${binding.reason}` };
	return { ...base, outcome: "committed", journalState: "committed", observed: null, audit: binding.audit };
}

/* ------------------------------------------------------------------ 持锁阶段 */

type UnderLockInput = {
	operationId: string;
	relativePath: string;
	target: ReviewJournalTarget;
	/** 持锁目标的受控身份（experience-card 的 id），用于与复读结果比对。 */
	targetKey: string;
	targetPath: string;
	now: number;
	signal?: AbortSignal;
};

async function reconcileUnderLock(boundary: StorageBoundary, input: UnderLockInput): Promise<ReconcileReviewResult> {
	const base = { operationId: input.operationId, relativePath: input.relativePath, target: input.target };
	/** 工件清理失败的逐件账本（R4）：空数组 = 本次没有留下任何工件残留。 */
	const artifactCleanup: ArtifactCleanupFailure[] = [];
	const recordCleanup = (failure: ArtifactCleanupFailure | undefined): void => {
		if (failure !== undefined) artifactCleanup.push(failure);
	};

	// ① 持锁后**重新读取** journal：另一个恢复者可能已经收口，此时必须幂等返回。
	const reread = await readReviewJournalArtifact(boundary, input.operationId, input.signal);
	if (!reread.ok) {
		return { ...base, outcome: "unreadable", journalState: null, observed: null, changed: false, audit: null, artifactCleanup, detail: `持锁期间 journal 变为不可读：${reread.message}` };
	}

	// ② **先确认锁定身份/绑定，再判状态**（R2）：journal 是根内可被外部改写的文件，
	//    "读 journal"与"创建锁目录"之间存在窗口；拿 A 的锁给 B 记账等于假结论（C1R/J1）。
	//    顺序也影响结论本身：若先处理终态，一个"被换成别的目标并写成终态"的 journal
	//    会被当成"已经收口，幂等返回"，把换目标这件事静默掉。
	if (reread.record.target.id !== input.targetKey) {
		return {
			...base,
			target: reread.record.target,
			outcome: "unreadable",
			journalState: reread.record.state,
			observed: null,
			changed: false,
			audit: null,
			artifactCleanup,
			detail: `持锁期间 journal 的受控目标发生变化（锁=${input.targetKey}，journal=${reread.record.target.id}）；未修改任何文件，请人工确认`,
		};
	}

	if (reread.record.state !== "prepared") {
		const terminal = await verifyTerminalState(boundary, reread.record, input.relativePath, input.signal);
		return { ...terminal, observed: null, artifactCleanup };
	}

	const record = reread.record;
	let observed: { revision: number | null; hash: string | null };
	try {
		observed = await readReviewTargetFingerprint(boundary, input.targetPath, record.target.id, input.signal);
	} catch (error) {
		if (isCancelledError(error)) throw error;
		const detail = isStorageError(error) ? `${error.code}${error.detail ? `（${error.detail}）` : ""}` : "无法判定";
		return { ...base, outcome: "unreadable", journalState: record.state, observed: null, changed: false, audit: null, artifactCleanup, detail: `目标不可判定（${detail}）；已保留证据，未修改 journal 与目标` };
	}

	const matchesAfter = observed.revision === record.after.revision && observed.hash === record.after.hash;
	const matchesBefore = observed.revision === record.before.revision && observed.hash === record.before.hash;

	// ③ **任何终态（committed / aborted / conflict）之前都必须先过完整绑定**（R2 / C2BR2 F1）：
	//    意图实测字节指纹 + operationId/eventId/target/before/after 逐项与已验证的完整 v2 比较
	//    （复用 `compareAuditAssociation`，不存在事件时传 null）。
	//    这不是"多一层检查"而是**顺序**问题：把 conflict 放在前面时，一次不可解释/错绑定的现场
	//    会被写成可幂等返回的终态——此后核对只走 `verifyTerminalState` 的 conflict 分支，
	//    第一层的绑定问题（意图被删/被换/版本不认识）再也看不见，`changed=true` 还让人以为已收口。
	const binding = await loadBoundIntent(boundary, record, input.signal);
	if (!binding.ok) {
		// 结论一律 `inconsistent`，与"目标=after"时同一口径：**绑定失败的分类不随目标指纹分支漂移**
		// （意图缺失、坏 JSON、未来版本、指纹/逐项不符都属于"journal 绑的决定与磁盘工件对不上"，
		//   要人工判断）。`unreadable` 留给读不懂的**目标文件**（坏 journal、坏事件路径、业务不可判定）。
		return { ...base, outcome: "inconsistent", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: `拒绝收口：${binding.reason}` };
	}

	// ④ 目标既不是 before 也不是 after：**绑定已验证**，按协议记 conflict
	//    （合法意图 + 目标后续合法更新是正常现场，不能因为上面的负例而取消这条收口）。
	if (!matchesAfter && !matchesBefore) {
		const detail = `目标既不是 before（revision=${record.before.revision}）也不是 after（revision=${record.after.revision}），需人工核对`;
		return await finalizeReview(boundary, record, input, "conflict", null, detail, observed, artifactCleanup);
	}

	if (matchesBefore) {
		// ⑤ 未提交操作**第一次**就要把矛盾报出来（R2）：精确读取 journal 绑定的 event 路径
		//    （由 recordId/eventId 派生，不需要全目录扫描），只在"事件确实缺失"时才允许 aborted。
		const existing = await inspectBoundEvent(boundary, record, binding.intent, input.signal);
		if (existing.kind === "claim" || existing.kind === "conflict") {
			return {
				...base,
				outcome: "inconsistent",
				journalState: record.state,
				observed,
				changed: false,
				audit: null,
				artifactCleanup,
				detail: `目标仍停在 before（视为未提交），但同 eventId 的审计事件已经存在：${existing.kind === "conflict" ? existing.reason : "事件与本次决定一致"}；不写 aborted、不删事件，请人工判断`,
			};
		}
		if (existing.kind === "unreadable") {
			return { ...base, outcome: "unreadable", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: `目标停在 before，但事件路径上存在无法解释的文件：${existing.reason}` };
		}
		return await finalizeReview(boundary, record, input, "aborted", null, "目标与 before 一致且事件确实缺失：视为未提交，不补发审计事件、不自动完成旧操作", observed, artifactCleanup);
	}

	// ⑤ 目标与 after 一致：**先认领已有事实**（R3），只在事件确实缺失时才生成 recovery 发布事实。
	const existing = await inspectBoundEvent(boundary, record, binding.intent, input.signal);
	if (existing.kind === "unreadable") {
		return { ...base, outcome: "unreadable", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: `审计事件路径上存在无法解释的文件，不认领也不覆盖：${existing.reason}` };
	}
	if (existing.kind === "conflict") {
		return { ...base, outcome: "inconsistent", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: `已有审计事件与本次决定不一致：${existing.reason}` };
	}
	if (existing.kind === "claim") {
		// 认领：不构造新候选、不尝试发布、**不受本次时钟回拨或新候选序列化预算影响**。
		return await finalizeReview(boundary, record, input, "committed", existing.fact, "目标与 after 一致且已有审计事实：直接认领其原始 publication/recordedAt（不改写、不重打时间）", observed, artifactCleanup);
	}

	// 事件确实缺失 ⇒ 才允许生成 recovery 发布事实；此时才需要校验恢复时钟。
	const clock = recoveryRecordedAt(input.now, binding.intent.decidedAt);
	if (!clock.ok) {
		return { ...base, outcome: "pending", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: clock.reason };
	}

	let publishedEvent: ReviewEventPublishOutcome;
	try {
		publishedEvent = await publishReviewEventArtifact(boundary, buildReviewEvent(binding.intent, "recovery", clock.recordedAt), input.signal);
	} catch (error) {
		// 先把已经发生的清理取回来，再决定"穿透取消"还是"转成待补"（C2BR2 / F2）：
		// **未发布前取消可穿透**（此时还没有任何"已被承认的事实"需要保住），
		// 但取消不能顺带把"事件临时文件没删掉"这件事从诊断里抹掉。
		const eventCleanup = cleanupFailureFromError(error, "event", reviewEventRelativePath(record.target.id, record.eventId));
		if (isCancelledError(error)) throw eventCleanup === undefined ? error : attachArtifactCleanupNote(error, "event", eventCleanup.relativePath);
		recordCleanup(eventCleanup);
		const code = isStorageError(error) ? `${error.code}${error.detail ? `（${error.detail}）` : ""}` : "unexpected";
		return {
			...base,
			outcome: "pending",
			journalState: record.state,
			observed,
			changed: false,
			audit: null,
			artifactCleanup,
			warnings: artifactCleanup.map((entry) => entry.note),
			detail: `审计事件发布失败（${code}）：业务已确认提交到 after（revision=${record.after.revision}），事件与完成终态待补；现场未改动，可重试核对，不要让异常暗示业务未提交`,
		};
	}

	// `exists` 与 `created` 都会产生并尝试清理一个临时文件：清理结果必须在**两个分支**都记下来（R4）。
	recordCleanup(publishedEvent.cleanup === "failed" ? artifactCleanupFailure("event", publishedEvent.relativePath) : undefined);
	let audit: ReviewAuditFact;
	if (publishedEvent.status === "exists") {
		// 撞名（另一个恢复者刚发布）：**不覆盖**，按认领规则重读一次。
		let raced: ExistingEventOutcome;
		try {
			raced = await inspectBoundEvent(boundary, record, binding.intent, input.signal);
		} catch (error) {
			// 提前退出（取消 / 读取失败）：已经取得的清理事实必须留在错误里（C2BR2 / F2），
			// 否则调用方只看到"取消"，磁盘上的 `.tmp` 变成无人知晓的残留。
			throw publishedEvent.cleanup === "failed" ? attachArtifactCleanupNote(error, "event", publishedEvent.relativePath) : error;
		}
		if (raced.kind !== "claim") {
			const why = raced.kind === "missing" ? "事件在发布瞬间又消失（撞名后读不到），现场不可解释" : raced.reason;
			return { ...base, outcome: "inconsistent", journalState: record.state, observed, changed: false, audit: null, artifactCleanup, detail: `事件在发布瞬间已存在且不能认领：${why}` };
		}
		audit = raced.fact;
	} else {
		audit = { eventId: record.eventId, relativePath: publishedEvent.relativePath, publication: "recovery", recordedAt: clock.recordedAt };
	}

	return await finalizeReview(boundary, record, input, "committed", audit, "目标与 after 一致：先确认审计事实，再写完成终态（不重放记录、不递增 revision）", observed, artifactCleanup);
}

/**
 * 写终态并把清理/失败**按阶段**如实带进结论。
 *
 * 两条硬规则：
 * - 终态**没写成**时结论是 `pending`（不是 `committed`/`aborted`/`conflict`）：把"journal 还是 prepared"
 *   说成"已经收口"会让调用方以为无需再核对（R3）。已知的审计事实照实返回，不因终态失败而丢弃；
 * - 工件清理失败逐件进入 `artifactCleanup` 与 `warnings`（R4）。
 */
async function finalizeReview(
	boundary: StorageBoundary,
	record: ReviewJournalRecord,
	input: UnderLockInput,
	state: "committed" | "aborted" | "conflict",
	audit: ReviewAuditFact | null,
	detail: string,
	observed: { revision: number | null; hash: string | null } | null = null,
	artifactCleanup: readonly ArtifactCleanupFailure[] = [],
): Promise<ReconcileReviewResult> {
	const prepared: PreparedReviewJournal = { operationId: record.operationId, path: boundary.resolve(...journalRelativeSegments(record.operationId)), relativePath: input.relativePath, record, cleanup: "ok" };
	const finalized = await finalizeReviewJournalEntry(boundary, prepared, { state, source: RECOVERY_SOURCE, now: Math.max(input.now, record.preparedAt), signal: input.signal });
	const cleanups: ArtifactCleanupFailure[] = [...artifactCleanup];
	const warnings: string[] = [];
	if (!finalized.ok) {
		const code = isStorageError(finalized.error) ? finalized.error.code : "未知错误";
		const failure = cleanupFailureFromError(finalized.error, "review-journal", input.relativePath);
		if (failure !== undefined) cleanups.push(failure);
		warnings.push(...cleanups.map((entry) => entry.note));
		warnings.push(`审核 journal 终态未写入（${code}）；journal 仍是 prepared，可稍后重试核对`);
		return { operationId: record.operationId, relativePath: input.relativePath, target: record.target, outcome: "pending", journalState: record.state, observed, changed: false, audit, artifactCleanup: cleanups, warnings, detail };
	}
	if (finalized.cleanup === "failed") {
		cleanups.push(artifactCleanupFailure("review-journal", input.relativePath));
		warnings.push(CLEANUP_FAILED_NOTE);
	}
	warnings.push(...cleanups.map((entry) => entry.note));
	return { operationId: record.operationId, relativePath: input.relativePath, target: record.target, outcome: state, journalState: state, observed, changed: true, audit, artifactCleanup: cleanups, detail, ...(warnings.length > 0 ? { warnings } : {}) };
}

/* ------------------------------------------------------------------ 关联与目标 */

/** 读目标经验卡的真实字节指纹；不存在返回 `{null,null}`（与 v2 的"非空指纹"必然不匹配）。 */
async function readReviewTargetFingerprint(boundary: StorageBoundary, absolutePath: string, recordId: string, signal: AbortSignal | undefined): Promise<{ revision: number | null; hash: string | null }> {
	let value: unknown;
	let fingerprint: string;
	try {
		({ value, fingerprint } = await boundary.readJson(absolutePath, boundary.limits.maxRecordBytes, signal));
	} catch (error) {
		if (isCancelledError(error)) throw error;
		if (isStorageError(error) && error.code === "not-found") return { revision: null, hash: null };
		throw error;
	}
	// 解释规则与读取路径**同源**：只读 revision 会把"坏 JSON/未来版本/身份不符"洗成一次
	// "合法但不同的一版"（conflict），那是把坏数据当正常判定（C1R/J2）。
	const interpreted = interpretRecord("experience-card", value, { id: recordId });
	if (!interpreted.ok) throw new StorageError(interpreted.problem.code, `目标记录无法解释：${interpreted.problem.message}`, { path: absolutePath, detail: "invalid-target" });
	return { revision: interpreted.record.revision, hash: fingerprint };
}

/**
 * 从 journal 的绑定加载并**完整核对**意图（R2）。
 *
 * 复用纯比较入口（`compareAuditAssociation`）而不是手写几条相等判断：投影来自**已验证的完整 v2**，
 * `intentBytesHash` 来自本次**实测的意图字节**，不存在事件时传 `null`（得到 `publish`）。
 * 于是 operationId / eventId / target / before / after 与"声明指纹 == 实测指纹"被**逐项**比对——
 * 这是"能不能按这条意图发布人工决定"的唯一判据。
 *
 * 旧实现只比了实测指纹、文件名 operationId 与 eventId，于是"改掉意图的
 * target/before/after 并把 journal.intentHash 更新为新文件的真实 hash"能一路发布成功（第十二轮验收 R2）。
 */
async function loadBoundIntent(boundary: StorageBoundary, record: ReviewJournalRecord, signal: AbortSignal | undefined): Promise<{ ok: true; intent: AuditIntent } | { ok: false; reason: string }> {
	const intent = await readReviewIntentArtifact(boundary, record.operationId, signal);
	if (!intent.ok) return { ok: false, reason: `审核意图${intent.missing ? "缺失" : `不可解释（${intent.code}）`}：${intent.message}` };
	const association = compareAuditAssociation({ intent: intent.value, projection: toReviewProjection(record), existingEvent: null, intentBytesHash: intent.hash });
	if (!association.ok) return { ok: false, reason: `意图与 journal 绑定不一致（${association.code}）：${association.issues[0]?.message ?? ""}` };
	if (association.kind !== "publish") return { ok: false, reason: "关联判定未返回发布（内部不一致）" };
	return { ok: true, intent: intent.value };
}

/** 校验"journal ↔ 意图 ↔ 已有事件"三方绑定，成功时返回可直接上报的审计事实。 */
async function verifyReviewBinding(boundary: StorageBoundary, record: ReviewJournalRecord, signal: AbortSignal | undefined): Promise<{ ok: true; audit: ReviewAuditFact } | { ok: false; reason: string }> {
	const loaded = await loadBoundIntent(boundary, record, signal);
	if (!loaded.ok) return loaded;
	const existing = await inspectBoundEvent(boundary, record, loaded.intent, signal);
	if (existing.kind === "claim") return { ok: true, audit: existing.fact };
	if (existing.kind === "missing") return { ok: false, reason: `审计事件缺失：${reviewEventRelativePath(record.target.id, record.eventId)}` };
	return { ok: false, reason: existing.reason };
}
