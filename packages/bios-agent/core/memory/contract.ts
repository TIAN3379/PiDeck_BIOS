/**
 * 记忆决策模块的**输入/输出契约与限额**（BM-M1）。
 *
 * 这是**纯决策层**：不 import `node:fs`、不扫描 Git、不连模型、不读时钟、不写知识库。
 * 它拿到的"候选依据"是调用方**已经读到的记录**与**显式声明的策略/快照**，
 * 输出是"当前可用 / 仅供参考 / 需复核 / 冲突 / 显式历史 / 排除"的判定与受控原因码。
 *
 * 三条边界（写在这里防止后来者顺手加进来）：
 *
 * 1. **不冒充 schema v2**：v1 记录无法表达的时态/替代关系一律 `null`（unspecified），
 *    不从 `createdAt/updatedAt` 猜工程生效时间，也不新增任何落盘字段。
 * 2. **不把调用方的读取声明当成自己做的磁盘复核**：`authority` 是**调用方声明**，
 *    纯模块只按声明分类；真正的读取证据由存储层负责。
 * 3. **授权先于可见**：未授权候选不得借标题、正文、ID 或排除计数出现在结果里，
 *    `history` 意图同样受授权约束。
 */
import type { EvidenceValidity, FieldStatus, ReuseScopeLevel, ValidationKind, ValidationResult } from "../contracts/common.ts";

/** 纯模块的输入错误（与存储层的 `StorageError` 分开：这一层不依赖存储实现）。 */
export type MemoryInputErrorCode = "invalid-limits" | "invalid-input" | "invalid-time-range";

export class MemoryInputError extends Error {
	readonly code: MemoryInputErrorCode;

	constructor(code: MemoryInputErrorCode, message: string) {
		super(message);
		this.name = "MemoryInputError";
		this.code = code;
	}
}

/**
 * 资源限额。
 *
 * 口径与存储层一致：`undefined` 保持默认；非安全整数/负数一律拒绝；**0 表示"不允许任何该项消耗"**，
 * 不是"无限"。先检查形态与数组长度，再遍历（不为超限输入做无界工作）。
 */
export type MemoryLimits = {
	/** 一次决策最多处理的候选数与关系数。 */
	maxCandidates: number;
	maxRelations: number;
	/** 单条决策最多返回的原因码数。 */
	maxReasons: number;
	/** 单条标题的字符上限（超出截断并显式标记）。 */
	maxTitleChars: number;
	/**
	 * `items` 实际 UTF-8 序列化字节预算（超限即 `incomplete` 并如实计数）。
	 *
	 * 口径固定：把 `items` 按 JSON 数组序列化后的**全部**字节数，含 `[`、`]` 与逗号分隔符。
	 * 因此空数组固定占 2 字节——预算 0 或 1 时**一条都放不下**（不是"至少塞一条解释"）。
	 */
	maxOutputBytes: number;
	/** 替代/撤回关系链的最大跳数（无界递归一律不允许）。 */
	maxRelationChain: number;
	/** 关系图求解的最大节点数（防止分叉图把一次纯计算变成无界遍历）。 */
	maxRelationNodes: number;
	/** 单个候选的**每个**嵌套数组（customers/confirmedFields/validations/evidence/contentHashes 等）的元素上限。 */
	maxNestedItems: number;
};

export const DEFAULT_MEMORY_LIMITS: MemoryLimits = {
	maxCandidates: 2_000,
	maxRelations: 2_000,
	maxReasons: 8,
	maxTitleChars: 512,
	maxOutputBytes: 256 * 1024,
	maxRelationChain: 4,
	maxRelationNodes: 256,
	maxNestedItems: 256,
};

const MEMORY_LIMIT_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_MEMORY_LIMITS));

/** 合并默认值并校验限额本身（未知字段直接拒绝：拼错名字等于换了一套预算）。 */
export function resolveMemoryLimits(overrides?: Partial<MemoryLimits>): MemoryLimits {
	const merged: MemoryLimits = { ...DEFAULT_MEMORY_LIMITS };
	if (overrides !== undefined) {
		if (typeof overrides !== "object" || overrides === null) throw new MemoryInputError("invalid-limits", "记忆限额必须是对象");
		for (const key of Object.keys(overrides)) {
			if (!MEMORY_LIMIT_KEYS.has(key)) throw new MemoryInputError("invalid-limits", `记忆限额存在未知字段：${key}`);
		}
		for (const key of Object.keys(DEFAULT_MEMORY_LIMITS) as Array<keyof MemoryLimits>) {
			const value = overrides[key];
			if (value !== undefined) merged[key] = value;
		}
	}
	for (const [key, value] of Object.entries(merged) as Array<[keyof MemoryLimits, number]>) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new MemoryInputError("invalid-limits", `记忆限额 ${key} 必须是有限非负整数`);
	}
	return merged;
}

/* ------------------------------------------------------------------ 三种身份（不能混为裸 ID） */

/**
 * **记录族**：v1 记录类型的命名空间。
 *
 * 为什么必须显式：同一段文本（例如 `"abc"`）在不同族里是**不同记录**。
 * 用裸 ID 做去重、淘汰或关系端点，会让"经验卡 abc"和"Feature abc"互相顶掉。
 */
export const MEMORY_RECORD_FAMILIES = ["project-profile", "experience-card", "feature-record", "task-record", "session-summary", "detected-candidate"] as const;
export type MemoryRecordFamily = (typeof MEMORY_RECORD_FAMILIES)[number];

/**
 * **记录身份** = 记录族 + 记录 ID + revision。
 *
 * 三者缺一不可：只给 ID 无法区分同名的不同族记录；只给 ID 也无法判断"这是不是最新版本"。
 */
export type MemoryRecordRef = {
	readonly family: MemoryRecordFamily;
	readonly recordId: string;
	readonly revision: number;
};

/** 记录身份的可比较文本键（仅本模块内部使用，不作为对外身份）。 */
export function recordRefKey(ref: MemoryRecordRef): string {
	return `${ref.family}\u0000${ref.recordId}\u0000${ref.revision}`;
}

/**
 * 候选的**事实身份键** = 记录身份 + 业务事实键。
 *
 * 一条记录可以承载多个字段级事实（例如同一个 ProjectProfile 的 boardName 与 chipsetFamily），
 * 所以"同族同 ID 同 revision"不是重复；真正重复的是连事实键也一致。
 */
export function candidateFactKey(candidate: MemoryCandidate): string {
	return `${recordRefKey(candidateRef(candidate))}\u0000${candidate.factKey ?? ""}`;
}

/* ------------------------------------------------------------------ 输入：范围 / 授权 / 时态 / 验证 */

/**
 * 维度声明。`null` = **未声明**（不是"匹配任何值"，也不是"未知就等于匹配"）。
 *
 * 为什么不用厂商名/板名/相同远端推断同一项目：那是"看起来像同一台"的猜测，
 * 不是工程身份。强身份只能由调用方显式给出（registry 绑定与人工确认）。
 */
export type MemoryScopeDeclaration = {
	readonly projectId: string | null;
	readonly workspaceId: string | null;
	readonly customerId: string | null;
	readonly boardName: string | null;
	readonly boardRevision: string | null;
	readonly buildTarget: string | null;
};

export const EMPTY_SCOPE: MemoryScopeDeclaration = { projectId: null, workspaceId: null, customerId: null, boardName: null, boardRevision: null, buildTarget: null };

/** 复用范围声明（与 `ReuseScope` 同源语义）。 */
export type MemoryReuseDeclaration = {
	readonly level: ReuseScopeLevel;
	readonly customers: readonly string[];
	/** 跨客户复用的显式授权说明；缺失即未授权。 */
	readonly authorization: string | null;
};

/**
 * 授权与端点策略：**由上层显式提供**。
 *
 * 现有 `authorization` 文本是**声明**，不是企业认证或可信权限服务；这一层只按它做决定，
 * 不声称它证明了调用者身份。
 */
export type MemoryAuthorization = {
	/** 允许访问的客户 ID（显式列出；不含当前项目客户）。 */
	readonly customers: readonly string[];
	/** 是否允许 `internal-general` 范围的候选。 */
	readonly allowInternalGeneral: boolean;
	/** 模型端点是否允许使用当前材料：`true`/`false`/`null`（未知）。 */
	readonly endpointAllowed: boolean | null;
};

/**
 * 时态视图：工程时间与状态关系**分开**，全部可 `null`（未指定）。
 *
 * 半开区间 `[effectiveFrom, effectiveTo)`；`null` 表示未指定——**不是**无限有效或无效。
 */
export type MemoryTimeDeclaration = {
	readonly occurredAt: number | null;
	readonly recordedAt: number | null;
	readonly effectiveFrom: number | null;
	readonly effectiveTo: number | null;
};

export const EMPTY_TIME: MemoryTimeDeclaration = { occurredAt: null, recordedAt: null, effectiveFrom: null, effectiveTo: null };

/** 一条验证（复用现有 `ValidationRecord` 的语义，只保留决策需要的部分）。 */
export type MemoryValidationRef = {
	readonly kind: ValidationKind;
	readonly result: ValidationResult;
	readonly performedAt: number;
};

/** 该验证/结论**显式声明**依赖的工程快照。未列出的维度不参与漂移判定。 */
export type MemoryDependencySnapshot = {
	readonly commit: string | null;
	readonly boardRevision: string | null;
	readonly buildTarget: string | null;
	readonly contentHashes: readonly string[];
};

/** 证据引用（只保留决策需要的：是否可用 + 是否与本次比较相关）。 */
export type MemoryEvidenceRef = {
	readonly validity: EvidenceValidity;
	readonly contentHash: string | null;
};

/** 目标上下文（查询方声明的"当前工程"）。 */
export type MemoryTargetContext = {
	readonly scope: MemoryScopeDeclaration;
	/** 目标代码/板卡快照，用于验证漂移判定。 */
	readonly snapshot: MemoryDependencySnapshot;
};

/** 人工确认字段（用于"确认值不被新候选覆盖"）。 */
export type MemoryConfirmedField = {
	readonly field: string;
	readonly value: string | null;
	readonly status: FieldStatus;
};

/**
 * 一条候选依据。
 *
 * 三个身份在这里各归其位（BM-M1 / R27-1）：
 * - **记录身份** = `family` + `recordId` + `revision`（去重、版本淘汰、关系端点都用它）；
 * - **事实身份** = `factKey`（调用方给的业务属性键）+ 范围重叠；
 *   它是**业务**键，故意不按记录族加前缀：一条人工确认的档案字段和一条新检测候选
 *   必须能落在同一个事实上（否则"确认值 vs 新候选"就永远对不上）；
 * - **字段粒度** = 同一条档案记录可以承载多个事实（每个 `factKey` 一个），
 *   因此不需要为了"每个字段一条记录"去伪造磁盘上并不存在的记录 ID。
 */
export type MemoryCandidate = {
	readonly family: MemoryRecordFamily;
	readonly recordId: string;
	readonly revision: number;
	/** 调用方声明的读取权威性（纯模块不自行证明磁盘复核）。 */
	readonly authority: "authoritative-read" | "unverified" | "unreadable";
	readonly sourceFingerprint: string | null;
	/** 记录状态：`deprecated` 一律不进入当前推荐；`draft`/`unknown` 经验不是当前工程依据。 */
	readonly status: "draft" | "reviewed" | "verified" | "deprecated" | "unknown";
	readonly scope: MemoryScopeDeclaration;
	readonly reuse: MemoryReuseDeclaration;
	readonly time: MemoryTimeDeclaration;
	/**
	 * 该记录**承载的字段级事实**的人工确认状态。
	 *
	 * `factKey` 命中的那条条目的 `status` 决定这个事实是否算"人工确认值"：
	 * `confirmed` = 人工确认；`candidate`/`unknown` = 候选或未知（不能作为当前依据）。
	 */
	readonly confirmedFields: readonly MemoryConfirmedField[];
	readonly validations: readonly MemoryValidationRef[];
	readonly evidence: readonly MemoryEvidenceRef[];
	/** 结论/验证依赖的快照；`null` = 未声明（不能宣称当前硬件验证通过）。 */
	readonly dependencySnapshot: MemoryDependencySnapshot | null;
	/** 若本候选是某个会话摘要的派生物，这里给出被摘要的记录 ID（用于"撤回不因旧摘要复活"）。 */
	readonly derivedFromSummaryOf: string | null;
	/** 事实键：调用方给的**业务**属性键（例如 `"project-profile.boardName"`）。`null` = 本条不承载字段级事实。 */
	readonly factKey: string | null;
	readonly value: string | null;
	/** 受控短标题（可能含客户信息，因此未授权时不得出现在任何输出面）。 */
	readonly title: string | null;
};

/** 一条候选的记录身份。 */
export function candidateRef(candidate: MemoryCandidate): MemoryRecordRef {
	return { family: candidate.family, recordId: candidate.recordId, revision: candidate.revision };
}

/**
 * 替代/撤回关系：**两端**都必须是具名的记录身份（族 + ID + revision）+ 作用范围。
 *
 * 为什么不允许"只写目标"或"只写一个 ID"：关系是"谁在什么时候作废了谁"的断言，
 * 端点不可解析时它就不是一条可用的断言（见 R27-2）；把它降级成"随手忽略"或
 * "旧事实继续有效"都会产生虚假确定性。
 */
export type MemoryRelation = {
	readonly type: "supersedes" | "retracts";
	/** 声明方（新的/撤回方）：必须能在候选里解析到，且自身是当前有效的权威读取。 */
	readonly source: MemoryRecordRef;
	/** 被作用方：必须能解析到一条候选，否则这条关系不作用于任何可见事实。 */
	readonly target: MemoryRecordRef;
	readonly scope: MemoryScopeDeclaration;
};

export type MemoryQuery = {
	/** `current`：只给当前适用结论；`history`：显式查看被替代/撤回/旧状态（仍受授权约束）。 */
	readonly intent: "current" | "history";
	/** 查询时间由调用方传入（纯模块不读时钟）。 */
	readonly now: number;
	readonly target: MemoryTargetContext;
	readonly authorization: MemoryAuthorization;
	readonly candidates: readonly MemoryCandidate[];
	readonly relations: readonly MemoryRelation[];
	readonly limits?: Partial<MemoryLimits>;
};

/* ------------------------------------------------------------------ 输出 */

/** 受控原因码（固定枚举；调用方按码分流，不解析文案）。 */
export type MemoryReasonCode =
	| "unauthorized-customer"
	| "unauthorized-internal-general"
	| "endpoint-denied"
	| "endpoint-unknown"
	| "scope-mismatch"
	| "scope-unknown"
	| "legacy-unspecified"
	| "not-yet-effective"
	| "expired"
	| "deprecated"
	/** 经验卡的审核状态不是 reviewed/verified ⇒ 不能作为当前工程依据（与"字段未确认"分开）。 */
	| "not-reviewed"
	/** 字段级事实不是人工确认值（检测候选 / 未确认字段）⇒ 只能提示，不能当当前事实。 */
	| "field-unconfirmed"
	| "superseded"
	| "retracted"
	| "needs-confirmation"
	| "conflict"
	/** 当前可见的同工作区/同范围整卡正文存在分歧，需人工比较证据。 */
	| "possible-content-conflict"
	| "verification-drift"
	| "evidence-unavailable"
	| "authority-unreadable"
	| "authority-unverified"
	/** 关系两端无法解析（缺失 / 未授权 / 不可读 / 版本对不上）⇒ 不能确认，也不能当作"没有关系"。 */
	| "unresolved-relation"
	/** 关系端点可解析，但声明方自身不是当前有效事实（未审核 / 已过期 / 旧版本…）⇒ 不能冒充明确替代。 */
	| "relation-not-effective"
	/** 多条适用关系互相矛盾（替代 vs 撤回，或成环）⇒ 保留矛盾，不挑一条赢。 */
	| "relation-ambiguous"
	| "relation-chain-truncated"
	| "older-revision"
	/** 该记录可授权的最高版本不可读 ⇒ 旧版本不得因此复活成当前结论。 */
	| "higher-revision-unreadable"
	| "history-record"
	| "summary-derived"
	| "title-truncated";

/** 决策分类：**当前可用依据 / 仅供参考 / 需复核 / 冲突 / 显式历史 / 排除**。 */
export type MemoryDecisionClass = "current" | "reference" | "needs-review" | "conflict" | "history" | "excluded";

/** 验证适用性：与"事实是否有效"分开报告，不揉成一个置信度。 */
export type MemoryVerificationView = {
	/** 范围内是否仍有可用验证（按依赖快照判定）。 */
	readonly status: "in-scope" | "drifted" | "unavailable" | "none";
	/**
	 * 通过的最强验证类别：`compile` 永远不会被报成 `board-boot`。
	 * `null` = 没有通过任何验证（**不**等于"验证失败"）。
	 */
	readonly strongestPassed: ValidationKind | null;
};

export type MemoryDecision = {
	readonly family: MemoryRecordFamily;
	readonly recordId: string;
	readonly revision: number;
	/**
	 * 该条目承载**字段级事实**时的业务事实键（调用方自己的输入键）；`null` = 记录级条目。
	 *
	 * 必须出现在结果里：一条档案记录可能承载多个事实（字段），
	 * 没有它就无法把两个条目对应回各自的字段，排序也就失去稳定的决胜字段。
	 */
	readonly factKey: string | null;
	readonly class: MemoryDecisionClass;
	readonly reasons: readonly MemoryReasonCode[];
	readonly reasonsTruncated: boolean;
	readonly verification: MemoryVerificationView;
	/** 仅在"允许返回"时给出；否则为 `null`。 */
	readonly title: string | null;
	readonly titleTruncated: boolean;
};

export type MemoryDecisionResult = {
	readonly intent: "current" | "history";
	/** `incomplete` 表示预算触顶（候选/关系/输出），此时结论**不能**当成完整。 */
	readonly status: "ok" | "incomplete";
	readonly items: readonly MemoryDecision[];
	/** 未进入 `items` 的候选数（只统计**已授权**的，避免用计数泄漏未授权材料）。 */
	readonly dropped: number;
	readonly limits: MemoryLimits;
};
