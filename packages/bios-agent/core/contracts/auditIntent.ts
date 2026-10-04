/**
 * 审核**意图**的契约（BM-02C2AR / C2AR-2）。
 *
 * 为什么意图必须与事件分开：
 * - 意图是"**人做了这个决定**"的落盘依据，必须在业务提交点之前存在，否则崩溃后没人能证明该改什么状态；
 * - 事件是"**这条决定已经按这个身份、在这个时间被发布**"的事实。`publication` / `recordedAt` 属于发布事实，
 *   在意图还没有被发布时**不存在**——把它写进意图等于在意图里预支一个尚未发生的发布。
 * 因此：意图 = 事件的**稳定决定字段**（谁/何时决定/理由/动作/目标/前后指纹/证据），**不含** publication/recordedAt。
 *
 * 与事件的关系（唯一来源，不重复造第二套类型）：
 * - 目标、指纹、证据、动作枚举全部**复用** `audit.ts` 的 schema；
 * - 语义规则（动作↔状态对、`after = before + 1`、文本/证据/总量预算）复用 `auditValidation.ts` 的同一份实现，
 *   保证"意图能落盘"与"事件能落盘"不会出现两套宽严不同的门槛。
 *
 * 本文件仍然**没有 IO**：不读盘、不生成 eventId/operationId、不写时间戳。
 */
import { type Static, Type } from "typebox";
import { ExperienceStatusSchema } from "./common.ts";
import { UuidSchema } from "./ids.ts";
import {
	AUDIT_EVIDENCE_MAX_ITEMS,
	AUDIT_HASH_PATTERN_SOURCE,
	AUDIT_LABEL_MAX_CHARS,
	AUDIT_MAX_DATE_MS,
	AUDIT_MAX_EVENT_BYTES,
	AUDIT_MAX_ISSUES,
	AUDIT_REASON_MAX_CHARS,
	AuditActionSchema,
	AuditEvidenceRefSchema,
	AuditFingerprintSchema,
	AuditTargetSchema,
	isLegalAuditTransition,
	type AuditAction,
	type AuditEvidenceRef,
	type AuditFingerprint,
	type AuditTarget,
} from "./audit.ts";
import { auditIssue, collectAuditEvidenceIssues, collectAuditRevisionIssues, collectAuditTextIssues, collectSchemaIssues, measureAuditEventBytes, type AuditIssue } from "./auditValidation.ts";

/** 意图结构版本。与事件 `auditVersion`、journal `journalVersion` 彼此独立。 */
export const AUDIT_INTENT_SCHEMA_VERSION = 1;

/** 意图用途。首版只有"审核"一种；未来若出现别的用途，必须新增 literal 而不是放宽成自由字符串。 */
export const AUDIT_INTENT_PURPOSE = "review";

/**
 * 单条意图的序列化字节上限。
 *
 * 与事件同量级的理由相同：意图也只存引用与短文本，领域内容留在业务记录里。
 * 两者共用同一个数值**不是**为了省一个常量，而是因为意图是事件的子集（少了 publication/recordedAt），
 * 允许意图比事件更大没有任何可解释的场景。
 */
export const AUDIT_MAX_INTENT_BYTES = AUDIT_MAX_EVENT_BYTES;

/** 意图文件名长度：36 位 UUID + `.json`。 */
export const AUDIT_INTENT_NAME_LENGTH = 41;

/**
 * 受控派生：意图文件名**只能**由 operationId 得来。
 *
 * 未来审计与恢复都必须用这个函数（或等价的唯一来源）决定"读哪个意图文件"，
 * 不允许由数据给出路径——否则"恢复时读哪里"就变成外部可控输入。
 */
export function auditIntentFileName(operationId: string): string {
	return `${operationId}.json`;
}

/**
 * 审核意图。
 *
 * `additionalProperties: false` 与事件同义：意图同样是外部可放置的数据，未知字段一律拒绝。
 */
export const AuditIntentSchema = Type.Object(
	{
		intentVersion: Type.Integer({ minimum: 1 }),
		purpose: Type.Literal(AUDIT_INTENT_PURPOSE),
		/** 决定的事件身份：与最终事件必须一致，用于"同一次决定"的幂等锚点。 */
		eventId: UuidSchema,
		/** 关联 C1 journal 的 operationId（也是意图文件名的来源）。 */
		operationId: UuidSchema,
		target: AuditTargetSchema,
		action: AuditActionSchema,
		fromStatus: ExperienceStatusSchema,
		toStatus: ExperienceStatusSchema,
		operatorLabel: Type.String({ minLength: 1, maxLength: AUDIT_LABEL_MAX_CHARS }),
		decidedAt: Type.Integer({ minimum: 0, maximum: AUDIT_MAX_DATE_MS }),
		reason: Type.String({ minLength: 1, maxLength: AUDIT_REASON_MAX_CHARS }),
		before: AuditFingerprintSchema,
		after: AuditFingerprintSchema,
		evidence: Type.Array(AuditEvidenceRefSchema, { maxItems: AUDIT_EVIDENCE_MAX_ITEMS }),
	},
	{ additionalProperties: false },
);
export type AuditIntent = Static<typeof AuditIntentSchema>;

/**
 * **稳定决定字段**：意图与事件之间必须逐项相等的那一组。
 *
 * `publication` / `recordedAt` 刻意不在表里：它们是**发布事实**，由实际发布者在其发布时刻填写；
 * 拿恢复时间或"应当是什么来源"去覆盖已有事件，等于改写发布历史（第十轮 A2）。
 */
export const AUDIT_INTENT_DECISION_FIELDS = ["operationId", "eventId", "target", "action", "fromStatus", "toStatus", "operatorLabel", "decidedAt", "reason", "before", "after", "evidence"] as const;
export type AuditIntentDecisionField = (typeof AUDIT_INTENT_DECISION_FIELDS)[number];

/** 读取 `intentVersion`；非正整数一律视为缺失（与事件/记录同规则）。 */
export function readAuditIntentVersion(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).intentVersion;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
	return raw;
}

export type AuditIntentValidation = { ok: true; value: AuditIntent } | { ok: false; issues: AuditIssue[]; droppedIssues: number };

/**
 * 校验一条审核意图（**纯函数**，接受 `unknown`，不修改输入）。
 *
 * 顺序与事件校验一致：根形态 → 版本闸门 → 结构 → 语义/预算。
 *
 * 注意：校验通过**不等于**这条意图曾经被发布，也不等于它属于某次已提交的写入——
 * "属于哪次写入"由未来的 journal v2 关联投影证明（见 `auditAssociation.ts`），
 * 本函数返回的是**意图本身**，不会伪造 `publication` / `recordedAt`。
 */
export function validateAuditIntent(input: unknown): AuditIntentValidation {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, issues: [auditIssue("invalid-audit-intent", "", "审核意图必须是普通对象（不是数组/null/标量）")], droppedIssues: 0 };
	}

	const version = readAuditIntentVersion(input);
	if (version === undefined) {
		return { ok: false, issues: [auditIssue("invalid-audit-intent-version", "/intentVersion", "intentVersion 必须是 >= 1 的整数")], droppedIssues: 0 };
	}
	if (version !== AUDIT_INTENT_SCHEMA_VERSION) {
		return {
			ok: false,
			issues: [auditIssue("unsupported-audit-intent-version", "/intentVersion", `intentVersion=${version} 不是本实现支持的 ${AUDIT_INTENT_SCHEMA_VERSION}，拒绝解释（不按当前版本猜测字段）`)],
			droppedIssues: 0,
		};
	}

	const shape = collectSchemaIssues(AuditIntentSchema, input, "invalid-audit-intent");
	if (!shape.ok) return { ok: false, issues: shape.issues, droppedIssues: shape.dropped };

	// 类型收窄说明：上面用同一份 schema 枚举错误、结果为空即"结构合法"；
	// 这是 typebox 表驱动校验的类型损失，不是绕过校验。
	const intent = input as AuditIntent;
	const issues: AuditIssue[] = [];
	if (!isLegalAuditTransition(intent.action, intent.fromStatus, intent.toStatus)) {
		issues.push(auditIssue("audit-action-mismatch", "/action", `${intent.action} 与 ${intent.fromStatus}→${intent.toStatus} 不成对合法（合法对见 AUDIT_ACTION_TRANSITIONS）`));
	}
	issues.push(...collectAuditRevisionIssues(intent.before, intent.after));
	issues.push(...collectAuditTextIssues(intent.operatorLabel, intent.reason));
	issues.push(...collectAuditEvidenceIssues(intent.evidence));
	if (issues.length > 0) {
		const kept = issues.slice(0, AUDIT_MAX_ISSUES);
		return { ok: false, issues: kept, droppedIssues: issues.length - kept.length };
	}

	const bytes = measureAuditEventBytes(intent);
	if (bytes === undefined) return { ok: false, issues: [auditIssue("invalid-audit-intent", "", "意图无法序列化")], droppedIssues: 0 };
	if (bytes > AUDIT_MAX_INTENT_BYTES) {
		return { ok: false, issues: [auditIssue("audit-too-large", "", `单条审核意图的序列化字节超过 ${AUDIT_MAX_INTENT_BYTES} 上限，拒绝写入（不截断后假称原始决定完整）`)], droppedIssues: 0 };
	}
	return { ok: true, value: intent };
}

export function isValidAuditIntent(input: unknown): boolean {
	return validateAuditIntent(input).ok;
}

/** 受控的人类可读摘要（诊断用；只含枚举与受控 ID，不含理由/标签正文）。 */
export function describeAuditIntent(intent: AuditIntent): string {
	return `${intent.action} ${intent.fromStatus}→${intent.toStatus} @${intent.target.kind}/${intent.target.recordId} r${intent.before.revision}→r${intent.after.revision} publication=pending`;
}

/** 重新导出：未来 IO 层需要同一份哈希口径来测量**实际读到**的意图字节。 */
export { AUDIT_HASH_PATTERN_SOURCE };

/** 便于调用方做类型收窄（与事件校验同风格）。 */
export type AuditIntentAction = AuditAction;
export type AuditIntentEvidence = AuditEvidenceRef;
export type AuditIntentFingerprint = AuditFingerprint;
export type AuditIntentTarget = AuditTarget;
