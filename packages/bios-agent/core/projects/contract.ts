/**
 * BM-03 项目事实服务的**公共骨架**：受控错误码、资源预算与纯输入判定。
 *
 * 放在一个文件里的理由：绑定/检测/确认/快照四条路径必须共用同一套
 * "什么算非法参数""一次最多读多少字节"的口径。各写一份迟早漂移
 * （例如绑定允许 8MB 单文件、检测只允许 512KB），而漂移的后果是资源上限失效。
 *
 * 这里**不做任何 IO**：IO 预算的消费点在各自的实现里，但数值只有这一份来源。
 */
import { isAbsolute } from "node:path";
import { KnowledgePathError, requireFullyQualifiedRoot } from "../paths.ts";
import { PROJECT_FIELD_NAMES, type ProjectFieldName } from "./fields.ts";

/** 受控错误码：调用方与 CLI 按码分流，不解析文案。 */
export type ProjectServiceErrorCode =
	/** 参数形态非法（路径/枚举/数量），在 IO 之前判定。 */
	| "invalid-argument"
	/** 目标不在已授权根内。 */
	| "not-authorized"
	/** 知识库或记录不存在。 */
	| "not-found"
	/** registry / profile / 工作区之间不一致，不能用于后续业务。 */
	| "inconsistent"
	/** CAS 冲突：期望的 revision 与实际不符（调用方应重读后重试）。 */
	| "revision-conflict"
	/** 已取消（含 Ctrl+C）。 */
	| "cancelled"
	/** 宿主能力不支持（例如无法启动 Git）。 */
	| "unsupported"
	/** 其它 IO 失败（权限、磁盘、网络盘），带上原始 fs 错误码。 */
	| "io-error";

export class ProjectServiceError extends Error {
	readonly code: ProjectServiceErrorCode;
	readonly detail: string | undefined;
	override readonly cause: unknown;

	constructor(code: ProjectServiceErrorCode, message: string, options: { detail?: string; cause?: unknown } = {}) {
		super(message);
		this.name = "ProjectServiceError";
		this.code = code;
		this.detail = options.detail;
		this.cause = options.cause;
	}
}

/**
 * 服务层资源预算（默认值即上限；调用方只能收紧不能放宽）。
 *
 * 为什么"只能收紧"：这些上限的存在意义是"一次人工/模型操作不会把源码树读进上下文"，
 * 如果参数可以放宽，那这条约束就变成提示词可以改变的东西。
 */
export type ProjectServiceLimits = {
	/** 检测最多读取的文件数。 */
	maxDetectFiles: number;
	/** 检测单个文件的字节上限。 */
	maxDetectFileBytes: number;
	/** 检测一次读取的总字节上限。 */
	maxDetectTotalBytes: number;
	/** 检测最多返回的候选数。 */
	maxDetectionCandidates: number;
	/** 检测遍历的目录项预算（传给目录线索探测）。 */
	maxDetectScanPaths: number;
	/** 检测遍历的深度预算。 */
	maxDetectDepth: number;
	/** 一次确认最多修改的字段数。 */
	maxConfirmFields: number;
	/** 单个字段值的字符上限（防止把整段源码塞进档案）。 */
	maxFieldValueChars: number;
	/** 证据复验最多读取的文件数。 */
	maxEvidenceFiles: number;
	/**
	 * 证据复验最多检查的**条目数**（含没有路径/hash、无法复验的声明）。
	 *
	 * 与文件预算是两个独立上限：不可复验的声明（human-note / commit）不读文件，
	 * 因此不会被文件预算约束——没有独立上限时，一份档案里的几百条声明会全部出现在输出里。
	 * 默认值在 `resolveProjectLimits` 里按 `maxEvidenceFiles × 4` 派生（上限 64），也可以独立覆盖。
	 */
	maxEvidenceEntries: number;
	/** 证据复验单个文件的字节上限。 */
	maxEvidenceFileBytes: number;
	/** Git 子进程的标准输出上限（字节）。 */
	maxGitOutputBytes: number;
	/** Git 子进程超时（毫秒）。 */
	gitTimeoutMs: number;
	/** 读取视图最多返回的诊断条数（外壳独立有界，不受 M1 条目预算影响）。 */
	maxViewProblems: number;
	/** 读取视图最多返回的资料缺口条数。 */
	maxViewGaps: number;
};

export const DEFAULT_PROJECT_LIMITS: ProjectServiceLimits = {
	maxDetectFiles: 8,
	maxDetectFileBytes: 512 * 1024,
	maxDetectTotalBytes: 2 * 1024 * 1024,
	maxDetectionCandidates: 24,
	maxDetectScanPaths: 4_000,
	maxDetectDepth: 8,
	maxConfirmFields: 12,
	maxFieldValueChars: 200,
	maxEvidenceFiles: 16,
	maxEvidenceEntries: 64,
	maxEvidenceFileBytes: 1024 * 1024,
	maxGitOutputBytes: 64 * 1024,
	gitTimeoutMs: 5_000,
	maxViewProblems: 32,
	maxViewGaps: 24,
};

const LIMIT_KEYS = Object.keys(DEFAULT_PROJECT_LIMITS) as Array<keyof ProjectServiceLimits>;

/**
 * 合并预算：未知键与非法值都**报错**而不是忽略。
 *
 * 静默忽略一个拼错的 `maxDetectFiles` 会让调用方以为上限生效了，实际跑的是默认值——
 * 这正是"看起来受限、实际没有"的那类缺口。
 */
export function resolveProjectLimits(overrides?: Partial<ProjectServiceLimits>): ProjectServiceLimits {
	const merged = { ...DEFAULT_PROJECT_LIMITS };
	if (overrides === undefined) return merged;
	if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) throw invalidArgument("资源预算必须是对象");
	for (const key of Object.keys(overrides)) {
		if (!LIMIT_KEYS.includes(key as keyof ProjectServiceLimits)) throw invalidArgument(`未知的资源预算项：${key}`);
	}
	for (const key of LIMIT_KEYS) {
		const value = overrides[key];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalidArgument(`资源预算 ${key} 必须是正整数`);
		if (value > DEFAULT_PROJECT_LIMITS[key]) throw invalidArgument(`资源预算 ${key} 只能收紧（上限 ${DEFAULT_PROJECT_LIMITS[key]}）`);
		merged[key] = value;
	}
	// 条目上限的默认值**跟随文件预算**（每条可复验证据最多随行 4 条不可复验声明）：
	// 否则 `maxEvidenceFiles = 1` 时几百条 human-note 仍然会全部进入输出。
	// 调用方给出显式值时以显式值为准（仍然只能收紧）。
	if (overrides.maxEvidenceEntries === undefined) merged.maxEvidenceEntries = Math.min(DEFAULT_PROJECT_LIMITS.maxEvidenceEntries, merged.maxEvidenceFiles * 4);
	return merged;
}

export function invalidArgument(message: string, detail = "invalid-argument"): ProjectServiceError {
	return new ProjectServiceError("invalid-argument", message, { detail });
}

export function notAuthorized(message: string, detail = "outside-authorized-roots"): ProjectServiceError {
	return new ProjectServiceError("not-authorized", message, { detail });
}

export function inconsistent(message: string, detail: string): ProjectServiceError {
	return new ProjectServiceError("inconsistent", message, { detail });
}

/** 完全限定绝对路径（与 `core/paths.ts` 同一口径）；非法配置一律报参数错误，不替调用方猜。 */
export function requireAbsolutePath(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument(`${label} 不能为空`);
	try {
		return requireFullyQualifiedRoot(value, label);
	} catch (error) {
		if (error instanceof KnowledgePathError) throw invalidArgument(`${label} 必须是完全限定的绝对路径（不接受 '.'、'..' 或相对路径），实际：${value}`);
		throw error;
	}
}

/** 可选绝对路径：`undefined`/空串等于"未提供"（空串当成"查询空路径"会掩盖拼写错误）。 */
export function optionalAbsolutePath(value: unknown, label: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim() === "") return undefined;
	return requireAbsolutePath(value, label);
}

/** 受控短文本（单行、有上界），用于 operatorLabel / displayName 这类声明性输入。 */
export function requireBoundedText(value: unknown, label: string, maxChars: number): string {
	if (typeof value !== "string") throw invalidArgument(`${label} 必须是字符串`);
	const trimmed = value.trim();
	if (trimmed === "") throw invalidArgument(`${label} 不能为空`);
	if (trimmed.length > maxChars) throw invalidArgument(`${label} 超过 ${maxChars} 字符上限`);
	return trimmed;
}

export function optionalBoundedText(value: unknown, label: string, maxChars: number): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireBoundedText(value, label, maxChars);
}

/** posix 分隔符的相对路径（证据一律存相对路径，不写用户主目录这类环境相关绝对路径）。 */
export function toPosixRelative(value: string): string {
	return value.split("\\").join("/");
}

/** 相对路径必须落在工作区内且非空：拒绝绝对路径、`..` 与空段。 */
export function assertSafeRelativePath(value: string): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument("相对路径不能为空");
	if (isAbsolute(value)) throw invalidArgument("证据/快照只接受相对路径，不接受绝对路径");
	const normalized = toPosixRelative(value).replace(/^\.\//, "");
	const segments = normalized.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) throw invalidArgument("相对路径不得包含空段、'.' 或 '..'");
	return segments.join("/");
}

/** 字段名 allowlist（身份字段 + 构建目标）。未知字段名直接拒绝，不做"尽力写入"。 */
export function requireProjectFieldName(value: unknown): ProjectFieldName {
	if (typeof value !== "string" || !PROJECT_FIELD_NAMES.includes(value as ProjectFieldName)) {
		throw invalidArgument(`不支持的档案字段名（允许：${PROJECT_FIELD_NAMES.join("、")}）`, "unknown-field");
	}
	return value as ProjectFieldName;
}
