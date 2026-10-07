/** 接入草稿只属于当前桌面项目；取消/切项目/配置变化拒绝迟到响应。 */
import { useCallback, useEffect, useRef, useState } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import type { BiosOnboardingPreview, BiosOnboardingResult, BiosServiceRef } from "../../../shared/types/biosOnboarding";
import type { BiosHostSettings } from "../../../shared/types/bios";

// 比较宿主实际配置，不把属性顺序差异当成撤权；不读取模型认证信息。
// D4：具名端点许可（provider/model/地址/版本）也在比较范围内——它变化就是许可变化。
const settingsKey = (settings: BiosHostSettings) =>
	JSON.stringify([
		settings.knowledgeRoot,
		settings.endpoint,
		settings.endpointGrant?.provider ?? null,
		settings.endpointGrant?.modelId ?? null,
		settings.endpointGrant?.origin ?? null,
		settings.endpointGrant?.version ?? null,
		settings.authorizedProjectIds,
		settings.allowedFeatureIds,
		settings.approvedCustomers,
		settings.authorizedRoots,
		settings.automation?.enabled,
		settings.automation?.localBookkeeping,
		settings.automation?.injectProjectData,
		settings.automation?.version,
	]);

type State = {
	phase: "idle" | "loading" | "review" | "saving" | "done" | "error";
	preview: BiosOnboardingPreview | null;
	result: BiosOnboardingResult | null;
	name: string;
	confirmed: boolean;
	/** AW-01：同一次确认里的自动化许可（默认勾选 = 打开工程后自动准备/检索/保存）。 */
	automation: boolean;
	/**
	 * D4：**端点外发的显式授权**（默认**未勾选**）。
	 *
	 * 接入本身不需要外发许可；只有用户明确勾选时才会把 `endpoint` 写成 `allowed`，
	 * 未勾选一律保持当前策略（`unknown` 不会被"确认接入"顺手改成允许外发）。
	 */
	endpointConsent: boolean;
	problem: string | null;
};
const empty = (): State => ({ phase: "idle", preview: null, result: null, name: "", confirmed: false, automation: true, endpointConsent: false, problem: null });

export function useBiosOnboarding(input: { desktopProjectId?: string; sessionId?: string; autoPrepare?: boolean; serviceRef?: BiosServiceRef | null; serviceKey?: string }) {
	const [state, setState] = useState<State>(empty);
	const scope = useRef(input.desktopProjectId);
	scope.current = input.desktopProjectId;
	/**
	 * D4：提交端点外发授权时附带的**会话引用**（哪一栏会话）。
	 *
	 * 这里只存引用，不存 provider/model/地址——真实身份由主进程按引用去读运行态；
	 * 用 ref 保存，避免每次渲染的新对象让 confirm 回调反复重建。
	 */
	const serviceRef = useRef<BiosServiceRef | null>(input.serviceRef ?? null);
	serviceRef.current = input.serviceRef ?? null;
	const epoch = useRef(0);
	const alive = useRef(true);
	const saving = useRef(false);
	const completed = useRef<BiosOnboardingResult | null>(null);
	/** R2：每个桌面项目只自动提议一次（用户取消后不反复弹）。 */
	const autoPrepared = useRef<string | null>(null);
	const serviceKey = input.serviceKey ?? "";
	const activeServiceKey = useRef(serviceKey);
	activeServiceKey.current = serviceKey;
	useEffect(() => {
		alive.current = true;
		return () => {
			alive.current = false;
			epoch.current += 1;
		};
	}, []);
	useEffect(() => {
		epoch.current += 1;
		completed.current = null;
		autoPrepared.current = null;
		setState(empty());
	}, [input.desktopProjectId, input.sessionId]);
	useEffect(() => {
		// A model/runtime change invalidates consent, including an in-flight preview and a saved receipt.
		// Revoking the old runtime as part of our save must still show its pending-restart receipt.
		// The save can stop its runtime before IPC returns; session changes still invalidate above.
		if (serviceKey === "" && (saving.current || completed.current !== null)) return;
		epoch.current += 1;
		completed.current = null;
		setState(empty());
	}, [serviceKey]);
	useEffect(
		() =>
			desktopApi.bios.onChanged((event) => {
				if (event?.kind === "selection") return;
				// 本动作会在 IPC 完成前发布配置通知；保存回执仍需显示，但不保留可再次提交的预览。
				if (saving.current) return;
				const version = ++epoch.current;
				const projectId = scope.current;
				const receipt = completed.current;
				const authorization = receipt?.authorization;
				const invalidate = () => {
					if (!alive.current || epoch.current !== version || scope.current !== projectId) return;
					completed.current = null;
					// Revocation/configuration events must not immediately re-open onboarding after
					// the user cancelled it. A new project/service or explicit retry can ask again.
					setState(empty());
				};
				if (authorization == null) {
					invalidate();
					return;
				}
				// 同一次保存的通知可能晚于 IPC 回应；只保留不可再提交的历史回执。
				// 真正配置变化或读失败仍失效，异步复核不能跨项目或覆盖较新通知。
				void desktopApi.bios
					.getSettings()
					.then((settings) => {
						if (settingsKey(settings) !== settingsKey(authorization.settings)) invalidate();
					})
					.catch(invalidate);
			}),
		[],
	);
	const fresh = useCallback((version: number, projectId: string) => alive.current && epoch.current === version && scope.current === projectId, []);
	const prepare = useCallback(async () => {
		const projectId = input.desktopProjectId;
		if (projectId === undefined || saving.current) return;
		const version = ++epoch.current;
		const preparedServiceKey = activeServiceKey.current;
		completed.current = null;
		setState({ ...empty(), phase: "loading" });
		try {
			const ref = serviceRef.current;
			const preview = await desktopApi.bios.prepareOnboarding({ desktopProjectId: projectId, ...(ref === null ? {} : { serviceRef: ref }) });
			if (fresh(version, projectId) && preparedServiceKey === activeServiceKey.current) setState({ ...empty(), phase: "review", preview, name: preview.displayName });
		} catch (error) {
			if (fresh(version, projectId)) setState({ ...empty(), phase: "error", problem: error instanceof Error ? error.message : String(error) });
		}
	}, [fresh, input.desktopProjectId]);
	/**
	 * R2：**宿主侧自动提议**——项目打开后由应用准备一次可取消的接入提议，
	 * 因此"空白配置首次接入"不再依赖用户在右栏里先点「预览接入」。
	 */
	useEffect(() => {
		if (input.autoPrepare !== true) return;
		const projectId = input.desktopProjectId;
		if (projectId === undefined || saving.current) return;
		if (state.phase !== "idle" || state.preview !== null) return;
		const key = JSON.stringify([projectId, serviceKey]);
		if (autoPrepared.current === key) return;
		autoPrepared.current = key;
		void prepare();
	}, [input.autoPrepare, input.desktopProjectId, prepare, serviceKey, state.phase, state.preview]);
	const confirm = useCallback(async () => {
		const preview = state.preview;
		const serviceOnly = preview?.existing === true && preview.authorized === true && state.endpointConsent;
		if (preview === null || (!state.confirmed && !serviceOnly) || state.name.trim() === "" || saving.current || preview.desktopProjectId !== scope.current) return null;
		const version = ++epoch.current;
		saving.current = true;
		setState((old) => ({ ...old, phase: "saving", problem: null }));
		try {
			// AW-01/D4：一次确认同时提交自动化许可与**显式**端点外发授权；
			// 未勾选则只做接入（等价旧行为），不改动端点策略。
			// 勾选时必须带**会话引用**：主进程据此核对真实运行态并写入具名许可（核对不过整批拒绝）。
			const ref = serviceRef.current;
			const result = await desktopApi.bios.completeOnboarding({
				token: preview.token,
				confirmed: true,
				...(serviceOnly ? { serviceOnly: true } : {}),
				displayName: state.name.trim(),
				...(!serviceOnly && state.automation ? { automation: { localBookkeeping: true, injectProjectData: true } } : {}),
				...(state.endpointConsent ? { endpointConsent: true } : {}),
				...(state.endpointConsent && ref !== null ? { serviceRef: ref } : {}),
			});
			if (!fresh(version, preview.desktopProjectId)) return null;
			completed.current = result;
			setState((old) => ({ ...old, phase: "done", preview: null, result, confirmed: false }));
			return result;
		} catch (error) {
			if (fresh(version, preview.desktopProjectId)) setState((old) => ({ ...old, phase: "error", preview: null, problem: error instanceof Error ? error.message : String(error) }));
			return null;
		} finally {
			saving.current = false;
			// A changed service may have deferred its automatic preview while this save was pending.
			if (alive.current && !fresh(version, preview.desktopProjectId)) setState((old) => ({ ...old }));
		}
	}, [fresh, state.automation, state.confirmed, state.endpointConsent, state.name, state.preview]);
	const cancel = useCallback(() => {
		if (saving.current) return;
		epoch.current += 1;
		completed.current = null;
		setState(empty());
	}, []);
	return {
		...state,
		prepare,
		confirm,
		cancel,
		setName: (name: string) => setState((old) => ({ ...old, name })),
		setConfirmed: (confirmed: boolean) => setState((old) => ({ ...old, confirmed })),
		setAutomation: (automation: boolean) => setState((old) => ({ ...old, automation })),
		setEndpointConsent: (endpointConsent: boolean) => setState((old) => ({ ...old, endpointConsent })),
		busy: state.phase === "loading" || state.phase === "saving",
		hint: t("bios.onboarding.hint"),
	};
}
