/**
 * 记忆决策的**纯策略**（BM-M1）：授权、范围、当前资格、时态、替代/撤回、验证漂移。
 *
 * 每个函数都是"输入 → 受控原因码"，不做 IO、不读时钟、不修改输入。
 * 顺序纪律（设计 §7）：**授权先于可见**；范围与状态在授权之后逐个判定；
 * 缺证据时保留 unknown，不用时间戳或来源数量强行选胜者。
 */
import type { MemoryAuthorization, MemoryCandidate, MemoryDependencySnapshot, MemoryReasonCode, MemoryRecordFamily, MemoryRecordRef, MemoryRelation, MemoryScopeDeclaration, MemoryTargetContext, MemoryTimeDeclaration, MemoryVerificationView } from "./contract.ts";
import { MEMORY_RECORD_FAMILIES, MemoryInputError, recordRefKey } from "./contract.ts";
import type { ValidationKind } from "../contracts/common.ts";

/** 范围维度（`projectId` 只在 `current-project` 复用时是硬约束，见 `authorizeCandidate`）。 */
export const SCOPE_DIMENSIONS = ["projectId", "workspaceId", "customerId", "boardName", "boardRevision", "buildTarget"] as const;
export type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

export type Verdict = {
	readonly allowed: boolean;
	readonly reasons: readonly MemoryReasonCode[];
};

/**
 * 授权判定：**先授权再可见**。
 *
 * 端点策略三态：`false` ⇒ 拒绝（连"参考"都不给）；`null`（未知）⇒ 允许进入判定但**不能是当前结论**。
 * "资料存在本地"不等于"允许发给当前模型"，因此未知不放行到 `current`。
 */
export function authorizeCandidate(candidate: MemoryCandidate, target: MemoryTargetContext, authorization: MemoryAuthorization): Verdict {
	const reasons: MemoryReasonCode[] = [];
	let allowed = true;

	if (authorization.endpointAllowed === false) {
		allowed = false;
		reasons.push("endpoint-denied");
	} else if (authorization.endpointAllowed === null) {
		reasons.push("endpoint-unknown");
	}

	const level = candidate.reuse.level;
	if (level === "current-project") {
		// 强身份是 registry 绑定/人工确认给的项目 ID；不用厂商名、板名或相同远端推断"同一项目"。
		if (candidate.scope.projectId === null || target.scope.projectId === null || candidate.scope.projectId !== target.scope.projectId) {
			allowed = false;
			reasons.push("scope-mismatch");
		}
	} else if (level === "customer") {
		const customerId = target.scope.customerId;
		// `customers` 为空表示未指定 ⇒ 按最窄范围处理（不授权）。
		if (customerId === null || !candidate.reuse.customers.includes(customerId) || !authorization.customers.includes(customerId)) {
			allowed = false;
			reasons.push("unauthorized-customer");
		}
	} else if (!authorization.allowInternalGeneral || candidate.reuse.authorization === null || candidate.reuse.authorization.trim() === "") {
		// `internal-general` 需要**显式**授权说明 + 上层策略同时放行；缺一即拒绝。
		allowed = false;
		reasons.push("unauthorized-internal-general");
	}

	return { allowed, reasons };
}

/**
 * 范围适配：授权通过后再逐项判定**已声明**的约束。
 *
 * 未声明的维度不是约束（"这条经验不限定板卡"本身不等于不适用），因此不在这里降级；
 * "没有生效时间也没有依赖快照"这种 v1 形态由 `decide.ts` 的 `legacy-unspecified` 处理。
 *
 * 三种结果必须分开（设计 §3.2.3）：
 * - 双方都声明且不同 ⇒ 不适用（`scope-mismatch`，本候选被排除）；
 * - 候选声明、目标未声明 ⇒ 不能确认（`scope-unknown`，需人工补目标信息）；
 * - 只在一侧声明 ⇒ 不作判断（不把"不知道"当成匹配，也不当成不适用）。
 */
export function scopeVerdict(candidate: MemoryCandidate, target: MemoryTargetContext): { readonly applicable: boolean; readonly reasons: readonly MemoryReasonCode[] } {
	const reasons: MemoryReasonCode[] = [];
	let applicable = true;
	for (const dimension of SCOPE_DIMENSIONS) {
		// `projectId` 在 current-project 复用里已由授权判定处理；跨项目级别的候选不因项目不同被排除。
		if (dimension === "projectId" && candidate.reuse.level !== "current-project") continue;
		const declared = candidate.scope[dimension];
		if (declared === null) continue;
		const wanted = target.scope[dimension];
		if (wanted === null) {
			// 目标不知道 ⇒ **不能确认**（needs-review），但也不能断言不适用（不排除）。
			reasons.push("scope-unknown");
			continue;
		}
		if (declared !== wanted) {
			reasons.push("scope-mismatch");
			applicable = false;
		}
	}
	return { applicable, reasons };
}

/* ------------------------------------------------------------------ 当前资格 */

/**
 * 让一条候选**不能参与当前值竞争**的原因码（R27-1）。
 *
 * 这张表是"当前准入"的唯一口径：`decide.ts` 既用它决定分类，也用它决定
 * "哪些事实有资格参加当前冲突判定"，以及"哪些记录有资格声明替代/撤回"。
 *
 * 刻意**不包含** `field-unconfirmed`：新检测候选与人工确认值的差异正是要暴露的当前矛盾
 * （包含它会让"确认值 vs 新候选"永远无法形成待确认差异）。
 */
export const NON_CURRENT_BLOCKERS: readonly MemoryReasonCode[] = ["older-revision", "higher-revision-unreadable", "not-reviewed", "not-yet-effective", "expired", "deprecated", "superseded", "retracted", "summary-derived", "unresolved-relation", "relation-not-effective", "relation-ambiguous", "authority-unreadable"];

export function isCurrentBlocker(reason: MemoryReasonCode): boolean {
	return NON_CURRENT_BLOCKERS.includes(reason);
}

/**
 * 记录族 / 字段级的**当前准入**（R27-1）。
 *
 * 为什么必须分族：经验卡有审核状态（`draft` 不能当工程依据），档案与 Feature 靠**字段确认状态**
 * 表达可信度（v1 里它们是 `unknown`，一刀切禁止 unknown 会直接废掉档案），
 * 任务记录只表达工作状态（`in_progress` 不是"未审核"）。
 */
export function eligibilityVerdict(candidate: MemoryCandidate): readonly MemoryReasonCode[] {
	const reasons: MemoryReasonCode[] = [];
	switch (candidate.family) {
		case "experience-card":
			// 只有经过审核的经验才能作为当前工程依据；draft/unknown 一律不是。
			if (candidate.status !== "reviewed" && candidate.status !== "verified") reasons.push("not-reviewed");
			break;
		case "project-profile":
		case "feature-record":
			// 字段粒度：只有"这个事实被人工确认"才算当前依据。
			if (candidate.factKey !== null && !isFactConfirmed(candidate)) reasons.push("field-unconfirmed");
			break;
		case "detected-candidate":
			// 检测结果天然只是候选：必须人工确认后才可能成为当前值。
			reasons.push("field-unconfirmed");
			break;
		case "task-record":
		case "session-summary":
			// 任务状态表达的是工作进度，不是可信度；摘要另行按 `summary-derived` 处理。
			break;
	}
	return reasons;
}

/** `confirmedFields` 里以该候选的 `factKey` 命名且状态为 `confirmed` 的条目 = 人工确认值。 */
export function isFactConfirmed(candidate: MemoryCandidate): boolean {
	if (candidate.factKey === null) return false;
	return candidate.confirmedFields.some((field) => field.field === candidate.factKey && field.status === "confirmed");
}

/** 时态校验 + 半开区间判定（`[from, to)`）；`null` 表示未指定，不是无限。 */
export function temporalVerdict(time: MemoryTimeDeclaration, now: number): { readonly blocked: boolean; readonly reasons: readonly MemoryReasonCode[] } {
	assertTimeValue(time.occurredAt, "occurredAt");
	assertTimeValue(time.recordedAt, "recordedAt");
	assertTimeValue(time.effectiveFrom, "effectiveFrom");
	assertTimeValue(time.effectiveTo, "effectiveTo");
	if (time.effectiveFrom !== null && time.effectiveTo !== null && time.effectiveFrom >= time.effectiveTo) {
		// 半开区间必须非空；倒置区间是输入错误，不"尽力解释成一整天"。
		throw new MemoryInputError("invalid-time-range", "生效区间倒置：effectiveFrom 必须早于 effectiveTo");
	}
	const reasons: MemoryReasonCode[] = [];
	if (time.effectiveFrom !== null && now < time.effectiveFrom) reasons.push("not-yet-effective");
	if (time.effectiveTo !== null && now >= time.effectiveTo) reasons.push("expired");
	return { blocked: reasons.length > 0, reasons };
}

function assertTimeValue(value: number | null, label: string): void {
	if (value === null) return;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new MemoryInputError("invalid-input", `${label} 必须是合法时间戳范围内的安全非负整数或 null`);
}

/* ------------------------------------------------------------------ 替代 / 撤回 */

/**
 * 关系**声明方**在"关系之外"的状态（R28-3）。
 *
 * 五态必须分开，因为它们对目标的影响完全不同：
 * - `readable`：授权可见、权威可读、且当前有效 ⇒ 需要进一步看它**自己**有没有被别的关系作废；
 * - `blocked`：可见但当前无效（未审核 / 未生效 / 已过期 / 旧版本 / 未确认字段…）⇒ `not-effective`；
 * - `unreadable`：授权可见但读不到内容 ⇒ `unresolved`（连断言本身都没拿到）；
 * - `unauthorized`：调用方给了这条材料、但它不在本次授权可见集合里
 *   ⇒ **整条边被忽略**：隐藏来源不能改变可见事实；
 * - `absent`：输入里根本没有这条记录 ⇒ `unresolved`（不能把"没给我"当成"没有关系"）。
 */
export type DeclarerState = "readable" | "blocked" | "unreadable" | "unauthorized" | "absent";

export type RelationNodeState = "none" | "superseded" | "retracted" | "ambiguous" | "unresolved" | "not-effective";

export type RelationNodeOutcome = {
	readonly state: RelationNodeState;
	readonly reasons: readonly MemoryReasonCode[];
	/** true ⇒ 这条结论不足以支持"确定"，整体必须报 `incomplete`。 */
	readonly uncertain: boolean;
	/** 关系链上到声明方的跳数（用于链长预算）。 */
	readonly depth: number;
};

export type RelationEvaluation = {
	readonly outcomes: ReadonlyMap<string, RelationNodeOutcome>;
	/** 关系图触顶（节点预算）⇒ 未求解的部分按不完整处理。 */
	readonly truncated: boolean;
	readonly truncatedBy: readonly ("nodes" | "chain")[];
};

export type EvaluateRelationsInput = {
	readonly relations: readonly MemoryRelation[];
	readonly declarerStateOf: (ref: MemoryRecordRef) => DeclarerState;
	readonly targetContext: MemoryTargetContext;
	readonly maxChain: number;
	readonly maxNodes: number;
};

/** 关系的作用范围与目标上下文的关系：未声明维度不构成约束。 */
type RelationScopeFit = "applies" | "not-applicable" | "unknown";

function relationScopeFit(relation: MemoryRelation, target: MemoryTargetContext): RelationScopeFit {
	let fit: RelationScopeFit = "applies";
	for (const dimension of SCOPE_DIMENSIONS) {
		const declared = relation.scope[dimension];
		if (declared === null) continue;
		const wanted = target.scope[dimension];
		// 目标不知道 ⇒ 不能确认这条关系作用于本次上下文；不能当成"不适用"（那等于替调用方假设）。
		if (wanted === null) fit = "unknown";
		else if (declared !== wanted) return "not-applicable";
	}
	return fit;
}

/** 确定性排序：同一批关系在任意输入排列下得到同一张图。 */
function compareRelations(left: MemoryRelation, right: MemoryRelation): number {
	const leftTarget = recordRefKey(left.target);
	const rightTarget = recordRefKey(right.target);
	if (leftTarget !== rightTarget) return leftTarget < rightTarget ? -1 : 1;
	const leftSource = recordRefKey(left.source);
	const rightSource = recordRefKey(right.source);
	if (leftSource !== rightSource) return leftSource < rightSource ? -1 : 1;
	return left.type < right.type ? -1 : left.type > right.type ? 1 : 0;
}

/**
 * 替代/撤回的**全图判定**（R27-2 + R28-3）。
 *
 * 旧实现用 `.find()` 从目标出发沿第一条有效边行走，于是：
 * - 输入排列一变，同一条分叉上的环就得到不同结论；
 * - 声明方自己的状态（被别的关系撤回）在"关系之前的快照"里看不出来。
 *
 * 现在改成：
 * 1. **建图**（按确定性顺序排序，结果与输入排列无关）；
 * 2. **依赖排序**：目标依赖声明方，用 Kahn 拓扑序求解；走不出来的节点（环及环下游）
 *    一律 `ambiguous`——保留矛盾，不挑一条边；
 * 3. **授权先于关系**：声明方不在可见集合里时整条边被忽略（不泄漏、不改变可见事实）；
 * 4. **来源被撤回/冲突/不可证明**时显式降级成 `not-effective`/`unresolved`
 *    （不反向把旧值"复活"成当前）；
 * 5. 节点数与链长都有预算，触顶如实标记为不完整。
 */
export function evaluateRelationStates(input: EvaluateRelationsInput): RelationEvaluation {
	const truncatedBy: Array<"nodes" | "chain"> = [];

	// ---- 1) 建图 ----
	const edgesByTarget = new Map<string, MemoryRelation[]>();
	const nodeKeys = new Set<string>();
	for (const relation of [...input.relations].sort(compareRelations)) {
		const targetKey = recordRefKey(relation.target);
		const bucket = edgesByTarget.get(targetKey);
		if (bucket === undefined) edgesByTarget.set(targetKey, [relation]);
		else bucket.push(relation);
		nodeKeys.add(targetKey);
		nodeKeys.add(recordRefKey(relation.source));
	}

	// 节点预算：确定性地取前 maxNodes 个（排序后），其余标记为触顶。
	const sortedNodes = [...nodeKeys].sort();
	const activeNodes = new Set(sortedNodes.slice(0, input.maxNodes));
	const truncated = sortedNodes.length > activeNodes.size;
	if (truncated) truncatedBy.push("nodes");

	// ---- 2) 依赖排序（Kahn）：只把"可能被递归求解"的边算作依赖 ----
	// 明确未授权 / 输入里没有 / 读不到内容的声明方不会参与递归，因此不构成依赖关系，
	// 否则一条隐藏来源的边会凭空把可见记录变成"环里的一员"。
	const declarationState = new Map<string, DeclarerState>();
	const declarerStateOf = (key: string): DeclarerState => {
		const cached = declarationState.get(key);
		if (cached !== undefined) return cached;
		const parsed = parseRefKey(key);
		const state = parsed === null ? "absent" : input.declarerStateOf(parsed);
		declarationState.set(key, state);
		return state;
	};

	const declaredBy = new Map<string, Set<string>>();
	for (const key of activeNodes) declaredBy.set(key, new Set());
	for (const [targetKey, edges] of edgesByTarget) {
		if (!activeNodes.has(targetKey)) continue;
		const bucket = declaredBy.get(targetKey);
		if (bucket === undefined) continue;
		for (const edge of edges) {
			const sourceKey = recordRefKey(edge.source);
			if (!activeNodes.has(sourceKey)) continue;
			const state = declarerStateOf(sourceKey);
			if (state === "readable" || state === "blocked") bucket.add(sourceKey);
		}
	}

	const order: string[] = [];
	const remaining = new Map([...declaredBy].map(([key, set]) => [key, new Set(set)] as const));
	const dependents = new Map<string, Set<string>>();
	for (const [targetKey, sources] of remaining) {
		for (const sourceKey of sources) {
			const bucket = dependents.get(sourceKey);
			if (bucket === undefined) dependents.set(sourceKey, new Set([targetKey]));
			else bucket.add(targetKey);
		}
	}
	const ready = [...remaining]
		.filter(([, sources]) => sources.size === 0)
		.map(([key]) => key)
		.sort();
	while (ready.length > 0) {
		const key = ready.shift();
		if (key === undefined) break;
		order.push(key);
		for (const dependent of dependents.get(key) ?? []) {
			const bucket = remaining.get(dependent);
			if (bucket === undefined) continue;
			bucket.delete(key);
			if (bucket.size === 0 && !order.includes(dependent) && !ready.includes(dependent)) ready.push(dependent);
		}
		ready.sort();
	}
	// 走不出拓扑序的节点 = 在环里或环的下游：保留矛盾（不挑一条边）。
	const cyclic = new Set([...remaining.keys()].filter((key) => !order.includes(key)));

	// ---- 3) 按依赖顺序求解 ----
	const outcomes = new Map<string, RelationNodeOutcome>();
	const depthOf = new Map<string, number>();
	const markTruncated = (): void => {
		if (!truncatedBy.includes("chain")) truncatedBy.push("chain");
	};

	for (const key of order) {
		const states = new Set<"superseded" | "retracted" | "unresolved" | "not-effective">();
		let unknownScope = false;
		let depth = 0;
		for (const edge of edgesByTarget.get(key) ?? []) {
			const fit = relationScopeFit(edge, input.targetContext);
			if (fit === "not-applicable") continue;
			if (fit === "unknown") {
				unknownScope = true;
				continue;
			}
			const sourceKey = recordRefKey(edge.source);
			const sourceState = declarerStateOf(sourceKey);
			if (sourceState === "unauthorized") continue; // 隐藏来源：整条边忽略
			if (sourceState === "absent" || sourceState === "unreadable") {
				states.add("unresolved");
				continue;
			}
			if (sourceState === "blocked") {
				states.add("not-effective");
				continue;
			}
			// 声明方自己可能被别的关系作废（"关系之前的快照"证明不了它最终有效）。
			const nested = outcomes.get(sourceKey)?.state ?? "none";
			depth = Math.max(depth, (depthOf.get(sourceKey) ?? 0) + 1);
			if (nested === "none") states.add(edge.type === "retracts" ? "retracted" : "superseded");
			else if (nested === "unresolved") states.add("unresolved");
			else states.add("not-effective");
		}
		depthOf.set(key, depth);
		const chainTruncated = depth > input.maxChain;
		if (chainTruncated) markTruncated();

		let state: RelationNodeState;
		let reasons: MemoryReasonCode[];
		let uncertain: boolean;
		if (unknownScope || states.has("unresolved")) {
			state = "unresolved";
			reasons = ["unresolved-relation"];
			uncertain = true;
		} else if (states.has("superseded") && states.has("retracted")) {
			state = "ambiguous";
			reasons = ["relation-ambiguous"];
			uncertain = false;
		} else if (states.has("superseded") || states.has("retracted")) {
			state = states.has("retracted") ? "retracted" : "superseded";
			reasons = [state === "retracted" ? "retracted" : "superseded"];
			uncertain = false;
		} else if (states.has("not-effective")) {
			state = "not-effective";
			reasons = ["relation-not-effective"];
			uncertain = true;
		} else {
			state = "none";
			reasons = [];
			uncertain = false;
		}
		// 链长触顶：结论还能给，但"没有走完关系集合"必须显式可见（并让整体不完整）。
		if (chainTruncated && state !== "none") {
			reasons = [...reasons, "relation-chain-truncated"];
			uncertain = true;
		}
		outcomes.set(key, { state, reasons, uncertain, depth });
	}

	for (const key of cyclic) {
		outcomes.set(key, { state: "ambiguous", reasons: ["relation-ambiguous"], uncertain: false, depth: 0 });
	}

	// 被节点预算丢掉的**目标**不能"看起来没有任何关系"：那会把一次预算不足
	// 变成"这条事实很干净"。按未解析 + 触顶处理，让调用方看到 incomplete。
	for (const key of sortedNodes.slice(input.maxNodes)) {
		if (!edgesByTarget.has(key)) continue;
		outcomes.set(key, { state: "unresolved", reasons: ["unresolved-relation", "relation-chain-truncated"], uncertain: true, depth: 0 });
	}

	return { outcomes, truncated, truncatedBy };
}

/** 记录身份文本键 → 记录身份（`recordRefKey` 的逆运算；缺失/畸形一律 null）。 */
function parseRefKey(key: string): MemoryRecordRef | null {
	const parts = key.split("\u0000");
	if (parts.length !== 3) return null;
	const [family, recordId, revisionText] = parts;
	if (family === undefined || recordId === undefined || revisionText === undefined) return null;
	if (!(MEMORY_RECORD_FAMILIES as readonly string[]).includes(family)) return null;
	const revision = Number(revisionText);
	if (!Number.isSafeInteger(revision) || revision < 0) return null;
	return { family: family as MemoryRecordFamily, recordId, revision };
}

/* ------------------------------------------------------------------ 验证与证据 */

const VALIDATION_STRENGTH: readonly ValidationKind[] = ["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"];

/**
 * 验证适用性：**事实有效**与**验证强度**分开报告。
 *
 * `compile` 永远不会被报成 `board-boot`：只按实际记录过的验证类别取最强项，
 * 不做"编译通过 ⇒ 硬件通过"的升级。
 */
export function verificationVerdict(candidate: MemoryCandidate, target: MemoryTargetContext): { readonly view: MemoryVerificationView; readonly reasons: readonly MemoryReasonCode[] } {
	const reasons: MemoryReasonCode[] = [];
	let strongestPassed: ValidationKind | null = null;
	for (const validation of candidate.validations) {
		if (validation.result !== "passed") continue;
		if (strongestPassed === null || VALIDATION_STRENGTH.indexOf(validation.kind) > VALIDATION_STRENGTH.indexOf(strongestPassed)) strongestPassed = validation.kind;
	}

	const drifted = snapshotDrift(candidate.dependencySnapshot, target.snapshot);
	if (drifted) reasons.push("verification-drift");
	let unavailable = false;
	let stale = false;
	for (const evidence of candidate.evidence) {
		if (evidence.validity === "unavailable") unavailable = true;
		if (evidence.validity === "stale") stale = true;
	}
	if (stale) reasons.push("verification-drift");
	if (unavailable) reasons.push("evidence-unavailable");

	const status: MemoryVerificationView["status"] = drifted || stale ? "drifted" : unavailable ? "unavailable" : candidate.validations.length > 0 || candidate.dependencySnapshot !== null ? "in-scope" : "none";
	return { view: { status, strongestPassed }, reasons };
}

/**
 * 只比较**该事实显式声明**依赖的维度：无关文件变化不得让全部知识失效。
 *
 * 声明了某个维度但目标侧为 `null`（不知道）时同样按漂移处理——"无法判定相关性"不能当成"没有变化"。
 */
function snapshotDrift(declared: MemoryDependencySnapshot | null, wanted: MemoryDependencySnapshot): boolean {
	if (declared === null) return false;
	if (declared.commit !== null && declared.commit !== wanted.commit) return true;
	if (declared.boardRevision !== null && declared.boardRevision !== wanted.boardRevision) return true;
	if (declared.buildTarget !== null && declared.buildTarget !== wanted.buildTarget) return true;
	for (const hash of declared.contentHashes) {
		if (!wanted.contentHashes.includes(hash)) return true;
	}
	return false;
}

/** 供调用方自查：本模块报告的原因码是否都属于受控枚举（测试用）。 */
export function isScopeDimension(value: string): value is ScopeDimension {
	return (SCOPE_DIMENSIONS as readonly string[]).includes(value);
}
