/** Human library IPC. Root/path/authorization/runtime claims are never accepted. */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { BiosLibraryKind, BiosLibraryRef } from "../../shared/types/biosLibrary";
import type { BiosLibraryService } from "../bios/BiosLibraryService";
import { pickExperienceChanges, pickFeatureChanges } from "./biosBusinessIpc";

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("知识库请求必须是对象");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).some((key) => !keys.includes(key))) throw new Error("知识库请求含未知或托管字段");
	return input;
}
function text(value: unknown, label: string, max = 200): string {
	if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${label} 无效`);
	return value;
}
function kind(value: unknown): BiosLibraryKind {
	if (value !== "experience-card" && value !== "feature-record") throw new Error("知识类型无效");
	return value;
}
function revision(value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("expectedRevision 无效");
	return value;
}
function ref(input: Record<string, unknown>): BiosLibraryRef {
	return { kind: kind(input.kind), id: text(input.id, "记录 ID"), libraryKey: text(input.libraryKey, "知识库版本") };
}

export function registerBiosLibraryIpc(service: BiosLibraryService): () => void {
	ipcMain.handle(ipcChannels.biosLibraryList, (_event, raw: unknown) => {
		const input = object(raw, ["kind", "query", "after", "libraryKey"]);
		if (input.query !== undefined && (typeof input.query !== "string" || input.query.length > 500)) throw new Error("查询词无效");
		return service.list({ kind: kind(input.kind), ...(typeof input.query === "string" ? { query: input.query } : {}), ...(input.after === undefined ? {} : { after: text(input.after, "分页游标") }), ...(input.libraryKey === undefined ? {} : { libraryKey: text(input.libraryKey, "知识库版本") }) });
	});
	ipcMain.handle(ipcChannels.biosLibraryDetail, (_event, raw: unknown) => service.detail(ref(object(raw, ["kind", "id", "libraryKey"]))));
	ipcMain.handle(ipcChannels.biosLibraryUpdate, (_event, raw: unknown) => {
		const input = object(raw, ["kind", "id", "libraryKey", "expectedRevision", "changes"]);
		const request = ref(input);
		const expectedRevision = revision(input.expectedRevision);
		if (request.kind === "experience-card") {
			const changes = object(input.changes, ["problem", "symptom", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen", "featureId", "validations", "evidence", "reuse"]);
			return service.update({ ...request, kind: request.kind, expectedRevision, changes: pickExperienceChanges(changes, "changes") });
		}
		const changes = object(input.changes, ["originalRequirement", "aliases", "customer", "productLine", "acceptanceCriteria", "relatedExperienceIds"]);
		return service.update({ ...request, kind: request.kind, expectedRevision, changes: pickFeatureChanges(changes, "changes") });
	});
	ipcMain.handle(ipcChannels.biosLibraryReview, (_event, raw: unknown) => {
		const input = object(raw, ["kind", "id", "libraryKey", "expectedRevision", "action", "reason", "confirmed"]);
		const request = ref(input);
		if (request.kind !== "experience-card" || input.confirmed !== true || (input.action !== "request-changes" && input.action !== "deprecate" && input.action !== "restore")) throw new Error("请明确确认允许的知识状态变更");
		return service.review({ ...request, kind: "experience-card", expectedRevision: revision(input.expectedRevision), confirmed: true, action: input.action, reason: text(input.reason, "变更理由", 2_000) });
	});
	return () => {
		for (const channel of [ipcChannels.biosLibraryList, ipcChannels.biosLibraryDetail, ipcChannels.biosLibraryUpdate, ipcChannels.biosLibraryReview]) ipcMain.removeHandler(channel);
	};
}
