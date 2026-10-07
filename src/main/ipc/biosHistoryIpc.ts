import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { BiosHistoryService } from "../bios/BiosHistoryService";

function object(raw: unknown): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("历史请求必须是对象");
	return Object.fromEntries(Object.entries(raw));
}
function text(value: unknown): string {
	if (typeof value !== "string" || value.length > 256) throw new Error("历史请求文本无效");
	return value;
}
export function registerBiosHistoryIpc(service: BiosHistoryService): () => void {
	ipcMain.handle(ipcChannels.biosScanHistory, async (_event, raw: unknown) => {
		const input = object(raw);
		if (typeof input.limit !== "number") throw new Error("提交上限必须是数字");
		return service.scan({ desktopProjectId: text(input.desktopProjectId), projectId: text(input.projectId), ref: text(input.ref), limit: input.limit, keyword: text(input.keyword) });
	});
	ipcMain.handle(ipcChannels.biosHistoryEvidence, async (_event, raw: unknown) => {
		const input = object(raw);
		return service.evidence(text(input.token), text(input.sha));
	});
	return () => {
		ipcMain.removeHandler(ipcChannels.biosScanHistory);
		ipcMain.removeHandler(ipcChannels.biosHistoryEvidence);
	};
}
