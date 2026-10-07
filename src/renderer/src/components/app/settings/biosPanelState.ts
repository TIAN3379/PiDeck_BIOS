/**
 * BM-07A R36-1：**BIOS 面板的状态机（纯函数，可被 node --test 直接覆盖）**。
 *
 * 面板原先把 projects/tasks/preview/pending 放在组件里、`buildPreview` 回来就直接 `setPreview`，
 * 于是：切会话/换 agent/换代次/撤权后的**迟到结果**会写进新会话的面板；旧正文在撤权后仍然显示；
 * 首次刷新还存在"`refreshProjects` 更新 projectId 后，串任务时仍捕获旧的空 projectId"的闭包缺陷。
 *
 * 这里把"身份隔离"变成可测的规则：
 * - **身份键**（session + agent + runtimeGeneration）或**配置代次**一变，立即失效列表/预览/回执，
 *   并推进 `acceptedEpoch` —— 所有在飞的旧请求结果都会被 `settle()` 丢弃；
 * - 列表/任务结果只在代次匹配时落地；项目/任务被清空时**不隐式选中第一项**（只做校验）；
 * - `synced` 只由"后端回执确认成功"产生，本地选择一律算 `candidate`。
 */
import type { BiosPreviewResult, BiosProjectSummary, BiosTaskSummary } from "../../../../../shared/types/bios";

/** 界面身份：会话 + agent + 运行时代次（任一变化都不能沿用旧结果）。 */
export type BiosPanelIdentity = {
	readonly sessionId: string | null;
	readonly agentId: string | null;
	readonly generation: number | null;
};

/** 已同步的选择（只有后端回执确认成功才写入）。 */
export type BiosSyncedSelection = {
	readonly projectId: string;
	readonly taskId: string;
	readonly workspaceId: string | null;
	readonly contextEnabled: boolean;
};

export type BiosPanelState = {
	/** 身份键（变化即失效旧结果）。 */
	readonly identityKey: string;
	/** 可信配置版本（变化即失效旧预览，避免撤权后仍显示 maySend=true 的旧正文）。 */
	readonly configEpoch: number;
	/** 当前"愿意接受"的请求代次：只有等于它的结果才会落地。 */
	readonly acceptedEpoch: number;
	readonly busy: string | null;
	readonly projects: readonly BiosProjectSummary[];
	readonly tasks: readonly BiosTaskSummary[];
	readonly projectId: string | null;
	readonly taskId: string | null;
	readonly preview: BiosPreviewResult | null;
	readonly receipt: { readonly text: string; readonly synced: boolean } | null;
	readonly problem: string | null;
	readonly synced: BiosSyncedSelection | null;
};

export function identityKeyOf(identity: BiosPanelIdentity): string {
	return `${identity.sessionId ?? "-"}|${identity.agentId ?? "-"}|${identity.generation === null ? "-" : String(identity.generation)}`;
}

export function initialBiosPanelState(): BiosPanelState {
	return { identityKey: "", configEpoch: -1, acceptedEpoch: 0, busy: null, projects: [], tasks: [], projectId: null, taskId: null, preview: null, receipt: null, problem: null, synced: null };
}

/**
 * 身份/配置变化：立即失效旧列表、旧预览、旧回执，并推进代次（在飞的旧结果全部作废）。
 *
 * 返回同一引用表示"什么都没变"（避免无谓重渲染）。
 */
export function syncScope(state: BiosPanelState, identityKey: string, configEpoch: number, nextEpoch: number): BiosPanelState {
	const identityChanged = state.identityKey !== identityKey;
	const configChanged = state.configEpoch !== configEpoch;
	if (!identityChanged && !configChanged) return state;
	if (identityChanged) {
		return { ...state, identityKey, configEpoch, acceptedEpoch: nextEpoch, busy: null, projects: [], tasks: [], projectId: null, taskId: null, preview: null, receipt: null, problem: null, synced: null };
	}
	// 只换配置：保留列表（授权变化后由调用方重新拉取），但**旧正文与旧回执必须消失**，
	// 否则"撤权后仍显示 maySendToModel=true 的旧预览"。
	return { ...state, configEpoch, acceptedEpoch: nextEpoch, busy: null, preview: null, receipt: null, problem: null, synced: null };
}

/** 开始一次请求：记录代次与进度标签；只有这个代次的结果会被接受。 */
export function beginRequest(state: BiosPanelState, epoch: number, label: string): BiosPanelState {
	return { ...state, acceptedEpoch: epoch, busy: label, problem: null };
}

/** 落地一次请求结果；代次不匹配（迟到/已失效）时原样返回，不写任何字段。 */
export function settle(state: BiosPanelState, epoch: number, patch: Partial<BiosPanelState>): BiosPanelState {
	if (epoch !== state.acceptedEpoch) return state;
	return { ...state, ...patch, busy: null };
}

/**
 * 列表结果的**补丁**（配合 `settle` 使用）：校验当前选择是否还在新列表里；不在就清空。
 *
 * 刻意返回补丁而不是新状态：调用方必须走 `settle(state, epoch, projectPatch(...))`，
 * 这样迟到结果连"补丁"都不会被应用。
 */
export function projectPatch(state: BiosPanelState, projects: readonly BiosProjectSummary[]): Partial<BiosPanelState> {
	const projectId = state.projectId !== null && projects.some((project) => project.projectId === state.projectId) ? state.projectId : null;
	if (projectId === null) return { projects, projectId: null, taskId: null, tasks: [], preview: null, synced: null };
	return { projects, projectId };
}

/** 任务结果的补丁：同样只做校验，不替用户选第一项（"候选"与"已同步"由 selectionView 区分）。 */
export function taskPatch(state: BiosPanelState, tasks: readonly BiosTaskSummary[]): Partial<BiosPanelState> {
	const taskId = state.taskId !== null && tasks.some((task) => task.taskId === state.taskId) ? state.taskId : null;
	return { tasks, taskId };
}

/** 用户显式选择项目：清空任务与旧预览（任务归属另一个项目）。 */
export function chooseProject(state: BiosPanelState, projectId: string): BiosPanelState {
	if (projectId === state.projectId) return state;
	return { ...state, acceptedEpoch: state.acceptedEpoch + 1, busy: null, projectId: projectId === "" ? null : projectId, taskId: null, tasks: [], preview: null, receipt: null, synced: null };
}

/** 用户显式选择任务。 */
export function chooseTask(state: BiosPanelState, taskId: string): BiosPanelState {
	return { ...state, acceptedEpoch: state.acceptedEpoch + 1, busy: null, taskId: taskId === "" ? null : taskId, preview: null, receipt: null, synced: null };
}

export type BiosSelectionView = {
	readonly projectId: string | null;
	readonly taskId: string | null;
	/** none = 未选择；candidate = 本地选择但后端未确认；synced = 后端回执确认过同一选择。 */
	readonly status: "none" | "candidate" | "synced";
	readonly contextEnabled: boolean | null;
};

/** 选择展示状态：本地选择永远只是"候选"，只有回执确认过才算"已同步"。 */
export function selectionView(state: BiosPanelState): BiosSelectionView {
	const { projectId, taskId } = state;
	if (projectId === null || taskId === null) return { projectId, taskId, status: "none", contextEnabled: null };
	const synced = state.synced;
	const match = synced !== null && synced.projectId === projectId && synced.taskId === taskId;
	return { projectId, taskId, status: match ? "synced" : "candidate", contextEnabled: match ? synced.contextEnabled : null };
}

/** 记下一次成功的同步（只有后端回执确认成功时才调用）。 */
export function markSynced(state: BiosPanelState, selection: BiosSyncedSelection, receiptText: string): BiosPanelState {
	return { ...state, synced: selection, receipt: { text: receiptText, synced: true } };
}

/** 记下"没能同步"的回执（意图保留、但界面不得显示成已生效）。 */
export function markUnsynced(state: BiosPanelState, receiptText: string, problem: string | null): BiosPanelState {
	return { ...state, synced: null, receipt: { text: receiptText, synced: false }, problem };
}

/** 预览结果落地：代次匹配才写；不匹配（迟到）直接丢弃。 */
export function applyPreview(state: BiosPanelState, epoch: number, preview: BiosPreviewResult): BiosPanelState {
	return settle(state, epoch, { preview });
}

/** 读取失败：代次匹配才写错误，避免旧会话的错误飘到新会话。 */
export function applyFailure(state: BiosPanelState, epoch: number, problem: string): BiosPanelState {
	return settle(state, epoch, { problem, preview: null });
}
