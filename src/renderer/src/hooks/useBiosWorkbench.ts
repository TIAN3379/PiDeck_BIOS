/**
 * BM-07B B-03：**BIOS 工作台**状态（项目区；任务/知识区由 B-04/B-05 填充）。
 *
 * 约定：
 * - 所有读写经 `desktopApi.bios.*`（主进程是唯一读库方）；本 hook 只做"取数 + 呈现态"，
 *   不持有任何路径/授权决定权；
 * - 每次请求带**请求代次**：切换项目 / 刷新 / 撤权后，过期响应必须被丢弃（不能贴到当前界面）；
 * - 配置变化（`bios:changed`）一律 refresh 并清空项目详情与检测结果——旧详情可能已不再可见；
 * - 建库是**显式动作**：选目录只写配置，`createStore` 才初始化（不隐式建库、不自动迁移）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiosAutomationStatus, BiosHostSettings, BiosProjectSummary, BiosReadiness, BiosRuntimeState, BiosSessionClaim, BiosStoreStatus } from "../../../shared/types/bios";
import { BIOS_SETTINGS_DEFAULTS } from "../../../shared/types/bios";
import type { BindProjectResult, ConfirmFieldInput, ConfirmProfileResult, DetectProjectResult, ProjectDecisionView } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

/** 确认字段的一项（界面只提交点名字段 + 值 + 依据）。 */
export type BiosConfirmDraft = ConfirmFieldInput;

export type BiosWorkbenchState = {
	loading: boolean;
	busy: string | null;
	problem: string | null;
	storeStatus: BiosStoreStatus | null;
	readiness: BiosReadiness | null;
	runtime: BiosRuntimeState | null;
	/** C5：宿主投影的自动记忆状态（`null` = 没读到/没配置，不伪造空状态）。 */
	automationStatus: BiosAutomationStatus | null;
	settings: BiosHostSettings;
	projects: BiosProjectSummary[];
	/** 列表为空时的受控原因（撤权/身份不符），不是"空库"。 */
	projectsGap: string | null;
	selectedProjectId: string | null;
	detail: ProjectDecisionView | null;
	detection: DetectProjectResult | null;
	bindOutcome: BindProjectResult | null;
	confirmOutcome: ConfirmProfileResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useBiosWorkbench(input: { desktopProjectId?: string; desktopProjectName?: string }) {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosWorkbenchState>({
		loading: false,
		busy: null,
		problem: null,
		storeStatus: null,
		readiness: null,
		runtime: null,
		automationStatus: null,
		settings: BIOS_SETTINGS_DEFAULTS,
		projects: [],
		projectsGap: null,
		selectedProjectId: null,
		detail: null,
		detection: null,
		bindOutcome: null,
		confirmOutcome: null,
	});
	/** 请求代次：切项目/刷新/撤权后自增，过期响应直接丢弃。 */
	const epochRef = useRef(0);
	const aliveRef = useRef(true);
	// 当前选中项目用 ref 读：让 loadProjects 保持稳定身份，避免每次选中都重订阅 bios:changed。
	const selectedRef = useRef<string | null>(null);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	const patch = useCallback((next: Partial<BiosWorkbenchState>) => {
		if (!aliveRef.current) return;
		setState((previous) => {
			const merged = { ...previous, ...next };
			selectedRef.current = merged.selectedProjectId;
			return merged;
		});
	}, []);
	const fresh = useCallback((epoch: number) => aliveRef.current && epoch === epochRef.current, []);

	// D4：`desktopProjectId` 必须进依赖。它被用来解析**宿主自动记忆状态**，
	// 若闭包捕获旧值，切换项目 A→B 后仍按 A 读，B 的界面会一直显示 A 的条数（§9.3 D4 实测）。
	const loadShell = useCallback(async () => {
		const epoch = epochRef.current;
		patch({ loading: true });
		try {
			const [settings, readiness, runtime, storeStatus, automationStatus] = await Promise.all([
				desktopApi.bios.getSettings(),
				desktopApi.bios.readiness(),
				desktopApi.bios.runtimeState(),
				desktopApi.bios.storeStatus(),
				// C5：自动记忆状态由**宿主**读附属记录后投影；读不到就保持 null（不显示正常空状态）。
				input.desktopProjectId === undefined ? Promise.resolve(null) : desktopApi.bios.automationStatus({ desktopProjectId: input.desktopProjectId }).catch(() => null),
			]);
			if (epoch !== epochRef.current) return;
			patch({ settings, readiness, runtime, storeStatus, automationStatus, problem: null, loading: false });
		} catch (error) {
			if (epoch !== epochRef.current) return;
			patch({ loading: false, problem: messageOf(error) });
		}
	}, [input.desktopProjectId, patch]);

	const loadProjects = useCallback(
		async (options?: { keepSelection?: boolean }) => {
			if (claim === null) {
				patch({ projects: [], projectsGap: t("bios.workbench.noSession") });
				return;
			}
			const epoch = epochRef.current;
			try {
				const listed = await desktopApi.bios.listProjects(claim);
				if (epoch !== epochRef.current) return;
				const keep = options?.keepSelection === true ? selectedRef.current : null;
				const stillVisible = keep !== null && listed.items.some((project) => project.projectId === keep);
				const matches = input.desktopProjectId === undefined ? [] : listed.items.filter((project) => project.desktopProjectId === input.desktopProjectId);
				const selected = stillVisible ? keep : matches.length === 1 ? matches[0].projectId : null;
				// 选中项目若已不在可见列表（撤权/未授权）⇒ 立刻清掉详情，不展示不可见正文。
				patch({ projects: listed.items, projectsGap: listed.gap, selectedProjectId: selected, ...(stillVisible ? {} : { detail: null, detection: null }) });
			} catch (error) {
				if (epoch !== epochRef.current) return;
				patch({ projects: [], projectsGap: messageOf(error) });
			}
		},
		[claim, input.desktopProjectId, patch, t],
	);

	const refresh = useCallback(async () => {
		epochRef.current += 1;
		patch({ detail: null, detection: null, bindOutcome: null, confirmOutcome: null, busy: null });
		await loadShell();
		await loadProjects({ keepSelection: true });
	}, [loadProjects, loadShell, patch]);

	// 首次进入 + 会话身份变化时重新取数（claim 对象每次渲染都是新的，用其稳定字段做依赖）。
	const claimKey = claim === null ? "none" : `${claim.sessionRef.agentId}|${claim.sessionRef.sessionId ?? "-"}|${claim.runtimeGeneration}`;
	useEffect(() => {
		patch({ selectedProjectId: null, projects: [], detail: null, detection: null });
		void refresh();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [claimKey, input.desktopProjectId]);

	// 配置/选择被改动：立即清空详情，避免展示已不可见的正文。
	useEffect(() => {
		const off = desktopApi.bios.onChanged((event) => {
			if (event?.kind === "selection") return;
			// 配置收窄/变化：清空详情与选中（旧详情可能已不可见），再重新取数。
			epochRef.current += 1;
			patch({ detail: null, detection: null, selectedProjectId: null, bindOutcome: null, confirmOutcome: null, busy: null });
			void loadShell();
			void loadProjects();
		});
		return off;
	}, [loadProjects, loadShell, patch]);

	/**
	 * D4：会话**终结回执**驱动默认状态自动刷新，不需要用户点刷新。
	 *
	 * 补记/检查点由 pi 子进程在 settle 边界写盘；渲染进程只能通过既有 runtime 事件得知
	 * "这一轮结束了"（`agents:state` → `status: "idle"`）。这里只重读宿主投影的自动记忆状态，
	 * 不重取项目/任务列表（避免打断用户正在填的表单）。
	 */
	const settleAgentId = claim?.sessionRef.agentId ?? null;
	const desktopProjectId = input.desktopProjectId ?? null;
	useEffect(() => {
		if (settleAgentId === null || desktopProjectId === null) return;
		let active = true;
		let readSequence = 0;
		const off = desktopApi.sessions.onRuntimeEvent((event) => {
			if (event?.sourceChannel !== "agents:state" || !Array.isArray(event.payload)) return;
			if (event.sessionId !== claim?.sessionRef.sessionId || event.agentId !== settleAgentId || event.runtimeGeneration !== claim?.runtimeGeneration) return;
			const tab = event.payload.find((entry): entry is { id?: unknown; status?: unknown } => entry !== null && typeof entry === "object" && (entry as { id?: unknown }).id === settleAgentId);
			if (tab === undefined || (tab as { status?: unknown }).status !== "idle") return;
			const epoch = epochRef.current;
			const sequence = ++readSequence;
			void desktopApi.bios
				.automationStatus({ desktopProjectId })
				.then((automationStatus) => {
					if (active && fresh(epoch) && sequence === readSequence) patch({ automationStatus });
				})
				.catch(() => undefined);
		});
		return () => {
			active = false;
			off();
		};
	}, [claimKey, desktopProjectId, fresh, patch, settleAgentId]);

	/** 选目录：**只写配置**，不创建知识库（"创建知识库"是独立动作）。 */
	const saveKnowledgeRoot = useCallback(
		async (root: string | null) => {
			patch({ busy: "root", problem: null });
			try {
				await desktopApi.bios.updateSettings({ ...state.settings, knowledgeRoot: root === null || root.trim() === "" ? null : root.trim() });
				await refresh();
				return true;
			} catch (error) {
				patch({ problem: messageOf(error) });
				return false;
			} finally {
				patch({ busy: null });
			}
		},
		[patch, refresh, state.settings],
	);

	/** 创建知识库（独立确认后调用）：只在已保存的知识根上初始化。 */
	const createStore = useCallback(async () => {
		const root = state.settings.knowledgeRoot;
		if (root === null) {
			patch({ problem: t("bios.workbench.store.needRoot") });
			return null;
		}
		patch({ busy: "store", problem: null });
		try {
			const outcome = await desktopApi.bios.initializeStore({ knowledgeRoot: root });
			await refresh();
			return outcome;
		} catch (error) {
			patch({ problem: messageOf(error) });
			return null;
		} finally {
			patch({ busy: null });
		}
	}, [patch, refresh, state.settings.knowledgeRoot, t]);

	const selectProject = useCallback(
		async (projectId: string, ownerEpoch?: number) => {
			const epoch = ownerEpoch ?? ++epochRef.current;
			if (!fresh(epoch)) return;
			patch({ selectedProjectId: projectId, detail: null, detection: null, confirmOutcome: null, problem: null, busy: "detail" });
			try {
				const outcome = await desktopApi.bios.readProjectView({ biosProjectId: projectId, ...(input.desktopProjectId === undefined ? {} : { desktopProjectId: input.desktopProjectId }) });
				if (epoch !== epochRef.current) return;
				patch({ detail: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
			} catch (error) {
				if (epoch !== epochRef.current) return;
				patch({ busy: null, problem: messageOf(error) });
			}
		},
		[fresh, input.desktopProjectId, patch],
	);

	/** 登记 / 连接当前桌面项目（同一个幂等动作：新绑定是 bound，已绑定是 already-bound）。 */
	const registerCurrentProject = useCallback(
		async (biosProjectId: string, displayName?: string) => {
			const desktopProjectId = input.desktopProjectId;
			if (desktopProjectId === undefined) {
				patch({ problem: t("bios.workbench.project.needDesktopProject") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "bind", problem: null, bindOutcome: null });
			try {
				const outcome = await desktopApi.bios.bindProject({ desktopProjectId, biosProjectId, ...(displayName === undefined || displayName.trim() === "" ? {} : { displayName: displayName.trim() }) });
				if (!fresh(epoch)) return null;
				patch({ bindOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				if (outcome.guard.stable) await loadProjects();
				if (!fresh(epoch)) return null;
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[fresh, input.desktopProjectId, loadProjects, patch, t],
	);

	const runDetection = useCallback(
		async (projectId: string, workspaceId?: string) => {
			const desktopProjectId = input.desktopProjectId;
			if (desktopProjectId === undefined) {
				patch({ problem: t("bios.workbench.project.needDesktopProject") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "detect", problem: null });
			try {
				const outcome = await desktopApi.bios.detectProject({ desktopProjectId, biosProjectId: projectId, ...(workspaceId === undefined ? {} : { workspaceId }) });
				if (epoch !== epochRef.current) return null;
				patch({ detection: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (epoch !== epochRef.current) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[input.desktopProjectId, patch, t],
	);

	/** 人工确认字段：只改点名字段，带 expectedRevision；CAS 冲突时**保留**表单由组件决定重读。 */
	const confirmFields = useCallback(
		async (projectId: string, expectedProfileRevision: number, values: readonly BiosConfirmDraft[], operatorLabel?: string) => {
			const epoch = ++epochRef.current;
			patch({ busy: "confirm", problem: null, confirmOutcome: null });
			try {
				const outcome = await desktopApi.bios.confirmProfile({ biosProjectId: projectId, expectedProfileRevision, values: [...values], ...(operatorLabel === undefined || operatorLabel.trim() === "" ? {} : { operatorLabel: operatorLabel.trim() }) });
				// 写入后重读详情拿新的 revision（不做自动合并）；重读会清掉上一次的 confirmOutcome，
				// 所以结果要**在重读之后**再写回，否则 CAS 冲突提示会被自己的刷新抹掉。
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable && outcome.result.status === "confirmed") await selectProject(projectId, epoch);
				if (!fresh(epoch)) return null;
				patch({ confirmOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[fresh, patch, selectProject],
	);

	const clearNotices = useCallback(() => patch({ problem: null, bindOutcome: null, confirmOutcome: null }), [patch]);

	return useMemo(
		() => ({ ...state, desktopProjectId: input.desktopProjectId, claim, refresh, saveKnowledgeRoot, createStore, selectProject, registerCurrentProject, runDetection, confirmFields, clearNotices }),
		[state, input.desktopProjectId, claim, refresh, saveKnowledgeRoot, createStore, selectProject, registerCurrentProject, runDetection, confirmFields, clearNotices],
	);
}

export type BiosWorkbench = ReturnType<typeof useBiosWorkbench>;
