/** WM-03：有界进程内增量索引；只提供候选 ID，命中仍由 search 重读权威记录。
 * 不写知识根、不缓存权限决定、不把索引正文交模型；重启冷建，最多四个根/授权组合。
 */
import { lstat } from "node:fs/promises";
import { createStorageBoundary } from "../storage/boundary.ts";
import { readRecord, recordRelativeSegments } from "../storage/records.ts";
import { assertKnowledgeId } from "../contracts/ids.ts";
import { normalizeForKey, ProjectServiceError } from "./contract.ts";
import { isFeatureVisible } from "./features.ts";
import type { SearchInput } from "./search.ts";
import type { ExperienceCard, FeatureRecord } from "../contracts/records.ts";
type Family = "experience-card" | "feature-record";
type Item = { signature: string; card: ExperienceCard | FeatureRecord; text: string; bytes: number };
const caches = new Map<string, Map<string, Item>>();
export function clearKnowledgeIndex(): void {
	caches.clear();
}

export async function indexedKnowledgeIds(input: SearchInput, family: Family, terms: readonly string[], maxReads: number) {
	const boundary = await createStorageBoundary({ root: input.root, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const key = JSON.stringify([boundary.canonicalRoot, family, [...input.visibility.authorizedProjectIds].sort(), [...(input.visibility.allowedFeatureIds ?? [])].sort(), [...(input.visibility.approvedCustomers ?? [])].sort(), [...(input.authorization.customers ?? [])].sort()]);
	let cache = caches.get(key);
	if (!cache) {
		cache = new Map();
		caches.set(key, cache);
		if (caches.size > 4) caches.delete(caches.keys().next().value!);
	}
	const listing = await boundary.listEntries(boundary.resolve(family === "experience-card" ? "experiences" : "features"), { filesOnly: true, includeSymlinks: true, maxEntries: Math.min(5000, boundary.limits.maxScanEntries), signal: input.signal });
	const entries: { id: string }[] = [];
	const problems: { path: string; code: string }[] = [];
	let recordsRead = 0,
		bytesRead = 0,
		incomplete = listing.truncated;
	const seen = new Set<string>();
	for (const name of listing.names.sort()) {
		if (input.signal?.aborted) throw new ProjectServiceError("cancelled", "检索索引刷新已取消");
		if (!name.endsWith(".json")) continue;
		const id = name.slice(0, -5);
		try {
			assertKnowledgeId(id, "index id");
		} catch {
			incomplete = true;
			continue;
		}
		seen.add(id);
		const path = boundary.resolve(...recordRelativeSegments(family, id));
		try {
			boundary.assertNoSymlinks(path);
			await boundary.beforeIo("stat", path);
			const stat = await lstat(path, { bigint: true });
			if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not-file");
			const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
			let item = cache.get(id);
			if (item?.signature !== signature) {
				cache.delete(id);
				if (recordsRead >= maxReads) {
					incomplete = true;
					continue;
				}
				recordsRead++;
				const read = await readRecord({ root: input.root, kind: family, id, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
				bytesRead += read.bytes;
				const card = read.record;
				const text = "problem" in card ? [card.id, card.problem, card.symptom ?? "", card.rootCause, card.solution, ...card.appliesWhen, ...card.doesNotApplyWhen].join("\n") : [card.id, card.originalRequirement, ...card.aliases, ...card.acceptanceCriteria].join("\n");
				item = { signature, card, text: normalizeForKey(text), bytes: read.bytes + Buffer.byteLength(text, "utf8") };
				const used = [...cache.values()].reduce((total, entry) => total + entry.bytes, 0);
				if (used + item.bytes <= 16 * 1024 * 1024) cache.set(id, item);
				else incomplete = true;
			}
			const visible =
				"sourceProjectId" in item.card
					? input.visibility.authorizedProjectIds.includes(item.card.sourceProjectId)
					: isFeatureVisible(item.card, input.visibility) || (item.card.customer.status === "confirmed" && item.card.customer.value !== null && (input.authorization.customers ?? []).includes(item.card.customer.value));
			if (visible && terms.every((term) => item.text.includes(term))) entries.push({ id });
		} catch (error) {
			cache.delete(id);
			if (input.signal?.aborted) throw error;
			incomplete = true;
			if (problems.length < 16) problems.push({ path: "", code: "index-entry-unreadable" });
		}
	}
	// 即使目录截断，也不使用本次没有观察到的缓存；完整列表才能清掉删除项。
	if (!listing.truncated) for (const id of cache.keys()) if (!seen.has(id)) cache.delete(id);
	if (input.signal?.aborted) throw new ProjectServiceError("cancelled", "检索索引刷新已取消");
	return { entries, problems, truncated: incomplete, truncatedBy: incomplete ? ["index-refresh"] : [], recordsRead, bytesRead };
}
