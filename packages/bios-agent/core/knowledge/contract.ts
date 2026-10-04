/**
 * BM-04 知识与经验服务的**公共骨架**：受控错误、资源预算与纯输入判定。
 *
 * 与 `core/projects/contract.ts` 的分工：那边管"项目档案与工作区"的预算，
 * 这边管"需求/经验正文与检索"的预算。两者共用同一个服务层错误类型
 * （`ProjectServiceError`：code + detail + cause），CLI 只按 `code` 分流。
 *
 * 四条纪律（对应 bm04_development_plan.md §3）：
 * 1. **原始文本只进不改**：人工写的需求/别名/根因/方案原样保存，
 *    检索用的规范化键是**派生**的，绝不回写覆盖原文；
 * 2. **托管字段不可绕过审核**：`status` / `reviewer` 只能由审核入口改，
 *    普通草稿写入不接受它们；
 * 3. **先授权后可见**：标题、片段、计数、排序都在授权过滤之后才形成；
 * 4. **一切有界**：正文长度、数组数量、条目数、实际读取字节、扫描条目、输出都有上限。
 */
import { isAbsolute } from "node:path";
import { assertKnowledgeId } from "../contracts/ids.ts";
import { invalidArgument, optionalAbsolutePath, optionalBoundedText, ProjectServiceError, requireAbsolutePath, requireBoundedText, toPosixRelative } from "../projects/contract.ts";

export { invalidArgument, notAuthorized, inconsistent, ProjectServiceError, requireAbsolutePath, optionalAbsolutePath, requireBoundedText, optionalBoundedText, toPosixRelative } from "../projects/contract.ts";

/** BM-04 的资源预算（默认值即上限；调用方只能收紧）。 */
export type KnowledgeServiceLimits = {
	/** 需求/问题/根因/方案正文的字符上限。 */
	maxBodyChars: number;
	/** 别名 / 不适用条件 / 验收条件 / 验证记录的数量上限。 */
	maxListItems: number;
	/** 单个短条目（别名、条件、验收标准）的字符上限。 */
	maxShortItemChars: number;
	/** 关联经验 ID 的数量上限。 */
	maxRelatedIds: number;
	/** 证据引用数量上限。 */
	maxEvidenceRefs: number;
	/** 检索关键词上限与单个词的字符上限。 */
	maxSearchTerms: number;
	/** 检索返回的候选条目上限。 */
	maxSearchResults: number;
	/** 检索时最多读取的记录条数（实际读取条数，不是目录条目数）。 */
	maxScanRecords: number;
	/** 审核理由 / 操作者标签的字符上限。 */
	maxReviewTextChars: number;
	/** 详情视图最多返回的关联条目数。 */
	maxDetailLinks: number;
};

export const DEFAULT_KNOWLEDGE_LIMITS: KnowledgeServiceLimits = {
	maxBodyChars: 8_000,
	maxListItems: 16,
	maxShortItemChars: 300,
	maxRelatedIds: 16,
	maxEvidenceRefs: 16,
	maxSearchTerms: 8,
	maxSearchResults: 20,
	maxScanRecords: 500,
	maxReviewTextChars: 500,
	maxDetailLinks: 32,
};

const LIMIT_KEYS = Object.keys(DEFAULT_KNOWLEDGE_LIMITS) as Array<keyof KnowledgeServiceLimits>;

/** 合并预算：未知键与非法值都报错（静默忽略一个拼错的限额最危险）。 */
export function resolveKnowledgeLimits(overrides?: Partial<KnowledgeServiceLimits>): KnowledgeServiceLimits {
	const merged = { ...DEFAULT_KNOWLEDGE_LIMITS };
	if (overrides === undefined) return merged;
	if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) throw invalidArgument("资源预算必须是对象");
	for (const key of Object.keys(overrides)) {
		if (!LIMIT_KEYS.includes(key as keyof KnowledgeServiceLimits)) throw invalidArgument(`未知的资源预算项：${key}`);
	}
	for (const key of LIMIT_KEYS) {
		const value = overrides[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalidArgument(`资源预算 ${key} 必须是正整数`);
		if (value > DEFAULT_KNOWLEDGE_LIMITS[key]) throw invalidArgument(`资源预算 ${key} 只能收紧（上限 ${DEFAULT_KNOWLEDGE_LIMITS[key]}）`);
		merged[key] = value;
	}
	return merged;
}

/** 知识 ID：形态校验与存储层同一口径（不接受空串、路径分隔符、`..`）。 */
export function requireKnowledgeId(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument(`${label} 不能为空`);
	try {
		return assertKnowledgeId(value, label);
	} catch (error) {
		throw invalidArgument(`${label} 不合法：${error instanceof Error ? error.message : String(error)}`);
	}
}

/** 正文：单行/多行都可以，但必须非空、有上界、不含 NUL 等控制字符。 */
export function requireBody(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") throw invalidArgument(`${label} 必须是字符串`);
	const text = value.replace(/\r\n/g, "\n").trim();
	if (text === "") throw invalidArgument(`${label} 不能为空`);
	if (text.length > maxChars) throw invalidArgument(`${label} 超过 ${maxChars} 字符上限`);
	// NUL 与控制字符（保留换行/制表）会让"原文"变成不可打印的东西：宁可拒绝。
	if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw invalidArgument(`${label} 不能包含控制字符`);
	return text;
}

/** 短条目（别名、条件、验收标准）：单行、非空、有上界。 */
export function requireShortItem(value: unknown, label: string, maxChars: number): string {
	const text = requireBody(value, label, maxChars);
	if (text.includes("\n")) throw invalidArgument(`${label} 必须是单行文本`);
	return text;
}

/** 字符串数组：数量与单项长度都有界，且**保持调用方给出的顺序**（原样保存）。 */
export function requireShortItems(value: unknown, label: string, limits: KnowledgeServiceLimits): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw invalidArgument(`${label} 必须是数组`);
	if (value.length > limits.maxListItems) throw invalidArgument(`${label} 超过 ${limits.maxListItems} 条上限`);
	const items: string[] = [];
	for (const entry of value) items.push(requireShortItem(entry, `${label} 的条目`, limits.maxShortItemChars));
	return items;
}

/** 知识 ID 数组：数量有界、形态合法、**不许重复**（重复 ID 会让"关联了几条"变成假的）。 */
export function requireKnowledgeIds(value: unknown, label: string, limits: KnowledgeServiceLimits, max: number): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw invalidArgument(`${label} 必须是数组`);
	if (value.length > max) throw invalidArgument(`${label} 超过 ${max} 条上限`);
	const ids: string[] = [];
	for (const entry of value) {
		const id = requireKnowledgeId(entry, `${label} 的 ID`);
		if (ids.includes(id)) throw invalidArgument(`${label} 出现重复 ID：${id}`);
		ids.push(id);
	}
	return ids;
}

/**
 * 字段的**确认程度**必须由调用方显式声明。
 *
 * 为什么不能从文本推断：`customer: "某客户"` 是一段自由文本，
 * 把它当成"已确认的客户身份"会让未验证的推断进入可复用结论（BM-04 §3 B1）。
 */
export type DeclaredFieldStatus = "candidate" | "confirmed";

export function requireDeclaredStatus(value: unknown, label: string): DeclaredFieldStatus {
	if (value === "candidate" || value === "confirmed") return value;
	throw invalidArgument(`${label} 必须显式声明为 candidate 或 confirmed（服务不从文本推断确认程度）`);
}

/** 检索用的**派生**规范化键：小写 + 折叠空白；只用于匹配，绝不回写原文。 */
export function normalizeForKey(text: string): string {
	return text
		.toLowerCase()
		.replace(/[\s\u3000]+/g, " ")
		.trim();
}

/** 查询词切分：按空白切分、去重、有小写化，且有数量与长度上限。 */
export function splitQueryTerms(value: unknown, limits: KnowledgeServiceLimits): string[] {
	if (typeof value !== "string") throw invalidArgument("查询必须是字符串");
	const normalized = normalizeForKey(value);
	if (normalized === "") throw invalidArgument("查询不能为空");
	const terms: string[] = [];
	for (const part of normalized.split(" ")) {
		if (part === "") continue;
		if (part.length > limits.maxShortItemChars) throw invalidArgument(`查询词超过 ${limits.maxShortItemChars} 字符上限`);
		if (!terms.includes(part)) terms.push(part);
		if (terms.length > limits.maxSearchTerms) throw invalidArgument(`查询词超过 ${limits.maxSearchTerms} 个上限`);
	}
	if (terms.length === 0) throw invalidArgument("查询不能为空");
	return terms;
}

/** 相对路径（供证据引用）：拒绝绝对路径与 `..`。 */
export function requireRelativePath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument(`${label} 不能为空`);
	if (isAbsolute(value)) throw invalidArgument(`${label} 只接受相对路径`);
	const normalized = toPosixRelative(value);
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw invalidArgument(`${label} 不得包含空段、'.' 或 '..'`);
	return normalized;
}

/** 一次知识写入的发布事实（与 BM-03 的项目写入同一形状，便于 CLI 统一报告）。 */
export type KnowledgeWriteFacts = {
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
};
