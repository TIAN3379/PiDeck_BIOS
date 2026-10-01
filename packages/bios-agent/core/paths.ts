/**
 * 知识根解析与路径拼接（纯函数，可独立单测）。
 *
 * 为什么集中在这里：桌面端（主进程）与 CLI 必须解析到**同一个**知识根，
 * 各拼一次路径迟早漂移成"界面看到的和工具读到的不是同一份数据"。
 *
 * 解析优先级只在本文定义一次：
 *   显式注入（桌面设置 / CLI 参数） > 环境变量 `BIOS_KNOWLEDGE_ROOT` > 用户级默认目录。
 *
 * 三条硬规则（round1 R2 与 round2 F2）：
 * 1. **不写死盘符**。默认值是当前用户目录下的 `BIOS_Knowledge`；
 *    桌面端应显式传入 `<userData>/bios-knowledge`（core 不依赖 Electron，路径由适配层给）。
 * 2. **必须是完全限定的绝对路径**。Windows 的 `\BIOS_Knowledge` 虽然 `isAbsolute` 为真，
 *    却没有盘符，`resolve` 会拿进程当前盘符补齐——同一个配置在桌面与 CLI 会指向不同知识库。
 *    因此这里只接受"盘符绝对路径 `C:\...`"或合法 UNC `\\server\share\...`；
 *    `\name`、`/name`、`C:name` 与普通相对路径一律拒绝。
 * 3. **所有公开入口复用同一校验**：`resolveKnowledgeRoot`、`resolveKnowledgePaths` 的字符串与对象
 *    形态、`resolveInsideRoot` 都走 `requireFullyQualified`，不依赖调用方"先调用对函数"。
 *
 * 边界：本文件的路径检查是**词法**层面的（名称合法性 + 拼接结果是否在根内）。
 * 它不能证明某个真实路径没有通过根内的 junction/符号链接逃逸到根外——
 * 那需要 realpath 与链接策略，属于 BM-02 的真实 IO 层。
 */
import { homedir } from "node:os";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import { assertKnowledgeId, type KnowledgeIdKind } from "./contracts/ids.ts";

/** 注入知识根的环境变量名（CLI 与桌面端共用同一条通道）。 */
export const BIOS_KNOWLEDGE_ROOT_ENV = "BIOS_KNOWLEDGE_ROOT";

export type KnowledgePathErrorCode = "relative-root" | "path-escape";

export class KnowledgePathError extends Error {
	readonly code: KnowledgePathErrorCode;

	constructor(code: KnowledgePathErrorCode, message: string) {
		super(message);
		this.name = "KnowledgePathError";
		this.code = code;
	}
}

/** `C:\...`（盘符绝对）。 */
const WIN32_DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
/** `\\server\share\...`（UNC：server 与 share 都必须非空）。 */
const WIN32_UNC_ABSOLUTE = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/;

/**
 * 是否为**完全限定**路径（不依赖进程当前目录/当前盘符）。
 * 纯字符串判定，可按平台测试，不需要真实文件系统。
 */
export function isFullyQualifiedPath(value: string, platform: NodeJS.Platform = process.platform): boolean {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (platform === "win32") return WIN32_DRIVE_ABSOLUTE.test(trimmed) || WIN32_UNC_ABSOLUTE.test(trimmed);
	return trimmed.startsWith("/");
}

/** 统一校验并规范化知识根/根路径：失败即抛 `relative-root`，绝不隐式 resolve 到 cwd。 */
export function requireFullyQualifiedRoot(value: string, label: string): string {
	const trimmed = value?.trim();
	if (!trimmed) throw new KnowledgePathError("relative-root", `${label} 不能为空`);
	if (!isFullyQualifiedPath(trimmed)) {
		throw new KnowledgePathError("relative-root", `${label} 必须是完全限定的绝对路径（Windows 需要盘符或 UNC；依赖当前盘符的 \\name、盘符相对路径 C:name 以及普通相对路径都不接受）：${trimmed}`);
	}
	return normalize(trimmed);
}

/**
 * 用户级默认知识根：`<home>/BIOS_Knowledge`。
 *
 * `home` 也遵守完全限定契约：解析结果必须是"换机器就换结果、不随 cwd 变"的绝对路径。
 */
export function defaultKnowledgeRoot(home: string = homedir()): string {
	const normalizedHome = requireFullyQualifiedRoot(home, "用户目录");
	return normalize(join(normalizedHome, "BIOS_Knowledge"));
}

export type KnowledgeRootSource = "override" | "env" | "default";

export type ResolvedKnowledgeRoot = {
	root: string;
	/** 来源用于界面说明与自检输出，避免"到底读的哪一份"靠猜。 */
	source: KnowledgeRootSource;
};

export type ResolveKnowledgeRootOptions = {
	/** 桌面设置或 CLI 显式传入的绝对路径（最高优先级）。 */
	override?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
};

export function resolveKnowledgeRoot(options: ResolveKnowledgeRootOptions = {}): ResolvedKnowledgeRoot {
	const override = options.override?.trim();
	if (override) return { root: requireFullyQualifiedRoot(override, "显式知识根"), source: "override" };

	const envValue = (options.env ?? process.env)[BIOS_KNOWLEDGE_ROOT_ENV]?.trim();
	if (envValue) return { root: requireFullyQualifiedRoot(envValue, `环境变量 ${BIOS_KNOWLEDGE_ROOT_ENV}`), source: "env" };

	return { root: defaultKnowledgeRoot(options.home ?? homedir()), source: "default" };
}

/**
 * 词法根约束：拼接结果必须停在根内。
 *
 * 用 `relative()` 判定而不是字符串前缀比较——后者会被 `C:\root2` 这类同前缀目录绕过。
 * 逃逸判定必须**精确匹配** `..` / `..` + 分隔符：`startsWith("..")` 会把根内合法的
 * `..cache` 目录误判成逃逸（round2 第 4 节建议 3）。
 *
 * 注意：这是**词法**检查，不解析符号链接；授权判断见 `core/projects/authorization.ts`。
 */
export function resolveInsideRoot(root: string, ...segments: string[]): string {
	const normalizedRoot = requireFullyQualifiedRoot(root, "知识根");
	const target = normalize(join(normalizedRoot, ...segments));
	const rel = relative(normalizedRoot, target);
	if (rel === "") return target;
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new KnowledgePathError("path-escape", `拒绝访问知识根之外的路径：${target}`);
	}
	return target;
}

/** 知识根的目录布局（mvp_development_plan.md §5.1）。 */
export type KnowledgePaths = {
	root: string;
	source: KnowledgeRootSource;
	registryPath: string;
	projectsDir: string;
	experiencesDir: string;
	featuresDir: string;
	auditDir: string;
	/** 缓存可删除、可重建，不能作为唯一事实来源。 */
	cacheDir: string;
	projectDir(projectId: string): string;
	projectProfilePath(projectId: string): string;
	projectTasksDir(projectId: string): string;
	taskPath(projectId: string, taskId: string): string;
	experiencePath(experienceId: string): string;
	featurePath(featureId: string): string;
	auditPath(recordId: string): string;
};

export function resolveKnowledgePaths(resolved: ResolvedKnowledgeRoot | string): KnowledgePaths {
	// 字符串与对象两个入口都走同一校验：调用方绕过 resolveKnowledgeRoot 也不能拿到相对根。
	const root = typeof resolved === "string" ? requireFullyQualifiedRoot(resolved, "知识根") : requireFullyQualifiedRoot(resolved.root, "知识根");
	const source: KnowledgeRootSource = typeof resolved === "string" ? "override" : resolved.source;
	const inside = (...segments: string[]) => resolveInsideRoot(root, ...segments);
	// 项目 ID 是 UUID；其余记录 ID 走通用规则。两种规则都在 contracts/ids.ts 定义。
	const id = (value: string, label: string, kind: KnowledgeIdKind = "generic") => assertKnowledgeId(value, label, kind);
	const projectId = (value: string, label: string) => id(value, label, "project");

	return {
		root,
		source,
		registryPath: inside("registry.json"),
		projectsDir: inside("projects"),
		experiencesDir: inside("experiences"),
		featuresDir: inside("features"),
		auditDir: inside("audit"),
		cacheDir: inside("cache"),
		projectDir: (value) => inside("projects", projectId(value, "projectId")),
		projectProfilePath: (value) => inside("projects", projectId(value, "projectId"), "profile.json"),
		projectTasksDir: (value) => inside("projects", projectId(value, "projectId"), "tasks"),
		taskPath: (value, taskId) => inside("projects", projectId(value, "projectId"), "tasks", `${id(taskId, "taskId")}.json`),
		experiencePath: (value) => inside("experiences", `${id(value, "experienceId")}.json`),
		featurePath: (value) => inside("features", `${id(value, "featureId")}.json`),
		auditPath: (value) => inside("audit", `${id(value, "recordId")}.json`),
	};
}
