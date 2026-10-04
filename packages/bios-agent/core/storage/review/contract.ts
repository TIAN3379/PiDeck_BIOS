/**
 * 审核专用 journal v2 的**纯契约**（BM-02C2B / C2B-1）。
 *
 * 为什么普通写继续用 v1、审核另立 v2：
 * v1 只回答"磁盘字节与写入意图是否一致"，它没有操作者、没有理由，也没有"这是哪条审计事件"
 * 的身份。审核要在崩溃后**补发一条人工决定**，因此 journal 必须额外携带可验证的绑定：
 * 事件 ID、受控意图文件名、意图原字节指纹。把这些字段塞进 v1 会让普通写凭空多出四个
 * 自己填不出的必填项（等于强制迁移），所以 v2 是一份**并列的新版本**：
 *
 * - v1（`journal/contract.ts`）：普通记录/registry 的写入意图，字段与解释**一行未改**；
 * - v2（本文件）：只用于 `recordReviewDecision`，`journalPurpose: "review"` 是判别位。
 *
 * 三条硬约束（与 C2AR 的协议一致，改动前先读 bm02c2a_implementation.md §3）：
 * 1. **判别位必填**：没有 `journalPurpose` 的记录一律不是审核 journal，不允许"猜"；
 * 2. **绑定必须完整**：`eventId` + 受控派生的 `intentName` + `intentHash` + `target/before/after`
 *    缺一不可——恢复侧要靠它们证明"这条意图属于这次提交"；
 * 3. **旧恢复器必须拒绝 v2**：v1 的 `validateJournalRecord` 对 `journalVersion !== 1` 报
 *    `unsupported-journal-version`（现状即如此），因此本文件**不修改** v1 的任何规则。
 *
 * 纯函数、无 IO：读写与判定分别在 `artifacts.ts` / `writer.ts` / `reconcile.ts`。
 */
import { type Static, Type } from "typebox";
import {
	AUDIT_HASH_LENGTH,
	AUDIT_HASH_PATTERN_SOURCE,
	AUDIT_INTENT_NAME_LENGTH,
	AUDIT_INTENT_PURPOSE,
	AUDIT_JOURNAL_V2_VERSION,
	AUDIT_MAX_EVENT_BYTES,
	AUDIT_TARGET_KIND,
	auditIntentFileName,
	AuditFingerprintSchema,
	collectAuditRevisionIssues,
	collectSchemaIssues,
	type AuditIssue,
	type AuditIssueCode,
	type AuditJournalReviewProjection,
	type AuditPublication,
} from "../../contracts/index.ts";
import { KnowledgeIdSchema, UuidSchema } from "../../contracts/ids.ts";
import { validateShape } from "../../contracts/validate.ts";
import { StorageError } from "../errors.ts";
import { MAX_DATE_MS } from "../lock.ts";
import { JOURNAL_DIR_NAME, JOURNAL_FILE_SUFFIX, journalFileName } from "../journal/contract.ts";

/** 审核 journal 的版本号（唯一来源是契约里的协议常量，避免两处各写一个 2）。 */
export const REVIEW_JOURNAL_VERSION = AUDIT_JOURNAL_V2_VERSION;
/** 审核 journal 的判别位取值。 */
export const REVIEW_JOURNAL_PURPOSE = AUDIT_INTENT_PURPOSE;

/**
 * 审核工件的**硬**字节上限（C2BR / R1）。
 *
 * 为什么审核工件不能跟随可配置的 `maxJournalBytes`：意图/事件/审核 v2 是**独立类别**，
 * 它们的序列化预算早已由契约分项限定（保守上界 13 KiB < 16 KiB），"实际读取/写入字节"
 * 因此也必须有独立上界。第十二轮验收实测：把 `maxJournalBytes` 配成 64 KiB 后，
 * 一个前置 17000 字节空白的合法意图（实际 17.6 KiB）仍被读成合法——JSON 空白与转义
 * 都算**实际磁盘字节**，配置放大就等于给审核路径开了一个无界读取窗口。
 *
 * 配置**只能收紧**（见 `reviewArtifactLimit`）：这是"可配置预算"与"类别硬上限"的正确关系。
 */
export const REVIEW_ARTIFACT_MAX_BYTES = AUDIT_MAX_EVENT_BYTES;

/** 审核工件的实际字节上限：配置收紧生效，放大被硬上限截住。 */
export function reviewArtifactLimit(limits: { readonly maxJournalBytes: number }): number {
	return Math.min(limits.maxJournalBytes, REVIEW_ARTIFACT_MAX_BYTES);
}

export type ReviewJournalState = "prepared" | "committed" | "aborted" | "conflict";
/** 终态来源：写入方确认 vs 恢复时观察。**不能互相冒充**。 */
export type ReviewJournalSource = "writer-confirmed" | "recovery-observed";

/** 受控目标：只有 experience-card（首版审核的唯一对象），**不含任何路径字段**。 */
export const ReviewJournalTargetSchema = Type.Object(
	{
		kind: Type.Literal(AUDIT_TARGET_KIND),
		id: KnowledgeIdSchema,
	},
	{ additionalProperties: false },
);
export type ReviewJournalTarget = Static<typeof ReviewJournalTargetSchema>;

/**
 * 完整审核 journal v2。
 *
 * 字段顺序刻意与 v1 对齐（前 10 个字段同名同义），只在尾部追加审核绑定，
 * 这样人工对照两份 journal 时不需要两套阅读顺序。
 */
export const ReviewJournalRecordSchema = Type.Object(
	{
		journalVersion: Type.Literal(REVIEW_JOURNAL_VERSION),
		/** 判别位：没有它就不是审核 journal（而不是"v2 里可选"）。 */
		journalPurpose: Type.Literal(REVIEW_JOURNAL_PURPOSE),
		operationId: UuidSchema,
		/** 审核必然是 update：审批不创建记录（create 走普通写 + submit-review）。 */
		operation: Type.Literal("update"),
		state: Type.Union([Type.Literal("prepared"), Type.Literal("committed"), Type.Literal("aborted"), Type.Literal("conflict")]),
		target: ReviewJournalTargetSchema,
		before: AuditFingerprintSchema,
		after: AuditFingerprintSchema,
		preparedAt: Type.Integer({ minimum: 0, maximum: MAX_DATE_MS }),
		/** 终态必填；prepared 必须缺席（半截或伪造记录一律拒绝）。 */
		finishedAt: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_DATE_MS })),
		source: Type.Optional(Type.Union([Type.Literal("writer-confirmed"), Type.Literal("recovery-observed")])),
		/** 本次决定对应的审计事件身份（与意图里的 eventId 必须一致）。 */
		eventId: UuidSchema,
		/** 受控派生的意图文件名；必须恰好等于 `<operationId>.json`。 */
		intentName: Type.String({ minLength: AUDIT_INTENT_NAME_LENGTH, maxLength: AUDIT_INTENT_NAME_LENGTH }),
		/** 持久意图时绑定的**真实字节** SHA-256 声明值；只有与 IO 实测值相等才可信。 */
		intentHash: Type.String({ minLength: AUDIT_HASH_LENGTH, maxLength: AUDIT_HASH_LENGTH, pattern: AUDIT_HASH_PATTERN_SOURCE }),
	},
	{ additionalProperties: false },
);
export type ReviewJournalRecord = Static<typeof ReviewJournalRecordSchema>;

/**
 * 审核 journal 的问题码。
 *
 * 直接并入 `AuditIssueCode`：v2 的 schema 校验、revision 关系与事件/意图**共用同一份实现**
 * （`collectSchemaIssues` / `collectAuditRevisionIssues`），各写一套码迟早漂移成
 * "事件拒绝、journal 接受"这种自相矛盾的门槛。
 */
export type ReviewJournalIssueCode =
	| AuditIssueCode
	/** 结构与契约不符（类型/枚举/必填/前后关系/时间）。 */
	| "invalid-review-journal"
	/** operationId 与文件名不一致（或文件名根本不是 UUID）。 */
	| "review-journal-name-mismatch";

export type ReviewJournalIssue = { readonly code: ReviewJournalIssueCode; readonly path: string; readonly message: string };
export type ReviewJournalValidation = { ok: true; value: ReviewJournalRecord } | { ok: false; issues: readonly ReviewJournalIssue[]; droppedIssues: number };

/** 一条 journal 最多报告的问题条数（与 v1/事件同一口径：防"坏文件刷屏"）。 */
const MAX_REVIEW_JOURNAL_ISSUES = 8;

export function toReviewJournalIssue(issue: AuditIssue): ReviewJournalIssue {
	return { code: issue.code, path: issue.path, message: issue.message };
}

/** 审核 journal 与 v1 共用同一个目录与文件名规则（`journal/<operationId>.json`）。 */
export const REVIEW_JOURNAL_DIR_NAME = JOURNAL_DIR_NAME;
export function reviewJournalFileName(operationId: string): string {
	return journalFileName(operationId);
}
export function reviewJournalRelativePath(operationId: string): string {
	return `${REVIEW_JOURNAL_DIR_NAME}/${reviewJournalFileName(operationId)}`;
}
/** 是否为"值得尝试解析"的 journal 候选文件（与 v1 同一判断，`.tmp` 残留不删）。 */
export function isReviewJournalCandidateFile(name: string): boolean {
	return name.endsWith(JOURNAL_FILE_SUFFIX) && name.length > JOURNAL_FILE_SUFFIX.length;
}

/** 读取 `journalVersion`（含判别位）；非正整数视为缺失。 */
export function readReviewJournalVersion(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = (value as Record<string, unknown>).journalVersion;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
	return raw;
}

/** 判别"这是不是审核 journal"：只看判别位，**不看**意图文件是否存在。 */
export function isReviewJournalShape(value: unknown): boolean {
	return typeof value === "object" && value !== null && !Array.isArray(value) && (value as Record<string, unknown>).journalPurpose === REVIEW_JOURNAL_PURPOSE;
}

type IssueSink = (code: ReviewJournalIssueCode, path: string, message: string) => void;

/**
 * 校验审核 journal（**不可信输入**：可能被手工改过、被上次崩溃写了一半、来自未来版本）。
 *
 * 判定顺序固定，最后一步才是"关系与派生"：
 * 根形态 → 版本闸门 → 判别位 → **完整 TypeBox schema** → 文件名/派生名/递增关系/终态三要素。
 *
 * 为什么必须执行完整 schema（C2BR / R1）：本文件早就定义了 `ReviewJournalRecordSchema`，
 * 旧实现却只手工检查了一部分字段并把结果 `as ReviewJournalRecord`——于是
 * `eventId="not-a-uuid"`、`target.id="../other"`、`target.id="con"`、`before.unexpected=…`
 * 全部被判成合法。**"已校验"是类型与元数据的承诺，不能用字段子集冒充。**
 *
 * 返回的类型来自通过的 schema 校验（`validateShape`），不是手工拼装 + 强转；
 * 诊断来自同一套脱敏管道（`collectSchemaIssues`），不回显未知字段名/值，且输出有界。
 */
export function validateReviewJournalRecord(value: unknown, fileName: string): ReviewJournalValidation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return { ok: false, issues: [{ code: "invalid-review-journal", path: "", message: "审核 journal 必须是 JSON 对象" }], droppedIssues: 0 };
	}
	const raw = value as Record<string, unknown>;

	// ① 版本闸门优先：未知版本只报一条，绝不按当前结构猜字段。
	const version = readReviewJournalVersion(raw);
	if (version === undefined) {
		return { ok: false, issues: [{ code: "invalid-review-journal", path: "/journalVersion", message: `journalVersion 必须是 >= 1 的整数（审核 journal 是 ${REVIEW_JOURNAL_VERSION}）` }], droppedIssues: 0 };
	}
	if (version !== REVIEW_JOURNAL_VERSION) {
		return { ok: false, issues: [{ code: "unsupported-journal-version", path: "/journalVersion", message: `journalVersion=${version} 不是审核 journal 支持的 ${REVIEW_JOURNAL_VERSION}，拒绝解释（不按当前版本猜测字段）` }], droppedIssues: 0 };
	}
	// ② 判别位先于完整 schema：它决定"这是不是审核 journal"，不认识就谈不上按 v2 解释。
	if (!isReviewJournalShape(raw)) {
		return { ok: false, issues: [{ code: "invalid-review-journal", path: "/journalPurpose", message: `审核 journal 必须带 journalPurpose=${REVIEW_JOURNAL_PURPOSE}（判别位缺失时不允许猜）` }], droppedIssues: 0 };
	}

	// ③ 完整 schema：类型/枚举/必填/长度/数值范围/嵌套对象的 additionalProperties、
	//    UUID、KnowledgeId（含 Windows 保留名）、指纹形态与长度，全部由它负责。
	const shape = collectSchemaIssues(ReviewJournalRecordSchema, raw, "invalid-review-journal");
	if (!shape.ok) return { ok: false, issues: shape.issues.map(toReviewJournalIssue), droppedIssues: shape.dropped };

	// ④ 类型收窄来自**同一份 schema 的校验结果**（不是字段子集 + as）。
	const typed = validateShape(ReviewJournalRecordSchema, raw);
	if (!typed.ok) return { ok: false, issues: [{ code: "invalid-review-journal", path: "", message: "审核 journal 无法按 v2 结构收窄" }], droppedIssues: 0 };
	const record = typed.value;

	const issues: ReviewJournalIssue[] = [];
	const add: IssueSink = (code, path, message) => {
		// 上限只防"坏文件刷屏"：一条 journal 至多 8 条问题够定位了（与 v1 同口径）。
		if (issues.length < MAX_REVIEW_JOURNAL_ISSUES) issues.push({ code, path, message });
	};

	// ⑤ 关系与受控派生（schema 表达不了的部分）。
	if (fileName !== reviewJournalFileName(record.operationId)) {
		add("review-journal-name-mismatch", "/operationId", `operationId 与文件名不一致（文件名 ${fileName}）`);
	}
	if (record.intentName !== auditIntentFileName(record.operationId)) {
		add("invalid-review-journal", "/intentName", "intentName 必须由 operationId 派生（<operationId>.json），不接受调用方指定路径");
	}
	// 递增关系与事件/意图**共用同一份规则**：before 必须可递增，after 恰好是 before + 1。
	// （`after = MAX_SAFE_INTEGER` 是合法的一步：审核该记录一次可以到达上限，再次更新才该拒绝。）
	issues.push(...collectAuditRevisionIssues(record.before, record.after).map(toReviewJournalIssue));

	if (record.state === "prepared") {
		if (record.finishedAt !== undefined || record.source !== undefined) {
			add("invalid-review-journal", "/finishedAt", "prepared 不得带 finishedAt/source（半截或伪造记录）");
		}
	} else if (record.finishedAt === undefined || record.source === undefined) {
		add("invalid-review-journal", "/finishedAt", "终态必须带 Date 可表示范围内的 finishedAt 与 source（writer-confirmed / recovery-observed）");
	} else {
		if (record.finishedAt < record.preparedAt) add("invalid-review-journal", "/finishedAt", "finishedAt 不得早于 preparedAt");
		// 写入方从不写 conflict：允许它出现等于给"伪造一个冲突"开口子（与 v1 同规则）。
		if (record.state === "conflict" && record.source !== "recovery-observed") add("invalid-review-journal", "/source", "conflict 只能由恢复观察产生（recovery-observed）");
	}

	if (issues.length > 0) return { ok: false, issues, droppedIssues: 0 };
	return { ok: true, value: record };
}

/**
 * 从**已校验的完整 v2**提取关联投影（C2AR 定义的那一份）。
 *
 * 为什么只能从完整 v2 提取：投影是"这次提交绑定了什么"的视图，若允许调用方任意拼一个投影，
 * 就等于绕过了 v2 的版本/状态/归属校验——那正是 A3 要堵的口子。
 */
export function toReviewProjection(record: ReviewJournalRecord): AuditJournalReviewProjection {
	return {
		journalVersion: REVIEW_JOURNAL_VERSION,
		journalPurpose: REVIEW_JOURNAL_PURPOSE,
		operationId: record.operationId,
		eventId: record.eventId,
		intentName: record.intentName,
		intentHash: record.intentHash,
		target: { kind: record.target.kind, recordId: record.target.id },
		before: record.before,
		after: record.after,
	};
}

/** 构造 prepared 记录（写入侧唯一生成点，字段顺序稳定便于人工查看）。 */
export function buildPreparedReviewJournalRecord(input: { operationId: string; eventId: string; intentName: string; intentHash: string; target: ReviewJournalTarget; before: ReviewJournalRecord["before"]; after: ReviewJournalRecord["after"]; preparedAt: number }): ReviewJournalRecord {
	return {
		journalVersion: REVIEW_JOURNAL_VERSION,
		journalPurpose: REVIEW_JOURNAL_PURPOSE,
		operationId: input.operationId,
		operation: "update",
		state: "prepared",
		target: input.target,
		before: input.before,
		after: input.after,
		preparedAt: input.preparedAt,
		eventId: input.eventId,
		intentName: input.intentName,
		intentHash: input.intentHash,
	};
}

/** 构造终态记录（保留 prepared 的绑定，只补终态三要素；`after` 可用实际提交结果覆盖）。 */
export function buildFinalReviewJournalRecord(input: { prepared: ReviewJournalRecord; state: Exclude<ReviewJournalState, "prepared">; source: ReviewJournalSource; finishedAt: number; after?: ReviewJournalRecord["after"] }): ReviewJournalRecord {
	return {
		...input.prepared,
		state: input.state,
		source: input.source,
		finishedAt: input.finishedAt,
		...(input.after === undefined ? {} : { after: input.after }),
	};
}

/**
 * 一条**已落盘（或已认领）**的审计事实。
 *
 * 刻意只有这四个字段：`publication`/`recordedAt` 必须来自真实发布（首次发布时由本次路径生成，
 * 认领时原样保留已有事件的值），`relativePath` 是受控派生的展示路径。
 */
export type ReviewAuditFact = {
	readonly eventId: string;
	readonly relativePath: string;
	readonly publication: AuditPublication;
	readonly recordedAt: number;
};

/** 自检：写入前确认自己没造出违反契约的记录（否则恢复侧只会看到 invalid）。 */
export function assertReviewJournalValid(record: ReviewJournalRecord, fileName: string): void {
	const outcome = validateReviewJournalRecord(record, fileName);
	if (outcome.ok) return;
	const first = outcome.issues[0];
	throw new StorageError("invalid-record", `审核 journal 记录自检失败：${first?.path || "/"} ${first?.message ?? ""}`, { detail: first?.code ?? "invalid-review-journal" });
}
