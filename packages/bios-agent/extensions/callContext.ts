/**
 * R31-2 / R31-3：**真实调用上下文**（不使用 `process.cwd()` 冒充会话目录）。
 *
 * 工具的 `execute(toolCallId, params, signal, onUpdate, ctx)` 与事件的 handler 都能拿到真实
 * `ctx.cwd` / `ctx.signal` / `ctx.sessionManager`。把它们集中在这里：
 * - `cwd`：会话工作目录（路径授权的判定基准）。**缺失即视为不可用**，不退回进程 cwd——
 *   进程 cwd 是 Package 目录，拿它当会话目录会把"另一个工作区"的事实当成当前续跑。
 * - `authorizedRoots`：可信的额外授权根（`BIOS_AUTHORIZED_ROOTS`，只能由适配层注入）。
 * - `signal`：真实取消信号；所有读取都要带上并在 await 后复查。
 * - `sessionId`：会话身份，用于隔离选择与迟到结果（不同会话的选择不互相沿用）。
 * - `configFingerprint`：可信配置指纹，用于发现"组装期间策略/授权/知识根变化"。
 */
import { readAuthorizedRootsFromEnv } from "../core/projects/authorization.ts";
import { serviceIdentityOf } from "../core/context/serviceIdentity.ts";
import { configFingerprint, readBiosHostConfig, withActualService, type BiosHostConfig } from "./hostConfig.ts";

/** 工具/事件上下文中我们真正依赖的那几个字段（结构化，便于单测直接构造）。 */
export type BiosCallLike = {
	readonly cwd?: unknown;
	readonly signal?: unknown;
	readonly sessionManager?: { getSessionId?: (() => string) | undefined; getLeafId?: (() => string | null) | undefined; getBranch?: (() => readonly unknown[]) | undefined } | undefined;
	/**
	 * D4：Pi 报告的**当前模型**快照（`ExtensionContext.model`）。
	 *
	 * 它是"资料到底会发给谁"的唯一事实来源（provider / id / baseUrl）；只有它能决定
	 * 宿主绑定的具名端点许可是否仍然有效。缺失即按"读不到实际服务"保守处理。
	 */
	readonly model?: unknown;
};

export type BiosCallContext = {
	/** 会话工作目录；空串表示"本次调用没有可用会话目录"。 */
	readonly cwd: string;
	/** 本次调用可用的额外授权根。 */
	readonly authorizedRoots: readonly string[];
	readonly signal: AbortSignal | undefined;
	readonly sessionId: string | null;
	/**
	 * 当前 Pi 分支最近的真实 user entry。before_agent_start 尚未写入新用户消息，
	 * 因此只能在首个 context（用户消息已持久化）绑定它；不能拿先前叶子当新用户身份。
	 */
	readonly userEntryId: string | null;
	readonly configFingerprint: string;
	readonly config: BiosHostConfig;
};

function readSessionId(ctx: BiosCallLike): string | null {
	try {
		const id = ctx.sessionManager?.getSessionId?.();
		return typeof id === "string" && id !== "" ? id : null;
	} catch {
		// 会话管理器不该抛异常；真抛了也不能让工具挂掉——按"未知会话"处理（更保守）。
		return null;
	}
}

function readUserEntryId(ctx: BiosCallLike): string | null {
	try {
		const branch = ctx.sessionManager?.getBranch?.();
		if (!Array.isArray(branch)) return null;
		for (let i = branch.length - 1; i >= Math.max(0, branch.length - 512); i--) {
			const entry = branch[i];
			if (entry === null || typeof entry !== "object" || !("type" in entry) || entry.type !== "message" || !("message" in entry)) continue;
			const message = entry.message;
			if (message !== null && typeof message === "object" && "role" in message && message.role === "user" && "id" in entry && typeof entry.id === "string" && entry.id !== "") return entry.id;
		}
		return null;
	} catch {
		return null;
	}
}

export function buildCallContext(ctx: BiosCallLike | undefined): BiosCallContext {
	const cwd = typeof ctx?.cwd === "string" ? ctx.cwd : "";
	const signal = ctx?.signal instanceof AbortSignal ? ctx.signal : undefined;
	// D4：实际服务身份只能来自 Pi 的调用上下文（env 是进程启动快照，模型可能已切）。
	const config = withActualService(readBiosHostConfig(), serviceIdentityOf(ctx?.model));
	return { cwd, authorizedRoots: readAuthorizedRootsFromEnv(), signal, sessionId: readSessionId(ctx ?? {}), userEntryId: readUserEntryId(ctx ?? {}), configFingerprint: configFingerprint(config), config };
}

/** 取消检查：所有 await 之后都必须调它（工具与注入共用）。 */
export function assertNotAborted(signal: AbortSignal | undefined, what: string): void {
	if (signal?.aborted === true) {
		const error = new Error(`${what}已取消`);
		error.name = "AbortError";
		throw error;
	}
}
