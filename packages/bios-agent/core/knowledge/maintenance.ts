/** WM-02：发现整合候选，不把文本相似度或时间戳当事实裁决。 */
import { listRecords } from "../storage/records.ts";
import { readExperienceDetail } from "./experiences.ts";
import { normalizeForKey } from "./contract.ts";
import { createStorageBoundary } from "../storage/boundary.ts";
import { validateAuditEvent } from "../contracts/auditValidation.ts";
import { assertKnowledgeId } from "../contracts/ids.ts";
import type { ExperienceCard } from "../contracts/records.ts";

export async function workspaceExperienceCards(input: { root: string; projectId: string; workspaceId: string; signal?: AbortSignal }) {
	const list = await listRecords({ root: input.root, kind: "experience-card", signal: input.signal, limits: { maxListEntries: 100, maxScanEntries: 500 } });
	const cards: ExperienceCard[] = [];
	let incomplete = list.truncated || list.problems.length > 0;
	for (const entry of list.entries) {
		try {
			const read = await readExperienceDetail({ root: input.root, experienceId: entry.id, authorizedProjectIds: [input.projectId], signal: input.signal });
			if (read.card?.sourceProjectId === input.projectId && read.card.evidence.some((ref) => ref.workspaceId === input.workspaceId)) cards.push(read.card);
		} catch (error) {
			if (input.signal?.aborted) throw error;
			incomplete = true;
		}
	}
	return { cards, incomplete };
}

/** 精确内容重复只在同工作区/同复用范围/同适用条件下识别，不跨客户或板卡合并。 */
export function experienceContentKey(card: Pick<ExperienceCard, "problem" | "rootCause" | "solution" | "appliesWhen" | "doesNotApplyWhen" | "reuseScope">): string {
	return JSON.stringify([normalizeForKey(card.problem), normalizeForKey(card.rootCause), normalizeForKey(card.solution), [...card.appliesWhen].map(normalizeForKey).sort(), [...card.doesNotApplyWhen].map(normalizeForKey).sort(), card.reuseScope]);
}
export function memoryMaintenanceCandidates(cards: readonly ExperienceCard[], head: string | null) {
	const issues: { kind: string; ids: string[]; revisions: number[]; reason: string }[] = [];
	const active = cards.filter((card) => card.status !== "deprecated");
	for (let i = 0; i < active.length && issues.length < 20; i++) {
		const a = active[i]!;
		if (head && a.evidence.some((ref) => ref.commit && ref.commit !== head)) issues.push({ kind: "baseline-review", ids: [a.id], revisions: [a.revision], reason: "来源提交与当前 HEAD 不同，只提示适用性复核，不判定错误或已过期" });
		for (let j = i + 1; j < active.length && issues.length < 20; j++) {
			const b = active[j]!;
			// 同症状不是同一工程事实：不得把另一项目/工作区的方案冒充冲突。
			const workspaces = a.evidence.flatMap((ref) => (ref.workspaceId ? [ref.workspaceId] : []));
			if (a.sourceProjectId !== b.sourceProjectId || !b.evidence.some((ref) => ref.workspaceId && workspaces.includes(ref.workspaceId))) continue;
			const sameScope = JSON.stringify([a.reuseScope, [...a.appliesWhen].sort(), [...a.doesNotApplyWhen].sort()]) === JSON.stringify([b.reuseScope, [...b.appliesWhen].sort(), [...b.doesNotApplyWhen].sort()]);
			if (!sameScope || normalizeForKey(a.problem) !== normalizeForKey(b.problem)) continue;
			issues.push({ kind: experienceContentKey(a) === experienceContentKey(b) ? "duplicate" : "possible-conflict", ids: [a.id, b.id], revisions: [a.revision, b.revision], reason: "同问题同声明范围；需读取证据并由工程师判断，不按新旧时间自动选赢者" });
		}
	}
	return issues;
}

/** 有界审核沿革：验证事件归属与结构；不伪装完整 revision 内容历史。 */
export async function experienceAuditHistory(input: { root: string; experienceId: string; signal?: AbortSignal }) {
	assertKnowledgeId(input.experienceId, "experience id");
	const boundary = await createStorageBoundary(input);
	const directory = boundary.resolve("audit", input.experienceId);
	if (!(await boundary.pathExists(directory))) return { events: [], incomplete: false };
	const list = await boundary.listEntries(directory, { filesOnly: true, includeSymlinks: true, maxEntries: 100 });
	const events = [];
	let incomplete = list.truncated;
	for (const name of list.names.sort()) {
		if (!/^[a-f0-9-]{36}\.json$/.test(name)) {
			incomplete = true;
			continue;
		}
		try {
			const read = await boundary.readJson(boundary.resolve("audit", input.experienceId, name), 16 * 1024);
			const validated = validateAuditEvent(read.value);
			if (!validated.ok || !validated.value || validated.value.target.recordId !== input.experienceId || `${validated.value.eventId}.json` !== name) {
				incomplete = true;
				continue;
			}
			const e = validated.value;
			events.push({ action: e.action, from: e.fromStatus, to: e.toStatus, beforeRevision: e.before.revision, afterRevision: e.after.revision, decidedAt: e.decidedAt, reason: e.reason, evidence: e.evidence });
		} catch (error) {
			if (input.signal?.aborted) throw error;
			incomplete = true;
		}
	}
	events.sort((a, b) => a.afterRevision - b.afterRevision);
	return { events: events.slice(-20), incomplete: incomplete || events.length > 20 };
}
