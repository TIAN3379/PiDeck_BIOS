/**
 * BM-07B B-04：**任务管理**（列表 / 详情 / 编辑 / 状态推进 / 上下文选择）。
 *
 * 约定：
 * - 列表**读取有界**（主进程按 `BIOS_TASK_LIST_LIMIT` 截断）；状态筛选只是**视图**，
 *   不会为了筛选去全库扫描；到上限时界面必须提示"可能被截断"；
 * - 正文保存与状态变更**分开**：`updateTask` 只改正文，`changeTaskStatus` 单独动作；
 * - 选中任务只是**候选**：只有显式点"用于当前会话"才走既有 selection/ACK 链路；
 *   切任务立刻清掉旧回执与旧详情（不让上一任务的回执看起来还对当前任务有效）；
 * - 每次请求带代次：过期响应直接丢弃；写失败/冲突保留调用方草稿，由组件决定重读。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiosSelectionResult, BiosTaskSummary } from "../../../shared/types/bios";
import { BIOS_TASK_LIST_LIMIT } from "../../../shared/biosLimits";
import type { TaskChanges, TaskDetailResult, TaskEvidenceInput, TaskStatusResult, TaskValidationInput, TaskWriteResult } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export type BiosTaskStatusFilter = "all" | "planned" | "in_progress" | "blocked" | "done" | "archived";

/** 新建任务的表单负载（组件持有草稿；hook 只负责提交与结果）。 */
export type BiosTaskCreateDraft = {
	taskId: string;
	workspaceId: string;
	requirement: string;
	decisions: readonly string[];
	todos: readonly string[];
	blockers: readonly string[];
	relatedFiles: readonly string[];
	sourceExperienceIds: readonly string[];
	validations: readonly TaskValidationInput[];
	branch?: string;
	baseCommit?: string;
};

/** 编辑任务的正文变更（不含 taskId/workspaceId：改归属必须显式重新登记，不在这里偷改）。 */
export type BiosTaskBodyDraft = {
	requirement?: string;
	decisions?: readonly string[];
	todos?: readonly string[];
	blockers?: readonly string[];
	relatedFiles?: readonly string[];
	sourceExperienceIds?: readonly string[];
	validations?: readonly TaskValidationInput[];
};

export type BiosTasksState = {
	loading: boolean;
	busy: string | null;
	problem: string | null;
	items: BiosTaskSummary[];
	/** 列表为空/被拒的受控原因（撤权/身份不符），不是"没有任务"。 */
	listGap: string | null;
	statusFilter: BiosTaskStatusFilter;
	selectedTaskId: string | null;
	detail: TaskDetailResult | null;
	writeOutcome: TaskWriteResult | null;
	statusOutcome: TaskStatusResult | null;
	/** 选择/上下文回执（只对**当前选中任务**有效）。 */
	selection: BiosSelectionResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useBiosTasks(input: { projectId: string | null; workspaceId?: string }) {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosTasksState>({
		loading: false,
		busy: null,
		problem: null,
		items: [],
		listGap: null,
		statusFilter: "all",
		selectedTaskId: null,
		detail: null,
		writeOutcome: null,
		statusOutcome: null,
		selection: null,
	});
	const epochRef = useRef(0);
	const pendingSelectionRef = useRef<import("../../../shared/types/bios").BiosSelectionRequest | null>(null);
	const aliveRef = useRef(true);
	const selectedRef = useRef<string | null>(null);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const patch = useCallback((next: Partial<BiosTasksState>) => {
		if (!aliveRef.current) return;
		setState((previous) => {
			const merged = { ...previous, ...next };
			selectedRef.current = merged.selectedTaskId;
			return merged;
		});
	}, []);

	const projectId = input.projectId;
	const fresh = useCallback((epoch: number) => aliveRef.current && epoch === epochRef.current, []);

	const refresh = useCallback(
		async (options?: { keepSelection?: boolean }, ownerEpoch?: number) => {
			const epoch = ownerEpoch ?? ++epochRef.current;
			if (!fresh(epoch)) return;
			if (projectId === null) {
				patch({ items: [], listGap: null, loading: false, busy: null });
				return;
			}
			if (claim === null) {
				patch({ items: [], listGap: t("bios.workbench.noSession"), loading: false, busy: null });
				return;
			}
			// 外部刷新取得新代次时已淘汰旧详情/写入回执，不能遗留它的 busy。
			// 同一写操作内部的 ownerEpoch 刷新则继续保持该操作的忙碌状态。
			patch({ loading: true, ...(ownerEpoch === undefined ? { busy: null } : {}) });
			try {
				const listed = await desktopApi.bios.listTasks({ ...claim, projectId });
				if (epoch !== epochRef.current) return;
				const keep = options?.keepSelection === true ? selectedRef.current : null;
				const visible = keep !== null && listed.items.some((task) => task.taskId === keep);
				patch({
					items: listed.items,
					listGap: listed.gap,
					loading: false,
					problem: null,
					selectedTaskId: visible ? keep : null,
					// 选择被清掉时，旧详情/回执必须同时清掉（不能留给另一个任务）。
					...(visible ? {} : { detail: null, selection: null }),
				});
				return true;
			} catch (error) {
				if (epoch !== epochRef.current) return;
				patch({ loading: false, items: [], listGap: messageOf(error) });
			}
		},
		[claim, fresh, patch, projectId, t],
	);

	const claimKey = claim === null ? "none" : `${claim.sessionRef.agentId}|${claim.sessionRef.sessionId ?? "-"}|${claim.runtimeGeneration}`;
	useEffect(() => {
		// 项目或会话身份变化：清空选中与详情，重新取列表。
		patch({ selectedTaskId: null, detail: null, selection: null, writeOutcome: null, statusOutcome: null, busy: null });
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [projectId, claimKey]);

	useEffect(() => {
		const off = desktopApi.bios.onChanged((event) => {
			if (event?.kind === "selection") {
				if (event.selection.sessionRef.agentId !== claim?.sessionRef.agentId || event.selection.runtimeGeneration !== claim?.runtimeGeneration) return;
				const pending = pendingSelectionRef.current;
				if (pending && event.selection.projectId === pending.projectId && event.selection.taskId === pending.taskId && event.selection.workspaceId === pending.workspaceId && event.selection.contextEnabled === pending.contextEnabled) return;
				++epochRef.current;
				patch({ selection: null, busy: null });
				return;
			}
			// 配置变化：授权可能已撤回 ⇒ 连列表一起重取，并清掉不可能再可见的详情。
			patch({ selectedTaskId: null, detail: null, selection: null, writeOutcome: null, statusOutcome: null, busy: null });
			void refresh();
		});
		return off;
	}, [claim, patch, refresh]);

	const setStatusFilter = useCallback((next: BiosTaskStatusFilter) => patch({ statusFilter: next }), [patch]);

	const selectTask = useCallback(
		async (taskId: string, ownerEpoch?: number) => {
			if (projectId === null) return;
			if (claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return;
			}
			const epoch = ownerEpoch ?? ++epochRef.current;
			if (!fresh(epoch)) return;
			// 切任务立刻清旧回执/旧详情：回执属于"那个任务的选择"，不能贴到新任务上。
			patch({ selectedTaskId: taskId, detail: null, selection: null, writeOutcome: null, statusOutcome: null, busy: "detail", problem: null });
			try {
				const outcome = await desktopApi.bios.readTaskDetail({ ...claim, projectId, taskId });
				if (epoch !== epochRef.current) return;
				patch({ detail: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.staleReason === null ? {} : { problem: outcome.guard.staleReason }) });
			} catch (error) {
				if (epoch !== epochRef.current) return;
				patch({ busy: null, problem: messageOf(error) });
			}
		},
		[claim, fresh, patch, projectId, t],
	);

	const createTask = useCallback(
		async (draft: BiosTaskCreateDraft) => {
			if (projectId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "create", problem: null, writeOutcome: null });
			try {
				const outcome = await desktopApi.bios.createTask({
					...claim,
					projectId,
					taskId: draft.taskId,
					workspaceId: draft.workspaceId,
					requirement: draft.requirement,
					decisions: [...draft.decisions],
					todos: [...draft.todos],
					blockers: [...draft.blockers],
					relatedFiles: [...draft.relatedFiles],
					sourceExperienceIds: [...draft.sourceExperienceIds],
					validations: [...draft.validations],
					...(draft.branch === undefined || draft.branch.trim() === "" ? {} : { branch: draft.branch.trim() }),
					...(draft.baseCommit === undefined || draft.baseCommit.trim() === "" ? {} : { baseCommit: draft.baseCommit.trim() }),
				});
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable) {
					await refresh(undefined, epoch);
					if (!fresh(epoch)) return null;
					if (outcome.result.status === "created") await selectTask(draft.taskId, epoch);
				}
				if (!fresh(epoch)) return null;
				patch({ writeOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, fresh, patch, projectId, refresh, selectTask, t],
	);

	const updateTask = useCallback(
		async (taskId: string, expectedRevision: number, changes: BiosTaskBodyDraft) => {
			if (projectId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const detail: TaskChanges = {
				...(changes.requirement === undefined ? {} : { requirement: changes.requirement }),
				...(changes.decisions === undefined ? {} : { decisions: [...changes.decisions] }),
				...(changes.todos === undefined ? {} : { todos: [...changes.todos] }),
				...(changes.blockers === undefined ? {} : { blockers: [...changes.blockers] }),
				...(changes.relatedFiles === undefined ? {} : { relatedFiles: [...changes.relatedFiles] }),
				...(changes.sourceExperienceIds === undefined ? {} : { sourceExperienceIds: [...changes.sourceExperienceIds] }),
				...(changes.validations === undefined ? {} : { validations: [...changes.validations] }),
			};
			const epoch = ++epochRef.current;
			patch({ busy: "save", problem: null, writeOutcome: null });
			try {
				const outcome = await desktopApi.bios.updateTask({ ...claim, projectId, taskId, expectedRevision, changes: detail });
				// 保存后刷新 revision：先重读详情再写回结果，否则冲突提示会被自己的刷新抹掉。
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable && (outcome.result.status === "updated" || outcome.result.status === "unchanged")) await selectTask(taskId, epoch);
				if (!fresh(epoch)) return null;
				patch({ writeOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, fresh, patch, projectId, selectTask, t],
	);

	/**
	 * 只改"参考经验 ID"（B-06 §B-06 第 3 条）。
	 *
	 * 刻意只动 `sourceExperienceIds`：不 copy patch、不改当前项目身份、**不**把参考批准成
	 * 目标项目的事实。参考"是否可作依据"由 core 的 `usableAsBasis` 判定并在详情里如实展示。
	 */
	const changeReferences = useCallback(
		async (experienceId: string, add: boolean) => {
			const detail = state.detail;
			const taskId = selectedRef.current;
			if (projectId === null || taskId === null || claim === null || detail?.task == null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const current = detail.task.sourceExperienceIds;
			const next = add ? (current.includes(experienceId) ? current : [...current, experienceId]) : current.filter((id) => id !== experienceId);
			if (next.length === current.length) return null;
			return updateTask(taskId, detail.revision ?? 0, { sourceExperienceIds: next });
		},
		[claim, patch, projectId, state.detail, t, updateTask],
	);

	const referenceTaskId = state.detail?.task?.id ?? null;

	const changeStatus = useCallback(
		async (taskId: string, expectedRevision: number, to: BiosTaskStatusFilter, reason: string) => {
			if (projectId === null || claim === null || to === "all") {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "status", problem: null, statusOutcome: null });
			try {
				const outcome = await desktopApi.bios.changeTaskStatus({ ...claim, projectId, taskId, expectedRevision, to, reason });
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable && (outcome.result.status === "changed" || outcome.result.status === "unchanged")) await selectTask(taskId, epoch);
				if (!fresh(epoch)) return null;
				patch({ statusOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, fresh, patch, projectId, selectTask, t],
	);

	/** 只有显式调用才动上下文：选中任务本身**不**开上下文。 */
	const applyContext = useCallback(
		async (enabled: boolean) => {
			const taskId = selectedRef.current;
			const detail = state.detail;
			if (projectId === null || taskId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const workspaceId = input.workspaceId ?? detail?.task?.workspace.workspaceId ?? null;
			const epoch = ++epochRef.current;
			const request = { ...claim, projectId, taskId, workspaceId, contextEnabled: enabled };
			pendingSelectionRef.current = request;
			patch({ busy: "context", problem: null });
			try {
				const outcome = await desktopApi.bios.applySelection(request);
				if (!fresh(epoch)) return null;
				patch({ selection: outcome, busy: null });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			} finally {
				if (pendingSelectionRef.current === request) pendingSelectionRef.current = null;
			}
		},
		[claim, fresh, input.workspaceId, patch, projectId, state.detail, t],
	);

	const clearSelection = useCallback(() => {
		++epochRef.current;
		patch({ selectedTaskId: null, detail: null, selection: null, writeOutcome: null, statusOutcome: null, problem: null, busy: null });
	}, [patch]);

	const clearNotices = useCallback(() => patch({ problem: null, writeOutcome: null, statusOutcome: null }), [patch]);

	/** 列表达到主进程上限 ⇒ 视图可能不完整，必须提示（不能当成"没有更多任务"）。 */
	const truncated = state.items.length >= BIOS_TASK_LIST_LIMIT;
	const visibleItems = useMemo(() => (state.statusFilter === "all" ? state.items : state.items.filter((task) => task.status === state.statusFilter)), [state.items, state.statusFilter]);

	return useMemo(
		() => ({ ...state, projectId, claim, visibleItems, truncated, referenceTaskId, refresh, setStatusFilter, selectTask, createTask, updateTask, changeStatus, changeReferences, applyContext, clearSelection, clearNotices }),
		[state, projectId, claim, visibleItems, truncated, referenceTaskId, refresh, setStatusFilter, selectTask, createTask, updateTask, changeStatus, changeReferences, applyContext, clearSelection, clearNotices],
	);
}

export type BiosTasks = ReturnType<typeof useBiosTasks>;

/** 供测试与组件共用的证据输入形状（与 core 的合法子集一致，不新增字段）。 */
export type BiosTaskEvidenceInput = TaskEvidenceInput;
