/** 小型真实回执投影：不复制知识正文，缺少可解析回执不能声明已保存。 */
export type BiosWorkflowResultState = "saved" | "read" | "attention";
export function biosWorkflowResultState(raw: unknown): BiosWorkflowResultState | undefined {
	if (typeof raw !== "string" || raw.length > 16000) return undefined;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || !("status" in parsed) || typeof parsed.status !== "string") return undefined;
		if (["created", "updated", "confirmed", "changed", "applied"].includes(parsed.status)) return "saved";
		return ["ok", "incomplete", "selected", "unchanged", "no-change"].includes(parsed.status) ? "read" : "attention";
	} catch {
		return undefined;
	}
}

/** 仅用于当前会话的 UI 候选选择，不是宿主授权或上下文 ACK。 */
export function biosWorkflowTaskReceipt(raw: unknown): { projectId: string; taskId: string } | undefined {
	if (typeof raw !== "string" || raw.length > 16000) return undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (!value || typeof value !== "object" || !("status" in value) || !["selected", "created"].includes(String(value.status)) || !("projectId" in value) || !("taskId" in value)) return undefined;
		if (typeof value.projectId !== "string" || !/^[a-f0-9-]{36}$/.test(value.projectId) || typeof value.taskId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.taskId)) return undefined;
		return { projectId: value.projectId, taskId: value.taskId };
	} catch {
		return undefined;
	}
}
