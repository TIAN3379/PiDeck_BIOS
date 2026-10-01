/**
 * 契约运行时校验与结构化错误。
 *
 * 设计要点：
 * 1. schema 校验只负责"结构与取值合法"，**不**负责业务规则（例如 verified 必须有
 *    上板验证记录）——那是 experiences 模块的职责，混在一起会让缺口无法解释；
 * 2. 未知/更高 `schemaVersion` 一律拒绝写入：宁可报错，不能按当前版本猜测旧/新格式；
 * 3. 错误码与路径都结构化返回，工具层可以直接把它转成模型可读文本，
 *    不需要在成功对象里写一句"失败"（mvp_development_plan.md §8）。
 */
import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { RecordBaseSchema } from "./common.ts";
import { RECORD_SCHEMAS, type RecordKind } from "./records.ts";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "./version.ts";

/** 结构化错误码。 */
export type ContractIssueCode =
	/** 结构与 schema 不符（含必填缺失、类型错误、枚举越界）。 */
	| "invalid-record"
	/** schemaVersion 缺失或不是正整数。 */
	| "invalid-schema-version"
	/** schemaVersion 高于本实现已知版本：只读，拒绝写入。 */
	| "unsupported-schema-version";

export type ContractIssue = {
	code: ContractIssueCode;
	/** JSON Pointer 风格路径（如 `/identity/chipsetFamily`）；根为 `""`。 */
	path: string;
	message: string;
};

export type ValidationOutcome<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };

/** 写入被拒绝时抛出的错误：调用方按 code 决定"只读展示"还是"提示升级"。 */
export class BiosContractError extends Error {
	readonly code: ContractIssueCode;
	readonly issues: ContractIssue[];

	constructor(issues: ContractIssue[]) {
		const first = issues[0];
		super(first ? `${first.code}: ${first.path || "/"} ${first.message}` : "contract validation failed");
		this.name = "BiosContractError";
		this.code = first?.code ?? "invalid-record";
		this.issues = issues;
	}
}

/** 读取记录头里的 schemaVersion；非正整数一律视为缺失。 */
export function readSchemaVersion(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const raw = (value as Record<string, unknown>).schemaVersion;
	if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) return undefined;
	return raw;
}

/**
 * 版本闸门：只接受与当前实现完全一致的版本。
 * 为什么不"向下兼容到 1"：当前只有 v1，任何其他数字都意味着数据来自别的实现，
 * 按 v1 解析会把差异当成缺字段，静默改写用户知识。
 */
export function checkSchemaVersion(value: unknown): ContractIssue | undefined {
	if (typeof value !== "object" || value === null) {
		return { code: "invalid-record", path: "", message: "记录必须是对象" };
	}
	const version = readSchemaVersion(value);
	if (version === undefined) {
		return { code: "invalid-schema-version", path: "/schemaVersion", message: "schemaVersion 必须是 >= 1 的整数" };
	}
	if (version > BIOS_CONTRACTS_SCHEMA_VERSION) {
		return {
			code: "unsupported-schema-version",
			path: "/schemaVersion",
			message: `记录 schemaVersion=${version} 高于本实现支持的 ${BIOS_CONTRACTS_SCHEMA_VERSION}，拒绝写入`,
		};
	}
	if (version < BIOS_CONTRACTS_SCHEMA_VERSION) {
		return {
			code: "unsupported-schema-version",
			path: "/schemaVersion",
			message: `记录 schemaVersion=${version} 低于本实现支持的 ${BIOS_CONTRACTS_SCHEMA_VERSION}，需迁移后再写入`,
		};
	}
	return undefined;
}

/** 按 schema 做结构校验；调用方负责先过版本闸门。 */
export function validateShape<T extends TSchema>(schema: T, value: unknown): ValidationOutcome<Static<T>> {
	if (Value.Check(schema, value)) {
		return { ok: true, value: value as Static<T> };
	}
	const issues: ContractIssue[] = [...Value.Errors(schema, value)].map((error) => ({
		code: "invalid-record",
		path: error.instancePath,
		message: error.message,
	}));
	return { ok: false, issues: issues.length > 0 ? issues : [{ code: "invalid-record", path: "", message: "记录结构与 schema 不符" }] };
}

/** 完整校验：版本闸门 → 结构校验。 */
export function validateRecord<T extends TSchema>(schema: T, value: unknown): ValidationOutcome<Static<T>> {
	const versionIssue = checkSchemaVersion(value);
	if (versionIssue) return { ok: false, issues: [versionIssue] };
	return validateShape(schema, value);
}

/** 按记录类型校验（存储层与工具层的统一入口）。 */
export function validateRecordByKind(kind: RecordKind, value: unknown): ValidationOutcome<Static<TSchema>> {
	return validateRecord(RECORD_SCHEMAS[kind], value);
}

/** 写入路径的守卫：失败即抛错，不返回"看起来成功"的结果。 */
export function assertWritableRecord<T extends TSchema>(schema: T, value: unknown): Static<T> {
	const outcome = validateRecord(schema, value);
	if (!outcome.ok) throw new BiosContractError(outcome.issues);
	return outcome.value;
}

/** 把问题列表压成一段可读文本（供工具 content 与日志使用，限制条数避免刷屏）。 */
export function describeIssues(issues: ContractIssue[], limit = 8): string {
	const shown = issues.slice(0, limit).map((issue) => `- [${issue.code}] ${issue.path || "/"} ${issue.message}`);
	if (issues.length > limit) shown.push(`- … 另有 ${issues.length - limit} 条问题`);
	return shown.join("\n");
}

/** 记录头的 schema（自检与 BM-02 存储层复用）。 */
export const RECORD_BASE_SCHEMA = Type.Object(RecordBaseSchema.properties);
