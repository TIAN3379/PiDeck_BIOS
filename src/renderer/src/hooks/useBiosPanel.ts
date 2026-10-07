/** BIOS 面板生命周期：controller 负责命令，hook 绑定当前会话并在绘制前清旧视图。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { createBiosPanelController, type BiosPanelScope } from "../components/app/settings/biosPanelController";
import { initialBiosPanelState } from "../components/app/settings/biosPanelState";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export function useBiosPanel() {
	// 会话身份只由 `useBiosSessionClaim` 一处推导（工作台与设置面板共用，避免两套口径漂移）。
	const { key, claim } = useBiosSessionClaim();
	const scope: BiosPanelScope = { key, claim };
	const scopeRef = useRef(scope);
	// 渲染发生时即让旧回调看到新身份，而不是等 effect 才更新。
	scopeRef.current = scope;
	const controller = useMemo(() => createBiosPanelController(desktopApi.bios, () => scopeRef.current, t), []);
	const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
	useLayoutEffect(() => {
		controller.alignScope();
	}, [controller, key]);
	useEffect(() => controller.start(), [controller]);
	useEffect(() => {
		void controller.reload();
	}, [controller, key]);
	// 清理 effect 前的这一帧也不展示上个会话的正文。
	const panel = state.panel.identityKey === key ? state.panel : initialBiosPanelState();
	return { ...state, panel, claim: scope.claim, controller };
}
