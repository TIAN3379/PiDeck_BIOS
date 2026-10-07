/** BIOS 面板命令的唯一 owner：所有异步完成和派生 IO 都核对当前身份与请求代次。 */
import type { PiDesktopApi } from "../../../../../preload";
import { BIOS_SETTINGS_DEFAULTS, type BiosHostSettings, type BiosRuntimeState, type BiosSessionClaim } from "../../../../../shared/types/bios";
import { beginRequest, chooseProject, chooseTask, initialBiosPanelState, markSynced, markUnsynced, projectPatch, settle, syncScope, taskPatch, type BiosPanelState } from "./biosPanelState";

export type BiosPanelScope = { key: string; claim: BiosSessionClaim | null };
type PanelApi = PiDesktopApi["bios"];
type PanelCopy = (key: "settings.bios.noSession" | "settings.bios.pickProjectTask" | "settings.bios.notSynced" | "settings.bios.saved" | "settings.bios.saveDropped" | "settings.bios.saveStopped" | "settings.bios.saveStopFailed") => string;
export type BiosPanelSnapshot = {
	panel: BiosPanelState;
	settings: BiosHostSettings;
	readiness: { ready: boolean; reason: string | null };
	runtime: BiosRuntimeState;
};

/** 可独立测试的生产 controller；hook 只订阅、装配生命周期和传递表单值。 */
export function createBiosPanelController(api: PanelApi, getScope: () => BiosPanelScope, copy: PanelCopy) {
	let snapshot: BiosPanelSnapshot = {
		panel: initialBiosPanelState(),
		settings: BIOS_SETTINGS_DEFAULTS,
		readiness: { ready: false, reason: null },
		runtime: { configVersion: 0, pendingRestart: false, stoppedRuntimes: [], stopFailures: [], note: null },
	};
	let alive = true;
	let epoch = 0;
	let reloadEpoch = 0;
	let saveSequence = 0;
	let activeSelection: { token: Token; selected: import("../../../../../shared/types/bios").BiosSelectionRequest } | null = null;
	const listeners = new Set<() => void>();
	const publish = (next: BiosPanelSnapshot) => {
		snapshot = next;
		for (const notify of listeners) notify();
	};
	const nextEpoch = () => (epoch = Math.max(epoch, snapshot.panel.acceptedEpoch) + 1);
	const alignScope = () => {
		const panel = syncScope(snapshot.panel, getScope().key, snapshot.runtime.configVersion, epoch + 1);
		if (panel !== snapshot.panel) {
			nextEpoch();
			publish({ ...snapshot, panel: { ...panel, acceptedEpoch: epoch } });
		}
	};
	const invalidate = () => {
		nextEpoch();
		publish({ ...snapshot, panel: { ...initialBiosPanelState(), identityKey: getScope().key, configEpoch: snapshot.runtime.configVersion, acceptedEpoch: epoch } });
	};
	const begin = (label: string) => {
		alignScope();
		const token = { key: getScope().key, epoch: nextEpoch(), config: snapshot.runtime.configVersion };
		publish({ ...snapshot, panel: beginRequest(snapshot.panel, token.epoch, label) });
		return token;
	};
	type Token = ReturnType<typeof begin>;
	const current = (token: Token) => alive && token.key === getScope().key && token.epoch === epoch && token.config === snapshot.runtime.configVersion;
	const finish = (token: Token, transform: (state: BiosPanelState) => Partial<BiosPanelState>) => {
		if (!current(token)) return false;
		publish({ ...snapshot, panel: settle(snapshot.panel, token.epoch, transform(snapshot.panel)) });
		return true;
	};
	const fail = (token: Token, error: unknown) => finish(token, () => ({ problem: error instanceof Error ? error.message : String(error), preview: null, synced: null }));
	const claim = () => {
		alignScope();
		const value = getScope().claim;
		if (value === null) publish({ ...snapshot, panel: { ...snapshot.panel, problem: copy("settings.bios.noSession") } });
		return value;
	};
	const reload = async () => {
		const ticket = ++reloadEpoch;
		const key = getScope().key;
		try {
			const [readiness, settings, runtime] = await Promise.all([api.readiness(), api.getSettings(), api.runtimeState()]);
			if (!alive || ticket !== reloadEpoch || key !== getScope().key || runtime.configVersion < snapshot.runtime.configVersion) return;
			if (runtime.configVersion !== snapshot.runtime.configVersion) invalidate();
			publish({ ...snapshot, readiness, settings, runtime });
			alignScope();
		} catch (error) {
			if (alive && ticket === reloadEpoch && key === getScope().key) publish({ ...snapshot, panel: { ...snapshot.panel, problem: error instanceof Error ? error.message : String(error) } });
		}
	};
	const refreshTasks = async (projectId: string) => {
		const session = claim();
		if (session === null || !projectId) return;
		const token = begin("tasks");
		try {
			const listed = await api.listTasks({ ...session, projectId });
			finish(token, (state) => ({ ...taskPatch(state, listed.items), problem: listed.gap }));
		} catch (error) {
			fail(token, error);
		}
	};
	const refreshProjects = async () => {
		const session = claim();
		if (session === null) return;
		const token = begin("projects");
		try {
			const listed = await api.listProjects(session);
			if (!finish(token, (state) => ({ ...projectPatch(state, listed.items), problem: listed.gap }))) return;
			// 只有仍属本请求的显式选择才串任务；拒绝旧列表后绝不再发子请求。
			if (current(token) && snapshot.panel.projectId !== null) await refreshTasks(snapshot.panel.projectId);
		} catch (error) {
			fail(token, error);
		}
	};
	const selectProject = async (projectId: string) => {
		alignScope();
		if (projectId && !snapshot.panel.projects.some((p) => p.projectId === projectId)) return;
		const panel = chooseProject(snapshot.panel, projectId);
		nextEpoch();
		publish({ ...snapshot, panel: { ...panel, acceptedEpoch: epoch, busy: null } });
		if (projectId) await refreshTasks(projectId);
	};
	const selectTask = (taskId: string) => {
		alignScope();
		if (taskId && !snapshot.panel.tasks.some((task) => task.taskId === taskId)) return;
		const panel = chooseTask(snapshot.panel, taskId);
		nextEpoch();
		publish({ ...snapshot, panel: { ...panel, acceptedEpoch: epoch, busy: null } });
	};
	const selection = () => {
		const session = claim();
		if (session === null) return null;
		const { projectId, taskId } = snapshot.panel;
		if (projectId === null || taskId === null) {
			publish({ ...snapshot, panel: { ...snapshot.panel, problem: copy("settings.bios.pickProjectTask") } });
			return null;
		}
		return { ...session, projectId, taskId, workspaceId: null };
	};
	const applySelection = async (contextEnabled: boolean) => {
		const selected = selection();
		if (selected === null) return;
		const token = begin("selection");
		activeSelection = { token, selected: { ...selected, contextEnabled } };
		try {
			const result = await api.applySelection({ ...selected, contextEnabled });
			if (!finish(token, (state) => (result.currentSessionSynced ? markSynced(state, { ...selected, contextEnabled }, result.receipt) : markUnsynced(state, result.receipt, result.reason ?? copy("settings.bios.notSynced"))))) return;
			const runtime = await api.runtimeState();
			if (!current(token)) return;
			if (runtime.configVersion !== snapshot.runtime.configVersion) invalidate();
			publish({ ...snapshot, runtime });
			alignScope();
		} catch (error) {
			fail(token, error);
		} finally {
			if (activeSelection?.token === token) activeSelection = null;
		}
	};
	const buildPreview = async () => {
		const selected = selection();
		if (selected === null) return;
		const token = begin("preview");
		try {
			const preview = await api.preview(selected);
			finish(token, () => ({ preview, problem: preview.problems.length ? preview.problems.join("\n") : null }));
		} catch (error) {
			fail(token, error);
		}
	};
	const saveSettings = async (settings: BiosHostSettings) => {
		// 保存可能收窄范围：立即清除旧正文，不等 changed/reload 返回才失效。
		invalidate();
		++reloadEpoch;
		const token = begin("save");
		const save = ++saveSequence;
		try {
			const result = await api.updateSettings(settings);
			// 主进程在返回 update 之前就广播 changed；它必须失效旧正文，但不能吞掉
			// 本次保存的停止失败回执。保存另有代次，配置版本只允许前进。
			if (!alive || save !== saveSequence || token.key !== getScope().key || result.runtime.configVersion < snapshot.runtime.configVersion) return;
			++reloadEpoch;
			const mayShowReceipt = snapshot.panel.busy === null || snapshot.panel.busy === "save";
			publish({ ...snapshot, settings: result.settings, runtime: result.runtime });
			alignScope();
			const parts = [
				result.droppedRoots.length ? `${copy("settings.bios.saveDropped")} ${result.droppedRoots.length}` : null,
				result.stopped.length ? `${copy("settings.bios.saveStopped")} ${result.stopped.length}` : null,
				result.stopFailed.length ? `${copy("settings.bios.saveStopFailed")} ${result.stopFailed.length}` : null,
			].filter((part) => part !== null);
			if (mayShowReceipt) publish({ ...snapshot, panel: { ...snapshot.panel, busy: null, receipt: { text: parts.length ? parts.join("；") : copy("settings.bios.saved"), synced: result.stopFailed.length === 0 } } });
			await reload();
		} catch (error) {
			fail(token, error);
		}
	};
	const pickKnowledgeRoot = async () => {
		const token = begin("pickRoot");
		try {
			const result = await api.pickKnowledgeRoot();
			return finish(token, () => ({})) && !result.canceled ? result.path : null;
		} catch (error) {
			fail(token, error);
			return null;
		}
	};
	return {
		getSnapshot: () => snapshot,
		subscribe: (listener: () => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		alignScope,
		reload,
		refreshProjects,
		selectProject,
		selectTask,
		applySelection,
		buildPreview,
		saveSettings,
		pickKnowledgeRoot,
		start: () => {
			alive = true;
			alignScope();
			void reload();
			const unsubscribe = api.onChanged((event) => {
				if (event?.kind === "selection") {
					const scope = getScope().claim;
					const changed = event.selection;
					if (scope?.sessionRef.agentId !== changed.sessionRef.agentId || scope.runtimeGeneration !== changed.runtimeGeneration || scope.sessionRef.sessionId !== changed.sessionRef.sessionId) return;
					const own = activeSelection;
					if (own && current(own.token) && own.selected.projectId === changed.projectId && own.selected.taskId === changed.taskId && own.selected.workspaceId === changed.workspaceId && own.selected.contextEnabled === changed.contextEnabled) {
						void reload();
						return;
					}
				}
				invalidate();
				void reload();
			});
			return () => {
				alive = false;
				++reloadEpoch;
				nextEpoch();
				unsubscribe();
			};
		},
	};
}
