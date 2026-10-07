/**
 * R33-1：**自有历史工具结果的重放守卫**（策略收窄后不再随历史重发商业正文）。
 *
 * 问题：`context` 事件只让我们替换"本次请求的消息列表"，而**已经进入会话历史**的 BIOS 工具结果
 * （`bios_get_task` 等返回的需求/待办/经验正文）会在之后的每次请求里被重新发送。上一轮的输出前守卫
 * 只能拦"正在读取"的结果，拦不住历史重放——端点从 allowed 改成 denied 后，旧正文仍会再发一次。
 *
 * 三条原则：
 * 1. **结构化归属**：只认 `role === "toolResult"` + `toolName` 属于本扩展自己的工具名，
 *    并且 `toolCallId` 能在助手消息的 tool call 里找到对应项（"识别真实工具归属及对应 tool-call"）；
 *    **不用文本子串**判断，也不动用户/助手/其它扩展的消息。
 * 2. **不破坏工具协议**：保留 `role`/`toolCallId`/`toolName`/`isError`/`timestamp` 与"恰好一条内容"的形态，
 *    只把内容换成撤回说明；不删除工具调用，也不改配对关系。
 * 3. **只按"收窄"撤回**：记录产出时的**授权范围**，输出前比对当前范围；端点不再是 allowed、
 *    知识根变化或授权集合收窄（记录⊄当前）即撤回；单纯放宽不撤回（旧结果仍在新范围内）。
 *
 * 宿主若不能可靠选择性撤回，本模块的替代动作是"撤回内容 + 可读回执要求隔离重开"，绝不保留旧许可。
 */
import { createHash } from "node:crypto";
import { outboundPolicy } from "../core/context/policy.ts";
import type { BiosHostConfig } from "./hostConfig.ts";

/** 本扩展自己注册的只读工具名（结构化归属依据；新增工具必须登记在这里）。 */
export const BIOS_TOOL_NAMES = ["bios_get_project_info", "bios_get_task", "bios_search_knowledge", "bios_get_feature", "bios_get_experience", "bios_preview_context"] as const;

/** 被撤回的历史工具结果里的可读回执（不含任何商业正文）。 */
export const WITHHELD_TOOL_RESULT_TEXT = "BIOS 读取结果已撤回：当前可信配置已收窄（端点不再允许外发/授权被撤销/知识根变化），扩展不再把这条历史结果发给模型。如需在新策略下继续，请隔离重开新会话（或在当前会话重新读取）。";

/** 产出该结果时的授权范围（只含 ID、策略与路径哈希：不含需求/经验正文）。 */
export type BiosResultScope = {
	readonly endpoint: "allowed" | "denied" | "unknown";
	readonly projectIds: readonly string[];
	readonly featureIds: readonly string[];
	readonly customers: readonly string[];
	/** 知识根路径的短哈希（换库即视为不可比）。 */
	readonly knowledgeRootHash: string;
	/**
	 * 产出时**已授权的目录根**哈希（排序、去重）。
	 *
	 * R34-1：历史结果依赖的不仅是"项目/需求/客户/端点"，还依赖**会话目录与目录授权**——
	 * 任务绑定工作区 B、当时授权 A+B 才能读到正文；只撤回 B 也必须让这条旧结果失效。
	 * 只记哈希（不记路径），比对时按"记录集合 ⊆ 当前集合"（只按收窄撤回）。
	 */
	readonly rootHashes: readonly string[];
	/** 产出时作为身份基准的会话目录哈希；`"none"` 表示当时没有可用会话目录。 */
	readonly cwdHash: string;
};

/** 通用短哈希（路径不落进记录，只留可比对的指纹）。 */
export function shortHash(value: string | null): string {
	if (value === null || value === "") return "none";
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function knowledgeRootHash(root: string | null): string {
	return root === null ? "none" : shortHash(root);
}

/** 记录范围时的**身份依据**（会话目录 + 目录授权）：单独取出来避免把整份 config 传进来。 */
export type BiosScopeIdentity = {
	readonly cwd: string;
	readonly authorizedRoots: readonly string[];
};

/** 从可信配置 + 身份依据提取"可记录的范围"。 */
export function scopeOf(config: BiosHostConfig, identity: BiosScopeIdentity): BiosResultScope {
	return {
		// Fresh reads and historical replay must obey the same effective grant, not just the legacy switch.
		endpoint: outboundPolicy(config.endpoint).allowCommercialBody ? "allowed" : config.endpoint.endpointAllowed === null ? "unknown" : "denied",
		projectIds: [...config.authorizedProjectIds],
		featureIds: [...config.allowedFeatureIds],
		customers: [...config.approvedCustomers],
		knowledgeRootHash: knowledgeRootHash(config.knowledgeRoot),
		rootHashes: [...new Set(identity.authorizedRoots.map((root) => shortHash(root)))].sort(),
		cwdHash: identity.cwd === "" ? "none" : shortHash(identity.cwd),
	};
}

function readScope(value: unknown): BiosResultScope | null {
	if (value === null || typeof value !== "object") return null;
	const candidate = value as Partial<Record<keyof BiosResultScope, unknown>>;
	const list = (input: unknown): string[] => (Array.isArray(input) ? input.filter((entry): entry is string => typeof entry === "string") : []);
	if (candidate.endpoint !== "allowed" && candidate.endpoint !== "denied" && candidate.endpoint !== "unknown") return null;
	if (typeof candidate.knowledgeRootHash !== "string") return null;
	// R34-1：没有目录授权证据的记录（本版本之前产出）**返回 null**，由调用方按"无法证明"保守处理。
	if (!Array.isArray(candidate.rootHashes) || typeof candidate.cwdHash !== "string") return null;
	return {
		endpoint: candidate.endpoint,
		projectIds: list(candidate.projectIds),
		featureIds: list(candidate.featureIds),
		customers: list(candidate.customers),
		knowledgeRootHash: candidate.knowledgeRootHash,
		rootHashes: list(candidate.rootHashes),
		cwdHash: candidate.cwdHash,
	};
}

/** 记录范围是否仍被当前范围覆盖（**只按收窄撤回**；放宽不影响旧结果）。 */
export function scopeStillAllowed(recorded: BiosResultScope, current: BiosResultScope): boolean {
	// 当前不允许外发商业正文 ⇒ 一律撤回，与记录时的端点无关。
	if (current.endpoint !== "allowed") return false;
	// 记录时就不允许 → 内容本来就被撤回，无需再次处理（保持原样，避免反复改写）。
	if (recorded.endpoint !== "allowed") return true;
	if (recorded.knowledgeRootHash !== current.knowledgeRootHash) return false;
	// R34-1：**目录授权**必须仍然覆盖记录时的全部根（撤回必需目录即失效；新增根不影响）。
	const covers = (recordedList: readonly string[], currentList: readonly string[]): boolean => recordedList.every((entry) => currentList.includes(entry));
	if (!covers(recorded.rootHashes, current.rootHashes)) return false;
	// 身份基准（会话目录）变化 ⇒ 这条结果已不属于当前续跑身份，不重放。
	if (recorded.cwdHash !== "none" && recorded.cwdHash !== current.cwdHash) return false;
	return covers(recorded.projectIds, current.projectIds) && covers(recorded.featureIds, current.featureIds) && covers(recorded.customers, current.customers);
}

type MessageLike = {
	readonly role?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly isError?: unknown;
	readonly timestamp?: unknown;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly toolCalls?: unknown;
};

/**
 * 收集"我们自己的工具调用"id。
 *
 * 真实 Pi 会话里工具调用是**助手消息 content 的 `toolCall` 片段**（`{type,toolCallId|id,name,arguments}`）；
 * 少数版本/形态把调用放在 `toolCalls`/`tool_calls` 数组里，故两者都认，但归属一律按**工具名**判断。
 */
export function ownToolCallIds(messages: readonly unknown[]): Set<string> {
	const ids = new Set<string>();
	const isOwnName = (name: unknown): boolean => typeof name === "string" && BIOS_TOOL_NAMES.includes(name as (typeof BIOS_TOOL_NAMES)[number]);
	const takeFromPart = (part: unknown): void => {
		if (part === null || typeof part !== "object") return;
		const candidate = part as MessageLike & { readonly type?: unknown; readonly id?: unknown; readonly name?: unknown; readonly toolName?: unknown; readonly toolCallId?: unknown };
		const isCall = candidate.type === "toolCall" || candidate.type === "tool_call" || (candidate.type === undefined && (candidate.name !== undefined || candidate.toolName !== undefined));
		if (!isCall) return;
		const name = candidate.toolName ?? candidate.name;
		if (!isOwnName(name)) return;
		const id = candidate.toolCallId ?? candidate.id;
		if (typeof id === "string" && id !== "") ids.add(id);
	};
	for (const message of messages) {
		if (message === null || typeof message !== "object") continue;
		const candidate = message as MessageLike;
		if (candidate.role !== "assistant") continue;
		if (Array.isArray(candidate.content)) for (const part of candidate.content) takeFromPart(part);
		if (Array.isArray(candidate.toolCalls)) for (const part of candidate.toolCalls) takeFromPart(part);
	}
	return ids;
}

/**
 * 是否是**本扩展自己的**工具结果：角色 + 工具名 + 与真实 tool call 的配对三者都要成立。
 *
 * 只按工具名判断会误伤其它扩展的同名工具；只按 id 判断会被伪造 id 蒙过去。
 */
export function isOwnToolResult(message: unknown, ownIds: ReadonlySet<string>): boolean {
	if (message === null || typeof message !== "object") return false;
	const candidate = message as MessageLike;
	if (candidate.role !== "toolResult") return false;
	if (typeof candidate.toolName !== "string" || !BIOS_TOOL_NAMES.includes(candidate.toolName as (typeof BIOS_TOOL_NAMES)[number])) return false;
	if (typeof candidate.toolCallId !== "string" || !ownIds.has(candidate.toolCallId)) return false;
	return true;
}

export type WithholdOutcome = {
	/** 处置后的消息列表（未改动时与输入同一引用）。 */
	readonly messages: readonly unknown[];
	/** 本次新撤回的条数。 */
	readonly withheld: number;
};

/**
 * 处置自有历史工具结果：收窄即撤回内容（保留工具协议字段），并打上 `withheld` 标记（幂等）。
 */
export function withholdOwnToolResults(messages: readonly unknown[], current: BiosResultScope): WithholdOutcome {
	const ownIds = ownToolCallIds(messages);
	let withheld = 0;
	let changed = false;
	const next = messages.map((message) => {
		if (!isOwnToolResult(message, ownIds)) return message;
		const candidate = message as MessageLike & { readonly details?: Record<string, unknown> };
		const details = (candidate.details ?? {}) as Record<string, unknown>;
		// 幂等：本模块已处置过、或内容本来就是"撤回态"（端点 deny/unknown 或身份闸门撤回）都不再改写。
		if (details.historyWithheld === true || details.withheld === true) return message;
		const outbound = (details.outbound ?? {}) as { readonly allowCommercialBody?: unknown };
		if (outbound.allowCommercialBody === false) return message;
		const recorded = readScope(details.scope);
		// R34-1：**无法证明仍获授权**的旧元数据（本版本之前产出、没有目录授权证据）保守处理——
		// 直接不重放，而不是"当前端点还允许就继续发"。用户在需要时应重新读取。
		const allowed = recorded === null ? false : scopeStillAllowed(recorded, current);
		if (allowed) return message;
		withheld += 1;
		changed = true;
		return {
			...candidate,
			// 保留 role/toolCallId/toolName/isError/timestamp：工具调用与结果的配对关系不变。
			content: [{ type: "text", text: WITHHELD_TOOL_RESULT_TEXT }],
			details: {
				status: "withheld",
				packageName: "bios-agent",
				outbound: { allowCommercialBody: false, note: "历史结果已撤回：当前策略不允许再发送商业正文" },
				historyWithheld: true,
				historyWithheldReason: recorded === null ? "缺少目录授权/身份证据（旧版本产出）：无法证明仍获授权，不重放历史结果" : "当前可信配置已收窄（端点/目录/知识根/授权集合/身份依据）：不重放历史结果",
				scope: current,
			},
		};
	});
	return { messages: changed ? next : messages, withheld };
}
