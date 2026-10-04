/**
 * 审核审计事件的契约（BM-02C2A）。
 *
 * 为什么要有独立类别：C1 的 journal 只能回答"磁盘字节与写入意图是否一致"，
 * 它没有操作者、没有理由、也没有"决定"这个语义。**不能**拿 journal 的
 * `recovery-observed` 冒充一条人工审核记录，所以审计事实必须是自己的结构、
 * 自己的版本号（`auditVersion`），而不是往五类业务记录里塞第六类：
 * 那会让"审核历史"与"业务内容"共用同一套 revision/覆盖语义，历史迟早被后一次动作覆盖。
 *
 * 本轮只有**纯契约**：schema 与由 schema 推导的类型、动作/状态表、限额常量。
 * 语义校验在 `auditValidation.ts`；持久化（写盘/恢复）属 C2B，本文件不做任何 IO。
 */
import { type Static, Type } from "typebox";
import { ExperienceStatusSchema, type ExperienceStatus } from "./common.ts";
import { KnowledgeIdSchema, UuidSchema } from "./ids.ts";

/** 审计事件结构版本。与记录 `schemaVersion`、journal `journalVersion` **彼此独立**。 */
export const AUDIT_SCHEMA_VERSION = 1;

/** 首版审计只覆盖经验卡：它是唯一带审核状态机的记录类型。 */
export const AUDIT_TARGET_KIND = "experience-card";

/** SHA-256 十六进制长度与形态（与 C1 journal 的哈希口径一致：小写、64 位）。 */
export const AUDIT_HASH_LENGTH = 64;
export const AUDIT_HASH_PATTERN_SOURCE = "^[0-9a-f]{64}$";

/**
 * 单条事件的序列化字节上限（**兜底闸门**）。
 *
 * 16 KiB 的依据：审计只存**引用与短文本**（标签/理由/证据下标），领域内容本来就在业务记录里。
 *
 * 保守上界（C2AR-3 修正，替换掉此前"分项之和 ≈ 9.6 KiB"的错误论证）：
 * JSON 会给控制字符做 `\uXXXX` 转义，**每码元最多 6 字节**，因此"UTF-8 字节预算"不等于
 * "序列化字节预算"。按各字段的最坏膨胀相加：
 *
 * ```text
 * 信封（其余字段 + 缩进 + 换行）  ≤ 1024
 * 标签 128 码元 × 6              ≤ 768
 * 理由 512 码元 × 6              ≤ 3072
 * 证据（按序列化字节计量）        ≤ 8192
 *                             合计 ≤ 13056 < 16384 ✓
 * ```
 *
 * 这是从**预算常量**推出的算术上界，不是对 `JSON.stringify` 所有行为的证明；真正的兜底是这条闸门本身：
 * 万一算法算错，超限输入会被拒绝而不是落盘。当前它不可被合法输入触发（分项预算总是先报错），
 * 因此它也**不是**"每天都在生效"的规则——`tests/auditContracts.test.mjs` 同时断言
 * "保守上界 < 闸门"（不误报）与"控制字符样例实测 ≤ 保守上界"（上界不虚）。
 */
export const AUDIT_MAX_EVENT_BYTES = 16 * 1024;
/** 操作者标签：字符数与 UTF-8 字节**分别**限制（中文标签按字节更容易触顶）。 */
export const AUDIT_LABEL_MAX_CHARS = 128;
export const AUDIT_LABEL_MAX_BYTES = 256;
/**
 * 审核理由：同上，先限字符再限字节，超出即拒绝，不静默截断。
 *
 * 字节上限必须**严格小于 3 × 字符上限**：`maxLength` 按 UTF-16 码元计数，而一个码元最多
 * 贡献 3 字节（BMP 中的 3 字节字符；4 字节字符要占 2 个码元，反而更省字节）。
 * 所以 512 × 3 = 1536 是字符上限下**永远达不到**的字节数——取 1536 等于这条规则永远不触发。
 * 取 1024 后：341 个汉字（1023 B）合法，342 个汉字（1026 B）被拒，规则真正有效。
 * 标签同理（128 × 3 = 384 ⇒ 取 256）。
 */
export const AUDIT_REASON_MAX_CHARS = 512;
export const AUDIT_REASON_MAX_BYTES = 1024;
/** 证据关联：条数 + 总字节 + 单条说明长度三重上限。 */
export const AUDIT_EVIDENCE_MAX_ITEMS = 32;
export const AUDIT_EVIDENCE_MAX_BYTES = 8 * 1024;
export const AUDIT_EVIDENCE_NOTE_MAX_CHARS = 256;
/** 证据下标上界：只用于挡住"天文数字下标"，真实数组远小于此。 */
export const AUDIT_EVIDENCE_INDEX_MAX = 1_000_000;

/** 诊断输出上限：条数、单条消息长度（脱敏与防刷屏）。 */
export const AUDIT_MAX_ISSUES = 20;
export const AUDIT_ISSUE_MESSAGE_MAX_CHARS = 200;
/** 校验器最多扫描的结构错误数（超过即停止扫描，只保证"至少还有更多"）。 */
export const AUDIT_ISSUE_SCAN_LIMIT = 200;

/** 时间戳上界：`Date` 可表示的最大毫秒值，超出即无法格式化（与锁模块同一口径）。 */
export const AUDIT_MAX_DATE_MS = 8_640_000_000_000_000;

/** 事件的发布来源：写入方在提交点之后直接发布，还是恢复器依据已落盘的审核意图补发。 */
export const AuditPublicationSchema = Type.Union([Type.Literal("writer"), Type.Literal("recovery")]);
export type AuditPublication = Static<typeof AuditPublicationSchema>;

/** 审核动作。刻意**没有**"草稿直达通过"的动作：一步到底会让审计无法回答"谁在何时审的"。 */
export const AuditActionSchema = Type.Union([Type.Literal("submit-review"), Type.Literal("request-changes"), Type.Literal("approve"), Type.Literal("deprecate"), Type.Literal("restore")]);
export type AuditAction = Static<typeof AuditActionSchema>;

/** 证据关联的三种形态（互斥，见 `auditValidation.ts` 的跨字段规则）。 */
export const AuditEvidenceKindSchema = Type.Union([Type.Literal("record-evidence"), Type.Literal("record-validation"), Type.Literal("external-reference")]);
export type AuditEvidenceKind = Static<typeof AuditEvidenceKindSchema>;

export type AuditTransition = { readonly from: ExperienceStatus; readonly to: ExperienceStatus };

/**
 * 动作 → 合法 `(from, to)` 对的**唯一**来源。
 *
 * 为什么写成表而不是散在 if 里：恢复路径只能沿用已落盘意图，一个"当时允许、现在不允许"的
 * 动作会在恢复时被判成非法，从而把一条真实存在的人工决定丢掉。表是数据，改它必须同步
 * 改 `auditContracts.test.mjs` 的对照用例。
 */
export const AUDIT_ACTION_TRANSITIONS: Readonly<Record<AuditAction, readonly AuditTransition[]>> = {
	"submit-review": [{ from: "draft", to: "reviewed" }],
	"request-changes": [{ from: "reviewed", to: "draft" }],
	approve: [{ from: "reviewed", to: "verified" }],
	deprecate: [
		{ from: "reviewed", to: "deprecated" },
		{ from: "verified", to: "deprecated" },
	],
	restore: [{ from: "deprecated", to: "draft" }],
};

export function isAuditAction(value: unknown): value is AuditAction {
	return typeof value === "string" && Object.prototype.hasOwnProperty.call(AUDIT_ACTION_TRANSITIONS, value);
}

/** 动作与状态对是否合法（恢复期判定的同一份规则）。 */
export function isLegalAuditTransition(action: AuditAction, from: ExperienceStatus, to: ExperienceStatus): boolean {
	return AUDIT_ACTION_TRANSITIONS[action].some((transition) => transition.from === from && transition.to === to);
}

/** 受控的人类可读动作清单（诊断文案用；只含契约内的枚举，不含任何用户数据）。 */
export function describeAuditTransitions(): string {
	return Object.entries(AUDIT_ACTION_TRANSITIONS)
		.map(([action, transitions]) => `${action}: ${transitions.map((transition) => `${transition.from}→${transition.to}`).join("/")}`)
		.join("；");
}

/** `before`/`after` 指纹：审核是 update 关系，**不接受** null。 */
export const AuditFingerprintSchema = Type.Object(
	{
		// 显式写出 `maximum`：数值越界（负数、小数、2^53、1e100）由 schema 直接拒绝（`invalid-audit`），
		// 语义层只负责 schema 表达不了的关系（`after = before + 1`）与溢出（见 auditValidation.ts）。
		revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
		hash: Type.String({ minLength: AUDIT_HASH_LENGTH, maxLength: AUDIT_HASH_LENGTH, pattern: AUDIT_HASH_PATTERN_SOURCE }),
	},
	{ additionalProperties: false },
);
export type AuditFingerprint = Static<typeof AuditFingerprintSchema>;

/**
 * 受控目标：只有 kind + recordId。
 *
 * 为什么不允许出现任何路径字段：路径一旦由数据给出，"恢复时往哪里写"就变成了外部可控输入；
 * 真实路径只能由受控 ID 派生（C1 的 `journalTargetSegments` 是同一原则）。
 */
export const AuditTargetSchema = Type.Object(
	{
		kind: Type.Literal(AUDIT_TARGET_KIND),
		recordId: KnowledgeIdSchema,
	},
	{ additionalProperties: false },
);
export type AuditTarget = Static<typeof AuditTargetSchema>;

export const AuditEvidenceRefSchema = Type.Object(
	{
		kind: AuditEvidenceKindSchema,
		/** 仅 `record-evidence` / `record-validation` 使用：指向目标记录里的下标。 */
		index: Type.Optional(Type.Integer({ minimum: 0, maximum: AUDIT_EVIDENCE_INDEX_MAX })),
		/** 仅 `external-reference` 使用：指向另一条记录的 ID。 */
		recordId: Type.Optional(KnowledgeIdSchema),
		/** 简短说明（≤256 字符）。**不**复制源码/补丁/对话/日志正文。 */
		note: Type.Optional(Type.String({ minLength: 1, maxLength: AUDIT_EVIDENCE_NOTE_MAX_CHARS })),
	},
	{ additionalProperties: false },
);
export type AuditEvidenceRef = Static<typeof AuditEvidenceRefSchema>;

/**
 * 一条审核审计事件。
 *
 * `additionalProperties: false` 是刻意的：审计是外部可放置的数据，**未知字段一律拒绝**
 * （校验层会把未知字段名从诊断里隐去，见 `auditValidation.ts`）。
 */
export const AuditEventSchema = Type.Object(
	{
		auditVersion: Type.Integer({ minimum: 1 }),
		eventId: UuidSchema,
		/** 关联 C1 journal 的 operationId：把"这次决定"与"那次写入"绑在一起。 */
		operationId: UuidSchema,
		target: AuditTargetSchema,
		action: AuditActionSchema,
		fromStatus: ExperienceStatusSchema,
		toStatus: ExperienceStatusSchema,
		/** 声明的人工标签，**不是**身份认证。 */
		operatorLabel: Type.String({ minLength: 1, maxLength: AUDIT_LABEL_MAX_CHARS }),
		/** 人工动作时间：范围由 schema 拒绝（报 `invalid-audit`），先后关系由语义层拒绝（报 `audit-time-invalid`）。 */
		decidedAt: Type.Integer({ minimum: 0, maximum: AUDIT_MAX_DATE_MS }),
		reason: Type.String({ minLength: 1, maxLength: AUDIT_REASON_MAX_CHARS }),
		before: AuditFingerprintSchema,
		after: AuditFingerprintSchema,
		evidence: Type.Array(AuditEvidenceRefSchema, { maxItems: AUDIT_EVIDENCE_MAX_ITEMS }),
		publication: AuditPublicationSchema,
		/** 事件落盘时间：范围同 `decidedAt`。 */
		recordedAt: Type.Integer({ minimum: 0, maximum: AUDIT_MAX_DATE_MS }),
	},
	{ additionalProperties: false },
);
export type AuditEvent = Static<typeof AuditEventSchema>;

/** 读取 `auditVersion`；非正整数一律视为缺失（与记录头的 `readSchemaVersion` 同规则）。 */
export function readAuditVersion(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).auditVersion;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
	return raw;
}

/** 受控的人类可读目标标识（诊断用；不含正文）。 */
export function describeAuditTarget(target: AuditTarget): string {
	return `${target.kind}/${target.recordId}`;
}
