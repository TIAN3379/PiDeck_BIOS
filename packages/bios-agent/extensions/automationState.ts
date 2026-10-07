/**
 * AW：**自动化的会话级运行时状态**（进程内、按会话隔离；预算与阶段状态不落盘）。
 *
 * 与"持久宿主许可"分开：
 * - 持久许可（`config.automation`）表示"用户允许什么"；本模块只读取它；
 * - 本模块保存的仍是**临时会话状态**（会话身份、已发生的事实、请求预算、补记阶段、本会话撤回），
 *   绝不继承其它会话的工具回执，也不跨 runtime 复用。
 *
 * C1/C2/C3：**预算归属单个原始请求**，补记阶段有独立身份与硬权限；"已保存"只认真实写入回执。
 */
import { randomUUID } from "node:crypto";
import { AUTOMATION_LIMITS, stableRunId, type AutomationCapability, type CheckpointOutcome, type ExecutedFact, type ReflectionMark } from "../core/automation/contract.ts";
import { classifyReflectionTool } from "../core/automation/policy.ts";
import type { BiosHostConfig } from "./hostConfig.ts";

/**
 * V2：**本进程启动标识**（扩展所在 pi 进程；模块级常量 ⇒ 同一进程内稳定、重启必换）。
 *
 * 用途：耐久补记标记记下"谁写的"。只有所有者进程已经不在（boot 不同）或同一会话已被
 * 新请求取代时，才有可信依据把一条未终结补记判成"未恢复"；别的会话的 settle 不能替它判定。
 */
const AUTOMATION_BOOT_ID = randomUUID();

/** 当前进程启动标识（供未恢复判定与测试使用）。 */
export function currentAutomationBootId(): string {
	return AUTOMATION_BOOT_ID;
}

/** 会话身份与范围：任一变化即视为新会话（旧事实与预算不继承）。 */
export type AutomationIdentity = {
	readonly sessionId: string | null;
	/** 可信配置指纹 + 目录 + 项目 + 工作区：范围变化的判定依据。 */
	readonly scopeKey: string | null;
	readonly projectId: string | null;
	readonly workspaceId: string | null;
	readonly cwd: string;
};

const EMPTY_IDENTITY: AutomationIdentity = { sessionId: null, scopeKey: null, projectId: null, workspaceId: null, cwd: "" };

/** 一条已入账的真实工具事实（带 toolCallId 以便去重）。 */
export type RecordedFact = ExecutedFact & { readonly callId: string | null };

/**
 * 一次"自动准备"的快照（R1）。
 *
 * 它是**授权复验的锚点**：注入时必须逐项与当前事实比对，任一项不同就丢弃本次准备，
 * 而不是继续复用旧正文（撤权/换端点/换模型/换会话/换目录都必须立即失效）。
 */
export type PreparedContextSnapshot = {
	/** 原始请求键（含自增序号，同前缀 prompt 不会互相覆盖）。 */
	readonly requestKey: string;
	/** 准备时的范围键（含可信配置指纹 + 目录 + 项目 + 工作区）。 */
	readonly scopeKey: string;
	readonly configFingerprint: string;
	readonly sessionId: string | null;
	readonly cwd: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly taskId: string | null;
	readonly preparedAt: number;
	/** 本次准备是否带有**项目资料正文**（未授权时不得注入；为空则无需复验正文）。 */
	readonly carriesProjectData: boolean;
};

/**
 * C1：**单个原始请求**的预算。
 *
 * 旧实现把 `stagesRequested/providerRequests/writeCalls` 放在会话级变量里，
 * 于是同一会话的第二个、第三个原始请求永远拿不到补记预算（第三轮调查不再补记）。
 */
export type RequestBudget = {
	readonly requestKey: string;
	stagesRequested: number;
	/** 该原始请求内**实际**发生的 provider 请求数（由 `context` 钩子计数，含补记阶段）。 */
	providerRequests: number;
	/** 补记阶段内的 BIOS 写入次数（原始调查的写入不计入补记预算）。 */
	writeCalls: number;
};

/**
 * C3：补记阶段状态。
 *
 * `id` 含请求键与阶段序号：检查点/轮次身份都带上它，补记 continuation 的 `turnIndex`
 * 重新开始也不会与原始阶段碰撞。
 */
export type ReflectionStage = {
	/** 稳定阶段身份：`<requestKey>#<n>`。 */
	readonly id: string;
	readonly requestKey: string;
	readonly startedAt: number;
	/** 阶段内实际 provider 请求数。 */
	providerRequests: number;
	writeCalls: number;
	/** **只有真实 BIOS 写入回执**（任务/草稿成功落盘）才置 true。 */
	saved: boolean;
	/** 阶段内从真实回执得到的任务 ID（新建任务当轮即可回链）。 */
	taskId: string | null;
	/** 指令是否已经交给模型（尚未消费时 `context` 必须保留它）。 */
	instructionPending: boolean;
	/** 阶段是否已在 settle 边界终结（不再开启第二个阶段）。 */
	settled: boolean;
};

/** 补记阶段工具权限判定结果。 */
export type ReflectionToolDecision = { readonly blocked: boolean; readonly reason: string | null; readonly terminate: boolean };

let identity: AutomationIdentity = { ...EMPTY_IDENTITY };
let currentRequestKey: string | null = null;
/**
 * D1：当前原始请求的**用户 entry 身份**（`ctx.sessionManager.getLeafId()`）。
 *
 * 为什么需要：会话内自增序号在新进程里从 0 重来，同样的 prompt 前缀会派生出与重启前
 * **完全相同**的请求键，于是"新请求"被旧耐久标记判成"已处理"，既不补记也不恢复。
 * entry 身份是持久事实：同一个用户 entry 重放时保持同一键（幂等），新 entry 必然是新键。
 */
let currentEntryIdentity: string | null = null;
let revoked = false;
let facts: RecordedFact[] = [];
let pending = false;
let outcome: CheckpointOutcome = "in-progress";
/** 已经完成自动检索的请求键（有界）。 */
let retrievedRequests: string[] = [];
/** 本会话内原始请求的自增序号（R3：同前缀 prompt 不冲突、补记阶段不占新号）。 */
let requestSequence = 0;
/** 最近一次自动准备的快照（注入前必须复验）。 */
let prepared: PreparedContextSnapshot | null = null;
/** C1：当前原始请求的预算（新请求开始时归零）。 */
let budget: RequestBudget | null = null;
/** 当前补记阶段（没有则为 null）。 */
let reflection: ReflectionStage | null = null;
/** 刚结束、等待 `agent_settled` 写完成回执的阶段。 */
let finishedStage: ReflectionStage | null = null;
/** 本轮从真实回执得到的任务 ID（原始调查或补记阶段都算）。 */
let runTaskId: string | null = null;
/** V2：耐久标记的所有者身份（写它的进程与会话）。 */
type DurableMarkOwner = { readonly ownerBootId: string; readonly ownerSessionId: string | null };

/** C3/D1/V2：持久补记标记的内存视图（`{ saved, attempts, finished, unrecoveredAt, owner* }`）。 */
type DurableMark = { saved: boolean; attempts: number; finished: boolean; unrecoveredAt?: number; ownerBootId?: string; ownerSessionId?: string };

let durableMarks = new Map<string, DurableMark>();
/**
 * D2：补记阶段**因预算用尽被拒绝的许可内写入**（任务/经验草稿）。
 *
 * 用途：最后一次允许的响应里模型请求了草稿写入、但阶段 provider 预算已用尽时必须如实呈现
 * "任务已保存、草稿未保存（受限）"，而不是拿单个任务成功当作整个补记完成，也不能因此放开第 3 次请求。
 */
let reflectionShortfall: string | null = null;

/** 新会话/换范围：清空全部临时事实与预算（不继承上一 runtime）。 */
export function resetAutomationSession(): void {
	identity = { ...EMPTY_IDENTITY };
	currentRequestKey = null;
	currentEntryIdentity = null;
	revoked = false;
	facts = [];
	pending = false;
	outcome = "in-progress";
	retrievedRequests = [];
	requestSequence = 0;
	prepared = null;
	budget = null;
	reflection = null;
	finishedStage = null;
	runTaskId = null;
	reflectionShortfall = null;
	durableMarks = new Map();
}

function clearRoundState(): void {
	facts = [];
	pending = false;
	outcome = "in-progress";
	budget = null;
	reflection = null;
	finishedStage = null;
	runTaskId = null;
	reflectionShortfall = null;
}

/**
 * 记录本次调用看到的会话身份。
 *
 * 身份或范围变化（换会话、切项目/工作区、目录变化）时**重置**临时事实——
 * 否则上一会话的工具回执会被投影到新 runtime（AW §3.2/§8 明确禁止）。
 * 返回 true 表示发生了重置。
 */
export function noteSessionIdentity(input: AutomationIdentity): boolean {
	const changed = identity.sessionId !== input.sessionId || identity.scopeKey !== input.scopeKey;
	if (changed) {
		identity = { ...input };
		currentRequestKey = null;
		currentEntryIdentity = null;
		retrievedRequests = [];
		requestSequence = 0;
		prepared = null;
		clearRoundState();
		return true;
	}
	identity = { ...identity, projectId: input.projectId, workspaceId: input.workspaceId, cwd: input.cwd };
	return false;
}

export function currentIdentity(): AutomationIdentity {
	return identity;
}

export function currentRequest(): string | null {
	return currentRequestKey;
}

/** 本会话撤回（`/bios-workflow off` 或宿主明确关闭）：停止自动动作，不删磁盘记录。 */
export function revokeAutomation(): void {
	revoked = true;
}

export function isRevoked(): boolean {
	return revoked;
}

/** 自动化总开关（含本会话撤回）。 */
export function automationActive(capability: AutomationCapability): boolean {
	return capability.enabled && !revoked;
}

/** 允许本地普通记账。 */
export function bookkeepingAllowed(capability: AutomationCapability): boolean {
	return automationActive(capability) && capability.localBookkeeping;
}

/** 允许把本项目资料注入当前请求。 */
export function injectionAllowed(capability: AutomationCapability): boolean {
	return automationActive(capability) && capability.injectProjectData;
}

/** 从宿主配置读取许可（模型无法修改）。 */
export function capabilityOf(config: BiosHostConfig): AutomationCapability {
	return config.automation;
}

/**
 * 是否已获得**项目级普通记账**授权（宿主许可开启、本会话未撤回，且**作用域已被显式授权**）。
 *
 * 这是 AW-03 的核心判据：`true` 时 `ensureWorkflowPermission` 不再按会话弹确认。
 * `/bios-workflow off` 会置 `revoked`，因此 off 之后的会话内不会自动重新授权。
 *
 * R1：许可**必须带项目/工作区作用域**——不能因为"总开关开着"就替一个未被显式授权的项目自动记账。
 */
export function projectBookkeepingGranted(config: BiosHostConfig, scope: { readonly projectId: string; readonly workspaceId: string } | null = null): boolean {
	if (!bookkeepingAllowed(config.automation)) return false;
	if (scope === null) return false;
	if (scope.workspaceId.trim() === "") return false;
	return config.authorizedProjectIds.includes(scope.projectId);
}

/** 记录一条真实工具事实（有界；同一 toolCallId + 工具名不重复入账）。 */
export function recordFact(fact: ExecutedFact & { readonly callId?: string | null }): void {
	if (facts.length >= 64) return;
	const callId = fact.callId ?? null;
	if (callId !== null && facts.some((existing) => existing.callId === callId && existing.tool === fact.tool)) return;
	// R6：业务状态与回链结果必须一起入账，否则保存回执只能靠"工具名出现过"推断。
	facts.push({ tool: fact.tool, outcome: fact.outcome, files: fact.files, wrote: fact.wrote, businessStatus: fact.businessStatus ?? null, linkFailed: fact.linkFailed === true, callId });
}

/** 标记本轮有未保存进展（供 settle 前判定）。 */
export function markPending(value: boolean): void {
	pending = value;
}

/** 记录本轮结局；`aborted`/`error` 不会被写成完成。 */
export function noteOutcome(value: CheckpointOutcome): void {
	outcome = value;
}

export type RunSnapshot = {
	readonly requestKey: string | null;
	readonly facts: readonly RecordedFact[];
	/** C1：当前原始请求的预算（没有则为全 0）。 */
	readonly budget: RequestBudget;
	readonly pending: boolean;
	readonly outcome: CheckpointOutcome;
	readonly stage: ReflectionStage | null;
	readonly runTaskId: string | null;
	/** D2：补记阶段因预算用尽被拒绝的许可内写入工具名（没有则为 null）。 */
	readonly shortfall: string | null;
};

const ZERO_BUDGET: RequestBudget = { requestKey: "", stagesRequested: 0, providerRequests: 0, writeCalls: 0 };

export function snapshotRun(): RunSnapshot {
	return { requestKey: currentRequestKey, facts: [...facts], budget: budget === null ? ZERO_BUDGET : { ...budget }, pending, outcome, stage: reflection === null ? null : { ...reflection }, runTaskId, shortfall: reflectionShortfall };
}

/** D2：本轮补记是否"想写但被预算拦住"（供 settle 时如实投影保存状态）。 */
export function reflectionShortfallOf(): string | null {
	return reflectionShortfall;
}

/** 本轮（原始请求）结束后清理事实；预算随下一个原始请求重建，不跨请求保留。 */
export function clearRequestFacts(): void {
	facts = [];
	pending = false;
	outcome = "in-progress";
}

/** 是否已经为这个原始请求做过自动检索（同 request/query/scope 未变不重复）。 */
export function markRetrieved(requestKey: string): void {
	if (retrievedRequests.includes(requestKey)) return;
	retrievedRequests = [...retrievedRequests, requestKey].slice(-AUTOMATION_LIMITS.maxRecentCheckpoints);
}

export function alreadyRetrieved(requestKey: string): boolean {
	return retrievedRequests.includes(requestKey);
}

/**
 * 派生稳定请求键：会话 + 分支 + 原始请求标识。
 *
 * 内部补记阶段使用同一 requestKey（不会派生新键），因此"补记不被识别为新工程请求"。
 */
export function requestKeyOf(sessionId: string | null, branch: string | null, seed: string): string {
	return stableRunId([sessionId, branch, seed]);
}

/**
 * C1/D1：为**新的原始用户请求**派生唯一请求键，并为它建立**独立预算**。
 *
 * 为什么不能只用 prompt 前缀：同一个前缀（"继续排查…"）会出现多次，会共用同一个键，
 * 于是补记预算、检索去重、补记标记互相污染，第三个调查就不再补记。
 *
 * 为什么还要带**用户 entry 身份**：会话内自增序号在新进程里从 0 重来，重启后同样的 prompt
 * 会派生出与重启前**完全相同**的键 ⇒ 新请求被旧耐久标记判成"已处理"（§9.3 D1 的实测反例）。
 * entry 身份（`ctx.sessionManager.getLeafId()`）是持久事实：新用户 entry 必然是新键。
 * 同一个 entry 重复进入（Pi 重放/分支恢复）时保持同一键，避免同一请求拿到两份预算。
 */
export function beginOriginalRequest(sessionId: string | null, cwd: string, promptHead: string, userEntryId: string | null = null): string {
	const entryIdentity = userEntryId !== null && userEntryId !== "" ? `entry:${userEntryId}` : `seq:${requestSequence + 1}|${promptHead}`;
	if (currentRequestKey !== null && currentEntryIdentity === entryIdentity) {
		// D1：同一 entry 重放（Pi 分支恢复/重放）时保持同一请求键，但**未终结**的补记才允许重置一次预算
		// ——否则同一进程内的重放会带着"已经请求过阶段"的预算回来，有界恢复根本没机会发生。
		// 预算重置次数由耐久标记的 `attempts` 兜底（达到上限即终结），不会变成无限重试。
		const mark = durableMarks.get(currentRequestKey);
		if (mark !== undefined && !mark.finished && mark.saved !== true && mark.attempts < 1 + AUTOMATION_LIMITS.maxReflectionRecoveryAttempts) {
			budget = { requestKey: currentRequestKey, stagesRequested: 0, providerRequests: 0, writeCalls: 0 };
			reflection = null;
			finishedStage = null;
			reflectionShortfall = null;
		}
		return currentRequestKey;
	}
	requestSequence += 1;
	currentEntryIdentity = entryIdentity;
	// 持久 entry 已经唯一；再混入进程序号会让同一 entry 在重启/回退后换键。
	currentRequestKey = requestKeyOf(sessionId, cwd, entryIdentity);
	budget = { requestKey: currentRequestKey, stagesRequested: 0, providerRequests: 0, writeCalls: 0 };
	reflection = null;
	finishedStage = null;
	runTaskId = null;
	reflectionShortfall = null;
	return currentRequestKey;
}

/** 本会话已经开始的原始请求数（诊断/测试可见）。 */
export function requestSequenceOf(): number {
	return requestSequence;
}

/** 首个 provider context 时绑定已持久化的用户 entry；不重置本轮预算或重复检索。 */
export function bindPersistedRequestEntry(sessionId: string | null, cwd: string, entryId: string | null): void {
	if (entryId === null || entryId === "" || budget === null || reflection !== null) return;
	// 一轮只绑定一次。steer/排队消息可能在后续 context 成为新叶子，不可中途换账本。
	if (currentEntryIdentity?.startsWith("entry:")) return;
	const key = requestKeyOf(sessionId, cwd, `entry:${entryId}`);
	if (key === currentRequestKey) return;
	if (currentRequestKey !== null && alreadyRetrieved(currentRequestKey)) markRetrieved(key);
	currentRequestKey = key;
	currentEntryIdentity = `entry:${entryId}`;
	budget = { ...budget, requestKey: key };
	if (prepared !== null) prepared = { ...prepared, requestKey: key };
}

/** 记录本次自动准备的快照（注入前用它做授权复验）。 */
export function notePreparedContext(snapshot: PreparedContextSnapshot): void {
	prepared = snapshot;
}

export function currentPreparedContext(): PreparedContextSnapshot | null {
	return prepared;
}

/** 丢弃本次准备（撤权/换端点/范围变化后不再复用正文）。 */
export function clearPreparedContext(): void {
	prepared = null;
}

/**
 * C1/C3：`agent_before_settle` 决定请求补记后开启补记阶段。
 *
 * 返回 false 表示**这个原始请求**已经有过一个补记阶段（不重复开启）——预算按请求算，
 * 不再像旧实现那样被整场会话累计。
 */
export function startReflectionStage(): boolean {
	if (budget === null || currentRequestKey === null) return false;
	if (budget.stagesRequested >= AUTOMATION_LIMITS.maxReflectionStagesPerRequest) return false;
	budget.stagesRequested += 1;
	reflection = {
		id: `${currentRequestKey}#${budget.stagesRequested}`,
		requestKey: currentRequestKey,
		startedAt: Date.now(),
		providerRequests: 0,
		writeCalls: 0,
		saved: false,
		taskId: runTaskId,
		instructionPending: true,
		settled: false,
	};
	return true;
}

export function currentReflectionStage(): ReflectionStage | null {
	return reflection === null ? null : { ...reflection };
}

/** 阶段已在 settle 边界终结（不再追加第二个阶段），但仍等 `agent_settled` 写完成回执。 */
export function settleReflectionStage(): void {
	if (reflection !== null) reflection = { ...reflection, settled: true };
}

/** 补记阶段**实际**发生了一次 provider 请求（由 `context` 钩子计数）。 */
export function noteReflectionProviderRequest(): void {
	if (budget !== null) budget.providerRequests += 1;
	if (reflection !== null) reflection = { ...reflection, providerRequests: reflection.providerRequests + 1 };
}

/** 原始调查期间也发生 provider 请求：计入预算总账（不影响补记阶段计数）。 */
export function noteRunProviderRequest(): void {
	if (budget !== null) budget.providerRequests += 1;
}

/**
 * C3：记录一次**真实 BIOS 写入回执**。
 *
 * `saved` 只在业务状态属于"确实落盘"的集合里才置位：
 * `declined`/`stale`/`conflict`/`endpoint-denied` 这类结构化失败一律不算已保存。
 */
export function noteBiosWriteReceipt(input: { readonly saved: boolean; readonly taskId: string | null }): void {
	if (input.taskId !== null) runTaskId = input.taskId;
	if (reflection === null) return;
	reflection = { ...reflection, writeCalls: reflection.writeCalls + 1, saved: reflection.saved || input.saved, taskId: reflection.taskId ?? input.taskId };
	if (budget !== null && input.saved) budget.writeCalls += 1;
}

/** 补记指令已被消费（下一次 `context` 不再保留它，避免永久污染上下文）。 */
export function consumeReflectionInstruction(): boolean {
	if (reflection === null || !reflection.instructionPending) return false;
	reflection = { ...reflection, instructionPending: false };
	return true;
}

/** 阶段结束：把状态交给 `agent_settled`（用于写耐久完成回执），之后不再接受新事实。 */
export function endReflectionStage(): ReflectionStage | null {
	finishedStage = reflection;
	reflection = null;
	return finishedStage === null ? null : { ...finishedStage };
}

/** 刚刚结束、等待写完成回执的阶段。 */
export function takeFinishedStage(): ReflectionStage | null {
	const value = finishedStage;
	finishedStage = null;
	return value === null ? null : { ...value };
}

/** 当前是否有活动补记阶段（诊断/测试可见）。 */
export function reflectionStageActive(): boolean {
	return reflection !== null;
}

/**
 * C2：补记阶段的**工具硬权限**。
 *
 * 三个判定按顺序生效：
 * 1. provider 请求预算用尽 ⇒ 拒绝**所有**工具并要求提前结束（这是"下一次 provider 请求前"的硬闸门）；
 * 2. 命令执行工具一律拒绝（防止用 shell 绕过只读限制）；
 * 3. 源码写入工具一律拒绝；只放行 `bios_*` 与只读调查工具。
 */
export function reflectionToolDecision(toolName: string): ReflectionToolDecision {
	if (reflection === null) return { blocked: false, reason: null, terminate: false };
	if (reflection.providerRequests >= AUTOMATION_LIMITS.maxReflectionProviderRequests) {
		// D2：最后一次允许的响应里模型还想写任务/草稿时，**如实记下"想写但被预算拦住"**。
		// 这既不放宽 2 次请求硬上限（不放行就是不放行），也不允许把单个任务的成功当成整轮补记完成。
		if (toolName === "bios_manage_task" || toolName === "bios_save_experience_draft") reflectionShortfall = toolName;
		return { blocked: true, reason: `补记阶段的模型请求预算（${AUTOMATION_LIMITS.maxReflectionProviderRequests} 次）已用尽：本次不再执行工具，请直接用已有信息收口。`, terminate: true };
	}
	switch (classifyReflectionTool(toolName)) {
		case "bios":
		case "readonly":
			return { blocked: false, reason: null, terminate: false };
		case "execution":
			return { blocked: true, reason: "补记阶段不允许执行命令：只允许只读调查与受限的 BIOS 记账。", terminate: true };
		case "source-write":
			return { blocked: true, reason: "补记阶段不允许修改源码：只允许总结、任务进度与经验草稿。", terminate: true };
		default:
			return { blocked: true, reason: `补记阶段不允许使用工具「${toolName}」：只允许只读调查与受限的 BIOS 记账工具。`, terminate: true };
	}
}

/**
 * C2/R3：补记阶段的写工具额度是否用尽（硬限制）。
 *
 * 由 `bios_manage_task` / `bios_save_experience_draft` 在真实调用入口检查，
 * 这样"最多两次写入"不是提示语而是拒绝。
 */
export function reflectionWriteBudgetExhausted(): boolean {
	if (reflection === null) return false;
	return reflection.writeCalls >= AUTOMATION_LIMITS.maxReflectionWriteCalls;
}

/* --------------------------------------------------------------- 耐久补记标记 */

/** 用磁盘上的标记填充内存视图（重启后据此判断"这个请求是否已经处理过"）。 */
export function hydrateDurableMarks(marks: readonly ReflectionMark[]): void {
	durableMarks = new Map(
		marks.map((mark) => [
			mark.requestKey,
			{
				saved: mark.saved,
				attempts: mark.attempts ?? (mark.saved ? 1 : 0),
				finished: mark.finished ?? mark.saved,
				...(mark.unrecoveredAt === undefined ? {} : { unrecoveredAt: mark.unrecoveredAt }),
				...(mark.ownerBootId === undefined ? {} : { ownerBootId: mark.ownerBootId }),
				...(mark.ownerSessionId === undefined ? {} : { ownerSessionId: mark.ownerSessionId }),
			},
		]),
	);
}

/** V2：标记所有者 = 当前进程 + 当前会话身份（同一进程内不同会话互不冒充）。 */
function currentOwner(): DurableMarkOwner {
	return { ownerBootId: AUTOMATION_BOOT_ID, ownerSessionId: identity.sessionId };
}

/**
 * 记录一次耐久标记（内存 + 供落盘）。
 *
 * V2：默认带上**当前进程/会话**作为所有者；测试或恢复路径可显式覆盖（缺省的旧记录保持"所有者未知"）。
 */
export function noteDurableMark(requestKey: string, saved: boolean, attempts: number, finished: boolean, unrecoveredAt?: number, owner?: Partial<DurableMarkOwner>): void {
	const resolved = owner === undefined ? currentOwner() : { ownerBootId: owner.ownerBootId ?? currentOwner().ownerBootId, ownerSessionId: owner.ownerSessionId === undefined ? identity.sessionId : owner.ownerSessionId };
	durableMarks = new Map([...durableMarks, [requestKey, { saved, attempts, finished, ...(unrecoveredAt === undefined ? {} : { unrecoveredAt }), ...(resolved.ownerBootId === "" ? {} : { ownerBootId: resolved.ownerBootId }), ...(resolved.ownerSessionId === null ? {} : { ownerSessionId: resolved.ownerSessionId }) }]]);
}

export function durableMarkOf(requestKey: string): { readonly saved: boolean; readonly attempts: number; readonly finished: boolean; readonly unrecoveredAt?: number } | null {
	return durableMarks.get(requestKey) ?? null;
}

/** D1：内存里的全部耐久标记（"未恢复"判定用；顺序与磁盘一致）。 */
export function durableMarkList(): readonly ReflectionMark[] {
	return [...durableMarks.entries()].map(([requestKey, mark]) => ({
		requestKey,
		runId: requestKey,
		recordedAt: 0,
		saved: mark.saved,
		attempts: mark.attempts,
		finished: mark.finished,
		...(mark.unrecoveredAt === undefined ? {} : { unrecoveredAt: mark.unrecoveredAt }),
		...(mark.ownerBootId === undefined ? {} : { ownerBootId: mark.ownerBootId }),
		...(mark.ownerSessionId === undefined ? {} : { ownerSessionId: mark.ownerSessionId }),
	}));
}

/**
 * D1：把"未恢复回执已发出"同步进内存视图。
 *
 * 否则同一进程内的下一次 settle 会把同一条标记再报一遍（磁盘上已经写过，内存没跟上）。
 *
 * V1：**只有耐久写入成功时**调用方才会调它——写失败时不得把内存标成"已通知"，
 * 否则重启后既没有回执也没有标记，用户什么都看不到。
 */
export function noteUnrecoveredLocally(requestKeys: readonly string[], at: number): void {
	if (requestKeys.length === 0) return;
	const wanted = new Set(requestKeys);
	durableMarks = new Map([...durableMarks].map(([requestKey, mark]) => [requestKey, wanted.has(requestKey) && mark.unrecoveredAt === undefined ? { ...mark, unrecoveredAt: at } : mark]));
}

/**
 * C3/D1：这个原始请求是否已经有**终结性**标记（"已处理，不要再补记"）。
 *
 * 判据是"**阶段已终结**"（拿到真实完成回执，或明确判定无法保存），而不是"有标记"：
 * - `finished:true` ⇒ 终结（`saved` 只区分成功/明确失败）；
 * - `finished:false` 但仍允许恢复 ⇒ 未终结；只有把
 *   `maxReflectionRecoveryAttempts` 次恢复也用完才终结（有界恢复，不无限重试）。
 *
 * 旧实现把阶段**开始**时写的 `attempts=1` 当终结，于是中断后从不真正恢复。
 * 旧记录没有 `finished` 时按 `saved === true` 推断（保守：未保存的旧标记允许一次恢复）。
 */
export function markedDurably(requestKey: string): boolean {
	const mark = durableMarks.get(requestKey);
	if (mark === undefined) return false;
	if (mark.finished) return true;
	return mark.attempts >= 1 + AUTOMATION_LIMITS.maxReflectionRecoveryAttempts;
}

/** 上限常量对测试可见（不允许调用方放大）。 */
export const AUTOMATION_CEILINGS = AUTOMATION_LIMITS;
