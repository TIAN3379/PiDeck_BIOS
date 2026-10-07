/**
 * R34-2 / R34-3 / R35-1～3：**真实会话端口**（适配层唯一的会话身份、命令通道与运行时门禁）。
 *
 * 职责（全部复用现有桌面能力，不新开通道、不 fork Pi）：
 * 1. **身份解析**：用 `AgentManager.list()` 的 `AgentTab` 解析 agentId / sessionId / cwd /
 *    `runtimeGeneration`，核对"提交的 sessionId 与按 agentId 找到的 tab 一致"；
 * 2. **命令 + 结构化回执**（R35-2）：把 `/bios-task select …` 与 `/bios-context on|off` 依次送出，
 *    用会话文件里**新增**的 `custom_message` 回执（`customType: "bios-receipt"` 的 `details`）
 *    核对 ok/action/选择/开关；增量读（`readSince`）保证长会话也能拿到新回执，
 *    不把 MAX_EVENTS 的账本读取当实时 ACK 查询；
 * 3. **发送前门禁**（R35-3）：每个动作**发送前后**都复核原始会话绑定；绑定变了就**不再发送**
 *    后续命令（过期请求不能向新 runtime 打开上下文），而不是"发完了再报未同步"；
 * 4. **运行中失效**（R35-1）：提供 `listSessions` / `pushContextOff` / `stopRuntime` 三个**必填**能力，
 *    让"配置收窄"能真正停掉旧 runtime —— 缺失能力不再静默变成"没有旧 runtime"。
 */
import type { BiosSessionClaim, BiosSessionSelection } from "../../shared/types/bios";
import type { SessionProcessEvent } from "../../shared/types/trajectory";
import type { BiosSessionPort, BiosSessionResolution, BiosSessionRuntimeInfo, BiosSyncRequest } from "./BiosKnowledgeService";

/** 会话句柄（从既有 `AgentTab` 取；只挑这里需要的字段，便于测试构造）。 */
export type BiosSessionTab = {
	readonly agentId: string;
	readonly sessionId: string | null;
	/** PiDeck 会话身份（选择键与 `PIDECK_SESSION_ID` 同源）。 */
	readonly deckSessionId?: string | null;
	readonly cwd: string;
	readonly runtimeGeneration: number;
	/** 会话文件路径（读结构化回执用）；没有就没有可核对的回执。 */
	readonly sessionPath?: string | null;
};

/** 增量读结果（新事件 + 下一次的起始偏移）。 */
export type BiosIncrementalRead = { readonly events: readonly SessionProcessEvent[]; readonly nextOffset: number };

export type BiosSessionPortDeps = {
	/** 列出当前真实会话（既有 AgentManager.list()）。 */
	listTabs: () => readonly BiosSessionTab[];
	/** 发送命令到某个会话（既有 AgentManager.sendPrompt）。 */
	sendPrompt: (input: { readonly agentId: string; readonly message: string }) => Promise<void>;
	/** 停止某个会话的运行时（既有 AgentManager.stop）；**必填**：收窄后旧进程不能继续调用知识工具。 */
	stopRuntime: (agentId: string) => Promise<void>;
	/**
	 * B-01：停止**并确认退出**（优先于 `stopRuntime`）。
	 *
	 * 生产装配接 `AgentManager.stopAndConfirm`：只有收到真实 `exit` 才返回 `stopped: true`。
	 * 缺省时退化为 `stopRuntime`（旧行为）——仅用于没有确认能力的替身/测试。
	 */
	stopRuntimeConfirmed?: (agentId: string) => Promise<{ readonly stopped: boolean; readonly error: string | null; readonly replaced?: boolean }>;
	/** B-01：标记该 runtime 授权已撤，**立即**阻断其业务发送（不等停止返回）。 */
	revokeRuntime?: (input: { readonly agentId: string; readonly generation: number }) => void;
	/** 当前会话文件长度（增量游标起点）。 */
	fileSize: (filePath: string) => Promise<number>;
	/** 自偏移起增量读过程事件（既有 sessions/sessionProcessEventsFile）。 */
	readSince: (filePath: string, offset: number) => Promise<BiosIncrementalRead>;
	/** 回执等待上限（毫秒）与轮询间隔（测试可注入小值）。 */
	receiptTimeoutMs?: number;
	pollIntervalMs?: number;
	/** 当前时间戳注入（测试用）。 */
	now?: () => number;
	/** 会话选择（可选，用于问题诊断）。 */
	readSelection?: (sessionKey: string) => BiosSessionSelection | null;
};

const DEFAULT_RECEIPT_TIMEOUT_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
const RECEIPT_CUSTOM_TYPE = "bios-receipt";

function idOf(tab: BiosSessionTab): string | null {
	return tab.sessionId ?? tab.deckSessionId ?? null;
}

/**
 * 解析会话引用（**带 sessionId 一致性核对**）。
 *
 * 提交了 sessionId 时，它必须与按 agentId 命中的 tab 一致；否则说明请求来自别的 runtime，
 * 直接拒绝（回退到"按 sessionId 再找一次"会把旧许可带到新会话）。
 */
export function resolveSessionClaim(claim: BiosSessionClaim, tabs: readonly BiosSessionTab[]): { readonly resolution: BiosSessionResolution } | { readonly error: string } {
	const byAgent = tabs.find((tab) => tab.agentId === claim.sessionRef.agentId);
	if (byAgent === undefined) {
		const bySession = claim.sessionRef.sessionId === null ? undefined : tabs.find((tab) => idOf(tab) === claim.sessionRef.sessionId);
		if (bySession !== undefined) return { error: "会话身份不一致：该 sessionId 已由另一个 agent 持有（拒绝把旧请求算到新 runtime）" };
		return { error: "会话不存在或已结束：请刷新后重新选择" };
	}
	const expectedSession = claim.sessionRef.sessionId;
	if (expectedSession !== null) {
		// 提交的 sessionId 必须属于**这个 agent 的这条会话**：pi 会话 id 与 PiDeck 身份都算
		// （渲染层可能只知道其中一个），但绝不能是别人的会话 id。
		const aliases = [byAgent.sessionId, byAgent.deckSessionId].filter((value): value is string => typeof value === "string" && value !== "");
		if (!aliases.includes(expectedSession)) return { error: `会话身份不一致：提交的 sessionId 与当前 agent 的会话不符（提交 ${expectedSession}，实际 ${aliases.join("/") || "无"}）` };
	}
	if (typeof byAgent.cwd !== "string" || byAgent.cwd.trim() === "") return { error: "该会话没有可用的工作目录：不使用进程 cwd 代替" };
	if (byAgent.runtimeGeneration !== claim.runtimeGeneration) return { error: `会话运行时代次已变化（当前 ${byAgent.runtimeGeneration}，请求 ${claim.runtimeGeneration}）：请刷新后重试` };
	// 选择键用 **PiDeck 会话身份**（`deckSessionId`）：`PiProcess` 注入子进程时用的
	// `PIDECK_SESSION_ID` 就是这个 id，两边必须是同一个键，否则"按会话的选择"对不上。
	return { resolution: { agentId: byAgent.agentId, sessionId: byAgent.deckSessionId ?? idOf(byAgent), cwd: byAgent.cwd, generation: byAgent.runtimeGeneration } };
}

/** 结构化回执核对：只认**本动作、成功、且选择/开关一致**的回执。 */
export function receiptMatches(details: Record<string, unknown> | undefined, expected: { readonly action: string; readonly projectId?: string; readonly taskId?: string; readonly workspaceId?: string | null; readonly opened?: boolean }): boolean {
	if (details === undefined) return false;
	if (details.ok !== true) return false;
	if (details.action !== expected.action) return false;
	if (expected.projectId !== undefined && details.projectId !== expected.projectId) return false;
	if (expected.taskId !== undefined && details.taskId !== expected.taskId) return false;
	// 命令回执会带上入档工作区；期望为空（未指定）时不额外要求回执带值。
	// R36-2：显式指定工作区时，回执**必须带上**同一个工作区；缺失或不同都不算本次成功。
	if (expected.workspaceId !== undefined && expected.workspaceId !== null && details.workspaceId !== expected.workspaceId) return false;
	if (expected.opened !== undefined) {
		// 开关结果必须与"我们要的开关状态"一致：回执说 off、我们要求 on ⇒ 不算 ACK。
		if (details.opened !== expected.opened) return false;
	}
	return true;
}

function biosReceipts(events: readonly SessionProcessEvent[]): readonly SessionProcessEvent[] {
	return events.filter((event) => event.kind === "custom" && event.customType === RECEIPT_CUSTOM_TYPE);
}

export function createBiosSessionPort(deps: BiosSessionPortDeps): BiosSessionPort {
	const timeoutMs = deps.receiptTimeoutMs ?? DEFAULT_RECEIPT_TIMEOUT_MS;
	const pollMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const now = deps.now ?? (() => Date.now());

	/** 复核原始会话绑定：任何一处变化都不能再当成"当前会话"。 */
	function bindingError(requestTime: { readonly claim: BiosSessionClaim; readonly resolution: BiosSessionResolution }): string | null {
		const again = resolveSessionClaim(requestTime.claim, deps.listTabs());
		if ("error" in again) return again.error;
		const current = again.resolution;
		if (current.generation !== requestTime.resolution.generation) return `会话运行时代次已变化（${requestTime.resolution.generation} → ${current.generation}）`;
		if (current.cwd !== requestTime.resolution.cwd) return "会话工作目录已变化";
		if (current.sessionId !== requestTime.resolution.sessionId) return "会话身份已变化";
		return null;
	}

	/** 发一条命令并等待**本次新增**的匹配回执；拿不到就返回错误（不把旧回执当 ACK）。 */
	async function runAndAwaitReceipt(tab: BiosSessionTab, command: string, expected: Parameters<typeof receiptMatches>[1], requestTime: { readonly claim: BiosSessionClaim; readonly resolution: BiosSessionResolution }): Promise<{ readonly text: string } | { readonly error: string }> {
		const filePath = tab.sessionPath ?? null;
		if (filePath === null) return { error: "该会话没有可读的会话文件：无法核对结构化回执（不做文本猜测）" };
		let cursor: number;
		try {
			cursor = await deps.fileSize(filePath);
		} catch (error) {
			return { error: `无法读取会话文件长度：${error instanceof Error ? error.message : "未知错误"}` };
		}
		// R35-3：读盘/取游标之后、**发送之前**再复核一次绑定（过期请求不产生副作用）。
		const beforeSend = bindingError(requestTime);
		if (beforeSend !== null) return { error: `会话绑定已变化（${beforeSend}）：未发送命令` };
		await deps.sendPrompt({ agentId: tab.agentId, message: command });
		const deadline = now() + timeoutMs;
		const seen: SessionProcessEvent[] = [];
		for (;;) {
			try {
				const chunk = await deps.readSince(filePath, cursor);
				cursor = chunk.nextOffset;
				seen.push(...chunk.events);
			} catch {
				// 读失败按"这次没看到回执"处理，继续等（可能是文件正被写入）。
			}
			const fresh = biosReceipts(seen);
			const matched = fresh.find((event) => receiptMatches(event.customDetails, expected));
			if (matched !== undefined) return { text: matched.detail ?? matched.summary };
			const failed = fresh.find((event) => event.customDetails !== undefined && event.customDetails.ok === false);
			if (failed !== undefined) return { error: `命令被拒绝（${String(failed.detail ?? failed.summary)}）` };
			if (now() >= deadline) {
				if (fresh.length > 0) return { error: `收到了回执但没有本动作的成功标志（${fresh.length} 条新回执）` };
				return { error: `等待回执超时（${timeoutMs}ms）：命令可能未被执行` };
			}
			await new Promise((resolve) => setTimeout(resolve, pollMs));
		}
	}

	function runtimeInfoOf(tab: BiosSessionTab): BiosSessionRuntimeInfo {
		// cwd 必须带出来：撤权/推关闭时要用**真实会话目录**构造 resolution，
		// 否则发送前绑定核对会拿假 cwd 自比（R36-2 的诊断就是 `cwd: ""` 导致"工作目录已变化：未发送命令"）。
		return { agentId: tab.agentId, sessionId: tab.deckSessionId ?? idOf(tab), cwd: tab.cwd, generation: tab.runtimeGeneration };
	}

	/**
	 * R36-2：**按 runtime 串行化**命令。
	 *
	 * 同一个 agent 上的选择/开关命令必须一条条走完（含等待回执），否则两条命令交叉时
	 * "等待期间出现的同动作回执"无法归属给哪次请求——Pi 的回执里没有请求 id，
	 * 串行化是唯一不新造协议的可靠做法。
	 */
	const runtimeQueues = new Map<string, Promise<unknown>>();
	function serialized<T>(agentId: string, task: () => Promise<T>): Promise<T> {
		const previous = runtimeQueues.get(agentId) ?? Promise.resolve();
		const next = previous.then(task, task);
		runtimeQueues.set(
			agentId,
			next.then(
				() => undefined,
				() => undefined,
			),
		);
		return next;
	}

	return {
		resolve(claim) {
			return resolveSessionClaim(claim, deps.listTabs());
		},
		// R35-1：这两个能力**不再可选**，生产装配必须接上，否则"没有旧 runtime"是假象。
		listSessions() {
			return deps.listTabs().map(runtimeInfoOf);
		},
		async pushContextOff(resolution) {
			const tab = deps.listTabs().find((candidate) => candidate.agentId === resolution.agentId);
			if (tab === undefined) return { error: "会话已结束：无需推送关闭" };
			return serialized(resolution.agentId, async () => {
				const outcome = await runAndAwaitReceipt(tab, "/bios-context off", { action: "off", opened: false }, { claim: { sessionRef: { agentId: resolution.agentId, sessionId: tab.deckSessionId ?? idOf(tab) }, runtimeGeneration: resolution.generation }, resolution });
				return "text" in outcome ? { receipt: `上下文已确认关闭（${outcome.text}）` } : outcome;
			});
		},
		async stopRuntime(resolution) {
			// R36-2：停止前核对**原 runtime**；代次已变说明旧的已经不在了（也不能停后来重开的新代次）。
			const current = deps.listTabs().find((candidate) => candidate.agentId === resolution.agentId);
			if (current !== undefined && current.runtimeGeneration !== resolution.generation) {
				return { stopped: true, error: null, replaced: true };
			}
			// B-01：先撤权（立即阻断发送），再尝试停止；即便停止确认失败，旧 runtime 也不能再发业务消息。
			try {
				deps.revokeRuntime?.({ agentId: resolution.agentId, generation: resolution.generation });
			} catch {
				/* 撤权是尽力而为的加锁动作，失败不阻塞停止流程本身 */
			}
			try {
				if (deps.stopRuntimeConfirmed !== undefined) {
					// 生产：只有确认真实 exit 才算 stopped；否则如实报未完成。
					const outcome = await deps.stopRuntimeConfirmed(resolution.agentId);
					return { stopped: outcome.stopped, error: outcome.error, ...(outcome.replaced === true ? { replaced: true } : {}) };
				}
				await deps.stopRuntime(resolution.agentId);
				return { stopped: true, error: null };
			} catch (error) {
				return { stopped: false, error: error instanceof Error ? error.message : "停止运行时失败" };
			}
		},
		/** B-01：标记撤权（由 service 在「标记旧许可」的同一时刻调用，立即阻断发送）。 */
		revokeAuthority(resolution) {
			try {
				deps.revokeRuntime?.({ agentId: resolution.agentId, generation: resolution.generation });
			} catch {
				/* 同上：撤权失败不能让收窄流程崩掉，读取侧门禁仍会挡住 */
			}
		},
		async syncSelection(request) {
			// 同一 runtime 上的命令串行化（含等待回执）：既避免交叉命令，也让"本次新增"
			// 真的等价于"本次请求的回执"。
			return serialized(request.resolution.agentId, async () => {
				const initial = bindingError({ claim: request.claim, resolution: request.resolution });
				if (initial !== null) return { error: `会话绑定已变化（${initial}）：未发送任何命令` };
				const tab = deps.listTabs().find((candidate) => candidate.agentId === request.resolution.agentId);
				if (tab === undefined) return { error: "会话在同步前已结束：不把命令发给别的会话" };
				const requestTime = { claim: request.claim, resolution: request.resolution };
				// R36-2：显式工作区也要进核对条件（否则"请求 workspace-b、回执 workspace-a"会被当成功）。
				const selectResult = await runAndAwaitReceipt(tab, request.commands.select, { action: "select", projectId: request.expectation.projectId, taskId: request.expectation.taskId, workspaceId: request.expectation.workspaceId }, requestTime);
				if ("error" in selectResult) return { error: `选择未同步：${selectResult.error}` };
				// 第一个动作之后、第二个动作之前再复核：换代前的请求不得向新 runtime 打开上下文。
				const beforeContext = bindingError(requestTime);
				if (beforeContext !== null) return { error: `会话绑定在两条命令之间变化（${beforeContext}）：未发送开关命令` };
				const contextResult = await runAndAwaitReceipt(tab, request.commands.context, { action: request.expectation.contextEnabled ? "on" : "off", opened: request.expectation.contextEnabled }, requestTime);
				if ("error" in contextResult) return { error: `上下文开关未同步：${contextResult.error}` };
				const after = bindingError(requestTime);
				if (after !== null) return { error: `会话绑定在等待回执期间变化（${after}）：本次同步不算当前会话已生效` };
				return { receipt: `select 已确认（${selectResult.text ?? "ok"}）｜context 已确认（${contextResult.text ?? "ok"}）` };
			});
		},
	};
}

/**
 * R35-1：**生产装配工厂**。
 *
 * 直接把 `AgentManager` 的形状接进端口——`listSessions` / `pushContextOff` / `stopRuntime`
 * 三个能力都在这里落地，而不是留给调用方"记得补"。
 */
export type BiosAgentManagerLike = {
	list: () => readonly {
		readonly id: string;
		readonly sessionId?: string | null;
		readonly deckSessionId?: string | null;
		readonly cwd?: string;
		readonly runtimeGeneration?: number;
		readonly sessionPath?: string | null;
	}[];
	sendPrompt: (input: { readonly agentId: string; readonly message: string; readonly description?: string; readonly requestId?: string }) => Promise<unknown>;
	stop: (agentId: string) => Promise<void>;
	/** B-01：停止并**确认退出**（生产 `AgentManager.stopAndConfirm`）。 */
	stopAndConfirm?: (agentId: string) => Promise<{ readonly stopped: boolean; readonly error: string | null; readonly replaced?: boolean }>;
	/** B-01：标记 runtime 授权已撤，立即阻断业务发送（生产 `AgentManager.revokeRuntimeAuthority`）。 */
	revokeRuntimeAuthority?: (agentId: string, generation: number) => void;
};

export function createBiosSessionPortFromAgentManager(
	manager: BiosAgentManagerLike,
	deps: {
		readonly fileSize: (filePath: string) => Promise<number>;
		readonly readSince: (filePath: string, offset: number) => Promise<BiosIncrementalRead>;
		readonly receiptTimeoutMs?: number;
		readonly pollIntervalMs?: number;
		readonly now?: () => number;
	},
): BiosSessionPort {
	return createBiosSessionPort({
		listTabs: () =>
			manager.list().map((tab) => ({
				agentId: tab.id,
				sessionId: tab.sessionId ?? null,
				deckSessionId: tab.deckSessionId ?? null,
				cwd: tab.cwd ?? "",
				runtimeGeneration: typeof tab.runtimeGeneration === "number" ? tab.runtimeGeneration : 0,
				sessionPath: tab.sessionPath ?? null,
			})),
		sendPrompt: async ({ agentId, message }) => {
			await manager.sendPrompt({ agentId, message, description: "BIOS 选择同步" });
		},
		stopRuntime: (agentId) => manager.stop(agentId),
		// B-01：生产装配优先用「确认退出」；替身没提供时退化为旧的 stop（并由测试单独覆盖失败路径）。
		...(manager.stopAndConfirm === undefined ? {} : { stopRuntimeConfirmed: (agentId: string) => manager.stopAndConfirm!(agentId) }),
		...(manager.revokeRuntimeAuthority === undefined ? {} : { revokeRuntime: ({ agentId, generation }: { readonly agentId: string; readonly generation: number }) => manager.revokeRuntimeAuthority!(agentId, generation) }),
		fileSize: deps.fileSize,
		readSince: deps.readSince,
		...(deps.receiptTimeoutMs === undefined ? {} : { receiptTimeoutMs: deps.receiptTimeoutMs }),
		...(deps.pollIntervalMs === undefined ? {} : { pollIntervalMs: deps.pollIntervalMs }),
		...(deps.now === undefined ? {} : { now: deps.now }),
	});
}
