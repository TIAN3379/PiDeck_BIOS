/**
 * BM-04 B3：**有界关键词/别名检索与详情复验**。
 *
 * 首版就是"关键词/别名 + 显式过滤"，不建索引库、不做语义理解：
 * 每次检索都**重新读取当前记录**（没有缓存，因此源变化/废弃立刻生效），
 * 用 `core/memory` 的决策管道产出"能参考什么、为什么"，而不是丢一堆标题。
 *
 * 六条纪律（对应 bm04_development_plan.md §3 B3）：
 * 1. **先授权后可见**：标题、片段、计数、排序都只在授权过滤**之后**形成；
 *    未授权的记录连 ID 与计数都不出现（由 M1 的"未授权候选完全不可见"保证）；
 * 2. **端点策略显式**：`endpointAllowed` / `allowInternalGeneral` / `customers` 由调用方给出，
 *    服务不硬编码"允许发给当前模型"；
 * 3. **一切有界**：扫描条目、实际读取条数、返回条数、片段长度、诊断条数都有上限；
 * 4. **current 与 history 分开**：`deprecated` 不进入当前推荐；显式 history 查询可以解释废弃原因，
 *    但不会把废弃记录升成 current；
 * 5. **无缓存即无陈旧推荐**：命中前重读当前 revision 与状态；
 * 6. **跨项目只是参考**：命中用于"移植参考"，不代表目标项目已经验证。
 */
import { decideMemory, projectV1ExperienceCard, type MemoryAuthorization, type MemoryCandidate, type MemoryDecision, type MemoryDecisionResult, type MemoryQuery, type MemoryScopeDeclaration, type MemoryTargetContext } from "../memory/index.ts";
import type { EvidenceRef } from "../contracts/common.ts";
import type { ExperienceCard, FeatureRecord } from "../contracts/records.ts";
import { isStorageError, listRecords, readRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { invalidArgument, normalizeForKey, ProjectServiceError, requireKnowledgeId, resolveKnowledgeLimits, splitQueryTerms, type KnowledgeServiceLimits } from "./contract.ts";

/** 可见范围：**显式**给出（v1 Feature 没有项目归属，不能替它猜一个）。 */
export type KnowledgeVisibility = {
	/** 被授权读取源项目的经验卡（跨项目参考的前提）。 */
	readonly authorizedProjectIds: readonly string[];
	/** 允许读取的需求记录 ID；不给等于"没有显式授权的需求"。 */
	readonly allowedFeatureIds?: readonly string[];
};

export type SearchInput = {
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
	readonly scanned: { readonly experiences: number; readonly features: number; readonly recordsRead: number; readonly recordsSkipped: number };
	/** 命中但因为结果上限被截断的条数（> 0 时必须如实报告）。 */
	readonly matchedButDropped: number;
	/** 读取失败的记录条数（不当作"没有命中"）。 */
	readonly unreadable: number;
	readonly problems: readonly string[];
};

/** 命中字段的权重：别名与 ID 最高（人工专门为检索写的），正文其次。 */
const FIELD_WEIGHTS: Record<string, number> = { id: 3, aliases: 3, originalRequirement: 2, acceptanceCriteria: 2, problem: 2, symptom: 2, rootCause: 2, solution: 2, appliesWhen: 1, doesNotApplyWhen: 1 };

type ScanCandidate = { readonly family: "experience-card" | "feature-record"; readonly id: string; readonly text: readonly (readonly [string, string])[] };

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
 * 有界关键词/别名检索。
 *
 * 顺序固定：**扫描目录 → 有界读取 → 关键词匹配 → M1 决策（内含授权）→ 生成命中与片段**。
 * 因此"未授权"的候选不会出现在标题、片段、计数或排序里。
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

	const scanned = { experiences: 0, features: 0, recordsRead: 0, recordsSkipped: 0 };
	let unreadable = 0;
	let truncated = false;

	const pushProblem = (message: string): void => {
		if (problems.length < maxProblems) problems.push(message);
	};

	const candidates: MemoryCandidate[] = [];
	const matchedMeta = new Map<string, { candidate: ScanCandidate; score: number; fields: string[]; snippet: string | null; recordedStatus: ExperienceCard["status"] | "unknown"; sourceProjectId: string | null; declaredValidations: { kind: string; result: string }[]; revision: number }>();

	const scanFamily = async (family: "experience-card" | "feature-record"): Promise<void> => {
		const listing = await listRecords({ root: input.root, kind: family, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		if (family === "experience-card") scanned.experiences = listing.entries.length;
		else scanned.features = listing.entries.length;
		if (listing.truncated) {
			truncated = true;
			pushProblem(`${family} 目录扫描被预算截断（${listing.truncatedBy.join("、")}）：可能有未纳入的记录`);
		}
		for (const problem of listing.problems) pushProblem(`${family}: ${problem.code}（${problem.path}）`);

		for (const entry of listing.entries) {
			if (input.signal?.aborted) throw new ProjectServiceError("cancelled", "检索已取消");
			if (scanned.recordsRead >= limits.maxScanRecords) {
				scanned.recordsSkipped += 1;
				truncated = true;
				continue;
			}
			scanned.recordsRead += 1;
			try {
				if (family === "experience-card") {
					const read = await readRecord({ root: input.root, kind: "experience-card", id: entry.id, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
					const card = read.record;
					// **服务层的第一道授权闸门**：源项目必须显式列在可见范围里
					// （空数组 = 没有授权任何来源项目，不是"不限定"）。M1 的第二道判定在其后。
					if (!input.visibility.authorizedProjectIds.includes(card.sourceProjectId)) continue;
					if (input.filters?.statuses !== undefined && !input.filters.statuses.includes(card.status)) continue;
					const text = experienceText(card);
					const match = matchTerms(text, terms);
					if (!match.matched) continue;
					const candidate = projectV1ExperienceCard(card);
					candidates.push(candidate);
					matchedMeta.set(`${candidate.family}|${candidate.recordId}|${candidate.revision}`, {
						candidate: { family, id: card.id, text },
						score: match.score,
						fields: match.fields,
						snippet: match.snippet,
						recordedStatus: card.status,
						sourceProjectId: card.sourceProjectId,
						declaredValidations: card.validations.map((validation) => ({ kind: validation.kind, result: validation.result })),
						revision: read.record.revision,
					});
				} else {
					const read = await readRecord({ root: input.root, kind: "feature-record", id: entry.id, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
					const card = read.record;
					const text = featureText(card);
					const match = matchTerms(text, terms);
					if (!match.matched) continue;
					const candidate = featureCandidate(card, read.record.revision, input);
					candidates.push(candidate);
					matchedMeta.set(`${candidate.family}|${candidate.recordId}|${candidate.revision}`, {
						candidate: { family, id: card.id, text },
						score: match.score,
						fields: match.fields,
						snippet: match.snippet,
						recordedStatus: "unknown",
						sourceProjectId: null,
						declaredValidations: [],
						revision: read.record.revision,
					});
				}
			} catch (error) {
				// 不可读 ≠ 没命中：计数并给出有界诊断（不把读取失败说成"没有结果"）。
				unreadable += 1;
				pushProblem(`${family}/${entry.id}: ${isStorageError(error) ? error.code : "io-error"}`);
			}
		}
	};

	for (const family of families) await scanFamily(family);

	if (candidates.length === 0) {
		return { status: truncated ? "incomplete" : "ok", hits: [], decision: null, scanned, matchedButDropped: 0, unreadable, problems };
	}

	const authorization: MemoryAuthorization = {
		endpointAllowed: input.authorization.endpointAllowed,
		allowInternalGeneral: input.authorization.allowInternalGeneral,
		customers: [...(input.authorization.customers ?? [])],
	};
	const query: MemoryQuery = { intent, now: input.now ?? Date.now(), candidates, relations: [], authorization, target: targetContext(input) };
	const decision = decideMemory(query);

	// 命中只从 M1 的**可见条目**生成：未授权记录没有 ID、标题、片段，也不进计数。
	const hits: SearchHit[] = [];
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
		readonly declaredValidations: readonly { readonly kind: string; readonly result: string; readonly performedBy: string }[];
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
 * 与检索共用同一套授权与决策：先按记录族/ID/revision 读取当前记录，
 * 再走 M1 判定"这条经验在当前目标上算什么"，最后给出移植口径。
 */
export async function readExperienceReference(input: {
	readonly root: string;
	readonly experienceId: string;
	readonly targetProjectId: string | null;
	/** 目标客户：`customer` 级复用的经验只有在目标客户已授权时才可见（未知不等于公开）。 */
	readonly targetCustomerId?: string | null;
	readonly authorization: SearchInput["authorization"];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
}): Promise<ReferenceView> {
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	const limits = resolveKnowledgeLimits(input.limits);
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

	const portingReasons: string[] = ["跨项目/跨平台的结论只作**移植参考**：本批不执行移植、构建或刷板"];
	if (input.targetProjectId !== null && input.targetProjectId !== card.sourceProjectId) portingReasons.push(`来源项目（${card.sourceProjectId}）与目标项目不同：需要在目标项目重新验证`);
	const strongest = card.validations.some((validation) => validation.result === "passed" && (validation.kind === "board-boot" || validation.kind === "stress-loop" || validation.kind === "customer-acceptance"));
	if (!strongest) portingReasons.push("记录里没有目标板级验证（board-boot / stress-loop / customer-acceptance）：只能作为受限参考");
	if (card.appliesWhen.length === 0) portingReasons.push("没有声明适用条件：无法自动判断是否适用于当前平台");

	return {
		status: item.class === "excluded" || item.class === "history" ? "not-recommended" : "ok",
		recordId: experienceId,
		revision,
		reference: {
			problem: card.problem,
			symptom: card.symptom ?? null,
			rootCause: card.rootCause,
			solution: card.solution,
			appliesWhen: card.appliesWhen.slice(0, limits.maxListItems),
			doesNotApplyWhen: card.doesNotApplyWhen.slice(0, limits.maxListItems),
			sourceProjectId: card.sourceProjectId,
			featureId: card.featureId ?? null,
			declaredValidations: card.validations.slice(0, limits.maxListItems).map((validation) => ({ kind: validation.kind, result: validation.result, performedBy: validation.performedBy })),
			reuseScope: card.reuseScope,
		},
		recommendation: item.class,
		reasons: item.reasons,
		porting: { referenceOnly: true, needsPortingReview: true, reasons: portingReasons },
		problems: [],
	};
}

/** 供 CLI 一行提示：命中的推荐强度分布（**只统计可见条目**）。 */
export function describeSearch(result: SearchResult): string {
	const counts = new Map<string, number>();
	for (const hit of result.hits) counts.set(hit.recommendation, (counts.get(hit.recommendation) ?? 0) + 1);
	const summary = [...counts.entries()].map(([label, count]) => `${label} ${count}`).join("、") || "无命中";
	return `命中 ${result.hits.length}（${summary}）｜扫描 experience ${result.scanned.experiences} / feature ${result.scanned.features}、读取 ${result.scanned.recordsRead}${result.unreadable > 0 ? `、不可读 ${result.unreadable}` : ""}`;
}
