/**
 * 记忆决策**管道**（BM-M1）：把候选按固定顺序判定成可用/参考/需复核/冲突/历史/排除。
 *
 * 顺序（设计 §7 + R27-1～3）：
 * 1. **浅层闸门**（对象/枚举/时间/数组形态）→ 2. **数量闸门**（不访问任何元素）→
 * 3. **有界嵌套校验**（枚举/布尔/null/时间/数组长度）→ 4. 授权（未授权完全不可见）→
 * 5. 记录身份上的 revision 淘汰 → 6. 记录族/字段级当前资格 → 7. 范围与生效条件 →
 * 8. 关系两端复验与多边共同判定 → 9. 当前事实之间的冲突 → 10. 确定性排序与精确输出预算。
 *
 * 四条纪律：
 * - **未授权候选完全不出现在结果里**（不返回 ID、标题，也不进任何计数）；
 * - **revision 与冲突都建立在"已授权可见集合"上**：未授权的高版本不能暗中淘汰可见的低版本；
 * - 冲突不按时间戳选赢者，且只有**具备当前资格**的事实才参加当前冲突判定；
 * - 预算不足如实报告 `incomplete`，不把"没读到矛盾"当成"没有矛盾"，也不为"给个解释"保留超限条目。
 */
import { Buffer } from "node:buffer";
import {
	MEMORY_RECORD_FAMILIES,
	MemoryInputError,
	candidateFactKey,
	candidateRef,
	recordRefKey,
	resolveMemoryLimits,
	type MemoryCandidate,
	type MemoryDecision,
	type MemoryDecisionClass,
	type MemoryDecisionResult,
	type MemoryLimits,
	type MemoryQuery,
	type MemoryReasonCode,
	type MemoryRecordRef,
	type MemoryRelation,
} from "./contract.ts";
import { authorizeCandidate, eligibilityVerdict, evaluateRelationStates, isCurrentBlocker, scopeVerdict, temporalVerdict, verificationVerdict, type DeclarerState } from "./policy.ts";

/** 分类优先级（越靠前越"强"）；用于确定性排序与"多条原因取最严"的唯一口径。 */
const CLASS_RANK: readonly MemoryDecisionClass[] = ["current", "reference", "needs-review", "conflict", "history", "excluded"];

const STATUS_VALUES = ["draft", "reviewed", "verified", "deprecated", "unknown"] as const;
const AUTHORITY_VALUES = ["authoritative-read", "unverified", "unreadable"] as const;
const REUSE_LEVEL_VALUES = ["current-project", "customer", "internal-general"] as const;
const FIELD_STATUS_VALUES = ["unknown", "candidate", "confirmed"] as const;
const EVIDENCE_VALIDITY_VALUES = ["active", "stale", "unavailable"] as const;
const VALIDATION_KIND_VALUES = ["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"] as const;
const VALIDATION_RESULT_VALUES = ["passed", "failed", "inconclusive"] as const;
const RELATION_TYPE_VALUES = ["supersedes", "retracts"] as const;

/** 一条候选的中间判定（原因集合要可变：多候选冲突与关系判定都会追加原因）。 */
type Assessment = {
	readonly candidate: MemoryCandidate;
	/** `excluded` 表示"预先判定不适用"（如范围不匹配），不再按原因码重算分类。 */
	readonly forced: MemoryDecisionClass | null;
	readonly reasons: MemoryReasonCode[];
	readonly reasonSet: Set<MemoryReasonCode>;
	readonly verification: MemoryDecision["verification"];
};

export function decideMemory(query: MemoryQuery): MemoryDecisionResult {
	assertQueryInput(query);
	const limits = resolveMemoryLimits(query.limits);

	// **数量闸门先于任何逐项访问**：超限时不读元素字段（调用方用 getter 也观察不到访问）。
	if (query.candidates.length > limits.maxCandidates || query.relations.length > limits.maxRelations) {
		return { intent: query.intent, status: "incomplete", items: [], dropped: 0, limits };
	}

	assertCandidateShapes(query.candidates, limits);
	assertRelationShapes(query.relations, limits);

	// ---- 授权：未授权候选在此被完全丢弃（不留 ID/标题/计数痕迹）----
	const authorized: MemoryCandidate[] = [];
	const baseReasons = new Map<string, MemoryReasonCode[]>();
	/** 记录身份 → 承载它的事实条目（一条记录可以有多个字段事实）。 */
	const byRef = new Map<string, MemoryCandidate[]>();
	for (const candidate of query.candidates) {
		const verdict = authorizeCandidate(candidate, query.target, query.authorization);
		if (!verdict.allowed) continue;
		authorized.push(candidate);
		const refKey = recordRefKey(candidateRef(candidate));
		const list = byRef.get(refKey);
		if (list === undefined) byRef.set(refKey, [candidate]);
		else list.push(candidate);
		baseReasons.set(candidateFactKey(candidate), [...verdict.reasons]);
	}

	// ---- 记录身份（族 + ID）上的版本集合：只在已授权集合上计算 ----
	const highestRevision = new Map<string, number>();
	const highestUnreadable = new Set<string>();
	for (const candidate of authorized) {
		const recordKey = `${candidate.family}\u0000${candidate.recordId}`;
		const seen = highestRevision.get(recordKey);
		if (seen === undefined || candidate.revision > seen) {
			highestRevision.set(recordKey, candidate.revision);
			if (candidate.authority === "unreadable") highestUnreadable.add(recordKey);
			else highestUnreadable.delete(recordKey);
		} else if (candidate.revision === seen && candidate.authority === "unreadable") {
			highestUnreadable.add(recordKey);
		}
	}

	// ---- 第一遍：每条候选的基础判定（关系之前的全部信号）----
	const verificationViews = new Map<string, MemoryDecision["verification"]>();
	for (const candidate of authorized) {
		const key = candidateFactKey(candidate);
		const reasons = baseReasons.get(key) ?? [];
		const recordKey = `${candidate.family}\u0000${candidate.recordId}`;
		const highest = highestRevision.get(recordKey) ?? candidate.revision;
		if (candidate.revision < highest) {
			reasons.push("older-revision");
			// 可授权的最高版本不可读时：旧版本**不得**因此复活成当前结论（R27-1）。
			if (highestUnreadable.has(recordKey)) reasons.push("higher-revision-unreadable");
		}
		reasons.push(...eligibilityVerdict(candidate));

		const scope = scopeVerdict(candidate, query.target);
		if (!scope.applicable) {
			const combined = unique([...reasons, ...scope.reasons]);
			baseReasons.set(key, combined);
			verificationViews.set(key, { status: "none", strongestPassed: null });
			continue;
		}
		reasons.push(...scope.reasons);
		reasons.push(...temporalVerdict(candidate.time, query.now).reasons);

		const verification = verificationVerdict(candidate, query.target);
		reasons.push(...verification.reasons);
		verificationViews.set(key, verification.view);

		// v1 **知识本体**（经验卡 / 需求）形态：既没有生效区间、也没有验证依赖快照
		// ⇒ 说不清"什么时候适用、依赖哪份代码"，因此不能作为当前已验证事实，只作参考（设计 §8）。
		// 限定在这两族：档案字段/任务状态表达的不是"某个时刻适用的经验"，
		// 对它们套用这条会把"已人工确认的板名"降级成参考（BM-03 消费视图需要它保持可用）。
		if ((candidate.family === "experience-card" || candidate.family === "feature-record") && candidate.time.effectiveFrom === null && candidate.time.effectiveTo === null && candidate.dependencySnapshot === null) {
			reasons.push("legacy-unspecified");
		}

		if (candidate.derivedFromSummaryOf !== null) reasons.push("summary-derived");
		if (candidate.authority === "unreadable") reasons.push("authority-unreadable");
		else if (candidate.authority === "unverified") reasons.push("authority-unverified");

		baseReasons.set(key, unique(reasons));
	}

	// ---- 第二遍：关系判定（**全图**求解：授权先于关系、分叉与环都保留矛盾）----
	//
	// **"关系之外"的信号先做一次快照**：否则 A 的关系结论会改变 B 的声明方可信度。
	// 但这张快照只能证明"声明方在关系之前不是明显无效"，**证明不了它在关系之后仍然有效**——
	// 声明方自己可能被别的关系撤回（R28-3）。因此真正的求解交给 `evaluateRelationStates`
	// 的依赖序图判定：那里的 `blocked` 只是"基底原因"，嵌套状态由拓扑序接续判断。
	const preRelationReasons = new Map(baseReasons);
	const inputRefKeys = new Set(query.candidates.map((candidate) => recordRefKey(candidateRef(candidate))));
	const declarerStateOf = (ref: MemoryRecordRef): DeclarerState => {
		const refKey = recordRefKey(ref);
		// 输入里根本没有这条记录 ⇒ 缺源（不能当成"没有关系"）。
		if (!inputRefKeys.has(refKey)) return "absent";
		const sources = byRef.get(refKey);
		// 给了材料但不在已授权可见集合里 ⇒ 整条边被忽略：隐藏来源不能改变可见事实。
		if (sources === undefined || sources.length === 0) return "unauthorized";
		// 记录身份承载的**每个**事实都必须可读且当期有效，才算一条可用断言。
		if (sources.some((source) => source.authority !== "authoritative-read")) return "unreadable";
		const blocked = sources.some((source) => {
			const reasons = preRelationReasons.get(candidateFactKey(source)) ?? [];
			return reasons.some((reason) => reason === "field-unconfirmed" || isCurrentBlocker(reason));
		});
		return blocked ? "blocked" : "readable";
	};

	const evaluation = evaluateRelationStates({
		relations: query.relations,
		declarerStateOf,
		targetContext: query.target,
		maxChain: limits.maxRelationChain,
		maxNodes: limits.maxRelationNodes,
	});
	// 关系图触顶（节点预算）意味着"有些边没有被求解"：整体必须如实报不完整。
	let relationUncertain = evaluation.truncated;
	const relationReasons = new Map<string, MemoryReasonCode[]>();
	for (const candidate of authorized) {
		const key = candidateFactKey(candidate);
		const reasons = preRelationReasons.get(key);
		if (reasons === undefined) continue;
		if (reasons.includes("scope-mismatch")) continue; // 已判定不适用：关系不改变结论
		const outcome = evaluation.outcomes.get(recordRefKey(candidateRef(candidate)));
		if (outcome === undefined || outcome.state === "none") continue;
		relationReasons.set(key, [...outcome.reasons]);
		if (outcome.uncertain) relationUncertain = true;
	}
	for (const [key, reasons] of relationReasons) {
		const existing = baseReasons.get(key);
		if (existing === undefined) continue;
		baseReasons.set(key, unique([...existing, ...reasons]));
	}

	// ---- 组装判定，并在**具备当前资格**的事实之间判定冲突 ----
	const assessments: Assessment[] = authorized.map((candidate) => {
		const key = candidateFactKey(candidate);
		const reasons = baseReasons.get(key) ?? [];
		const forced: MemoryDecisionClass | null = reasons.includes("scope-mismatch") ? "excluded" : null;
		return { candidate, forced, reasons, reasonSet: new Set(reasons), verification: verificationViews.get(key) ?? { status: "none", strongestPassed: null } };
	});

	applyFactKeyConflicts(assessments);

	const items = assessments.map((assessment) => finalize(assessment, query, limits)).sort(compareDecisions);
	const { kept, dropped, used } = applyOutputBudget(items, limits);

	return {
		intent: query.intent,
		status: dropped > 0 || used > limits.maxOutputBytes || relationUncertain ? "incomplete" : "ok",
		items: kept,
		dropped,
		limits,
	};
}

/**
 * 事实键冲突：只有**具备当前资格**、**范围重叠**且**值不同**的事实才构成当前矛盾。
 *
 * 三条从 R27-1 来的纪律：
 * - 已被 revision 淘汰、未审核、未生效/已过期、不可读的事实**不参加**当前冲突判定，
 *   所以"未来版本"和"旧版本"不会让当前值虚假冲突；
 * - `field-unconfirmed`（新检测候选 / 未确认字段）**要参加**：它与人工确认值的差异正是要暴露的待确认差异；
 * - 人工 `confirmed` 值不被新检测候选覆盖：两者都保留并标 `needs-confirmation`。
 */
function applyFactKeyConflicts(assessments: readonly Assessment[]): void {
	const groups = new Map<string, Assessment[]>();
	for (const assessment of assessments) {
		const key = assessment.candidate.factKey;
		if (key === null || assessment.forced !== null) continue;
		if (assessment.reasons.some((reason) => isCurrentBlocker(reason))) continue;
		const bucket = groups.get(key);
		if (bucket === undefined) groups.set(key, [assessment]);
		else bucket.push(assessment);
	}
	for (const bucket of groups.values()) {
		for (let left = 0; left < bucket.length; left += 1) {
			for (let right = left + 1; right < bucket.length; right += 1) {
				const a = bucket[left];
				const b = bucket[right];
				if (a === undefined || b === undefined) continue;
				if (a.candidate.value === b.candidate.value) continue;
				if (!scopesOverlap(a.candidate, b.candidate)) continue;
				if (isFactConfirmed(a.candidate) !== isFactConfirmed(b.candidate)) {
					// 人工确认值**不被覆盖**：两者都保留，并把差异交人工确认（不挑一条继续用）。
					addReason(a, "needs-confirmation");
					addReason(b, "needs-confirmation");
					continue;
				}
				addReason(a, "conflict");
				addReason(b, "conflict");
			}
		}
	}
}

function addReason(assessment: Assessment, reason: MemoryReasonCode): void {
	if (assessment.reasonSet.has(reason)) return;
	assessment.reasonSet.add(reason);
	assessment.reasons.push(reason);
}

/** 两条事实的范围重叠 = 双方都声明的维度取值相同（单边未声明不算重叠证据）。 */
function scopesOverlap(left: MemoryCandidate, right: MemoryCandidate): boolean {
	const dimensions = ["projectId", "workspaceId", "customerId", "boardName", "boardRevision", "buildTarget"] as const;
	let shared = false;
	for (const dimension of dimensions) {
		const a = left.scope[dimension];
		const b = right.scope[dimension];
		if (a === null || b === null) continue;
		if (a !== b) return false;
		shared = true;
	}
	return shared;
}

/** `confirmedFields` 里以该候选的 `factKey` 命名且状态为 `confirmed` 的条目 = 人工确认值。 */
function isFactConfirmed(candidate: MemoryCandidate): boolean {
	if (candidate.factKey === null) return false;
	return candidate.confirmedFields.some((field) => field.field === candidate.factKey && field.status === "confirmed");
}

/** 汇总原因 → 唯一分类（"取最严"，不把多个信号揉成一个置信度）。 */
function finalize(assessment: Assessment, query: MemoryQuery, limits: MemoryLimits): MemoryDecision {
	const candidate = assessment.candidate;
	const has = (reason: MemoryReasonCode): boolean => assessment.reasonSet.has(reason);
	const reasons: MemoryReasonCode[] = [...assessment.reasons];
	if (candidate.status === "deprecated") reasons.push("deprecated");

	let klass: MemoryDecisionClass;
	if (assessment.forced === "excluded") {
		klass = "excluded";
	} else if (query.intent === "history") {
		klass = "history";
		reasons.push("history-record");
	} else if (candidate.status === "deprecated" || has("superseded") || has("retracted") || has("summary-derived") || has("older-revision") || has("higher-revision-unreadable")) {
		klass = "excluded";
	} else if (has("conflict")) {
		klass = "conflict";
	} else if (
		has("needs-confirmation") ||
		has("not-reviewed") ||
		has("field-unconfirmed") ||
		has("verification-drift") ||
		has("evidence-unavailable") ||
		has("authority-unreadable") ||
		has("scope-unknown") ||
		has("unresolved-relation") ||
		has("relation-not-effective") ||
		has("relation-ambiguous") ||
		has("relation-chain-truncated") ||
		has("not-yet-effective") ||
		has("expired")
	) {
		klass = "needs-review";
	} else if (has("legacy-unspecified") || has("authority-unverified") || has("endpoint-unknown")) {
		klass = "reference";
	} else {
		klass = "current";
	}

	const includeTitle = candidate.authority === "authoritative-read" && klass !== "excluded" && candidate.title !== null;
	const rawTitle = includeTitle ? candidate.title : null;
	const truncatedTitle = rawTitle !== null && rawTitle.length > limits.maxTitleChars ? rawTitle.slice(0, limits.maxTitleChars) : rawTitle;
	if (rawTitle !== null && truncatedTitle !== rawTitle) reasons.push("title-truncated");

	const uniqueReasons = unique(reasons);
	const capped = uniqueReasons.slice(0, limits.maxReasons);
	return {
		recordId: candidate.recordId,
		revision: candidate.revision,
		family: candidate.family,
		factKey: candidate.factKey,
		class: klass,
		reasons: capped,
		reasonsTruncated: capped.length < uniqueReasons.length,
		verification: assessment.verification,
		title: truncatedTitle,
		titleTruncated: truncatedTitle !== rawTitle,
	};
}

function unique(values: readonly MemoryReasonCode[]): MemoryReasonCode[] {
	return [...new Set(values)];
}

/**
 * 确定性排序：分类强度 → 记录族 → recordId → revision → 事实键。
 *
 * 事实键必须参与：同一条档案记录承载多个字段事实时，只按记录排序会让"同 recordId 同 revision"
 * 的两条保持输入顺序（`Array#sort` 是稳定排序），于是结果随输入排列变化。
 */
function compareDecisions(left: MemoryDecision, right: MemoryDecision): number {
	const rank = CLASS_RANK.indexOf(left.class) - CLASS_RANK.indexOf(right.class);
	if (rank !== 0) return rank;
	if (left.family !== right.family) return left.family < right.family ? -1 : 1;
	if (left.recordId !== right.recordId) return left.recordId < right.recordId ? -1 : 1;
	if (left.revision !== right.revision) return left.revision - right.revision;
	const leftFact = left.factKey ?? "";
	const rightFact = right.factKey ?? "";
	if (leftFact === rightFact) return 0;
	return leftFact < rightFact ? -1 : 1;
}

/* ------------------------------------------------------------------ 精确输出预算 */

/**
 * `items` 的字节口径：JSON 数组序列化后的**全部**字节，含 `[`、`]` 与逗号。
 *
 * 因此：空数组固定 2 字节（预算 < 2 时一条都放不下）；第 n 条额外占
 * `byteLength(JSON.stringify(item))` 再加 1 字节逗号（n ≥ 2）。
 * 一旦某条放不下就**从该条起全部丢弃**（前缀语义，结果不因大小分布而抖动），
 * 并且**不会**为了"至少给一个解释"而保留超限的首条。
 */
function applyOutputBudget(items: readonly MemoryDecision[], limits: MemoryLimits): { kept: MemoryDecision[]; dropped: number; used: number } {
	const kept: MemoryDecision[] = [];
	let used = 2; // `[` + `]`
	if (used > limits.maxOutputBytes) return { kept, dropped: items.length, used };
	for (let index = 0; index < items.length; index += 1) {
		const item = items[index];
		if (item === undefined) continue;
		const size = Buffer.byteLength(JSON.stringify(item), "utf8") + (kept.length === 0 ? 0 : 1);
		if (used + size > limits.maxOutputBytes) return { kept, dropped: items.length - index, used };
		used += size;
		kept.push(item);
	}
	return { kept, dropped: 0, used };
}

/* ------------------------------------------------------------------ 输入闸门 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误文案**不回显被拒材料**：只说位置与允许取值，不粘贴正文。 */
function reject(message: string): never {
	throw new MemoryInputError("invalid-input", message);
}

function assertOneOf(value: unknown, allowed: readonly string[], label: string): void {
	if (typeof value !== "string" || !allowed.includes(value)) reject(`${label} 取值非法`);
}

function assertOptionalNullableString(value: unknown, label: string): void {
	if (value !== null && typeof value !== "string") reject(`${label} 必须是字符串或 null`);
}

function assertOptionalNullableTime(value: unknown, label: string): void {
	if (value === null) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) reject(`${label} 必须是合法时间戳范围内的安全非负整数或 null`);
}

function assertStringArray(value: unknown, label: string, maxItems: number): void {
	if (!Array.isArray(value)) reject(`${label} 必须是数组`);
	if (value.length > maxItems) reject(`${label} 超出嵌套数组上限`);
	for (const entry of value) {
		if (typeof entry !== "string") reject(`${label} 的元素必须是字符串`);
	}
}

function assertScopeShape(value: unknown, label: string): void {
	if (!isPlainObject(value)) reject(`${label} 必须是对象`);
	for (const dimension of ["projectId", "workspaceId", "customerId", "boardName", "boardRevision", "buildTarget"]) {
		assertOptionalNullableString(value[dimension], `${label}.${dimension}`);
	}
}

function assertSnapshotShape(value: unknown, label: string, maxItems: number): void {
	if (value === null) return;
	if (!isPlainObject(value)) reject(`${label} 必须是对象或 null`);
	for (const field of ["commit", "boardRevision", "buildTarget"]) assertOptionalNullableString(value[field], `${label}.${field}`);
	assertStringArray(value.contentHashes, `${label}.contentHashes`, maxItems);
}

/** 顶层浅层闸门：不访问任何候选/关系元素。 */
function assertQueryInput(query: unknown): void {
	if (!isPlainObject(query)) reject("记忆查询必须是对象");
	assertOneOf(query.intent, ["current", "history"], "读取意图");
	if (typeof query.now !== "number" || !Number.isSafeInteger(query.now) || query.now < 0) reject("查询时间必须是合法时间戳范围内的安全非负整数");
	if (!Array.isArray(query.candidates)) reject("candidates 必须是数组");
	if (!Array.isArray(query.relations)) reject("relations 必须是数组");
	if (!isPlainObject(query.authorization)) reject("authorization 必须是对象");
	const authorization = query.authorization;
	assertStringArray(authorization.customers, "authorization.customers", Number.MAX_SAFE_INTEGER);
	if (typeof authorization.allowInternalGeneral !== "boolean") reject("authorization.allowInternalGeneral 必须是 boolean");
	if (authorization.endpointAllowed !== null && typeof authorization.endpointAllowed !== "boolean") reject("authorization.endpointAllowed 必须是 boolean 或 null");
	if (!isPlainObject(query.target)) reject("target 必须是对象");
	assertScopeShape(query.target.scope, "target.scope");
	assertSnapshotShape(query.target.snapshot, "target.snapshot", Number.MAX_SAFE_INTEGER);
}

/** 有界嵌套校验：枚举/布尔/null/时间/数组长度都按契约检查，超出上限直接受控拒绝。 */
function assertCandidateShapes(candidates: readonly unknown[], limits: MemoryLimits): void {
	const seen = new Set<string>();
	for (const value of candidates) {
		if (!isPlainObject(value)) reject("候选必须是对象");
		// 记录身份 = 族 + ID + revision（缺一不可；同一裸 ID 在不同族里合法）。
		assertOneOf(value.family, MEMORY_RECORD_FAMILIES, "候选记录族");
		if (typeof value.recordId !== "string" || value.recordId === "") reject("候选必须带非空 recordId");
		if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) reject("候选 revision 必须是安全非负整数");
		// 事实身份 = 记录身份 + 业务事实键：同一记录可以承载多个字段事实，那不是重复。
		const key = `${value.family}\u0000${value.recordId}\u0000${value.revision}\u0000${typeof value.factKey === "string" ? value.factKey : ""}`;
		// 连事实键都一致说明调用方给了重复材料：确定性结论失去意义，直接拒绝。
		if (seen.has(key)) reject("候选存在重复的记录身份+事实键");
		seen.add(key);

		assertOneOf(value.authority, AUTHORITY_VALUES, "候选权威性");
		assertOneOf(value.status, STATUS_VALUES, "候选状态");
		assertScopeShape(value.scope, "候选 scope");
		if (!isPlainObject(value.reuse)) reject("候选 reuse 必须是对象");
		assertOneOf(value.reuse.level, REUSE_LEVEL_VALUES, "候选复用范围");
		assertStringArray(value.reuse.customers, "候选复用客户", limits.maxNestedItems);
		assertOptionalNullableString(value.reuse.authorization, "候选复用授权说明");

		if (!isPlainObject(value.time)) reject("候选 time 必须是对象");
		assertOptionalNullableTime(value.time.occurredAt, "候选 occurredAt");
		assertOptionalNullableTime(value.time.recordedAt, "候选 recordedAt");
		assertOptionalNullableTime(value.time.effectiveFrom, "候选 effectiveFrom");
		assertOptionalNullableTime(value.time.effectiveTo, "候选 effectiveTo");

		if (!Array.isArray(value.confirmedFields) || value.confirmedFields.length > limits.maxNestedItems) reject("候选 confirmedFields 必须是数组且不超上限");
		for (const field of value.confirmedFields) {
			if (!isPlainObject(field)) reject("候选确认字段必须是对象");
			if (typeof field.field !== "string") reject("候选确认字段必须带 field 名称");
			assertOptionalNullableString(field.value, "候选确认字段值");
			assertOneOf(field.status, FIELD_STATUS_VALUES, "候选确认字段状态");
		}

		if (!Array.isArray(value.validations) || value.validations.length > limits.maxNestedItems) reject("候选 validations 必须是数组且不超上限");
		for (const validation of value.validations) {
			if (!isPlainObject(validation)) reject("候选验证必须是对象");
			assertOneOf(validation.kind, VALIDATION_KIND_VALUES, "候选验证类别");
			assertOneOf(validation.result, VALIDATION_RESULT_VALUES, "候选验证结论");
			if (typeof validation.performedAt !== "number" || !Number.isSafeInteger(validation.performedAt) || validation.performedAt < 0) reject("候选验证时间必须是安全非负整数");
		}

		if (!Array.isArray(value.evidence) || value.evidence.length > limits.maxNestedItems) reject("候选证据必须是数组且不超上限");
		for (const evidence of value.evidence) {
			if (!isPlainObject(evidence)) reject("候选证据必须是对象");
			assertOneOf(evidence.validity, EVIDENCE_VALIDITY_VALUES, "候选证据有效性");
			assertOptionalNullableString(evidence.contentHash, "候选证据 hash");
		}

		assertSnapshotShape(value.dependencySnapshot, "候选依赖快照", limits.maxNestedItems);
		assertOptionalNullableString(value.derivedFromSummaryOf, "候选摘要来源");
		assertOptionalNullableString(value.factKey, "候选事实键");
		assertOptionalNullableString(value.value, "候选事实值");
		assertOptionalNullableString(value.title, "候选标题");
		if (typeof value.sourceFingerprint !== "string" && value.sourceFingerprint !== null) reject("候选来源指纹必须是字符串或 null");
	}
}

function assertRecordRefShape(value: unknown, label: string): void {
	if (!isPlainObject(value)) reject(`${label} 必须是对象`);
	assertOneOf(value.family, MEMORY_RECORD_FAMILIES, `${label} 记录族`);
	if (typeof value.recordId !== "string" || value.recordId === "") reject(`${label} 必须带非空 recordId`);
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) reject(`${label} revision 必须是安全非负整数`);
}

function assertRelationShapes(relations: readonly unknown[], limits: MemoryLimits): void {
	void limits;
	for (const value of relations) {
		if (!isPlainObject(value)) reject("关系必须是对象");
		assertOneOf(value.type, RELATION_TYPE_VALUES, "关系类型");
		// 关系两端都必须是具名记录身份：缺任一端就不是一条可用断言（R27-2）。
		assertRecordRefShape(value.source, "关系声明方");
		assertRecordRefShape(value.target, "关系被作用方");
		assertScopeShape(value.scope, "关系 scope");
	}
}
