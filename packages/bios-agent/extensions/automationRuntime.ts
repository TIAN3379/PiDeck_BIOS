/**
 * AW-03/02：**自动化附属记录的落盘编排**（检查点、状态索引、摘要基线）。
 *
 * 这里只做编排：持久化原语在 `core/automation/store.ts`，纯策略在 `core/automation/policy.ts`。
 * 三条约束：
 * - CAS 冲突最多重读一次后重试（AW §8：自动保存冲突最多重读一次；语义冲突保留待处理）；
 * - 受保护记录占满预算时**停止新增**并如实回报，不静默删除；
 * - 任何失败都只降级"本次记忆能力"，不抛穿到普通 Agent。
 */
import { buildCheckpoint, hasUnsavedProgress, type ReflectionMarkContext } from "../core/automation/policy.ts";
import { AUTOMATION_LIMITS, stableRunId, type AutomationReceipt, type CheckpointOutcome, type CheckpointTaskLink, type CodeBaseline, type ExecutedFact, type ReflectionMark, type SummaryBaseline, type WorkspaceAutomationState } from "../core/automation/contract.ts";
import { initialWorkspaceState, isUnresolvedReceipt, persistCheckpointRecord, readWorkspaceState, recordAutomationReceipt as persistAutomationReceipt, recordUnrecoveredReceipt as persistUnrecoveredReceipt, writeWorkspaceState } from "../core/automation/store.ts";

export type AutomationTarget = {
	readonly root: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly signal?: AbortSignal;
	readonly now?: number;
};

export type PersistCheckpointResult = {
	/** `unchanged` = 同名检查点已存在（重复回调/重启重放，幂等成立）。 */
	readonly status: "created" | "unchanged" | "full" | "failed";
	readonly runId: string;
	readonly detail: string;
	/** 索引中当前检查点条数（调用方据此如实投影保存状态）。 */
	readonly indexed: number;
	/** 被轮换清理的检查点数量。 */
	readonly rotated: number;
};

/** 状态更新：读 → 改 → CAS 写；冲突最多重读一次。返回最终状态与是否失败。 */
async function updateState(target: AutomationTarget, mutate: (state: WorkspaceAutomationState) => { readonly next: WorkspaceAutomationState; readonly outcome: "updated" | "full" }): Promise<{ readonly status: "ok" | "full" | "failed"; readonly detail: string; readonly state: WorkspaceAutomationState | null }> {
	const now = target.now ?? Date.now();
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const read = await readWorkspaceState(target);
		if (read.status === "unsupported-version") return { status: "failed", detail: read.detail, state: null };
		if (read.status === "corrupt" || read.status === "denied") return { status: "failed", detail: `${read.status}：保留原字节等待人工核对`, state: null };
		const base = read.status === "ok" ? read.value : initialWorkspaceState({ projectId: target.projectId, workspaceId: target.workspaceId, now });
		const expected = read.status === "ok" ? read.value.revision : null;
		const mutated = mutate(base);
		if (mutated.outcome === "full") return { status: "full", detail: "受保护记录已占满近期集合预算：停止新增检查点，已有记录与普通开发继续", state: base };
		const written = await writeWorkspaceState({ ...target, state: mutated.next, expectedRevision: expected });
		if (written.status === "created" || written.status === "updated") return { status: "ok", detail: `revision ${written.revision}`, state: mutated.next };
		if (written.status !== "revision-conflict") return { status: "failed", detail: `状态写入失败：${written.status}`, state: null };
		// CAS 冲突：最多重读一次后重试。
	}
	return { status: "failed", detail: "状态并发冲突（已重读一次仍冲突）：本次不覆盖其它会话的结果", state: null };
}

/**
 * 落盘一次执行事实检查点，并把索引并入工作区状态。
 *
 * `runId` 由 session+branch+requestKey 派生 ⇒ 重复回调/重启重放命中同一文件，幂等成立。
 */
export async function persistCheckpoint(
	input: AutomationTarget & {
		readonly sessionId: string | null;
		readonly branch: string | null;
		/**
		 * **原始请求**的稳定标识（不含轮次分片）。
		 *
		 * D2：索引里的 `requestKey` 用它做"同请求旧记录收口"的分组键；轮次唯一性由
		 * `turnKey` 参与 `runId` 派生保证（旧实现把分片键并进 requestKey，导致分组失效）。
		 */
		readonly requestKey: string;
		/** 同一原始请求内的分片键（turn-N / settle）：让每轮都有可恢复的检查点。 */
		readonly turnKey: string;
		readonly baseline: CodeBaseline;
		readonly facts: readonly ExecutedFact[];
		readonly task: CheckpointTaskLink | null;
		readonly outcome: CheckpointOutcome;
		readonly pendingReflection: boolean;
	},
): Promise<PersistCheckpointResult> {
	const now = input.now ?? Date.now();
	const runId = stableRunId([input.sessionId, input.branch, input.requestKey, input.turnKey]);
	const checkpoint = buildCheckpoint({
		runId,
		projectId: input.projectId,
		workspaceId: input.workspaceId,
		sessionId: input.sessionId,
		requestKey: input.requestKey,
		recordedAt: now,
		baseline: input.baseline,
		executed: input.facts,
		task: input.task,
		outcome: input.outcome,
		pendingReflection: input.pendingReflection,
	});
	// R6：容量判定 → 发布文件 → CAS 索引 → 轮换清理，全部在同一次持锁组合操作里完成。
	const outcome = await persistCheckpointRecord({
		...input,
		checkpoint,
		// D2：只有"仍有唯一证据（待补记）"才显式保护；任务关联不等于永久保护——
		// 按 taskId 检索的权威依据由 `protectedRunIds` 保留"该任务最新一条"，同任务旧记录可轮换，
		// 否则正常使用几十轮就会把近期集合预算占满。
		protectedFromRotation: input.pendingReflection,
	});
	if (outcome.status === "full") return { status: "full", runId, detail: outcome.detail, indexed: outcome.indexed, rotated: 0 };
	if (outcome.status !== "created" && outcome.status !== "unchanged") return { status: "failed", runId, detail: outcome.detail, indexed: outcome.indexed, rotated: 0 };
	return { status: outcome.status, runId, detail: outcome.detail, indexed: outcome.indexed, rotated: outcome.rotatedOut.length };
}

/** R3：读回**耐久**的补记标记（重启后据此不重复创建，恢复中断补记最多一次）。 */
export async function readReflectionMarks(target: AutomationTarget): Promise<readonly ReflectionMark[]> {
	const read = await readWorkspaceState(target);
	return read.status === "ok" ? read.value.reflectionMarks : [];
}

/**
 * 写入持久补记标记。
 *
 * C3：`saved=true` 只在**真实写入成功**后写；未完成时同时记录 `attempts`，
 * 让重启后的恢复次数**有界**（不能把 `saved=false` 当成已处理，也不能无限重试）。
 */
export async function recordReflectionMark(
	input: AutomationTarget & { readonly requestKey: string; readonly runId: string; readonly saved: boolean; readonly attempts?: number; readonly finished?: boolean; readonly ownerBootId?: string; readonly ownerSessionId?: string | null },
): Promise<{ readonly status: "ok" | "failed"; readonly detail: string }> {
	const now = input.now ?? Date.now();
	const attempts = input.attempts ?? (input.saved ? 1 : 0);
	// D1：`finished` 是"阶段已终结"的判据（拿到真实完成回执或明确判定无法保存）。
	// 旧记录没有该字段时按 `saved === true` 推断，保持向后兼容。
	const finished = input.finished ?? input.saved;
	const updated = await updateState(input, (state) => {
		const previous = state.reflectionMarks.find((mark) => mark.requestKey === input.requestKey);
		// V2：所有者身份属于**写它的进程/会话**；调用方没给就沿用旧值，绝不用新进程冒充旧所有者。
		const ownerBootId = input.ownerBootId ?? previous?.ownerBootId;
		const ownerSessionId = input.ownerSessionId === undefined ? previous?.ownerSessionId : input.ownerSessionId;
		const mark: ReflectionMark = {
			requestKey: input.requestKey,
			runId: input.runId,
			recordedAt: now,
			saved: input.saved,
			attempts,
			finished,
			// V1：保留"已发过未恢复回执"这一事实（写回时不丢，避免重复刷屏）。
			...(previous?.unrecoveredAt === undefined ? {} : { unrecoveredAt: previous.unrecoveredAt }),
			...(ownerBootId === undefined ? {} : { ownerBootId }),
			...(ownerSessionId === undefined || ownerSessionId === null ? {} : { ownerSessionId }),
		};
		const marks = [mark, ...state.reflectionMarks.filter((entry) => entry.requestKey !== input.requestKey)].slice(0, AUTOMATION_LIMITS.maxReflectionMarks);
		// V3：标记真正收口后清除"未恢复"回执（它描述的是仍未处理的失败事实）。
		const stillUnresolved = marks.some((entry) => entry.unrecoveredAt !== undefined && entry.saved !== true && entry.finished !== true);
		const lastReceipt = !stillUnresolved && isUnresolvedReceipt(state.lastReceipt) ? null : state.lastReceipt;
		return { next: { ...state, reflectionMarks: marks, lastReceipt }, outcome: "updated" };
	});
	return updated.status === "ok" ? { status: "ok", detail: updated.detail } : { status: "failed", detail: updated.detail };
}

/**
 * V1（§13.2）：**原子**写入"未恢复回执 + 对应标记的 `unrecoveredAt`"。
 *
 * 与旧 `noteUnrecoveredMarks` 的区别：旧实现分两次写（回执一次、标记一次），任一失败就会
 * 留下自相矛盾的状态——实测过"回执没落盘、标记却全部落盘"。这里交给存储层在**同一次 CAS**内提交，
 * 并返回**实际**被打上标记的请求键；调用方只在这些键上同步内存"已通知"，写失败一律返回空。
 */
export async function commitUnrecoveredReceipt(
	input: AutomationTarget & { readonly receipt: AutomationReceipt; readonly requestKeys: readonly string[]; readonly at: number; readonly terminationContext?: ReflectionMarkContext },
): Promise<{ readonly status: "ok" | "failed"; readonly detail: string; readonly noted: readonly string[] }> {
	return persistUnrecoveredReceipt(input);
}

/**
 * D2：写入/清除**耐久回执**（容量满、写入失败、补记只完成一部分）。
 *
 * 与 `recordReflectionMark` 分开：回执描述的是"受限/失败"这一独立事实，
 * 宿主默认面板据此显示真实状态，而不是靠私有变量在内存里转述。
 */
export async function recordAutomationReceipt(input: AutomationTarget & { readonly receipt: AutomationReceipt | null }): Promise<{ readonly status: "ok" | "failed"; readonly detail: string }> {
	return persistAutomationReceipt(input);
}

/** 写回摘要基线（增量：只保存分支/HEAD 与关键文件 hash）。 */
export async function storeSummaryBaseline(input: AutomationTarget & { readonly baseline: SummaryBaseline }): Promise<{ readonly status: "ok" | "failed"; readonly detail: string }> {
	const updated = await updateState(input, (state) => ({ next: { ...state, summaryBaseline: input.baseline }, outcome: "updated" }));
	return updated.status === "ok" ? { status: "ok", detail: updated.detail } : { status: "failed", detail: updated.detail };
}

/** 读取摘要基线（`null` 表示没有/不可用，不猜）。 */
export async function readSummaryBaseline(target: AutomationTarget): Promise<SummaryBaseline | null> {
	const read = await readWorkspaceState(target);
	return read.status === "ok" ? read.value.summaryBaseline : null;
}

/** 本轮是否有未保存的重要进展（只读调查也算，见 core 策略注释）。 */
export function needsReflection(facts: readonly ExecutedFact[]): boolean {
	return hasUnsavedProgress(facts);
}
