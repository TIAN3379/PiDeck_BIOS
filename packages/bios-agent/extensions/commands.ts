/**
 * R31-2 / B2：**人工任务选择与上下文开关**命令（`/bios-task`、`/bios-context`）。
 *
 * 与上一轮的三点差别：
 * 1. **选择经过真实服务校验**：项目必须在宿主授权集合内、任务必须真实存在、工作区必须属于该任务；
 *    换项目/任务而未指定工作区时**清除**旧工作区（不沿用、不默认挑第一项）；
 * 2. **有可读回执**：用 Pi 的声明式消息通道 `pi.sendMessage`（`customType: "bios-receipt"`）
 *    返回结果与失败原因，不再静默忽略；不新建 HTTP、不借认证/GUI 桥扩权；
 * 3. **会话隔离**：选择记录会话身份；不同会话按"未选择"处理（恢复后需重选，UI 会提示）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readTaskDetail } from "../core/tasks/index.ts";
import { buildCallContext } from "./callContext.ts";
import { hostReadiness, readInitialSelection } from "./hostConfig.ts";
import { clearSelection, describeSelection, initialAdoptionState, markInitialAdoption, selectionFor, updateSelection, type BiosSelection } from "./selection.ts";

export const BIOS_RECEIPT_CUSTOM_TYPE = "bios-receipt";

export type CommandReceipt = { readonly ok: boolean; readonly text: string; readonly details: Record<string, unknown> };

function split(args: string): string[] {
	return args
		.trim()
		.split(/\s+/)
		.filter((value) => value !== "");
}

/** `/bios-task [status|clear|select <projectId> <taskId> [workspaceId]]`。 */
export async function handleBiosTaskCommand(args: string, ctx: unknown): Promise<CommandReceipt> {
	const parts = split(args);
	const action = parts[0] ?? "status";
	const call = buildCallContext(ctx as Parameters<typeof buildCallContext>[0]);
	const readiness = hostReadiness(call.config);
	if (action === "clear") {
		clearSelection();
		return { ok: true, text: "BIOS 选择已清空（上下文注入同时关闭）。", details: { action: "clear" } };
	}
	if (action === "status") {
		const view = selectionFor(call.sessionId, call.configFingerprint);
		return { ok: true, text: describeSelection(view, call.sessionId), details: { action: "status", selection: view.selection, belongsToSession: view.belongsToSession, autoDisabledReason: view.autoDisabledReason } };
	}
	if (action !== "select") {
		return { ok: false, text: "用法：/bios-task status｜/bios-task clear｜/bios-task select <projectId> <taskId> [workspaceId]", details: { action } };
	}
	const projectId = parts[1];
	const taskId = parts[2];
	const workspaceId = parts[3];
	if (projectId === undefined || taskId === undefined) return { ok: false, text: "用法：/bios-task select <projectId> <taskId> [workspaceId]", details: { action } };
	if (!readiness.ready) return { ok: false, text: `无法选择：${readiness.reason ?? "宿主未就绪"}`, details: { action } };
	if (!call.config.authorizedProjectIds.includes(projectId)) return { ok: false, text: `拒绝选择：项目 ${projectId} 不在宿主授权集合内（模型与命令都不能给自己扩权）。`, details: { action, projectId } };
	if (call.cwd === "") return { ok: false, text: "拒绝选择：本次调用没有可用的会话工作目录（ctx.cwd）。", details: { action, projectId, taskId } };

	// 真实服务校验：任务必须存在、属于该项目；工作区必须等于任务入档的工作区。
	const detail = await readTaskDetail({ root: call.config.knowledgeRoot as string, projectId, taskId, cwd: call.cwd, authorizedRoots: call.authorizedRoots, authorizedProjectIds: call.config.authorizedProjectIds, signal: call.signal });
	if (detail.status !== "ok" || detail.task === null) {
		return { ok: false, text: `拒绝选择：任务 ${taskId} 不存在或未授权（${detail.status}）。请用人工 CLI 确认项目/任务 ID。`, details: { action, projectId, taskId, status: detail.status } };
	}
	const taskWorkspaceId = detail.task.workspace.workspaceId;
	if (workspaceId !== undefined && workspaceId !== taskWorkspaceId) {
		return { ok: false, text: `拒绝选择：工作区 ${workspaceId} 不是任务 ${taskId} 入档的工作区 ${taskWorkspaceId}（不把另一个工作区的任务当成当前续跑）。`, details: { action, projectId, taskId, taskWorkspaceId } };
	}
	const previous = selectionFor(call.sessionId, call.configFingerprint).selection;
	// 换任务时**只**沿用本次显式给出的工作区：其余情况按任务绑定重建，绝不沿用旧工作区。
	const nextWorkspaceId = workspaceId ?? taskWorkspaceId;
	const patch: Partial<BiosSelection> = { projectId, taskId, workspaceId: nextWorkspaceId };
	const changedWorkspace = previous.workspaceId !== null && previous.workspaceId !== nextWorkspaceId;
	const next = updateSelection(patch, { sessionId: call.sessionId, configFingerprint: call.configFingerprint });
	const lines = [
		`已选择任务：项目 ${projectId}｜任务 ${taskId}｜工作区 ${nextWorkspaceId}（按任务绑定重建${changedWorkspace ? `；原工作区 ${previous.workspaceId} 已清除` : ""}）`,
		`上下文注入：${next.contextEnabled ? "开" : "关（用 /bios-context on 打开；打开不等于端点允许）"}`,
		`会话：${call.sessionId ?? "（无会话上下文）"}`,
	];
	if (detail.workspaceAuthorized === false) lines.push("提示：任务工作区当前不在本次会话授权范围内：工具会只给标识与缺口，不输出任务正文。");
	return { ok: true, text: lines.join("\n"), details: { action, projectId, taskId, workspaceId: nextWorkspaceId, clearedPreviousWorkspace: changedWorkspace, workspaceAuthorized: detail.workspaceAuthorized } };
}

/** `/bios-context [on|off|status]`（默认 off；打开不等于端点允许）。 */
export async function handleBiosContextCommand(args: string, ctx: unknown): Promise<CommandReceipt> {
	const action = split(args)[0] ?? "status";
	const call = buildCallContext(ctx as Parameters<typeof buildCallContext>[0]);
	const view = selectionFor(call.sessionId, call.configFingerprint);
	if (action === "on") {
		if (view.selection.projectId === null || view.selection.taskId === null) {
			return { ok: false, text: "无法打开：请先用 /bios-task select 选择一个已授权的任务（不自动挑任务、不自动打开）。", details: { action, opened: false } };
		}
		updateSelection({ contextEnabled: true }, { sessionId: call.sessionId, configFingerprint: call.configFingerprint });
		const endpoint = call.config.endpoint.endpointAllowed;
		const note = endpoint === true ? "端点策略 allowed：可注入商业正文。" : endpoint === false ? "端点策略 denied：打开后仍不会注入商业正文（只给标识与缺口）。" : "端点策略未知：默认不自动注入商业正文，需显式确认端点。";
		return { ok: true, text: `已打开本会话 BIOS 上下文注入。${note}`, details: { action, opened: true, endpointAllowed: endpoint } };
	}
	if (action === "off") {
		updateSelection({ contextEnabled: false }, { sessionId: call.sessionId, configFingerprint: call.configFingerprint });
		return { ok: true, text: "已关闭本会话 BIOS 上下文注入（下一请求起移除本扩展注入的内容）。", details: { action, opened: false } };
	}
	const status = selectionFor(call.sessionId, call.configFingerprint);
	const endpoint = call.config.endpoint.endpointAllowed;
	return {
		ok: true,
		text: `${describeSelection(status, call.sessionId)}\n端点策略：${endpoint === true ? "allowed" : endpoint === false ? "denied" : "unknown（默认不注入商业正文）"}`,
		details: { action: "status", selection: status.selection, endpointAllowed: endpoint, autoDisabledReason: status.autoDisabledReason },
	};
}

/**
 * 命令回执：用 Pi 的声明式消息通道呈现（失败也有回执，不再静默）。
 *
 * R34-3：**结构化成功标志必须进 `details`**——适配层（桌面主进程）要靠 `details.ok` + `details.action`
 * + `details.selection` 判断"这个动作真的成功了"，不能只看消息文本里有没有出现 "BIOS"。
 */
async function emit(pi: ExtensionAPI, receipt: CommandReceipt): Promise<void> {
	try {
		await pi.sendMessage({ customType: BIOS_RECEIPT_CUSTOM_TYPE, content: receipt.text, display: true, details: { ok: receipt.ok, ...receipt.details } });
	} catch {
		// 回执通道失败不能让命令本身抛错（宿主/模式可能不支持）：状态已经更新，下一次状态命令仍可查。
	}
}

/**
 * R31-2 / C3：采纳**适配层注入的初始选择**（`BIOS_SELECTED_*`）。
 *
 * - 与手动 `/bios-task select` 走**同一套校验**：项目必须在授权集合内、任务必须真实存在、
 *   工作区必须等于任务入档的工作区；任一条不成立就**不选择**并记录原因（不自动挑、不沿用）。
 * - 幂等：同一会话只采纳一次（记录在 `selection` 模块里），适配层重复注入不会覆盖工程师的选择。
 */
export async function adoptInitialSelection(ctx: unknown, notify?: (text: string) => void | Promise<void>): Promise<{ readonly adopted: boolean; readonly reason: string | null }> {
	const call = buildCallContext(ctx as Parameters<typeof buildCallContext>[0]);
	// 每个会话只采纳一次：工程师手动选择后不得被适配层的初始值改回去；
	// 换会话（新的 sessionId）时重新采纳，这正是"恢复后按当前会话重验"的路径。
	const state = initialAdoptionState();
	if (state.done && state.sessionId === call.sessionId) return { adopted: false, reason: null };
	const initial = readInitialSelection();
	if (initial.taskId === null) {
		markInitialAdoption(null, call.sessionId);
		return { adopted: false, reason: null };
	}
	/** 失败一律**给回执**：注入的选择没能生效时必须让人知道，而不是静默当作"没选"。 */
	const fail = async (reason: string): Promise<{ readonly adopted: boolean; readonly reason: string }> => {
		markInitialAdoption(reason, call.sessionId);
		if (notify !== undefined) await notify(`BIOS 初始选择未采纳：${reason}`);
		return { adopted: false, reason };
	};
	if (!hostReadiness(call.config).ready) return fail("宿主未就绪：未采纳注入的初始选择");
	if (initial.projectId === null || !call.config.authorizedProjectIds.includes(initial.projectId)) return fail("注入的初始选择引用了未授权项目：未采纳");
	if (call.cwd === "") return fail("没有可用的会话工作目录（ctx.cwd）：未采纳注入的初始选择");
	const detail = await readTaskDetail({ root: call.config.knowledgeRoot as string, projectId: initial.projectId, taskId: initial.taskId, cwd: call.cwd, authorizedRoots: call.authorizedRoots, authorizedProjectIds: call.config.authorizedProjectIds, signal: call.signal });
	if (detail.status !== "ok" || detail.task === null) return fail(`注入的初始选择任务不可用（${detail.status}）：未采纳`);
	const taskWorkspaceId = detail.task.workspace.workspaceId;
	if (initial.workspaceId !== null && initial.workspaceId !== taskWorkspaceId) return fail(`注入的初始选择工作区不属于该任务（${initial.workspaceId} ≠ ${taskWorkspaceId}）：未采纳`);
	updateSelection({ projectId: initial.projectId, taskId: initial.taskId, workspaceId: taskWorkspaceId, contextEnabled: initial.contextEnabled }, { sessionId: call.sessionId, configFingerprint: call.configFingerprint });
	markInitialAdoption(null, call.sessionId);
	if (notify !== undefined) await notify(`BIOS 初始选择已生效：项目 ${initial.projectId}｜任务 ${initial.taskId}｜工作区 ${taskWorkspaceId}｜上下文注入 ${initial.contextEnabled ? "开" : "关"}`);
	return { adopted: true, reason: null };
}

export function registerBiosCommands(pi: ExtensionAPI): void {
	pi.registerCommand("bios-task", {
		description: "选择/查看 BIOS 任务与工作区（选择经服务校验，只保存知识 ID 与开关）",
		handler: async (args, ctx) => {
			await emit(pi, await handleBiosTaskCommand(args, ctx));
		},
	});
	pi.registerCommand("bios-context", {
		description: "打开/关闭 BIOS 受控上下文注入（默认关闭；端点策略仍由宿主配置决定）",
		handler: async (args, ctx) => {
			await emit(pi, await handleBiosContextCommand(args, ctx));
		},
	});
}
