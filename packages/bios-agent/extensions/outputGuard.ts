/**
 * R32-1：**输出前的动态复查**（读取途中策略/授权/身份变化 ⇒ 丢弃旧正文）。
 *
 * 为什么必须有这一层：工具与注入都是"先判定、再 await 读取、最后输出"。判定时拿到的是**当时**的
 * 可信配置与选择；读取期间端点可能被改成 denied/unknown、项目/客户/需求可能被撤权、知识根可能被换掉、
 * 会话选择可能已经切走、调用可能被取消。此时若照原样输出，就等于"用旧许可发新正文"。
 *
 * 三条规则：
 * 1. **只看当前事实**：输出前重新读取可信宿主配置，与判定时的指纹比对；
 * 2. **变化即丢弃正文**（不是换个状态标签继续发）：授权/根/目录/端点多维变化一律撤回商业正文；
 * 3. **取消同样丢弃**：`signal.aborted` 后不输出已读内容（与"读取失败"分开表述）。
 */
import type { EndpointServiceIdentity } from "../core/context/index.ts";
import { configFingerprint, hostReadiness, readBiosHostConfig, withActualService, type BiosHostConfig } from "./hostConfig.ts";
import { selectionFor } from "./selection.ts";

/** 丢弃原因的分类（不换标签继续发，所以只有丢弃时才用得上）。 */
export type OutputRecheckStatus = "cancelled" | "stale" | "denied";

export type OutputRecheck = { readonly ok: true; readonly status: null; readonly reason: null; readonly config: BiosHostConfig; readonly fingerprint: string } | { readonly ok: false; readonly status: OutputRecheckStatus; readonly reason: string; readonly config: BiosHostConfig; readonly fingerprint: string };

/**
 * 输出前复查：取消状态 + 当前可信配置 + 会话选择代次。
 *
 * `config` 是**重新读取**的当前配置：调用方应当用它渲染信封（端点策略/知识根来源），
 * 否则"变化后仍报旧策略"会误导调用方。
 *
 * D4：`actual` 是**当前调用上下文**里的实际模型服务身份（只能来自 Pi 的 `ctx.model`）。
 * 重新读取的 env 里没有这个事实，若不并回来，"配置指纹"就会在自己和自己比较时判成变化
 * （每次读取都变成 stale）。调用方必须在 await 后重新读 `ctx.model`，不能复用读取前的快照。
 */
export function recheckBeforeOutput(input: { readonly configFingerprint: string; readonly signal: AbortSignal | undefined; readonly sessionId: string | null; readonly selectionGeneration: number; readonly env?: NodeJS.ProcessEnv; readonly actual?: EndpointServiceIdentity | null }): OutputRecheck {
	const current = withActualService(readBiosHostConfig(input.env), input.actual ?? null);
	const fingerprint = configFingerprint(current, input.env);
	if (input.signal?.aborted === true) return { ok: false, status: "cancelled", reason: "读取期间本次调用被取消：不输出已读取的内容", config: current, fingerprint };
	const readiness = hostReadiness(current);
	if (readiness.reason !== null) return { ok: false, status: "denied", reason: `读取期间宿主配置已不可用：${readiness.reason}`, config: current, fingerprint };
	if (fingerprint !== input.configFingerprint) {
		return { ok: false, status: "stale", reason: "读取期间可信配置（端点/授权项目/需求/客户/知识根/目录根）已变化：丢弃旧正文", config: current, fingerprint };
	}
	if (selectionFor(input.sessionId, fingerprint).generation !== input.selectionGeneration) {
		return { ok: false, status: "stale", reason: "读取期间本次会话的选择已变化（切换/关闭/清理）：丢弃旧正文", config: current, fingerprint };
	}
	return { ok: true, status: null, reason: null, config: current, fingerprint };
}
