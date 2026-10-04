/**
 * 记忆决策模块（BM-M1）的**窄出口**。
 *
 * 这一层是**纯决策**：没有文件系统、没有 Git、没有模型、没有时钟、没有写入。
 * 调用方负责把"已经取得的记录"与"显式策略/快照"交进来，再把返回的受控原因码映射成业务动作。
 *
 * 边界（本批刻意不做的事）：
 * - 不升 schema、不写迁移器、不新增落盘字段：v1 表达不了的维度一律 `null`（unspecified）；
 * - 不冒充搜索引擎或语义历史账本：它只对**给定的候选**做判定，不做全库扫描；
 * - 不把"读取声明"当成自己完成的磁盘复核（`authority` 由调用方声明）。
 */
export {
	candidateRef,
	DEFAULT_MEMORY_LIMITS,
	EMPTY_SCOPE,
	EMPTY_TIME,
	MEMORY_RECORD_FAMILIES,
	MemoryInputError,
	recordRefKey,
	resolveMemoryLimits,
	type MemoryAuthorization,
	type MemoryCandidate,
	type MemoryConfirmedField,
	type MemoryDecision,
	type MemoryDecisionClass,
	type MemoryDecisionResult,
	type MemoryDependencySnapshot,
	type MemoryEvidenceRef,
	type MemoryInputErrorCode,
	type MemoryLimits,
	type MemoryQuery,
	type MemoryReasonCode,
	type MemoryRecordFamily,
	type MemoryRecordRef,
	type MemoryRelation,
	type MemoryReuseDeclaration,
	type MemoryScopeDeclaration,
	type MemoryTargetContext,
	type MemoryTimeDeclaration,
	type MemoryValidationRef,
	type MemoryVerificationView,
} from "./contract.ts";
export { projectV1ExperienceCard, projectV1FeatureRecord, projectV1ProjectProfile, projectV1Record, projectV1TaskRecord, type MemoryProjectionResult } from "./projection.ts";
export {
	authorizeCandidate,
	eligibilityVerdict,
	evaluateRelationStates,
	isCurrentBlocker,
	isFactConfirmed,
	isScopeDimension,
	NON_CURRENT_BLOCKERS,
	scopeVerdict,
	temporalVerdict,
	verificationVerdict,
	SCOPE_DIMENSIONS,
	type DeclarerState,
	type EvaluateRelationsInput,
	type RelationEvaluation,
	type RelationNodeOutcome,
	type RelationNodeState,
	type ScopeDimension,
	type Verdict,
} from "./policy.ts";
export { decideMemory } from "./decide.ts";
