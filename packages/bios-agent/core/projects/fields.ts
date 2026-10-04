/**
 * 档案字段的**单一命名来源**与初始形态。
 *
 * 为什么单独一个文件：字段名同时出现在四处（schema 推导、检测候选、人工确认 allowlist、
 * CLI 参数解析），任一处硬编码字符串都会在改名时悄悄漂移——漂移的后果是
 * "确认了一个没人读的字段"或"检测写进了没有对应字段的键"。
 *
 * 允许写模型的字段（v1 `ProjectIdentity`）与 schema 逐字对应；
 * 这里用 `satisfies` 式的显式列表而不是 `keyof` 推导，是为了在 schema 增删字段时
 * **编译期报错**，而不是悄悄多一个没人管的键。
 */
import type { ProjectIdentity } from "../contracts/records.ts";
import type { ProjectField } from "../contracts/common.ts";

/** `ProjectIdentity` 的字段名（与 schema 逐字对应）。 */
export const IDENTITY_FIELD_NAMES = ["ibv", "ibvVersion", "chipsetVendor", "chipsetFamily", "chipsetGeneration", "architecture", "boardName", "boardRevision", "customer", "productLine", "crbBaseline"] as const;
export type IdentityFieldName = (typeof IDENTITY_FIELD_NAMES)[number];

/** 数组型字段：每个条目是 `ProjectField`（值 + 确认程度 + 证据）。 */
export const ARRAY_FIELD_NAMES = ["buildTargets", "keyEntryPoints"] as const;
export type ArrayFieldName = (typeof ARRAY_FIELD_NAMES)[number];

/** 人工确认与检测候选可触达的字段全集（身份字段 + 构建目标）。 */
export const PROJECT_FIELD_NAMES = [...IDENTITY_FIELD_NAMES, ...ARRAY_FIELD_NAMES] as const;
export type ProjectFieldName = (typeof PROJECT_FIELD_NAMES)[number];

/** 身份字段判定：编译期约束"数组里写的名字确实是 `ProjectIdentity` 的键"。 */
const IDENTITY_FIELD_GUARD: Readonly<Record<IdentityFieldName, keyof ProjectIdentity>> = {
	ibv: "ibv",
	ibvVersion: "ibvVersion",
	chipsetVendor: "chipsetVendor",
	chipsetFamily: "chipsetFamily",
	chipsetGeneration: "chipsetGeneration",
	architecture: "architecture",
	boardName: "boardName",
	boardRevision: "boardRevision",
	customer: "customer",
	productLine: "productLine",
	crbBaseline: "crbBaseline",
};

export function isIdentityFieldName(value: string): value is IdentityFieldName {
	return Object.prototype.hasOwnProperty.call(IDENTITY_FIELD_GUARD, value);
}

export function isArrayFieldName(value: string): value is ArrayFieldName {
	return (ARRAY_FIELD_NAMES as readonly string[]).includes(value);
}

/**
 * 未知字段的初始形态：`value = null` + `status = "unknown"`。
 *
 * 空字符串**不是**"未知"：它会以"已知但内容为空"的样子进入后续检索与展示。
 * 没有证据就是 unknown，不允许猜一个最可能的值（`common.ts` 的三态定义）。
 */
export function emptyProjectField(now: number): ProjectField {
	return { value: null, status: "unknown", evidence: [], updatedAt: now };
}

/** 全新项目的身份：全部未知，证据为空。 */
export function createEmptyIdentity(now: number): ProjectIdentity {
	return {
		ibv: emptyProjectField(now),
		ibvVersion: emptyProjectField(now),
		chipsetVendor: emptyProjectField(now),
		chipsetFamily: emptyProjectField(now),
		chipsetGeneration: emptyProjectField(now),
		architecture: emptyProjectField(now),
		boardName: emptyProjectField(now),
		boardRevision: emptyProjectField(now),
		customer: emptyProjectField(now),
		productLine: emptyProjectField(now),
		crbBaseline: emptyProjectField(now),
	};
}

/** 身份字段里处于 `confirmed` 的字段名（消费视图用它区分"人工确认"与"检测候选"）。 */
export function confirmedIdentityFields(identity: ProjectIdentity): IdentityFieldName[] {
	return IDENTITY_FIELD_NAMES.filter((name) => identity[name].status === "confirmed" && identity[name].value !== null);
}

/** 明确"不知道什么"的资料缺口清单（无缺口返回空数组，不返回"无"这类占位文本）。 */
export function unknownIdentityFields(identity: ProjectIdentity): IdentityFieldName[] {
	return IDENTITY_FIELD_NAMES.filter((name) => identity[name].status === "unknown" || identity[name].value === null);
}
