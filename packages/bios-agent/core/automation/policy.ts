/**
 * AW：**自动化的纯策略**（无 IO、无时钟、无 Pi 依赖，便于单测）。
 *
 * 这里只放"给定事实 → 决定做什么"的函数：意图粗分类、检索/补记预算、检查点组装、状态投影。
 * 模型仍然是唯一做有歧义语义判断的地方；扩展只做保守准备与闸门。
 */
import { AUTOMATION_LIMITS, type AutomationCheckpoint, type CheckpointOutcome, type CheckpointRef, type CheckpointTaskLink, type CodeBaseline, type ExecutedFact, type ReflectionMark } from "./contract.ts";

/**
 * 请求意图**粗分类**：只用于"要不要自动准备资料/检索"。
 *
 * 明确不做的事：不用它替模型建任务。`unclear` 时仍准备只读背景（无副作用），
 * 但**不**自动保存任何语义进度——那由模型在当前循环里判断。
 */
export type RequestIntent = "engineering" | "greeting" | "conceptual" | "unclear";

const GREETING_PATTERNS: readonly RegExp[] = [/^(你好|您好|hi|hello|hey|在吗|早上好|晚上好|嗨)[!！。.\s]*$/i, /^(谢谢|thanks|thank you|thx)[!！。.\s]*$/i];

const CONCEPTUAL_PATTERNS: readonly RegExp[] = [/^(什么是|什么叫|解释一下|解释下|科普一下)/, /^(what is|what's|explain|how does)\b/i];

/** 工程动作词：出现即认为是工程请求（但仍由模型做最终语义判断）。 */
const ENGINEERING_PATTERNS: readonly RegExp[] = [
	/(分析|排查|调查|定位|修复|实现|移植|调试|编译|构建|复现|验证|优化|重构|回退|回归|报错|崩溃|死机|黑屏|不亮|起不来)/,
	/(bug|issue|error|fail|failure|crash|hang|regression|debug|analyse|analyze|investigate|fix|implement|port|compile|build)/i,
	/(为什么|为何|怎么|如何).{0,20}(不|没|无法|失败|异常|错)/,
];

/** 明显的打招呼/寒暄（很短且整句匹配）。 */
function isGreeting(text: string): boolean {
	if (text.length > 24) return false;
	return GREETING_PATTERNS.some((pattern) => pattern.test(text.trim()));
}

/** 明确的通用概念提问（不含工程上下文词）。 */
function isConceptual(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.length > 60) return false;
	return CONCEPTUAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export function classifyRequestIntent(prompt: string): { readonly intent: RequestIntent; readonly reason: string } {
	const text = prompt.trim();
	if (text === "") return { intent: "unclear", reason: "空请求" };
	if (isGreeting(text)) return { intent: "greeting", reason: "整句匹配寒暄模板" };
	if (ENGINEERING_PATTERNS.some((pattern) => pattern.test(text))) return { intent: "engineering", reason: "命中工程动作词" };
	if (isConceptual(text)) return { intent: "conceptual", reason: "命中通用概念提问模板" };
	return { intent: "unclear", reason: "无明确工程动作词；由当前模型循环判断" };
}

/** 自动化是否应当为这次请求准备只读背景（寒暄不准备；其余都准备但只读）。 */
export function shouldPrepareBackground(intent: RequestIntent): boolean {
	return intent !== "greeting";
}

/**
 * 我们自己的补记阶段写入的会话条目类型。
 *
 * 补记阶段会在 `agent_before_settle` 里追加一条带该 `customType` 的条目；
 * `before_agent_start` 见到它就**不**再做意图分类/自动检索，避免"自己的补记被当成新工程请求"。
 */
export const BIOS_REFLECTION_CUSTOM_TYPE = "bios-pending-reflection";

/** 会话条目是否是我们自己的补记标记（结构化判断，不做文本子串匹配）。 */
export function isReflectionMarker(entry: unknown): boolean {
	if (entry === null || typeof entry !== "object") return false;
	const candidate = entry as { readonly type?: unknown; readonly customType?: unknown; readonly role?: unknown };
	return candidate.customType === BIOS_REFLECTION_CUSTOM_TYPE;
}

/** 会话条目是否是真实的**用户**输入（补记标记不是）。 */
export function isUserEntry(entry: unknown): boolean {
	if (entry === null || typeof entry !== "object") return false;
	const candidate = entry as { readonly type?: unknown; readonly role?: unknown; readonly customType?: unknown };
	if (candidate.customType === BIOS_REFLECTION_CUSTOM_TYPE) return false;
	return candidate.role === "user" || candidate.type === "user";
}

/** 检索预算：整块 BIOS 上下文共享同一份 12,000 字符 / 24 KiB 硬上限，这里只给"取几条"。 */
export type RetrievalPlan = {
	/** 摘要候选上限。 */
	readonly maxLeads: number;
	/** 其中本项目未验证线索上限。 */
	readonly maxProjectLeads: number;
	/** 按需详情读取上限。 */
	readonly maxDetailReads: number;
	/** 自动 Git 取证单批提交数（不 fetch/pull）。 */
	readonly maxCommits: number;
};

export const DEFAULT_RETRIEVAL_PLAN: RetrievalPlan = {
	maxLeads: AUTOMATION_LIMITS.maxWorkingLeads,
	maxProjectLeads: AUTOMATION_LIMITS.maxProjectLeads,
	maxDetailReads: AUTOMATION_LIMITS.maxDetailReads,
	maxCommits: AUTOMATION_LIMITS.maxGitCommitsPerBatch,
};

/** 只允许**收紧**检索预算（与既有 12,000/24 KiB 规则一致：上限不可被参数放大）。 */
export function resolveRetrievalPlan(requested?: Partial<RetrievalPlan>): RetrievalPlan {
	const clamp = (value: number | undefined, ceiling: number): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), ceiling) : ceiling);
	return {
		maxLeads: clamp(requested?.maxLeads, DEFAULT_RETRIEVAL_PLAN.maxLeads),
		maxProjectLeads: clamp(requested?.maxProjectLeads, DEFAULT_RETRIEVAL_PLAN.maxProjectLeads),
		maxDetailReads: clamp(requested?.maxDetailReads, DEFAULT_RETRIEVAL_PLAN.maxDetailReads),
		maxCommits: clamp(requested?.maxCommits, DEFAULT_RETRIEVAL_PLAN.maxCommits),
	};
}

/**
 * D1（§11.3）：找出**没有恢复路径**的未终结补记，供"未恢复"回执使用。
 *
 * 背景：补记阶段的恢复只有一个触发条件——**同一个用户 entry 重新成为当前请求**
 * （Pi 自动重试，或同一 entry 的分支重放）。若请求身份已经变成新 entry，那条未终结标记
 * 就永远等不到恢复；旧实现让它静静停在 `finished:false`，对用户等于无声消失。
 *
 * 判据（全部满足才算"未恢复"）：
 * - 没有成功保存（`saved !== true`）且没有终结（`finished !== true`）；
 * - **不是**当前请求（当前请求由正常补记逻辑处理，不能提前判死）；
 * - 还没发过未恢复回执（`unrecoveredAt` 为空）：只告知一次，不每轮刷屏；
 * - 恢复次数已用尽时给不同原因（"恢复次数用尽"），仍在恢复额度内则说明"缺恢复路径"。
 */
export type UnrecoveredReflection = {
	readonly requestKey: string;
	readonly attempts: number;
	/** `no-recovery-path`：请求身份已变；`recovery-exhausted`：有界恢复次数已用尽。 */
	readonly reason: "no-recovery-path" | "recovery-exhausted";
};

/**
 * V2：判断一条未终结补记是否具有**可信的终止依据**。
 *
 * 背景（§13.2 V2）：状态按工作区共享，B 会话的 settle **不能**证明 A 会话的请求已经中断
 * （A 可能仍在跑）。旧判据只看"requestKey 不是当前请求"，等于凭请求不同就判死。
 *
 * 可信依据：**同一进程、同一会话已被新请求取代**（`ownerBootId` 相同、`ownerSessionId` 等于当前会话，
 *    而当前请求键已不是它）——同一会话一次只处理一个请求，"有新请求在跑"就是旧请求的回合已结束。
 *
 * 启动 UUID 不是存活证明：多个 Pi 进程可同时使用同一工作区，不同 UUID 不能证明对方已退出。
 * 没有宿主终止证据的外部进程（包括旧进程）、其它会话和未知所有者一律保守待核对。
 */
function hasCredibleTermination(mark: ReflectionMark, context: { readonly bootId: string; readonly sessionId: string | null }): boolean {
	if (mark.ownerBootId === undefined || mark.ownerBootId === "") return false;
	if (mark.ownerBootId !== context.bootId) return false;
	if (context.sessionId === null) return false;
	return mark.ownerSessionId === context.sessionId;
}

/** V2/V3：一条补记标记的**状态口径**（扩展判定与宿主投影同源）。 */
export type ReflectionMarkStatus = {
	/**
	 * - `saved`：已成功落盘；
	 * - `failed`：已终结但没有保存成功（明确失败，需要人关注而不是等待恢复）；
	 * - `active`：就是当前（或刚刚收口的）请求，仍在正常补记流程里；
	 * - `unrecovered`：有可信终止依据但没有收口（证据保留，不再自动恢复）；
	 * - `awaiting-check`：未终结且**没有**可信终止依据——可能仍在别的会话里跑，保守待核对。
	 */
	readonly state: "saved" | "failed" | "active" | "unrecovered" | "awaiting-check";
};

export type ReflectionMarkContext = {
	readonly currentRequestKey: string | null;
	/** 刚刚在本进程收口的请求键（它自己的 settle 不能把它算作未恢复）。 */
	readonly settledRequestKey?: string | null;
	/** 当前进程启动标识（`currentAutomationBootId()`）。 */
	readonly bootId: string;
	/** 当前会话 ID；拿不到时保守（不把"同进程其它会话"当成已中断）。 */
	readonly sessionId: string | null;
};

export function classifyReflectionMark(mark: ReflectionMark, context: ReflectionMarkContext): ReflectionMarkStatus {
	if (mark.saved === true) return { state: "saved" };
	if (mark.finished === true) return { state: "failed" };
	if (mark.requestKey === context.currentRequestKey || (context.settledRequestKey !== undefined && context.settledRequestKey !== null && mark.requestKey === context.settledRequestKey)) return { state: "active" };
	return { state: hasCredibleTermination(mark, context) ? "unrecovered" : "awaiting-check" };
}

/**
 * V3：把标记集合投影成**同源计数**（扩展回执、宿主统计、默认面板都用这一份）。
 *
 * `unrecovered` 只统计"有可信终止依据但未终结"的项；`awaiting` 是没有终止依据的未终结项
 * （可能仍在别的会话里跑），两者不能混成一个"待恢复"数字。
 */
export type ReflectionCounts = {
	readonly saved: number;
	readonly failed: number;
	readonly active: number;
	readonly unrecovered: number;
	readonly awaiting: number;
};

export function reflectionCounts(marks: readonly ReflectionMark[], context: ReflectionMarkContext): ReflectionCounts {
	const counts = { saved: 0, failed: 0, active: 0, unrecovered: 0, awaiting: 0 };
	for (const mark of marks) {
		const { state } = classifyReflectionMark(mark, context);
		if (state === "saved") counts.saved += 1;
		else if (state === "failed") counts.failed += 1;
		else if (state === "active") counts.active += 1;
		else if (state === "unrecovered") counts.unrecovered += 1;
		else counts.awaiting += 1;
	}
	return counts;
}

/**
 * V1/V2：找出**需要发"未恢复"回执**的未终结补记。
 *
 * 与旧实现的差别（§13.2）：
 * - 只有 `classifyReflectionMark` 判成 `unrecovered`（有可信终止依据）的才进候选；
 *   所有者未知的旧记录与其它会话的 pending 一律**不判死**；
 * - 已经发过回执（`unrecoveredAt`）的不重复。
 */
export function unrecoveredReflections(input: { readonly marks: readonly ReflectionMark[] } & ReflectionMarkContext): readonly UnrecoveredReflection[] {
	const out: UnrecoveredReflection[] = [];
	for (const mark of input.marks) {
		if (classifyReflectionMark(mark, input).state !== "unrecovered") continue;
		if (mark.unrecoveredAt !== undefined) continue;
		const attempts = mark.attempts ?? 0;
		out.push({ requestKey: mark.requestKey, attempts, reason: attempts >= 1 + AUTOMATION_LIMITS.maxReflectionRecoveryAttempts ? "recovery-exhausted" : "no-recovery-path" });
	}
	return out;
}

/**
 * D1：渲染"未恢复"说明（模型可见 + 宿主面板同源文案）。
 *
 * 措辞必须**不承诺**已经恢复，也不要求模型自己重做补记（那可能凭空编造执行事实）；
 * 只说明事实、后果与人工下一步。
 */
export function renderUnrecoveredNote(items: readonly UnrecoveredReflection[]): string {
	if (items.length === 0) return "";
	const lines = items.slice(0, 5).map((item) => `- ${item.requestKey.slice(0, 24)}：补记阶段已开始 ${item.attempts} 次但未收口（${item.reason === "recovery-exhausted" ? "有界恢复次数已用尽" : "本次请求身份已变，缺少恢复路径"}）`);
	return ["补记未恢复（如实说明，未自动重放）：", ...lines, "对应检查点与工具事实**已保留**，没有删除或改写；如需补齐请重新发起那次调查（同一请求身份重试时才会自动恢复），本次不代替它新建记录。"].join("\n");
}

/**
 * V3：渲染"**待核对**"说明。
 *
 * 与"未恢复"分开：这些未终结标记**没有可信终止依据**（可能仍在别的会话里执行），
 * 不能对用户说成"已中断/未恢复"。只说明"存在未收口的补记、证据已保留、待核对"。
 */
export function renderAwaitingCheckNote(items: readonly ReflectionMark[]): string {
	if (items.length === 0) return "";
	const lines = items.slice(0, 5).map((mark) => `- ${mark.requestKey.slice(0, 24)}：补记阶段已开始 ${mark.attempts ?? 0} 次，尚未收到终结回执`);
	return ["补记状态待核对（不宣称已中断）：", ...lines, "这些请求的检查点与工具事实**已保留**；若它们所属的会话仍在运行，会在它自己的回合里收口，本次不替它判定、也不新建记录。"].join("\n");
}

/**
 * §7.4 R4：**目标客户**只取项目档案里**人工确认**过的字段。
 *
 * 为什么必须这样：客户级复用（`reuseScope.level = "customer"`）的可见性判定要求
 * `target.customerId` 非空且出现在已批准客户里；旧实现一直传 `null`，于是"已批准客户的
 * 跨平台正式经验"永远检索不到，单库正例也就无法证明跨客户复用。
 *
 * 但也不能猜客户：候选值（`status !== "confirmed"`）、空值一律返回 null，
 * 未知客户**不等于**公开（判定会按未授权处理）。
 */
export function confirmedCustomerOf(profile: { readonly identity?: { readonly customer?: { readonly value?: unknown; readonly status?: unknown } } } | null | undefined): string | null {
	const entry = profile?.identity?.customer;
	if (entry === undefined || entry === null) return null;
	if (entry.status !== "confirmed") return null;
	return typeof entry.value === "string" && entry.value.trim() !== "" ? entry.value : null;
}

/**
 * R4（§9.4）：**合并检索预算**账本。
 *
 * 为什么需要：正式（已审核）与本项目 working 是同一次自动检索的两半。旧实现两边各自
 * `resolveRetrievalPlan()` 再各自按 `maxLeads` 截断——同一份计划被消费两次，实际"取几条"
 * 是 `2 × maxLeads`，单库正例永远看不出合并预算的问题，也无法量测截断量。
 *
 * 账本让两次检索花**同一份**预算，并如实累计"因为共享预算不足而没取到的候选数"，
 * 调用方可据此渲染真实的截断说明（不是"没命中"）。
 */
export type RetrievalUsage = {
	/** 本次实际取回的线索数。 */
	readonly leads: number;
	/** 本次实际消耗的详情读取次数。 */
	readonly detailReads: number;
	/** 本次因预算不足被裁掉的候选数（可量测的截断量）。 */
	readonly leadsTruncated: number;
	/** 本次因详情读取预算不足而没有读取的候选数。 */
	readonly detailReadsTruncated: number;
};

export type RetrievalLedgerSnapshot = RetrievalUsage & {
	readonly maxLeads: number;
	readonly maxDetailReads: number;
	/** 共享预算是否已经用尽（后续检索必须如实报告"没轮到读"，不能假装没命中）。 */
	readonly exhausted: boolean;
};

export type RetrievalLedger = {
	/** 还剩下多少共享预算（按调用顺序递减：先正式、后 working）。 */
	readonly remaining: () => { readonly leads: number; readonly detailReads: number };
	readonly charge: (usage: RetrievalUsage) => void;
	readonly snapshot: () => RetrievalLedgerSnapshot;
};

export function createRetrievalLedger(plan: RetrievalPlan = DEFAULT_RETRIEVAL_PLAN): RetrievalLedger {
	let leads = 0;
	let detailReads = 0;
	let leadsTruncated = 0;
	let detailReadsTruncated = 0;
	const nonNegative = (value: number): number => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
	return {
		remaining: () => ({ leads: Math.max(0, plan.maxLeads - leads), detailReads: Math.max(0, plan.maxDetailReads - detailReads) }),
		charge: (usage) => {
			leads += nonNegative(usage.leads);
			detailReads += nonNegative(usage.detailReads);
			leadsTruncated += nonNegative(usage.leadsTruncated);
			detailReadsTruncated += nonNegative(usage.detailReadsTruncated);
		},
		snapshot: () => ({ maxLeads: plan.maxLeads, maxDetailReads: plan.maxDetailReads, leads, detailReads, leadsTruncated, detailReadsTruncated, exhausted: leads >= plan.maxLeads || detailReads >= plan.maxDetailReads }),
	};
}

/**
 * 补记预算：每个原始用户请求最多 1 次专用补记阶段、最多 2 次 provider 请求、最多 2 次写工具调用。
 *
 * 纯函数：调用方提供"已经用了多少"和当前状态，这里只回答"还能不能请求"。
 */
export type ReflectionBudgetState = {
	/** 原始用户请求的稳定标识（session + branch + 首个 entry）。 */
	readonly requestKey: string;
	/** 已经请求过的补记阶段数。 */
	readonly stagesRequested: number;
	/** 补记阶段内已经发生的 provider 请求数。 */
	readonly providerRequests: number;
	/** 补记阶段内已经发生的 BIOS 写工具调用数。 */
	readonly writeCalls: number;
};

export const EMPTY_REFLECTION_BUDGET: Omit<ReflectionBudgetState, "requestKey"> = { stagesRequested: 0, providerRequests: 0, writeCalls: 0 };

export function shouldRequestReflection(input: {
	readonly budget: ReflectionBudgetState;
	/** 本轮是否确实有重要进展尚未保存（由扩展按已发生的工具事实判断）。 */
	readonly pending: boolean;
	readonly aborted: boolean;
	/** 授权/端点/scope 是否仍然一致（任一变即不发总结模型）。 */
	readonly scopeStable: boolean;
	/** 是否已存在**耐久**补记标记（重启后不重复创建）。 */
	readonly alreadyMarked: boolean;
	/**
	 * 本轮的真实结局（Pi 的 settled outcome）。
	 *
	 * 只有正常完成才请求补记：取消/模型错误时既不能保证"进展"完整，也不该再发起模型请求
	 * （R3：settled outcome 必须参与补记门禁）。
	 */
	readonly outcome: "completed" | "aborted" | "error";
}): { readonly request: boolean; readonly reason: string } {
	if (!input.pending) return { request: false, reason: "本轮没有未保存的重要进展" };
	if (input.outcome !== "completed") return { request: false, reason: `本轮结局为 ${input.outcome}：不发总结模型` };
	if (input.aborted) return { request: false, reason: "请求已取消：不发总结模型" };
	if (!input.scopeStable) return { request: false, reason: "授权/端点或范围已变化：不发总结模型" };
	if (input.alreadyMarked) return { request: false, reason: "已有持久补记标记：不重复创建" };
	if (input.budget.stagesRequested >= AUTOMATION_LIMITS.maxReflectionStagesPerRequest) return { request: false, reason: "每个原始请求最多一次专用补记阶段" };
	if (input.budget.providerRequests >= AUTOMATION_LIMITS.maxReflectionProviderRequests) return { request: false, reason: "补记阶段 provider 请求已达上限" };
	// R3：写入上限必须在**决策**里就检查，否则"两次写入"只是提示语。
	if (input.budget.writeCalls >= AUTOMATION_LIMITS.maxReflectionWriteCalls) return { request: false, reason: `补记阶段写工具调用已达上限（${AUTOMATION_LIMITS.maxReflectionWriteCalls} 次）` };
	return { request: true, reason: "有未保存进展且仍在预算内" };
}

/** 续接阶段是否还有 provider 预算（用于"硬停止"补记阶段的多轮循环）。 */
export function reflectionStageExhausted(input: { readonly providerRequests: number; readonly writeCalls: number }): { readonly exhausted: boolean; readonly reason: string } {
	if (input.providerRequests >= AUTOMATION_LIMITS.maxReflectionProviderRequests) return { exhausted: true, reason: `补记阶段 provider 请求已达上限（${AUTOMATION_LIMITS.maxReflectionProviderRequests} 次）` };
	if (input.writeCalls >= AUTOMATION_LIMITS.maxReflectionWriteCalls) return { exhausted: true, reason: `补记阶段写工具调用已达上限（${AUTOMATION_LIMITS.maxReflectionWriteCalls} 次）` };
	return { exhausted: false, reason: "" };
}

/** 补记阶段的**受控指令文本**：只要求补记，不扩大权限，不要求重复已保存内容。 */
export function reflectionInstruction(): string {
	return [
		"[BIOS 自动化补记] 本轮还有重要进展没有落盘。请只做一件事：",
		"用已有工具保存尚未记录的任务进度与（如果有）经验草稿；已经保存过的内容不要重复写。",
		"约束：最多 2 次写工具调用；不得批准/审核经验、不得添加验证结论、不得扩大授权、不得修改源码或提交；",
		"根因未知就写 unknown，不为了凑经验而编造结论。若没有真实进展可保存，直接结束。",
	].join("\n");
}

/** 受支持工具的分类：只有明确列出的才算"可入账的真实执行事实"。 */
const WRITE_TOOLS: readonly string[] = ["edit", "write", "multiedit", "apply_patch", "str_replace"];
const READ_TOOLS: readonly string[] = ["read", "grep", "glob", "list", "ls", "bash", "search", "find"];
const BIOS_TOOLS: readonly string[] = [
	"bios_detect_project",
	"bios_get_project_info",
	"bios_get_task",
	"bios_search_knowledge",
	"bios_get_feature",
	"bios_get_experience",
	"bios_preview_context",
	"bios_read_history",
	"bios_manage_task",
	"bios_save_experience_draft",
	"bios_propose_feature",
	"bios_maintain_memory",
	"bios_confirm_project_fields",
];

export function isWriteTool(toolName: string): boolean {
	return WRITE_TOOLS.includes(toolName.toLowerCase());
}

export function isReadTool(toolName: string): boolean {
	return READ_TOOLS.includes(toolName.toLowerCase());
}

/** 受支持工具：读/写 + 本包自己的工具；其它扩展的工具既不入账也不影响判定。 */
export function isSupportedTool(toolName: string): boolean {
	const lower = toolName.toLowerCase();
	return isWriteTool(lower) || isReadTool(lower) || BIOS_TOOLS.includes(toolName);
}

const FILE_FIELD_NAMES: readonly string[] = ["filePath", "file_path", "path", "file", "target"];

/**
 * C4：这句话是不是"继续上次的工作"。
 *
 * 背景参考与**明确续接**必须分开：只有用户表达继续意图（或显式选中了任务）时，
 * 才把旧任务的进展当作"当前工作"注入；否则新问题不应该被自动改成旧任务续接。
 */
const CONTINUATION_PATTERNS: readonly RegExp[] = [/(继续|接着|上次|之前|上回|恢复|续接|还没|未完成)/, /\b(continue|resume|pick up|where we left|last time|previous)\b/i];

export function looksLikeContinuation(prompt: string): boolean {
	return CONTINUATION_PATTERNS.some((pattern) => pattern.test(prompt));
}

/**
 * C4：从工具**回执文本**里取出真实 `taskId`。
 *
 * BIOS 工作流工具的回执正文是 JSON（`details` 只放投影信息、不放整份记录），
 * 因此任务回链必须解析回执正文；解析失败就当作"没有回执"，绝不按模型自报推断。
 */
export function receiptTaskIdOf(content: unknown): string | null {
	let text = "";
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) {
		text = content.map((part) => (typeof part === "string" ? part : typeof (part as { readonly text?: unknown })?.text === "string" ? String((part as { readonly text: string }).text) : "")).join("\n");
	}
	if (text.trim() === "") return null;
	try {
		const parsed = JSON.parse(text) as { readonly taskId?: unknown; readonly task?: { readonly taskId?: unknown } };
		const candidate = parsed?.taskId ?? parsed?.task?.taskId;
		return typeof candidate === "string" && candidate !== "" ? candidate : null;
	} catch {
		return null;
	}
}

/* ------------------------------------------------- C2：补记阶段的工具权限分类 */

/** 补记阶段允许的只读调查工具（`bios_*` 另按前缀放行）。 */
const REFLECTION_READONLY_TOOLS: readonly string[] = ["read", "grep", "find", "ls", "glob"];
/** 修改源码的工具（补记阶段一律拒绝）。 */
const REFLECTION_SOURCE_WRITE_TOOLS: readonly string[] = ["write", "edit", "multi_edit", "multiedit", "apply_patch", "patch", "notebook_edit", "create_file", "str_replace"];
/** 可执行任意命令的工具（补记阶段一律拒绝，防止绕过只读限制）。 */
const REFLECTION_EXECUTION_TOOLS: readonly string[] = ["bash", "powershell", "shell", "exec", "terminal", "run_command", "spawn", "cmd"];

export type ReflectionToolClass = "bios" | "readonly" | "source-write" | "execution" | "unknown";

/**
 * C2：工具在补记阶段的类别。
 *
 * 放行规则是**白名单**：只允许 `bios_*` 与只读调查工具；其它一律按 `unknown` 拒绝，
 * 这样新增的第三方工具不会因为"不在拒绝名单里"而被放行。
 */
export function classifyReflectionTool(tool: string): ReflectionToolClass {
	if (tool.startsWith("bios_")) return "bios";
	if (REFLECTION_READONLY_TOOLS.includes(tool)) return "readonly";
	if (REFLECTION_SOURCE_WRITE_TOOLS.includes(tool)) return "source-write";
	if (REFLECTION_EXECUTION_TOOLS.includes(tool)) return "execution";
	return "unknown";
}

/** 从工具参数里提取有界、去重的文件路径（只取显式字段，不从命令字符串里猜）。 */
export function filesFromToolArgs(args: unknown): readonly string[] {
	if (args === null || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const found: string[] = [];
	for (const field of FILE_FIELD_NAMES) {
		const value = record[field];
		if (typeof value === "string" && value.trim() !== "" && value.length <= 1024) found.push(value);
	}
	return [...new Set(found)].slice(0, 16);
}

/** 把一次工具执行归约成一条执行事实（R6：同时记录业务状态与回链结果）。 */
export function executedFact(input: { readonly tool: string; readonly outcome: "ok" | "error" | "blocked"; readonly args?: unknown; readonly businessStatus?: string | null; readonly linkFailed?: boolean }): ExecutedFact {
	return { tool: input.tool, outcome: input.outcome, files: filesFromToolArgs(input.args), wrote: isWriteTool(input.tool), businessStatus: input.businessStatus ?? null, linkFailed: input.linkFailed === true };
}

/** 各 BIOS 写工具的**成功**业务状态（其余状态一律不算"已保存"）。 */
const SAVE_SUCCESS_STATUSES: Readonly<Record<string, readonly string[]>> = {
	// 任务进度：创建/更新/状态推进算保存；`declined`/`stale`/`endpoint-denied` 等一概不算。
	bios_manage_task: ["created", "updated", "ok"],
	// 经验草稿：`unchanged` 表示"相同草稿已存在"，记录确实在库里，算已保存。
	bios_save_experience_draft: ["created", "updated", "unchanged"],
};

/** 该事实是否代表一次**真实落盘**的 BIOS 保存（按业务状态判定，不按工具名推断）。 */
export function isSavedFact(fact: ExecutedFact): boolean {
	const allowed = SAVE_SUCCESS_STATUSES[fact.tool];
	if (allowed === undefined) return false;
	return fact.outcome === "ok" && typeof fact.businessStatus === "string" && allowed.includes(fact.businessStatus);
}

/**
 * 判断"本轮有未保存的重要进展"。
 *
 * 关键点（AW §5.3）：**只读调查也可能产生重要结论**，所以不能把"是否 edit"当唯一条件。
 * 这里只做保守的**前置条件**判断（有真实取证事实 + 没有已保存的 BIOS 写工具回执）；
 * 是否真有值得沉淀的结论由模型在补记阶段判断。
 */
export function hasUnsavedProgress(facts: readonly ExecutedFact[]): boolean {
	const meaningful = facts.filter((fact) => fact.outcome === "ok" && isSupportedTool(fact.tool));
	if (meaningful.length === 0) return false;
	// R6：只有**真实落盘**的 BIOS 保存才算"已保存"；结构化失败（declined/stale/…）不算。
	return !meaningful.some(isSavedFact);
}

/**
 * R6：把真实结果投影成保存状态输入。
 *
 * 每一维都来自**实际发生的写入回执**，而不是"出现过某个工具名"：
 * - `progress`：`bios_manage_task` 的业务状态成功；
 * - `draft`：`bios_save_experience_draft` 的业务状态成功（含 `unchanged` 已存在）；
 * - `link`：草稿已保存但回链失败（独立事实）；
 * - `checkpoint`：本轮真实检查点写入结果（由调用方给出）。
 */
export function saveStatusInputs(input: { readonly automationEnabled: boolean; readonly facts: readonly ExecutedFact[]; readonly checkpoint: "none" | "ok" | "failed" | "limited"; readonly pendingReflection: boolean; readonly shortfall?: string | null }): Parameters<typeof projectSaveStatus>[0] {
	const shortfall = input.shortfall ?? null;
	// D2：被**补记预算硬闸门**拒绝的那一次写入不是"业务保存失败"——它是"本轮没轮到写"。
	// 把它算成 failed 会让状态显示成"保存失败"，而正确语义是"部分保存（受限）"。
	const facts = shortfall === null ? input.facts : input.facts.filter((fact) => fact.tool !== shortfall);
	const saved = facts.filter(isSavedFact);
	const progressStatuses = SAVE_SUCCESS_STATUSES.bios_manage_task ?? [];
	const progress = facts.some((fact) => fact.tool === "bios_manage_task" && fact.outcome === "ok" && typeof fact.businessStatus === "string" && progressStatuses.includes(fact.businessStatus)) ? "ok" : facts.some((fact) => fact.tool === "bios_manage_task" && fact.outcome !== "ok") ? "failed" : "none";
	const draft = facts.some((fact) => fact.tool === "bios_save_experience_draft" && isSavedFact(fact)) ? "ok" : facts.some((fact) => fact.tool === "bios_save_experience_draft" && fact.outcome !== "ok") ? "failed" : "none";
	const linkFailed = saved.some((fact) => fact.linkFailed === true);
	return { automationEnabled: input.automationEnabled, checkpoint: input.checkpoint, progress, draft, link: linkFailed ? "failed" : draft === "ok" ? "ok" : "none", pendingReflection: input.pendingReflection, shortfall };
}

/** 组装检查点（纯函数：调用方给齐全部事实，这里只做结构约束与有界化）。 */
export function buildCheckpoint(input: {
	readonly runId: string;
	readonly projectId: string;
	readonly workspaceId: string;
	readonly sessionId: string | null;
	readonly requestKey: string;
	readonly recordedAt: number;
	readonly baseline: CodeBaseline;
	readonly executed: readonly ExecutedFact[];
	readonly task: CheckpointTaskLink | null;
	readonly outcome: CheckpointOutcome;
	readonly pendingReflection: boolean;
}): AutomationCheckpoint {
	const executed = input.executed.slice(0, 64);
	const changedFiles = [...new Set(executed.filter((fact) => fact.wrote).flatMap((fact) => fact.files))].slice(0, 64);
	return {
		version: 1,
		runId: input.runId,
		projectId: input.projectId,
		workspaceId: input.workspaceId,
		sessionId: input.sessionId,
		branch: input.baseline.branch,
		requestKey: input.requestKey,
		recordedAt: input.recordedAt,
		baseline: input.baseline,
		executed,
		changedFiles,
		task: input.task,
		outcome: input.outcome,
		pendingReflection: input.pendingReflection,
	};
}

/** 检查点索引项：只有"未归并/有唯一证据/待补记"的才受保护，不得被轮换。 */
export function checkpointRef(input: { readonly runId: string; readonly recordedAt: number; readonly taskId: string | null; readonly pendingReflection: boolean; readonly protectedFromRotation: boolean }): CheckpointRef {
	return { runId: input.runId, recordedAt: input.recordedAt, taskId: input.taskId, pendingReflection: input.pendingReflection, protectedFromRotation: input.protectedFromRotation };
}

/** 对外显示的最小保存状态（AW §10）。 */
export type SaveStatus = "idle" | "preparing" | "prepared" | "partial" | "referenced" | "saved" | "pending-reflection" | "save-failed" | "automation-off" | "needs-decision";

/**
 * 把"事实检查点/任务进度/经验草稿/回链"四件独立结果投影成一个最小状态。
 *
 * R6：状态的每一维都必须来自**真实写入结果**（`none` 未发生 / `ok` 已落盘 / `failed` 失败 /
 * `limited` 因容量受限未新增）。任何一维"未发生"都不能被推断成"已保存"。
 */
export function projectSaveStatus(input: {
	readonly automationEnabled: boolean;
	readonly checkpoint: "none" | "ok" | "failed" | "limited";
	readonly progress: "none" | "ok" | "failed";
	readonly draft: "none" | "ok" | "failed";
	readonly link: "none" | "ok" | "failed";
	/** 是否仍有一轮补记尚未完成（持久标记 `saved=false`）。 */
	readonly pendingReflection: boolean;
	/**
	 * D2：补记阶段**因 provider 预算用尽被拒绝的许可内写入**（工具名；没有则为 null）。
	 *
	 * 为什么需要：2 次真实请求是硬上限，不能为了让最后一次响应里的工具跑起来而放开第 3 次请求；
	 * 但也不能拿单个任务的成功当作整轮补记完成——必须如实显示"还有一部分没保存"。
	 */
	readonly shortfall?: string | null;
}): {
	readonly status: SaveStatus;
	readonly note: string;
} {
	if (!input.automationEnabled) return { status: "automation-off", note: "自动记忆已关闭" };
	if (input.checkpoint === "failed" || input.progress === "failed" || input.draft === "failed") return { status: "save-failed", note: "部分保存失败：普通开发继续，可按提示重试" };
	if (input.checkpoint === "limited") return { status: "partial", note: "保存受限：受保护记录已占满预算，本轮检查点未新增（已有证据未丢失）" };
	// D2：预算用尽是**受限**而不是失败：已保存的部分如实算已保存，未保存的部分明确说出来。
	if (input.shortfall !== undefined && input.shortfall !== null && (input.progress === "ok" || input.draft === "ok")) {
		const missing = input.shortfall === "bios_save_experience_draft" ? "经验草稿" : "任务进度";
		return { status: "partial", note: `有进展已保存，但补记预算已用尽：${missing}未保存（不放宽请求上限）` };
	}
	if (input.pendingReflection) return { status: "pending-reflection", note: "有进展待补记" };
	// 经验已保存但回链失败：如实说"经验已保存，任务关联待重试"，不整体说未保存。
	if (input.draft === "ok" && input.link === "failed") return { status: "partial", note: "经验已保存，任务关联待重试" };
	if (input.draft === "ok" || input.progress === "ok" || input.checkpoint === "ok") return { status: "saved", note: "已保存本轮进展" };
	return { status: "idle", note: "本轮暂无可保存进展" };
}
