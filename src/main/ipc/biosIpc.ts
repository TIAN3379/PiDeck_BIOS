/**
 * BM-07A C1 + R33-2/R33-4：**BIOS IPC 域**（`bios:*`）。
 *
 * 只做输入校验与字段挑选；所有读取都在 `BiosKnowledgeService` 里（复用 Package core）。
 * 三条边界：
 * - renderer 只能给**会话引用 + ID + 收紧预算**：不接受 cwd、知识根、授权集合、目录根
 *   （那些只走设置通道，且只有在设置里写过才算数）；
 * - 会话身份与代次由主进程解析（`AgentManager`），假身份/迟到代次直接拒绝；
 * - 预算与领域入口共用 12,000 字符 / 24 KiB 硬上限，参数只能收紧（超限夹紧并如实标记）。
 */
import { dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	BiosAutomationStatus,
	BiosHostSettings,
	BiosChangedEvent,
	BiosKnowledgeRootPickResult,
	BiosListProjectsRequest,
	BiosListResult,
	BiosListTasksRequest,
	BiosPreviewRequest,
	BiosPreviewResult,
	BiosProjectSummary,
	BiosReadiness,
	BiosRuntimeState,
	BiosSelectionRequest,
	BiosSelectionResult,
	BiosSettingsUpdateResult,
	BiosTaskSummary,
} from "../../shared/types/bios";
import type { BiosKnowledgeService } from "../bios/BiosKnowledgeService";
import { normalizeBiosHostSettings } from "../bios/BiosKnowledgeService";
import type { AppLogger } from "../logging/AppLogger";

export type BiosIpcDeps = {
	biosService: BiosKnowledgeService;
	/** 读取/写入桌面设置里的 BIOS 配置（由 main 注入，避免本模块直接依赖 SettingsStore 单例）。 */
	readBiosSettings: () => Partial<BiosHostSettings> | null;
	updateBiosSettings: (patch: Partial<BiosHostSettings>) => Promise<void>;
	/** 按会话保存的选择（R33-2）。 */
	readBiosSelections: () => import("../../shared/types/bios").BiosSelectionMap | null;
	updateBiosSelections: (next: import("../../shared/types/bios").BiosSelectionMap) => Promise<void>;
	appLogger: AppLogger;
	/** 通知 renderer 配置变化（可选）。 */
	onChanged?: (event: BiosChangedEvent) => void;
	/** C5：读自动记忆状态（宿主投影；缺省表示不可用，不伪造空状态）。 */
	readAutomationStatus?: (desktopProjectId: string) => Promise<BiosAutomationStatus>;
};

function requireId(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} 必须是非空字符串`);
	return value.trim();
}

function requireSessionClaim(input: unknown): { readonly sessionRef: { readonly agentId: string; readonly sessionId: string | null }; readonly runtimeGeneration: number } {
	if (input === null || typeof input !== "object") throw new Error("请求必须是对象（含 sessionRef 与 runtimeGeneration）");
	const claim = input as { readonly sessionRef?: unknown; readonly runtimeGeneration?: unknown };
	const ref = claim.sessionRef;
	if (ref === null || typeof ref !== "object") throw new Error("sessionRef 必须是对象：renderer 只能提交会话引用，不能提交目录");
	const agentId = requireId((ref as { readonly agentId?: unknown }).agentId, "sessionRef.agentId");
	const rawSession = (ref as { readonly sessionId?: unknown }).sessionId;
	const sessionId = typeof rawSession === "string" && rawSession.trim() !== "" ? rawSession.trim() : null;
	if (typeof claim.runtimeGeneration !== "number" || !Number.isSafeInteger(claim.runtimeGeneration) || claim.runtimeGeneration < 0) throw new Error("runtimeGeneration 必须是非负整数");
	return { sessionRef: { agentId, sessionId }, runtimeGeneration: claim.runtimeGeneration };
}

export function registerBiosIpc(deps: BiosIpcDeps): () => void {
	const { biosService, readBiosSettings, updateBiosSettings, readBiosSelections, updateBiosSelections, appLogger, onChanged, readAutomationStatus } = deps;

	// C5：宿主投影的自动记忆状态。renderer 只能给桌面项目 ID，路径/授权由主进程解析。
	ipcMain.handle(ipcChannels.biosAutomationStatus, async (_event, raw: unknown): Promise<BiosAutomationStatus> => {
		const input = (raw ?? {}) as { readonly desktopProjectId?: unknown };
		if (typeof input.desktopProjectId !== "string" || input.desktopProjectId.trim() === "") throw new Error("desktopProjectId 必须是非空字符串");
		if (readAutomationStatus === undefined) return { available: false, reason: "unavailable", checkpoints: 0, pendingReflection: 0, lastRecordedAt: null, durableSaved: 0, durablePending: 0, durableFailed: 0, durableUnrecovered: 0, receipt: null };
		return readAutomationStatus(input.desktopProjectId.trim());
	});

	ipcMain.handle(ipcChannels.biosReadiness, async (): Promise<BiosReadiness> => biosService.readiness());

	ipcMain.handle(ipcChannels.biosRuntimeState, async (): Promise<BiosRuntimeState> => biosService.runtimeState());

	ipcMain.handle(ipcChannels.biosListProjects, async (_event, request: BiosListProjectsRequest): Promise<BiosListResult<BiosProjectSummary>> => biosService.listProjects(requireSessionClaim(request)));

	ipcMain.handle(ipcChannels.biosListTasks, async (_event, request: BiosListTasksRequest): Promise<BiosListResult<BiosTaskSummary>> => {
		const claim = requireSessionClaim(request);
		const projectId = requireId((request as { readonly projectId?: unknown }).projectId, "projectId");
		return biosService.listTasks({ ...claim, projectId });
	});

	ipcMain.handle(ipcChannels.biosPreview, async (_event, request: BiosPreviewRequest): Promise<BiosPreviewResult> => {
		const claim = requireSessionClaim(request);
		const projectId = requireId(request.projectId, "projectId");
		const taskId = requireId(request.taskId, "taskId");
		// R33-4：预算只能是正整数（NaN/Infinity/小数/负数一律拒绝），超限由领域侧夹紧到 12,000。
		if (request.budgetChars !== undefined && (typeof request.budgetChars !== "number" || !Number.isSafeInteger(request.budgetChars) || request.budgetChars <= 0)) {
			throw new Error("budgetChars 必须是正整数（不支持 NaN/Infinity/小数/非正数），且只能收紧宿主上限");
		}
		return biosService.preview({
			...claim,
			projectId,
			taskId,
			workspaceId: typeof request.workspaceId === "string" && request.workspaceId.trim() !== "" ? request.workspaceId.trim() : null,
			...(request.budgetChars === undefined ? {} : { budgetChars: request.budgetChars }),
			...(typeof request.query === "string" && request.query.trim() !== "" ? { query: request.query.trim().slice(0, 200) } : {}),
		});
	});

	ipcMain.handle(ipcChannels.biosGetSettings, async (): Promise<BiosHostSettings> => normalizeBiosHostSettings(readBiosSettings()));

	ipcMain.handle(ipcChannels.biosUpdateSettings, async (_event, patch: Partial<BiosHostSettings>): Promise<BiosSettingsUpdateResult> => {
		if (patch === null || typeof patch !== "object") throw new Error("设置补丁必须是对象");
		const outcome = await biosService.updateSettings(patch);
		await updateBiosSettings(outcome.settings);
		onChanged?.({ kind: "settings" });
		appLogger.info("bios", `可信配置已更新（知识根/授权/端点）；丢弃非法目录根 ${outcome.droppedRoots.length} 条；旧许可 runtime ${outcome.invalidated.length} 个（已确认关闭上下文 ${outcome.pushedOff.length} 个）`);
		return { settings: outcome.settings, droppedRoots: [...outcome.droppedRoots], runtime: outcome.runtime, invalidated: [...outcome.invalidated], pushedOff: [...outcome.pushedOff], stopped: [...outcome.stopped], stopFailed: [...outcome.stopFailed], stopFailureDetails: [...outcome.stopFailureDetails] };
	});

	ipcMain.handle(ipcChannels.biosPickKnowledgeRoot, async (): Promise<BiosKnowledgeRootPickResult> => {
		const result = await dialog.showOpenDialog({ properties: ["openDirectory"], title: "选择 BIOS 知识库目录" });
		if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null };
		return { canceled: false, path: result.filePaths[0] ?? null };
	});

	ipcMain.handle(ipcChannels.biosApplySelection, async (_event, request: BiosSelectionRequest): Promise<BiosSelectionResult> => {
		const claim = requireSessionClaim(request);
		const projectId = requireId(request.projectId, "projectId");
		const taskId = requireId(request.taskId, "taskId");
		const workspaceId = typeof request.workspaceId === "string" && request.workspaceId.trim() !== "" ? request.workspaceId.trim() : null;
		const outcome = await biosService.applySelection({ ...claim, projectId, taskId, workspaceId, contextEnabled: request.contextEnabled === true });
		if (outcome.applied) onChanged?.({ kind: "selection", selection: { ...claim, projectId, taskId, workspaceId, contextEnabled: request.contextEnabled === true } });
		return outcome;
	});

	return () => {
		for (const channel of [ipcChannels.biosReadiness, ipcChannels.biosRuntimeState, ipcChannels.biosListProjects, ipcChannels.biosListTasks, ipcChannels.biosPreview, ipcChannels.biosGetSettings, ipcChannels.biosUpdateSettings, ipcChannels.biosPickKnowledgeRoot, ipcChannels.biosApplySelection]) {
			ipcMain.removeHandler(channel);
		}
	};
}
