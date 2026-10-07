/**
 * BM-04 B3：**有界关键词/别名检索与详情复验**（R29 加固）。
 *
 * 首版就是"关键词/别名 + 显式过滤 + 有界关联扩展"，不做语义理解。
 * WM 可选进程内增量候选索引；每个命中仍**重新读取当前记录**，
 * 用 `core/memory` 的决策管道产出"能参考什么、为什么"，而不是丢一堆标题。
 *
 * 七条纪律（对应 bm04_development_plan.md §3 B3 与 round29_acceptance.md §4）：
 * 1. **缺省拒绝**：没有任何显式授权（来源项目 / 需求 ID / 批准客户）时**不读取任何记录**，
 *    连 ID、计数与路径诊断都不形成；
 * 2. **先授权后可见**：标题、片段、计数、排序都只在授权过滤**之后**形成；
 * 3. **关联扩展有界**：需求命中（含别名）后按其 `relatedExperienceIds` 有界读取关联经验，
 *    再按来源授权 / 审核状态 / 当前 revision / 复用范围 / 端点策略复验，绝不递归遍历整库；
 * 4. **一切有界且如实记账**：目录列举的正文读取与再次详情读取都计入预算，
 *    实际读取条目数/字节数如实报告；取消在**所有**读取路径上穿透；
 * 5. **端点策略显式**：`endpointAllowed` / `allowInternalGeneral` / `customers` 由调用方给出；
 * 6. **current 与 history 分开**：`deprecated` 不进入当前推荐；
 * 7. **跨项目只是参考**：命中用于"移植参考"，不代表目标项目已经验证。
 */
import { decideMemory, projectV1ExperienceCard, type MemoryAuthorization, type MemoryCandidate, type MemoryDecision, type MemoryDecisionResult, type MemoryQuery, type MemoryScopeDeclaration, type MemoryTargetContext } from "../memory/index.ts";
import type { EvidenceRef } from "../contracts/common.ts";
import type { ExperienceCard, FeatureRecord } from "../contracts/records.ts";
import { isStorageError, listRecords, readRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { isFeatureVisible } from "./features.ts";
import { indexedKnowledgeIds } from "./searchIndex.ts";
import { memoryMaintenanceCandidates } from "./maintenance.ts";
import { invalidArgument, normalizeForKey, ProjectServiceError, requireKnowledgeId, resolveKnowledgeLimits, splitQueryTerms, type KnowledgeServiceLimits } from "./contract.ts";

/** 可见范围：**显式**给出（v1 Feature 没有项目归属，不能替它猜一个）。 */
export type KnowledgeVisibility = {
	/** 被授权读取源项目的经验卡（跨项目参考的前提）。 */
	readonly authorizedProjectIds: readonly string[];
	/** 允许读取的需求记录 ID；不给等于"没有显式授权的需求"。 */
	readonly allowedFeatureIds?: readonly string[];
	/** 明确批准的客户范围（需求可见的第二条显式路径；未知客户不推导公开）。 */
	readonly approvedCustomers?: readonly string[];
};

export type SearchInput = {
	/** 可重建的进程内索引：只加速候选定位，不替代授权和权威详情复验。 */
	readonly useIndex?: boolean;
	readonly root: string;
	readonly query: string;
	readonly visibility: KnowledgeVisibility;
	/** 本次目标的上下文（项目/客户/板卡/构建目标）。 */
	readonly target: {
		readonly projectId: string | null;
		readonly workspaceId?: string | null;
		readonly customerId: string | null;
		readonly boardName?: string | null;
		readonly boardRevision?: string | null;
		readonly buildTarget?: string | null;
		readonly commit?: string | null;
	};
	/** 端点/复用策略：由调用方显式给出（人工 CLI 的"允许"只适用于该本地入口）。 */
	readonly authorization: {
		readonly endpointAllowed: boolean | null;
		readonly allowInternalGeneral: boolean;
		readonly customers?: readonly string[];
		/** 被授权读取来源项目的经验卡（与 `visibility.authorizedProjectIds` 同一口径，缺省用后者）。 */
		readonly authorizedProjectIds?: readonly string[];
	};
	readonly intent?: "current" | "history";
	readonly filters?: {
		readonly recordFamilies?: readonly ("experience-card" | "feature-record")[];
		readonly statuses?: readonly ExperienceCard["status"][];
	};
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
};

export type SearchHit = {
	readonly family: "experience-card" | "feature-record";
	readonly recordId: string;
	readonly revision: number;
	/** 记录自身的状态（经验卡审核状态；需求没有状态，固定 `unknown`）。 */
	readonly recordedStatus: ExperienceCard["status"] | "unknown";
	readonly title: string | null;
	readonly matchedFields: readonly string[];
	readonly score: number;
	/** 有界片段（只来自命中字段，且只在授权通过后生成）。 */
	readonly snippet: string | null;
	readonly sourceProjectId: string | null;
	/** M1 的分类（`current` / `reference` / `needs-review` / `conflict` / `history` / `excluded`）。 */
	readonly recommendation: MemoryDecision["class"];
	readonly reasons: readonly string[];
	/** 实际声明的验证级别（只按声明报告，不做升级）。 */
	readonly declaredValidations: readonly { readonly kind: string; readonly result: string }[];
};

export type SearchResult = {
	readonly status: "ok" | "incomplete";
	readonly hits: readonly SearchHit[];
	readonly decision: MemoryDecisionResult | null;
	/**
	 * 扫描记账：只统计**授权范围内**被检查的条目与实际读取成本。
	 *
	 * - `experiences` / `features`：授权范围内被检查的条目数（未授权条目不计入，避免用计数泄漏）；
	 * - `recordsRead`：实际读取正文的记录次数（目录列举的完整正文读取 + 再次详情读取）；
	 * - `recordsSkipped`：因 `maxScanRecords` 预算未做详情处理的条目数；
	 * - `bytesRead`：实际读取的正文字节数（含目录列举阶段）。
	 */
	readonly scanned: { readonly experiences: number; readonly features: number; readonly recordsRead: number; readonly recordsSkipped: number; readonly bytesRead: number };
	/** 命中但因为结果上限被截断的条数（> 0 时必须如实报告）。 */
	readonly matchedButDropped: number;
	/** 读取失败的记录条数（不当作"没有命中"）。 */
	readonly unreadable: number;
	readonly problems: readonly string[];
};

/** 命中字段的权重：别名与 ID 最高（人工专门为检索写的），正文其次。 */
const FIELD_WEIGHTS: Record<string, number> = { id: 3, aliases: 3, originalRequirement: 2, acceptanceCriteria: 2, problem: 2, symptom: 2, rootCause: 2, solution: 2, appliesWhen: 1, doesNotApplyWhen: 1 };

type ScanCandidate = { readonly family: "experience-card" | "feature-record"; readonly id: string; readonly text: readonly (readonly [string, string])[] };

type MatchedMeta = {
	readonly candidate: ScanCandidate;
	readonly score: number;
	readonly fields: string[];
	readonly snippet: string | null;
	readonly recordedStatus: ExperienceCard["status"] | "unknown";
	readonly sourceProjectId: string | null;
	readonly declaredValidations: { kind: string; result: string }[];
	readonly revision: number;
};

/** 可检索文本：**派生**的规范键 → 原文片段（原文从不被改写）。 */
function experienceText(card: ExperienceCard): ScanCandidate["text"] {
	return [
		["id", card.id],
		["problem", card.problem],
		...(card.symptom === undefined ? [] : [["symptom", card.symptom] as const]),
		["rootCause", card.rootCause],
		["solution", card.solution],
		...card.appliesWhen.map((item) => ["appliesWhen", item] as const),
		...card.doesNotApplyWhen.map((item) => ["doesNotApplyWhen", item] as const),
	];
}

function featureText(card: FeatureRecord): ScanCandidate["text"] {
	return [["id", card.id], ["originalRequirement", card.originalRequirement], ...card.aliases.map((alias) => ["aliases", alias] as const), ...card.acceptanceCriteria.map((item) => ["acceptanceCriteria", item] as const)];
}

/** 关键词匹配：**全部词**都要出现（AND），返回命中字段与确定性得分。 */
function matchTerms(text: ScanCandidate["text"], terms: readonly string[]): { readonly matched: boolean; readonly fields: string[]; readonly score: number; readonly snippet: string | null; readonly snippetField: string | null } {
	const fields: string[] = [];
	let score = 0;
	let snippet: string | null = null;
	let snippetField: string | null = null;
	for (const term of terms) {
		let hit = false;
		for (const [field, value] of text) {
			if (!normalizeForKey(value).includes(term)) continue;
			hit = true;
			if (!fields.includes(field)) {
				fields.push(field);
				score += FIELD_WEIGHTS[field] ?? 1;
				if (snippet === null) {
					snippet = value;
					snippetField = field;
				}
			}
		}
		if (!hit) return { matched: false, fields: [], score: 0, snippet: null, snippetField: null };
	}
	return { matched: fields.length > 0, fields, score, snippet, snippetField };
}

function evidenceToView(evidence: readonly EvidenceRef[]): MemoryCandidate["evidence"] {
	return evidence.slice(0, 16).map((entry) => ({ validity: entry.validity === "active" ? ("active" as const) : entry.validity === "stale" ? ("stale" as const) : ("unavailable" as const), contentHash: entry.contentHash ?? null }));
}

/** 需求记录 → M1 候选（v1 没有项目归属：只有"人工显式授权"或"已确认客户"两条路）。 */
function featureCandidate(card: FeatureRecord, revision: number, input: SearchInput): MemoryCandidate {
	const customer = card.customer.status === "confirmed" && card.customer.value !== null ? card.customer.value : null;
	const authorizedCustomers = input.authorization.customers ?? [];
	const explicitlyAllowed = input.visibility.allowedFeatureIds?.includes(card.id) === true;
	const scope: MemoryScopeDeclaration = { projectId: null, workspaceId: null, customerId: customer, boardName: null, boardRevision: null, buildTarget: null };
	const reuse: MemoryCandidate["reuse"] =
		customer !== null && authorizedCustomers.includes(customer)
			? { level: "customer", customers: [customer], authorization: null }
			: explicitlyAllowed && input.authorization.allowInternalGeneral
				? { level: "internal-general", customers: [], authorization: "operator-declared-feature-visibility" }
				: { level: "internal-general", customers: [], authorization: null };
	return {
		family: "feature-record",
		recordId: card.id,
		revision,
		authority: "authoritative-read",
		sourceFingerprint: null,
		status: "unknown",
		scope,
		reuse,
		time: { occurredAt: null, recordedAt: card.updatedAt, effectiveFrom: null, effectiveTo: null },
		confirmedFields: [],
		validations: [],
		evidence: evidenceToView(card.customer.evidence),
		dependencySnapshot: null,
		derivedFromSummaryOf: null,
		factKey: null,
		value: null,
		title: null,
	};
}

function targetContext(input: SearchInput): MemoryTargetContext {
	return {
		scope: {
			projectId: input.target.projectId,
			workspaceId: input.target.workspaceId ?? null,
			customerId: input.target.customerId,
			boardName: input.target.boardName ?? null,
			boardRevision: input.target.boardRevision ?? null,
			buildTarget: input.target.buildTarget ?? null,
		},
		snapshot: { commit: input.target.commit ?? null, boardRevision: input.target.boardRevision ?? null, buildTarget: input.target.buildTarget ?? null, contentHashes: [] },
	};
}

/**
 * 需求可见的三条**显式**路径：授权 ID、批准的客户范围、或本次端点策略里显式列出的客户
 * （与 M1 的 customer 级复用同一口径；未知客户不推导公开）。
 */
function featureVisibleForSearch(card: FeatureRecord, input: SearchInput): boolean {
	if (isFeatureVisible(card, input.visibility)) return true;
	const authorizedCustomers = input.authorization.customers;
	if (authorizedCustomers === undefined || authorizedCustomers.length === 0) return false;
	return card.customer.status === "confirmed" && card.customer.value !== null && authorizedCustomers.includes(card.customer.value);
}

function hasFeatureAuthorization(visibility: KnowledgeVisibility, authorization: SearchInput["authorization"]): boolean {
	return (visibility.allowedFeatureIds?.length ?? 0) > 0 || (visibility.approvedCustomers?.length ?? 0) > 0 || (authorization.customers?.length ?? 0) > 0;
}

function hasProjectAuthorization(visibility: KnowledgeVisibility): boolean {
	return visibility.authorizedProjectIds.length > 0;
}

/**
 * 诊断文案：不回显绝对路径；无法判定授权的条目**不回显 ID**（R29-1 / R30-1）。
 *
 * 经验族的授权依据是记录里的 `sourceProjectId`，而坏文件读不出它——因此经验条目**一律**省略 ID
 * （不能把"授权了任意一个项目"当成该条目的授权）；需求族可以按显式 `allowedFeatureIds` 判定。
 */
function diagnostic(family: "experience-card" | "feature-record", id: string | null, code: string, authorized: boolean): string {
	if (family === "experience-card") return `${family}: ${code}（不可读条目；已省略 ID 与路径）`;
	if (id !== null && authorized) return `${family}/${id}: ${code}`;
	return `${family}: ${code}（不可读条目；已省略 ID 与路径）`;
}

/**
 * 有界关键词/别名检索。
 *
 * 顺序固定：**授权闸门 → 扫描目录（计入正文读取）→ 有界详情读取/匹配 →
 * 别名命中后的有界关联扩展 → M1 决策（内含第二道授权）→ 生成命中与片段**。
 */
export async function searchKnowledge(input: SearchInput): Promise<SearchResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("检索参数必须是对象");
	const limits = resolveKnowledgeLimits(input.limits);
	const terms = splitQueryTerms(input.query, limits);
	const intent = input.intent ?? "current";
	const families = input.filters?.recordFamilies ?? ["experience-card", "feature-record"];
	if (families.length === 0) throw invalidArgument("recordFamilies 不能为空");
	const problems: string[] = [];
	const maxProblems = 16;

	const scanned = { experiences: 0, features: 0, recordsRead: 0, recordsSkipped: 0, bytesRead: 0 };
	let unreadable = 0;
	let truncated = false;

	const pushProblem = (message: string): void => {
		if (problems.length < maxProblems) problems.push(message);
	};
	const assertNotCancelled = (): void => {
		if (input.signal?.aborted) throw new ProjectServiceError("cancelled", "检索已取消", { detail: "cancelled" });
	};

	const scanExperiences = families.includes("experience-card");
	const scanFeatures = families.includes("feature-record");
	const projectAuthorized = hasProjectAuthorization(input.visibility);
	const featureAuthorized = hasFeatureAuthorization(input.visibility, input.authorization);

	// **授权先于扫描**：本族没有显式授权时不读取该族任何记录。
	// 两族都没有授权 ⇒ 直接返回空结果（连 ID、计数与诊断都不形成）。
	if ((!scanExperiences || !projectAuthorized) && (!scanFeatures || !featureAuthorized)) {
		return { status: "ok", hits: [], decision: null, scanned, matchedButDropped: 0, unreadable: 0, problems: [] };
	}

	const candidates: MemoryCandidate[] = [];
	const matchedMeta = new Map<string, MatchedMeta>();
	const addedCandidateKeys = new Set<string>();

	/**
	 * **全族共享**的读取预算（R31-3）：列举、详情、关联扩展都从同一个剩余额度扣；
	 * 额度为 0 时不再开下一个族——旧实现用 `Math.max(1, remaining)` 给第二族"免费一条"，
	 * 于是 `maxScanRecords=1` 实际读了 2 条正文。
	 *
	 * 已读记录进入本次缓存：重复逻辑读取（别名扩展再次碰到同一条）不再重复计费，
	 * 避免"重复读把额度耗光后把命中全丢掉"。
	 */
	let budgetRemaining = limits.maxScanRecords;
	const experienceCache = new Map<string, { readonly card: ExperienceCard; readonly revision: number } | null>();
	const featureCache = new Map<string, { readonly card: FeatureRecord; readonly revision: number } | null>();
	const noteSkipped = (): void => {
		scanned.recordsSkipped += 1;
		truncated = true;
	};
	const canRead = (): boolean => budgetRemaining > 0;
	/** 实际读取才计费（成功与失败都算成本；缓存命中不算）。 */
	const chargeRead = (): void => {
		budgetRemaining -= 1;
		scanned.recordsRead += 1;
	};

	/** 读取一条经验卡正文（共享预算；失败也计费；取消穿透；不可读进入有界诊断）。 */
	const readExperienceForScan = async (experienceId: string): Promise<{ readonly card: ExperienceCard; readonly revision: number } | null> => {
		assertNotCancelled();
		const cached = experienceCache.get(experienceId);
		if (cached !== undefined) return cached;
		if (!canRead()) {
			noteSkipped();
			return null;
		}
		chargeRead();
		try {
			const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			scanned.bytesRead += read.bytes;
			const loaded = { card: read.record, revision: read.record.revision };
			experienceCache.set(experienceId, loaded);
			return loaded;
		} catch (error) {
			if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "检索已取消", { detail: "cancelled", cause: error });
			unreadable += 1;
			experienceCache.set(experienceId, null);
			pushProblem(diagnostic("experience-card", experienceId, isStorageError(error) ? error.code : "io-error", projectAuthorized));
			return null;
		}
	};

	/** 加入一条经验候选（同一记录身份+revision 只加一次；事实键都是 null ⇒ 按记录身份去重即可）。 */
	const addExperienceCandidate = (card: ExperienceCard, revision: number, meta: Omit<MatchedMeta, "revision" | "candidate">): void => {
		const key = `experience-card|${card.id}|${revision}`;
		if (addedCandidateKeys.has(key)) return;
		addedCandidateKeys.add(key);
		candidates.push(projectV1ExperienceCard(card));
		matchedMeta.set(key, { ...meta, revision, candidate: { family: "experience-card", id: card.id, text: experienceText(card) } });
	};

	const scanFamily = async (family: "experience-card" | "feature-record"): Promise<void> => {
		// 零额度直接停：不再开下一个族（R31-3）。
		if (!canRead()) {
			noteSkipped();
			return;
		}
		// 前置列举同样服从**共享**剩余额度：最多读 remaining 条正文。
		const remaining = budgetRemaining;
		const bounds = input.storageLimits ?? {};
		const indexed = input.useIndex === true ? await indexedKnowledgeIds(input, family, terms, Math.max(0, remaining - 1)) : null;
		const listing =
			indexed ??
			(await listRecords({
				root: input.root,
				kind: family,
				limits: { ...bounds, maxListEntries: Math.min(bounds.maxListEntries ?? Number.MAX_SAFE_INTEGER, remaining), maxScanEntries: Math.min(bounds.maxScanEntries ?? Number.MAX_SAFE_INTEGER, remaining) },
				signal: input.signal,
				ioHooks: input.ioHooks,
			}));
		// 目录列举为了生成摘要会读取每条正文：这份成本必须计入共享预算与字节。
		const indexReads = indexed?.recordsRead ?? listing.entries.length;
		budgetRemaining -= indexReads;
		scanned.recordsRead += indexReads;
		scanned.bytesRead += listing.bytesRead;
		if (listing.truncated) {
			truncated = true;
			pushProblem(`${family} 目录扫描被预算截断（${listing.truncatedBy.join("、")}）：可能有未纳入的记录`);
		}
		for (const problem of listing.problems) {
			// 只报受控码；未授权条目不回显 ID，任何条目都不回显绝对路径。
			const authorized = family === "feature-record" ? input.visibility.allowedFeatureIds?.includes(problemIdFromPath(problem.path)) === true : projectAuthorized;
			pushProblem(diagnostic(family, problemIdFromPath(problem.path), problem.code, authorized));
		}

		for (const entry of listing.entries) {
			assertNotCancelled();
			if (!canRead()) {
				noteSkipped();
				continue;
			}
			if (family === "experience-card") {
				const loaded = await readExperienceForScan(entry.id);
				if (loaded === null) continue;
				// 服务层的第一道授权闸门：源项目必须显式列在可见范围里。
				if (!input.visibility.authorizedProjectIds.includes(loaded.card.sourceProjectId)) continue;
				if (input.filters?.statuses !== undefined && !input.filters.statuses.includes(loaded.card.status)) continue;
				scanned.experiences += 1;
				const match = matchTerms(experienceText(loaded.card), terms);
				if (match.matched) {
					addExperienceCandidate(loaded.card, loaded.revision, {
						score: match.score,
						fields: match.fields,
						snippet: match.snippet,
						recordedStatus: loaded.card.status,
						sourceProjectId: loaded.card.sourceProjectId,
						declaredValidations: loaded.card.validations.map((validation) => ({ kind: validation.kind, result: validation.result })),
					});
				}
			} else {
				const read = await readFeatureSafely(entry.id);
				if (read === null) continue;
				if (!featureVisibleForSearch(read.card, input)) continue;
				scanned.features += 1;
				const match = matchTerms(featureText(read.card), terms);
				if (!match.matched) continue;
				const key = `feature-record|${read.card.id}|${read.revision}`;
				if (!addedCandidateKeys.has(key)) {
					addedCandidateKeys.add(key);
					candidates.push(featureCandidate(read.card, read.revision, input));
					matchedMeta.set(key, { candidate: { family, id: read.card.id, text: featureText(read.card) }, score: match.score, fields: match.fields, snippet: match.snippet, recordedStatus: "unknown", sourceProjectId: null, declaredValidations: [], revision: read.revision });
				}
				// **别名/需求命中后的有界关联扩展**：只读它真实引用的经验，绝不递归遍历整库。
				if (!scanExperiences) continue;
				for (const relatedId of read.card.relatedExperienceIds.slice(0, limits.maxDetailLinks)) {
					// 关联扩展把尚未进入结果的授权经验补进来（含未命中关键词的那些）；
					// 读取仍走同一预算、同一取消与同一条授权闸门。
					const related = await readExperienceForScan(relatedId);
					if (related === null) continue;
					if (!input.visibility.authorizedProjectIds.includes(related.card.sourceProjectId)) continue;
					if (input.filters?.statuses !== undefined && !input.filters.statuses.includes(related.card.status)) continue;
					addExperienceCandidate(related.card, related.revision, {
						score: 1,
						fields: ["relatedExperienceIds"],
						snippet: null,
						recordedStatus: related.card.status,
						sourceProjectId: related.card.sourceProjectId,
						declaredValidations: related.card.validations.map((validation) => ({ kind: validation.kind, result: validation.result })),
					});
				}
			}
		}
	};

	/** Feature 详情读取（与经验同一条共享预算与缓存；失败计费；取消穿透）。 */
	async function readFeatureSafely(featureId: string): Promise<{ readonly card: FeatureRecord; readonly revision: number } | null> {
		assertNotCancelled();
		const cached = featureCache.get(featureId);
		if (cached !== undefined) return cached;
		if (!canRead()) {
			noteSkipped();
			return null;
		}
		chargeRead();
		try {
			const read = await readRecord({ root: input.root, kind: "feature-record", id: featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			scanned.bytesRead += read.bytes;
			const loaded = { card: read.record, revision: read.record.revision };
			featureCache.set(featureId, loaded);
			return loaded;
		} catch (error) {
			if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "检索已取消", { detail: "cancelled", cause: error });
			unreadable += 1;
			featureCache.set(featureId, null);
			pushProblem(diagnostic("feature-record", featureId, isStorageError(error) ? error.code : "io-error", input.visibility.allowedFeatureIds?.includes(featureId) === true));
			return null;
		}
	}

	for (const family of families) {
		// 本族没有显式授权时**不扫描该族**（不读取、不计入成本、不产生诊断）。
		if (family === "experience-card" && !projectAuthorized) continue;
		if (family === "feature-record" && !featureAuthorized) continue;
		// 零额度停止：后面还有族也不再开（共享额度，不给任何族免费额度）。
		if (!canRead()) {
			noteSkipped();
			break;
		}
		await scanFamily(family);
	}

	if (candidates.length === 0) {
		// 无命中 ≠ 完整：列举/读取问题与预算触顶都必须汇总成 incomplete。
		const incomplete = truncated || unreadable > 0 || problems.length > 0;
		return { status: incomplete ? "incomplete" : "ok", hits: [], decision: null, scanned, matchedButDropped: 0, unreadable, problems };
	}

	const authorization: MemoryAuthorization = {
		endpointAllowed: input.authorization.endpointAllowed,
		allowInternalGeneral: input.authorization.allowInternalGeneral,
		customers: [...(input.authorization.customers ?? [])],
	};
	const query: MemoryQuery = { intent, now: input.now ?? Date.now(), candidates, relations: [], authorization, target: targetContext(input) };
	let decision = decideMemory(query);

	// 命中只从 M1 的**可见条目**生成：未授权记录没有 ID、标题、片段，也不进计数。
	let hits: SearchHit[] = [];
	for (const item of decision.items) {
		const key = `${item.family}|${item.recordId}|${item.revision}`;
		const meta = matchedMeta.get(key);
		if (meta === undefined) continue;
		hits.push({
			family: item.family === "experience-card" ? "experience-card" : "feature-record",
			recordId: item.recordId,
			revision: item.revision,
			recordedStatus: meta.recordedStatus,
			title: item.title ?? meta.candidate.id,
			matchedFields: meta.fields,
			score: meta.score,
			snippet: meta.snippet === null ? null : meta.snippet.length > limits.maxShortItemChars ? `${meta.snippet.slice(0, limits.maxShortItemChars)}…` : meta.snippet,
			sourceProjectId: meta.sourceProjectId,
			recommendation: item.class,
			reasons: item.reasons,
			declaredValidations: meta.declaredValidations,
		});
	}

	// 排序：先按推荐强度（current → reference → needs-review → conflict → history → excluded），
	// 再按关键词得分降序，最后按记录族/ID —— 结果与输入顺序无关。
	const CLASS_ORDER = ["current", "reference", "needs-review", "conflict", "history", "excluded"];
	// 只比较本次已经可见的当前记录；未授权/历史卡不能给另一张卡制造冲突。
	const visibleIds = new Set(hits.filter((hit) => hit.family === "experience-card" && !["excluded", "history"].includes(hit.recommendation)).map((hit) => hit.recordId));
	const visibleCards = [...experienceCache.values()].flatMap((entry) => (entry && visibleIds.has(entry.card.id) ? [entry.card] : []));
	const maintenance = memoryMaintenanceCandidates(visibleCards, null);
	if (maintenance.length >= 20) truncated = true;
	const conflicts = new Set(maintenance.filter((issue) => issue.kind === "possible-conflict").flatMap((issue) => issue.ids));
	hits = hits.map((hit) => (conflicts.has(hit.recordId) ? { ...hit, recommendation: "conflict", reasons: [...hit.reasons, "possible-content-conflict"] } : hit));
	decision = { ...decision, items: decision.items.map((item) => (item.family === "experience-card" && conflicts.has(item.recordId) ? { ...item, class: "conflict", reasons: [...item.reasons, "possible-content-conflict"] } : item)) };
	hits.sort((left, right) => {
		const rank = CLASS_ORDER.indexOf(left.recommendation) - CLASS_ORDER.indexOf(right.recommendation);
		if (rank !== 0) return rank;
		if (left.score !== right.score) return right.score - left.score;
		if (left.family !== right.family) return left.family < right.family ? -1 : 1;
		return left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0;
	});

	const matchedButDropped = Math.max(0, hits.length - limits.maxSearchResults);
	const bounded = hits.slice(0, limits.maxSearchResults);
	if (matchedButDropped > 0) truncated = true;

	// 有读不出来的条目（目录问题或读取失败）时不能说"检索完整"：那是"没看到"，不是"没有"。
	const incomplete = truncated || unreadable > 0 || problems.length > 0 || decision.status === "incomplete";
	return {
		status: incomplete ? "incomplete" : "ok",
		hits: bounded,
		decision,
		scanned,
		matchedButDropped,
		unreadable,
		problems,
	};
}

/** 从列表问题的路径里取出记录 ID（仅用于判断"是否显式授权"，绝不回显绝对路径）。 */
function problemIdFromPath(path: string): string {
	const normalized = path.split("\\").join("/");
	const name = normalized.slice(normalized.lastIndexOf("/") + 1);
	return name.endsWith(".json") ? name.slice(0, -".json".length) : name;
}

/* ------------------------------------------------------------------ 跨项目参考详情 */

export type ReferenceView = {
	readonly status: "ok" | "not-found" | "not-recommended";
	readonly recordId: string;
	readonly revision: number | null;
	readonly reference: {
		readonly problem: string;
		readonly symptom: string | null;
		readonly rootCause: string;
		readonly solution: string;
		readonly appliesWhen: readonly string[];
		readonly doesNotApplyWhen: readonly string[];
		readonly sourceProjectId: string;
		readonly featureId: string | null;
		readonly declaredValidations: readonly { readonly kind: string; readonly scope: string; readonly result: string; readonly performedBy: string }[];
		/** 完整 EvidenceRef 引用（有界；不复制正文）。 */
		readonly evidence: readonly EvidenceRef[];
		/** 来源 commit：只在存在合法 EvidenceRef 时给出；没有则为 null + 明确原因。 */
		readonly sourceCommit: string | null;
		/** 关联需求的原始需求/验收条件（仅在显式授权读取该需求时给出）。 */
		readonly feature: { readonly originalRequirement: string; readonly acceptanceCriteria: readonly string[]; readonly revision: number } | null;
		readonly reuseScope: ExperienceCard["reuseScope"];
	} | null;
	readonly recommendation: MemoryDecision["class"] | null;
	readonly reasons: readonly string[];
	/** 移植口径：**始终**只作参考（本批不执行移植/构建/刷板）。 */
	readonly porting: { readonly referenceOnly: true; readonly needsPortingReview: boolean; readonly reasons: readonly string[] };
	readonly problems: readonly string[];
};

/**
 * 单条经验的**跨项目参考详情**。
 *
 * 与检索共用同一套授权与决策，并补齐来源证据闭环（R29-2）：
 * 完整 EvidenceRef、来源 commit（若有合法引用）、关联需求原文/验收条件（仅在显式授权时）。
 */
export async function readExperienceReference(input: {
	readonly root: string;
	readonly experienceId: string;
	readonly targetProjectId: string | null;
	/** 目标客户：`customer` 级复用的经验只有在目标客户已授权时才可见（未知不等于公开）。 */
	readonly targetCustomerId?: string | null;
	readonly authorization: SearchInput["authorization"];
	/** 允许读取关联需求的显式授权 ID（不给 ⇒ 不展示需求正文）。 */
	readonly allowedFeatureIds?: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
}): Promise<ReferenceView> {
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	const limits = resolveKnowledgeLimits(input.limits);
	const problems: string[] = [];
	let card: ExperienceCard;
	let revision: number;
	try {
		const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		card = read.record;
		revision = read.record.revision;
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) {
			return { status: "not-found", recordId: experienceId, revision: null, reference: null, recommendation: null, reasons: [], porting: { referenceOnly: true, needsPortingReview: true, reasons: ["记录不可读：不能作为参考"] }, problems: [] };
		}
		if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "读取经验卡已取消", { detail: "cancelled", cause: error });
		throw new ProjectServiceError("io-error", `读取经验卡失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}

	const target: SearchInput["target"] = { projectId: input.targetProjectId, customerId: input.targetCustomerId ?? null };
	const decision = decideMemory({
		intent: "current",
		now: input.now ?? Date.now(),
		candidates: [projectV1ExperienceCard(card)],
		relations: [],
		authorization: { endpointAllowed: input.authorization.endpointAllowed, allowInternalGeneral: input.authorization.allowInternalGeneral, customers: [...(input.authorization.customers ?? [])] },
		target: targetContext({ root: input.root, query: "", visibility: { authorizedProjectIds: [] }, target, authorization: input.authorization }),
	});
	const item = decision.items[0];

	// 服务层的第一道闸门：来源项目必须是显式授权的（空集合 = 没有授权任何来源）。
	const authorizedProjects = input.authorization.authorizedProjectIds ?? [];
	if (!authorizedProjects.includes(card.sourceProjectId)) {
		return { status: "not-recommended", recordId: experienceId, revision, reference: null, recommendation: null, reasons: [], porting: { referenceOnly: true, needsPortingReview: true, reasons: ["来源项目不在授权范围内：不展示内容"] }, problems: [] };
	}

	// 未授权 ⇒ M1 完全不返回条目；这里如实说"没有可用结论"，不泄漏记录内容。
	if (item === undefined) {
		return { status: "not-recommended", recordId: experienceId, revision, reference: null, recommendation: null, reasons: [], porting: { referenceOnly: true, needsPortingReview: true, reasons: ["该经验不在本次授权范围内：不展示内容"] }, problems: [] };
	}

	// 来源 commit / 关联需求：能锚定就展示，锚定不了就明确"未知"，不拿当前 HEAD 追溯历史。
	const sourceCommitRef = card.evidence.find((ref) => typeof ref.commit === "string" && ref.commit.length > 0);
	const sourceCommit = sourceCommitRef?.commit ?? null;
	if (sourceCommit === null) problems.push("来源 commit 未知：记录里没有带 commit 的合法 EvidenceRef，不拿当前 HEAD 追溯历史验证");
	let feature: { originalRequirement: string; acceptanceCriteria: readonly string[]; revision: number } | null = null;
	if (card.featureId !== undefined) {
		if (input.allowedFeatureIds?.includes(card.featureId) === true) {
			try {
				const featureRead = await readRecord({ root: input.root, kind: "feature-record", id: card.featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
				feature = { originalRequirement: featureRead.record.originalRequirement, acceptanceCriteria: featureRead.record.acceptanceCriteria.slice(0, limits.maxListItems), revision: featureRead.record.revision };
			} catch (error) {
				if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "读取关联需求已取消", { detail: "cancelled", cause: error });
				problems.push(`关联需求 ${card.featureId} 不可读：不展示需求正文`);
			}
		} else {
			problems.push(`关联需求 ${card.featureId} 未在显式授权范围内：不展示需求正文`);
		}
	}

	const portingReasons: string[] = ["跨项目/跨平台的结论只作**移植参考**：本批不执行移植、构建或刷板"];
	if (input.targetProjectId !== null && input.targetProjectId !== card.sourceProjectId) portingReasons.push(`来源项目（${card.sourceProjectId}）与目标项目不同：需要在目标项目重新验证`);
	const strongest = card.validations.some((validation) => validation.result === "passed" && (validation.kind === "board-boot" || validation.kind === "stress-loop" || validation.kind === "customer-acceptance"));
	if (!strongest) portingReasons.push("记录里没有目标板级验证（board-boot / stress-loop / customer-acceptance）：只能作为受限参考");
	if (card.appliesWhen.length === 0) portingReasons.push("没有声明适用条件：无法自动判断是否适用于当前平台");

	const featureView: NonNullable<ReferenceView["reference"]> = {
		problem: card.problem,
		symptom: card.symptom ?? null,
		rootCause: card.rootCause,
		solution: card.solution,
		appliesWhen: card.appliesWhen.slice(0, limits.maxListItems),
		doesNotApplyWhen: card.doesNotApplyWhen.slice(0, limits.maxListItems),
		sourceProjectId: card.sourceProjectId,
		featureId: card.featureId ?? null,
		declaredValidations: card.validations.slice(0, limits.maxListItems).map((validation) => ({ kind: validation.kind, scope: validation.scope, result: validation.result, performedBy: validation.performedBy })),
		evidence: card.evidence.slice(0, limits.maxEvidenceRefs),
		sourceCommit,
		feature,
		reuseScope: card.reuseScope,
	};

	return {
		status: item.class === "excluded" || item.class === "history" ? "not-recommended" : "ok",
		recordId: experienceId,
		revision,
		reference: featureView,
		recommendation: item.class,
		reasons: item.reasons,
		porting: { referenceOnly: true, needsPortingReview: true, reasons: portingReasons },
		problems,
	};
}

/** 供 CLI 一行提示：命中的推荐强度分布（**只统计可见条目**）。 */
export function describeSearch(result: SearchResult): string {
	const counts = new Map<string, number>();
	for (const hit of result.hits) counts.set(hit.recommendation, (counts.get(hit.recommendation) ?? 0) + 1);
	const summary = [...counts.entries()].map(([label, count]) => `${label} ${count}`).join("、") || "无命中";
	return `命中 ${result.hits.length}（${summary}）｜检查 experience ${result.scanned.experiences} / feature ${result.scanned.features}、读取 ${result.scanned.recordsRead} 次（${result.scanned.bytesRead} 字节）${result.unreadable > 0 ? `、不可读 ${result.unreadable}` : ""}`;
}
