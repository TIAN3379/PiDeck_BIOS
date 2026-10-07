/** 检查点覆盖证明：只有同身份、同基线且完整覆盖执行事实，才可移除旧待补记副本。 */
import type { AutomationCheckpoint } from "./contract.ts";

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function strings(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 只比较已验证的证据字段；损坏/旧版缺字段的正文永远不能授权删除。 */
function evidence(value: unknown): { readonly record: Record<string, unknown>; readonly hashes: Record<string, unknown>; readonly facts: readonly string[]; readonly files: readonly string[]; readonly baseline: Record<string, unknown> } | null {
	if (!object(value) || value.version !== 1 || typeof value.requestKey !== "string" || typeof value.recordedAt !== "number" || !Number.isFinite(value.recordedAt)) return null;
	if (!object(value.baseline) || !object(value.baseline.fileHashes) || !strings(value.changedFiles) || !Array.isArray(value.executed)) return null;
	if (typeof value.pendingReflection !== "boolean" || typeof value.projectId !== "string" || typeof value.workspaceId !== "string") return null;
	if (typeof value.sessionId !== "string" && value.sessionId !== null) return null;
	if (typeof value.branch !== "string" && value.branch !== null) return null;
	if (typeof value.baseline.workspacePath !== "string") return null;
	for (const key of ["branch", "commit"]) if (value.baseline[key] !== null && typeof value.baseline[key] !== "string") return null;
	if (Object.values(value.baseline.fileHashes).some((hash) => typeof hash !== "string")) return null;
	if (value.task !== null && (!object(value.task) || typeof value.task.taskId !== "string" || typeof value.task.revision !== "number")) return null;
	const facts: string[] = [];
	for (const fact of value.executed) {
		if (!object(fact) || typeof fact.tool !== "string" || !["ok", "error", "blocked"].includes(String(fact.outcome)) || !strings(fact.files) || typeof fact.wrote !== "boolean") return null;
		if (fact.businessStatus !== undefined && fact.businessStatus !== null && typeof fact.businessStatus !== "string") return null;
		if (fact.linkFailed !== undefined && typeof fact.linkFailed !== "boolean") return null;
		facts.push(JSON.stringify([fact.tool, fact.outcome, [...fact.files].sort(), fact.wrote, fact.businessStatus ?? null, fact.linkFailed === true]));
	}
	return { record: value, hashes: value.baseline.fileHashes, facts, files: value.changedFiles, baseline: value.baseline };
}

export function checkpointCovers(older: AutomationCheckpoint, newer: AutomationCheckpoint): boolean {
	const old = evidence(older);
	const next = evidence(newer);
	if (old === null || next === null || old.record.pendingReflection !== true || next.record.pendingReflection !== false) return false;
	for (const key of ["projectId", "workspaceId", "sessionId", "branch", "requestKey"]) if (old.record[key] !== next.record[key]) return false;
	if (newer.recordedAt < older.recordedAt) return false;
	for (const key of ["workspacePath", "branch", "commit"]) if (old.baseline[key] !== next.baseline[key]) return false;
	for (const [path, hash] of Object.entries(old.hashes)) if (next.hashes[path] !== hash) return false;
	if (object(old.record.task)) {
		if (!object(next.record.task) || next.record.task.taskId !== old.record.task.taskId || typeof next.record.task.revision !== "number" || typeof old.record.task.revision !== "number" || next.record.task.revision < old.record.task.revision) return false;
	}
	// 多重集合而不是 Set：重复执行两次的事实不能被一条同名回执冒充覆盖。
	const remaining = [...next.facts];
	for (const fact of old.facts) {
		const index = remaining.indexOf(fact);
		if (index < 0) return false;
		remaining.splice(index, 1);
	}
	return old.files.every((path) => next.files.includes(path));
}
