/**
 * 知识记录 ID 的**唯一**规则来源：契约 schema 与路径拼接共用同一份定义。
 *
 * 为什么要单一来源：schema 校验与文件名拼接如果各写一份正则，迟早出现
 * "schema 通过但文件名非法"（或反之）的裂缝——那正是两个 ID 映射到同一个文件、
 * 或写入静默失败的直接原因。
 *
 * 规则（在 Windows 与 POSIX 上同时安全）：
 * - 只允许小写字母、数字、`.`、`_`、`-`，首字符必须是字母或数字。
 *   限制为小写同时消除大小写不敏感文件系统上的别名碰撞（`Exp` 与 `exp` 会落到同一个文件）；
 * - 不允许以 `.` 结尾：Windows 会静默丢掉尾点，`exp.` 与 `exp` 会命中同一个文件；
 * - 拒绝 Windows 设备保留名，**包括带点后缀的形式**（`con`、`con.json`、`nul.txt`…）：
 *   保留名不区分大小写且扩展名不能解除保留；
 * - 长度 1..128。
 *
 * 边界：这里只判断**名称是否合法**，不构成任何 IO 授权。
 * 根约束、链接逃逸与 realpath 校验属于 BM-02 的真实 IO 层（见 round1_acceptance.md R3）。
 */
import { type Static, Type } from "typebox";

export const KNOWLEDGE_ID_MIN_LENGTH = 1;
export const KNOWLEDGE_ID_MAX_LENGTH = 128;

/**
 * 通用知识 ID 的 ECMA-262 正则源码。
 * 同一字符串同时用于 TypeBox 的 `pattern` 与运行时的 `RegExp`，避免两处规则漂移。
 *
 * 负向先行断言 `(?!(?:con|…)(?:\.|$))` 同时覆盖"整个字符串就是保留名"与
 * "保留名 + 点后缀"两种形态——只排除前者会让 `con.json` 通过 schema 却被路径层拒绝
 * （第二轮验收 F1 的实际裂缝）。
 */
export const KNOWLEDGE_ID_PATTERN_SOURCE = "^(?!(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$))[a-z0-9](?:[a-z0-9._-]*[a-z0-9_-])?$";

/** 稳定项目 ID：小写 UUID（`crypto.randomUUID()` 的输出形态）。 */
export const BIOS_PROJECT_ID_PATTERN_SOURCE = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

const KNOWLEDGE_ID_REGEX = new RegExp(KNOWLEDGE_ID_PATTERN_SOURCE);
const BIOS_PROJECT_ID_REGEX = new RegExp(BIOS_PROJECT_ID_PATTERN_SOURCE);

/** Windows 设备保留名（小写形式；点后缀形式在 `isReservedDeviceName` 里处理）。 */
export const RESERVED_DEVICE_NAMES: ReadonlySet<string> = new Set(["con", "prn", "aux", "nul", ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`), ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)]);

/** 保留名判定：比较第一个点之前的主名，因此 `con.json` 也是保留名。 */
export function isReservedDeviceName(value: string): boolean {
	const primaryName = value.split(".", 1)[0] ?? value;
	return RESERVED_DEVICE_NAMES.has(primaryName);
}

export type KnowledgeIdKind = "generic" | "project";

export type KnowledgeIdIssue = "not-string" | "empty" | "too-long" | "charset" | "trailing-dot" | "reserved-name" | "not-uuid";

export class KnowledgeIdError extends Error {
	readonly code: KnowledgeIdIssue;
	readonly id: string;

	constructor(code: KnowledgeIdIssue, id: string, message: string) {
		super(message);
		this.name = "KnowledgeIdError";
		this.code = code;
		this.id = id;
	}
}

const KIND_LABEL: Record<KnowledgeIdKind, string> = { generic: "知识记录 ID", project: "项目 ID" };

/**
 * 检查 ID 并返回**第一个**失败原因（无则 undefined）。
 *
 * 允许集合只由 `KNOWLEDGE_ID_REGEX`（也就是 schema 的 `pattern`）决定；
 * 下面的分类只用于给出更细的错误码，**不参与"是否接受"的判断**。
 * 如果让分类逻辑也参与接受判断，schema 与运行时又会各自形成一套允许集合——
 * 这正是第二轮 F1 暴露的问题。
 */
export function inspectKnowledgeId(value: unknown, kind: KnowledgeIdKind = "generic"): KnowledgeIdIssue | undefined {
	if (typeof value !== "string") return "not-string";
	if (value.length === 0) return "empty";
	if (value.length > KNOWLEDGE_ID_MAX_LENGTH) return "too-long";

	if (kind === "project") {
		return BIOS_PROJECT_ID_REGEX.test(value) ? undefined : "not-uuid";
	}

	if (KNOWLEDGE_ID_REGEX.test(value)) return undefined;

	// 到这里已经确定被拒绝，以下只是把原因说清楚。
	if (value.endsWith(".")) return "trailing-dot";
	if (isReservedDeviceName(value)) return "reserved-name";
	return "charset";
}

export function isValidKnowledgeId(value: unknown, kind: KnowledgeIdKind = "generic"): boolean {
	return inspectKnowledgeId(value, kind) === undefined;
}

/** 失败即抛错（存储层与路径拼接的守卫；调用方按 code 决定提示）。 */
export function assertKnowledgeId(value: unknown, label = "id", kind: KnowledgeIdKind = "generic"): string {
	const issue = inspectKnowledgeId(value, kind);
	if (issue !== undefined) {
		const shown = typeof value === "string" ? value : `<${typeof value}>`;
		throw new KnowledgeIdError(issue, shown, `${label}（${KIND_LABEL[kind]}）不合法：${describeIssue(issue)}；实际值：${shown}`);
	}
	return value as string;
}

export function describeIssue(issue: KnowledgeIdIssue): string {
	switch (issue) {
		case "not-string":
			return "必须是字符串";
		case "empty":
			return "不能为空";
		case "too-long":
			return `长度不能超过 ${KNOWLEDGE_ID_MAX_LENGTH}`;
		case "trailing-dot":
			return "不能以 `.` 结尾（Windows 会静默去掉尾点，导致两个 ID 命中同一文件）";
		case "reserved-name":
			return "不能使用 Windows 设备保留名（con/nul/com1…），带点后缀也不行";
		case "not-uuid":
			return "必须是规范的小写 UUID";
		case "charset":
			return "只允许小写字母、数字以及 `.` `_` `-`，且首字符必须是字母或数字";
	}
}

/** TypeBox schema：与运行时函数共享同一份正则源码。 */
export const KnowledgeIdSchema = Type.String({ minLength: KNOWLEDGE_ID_MIN_LENGTH, maxLength: KNOWLEDGE_ID_MAX_LENGTH, pattern: KNOWLEDGE_ID_PATTERN_SOURCE });
export type KnowledgeId = Static<typeof KnowledgeIdSchema>;

/** 小写 UUID 的通用 schema（项目 ID 与工作区标识共用同一形态）。 */
export const UuidSchema = Type.String({ minLength: 36, maxLength: 36, pattern: BIOS_PROJECT_ID_PATTERN_SOURCE });
export type Uuid = Static<typeof UuidSchema>;

/** 稳定项目 ID：小写 UUID。不能用 Session ID、agentId、目录名或远端 URL 替代。 */
export const BiosProjectIdSchema = UuidSchema;
export type BiosProjectId = Uuid;
