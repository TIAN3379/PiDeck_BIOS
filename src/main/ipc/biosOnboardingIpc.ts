/** 接入管理边界：仅接受桌面项目 ID、预览凭证和明确的人工作答。 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { BiosOnboardingService } from "../bios/BiosOnboardingService";
import type { AppLogger } from "../logging/AppLogger";

function record(value: unknown): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("接入请求必须是对象");
	return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > 256) throw new Error(`${label} 必须是长度不超过 256 的非空文本`);
	return value.trim();
}

/**
 * R2：自动化许可必须**逐字段**校验后原样传给服务。
 *
 * 之前这里只挑了 `token`/`displayName`，渲染层送来的 `automation` 被静默丢弃——
 * 用户在接入卡上勾了"自动记忆"，实际什么都没发生（而服务层单测直接调用，因此没暴露）。
 * 只接受两个布尔字段；多余字段一律拒绝（不能借接入通道塞别的授权）。
 */
function automationConsent(value: unknown): { localBookkeeping: boolean; injectProjectData: boolean } | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("automation 必须是对象");
	const record = value as Record<string, unknown>;
	const allowed = ["localBookkeeping", "injectProjectData"];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new Error(`automation 不接受字段：${key}`);
		if (typeof record[key] !== "boolean") throw new Error(`automation.${key} 必须是布尔值`);
	}
	return { localBookkeeping: record.localBookkeeping === true, injectProjectData: record.injectProjectData === true };
}

/**
 * D4：**服务引用**只接受"哪一栏会话"三个字段，且全部做类型/范围校验。
 *
 * renderer **不能**提交 provider/model/地址：那些事实只能由主进程按这个引用去读真实运行态，
 * 所以这里多余字段一律拒绝（防止借接入通道塞伪造身份）。
 */
function serviceRef(value: unknown): { agentId: string; sessionId: string | null; generation: number } | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("serviceRef 必须是对象");
	const record = value as Record<string, unknown>;
	const allowed = ["agentId", "sessionId", "generation"];
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) throw new Error(`serviceRef 不接受字段：${key}`);
	}
	const sessionId = record.sessionId;
	if (sessionId !== null && typeof sessionId !== "string") throw new Error("serviceRef.sessionId 必须是文本或 null");
	const generation = record.generation;
	if (typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0) throw new Error("serviceRef.generation 必须是非负整数");
	return { agentId: text(record.agentId, "serviceRef.agentId"), sessionId: sessionId ?? null, generation };
}

export function registerBiosOnboardingIpc(deps: { onboarding: BiosOnboardingService; appLogger: AppLogger; onChanged: () => void }): () => void {
	ipcMain.handle(ipcChannels.biosConnections, () => deps.onboarding.connections());
	ipcMain.handle(ipcChannels.biosDisconnectProject, async (_event, raw: unknown) => {
		const input = record(raw);
		if (Object.keys(input).some((key) => !["projectId", "expectedRevision", "configurationVersion", "confirmed"].includes(key))) throw new Error("取消接入请求含未知字段");
		if (input.confirmed !== true) throw new Error("请明确确认取消接入");
		if (typeof input.expectedRevision !== "number" || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw new Error("项目列表版本无效");
		if (typeof input.configurationVersion !== "number" || !Number.isSafeInteger(input.configurationVersion) || input.configurationVersion < 0) throw new Error("配置版本无效");
		const result = await deps.onboarding.disconnect({ projectId: text(input.projectId, "projectId"), expectedRevision: input.expectedRevision, configurationVersion: input.configurationVersion, confirmed: true });
		deps.onChanged();
		return result;
	});
	ipcMain.handle(ipcChannels.biosPrepareOnboarding, async (_event, raw: unknown) => {
		const input = record(raw);
		// R2：空白配置（knowledgeRoot=null）也必须能预览并提议创建默认库；"知识库未就绪"不再是硬门槛。
		return deps.onboarding.prepare(text(input.desktopProjectId, "desktopProjectId"), serviceRef(input.serviceRef));
	});
	ipcMain.handle(ipcChannels.biosCompleteOnboarding, async (_event, raw: unknown) => {
		const input = record(raw);
		if (input.confirmed !== true) throw new Error("请明确确认项目和目录授权");
		const consent = automationConsent(input.automation);
		// D4：端点授权只认显式布尔 true（缺省 = 不改动当前策略，unknown 不会被静默放行）。
		if (input.endpointConsent !== undefined && typeof input.endpointConsent !== "boolean") throw new Error("endpointConsent 必须是布尔值");
		if (input.serviceOnly !== undefined && typeof input.serviceOnly !== "boolean") throw new Error("serviceOnly 必须是布尔值");
		const ref = serviceRef(input.serviceRef);
		const outcome = await deps.onboarding.complete({
			token: text(input.token, "token"),
			confirmed: true,
			...(input.serviceOnly === true ? { serviceOnly: true } : {}),
			...(input.displayName === undefined ? {} : { displayName: text(input.displayName, "displayName") }),
			...(consent === undefined ? {} : { automation: consent }),
			...(input.endpointConsent === true ? { endpointConsent: true } : {}),
			...(ref === undefined ? {} : { serviceRef: ref }),
		});
		deps.onChanged();
		deps.appLogger.info("bios", `人工项目接入：${outcome.status}（授权保存=${outcome.authorization !== null}，绑定提交=${outcome.binding?.committed === true}，自动化许可=${consent === undefined ? "未勾选" : "已勾选"}，端点显式授权=${input.endpointConsent === true ? "已勾选" : "未勾选"}）`);
		return outcome;
	});
	return () => {
		ipcMain.removeHandler(ipcChannels.biosConnections);
		ipcMain.removeHandler(ipcChannels.biosDisconnectProject);
		ipcMain.removeHandler(ipcChannels.biosPrepareOnboarding);
		ipcMain.removeHandler(ipcChannels.biosCompleteOnboarding);
	};
}
