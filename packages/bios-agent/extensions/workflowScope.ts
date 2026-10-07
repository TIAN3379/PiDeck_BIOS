/** CW-01：会话级草稿许可。真实项目/目录/外发授权只来自宿主；模型不能扩大范围。 */
import { realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { buildCallContext, assertNotAborted, type BiosCallContext, type BiosCallLike } from "./callContext.ts";
import { isRevoked, projectBookkeepingGranted } from "./automationState.ts";
import { openProjectProfile } from "../core/projects/binding.ts";
import { readRegistry, resolveProjectBinding } from "../core/storage/registry.ts";
import { outboundPolicy } from "../core/context/policy.ts";
import { hostReadiness } from "./hostConfig.ts";
import { scopeOf } from "./historyGuard.ts";
import { boundText, resolveModelBudget } from "./outbound.ts";

export type WorkflowContext = BiosCallLike & { readonly hasUI?: boolean; readonly ui?: { confirm(title: string, message: string, options?: { signal?: AbortSignal; timeout?: number }): Promise<boolean> } };
export type WorkflowScope = { call: BiosCallContext; root: string; cwd: string; projectId: string; workspaceId: string; registryRevision: number; profileRevision: number; key: string };
export class WorkflowError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
let permission: string | null = null;
let permissionEpoch = 0;

/** 撤回普通草稿写入与自动续接许可；不修改磁盘记录。 */
export function clearWorkflowPermission(): void {
	permission = null;
	permissionEpoch++;
}

/** 同一 Pi 调用重试命中同一记录；已有记录由 core 返回 CAS 冲突，不重复落库或覆盖。 */
export function workflowRecordId(scope: WorkflowScope, kind: "task" | "exp" | "feature", toolCallId: string): string {
	if (!toolCallId) throw new WorkflowError("invalid-call", "需要真实工具调用身份，未创建记录");
	return `${kind}-${createHash("sha256")
		.update(JSON.stringify([scope.root, scope.call.sessionId, scope.projectId, scope.workspaceId, kind, toolCallId]))
		.digest("hex")}`;
}

/** 只定位 cwd 的确切登记，不按名称、远端、父目录或第一个项目猜测。 */
export async function resolveWorkflowScope(ctx: WorkflowContext, signal?: AbortSignal): Promise<WorkflowScope> {
	const fromCtx = buildCallContext(ctx);
	const call = signal === undefined ? fromCtx : { ...fromCtx, signal };
	assertNotAborted(call.signal, "工作流");
	const reason = hostReadiness(call.config).reason;
	if (reason !== null || call.config.knowledgeRoot === null) throw new WorkflowError("not-ready", reason ?? "知识库不可用");
	if (!outboundPolicy(call.config.endpoint).allowCommercialBody) throw new WorkflowError("endpoint-denied", "请先在 BIOS 设置中确认模型端点允许接收当前项目资料");
	if (!call.sessionId || !call.cwd) throw new WorkflowError("no-session", "需要真实会话身份与工作目录");
	const cwd = await realpath(call.cwd);
	const root = call.config.knowledgeRoot;
	const registry = await readRegistry({ root, signal: call.signal });
	const binding = resolveProjectBinding(registry, { workspacePath: cwd });
	if (binding.status !== "resolved" || !call.config.authorizedProjectIds.includes(binding.project.biosProjectId)) throw new WorkflowError("not-bound", "当前目录尚未唯一接入并授权，请在项目接入卡确认一次");
	const projectId = binding.project.biosProjectId;
	const opened = await openProjectProfile({ root, cwd, authorizedRoots: call.authorizedRoots, workspacePath: cwd, biosProjectId: projectId, signal: call.signal });
	if (!opened.usable || opened.workspaceId === null || opened.profileRevision === null) throw new WorkflowError("binding-unusable", "项目档案与工作区绑定不可用，请核对接入状态");
	assertNotAborted(call.signal, "工作流");
	const current = buildCallContext(ctx);
	if (current.configFingerprint !== call.configFingerprint || current.sessionId !== call.sessionId || current.cwd !== call.cwd) throw new WorkflowError("stale", "配置或会话已改变，请重试");
	const key = JSON.stringify([call.sessionId, call.configFingerprint, cwd, projectId, opened.workspaceId, registry.revision, opened.profileRevision]);
	if (permission !== null && permission !== key) clearWorkflowPermission();
	return { call, root, cwd, projectId, workspaceId: opened.workspaceId, registryRevision: registry.revision, profileRevision: opened.profileRevision, key };
}

/** 每个会话/范围仅确认一次；延迟确认返回后仍复验，不给新会话或撤权结果授信。 */
export async function ensureWorkflowPermission(scope: WorkflowScope, ctx: WorkflowContext): Promise<void> {
	if (permission === scope.key) return;
	// AW-03：**宿主项目级持久许可**已开启本地普通记账、且本会话未被撤回时，不再按会话弹确认。
	// 安全等价性：`scope.key` 已包含配置指纹（含自动化开关与版本），端点/授权/知识根/目录根
	// 任一变化都会让 key 失效并重新走一次判定；`/bios-workflow off`（revoked）后本会话内也不会自动重新授权。
	if (projectBookkeepingGranted(scope.call.config, { projectId: scope.projectId, workspaceId: scope.workspaceId })) {
		permission = scope.key;
		return;
	}
	// 宿主许可开启后用户显式 `/bios-workflow off`：本会话保持暂停，不再用弹窗把许可"复活"
	// （持久关闭/重新开启都在宿主设置里完成）。关闭自动化时维持旧的会话级确认行为。
	if (scope.call.config.automation.enabled && isRevoked()) throw new WorkflowError("permission-revoked", "本会话已暂停 BIOS 自动记忆（/bios-workflow off）：如需继续请在 BIOS 设置里重新开启，或新开一个会话。");
	const epoch = permissionEpoch;
	if (ctx.hasUI !== true || ctx.ui === undefined) throw new WorkflowError("confirmation-unavailable", "当前宿主无法展示人工确认，未启用自动保存");
	const accepted = await ctx.ui.confirm("允许 AI 管理本会话的 BIOS 草稿？", `项目 ${scope.projectId}\n工作区 ${scope.cwd}\n允许自动建立任务、保存进度、保存待审核经验草稿，以及续接本工作区任务上下文。不会批准经验、添加验证、扩大授权、修改源码或提交代码。许可仅对本会话当前范围有效；/bios-workflow off 可撤回。`, {
		signal: scope.call.signal,
		timeout: 120000,
	});
	const current = await resolveWorkflowScope(ctx, scope.call.signal);
	if (current.key !== scope.key || epoch !== permissionEpoch) throw new WorkflowError("stale", "确认期间项目或配置变化/许可撤回，许可未生效");
	if (!accepted) throw new WorkflowError("declined", "你未允许自动保存；本次未写入");
	permission = scope.key;
}

/** 临界动作逐次确认；确认失败、取消、身份漂移都不写入。 */
export async function confirmWorkflowAction(scope: WorkflowScope, ctx: WorkflowContext, message: string): Promise<void> {
	if (ctx.hasUI !== true || ctx.ui === undefined || !(await ctx.ui.confirm("确认 BIOS 关键操作", message, { signal: scope.call.signal, timeout: 120000 }))) throw new WorkflowError("declined", "关键操作未确认，本次未写入");
	await recheckWorkflowScope(scope, ctx);
}

export async function recheckWorkflowScope(scope: WorkflowScope, ctx: WorkflowContext, requirePermission = false): Promise<void> {
	const current = await resolveWorkflowScope(ctx, scope.call.signal);
	if (current.key !== scope.key) throw new WorkflowError("stale", "项目绑定、档案或可信配置变化，未继续操作");
	if (requirePermission && permission !== scope.key) throw new WorkflowError("permission-revoked", "本会话自动保存许可已撤回，未继续操作");
}

/** 回执也受预算与范围重放守卫限制。不要重复把整份记录放入 details。 */
export function workflowResult(ctx: WorkflowContext, status: string, data: unknown = {}, text?: string, expected?: WorkflowScope) {
	const call = buildCallContext(ctx);
	const withheld = expected !== undefined && (call.configFingerprint !== expected.call.configFingerprint || call.sessionId !== expected.call.sessionId || call.cwd !== expected.call.cwd || !outboundPolicy(call.config.endpoint).allowCommercialBody);
	const bounded = boundText(withheld ? "工作流已返回，但期间会话/授权范围变化，正文已撤回。请在本地检查是否已发布，勿盲目重复创建。" : (text ?? JSON.stringify(data)), resolveModelBudget({ maxChars: 6000, maxBytes: 12000 }));
	return {
		content: [{ type: "text" as const, text: bounded.text }],
		details: { packageName: "bios-agent", status, withheld, scope: scopeOf(call.config, { cwd: call.cwd, authorizedRoots: call.authorizedRoots }), outbound: outboundPolicy(call.config.endpoint), budget: { usedChars: bounded.usedChars, usedBytes: bounded.usedBytes, truncated: bounded.truncated }, counts: {} },
	};
}

/** 不透传文件系统错误中的路径/商业内容；已发布的写结果由调用方直接报告。 */
export function workflowFailure(ctx: WorkflowContext, error: unknown) {
	if (error instanceof WorkflowError) return workflowResult(ctx, error.code, { status: error.code, message: error.message });
	if (error instanceof Error && error.name === "AbortError") return workflowResult(ctx, "cancelled", { status: "cancelled", message: "本次工作流已取消，未继续操作。" });
	const code = error !== null && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
	return workflowResult(ctx, "failed", { status: "failed", message: `BIOS 工作流未完成（${code.slice(0, 60)}）。请核对工具状态，不要假定已保存或盲目重复创建。` });
}

export function requireOnlyKeys(input: object, allowed: readonly string[]): void {
	if (Object.keys(input).some((key) => !allowed.includes(key))) throw new WorkflowError("invalid-argument", "不接受额外字段，授权、来源、审核与验证状态由宿主管理");
}
