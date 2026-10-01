/**
 * registry 的读取、显式初始化与绑定解析（BM-02A）。
 *
 * **唯一的生产写能力**是初始化时创建目录布局与一个合法空 registry：
 * 既有 `registry.json` 一律只读校验，不"修复"、不重置 revision/时间/绑定。
 * 普通记录写入与绑定变更属于 BM-02B（需要 expectedRevision 与跨进程锁）。
 *
 * 初始化竞争（两个进程同时首建）：采用"临时文件 + 硬链接发布"的非覆盖写入，
 * 因此不会出现互相覆盖；落后的那一方会读到对方发布的文件；
 * 若短时间内读不到完整合法的 registry，返回可重试的 `init-race` 错误，
 * 而不是用"删锁重来"之类的危险恢复。
 */
import { existsSync } from "node:fs";
import { normalize } from "node:path";
import { createEmptyRegistry, type Registry, type RegistryProjectEntry, type RegistryWorkspaceEntry, validateRegistry } from "../contracts/registry.ts";
import { describeIssues } from "../contracts/validate.ts";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../contracts/version.ts";
import { isFullyQualifiedPath } from "../paths.ts";
import { createStorageBoundary, type StorageBoundary } from "./boundary.ts";
import { StorageError, throwIfCancelled } from "./errors.ts";
import type { StorageLimits } from "./limits.ts";

/** 知识库目录布局（与 mvp_development_plan.md §5.1 对齐）。 */
export type KnowledgeStoreLayout = {
	root: string;
	canonicalRoot: string;
	registryPath: string;
	projectsDir: string;
	experiencesDir: string;
	featuresDir: string;
	auditDir: string;
	/** 缓存可删除、可重建，不是事实来源。 */
	cacheDir: string;
};

export function knowledgeLayout(boundary: StorageBoundary): KnowledgeStoreLayout {
	return {
		root: boundary.root,
		canonicalRoot: boundary.canonicalRoot,
		registryPath: boundary.resolve("registry.json"),
		projectsDir: boundary.resolve("projects"),
		experiencesDir: boundary.resolve("experiences"),
		featuresDir: boundary.resolve("features"),
		auditDir: boundary.resolve("audit"),
		cacheDir: boundary.resolve("cache"),
	};
}

export type BindingIssueCode = "invalid-path" | "duplicate-workspace-id" | "duplicate-path" | "workspace-claimed-by-other-project" | "duplicate-desktop-project";

export type BindingIssue = {
	code: BindingIssueCode;
	message: string;
	conflicts: string[];
};

/**
 * 路径比较键。
 * Windows 文件系统不区分大小写：不统一大小写的话，`C:\Work\bios` 与 `C:\work\BIOS`
 * 会被当成两个不同工作区，绑定唯一性就失效了。
 */
export function workspacePathKey(path: string, platform: NodeJS.Platform = process.platform): string {
	const normalized = normalize(path);
	return platform === "win32" ? normalized.toLowerCase() : normalized;
}

/** 检查 registry 内的绑定一致性（重复绑定、一个路径归属两个项目、非法路径）。 */
export function inspectBindingIssues(registry: Registry, platform: NodeJS.Platform = process.platform): BindingIssue[] {
	const issues: BindingIssue[] = [];
	const workspaceOwner = new Map<string, string>();
	const pathOwner = new Map<string, { biosProjectId: string; workspaceId: string }>();
	const desktopOwner = new Map<string, string>();

	for (const project of registry.projects) {
		if (project.desktopProjectId !== undefined) {
			const existing = desktopOwner.get(project.desktopProjectId);
			if (existing !== undefined && existing !== project.biosProjectId) {
				issues.push({
					code: "duplicate-desktop-project",
					message: `desktopProjectId ${project.desktopProjectId} 同时属于多个知识项目：${existing}、${project.biosProjectId}`,
					conflicts: [existing, project.biosProjectId],
				});
			}
			desktopOwner.set(project.desktopProjectId, project.biosProjectId);
		}

		for (const workspace of project.workspaces) {
			if (!isFullyQualifiedPath(workspace.path, platform)) {
				issues.push({ code: "invalid-path", message: `工作区路径不是完全限定绝对路径：${workspace.path}`, conflicts: [workspace.path] });
				continue;
			}

			const previousOwner = workspaceOwner.get(workspace.workspaceId);
			if (previousOwner !== undefined) {
				issues.push({
					code: "duplicate-workspace-id",
					message: `workspaceId ${workspace.workspaceId} 在 registry 中出现多次（${previousOwner} 与 ${project.biosProjectId}）`,
					conflicts: [previousOwner, project.biosProjectId],
				});
			} else {
				workspaceOwner.set(workspace.workspaceId, project.biosProjectId);
			}

			const key = workspacePathKey(workspace.path, platform);
			const previousPath = pathOwner.get(key);
			if (previousPath === undefined) {
				pathOwner.set(key, { biosProjectId: project.biosProjectId, workspaceId: workspace.workspaceId });
				continue;
			}
			if (previousPath.biosProjectId !== project.biosProjectId) {
				// 不同目录不会因为"同远端"自动合并；同一个目录也不能被两个项目同时声称。
				issues.push({
					code: "workspace-claimed-by-other-project",
					message: `路径 ${workspace.path} 同时绑定到多个知识项目：${previousPath.biosProjectId}、${project.biosProjectId}`,
					conflicts: [previousPath.biosProjectId, project.biosProjectId],
				});
				continue;
			}
			if (previousPath.workspaceId !== workspace.workspaceId) {
				issues.push({
					code: "duplicate-path",
					message: `同一项目内路径 ${workspace.path} 被绑定到多个工作区：${previousPath.workspaceId}、${workspace.workspaceId}`,
					conflicts: [previousPath.workspaceId, workspace.workspaceId],
				});
			}
		}
	}

	return issues;
}

export type ReadRegistryOptions = {
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
};

export async function readRegistry(options: ReadRegistryOptions): Promise<Registry> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal });
	return readRegistryWithBoundary(boundary);
}

/** 复用已有 boundary 的读取入口（初始化流程与测试用，避免重复 realpath）。 */
export async function readRegistryWithBoundary(boundary: StorageBoundary): Promise<Registry> {
	const layout = knowledgeLayout(boundary);
	const { value } = await boundary.readJson(layout.registryPath, boundary.limits.maxRegistryBytes);

	const outcome = validateRegistry(value);
	if (!outcome.ok) {
		// 版本问题与结构问题必须分开：前者"不要猜字段"，后者"结构写错了"。
		const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
		if (versionIssue) {
			throw new StorageError("unsupported-schema-version", `registry 版本无法解释：${versionIssue.message}`, { path: layout.registryPath });
		}
		throw new StorageError("invalid-record", `registry 结构不合法：${describeIssues(outcome.issues)}`, { path: layout.registryPath });
	}

	const bindingIssues = inspectBindingIssues(outcome.value);
	if (bindingIssues.length > 0) {
		throw new StorageError("binding-conflict", `registry 绑定冲突：${bindingIssues.map((issue) => issue.message).join("；")}`, {
			path: layout.registryPath,
			conflicts: bindingIssues.flatMap((issue) => issue.conflicts),
		});
	}

	return outcome.value;
}

export type InitializeKnowledgeStoreOptions = ReadRegistryOptions & {
	/** 注入时间（测试用），默认 `Date.now()`。 */
	now?: number;
};

export type InitializeKnowledgeStoreResult = {
	status: "created" | "existing";
	registry: Registry;
	layout: KnowledgeStoreLayout;
	/** 本次实际创建的目录（幂等：已存在的不列出）。 */
	createdDirectories: string[];
	/** 因竞争而重试读取的次数（0 表示无竞争）。 */
	raceRetries: number;
};

const INIT_RACE_RETRIES = 3;
const INIT_RACE_DELAY_MS = 25;

export async function initializeKnowledgeStore(options: InitializeKnowledgeStoreOptions): Promise<InitializeKnowledgeStoreResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, createIfMissing: true });
	const layout = knowledgeLayout(boundary);
	throwIfCancelled(options.signal);

	const createdDirectories: string[] = [];
	for (const directory of [layout.projectsDir, layout.experiencesDir, layout.featuresDir, layout.auditDir, layout.cacheDir]) {
		const existed = existsSync(directory);
		await boundary.ensureDirectory(directory);
		if (!existed) createdDirectories.push(directory);
	}

	// 已存在（无论内容是否合法）：只做只读校验。
	// 损坏文件既不"修复"也不覆盖——调用方拿到 invalid-json / unsupported-schema-version 自行处理。
	if (existsSync(layout.registryPath)) {
		return { status: "existing", registry: await readRegistryWithBoundary(boundary), layout, createdDirectories, raceRetries: 0 };
	}

	const empty = createEmptyRegistry(options.now ?? Date.now(), BIOS_CONTRACTS_SCHEMA_VERSION);
	const published = await boundary.publishJson(layout.registryPath, empty);
	if (published === "created") {
		return { status: "created", registry: empty, layout, createdDirectories, raceRetries: 0 };
	}

	// 竞争：另一个进程刚发布（或正发布）。短暂重试读取，读不到就给出可重试的明确错误。
	for (let attempt = 1; attempt <= INIT_RACE_RETRIES; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, INIT_RACE_DELAY_MS * attempt));
		try {
			const registry = await readRegistryWithBoundary(boundary);
			return { status: "existing", registry, layout, createdDirectories, raceRetries: attempt };
		} catch (error) {
			if (attempt === INIT_RACE_RETRIES) {
				throw new StorageError("init-race", `另一个进程正在初始化知识库，请稍后重试：${layout.registryPath}`, {
					path: layout.registryPath,
					detail: error instanceof Error ? error.message : String(error),
					cause: error,
				});
			}
		}
	}

	throw new StorageError("init-race", `初始化竞争未解决：${layout.registryPath}`, { path: layout.registryPath });
}

export type ProjectBindingQuery = {
	workspacePath?: string;
	biosProjectId?: string;
	desktopProjectId?: string;
};

export type ProjectBindingResolution = { status: "resolved"; project: RegistryProjectEntry; workspace: RegistryWorkspaceEntry } | { status: "missing"; reason: "no-query" | "no-match" | "no-workspace" } | { status: "conflict"; reason: "ambiguous-workspace" | "ambiguous-desktop-project"; candidates: string[] };

/**
 * 依据已有 registry 解析绑定。
 * **不按相同远端猜合并**：registry 里没有远端信息，同一路径若被多个项目声称就是冲突，
 * 由调用方提示用户显式改绑。
 */
export function resolveProjectBinding(registry: Registry, query: ProjectBindingQuery, platform: NodeJS.Platform = process.platform): ProjectBindingResolution {
	const workspacePath = query.workspacePath?.trim();
	if (workspacePath) {
		const key = workspacePathKey(workspacePath, platform);
		const matches: Array<{ project: RegistryProjectEntry; workspace: RegistryWorkspaceEntry }> = [];
		for (const project of registry.projects) {
			for (const workspace of project.workspaces) {
				if (workspacePathKey(workspace.path, platform) === key) matches.push({ project, workspace });
			}
		}
		if (matches.length === 0) return { status: "missing", reason: "no-match" };

		const projectIds = [...new Set(matches.map((match) => match.project.biosProjectId))];
		if (projectIds.length > 1) return { status: "conflict", reason: "ambiguous-workspace", candidates: projectIds };

		const preferred = query.biosProjectId === undefined ? undefined : matches.find((match) => match.project.biosProjectId === query.biosProjectId);
		const chosen = preferred ?? matches[0];
		// matches 非空已在上面保证；这里只为类型收窄。
		if (!chosen) return { status: "missing", reason: "no-match" };
		return { status: "resolved", project: chosen.project, workspace: chosen.workspace };
	}

	if (query.biosProjectId !== undefined) {
		const project = registry.projects.find((entry) => entry.biosProjectId === query.biosProjectId);
		if (!project) return { status: "missing", reason: "no-match" };
		const workspace = project.workspaces[0];
		if (!workspace) return { status: "missing", reason: "no-workspace" };
		return { status: "resolved", project, workspace };
	}

	if (query.desktopProjectId !== undefined) {
		const matches = registry.projects.filter((entry) => entry.desktopProjectId === query.desktopProjectId);
		if (matches.length === 0) return { status: "missing", reason: "no-match" };
		if (matches.length > 1) return { status: "conflict", reason: "ambiguous-desktop-project", candidates: matches.map((entry) => entry.biosProjectId) };
		const project = matches[0];
		if (!project) return { status: "missing", reason: "no-match" };
		const workspace = project.workspaces[0];
		if (!workspace) return { status: "missing", reason: "no-workspace" };
		return { status: "resolved", project, workspace };
	}

	return { status: "missing", reason: "no-query" };
}
