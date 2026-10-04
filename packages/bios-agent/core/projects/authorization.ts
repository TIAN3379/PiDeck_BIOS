/**
 * 目标目录授权（round1 R6 + round2 F4）。
 *
 * 规则：工具只能在**已授权根**及其子目录内工作。
 * - 默认授权根是会话工作目录（Pi 的 `ctx.cwd`）——它就是当前项目工作区；
 * - 额外根必须由**适配层**注入（桌面设置 / CLI 参数 / 环境变量），
 *   **不接受模型通过工具参数自行扩权**：否则"读取范围"就变成提示词可以改变的东西；
 * - 额外根还必须是**完全限定的绝对路径**：`'.'`、`'../..'` 这类相对配置会被
 *   `statSync` 按**进程** cwd 解析，于是同一个配置在不同进程里授予不同范围
 *   （round2 F4 的实际观察：进程 cwd 是包目录时 `'.'` 把包目录加进了授权根）。
 *   非法配置一律报配置错误，不替调用方猜路径；
 * - 比较使用真实路径（realpath），因此根内指向根外的符号链接 / junction 会被拒绝；
 * - 拒绝时不返回目标目录内的任何线索（先授权、后扫描）。
 *
 * 与 `core/paths.ts` 的分工：paths 只做词法拼接检查（名称合法性 + 是否停在根内），
 * 本文件负责真实路径授权，两者共用同一份"完全限定路径"判定。
 * 两者都不能声称提供操作系统级沙箱——本地进程仍可直接读写文件，这里的规则约束的是**本工具**的访问面。
 */
import { realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import { KnowledgePathError, requireFullyQualifiedRoot } from "../paths.ts";

/** 由适配层注入额外授权根的环境变量（`path.delimiter` 分隔；模型无法设置）。 */
export const BIOS_AUTHORIZED_ROOTS_ENV = "BIOS_AUTHORIZED_ROOTS";

export type AuthorizedTargetErrorCode = "not-found" | "not-directory" | "outside-authorized-roots" | "invalid-authorized-root" | "invalid-cwd";

export class AuthorizedTargetError extends Error {
	readonly code: AuthorizedTargetErrorCode;

	constructor(code: AuthorizedTargetErrorCode, message: string) {
		super(message);
		this.name = "AuthorizedTargetError";
		this.code = code;
	}
}

/**
 * 读取适配层注入的额外授权根。
 * 这里只做"拆分 + 去空白"；**合法性与存在性都在 `resolveAuthorizedTargetDir` 校验**，
 * 以便把"配置非法"与"目录离线"区分开。
 */
export function readAuthorizedRootsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const raw = env[BIOS_AUTHORIZED_ROOTS_ENV];
	if (!raw) return [];
	return raw
		.split(delimiter)
		.map((value) => value.trim())
		.filter((value) => value.length > 0);
}

/**
 * 目标是否位于根内（两侧都必须是真实路径）。
 *
 * 逃逸判定精确匹配 `..` / `..` + 分隔符：`startsWith("..")` 会把根内合法的
 * `..cache` 目录误判成逃逸（round2 第 4 节建议 3）。
 */
export function isWithinAuthorizedRoot(rootRealPath: string, targetRealPath: string): boolean {
	const rel = relative(rootRealPath, targetRealPath);
	if (rel === "") return true;
	return !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`));
}

export type AuthorizedTarget = {
	/** 通过授权检查的目标目录（真实路径）。 */
	targetDir: string;
	/** 命中的授权根（真实路径），用于在结果里说明"这次是在哪个范围内扫描的"。 */
	matchedRoot: string;
	/** 本次生效的授权根集合（真实路径，含会话工作目录；已去重）。 */
	effectiveRoots: string[];
	/** 配置为完全限定路径但当前不可达的额外根（离线根，不参与本次授权）。 */
	unreachableRoots: string[];
};

export type ResolveAuthorizedTargetOptions = {
	/** 模型给出的目标目录：绝对路径或相对会话工作目录的路径。 */
	requested?: string;
	/** 会话工作目录：默认授权根。 */
	cwd: string;
	/** 适配层注入的额外授权根（必须是完全限定的绝对路径）。 */
	authorizedRoots?: readonly string[];
};

function realDirectory(path: string): string | undefined {
	try {
		if (!statSync(path).isDirectory()) return undefined;
		return realpathSync(path);
	} catch {
		return undefined;
	}
}

/** 真实路径优先、失败时退回词法路径（用于"目录当前不可达但仍要判定授权"的场景）。 */
function realOrLexical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export type BoundWorkspaceAuthorization = {
	readonly authorized: boolean;
	readonly matchedRoot: string | null;
	/** 目标当前是否可达（不存在/无权访问时为 false；不可达不等于"未授权"）。 */
	readonly reachable: boolean;
};

/**
 * 判定一个**已入档的工作区路径**是否仍在本次会话的授权范围内（R28-4）。
 *
 * 为什么不能只靠 bind 时的检查：registry/profile 里保存的是**过去的**路径，
 * 而每次读取都带进来一份 cwd/授权根。若 open/detect/read/refresh 不重新执行这条判定，
 * 绑定记录就变成了一条长期通行证——用户明确收窄了授权，服务却仍然去读那份检出。
 *
 * 与 `resolveAuthorizedTargetDir` 的两点区别（都是刻意的）：
 * - 目标不存在时**不报错**：不可达要如实报告为 unreachable，而不是伪装成授权失败；
 * - 根与目标都用"真实路径优先、词法兜底"解析：目录离线时仍要能判定它是否在根内。
 */
export function authorizeWorkspacePath(options: { cwd: string; authorizedRoots?: readonly string[]; path: string }): BoundWorkspaceAuthorization {
	let cwdAbsolute: string;
	try {
		cwdAbsolute = requireFullyQualifiedRoot(options.cwd, "会话工作目录");
	} catch (error) {
		if (error instanceof KnowledgePathError) throw new AuthorizedTargetError("invalid-cwd", `会话工作目录必须是完全限定的绝对路径：${options.cwd}`);
		throw error;
	}
	const target = requireFullyQualifiedRoot(options.path, "工作区路径");

	const roots: string[] = [realOrLexical(cwdAbsolute)];
	for (const candidate of options.authorizedRoots ?? []) {
		const validated = validateAuthorizedRoot(candidate);
		roots.push(realOrLexical(validated));
	}

	const targetResolved = realOrLexical(target);
	const reachable = realDirectory(target) !== undefined;
	for (const root of roots) {
		if (isWithinAuthorizedRoot(root, targetResolved)) return { authorized: true, matchedRoot: root, reachable };
	}
	return { authorized: false, matchedRoot: null, reachable };
}

/** 配置里的额外根：先校验形态（非法即报配置错误），再看是否可达。 */
function validateAuthorizedRoot(candidate: string): string {
	try {
		return requireFullyQualifiedRoot(candidate, "额外授权根");
	} catch (error) {
		if (error instanceof KnowledgePathError) {
			throw new AuthorizedTargetError("invalid-authorized-root", `额外授权根必须是完全限定的绝对路径（不接受 '.'、'..' 或相对路径）：${candidate}`);
		}
		throw error;
	}
}

/**
 * 解析并授权目标目录。
 *
 * `cwd` 也要求是完全限定的绝对路径：会话工作目录失效或形态异常时，
 * 与其猜测，不如明确报错（否则后续所有相对路径都会指向不可预期的位置）。
 */
export function resolveAuthorizedTargetDir(options: ResolveAuthorizedTargetOptions): AuthorizedTarget {
	let cwdReal: string | undefined;
	try {
		const cwdAbsolute = requireFullyQualifiedRoot(options.cwd, "会话工作目录");
		cwdReal = realDirectory(cwdAbsolute);
	} catch (error) {
		if (error instanceof KnowledgePathError) throw new AuthorizedTargetError("invalid-cwd", `会话工作目录必须是完全限定的绝对路径：${options.cwd}`);
		throw error;
	}
	if (!cwdReal) throw new AuthorizedTargetError("not-found", `会话工作目录不存在或不可访问：${options.cwd}`);

	const unreachableRoots: string[] = [];
	const extraRoots: string[] = [];
	for (const candidate of options.authorizedRoots ?? []) {
		const validated = validateAuthorizedRoot(candidate);
		const resolved = realDirectory(validated);
		if (resolved) extraRoots.push(resolved);
		// 明确配置但当前不可达：标记离线，不静默当成"没配过"，也不因此报错。
		else unreachableRoots.push(validated);
	}

	// realpath 去重：两个写法指向同一目录时不应该在结果里出现两次。
	const effectiveRoots = [...new Set([cwdReal, ...extraRoots])];

	const requested = options.requested?.trim();
	if (!requested) {
		return { targetDir: cwdReal, matchedRoot: cwdReal, effectiveRoots, unreachableRoots };
	}

	// 相对 targetDir 按**会话**工作目录解析（不是进程 cwd）；越界仍由下面的授权检查拒绝。
	const absolute = isAbsolute(requested) ? requested : join(cwdReal, requested);
	const targetReal = realDirectory(absolute);
	if (!targetReal) {
		// 区分"不存在"和"不是目录"能让报错更可操作（模型下一步该换路径还是换目标）。
		try {
			statSync(absolute);
			throw new AuthorizedTargetError("not-directory", `目标路径不是目录：${absolute}`);
		} catch (error) {
			if (error instanceof AuthorizedTargetError) throw error;
			throw new AuthorizedTargetError("not-found", `目标目录不存在或不可访问：${absolute}`);
		}
	}

	for (const root of effectiveRoots) {
		if (isWithinAuthorizedRoot(root, targetReal)) {
			return { targetDir: targetReal, matchedRoot: root, effectiveRoots, unreachableRoots };
		}
	}

	throw new AuthorizedTargetError("outside-authorized-roots", `目标目录不在已授权范围内（已授权根：${effectiveRoots.join("、")}）：${targetReal}`);
}
