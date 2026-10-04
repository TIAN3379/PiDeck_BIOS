/**
 * 预检的**分类策略**（BM-02C3）：把"读到的值"变成"这是不是当前支持的格式"。
 *
 * 与磁盘遍历分开的理由：分类必须与既有校验器**逐条对齐**（记录、journal v1/v2、审核意图、审计事件
 * 各有一套链路），而遍历只关心"在哪里、按什么预算读"。两件事混在一个函数里，
 * 迟早出现"某个类别用了更弱的判据"。
 *
 * 三条共同规则：
 * 1. **版本闸门优先**：版本不认识就只报一条、绝不按当前结构猜字段；
 * 2. **路径身份与读取器同判据**：意图的 purpose/operationId、事件的 eventId/target 必须落在本路径上；
 * 3. 版本号照实报告（不支持/缺失也报，缺失 = null）。
 */
import { AUDIT_INTENT_PURPOSE, readAuditIntentVersion, readAuditVersion, readSchemaVersion, validateAuditEvent, validateAuditIntent } from "../../contracts/index.ts";
import type { RecordKind } from "../../contracts/records.ts";
import { interpretRecord } from "../records.ts";
import { JOURNAL_SCHEMA_VERSION, validateJournalRecord } from "../journal/index.ts";
import { readReviewJournalVersion, REVIEW_JOURNAL_VERSION, validateReviewJournalRecord } from "../review/contract.ts";
import type { FileVerdict } from "./scan.ts";
import { statusForCode } from "./scan.ts";

/** 观察到的记录格式版本（缺失/非法 = null：**不猜**）。 */
export function versionOf(value: unknown): number | null {
	return readSchemaVersion(value) ?? null;
}

/** 记录候选的观察结论（与 `readRecordWithBoundary` 同一条解释链：结构 → 版本 → ID → 归属）。 */
export function verdictForRecord(kind: RecordKind, value: unknown, expected: { id: string; projectId?: string }): FileVerdict {
	const interpreted = interpretRecord(kind, value, expected);
	const version = versionOf(value);
	if (!interpreted.ok) {
		return {
			ok: false,
			status: interpreted.problem.code === "unsupported-schema-version" ? "unsupported-version" : "invalid",
			version,
			code: interpreted.problem.code,
			message: interpreted.problem.message,
		};
	}
	return { ok: true, status: "ok", version, code: null };
}

/**
 * 审核意图的观察结论。
 *
 * 判据与 `readReviewIntentArtifact` **同一份**：完整 `validateAuditIntent` + 路径身份。
 * 预检自己读原始字节，是为了保留**校验器给出的真实错误码**（例如 `unsupported-audit-intent-version`），
 * 而不是把它压成一句"不符合契约"。
 */
export function verdictForIntent(value: unknown, operationId: string): FileVerdict {
	const version = readAuditIntentVersion(value) ?? null;
	const outcome = validateAuditIntent(value);
	if (!outcome.ok) {
		const first = outcome.issues[0];
		const code = first?.code ?? "invalid-audit-intent";
		return { ok: false, status: statusForCode(code), version, code, message: `${code}：${first?.message ?? ""}` };
	}
	if (outcome.value.purpose !== AUDIT_INTENT_PURPOSE || outcome.value.operationId !== operationId) {
		return { ok: false, status: "invalid", version, code: "invalid-record", message: "意图的 purpose/operationId 与该路径不对应" };
	}
	return { ok: true, status: "ok", version, code: null };
}

/** 审计事件的观察结论（判据与 `readReviewEventArtifact` 同一份）。 */
export function verdictForEvent(value: unknown, recordId: string, eventId: string): FileVerdict {
	const version = readAuditVersion(value) ?? null;
	const outcome = validateAuditEvent(value);
	if (!outcome.ok) {
		const first = outcome.issues[0];
		const code = first?.code ?? "invalid-audit";
		return { ok: false, status: statusForCode(code), version, code, message: `${code}：${first?.message ?? ""}` };
	}
	if (outcome.value.eventId !== eventId || outcome.value.target.recordId !== recordId) {
		return { ok: false, status: "invalid", version, code: "invalid-record", message: "事件的 eventId/target 与该路径不对应" };
	}
	return { ok: true, status: "ok", version, code: null };
}

/**
 * journal 候选的观察结论：**按 `journalVersion` 显式路由**，未知版本绝不猜字段。
 *
 * v1 = 普通写意图日志，v2 = 审核专用；两者**合法共存**，都不是对方的旧版本。
 * `prepared`/`conflict` 是"需要人工核对"的事项，预检只报告、不调用 reconcile。
 */
export function verdictForJournal(value: unknown, fileName: string): FileVerdict {
	const version = readReviewJournalVersion(value);
	if (version === undefined) {
		return { ok: false, status: "invalid", version: null, code: "invalid-journal", message: "journal 缺少合法的 journalVersion（不按当前版本猜字段）" };
	}
	if (version === JOURNAL_SCHEMA_VERSION) {
		const outcome = validateJournalRecord(value, fileName);
		if (!outcome.ok) {
			const first = outcome.issues[0];
			return { ok: false, status: "invalid", version, code: first?.code ?? "invalid-journal", message: `${first?.code ?? "invalid-journal"}：${first?.message ?? ""}` };
		}
		const state = outcome.value.state;
		return state === "prepared" || state === "conflict" ? { ok: true, status: "ok", version, code: null, manualReason: state === "prepared" ? "prepared-journal" : "conflict-journal", message: `journal 处于 ${state}：需要人工核对（预检不调用 reconcile）` } : { ok: true, status: "ok", version, code: null };
	}
	if (version === REVIEW_JOURNAL_VERSION) {
		const outcome = validateReviewJournalRecord(value, fileName);
		if (!outcome.ok) {
			const first = outcome.issues[0];
			return { ok: false, status: "invalid", version, code: first?.code ?? "invalid-review-journal", message: `${first?.code ?? "invalid-review-journal"}：${first?.message ?? ""}` };
		}
		const state = outcome.value.state;
		return state === "prepared" || state === "conflict" ? { ok: true, status: "ok", version, code: null, manualReason: state === "prepared" ? "prepared-journal" : "conflict-journal", message: `审核 journal 处于 ${state}：需要人工核对（预检不调用 reconcile）` } : { ok: true, status: "ok", version, code: null };
	}
	return { ok: false, status: "unsupported-version", version, code: "unsupported-journal-version", message: `journalVersion=${version} 不在本实现支持的 1/2 之内，拒绝解释（不猜字段）` };
}
