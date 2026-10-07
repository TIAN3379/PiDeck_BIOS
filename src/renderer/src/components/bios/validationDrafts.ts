/**
 * BM-07B：**验证记录表单的纯函数**（任务与经验卡共用）。
 *
 * 为什么放在 bios 根目录而不是任务目录：`core` 的任务验证与经验验证是**同一套**形状
 * （kind/scope/result/performedAt/performedBy/evidence），B-04/B-05 各自再实现一遍
 * 必然出现两套校验口径。这里用结构化类型同时接受两者，最终判定仍在 core。
 *
 * 约定：
 * - 字段一个不多一个不少（不为"表单更完整"扩张格式）；
 * - 空证据**不写入**：不静默落成空数组，也不编造 hash/行号；
 * - 前置校验只为了尽早给出可读错误，不代替 core 的判定。
 */
import type { EvidenceSourceType, ValidationKind, ValidationResult } from "../../../../shared/types/biosBusiness";

export const VALIDATION_KINDS: readonly ValidationKind[] = ["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"];
export const VALIDATION_RESULTS: readonly ValidationResult[] = ["passed", "failed", "inconclusive"];
export const EVIDENCE_TYPES: readonly EvidenceSourceType[] = ["source-file", "commit", "document", "session", "human-note"];

/** v1 合法的证据子集（`TaskEvidenceInput` 与 `ExperienceEvidenceInput` 的共同结构）。 */
export type BiosEvidenceInput = {
	readonly type: EvidenceSourceType;
	readonly relativePath?: string | null;
	readonly contentHash?: string | null;
	readonly workspaceId?: string | null;
	readonly commit?: string | null;
	readonly location?: string | null;
};

/** v1 验证记录输入（任务与经验共用同一结构）。 */
export type BiosValidationRecord = {
	readonly kind: ValidationKind;
	readonly scope: string;
	readonly result: ValidationResult;
	readonly performedAt: number;
	readonly performedBy: string;
	readonly evidence?: readonly BiosEvidenceInput[];
};

/** 一条验证记录的界面草稿（时间用 `datetime-local` 文本，便于人工填写）。 */
export type BiosValidationDraft = {
	kind: ValidationKind;
	/** 验证覆盖范围/说明（core 的 `scope`）。 */
	scope: string;
	result: ValidationResult;
	performedAtLocal: string;
	performedBy: string;
	/** `none` 表示本次不带证据（core 允许空证据，但不会替我们编造）。 */
	evidenceType: EvidenceSourceType | "none";
	evidenceRelativePath: string;
	evidenceContentHash: string;
	evidenceCommit: string;
	evidenceLocation: string;
};

/** 多行/逗号分隔文本 → 字符串数组（去空白、去空项、保序）。 */
export function parseList(value: string): string[] {
	return value
		.split(/[\n,，;；]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}

export function formatList(values: readonly string[]): string {
	return values.join("\n");
}

/** 本地时间文本（`YYYY-MM-DDTHH:mm`）——不用 UTC，避免用户按本地时间填却被平移。 */
export function toLocalDateTime(epochMs: number): string {
	const date = new Date(epochMs);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalDateTime(value: string): number | null {
	if (value.trim() === "") return null;
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : null;
}

export function emptyValidationDraft(now: number): BiosValidationDraft {
	return { kind: "compile", scope: "", result: "inconclusive", performedAtLocal: toLocalDateTime(now), performedBy: "", evidenceType: "none", evidenceRelativePath: "", evidenceContentHash: "", evidenceCommit: "", evidenceLocation: "" };
}

export type ValidationDraftOutcome = { readonly ok: true; readonly value: BiosValidationRecord } | { readonly ok: false; readonly error: string };

/** 草稿 → core 输入；空证据字段**不写入**（不静默落成空数组，也不编造 hash）。 */
export function toValidationInput(draft: BiosValidationDraft): ValidationDraftOutcome {
	const scope = draft.scope.trim();
	if (scope === "") return { ok: false, error: "scope" };
	const performedBy = draft.performedBy.trim();
	if (performedBy === "") return { ok: false, error: "performedBy" };
	const performedAt = fromLocalDateTime(draft.performedAtLocal);
	if (performedAt === null) return { ok: false, error: "performedAt" };
	const raw = { relativePath: draft.evidenceRelativePath.trim(), contentHash: draft.evidenceContentHash.trim(), commit: draft.evidenceCommit.trim(), location: draft.evidenceLocation.trim() };
	const anyEvidence = draft.evidenceType !== "none" && (raw.relativePath !== "" || raw.contentHash !== "" || raw.commit !== "" || raw.location !== "");
	const evidence = anyEvidence
		? [
				{
					type: draft.evidenceType as EvidenceSourceType,
					...(raw.relativePath === "" ? {} : { relativePath: raw.relativePath }),
					...(raw.contentHash === "" ? {} : { contentHash: raw.contentHash }),
					...(raw.commit === "" ? {} : { commit: raw.commit }),
					...(raw.location === "" ? {} : { location: raw.location }),
				},
			]
		: undefined;
	return { ok: true, value: { kind: draft.kind, scope, result: draft.result, performedAt, performedBy, ...(evidence === undefined ? {} : { evidence }) } };
}

/** 已保存的验证记录 → 草稿（用于编辑时保留既有验证，而不是清空重填）。 */
export function validationDraftFrom(record: BiosValidationRecord): BiosValidationDraft {
	const evidence = record.evidence?.[0];
	return {
		kind: record.kind,
		scope: record.scope,
		result: record.result,
		performedAtLocal: toLocalDateTime(record.performedAt),
		performedBy: record.performedBy,
		evidenceType: evidence?.type ?? "none",
		evidenceRelativePath: evidence?.relativePath ?? "",
		evidenceContentHash: evidence?.contentHash ?? "",
		evidenceCommit: evidence?.commit ?? "",
		evidenceLocation: evidence?.location ?? "",
	};
}

/** 已保存的验证记录是否有"界面表达不了"的部分（多条证据），必须提示且**不能静默丢弃**。 */
export function validationHasExtraEvidence(records: readonly BiosValidationRecord[]): boolean {
	return records.some((record) => (record.evidence?.length ?? 0) > 1);
}

/**
 * 同一分钟即视为同一时间。
 *
 * `datetime-local` 只精确到分钟，而已保存记录是精确到毫秒的 epoch ms：直接比数值会把
 * "秒/毫秒非零"的记录**全部**误判成"已修改"，用户在关闭编辑页时会被反复要求确认。
 * 表单能表达的最小粒度就是分钟，因此这是唯一诚实且不误报的口径。
 */
export function sameMinute(a: number, b: number): boolean {
	return Math.floor(a / 60_000) === Math.floor(b / 60_000);
}

/**
 * 草稿与已保存记录是否语义一致（用于未保存检测）。
 *
 * 刻意不用 `JSON.stringify` 比较：字段顺序与省略写法（`undefined` vs 缺省）会让
 * 内容相同的记录被误判成"已修改"，从而在关闭时反复要求确认。
 */
export function validationDraftMatchesRecord(draft: BiosValidationDraft, record: BiosValidationRecord): boolean {
	const outcome = toValidationInput(draft);
	if (!outcome.ok) return false;
	const value = outcome.value;
	if (value.kind !== record.kind || value.scope !== record.scope || value.result !== record.result || !sameMinute(value.performedAt, record.performedAt) || value.performedBy !== record.performedBy) return false;
	const current = value.evidence?.[0];
	const saved = record.evidence?.[0];
	if (current === undefined || saved === undefined) return current === undefined && saved === undefined;
	return current.type === saved.type && (current.relativePath ?? "") === (saved.relativePath ?? "") && (current.contentHash ?? "") === (saved.contentHash ?? "") && (current.commit ?? "") === (saved.commit ?? "") && (current.location ?? "") === (saved.location ?? "");
}
