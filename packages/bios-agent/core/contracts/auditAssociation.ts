/**
 * 审核关联与幂等认领的**纯**比较（BM-02C2AR / C2AR-2）。
 *
 * 解决第十轮 A2/A3 两件事：
 * - **A2**：不能拿"字节相同"当幂等条件。发布事实（`publication` / `recordedAt`）每次都不同，
 *   用它比字节必然误报冲突；反过来把已有 writer 事件改写成 recovery 又是在改写发布历史。
 *   正确规则：**不存在事件**时才由未来 IO 生成发布事实；**已有事件**先完整校验，再逐项比较
 *   **稳定决定字段**（`AUDIT_INTENT_DECISION_FIELDS`），匹配就认领它**原有的** publication/recordedAt。
 * - **A3**：不能靠"intent 文件在不在"判断这是不是审核写。审核必须能被证明属于某次提交：
 *   未来的审核 journal v2 携带受控关联投影（operationId / eventId / 受控 intent 文件名 /
 *   **intent 原字节的真实指纹** / target / before / after），本模块把它与意图、已有事件三方对齐。
 *
 * 三条边界，读代码前先看：
 * 1. **不接收磁盘路径**：输入是三份**已解析的值**（意图、投影、已有事件）外加一个由未来 IO 层
 *    测量并传入的 `intentBytesHash`。本模块不读盘、不计算哈希、不生成时间戳。
 * 2. **不把声明当作证明**：`intentHash` 是投影里的**声明值**，只有把它与 IO 层实际读到的字节指纹
 *    比对之后才有意义；本模块只做这次比较，不会把任意一方单独当证据。
 * 3. **投影不是完整 v2 记录**：它只是"未来已通过 v2 结构校验的 journal"提供的关联视图，
 *    不能拿它绕过 v2 自身的结构校验，也不能据此推断 v2 的其它字段。
 */
import { type Static, Type } from "typebox";
import { UuidSchema } from "./ids.ts";
import { AUDIT_HASH_LENGTH, AUDIT_HASH_PATTERN_SOURCE, AUDIT_MAX_ISSUES, AuditFingerprintSchema, AuditTargetSchema, type AuditEvidenceRef, type AuditEvent, type AuditFingerprint, type AuditTarget } from "./audit.ts";
import { AUDIT_INTENT_NAME_LENGTH, AUDIT_INTENT_PURPOSE, auditIntentFileName, validateAuditIntent, type AuditIntent } from "./auditIntent.ts";
import { auditIssue, collectAuditRevisionIssues, collectSchemaIssues, validateAuditEvent, type AuditIssue, type AuditIssueCode } from "./auditValidation.ts";

/** 未来审核专用 journal 的版本号。**本轮只定义协议**，不实现 v2 的读写，也不改现有 v1。 */
export const AUDIT_JOURNAL_V2_VERSION = 2;

/**
 * 未来 journal v2 提供的**审核关联投影**。
 *
 * 只回答"这次提交绑定了哪条意图、哪条事件、哪个目标、哪两个版本"，
 * 不重复 v2 的其它字段（写入意图、时间、清理状态等仍由 v2 自己负责）。
 */
export const AuditJournalReviewProjectionSchema = Type.Object(
	{
		journalVersion: Type.Literal(AUDIT_JOURNAL_V2_VERSION),
		journalPurpose: Type.Literal(AUDIT_INTENT_PURPOSE),
		operationId: UuidSchema,
		eventId: UuidSchema,
		/** 受控派生的意图文件名：必须恰好等于 `<operationId>.json`（见语义校验）。 */
		intentName: Type.String({ minLength: AUDIT_INTENT_NAME_LENGTH, maxLength: AUDIT_INTENT_NAME_LENGTH }),
		/** 持久意图时绑定的**真实字节** SHA-256 声明值；只有与 IO 层实测值相等才可信。 */
		intentHash: Type.String({ minLength: AUDIT_HASH_LENGTH, maxLength: AUDIT_HASH_LENGTH, pattern: AUDIT_HASH_PATTERN_SOURCE }),
		target: AuditTargetSchema,
		before: AuditFingerprintSchema,
		after: AuditFingerprintSchema,
	},
	{ additionalProperties: false },
);
export type AuditJournalReviewProjection = Static<typeof AuditJournalReviewProjectionSchema>;

const HASH_REGEX = new RegExp(AUDIT_HASH_PATTERN_SOURCE);

/** 读取 `journalVersion`；非正整数一律视为缺失。 */
export function readJournalVersion(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).journalVersion;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
	return raw;
}

export type AuditProjectionValidation = { ok: true; value: AuditJournalReviewProjection } | { ok: false; issues: AuditIssue[]; droppedIssues: number };

/**
 * 校验关联投影（纯函数，不修改输入）。
 *
 * 版本闸门先行：`journalVersion !== 2` 一律 `unsupported-journal-version`。
 * 这条同样是**旧恢复器的行为要求**：现有 C1 恢复器对 v2 必须当作未知版本保守拒绝，
 * 不能"读不懂就当 v1 普通写收口"（否则审核 journal 会被静默降级成普通写）。
 */
export function validateAuditJournalProjection(input: unknown): AuditProjectionValidation {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		return { ok: false, issues: [auditIssue("invalid-audit-projection", "", "关联投影必须是普通对象（不是数组/null/标量）")], droppedIssues: 0 };
	}
	const version = readJournalVersion(input);
	if (version === undefined) {
		return { ok: false, issues: [auditIssue("invalid-audit-projection", "/journalVersion", "缺少 journalVersion：无法判断这是不是审核专用 journal")], droppedIssues: 0 };
	}
	if (version !== AUDIT_JOURNAL_V2_VERSION) {
		return {
			ok: false,
			issues: [auditIssue("unsupported-journal-version", "/journalVersion", `journalVersion=${version} 不是审核关联支持的 ${AUDIT_JOURNAL_V2_VERSION}；未知版本一律拒绝解释`)],
			droppedIssues: 0,
		};
	}

	const shape = collectSchemaIssues(AuditJournalReviewProjectionSchema, input, "invalid-audit-projection");
	if (!shape.ok) return { ok: false, issues: shape.issues, droppedIssues: shape.dropped };

	const projection = input as AuditJournalReviewProjection;
	const issues: AuditIssue[] = [];
	// 受控派生：文件名不允许由数据自由给出，必须与 operationId 一致。
	if (projection.intentName !== auditIntentFileName(projection.operationId)) {
		issues.push(auditIssue("audit-association-mismatch", "/intentName", "intentName 必须由 operationId 派生（<operationId>.json），不接受调用方指定路径"));
	}
	issues.push(...collectAuditRevisionIssues(projection.before, projection.after));
	if (issues.length > 0) return { ok: false, issues: issues.slice(0, AUDIT_MAX_ISSUES), droppedIssues: Math.max(0, issues.length - AUDIT_MAX_ISSUES) };
	return { ok: true, value: projection };
}

export type AuditAssociationInput = {
	/** 审核意图（**未校验**原始值；本模块自己校验）。 */
	readonly intent: unknown;
	/** 未来 journal v2 的关联投影（**未校验**原始值）。 */
	readonly projection: unknown;
	/** 已存在的审计事件；没有读到事件时必须是 `null`（用 `undefined` 表示"没读到"会掩盖调用方错误）。 */
	readonly existingEvent: unknown | null;
	/** 本次**实际读到**的意图原字节 SHA-256，由未来 IO 层测量后传入（本模块不计算哈希）。 */
	readonly intentBytesHash: unknown;
};

/**
 * 关联判定结果。判别联合，避免用一个对象里的可选字段暗示"发布已经发生"：
 * - `publish`：**没有**已有事件 ⇒ 未来 IO 必须为本次发布生成 `publication` 与 `recordedAt`；
 *   本结果**不携带任何发布事实**（不预支、不猜测来源）。
 * - `claim`：已存在**完整合法且决定一致**的事件 ⇒ 调用方认领它，并**原样保留**其
 *   `publication` 与 `recordedAt`（不重新生成、不以当前恢复时间替换）。
 * - 失败：`code` 取首个失败阶段的 code，完整列表在 `issues`。
 */
export type AuditAssociationResult = { ok: true; kind: "publish" } | { ok: true; kind: "claim"; event: AuditEvent } | { ok: false; code: AuditIssueCode; issues: readonly AuditIssue[]; droppedIssues: number };

function fail(issues: readonly AuditIssue[], droppedIssues = 0): AuditAssociationResult {
	const kept = issues.slice(0, AUDIT_MAX_ISSUES);
	return { ok: false, code: kept[0]?.code ?? "invalid-audit", issues: kept, droppedIssues: droppedIssues + Math.max(0, issues.length - kept.length) };
}

function fingerprintPaths(prefix: string, left: AuditFingerprint, right: AuditFingerprint): string[] {
	const paths: string[] = [];
	if (left.revision !== right.revision) paths.push(`${prefix}/revision`);
	if (left.hash !== right.hash) paths.push(`${prefix}/hash`);
	return paths;
}

/** 同一 key 集合的结构比较：**对象键顺序不影响结论**（决定的相等性不取决于写法）。 */
function sameEvidenceRef(left: AuditEvidenceRef, right: AuditEvidenceRef): boolean {
	return left.kind === right.kind && left.index === right.index && left.recordId === right.recordId && left.note === right.note;
}

/**
 * 证据数组：**顺序有意义**（逐项按下标匹配）。
 *
 * 顺序被固定为有意义，而不是"排序后比较"：证据的排列本身携带"先看哪条"的意图，
 * 排序会把两个不同的决定判成同一个。
 */
function evidenceEquals(left: readonly AuditEvidenceRef[], right: readonly AuditEvidenceRef[]): boolean {
	if (left.length !== right.length) return false;
	return left.every((entry, index) => sameEvidenceRef(entry, right[index] as AuditEvidenceRef));
}

/** 投影与意图的身份对齐：operationId / eventId / target / before / after。 */
function collectIdentityIssues(intent: AuditIntent, projection: AuditJournalReviewProjection): AuditIssue[] {
	const issues: AuditIssue[] = [];
	if (projection.operationId !== intent.operationId) issues.push(auditIssue("audit-association-mismatch", "/operationId", "投影的 operationId 与意图不一致：不能证明这条意图属于那次提交"));
	if (projection.eventId !== intent.eventId) issues.push(auditIssue("audit-association-mismatch", "/eventId", "投影的 eventId 与意图不一致：不能据此发布/认领这条决定"));
	if (projection.target.kind !== intent.target.kind || projection.target.recordId !== intent.target.recordId) {
		issues.push(auditIssue("audit-association-mismatch", "/target/recordId", "投影的目标与意图不一致：不接受对别的记录发布人工审核事实"));
	}
	for (const path of fingerprintPaths("/before", intent.before, projection.before)) issues.push(auditIssue("audit-association-mismatch", path, "投影的 before 与意图不一致"));
	for (const path of fingerprintPaths("/after", intent.after, projection.after)) issues.push(auditIssue("audit-association-mismatch", path, "投影的 after 与意图不一致"));
	return issues;
}

/**
 * 已有事件与意图的**稳定决定字段**逐项比较。
 *
 * 刻意逐字段列出（而不是整对象比较）：整对象比较会把 `publication` / `recordedAt` 也拉进来，
 * 于是"同一次决定、由不同发布者写出的事件"会被误判成冲突；逐字段也让诊断能指出到底哪一项不同。
 */
function collectDecisionIssues(intent: AuditIntent, event: AuditEvent): AuditIssue[] {
	const issues: AuditIssue[] = [];
	const conflict = (path: string, what: string): void => {
		issues.push(auditIssue("audit-decision-conflict", path, `已有事件的「${what}」与本次意图不同：属于冲突，既不认领也不覆盖，交人工判断`));
	};
	if (event.operationId !== intent.operationId) conflict("/operationId", "operationId");
	if (event.eventId !== intent.eventId) conflict("/eventId", "eventId");
	if (event.target.kind !== intent.target.kind || event.target.recordId !== intent.target.recordId) conflict("/target/recordId", "目标");
	if (event.action !== intent.action) conflict("/action", "动作");
	if (event.fromStatus !== intent.fromStatus || event.toStatus !== intent.toStatus) conflict("/action", "状态对");
	if (event.operatorLabel !== intent.operatorLabel) conflict("/operatorLabel", "操作者标签");
	if (event.decidedAt !== intent.decidedAt) conflict("/decidedAt", "决定时间");
	if (event.reason !== intent.reason) conflict("/reason", "理由");
	for (const path of fingerprintPaths("/before", intent.before, event.before)) conflict(path, "before 指纹");
	for (const path of fingerprintPaths("/after", intent.after, event.after)) conflict(path, "after 指纹");
	if (!evidenceEquals(intent.evidence, event.evidence)) conflict("/evidence", "证据关联");
	return issues;
}

/**
 * 关联判定入口（纯函数）：意图 + 关联投影 + 已有事件 + 实测意图字节指纹。
 *
 * 判定顺序（固定，调用方可依赖）：
 * 1. 校验意图（拒绝未知版本/结构/未知字段/预算超限）；
 * 2. 校验投影（拒绝非 v2 版本、非法派生名、非法结构）；
 * 3. 实测意图字节指纹的格式与"声明 == 实测"；
 * 4. 投影与意图的身份对齐；
 * 5. 没有已有事件 ⇒ `publish`（**不生成**发布事实）；
 * 6. 有已有事件 ⇒ 先完整校验事件，再比较稳定决定字段；一致 ⇒ `claim`（保留其原始发布事实），
 *    不一致 ⇒ `audit-decision-conflict`。
 */
export function compareAuditAssociation(input: AuditAssociationInput): AuditAssociationResult {
	const intentResult = validateAuditIntent(input.intent);
	if (!intentResult.ok) return fail(intentResult.issues, intentResult.droppedIssues);

	const projectionResult = validateAuditJournalProjection(input.projection);
	if (!projectionResult.ok) return fail(projectionResult.issues, projectionResult.droppedIssues);

	if (typeof input.intentBytesHash !== "string" || !HASH_REGEX.test(input.intentBytesHash)) {
		return fail([auditIssue("invalid-intent-hash", "/intentHash", "intentBytesHash 必须是 64 位小写十六进制 SHA-256（由 IO 层实测意图原字节得出）")]);
	}
	if (input.intentBytesHash !== projectionResult.value.intentHash) {
		return fail([auditIssue("audit-association-mismatch", "/intentHash", "投影绑定的 intent 指纹与本次实际读到的意图字节不一致：意图可能被替换，拒绝发布人工决定")]);
	}

	const identityIssues = collectIdentityIssues(intentResult.value, projectionResult.value);
	if (identityIssues.length > 0) return fail(identityIssues);

	if (input.existingEvent === null) return { ok: true, kind: "publish" };

	const eventResult = validateAuditEvent(input.existingEvent);
	if (!eventResult.ok) return fail(eventResult.issues, eventResult.droppedIssues);

	const decisionIssues = collectDecisionIssues(intentResult.value, eventResult.value);
	if (decisionIssues.length > 0) return fail(decisionIssues);

	// 认领：返回**原事件**，调用方读它的 publication/recordedAt 即为发布事实（不重新生成、不覆盖）。
	return { ok: true, kind: "claim", event: eventResult.value };
}

/** 便于测试与未来 IO 断言"哪些字段参与比较"。 */
export const AUDIT_ASSOCIATION_COMPARED_FIELDS = ["operationId", "eventId", "target", "before", "after"] as const;
export type AuditAssociationComparedField = (typeof AUDIT_ASSOCIATION_COMPARED_FIELDS)[number];

/** 便于调用方做类型收窄（避免外部再写一遍 as）。 */
export type AuditAssociationTarget = AuditTarget;
