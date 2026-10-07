/**
 * AW-04：**本项目工作线索（working）的只读检索**。
 *
 * 与"已审核推荐"是**两种用途**（AW §7.1）：
 * - working 只读**目标工程的精确工作区**：本项目经验草稿 + 绑定目标任务的执行事实检查点；
 * - working 里的内容一律标注 `unverified`，**不能**进入 current 推荐块，也不能作为移植决定、
 *   客户要求或测试通过的依据；
 * - 授权过滤（项目/客户/需求）先于返回标题、摘要与计数；未授权来源连标题都不出现。
 *
 * 复用既有边界与预算：读取走 `readExperienceDetail`（内部已做授权与有界读取），
 * 检查点走 automation store（根内路径 + 有界读）。本模块不引入第二套检索通道。
 */
import { listRecords } from "../storage/records.ts";
import { readExperienceDetail } from "../knowledge/experiences.ts";
import { searchKnowledge } from "../knowledge/search.ts";
import { normalizeForKey } from "../knowledge/contract.ts";
import { resolveRetrievalPlan, type RetrievalLedger, type RetrievalPlan } from "./policy.ts";
import { readCheckpoint, readWorkspaceState } from "./store.ts";
import type { ExperienceCard } from "../contracts/records.ts";

/** 一条工作线索：**始终**带状态与来源，正文与标记一起输出。 */
export type WorkingLead = {
	/** `reviewed-experience` 只来自正式检索（已审核），其余两种来自 working（未验证）。 */
	readonly kind: "project-draft" | "task-checkpoint" | "reviewed-experience";
	readonly recordId: string;
	readonly revision: number;
	readonly title: string;
	/** 记录状态（draft / in-progress / interrupted / error / reviewed / verified）。 */
	readonly state: string;
	/**
	 * 证据强度：`unverified`（本项目草稿）/ `recorded-fact`（已发生的执行事实）/
	 * `reviewed`（已审核经验，可作结论依据）。
	 */
	readonly verification: "unverified" | "recorded-fact" | "reviewed";
	/** 采集时的代码基线摘要（有则给，不猜）。 */
	readonly baseline: string | null;
	readonly excerpt: string;
	readonly matchedFields: readonly string[];
	readonly score: number;
};

export type WorkingSearchResult = {
	/** ok=有结果；incomplete=预算受限；empty=确实没有；denied=未授权。 */
	readonly status: "ok" | "incomplete" | "empty" | "denied";
	readonly leads: readonly WorkingLead[];
	readonly scanned: { readonly cards: number; readonly checkpoints: number };
	readonly notes: readonly string[];
};

export type WorkingSearchInput = {
	readonly root: string;
	readonly projectId: string;
	readonly workspaceId: string;
	/** 目标任务；给定时才会读该任务的执行事实检查点。 */
	readonly taskId: string | null;
	readonly query: string;
	/** 授权集合（缺省即拒绝：不在集合内的项目一律不读）。 */
	readonly authorizedProjectIds: readonly string[];
	/**
	 * R4：**明确批准的客户范围**。
	 *
	 * 草稿若声明了客户范围，只有该客户被显式批准后才进入 working；
	 * 缺省（空数组）= 没有客户授权 ⇒ 客户范围草稿一律不返回正文。
	 */
	readonly approvedCustomers?: readonly string[];
	/** R4：显式授权的需求 ID；草稿若绑定需求，只有该需求被显式授权才返回。 */
	readonly allowedFeatureIds?: readonly string[];
	/** 端点是否允许把本项目资料交给当前模型（false 时直接拒绝，不读正文）。 */
	readonly endpointAllowed?: boolean;
	readonly plan?: Partial<RetrievalPlan>;
	/**
	 * R4（§9.4）：**与正式检索共享**的合并预算账本。
	 *
	 * 给了账本就只花"剩下"的额度（按调用顺序递减），并把实际用量与截断量记回去；
	 * 不给则退化为"本模块独占一份 plan"（单库/单用途调用，保持旧行为）。
	 */
	readonly ledger?: RetrievalLedger;
	readonly signal?: AbortSignal;
};

/** 读取预算：**所有**详情读取（草稿 + 检查点）共享同一个剩余额度。 */
type DetailBudget = { remaining: number };

const MAX_EXCERPT_CHARS = 320;

/**
 * 分词：只做小写 + 去空白，不引入第二套分词/向量依赖。
 *
 * R4：中文自然问句（"为什么USB端口只跑2.0速度"）整体没有空格，按空白切分只会得到一个长词，
 * 子串匹配必然落空。这里额外把 ASCII 片段与 CJK 二字组分开取，使"USB"/"端口"/"速度"都能命中。
 */
function terms(query: string): readonly string[] {
	const normalized = normalizeForKey(query);
	const found = new Set<string>();
	for (const match of normalized.matchAll(/[a-z0-9][a-z0-9._-]*/g)) found.add(match[0]);
	for (const run of normalized.match(/[\u4e00-\u9fff]+/g) ?? []) {
		if (run.length <= 2) found.add(run);
		else for (let index = 0; index + 2 <= run.length; index += 1) found.add(run.slice(index, index + 2));
	}
	return [...found].filter((term) => term.length >= 2).slice(0, 8);
}

/**
 * R4：正式检索的**放宽查询**（一次重试用）。
 *
 * 既有检索对多个查询词是"全部命中"语义，因此长问句容易 0 命中。
 * 这里只在**严格查询没有命中**时退化到单个最强词：优先最长的 ASCII 片段（USB/2.0/POST 等
 * 在 BIOS 语境下最有区分度），否则取第一个 CJK 二字组。
 */
export function relaxedQueryOf(query: string): string | null {
	const normalized = normalizeForKey(query);
	const ascii = [...normalized.matchAll(/[a-z0-9][a-z0-9._-]*/g)].map((match) => match[0]).sort((left, right) => right.length - left.length);
	if (ascii.length > 0 && (ascii[0]?.length ?? 0) >= 2) return ascii[0] as string;
	const runs = normalized.match(/[\u4e00-\u9fff]+/g) ?? [];
	for (const run of runs) {
		if (run.length === 2) return run;
		if (run.length > 2) return run.slice(0, 2);
	}
	return null;
}

function score(text: string, needles: readonly string[]): { score: number; matched: string[] } {
	const haystack = normalizeForKey(text);
	const matched: string[] = [];
	let total = 0;
	for (const needle of needles) {
		if (needle === "" || !haystack.includes(needle)) continue;
		matched.push(needle);
		total += needle.length >= 4 ? 3 : 2;
	}
	return { score: total, matched };
}

function excerpt(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= MAX_EXCERPT_CHARS ? flat : `${flat.slice(0, MAX_EXCERPT_CHARS)}…`;
}

/** 草稿卡的内容分：问题/症状/根因/解法/适用条件都参与，字段命中可解释。 */
function scoreCard(card: ExperienceCard, needles: readonly string[]): { score: number; matched: string[] } {
	const fields: Array<[string, string]> = [
		["problem", card.problem],
		["symptom", card.symptom ?? ""],
		["rootCause", card.rootCause],
		["solution", card.solution],
		["appliesWhen", card.appliesWhen.join(" ")],
		["doesNotApplyWhen", card.doesNotApplyWhen.join(" ")],
	];
	const matched: string[] = [];
	let total = 0;
	for (const [name, value] of fields) {
		if (value.trim() === "") continue;
		const result = score(value, needles);
		if (result.score === 0) continue;
		total += result.score;
		matched.push(name);
	}
	return { score: total, matched };
}

/**
 * 读取本项目未验证线索。
 *
 * 只保留 `status === "draft"`：`reviewed/verified` 属于"已审核推荐"用途（走既有检索），
 * `deprecated` 与任何撤回状态一律不得借 working 重新成为当前事实。
 */
/**
 * R4：草稿的**客户/需求范围**判定。
 *
 * 为什么需要：项目授权只说明"可以读这个项目的记录"，不等于"可以读这条客户范围的内容"。
 * 规则与 M1 一致——声明的客户必须被**显式**批准，绑定的需求必须被**显式**授权；
 * 未知客户不推导公开。
 */
function scopeAllowed(card: ExperienceCard, input: WorkingSearchInput): { readonly allowed: boolean; readonly reason: string | null } {
	const customers = card.reuseScope?.customers ?? [];
	const approvedCustomers = input.approvedCustomers ?? [];
	const missingCustomer = customers.filter((customer) => !approvedCustomers.includes(customer));
	if (missingCustomer.length > 0) return { allowed: false, reason: "客户范围未获显式批准" };
	if (card.featureId !== undefined && card.featureId !== null && !(input.allowedFeatureIds ?? []).includes(card.featureId)) return { allowed: false, reason: "绑定需求未获显式授权" };
	return { allowed: true, reason: null };
}

async function draftLeads(input: WorkingSearchInput, needles: readonly string[], limit: number, budget: DetailBudget): Promise<{ leads: WorkingLead[]; scanned: number; incomplete: boolean }> {
	const listed = await listDraftCandidates(input);
	const leads: WorkingLead[] = [];
	let scanned = 0;
	let skippedByScope = 0;
	for (const id of listed.ids) {
		if (input.signal?.aborted) throw Object.assign(new Error("working 检索已取消"), { name: "AbortError" });
		if (leads.length >= limit || budget.remaining <= 0) break;
		budget.remaining -= 1;
		let detail: Awaited<ReturnType<typeof readExperienceDetail>>;
		try {
			detail = await readExperienceDetail({ root: input.root, experienceId: id, authorizedProjectIds: input.authorizedProjectIds, signal: input.signal });
		} catch (error) {
			if (input.signal?.aborted) throw error;
			continue;
		}
		if (detail.status !== "ok" || detail.card === null) continue;
		const card = detail.card;
		scanned += 1;
		// 精确工作区 + 只读 draft：不满足任一条件的记录不进入 working。
		if (card.status !== "draft" || card.sourceProjectId !== input.projectId) continue;
		if (!card.evidence.some((ref) => ref.workspaceId === input.workspaceId)) continue;
		// 先过滤客户/需求范围，再参与打分与返回（未授权连标题都不出现）。
		if (!scopeAllowed(card, input).allowed) {
			skippedByScope += 1;
			continue;
		}
		const scored = scoreCard(card, needles);
		if (scored.score === 0) continue;
		leads.push({
			kind: "project-draft",
			recordId: card.id,
			revision: card.revision,
			title: card.problem.slice(0, 160),
			state: card.status,
			verification: "unverified",
			baseline: card.evidence.find((ref) => ref.commit)?.commit ?? null,
			excerpt: excerpt([card.rootCause, card.solution].filter((part) => part.trim() !== "").join(" / ")),
			matchedFields: scored.matched,
			score: scored.score,
		});
	}
	const incomplete = listed.incomplete || budget.remaining <= 0 || skippedByScope > 0;
	return { leads, scanned, incomplete };
}

/** 列出候选 ID（只做目录层过滤，不读正文；正文读取在上层按预算逐条进行）。 */
async function listDraftCandidates(input: WorkingSearchInput): Promise<{ ids: readonly string[]; incomplete: boolean }> {
	const listed = await listRecords({ root: input.root, kind: "experience-card", signal: input.signal, limits: { maxListEntries: 60, maxScanEntries: 300 } });
	return { ids: listed.entries.map((entry) => entry.id), incomplete: listed.truncated || listed.problems.length > 0 };
}

/** 读取绑定目标任务的执行事实检查点（只在给定 taskId 时）。 */
async function checkpointLeads(input: WorkingSearchInput, needles: readonly string[], limit: number, budget: DetailBudget): Promise<{ leads: WorkingLead[]; scanned: number; incomplete: boolean }> {
	if (input.taskId === null) return { leads: [], scanned: 0, incomplete: false };
	const state = await readWorkspaceState({ root: input.root, projectId: input.projectId, workspaceId: input.workspaceId, signal: input.signal });
	if (state.status !== "ok") return { leads: [], scanned: 0, incomplete: state.status !== "missing" };
	const matching = state.value.checkpoints.filter((ref) => ref.taskId === input.taskId);
	const refs = matching.slice(0, limit);
	const leads: WorkingLead[] = [];
	let scanned = 0;
	for (const ref of refs) {
		if (input.signal?.aborted) throw Object.assign(new Error("working 检索已取消"), { name: "AbortError" });
		if (budget.remaining <= 0) break;
		budget.remaining -= 1;
		const read = await readCheckpoint({ root: input.root, projectId: input.projectId, workspaceId: input.workspaceId, runId: ref.runId, signal: input.signal });
		if (read.status !== "ok") continue;
		scanned += 1;
		const checkpoint = read.value;
		const summary = [`文件：${checkpoint.changedFiles.slice(0, 6).join(", ") || "无"}`, `工具：${[...new Set(checkpoint.executed.map((fact) => fact.tool))].slice(0, 6).join(", ") || "无"}`, `结果：${checkpoint.outcome}`].join("；");
		const scored = score(`${checkpoint.changedFiles.join(" ")} ${checkpoint.executed.map((fact) => fact.tool).join(" ")}`, needles);
		leads.push({
			kind: "task-checkpoint",
			recordId: checkpoint.runId,
			revision: checkpoint.version,
			title: `任务 ${input.taskId} 的执行事实检查点`,
			state: checkpoint.outcome,
			verification: "recorded-fact",
			baseline: checkpoint.baseline.commit === null ? checkpoint.baseline.branch : `${checkpoint.baseline.branch ?? "非 Git"}@${checkpoint.baseline.commit.slice(0, 12)}`,
			excerpt: excerpt(summary),
			matchedFields: scored.matched,
			// 检查点是"已发生的执行事实"：任务绑定的线索优先于纯关键词命中。
			score: scored.score + 5,
		});
	}
	return { leads, scanned, incomplete: refs.length < matching.length || budget.remaining <= 0 };
}

/**
 * 工作线索检索入口。
 *
 * 顺序：授权 → 精确工作区/目标任务 → 只读 draft/已发生事实 → 关键词打分 → 预算截断。
 * 未授权（项目不在集合内）直接返回 `denied`，不泄漏标题或计数。
 */
export async function searchWorkingMemory(input: WorkingSearchInput): Promise<WorkingSearchResult> {
	if (!input.authorizedProjectIds.includes(input.projectId)) {
		return { status: "denied", leads: [], scanned: { cards: 0, checkpoints: 0 }, notes: ["该项目不在授权集合内：不返回任何工作线索"] };
	}
	// 端点不明确允许时连正文都不读（与既有外发策略同一口径）。
	if (input.endpointAllowed === false) {
		return { status: "denied", leads: [], scanned: { cards: 0, checkpoints: 0 }, notes: ["当前端点策略不允许把项目资料交给模型：未读取任何工作线索"] };
	}
	const plan = resolveRetrievalPlan({ maxLeads: input.plan?.maxLeads ?? undefined, maxProjectLeads: input.plan?.maxProjectLeads ?? undefined, maxDetailReads: input.plan?.maxDetailReads ?? undefined });
	const needles = terms(input.query);
	const notes: string[] = [];
	// R4（§9.4）：有共享账本时只花"剩下"的额度——正式检索已经花掉的部分不再重复发给 working。
	const remaining = input.ledger?.remaining();
	const leadQuota = remaining === undefined ? plan.maxLeads : Math.min(plan.maxLeads, remaining.leads);
	const detailQuota = remaining === undefined ? plan.maxDetailReads : Math.min(plan.maxDetailReads, remaining.detailReads);
	// 合并预算已用尽：不去读记录，也**不能**把"没轮到读"说成"本项目没有相关线索"。
	if (leadQuota <= 0) {
		return { status: "incomplete", leads: [], scanned: { cards: 0, checkpoints: 0 }, notes: ["合并检索预算（正式与 working 共享）已用尽：本次未取回本项目线索，这不等于没有相关记录"] };
	}
	// R4：草稿与检查点**共享**同一份详情读取预算，避免"60 条草稿逐条读"。
	const budget: DetailBudget = { remaining: detailQuota };
	const drafts = await draftLeads(input, needles, Math.min(plan.maxProjectLeads, leadQuota), budget);
	const checkpoints = await checkpointLeads(input, needles, detailQuota, budget);
	const all = [...checkpoints.leads, ...drafts.leads].sort((a, b) => b.score - a.score);
	const merged = all.slice(0, leadQuota);
	input.ledger?.charge({ leads: merged.length, detailReads: detailQuota - budget.remaining, leadsTruncated: all.length - merged.length, detailReadsTruncated: 0 });
	const incomplete = drafts.incomplete || checkpoints.incomplete || all.length > merged.length;
	if (merged.length > 0) notes.push("以下为本项目未验证线索（draft/执行事实），不能当作已审核结论、客户要求或测试通过依据");
	if (all.length > merged.length) notes.push(`本次因**合并检索预算**（正式与 working 共享）未取回的线索：${all.length - merged.length} 条`);
	if (incomplete) notes.push("本次读取命中预算或存在不可读记录：结果可能不完整");
	return { status: merged.length > 0 ? (incomplete ? "incomplete" : "ok") : incomplete ? "incomplete" : "empty", leads: merged, scanned: { cards: drafts.scanned, checkpoints: checkpoints.scanned }, notes };
}

/* ------------------------------------------------- R4：正式（已审核）知识检索 */

export type ReviewedRetrievalInput = {
	readonly root: string;
	readonly query: string;
	/** 目标项目（M1 用它做"同项目/跨项目参考"判定）。 */
	readonly projectId: string;
	readonly workspaceId: string;
	/**
	 * §7.4 R4：**目标客户**（只允许传项目档案里人工确认过的客户；`null` = 未知，按未授权处理）。
	 *
	 * 客户级复用的经验只有在目标客户已知且已批准时才可见；旧实现恒传 `null`，
	 * 使"已批准客户的跨平台正式经验"永远检索不到。
	 */
	readonly targetCustomerId?: string | null;
	readonly authorizedProjectIds: readonly string[];
	readonly allowedFeatureIds: readonly string[];
	readonly approvedCustomers: readonly string[];
	readonly endpointAllowed: boolean;
	readonly plan?: Partial<RetrievalPlan>;
	/** R4（§9.4）：与 working 共享的合并预算账本（先正式、后 working 的顺序消费）。 */
	readonly ledger?: RetrievalLedger;
	readonly signal?: AbortSignal;
};

/**
 * R4：正式经验的自动检索（复用既有 `searchKnowledge`，不新建检索通道）。
 *
 * 与 working 的差别：这里只取**已审核**状态、只作 `current` 推荐；授权、时态、复用范围、
 * 需求边界全部由既有 M1 决策给出，扩展只负责把结果渲染进有界上下文。
 */
export async function searchReviewedKnowledge(input: ReviewedRetrievalInput): Promise<WorkingSearchResult> {
	const plan = resolveRetrievalPlan({ maxLeads: input.plan?.maxLeads ?? undefined, maxProjectLeads: input.plan?.maxProjectLeads ?? undefined, maxDetailReads: input.plan?.maxDetailReads ?? undefined });
	if (input.authorizedProjectIds.length === 0) return { status: "denied", leads: [], scanned: { cards: 0, checkpoints: 0 }, notes: ["没有授权项目：不检索正式知识"] };
	if (!input.endpointAllowed) return { status: "denied", leads: [], scanned: { cards: 0, checkpoints: 0 }, notes: ["当前端点策略不允许外发：不检索正式知识"] };
	const run = (query: string) =>
		searchKnowledge({
			root: input.root,
			query,
			visibility: { authorizedProjectIds: input.authorizedProjectIds, allowedFeatureIds: input.allowedFeatureIds, approvedCustomers: input.approvedCustomers },
			target: { projectId: input.projectId, workspaceId: input.workspaceId, customerId: input.targetCustomerId ?? null },
			authorization: { endpointAllowed: true, allowInternalGeneral: false, customers: input.approvedCustomers, authorizedProjectIds: input.authorizedProjectIds },
			intent: "current",
			filters: { recordFamilies: ["experience-card"], statuses: ["reviewed", "verified"] },
			// 命中上限由本模块按 `plan.maxLeads` 截断；这里只收紧既有扫描预算。
			limits: { maxScanRecords: plan.maxDetailReads * 8 },
			signal: input.signal,
		});
	let result = await run(input.query);
	// R4：中文自然问句（无空格）在"全部词命中"语义下会落空；严格查询没命中时退化到单个最强词，**只重试一次**。
	if (result.hits.length === 0) {
		const relaxed = relaxedQueryOf(input.query);
		if (relaxed !== null && relaxed !== input.query.trim().toLowerCase()) result = await run(relaxed);
	}
	// R4（§9.4）：正式检索**先**消费共享预算；剩余额度才轮到 working。
	const quota = input.ledger === undefined ? plan.maxLeads : Math.min(plan.maxLeads, input.ledger.remaining().leads);
	const taken = result.hits.slice(0, quota);
	input.ledger?.charge({ leads: taken.length, detailReads: 0, leadsTruncated: result.hits.length - taken.length + Math.max(0, result.matchedButDropped), detailReadsTruncated: 0 });
	const leads: WorkingLead[] = taken.map((hit) => ({
		kind: "reviewed-experience" as const,
		recordId: hit.recordId,
		revision: hit.revision,
		title: (hit.title ?? hit.recordId).slice(0, 160),
		state: hit.recordedStatus,
		verification: "reviewed" as const,
		baseline: hit.sourceProjectId === input.projectId ? "同项目" : "跨项目参考",
		excerpt: (hit.snippet ?? "").slice(0, 320),
		matchedFields: hit.matchedFields,
		score: hit.score,
	}));
	const notes: string[] = [];
	if (leads.length > 0) notes.push("以下为已审核经验（`current` 推荐），跨项目条目只能作**移植参考**");
	const truncated = result.hits.length - taken.length + Math.max(0, result.matchedButDropped);
	if (truncated > 0) notes.push(`正式检索因预算未取回的候选：${truncated} 条（正式与 working 共享同一份合并预算）`);
	if (result.status === "incomplete" || result.matchedButDropped > 0) notes.push("正式检索命中预算：结果可能不完整");
	return { status: leads.length > 0 ? (result.status === "ok" ? "ok" : "incomplete") : result.status === "incomplete" ? "incomplete" : "empty", leads, scanned: { cards: result.scanned.experiences, checkpoints: 0 }, notes };
}

/** 渲染正式检索结果（与 working 分开输出，避免未验证 draft 冒充已审核结论）。 */
export function renderReviewedLeads(result: WorkingSearchResult): string {
	if (result.leads.length === 0) {
		if (result.status === "denied") return "已审核经验：未授权/未允许外发，未检索。";
		if (result.status === "incomplete") return "已审核经验：检索不完整（预算或不可读记录），不声称没有历史经验。";
		return "已审核经验：本次已查无匹配。";
	}
	const lines = result.leads.map((lead) => `- [已审核 ${lead.state}] ${lead.title}（${lead.recordId}@${lead.revision}${lead.baseline === null ? "" : `，${lead.baseline}`}）：${lead.excerpt}`);
	return ["已审核经验线索（可作结论依据；跨项目条目只作移植参考）：", ...lines].join("\n");
}

/** 把工作线索渲染成有界文本块（供上下文注入；来源/状态随正文一起给出）。 */
export function renderWorkingLeads(result: WorkingSearchResult): string {
	if (result.leads.length === 0) {
		if (result.status === "denied") return "本项目工作线索：未授权，未读取。";
		if (result.status === "incomplete") return "本项目工作线索：读取不完整（预算或不可读记录），不声称没有线索。";
		return "本项目工作线索：已查无匹配。";
	}
	const lines = result.leads.map((lead) => `- [${lead.verification === "unverified" ? "未验证 draft" : "执行事实"}] ${lead.title}（${lead.recordId}@${lead.revision}，状态 ${lead.state}${lead.baseline === null ? "" : `，基线 ${lead.baseline}`}）：${lead.excerpt}`);
	return [`本项目工作线索（未验证，仅供假设，不作为最终结论）：`, ...lines].join("\n");
}
