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
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "./boundary.ts";
import { type StorageErrorCode, isStorageError, StorageError, throwIfCancelled } from "./errors.ts";
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
	/**
	 * 跨进程锁目录（BM-02B）。
	 *
	 * 放在知识根内而不是系统临时目录：锁必须与它保护的数据"同源"——
	 * 放到 `os.tmpdir()` 会让"同一个知识根被两个挂载点访问"这类情况产生两把互不相干的锁，
	 * 看起来加锁了，实际零互斥。
	 */
	locksDir: string;
	/**
	 * 写入意图日志目录（BM-02C1）。
	 *
	 * **惰性创建**：`initializeKnowledgeStore` 不建它，因此既有的 6 个布局目录语义、
	 * "重复初始化 createdDirectories 为空"以及更早版本创建的知识库都完全兼容。
	 * 路径解析集中在这里，避免 writer / inspect / reconcile 各拼一次。
	 */
	journalDir: string;
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
		locksDir: boundary.resolve("locks"),
		journalDir: boundary.resolve("journal"),
	};
}

export type BindingIssueCode = "invalid-path" | "duplicate-workspace-id" | "duplicate-path" | "workspace-claimed-by-other-project" | "duplicate-desktop-project" | "duplicate-bios-project";

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
	const projectOwner = new Set<string>();

	for (const project of registry.projects) {
		// biosProjectId 是项目主键，唯一性必须先于一切解析（BM-02AR / S5）。
		// 旧实现只查了 workspace/路径/desktopProjectId 的唯一性：两个条目重复同一个
		// biosProjectId 且 workspaces 为空时 `inspectBindingIssues` 返回 []，于是
		// `resolveProjectBinding` 的 `find`/`filter` 会用"第一条"冒充确定结论。
		if (projectOwner.has(project.biosProjectId)) {
			issues.push({
				code: "duplicate-bios-project",
				message: `biosProjectId ${project.biosProjectId} 在 registry 中出现多次`,
				conflicts: [project.biosProjectId],
			});
		} else {
			projectOwner.add(project.biosProjectId);
		}

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
	/** 受控 IO 故障注入（仅测试；见 boundary.ts 的 StorageIoHooks）。 */
	ioHooks?: StorageIoHooks;
};

export async function readRegistry(options: ReadRegistryOptions): Promise<Registry> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, ioHooks: options.ioHooks });
	return readRegistryWithBoundary(boundary);
}

/** 复用已有 boundary 的读取入口（初始化流程与测试用，避免重复 realpath）。 */
export async function readRegistryWithBoundary(boundary: StorageBoundary): Promise<Registry> {
	return (await readRegistryWithFingerprint(boundary)).registry;
}

/**
 * 与 `readRegistryWithBoundary` 完全同一条校验链，额外返回**实际读到字节**的 SHA-256。
 *
 * 为什么要单独一个入口而不是让调用方再 `readJson` 一次：journal 的 `before.hash`
 * 必须与被校验的那一版内容同源。读两遍会出现"校验的是 A、记进哈希的是 B"的窗口，
 * 而这个窗口恰恰在崩溃恢复场景里最致命。校验逻辑只写一份，避免两条链漂移。
 */
export async function readRegistryWithFingerprint(boundary: StorageBoundary): Promise<{ registry: Registry; fingerprint: string }> {
	const layout = knowledgeLayout(boundary);
	const { value, fingerprint } = await boundary.readJson(layout.registryPath, boundary.limits.maxRegistryBytes, boundary.signal);

	const interpreted = interpretRegistryValue(value);
	if (!interpreted.ok) {
		throw new StorageError(interpreted.code, interpreted.message, {
			path: layout.registryPath,
			...(interpreted.conflicts === undefined ? {} : { conflicts: interpreted.conflicts }),
		});
	}

	return { registry: interpreted.registry, fingerprint };
}

/** registry 值 → registry（或结构化拒绝）的**唯一**解释链：版本闸门 → 结构 → 绑定一致性。 */
export type RegistryInterpretation = { ok: true; registry: Registry } | { ok: false; code: StorageErrorCode; message: string; conflicts?: string[] };

/**
 * 纯粹的"值 → registry"解释，不碰任何 IO。
 *
 * 抽出来的原因（BM-02C1R / J2）：恢复核对必须对**同一次有界读取**拿到的值做与读取路径
 * 完全相同的校验，再拿这份值的字节哈希去比 before/after。若恢复侧自己写一套更弱的规则
 * （原来只看了 `revision`），一个 `schemaVersion: 999` 或结构残缺的目标就会被当成
 * "合法但不同的一版"记成 conflict，把坏数据洗成一次正常判定。
 */
export function interpretRegistryValue(value: unknown): RegistryInterpretation {
	const outcome = validateRegistry(value);
	if (!outcome.ok) {
		// 版本问题与结构问题必须分开：前者"不要猜字段"，后者"结构写错了"。
		const versionIssue = outcome.issues.find((issue) => issue.code === "unsupported-schema-version");
		if (versionIssue) {
			return { ok: false, code: "unsupported-schema-version", message: `registry 版本无法解释：${versionIssue.message}` };
		}
		return { ok: false, code: "invalid-record", message: `registry 结构不合法：${describeIssues(outcome.issues)}` };
	}

	const bindingIssues = inspectBindingIssues(outcome.value);
	if (bindingIssues.length > 0) {
		return {
			ok: false,
			code: "binding-conflict",
			message: `registry 绑定冲突：${bindingIssues.map((issue) => issue.message).join("；")}`,
			conflicts: bindingIssues.flatMap((issue) => issue.conflicts),
		};
	}

	return { ok: true, registry: outcome.value };
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

/**
 * 可重试的初始化竞争条件（BM-02AR / AR-1）。
 *
 * 只有"目标还没出现"算竞争：发布走"同目录完整临时文件 + 硬链接"，读者只会看到
 * ENOENT 或完整文件，不存在需要重试的中间态。其他错误都是确定结论，重试只会
 * 把一个永远失败的操作拖长，并把"用户取消"伪装成"竞争"。
 */
function isRetryableInitRaceError(error: unknown): boolean {
	if (!isStorageError(error)) return false;
	return error.code === "not-found" || error.code === "init-race";
}

/** 可取消的退避等待：竞争等待期间取消必须立即生效，而不是等满退避时间。 */
async function sleepWithCancellation(ms: number, signal: AbortSignal | undefined): Promise<void> {
	throwIfCancelled(signal);
	if (signal === undefined) {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, ms);
		});
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new StorageError("cancelled", "初始化竞争等待已取消"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 初始化（幂等）。
 *
 * 失败时的残留约定（BM-02AR / AR-1）：目录布局可能已建（幂等、可重复执行），
 * **但 registry 只有两种状态——不存在，或完整合法**。发布失败（`publish-unsupported`
 * / `permission-denied`）或取消都不会创建 registry，也不会留下空/半文件；
 * 本轮不做"启动时自动删锁/自动清空 registry"这类危险恢复。
 */
export async function initializeKnowledgeStore(options: InitializeKnowledgeStoreOptions): Promise<InitializeKnowledgeStoreResult> {
	const boundary = await createStorageBoundary({ root: options.root, limits: options.limits, signal: options.signal, createIfMissing: true, ioHooks: options.ioHooks });
	const layout = knowledgeLayout(boundary);
	throwIfCancelled(options.signal);

	const createdDirectories: string[] = [];
	for (const directory of [layout.projectsDir, layout.experiencesDir, layout.featuresDir, layout.auditDir, layout.cacheDir, layout.locksDir]) {
		const existed = existsSync(directory);
		// 逐目录创建：每个目录都是 IO 等待点，取消在 boundary 内部生效。
		await boundary.ensureDirectory(directory, options.signal);
		if (!existed) createdDirectories.push(directory);
	}

	// 已存在（无论内容是否合法）：只做只读校验。
	// 损坏文件既不"修复"也不覆盖——调用方拿到 invalid-json / unsupported-schema-version 自行处理。
	if (existsSync(layout.registryPath)) {
		return { status: "existing", registry: await readRegistryWithBoundary(boundary), layout, createdDirectories, raceRetries: 0 };
	}

	const empty = createEmptyRegistry(options.now ?? Date.now(), BIOS_CONTRACTS_SCHEMA_VERSION);
	// 发布前 boundary 会再查一次取消：此刻目标仍不存在，取消 = 干净失败，不留半文件（AR-1）。
	const published = await boundary.publishJson(layout.registryPath, empty, options.signal);
	if (published === "created") {
		return { status: "created", registry: empty, layout, createdDirectories, raceRetries: 0 };
	}

	// 竞争：另一个进程刚发布（或正发布）。短暂重试读取，读不到就给出可重试的明确错误。
	//
	// 只对**真正可重试的竞争**重试（BM-02AR / AR-1）：发布用的是同目录临时文件 + 硬链接，
	// 读者要么看到 ENOENT（还没发布），要么看到完整文件，不存在"半截 JSON"的中间态。
	// 因此重试白名单就是 `not-found`；其余错误（cancelled / permission-denied /
	// invalid-json / unsupported-schema-version / binding-conflict / publish-unsupported …）
	// 都是**确定的**结论，把它们伪装成 init-race 会让调用方一直重试一个永远失败的操作，
	// 也会把"用户取消了"变成"再试一次"。
	let lastError: unknown;
	for (let attempt = 1; attempt <= INIT_RACE_RETRIES; attempt += 1) {
		await sleepWithCancellation(INIT_RACE_DELAY_MS * attempt, options.signal);
		try {
			const registry = await readRegistryWithBoundary(boundary);
			return { status: "existing", registry, layout, createdDirectories, raceRetries: attempt };
		} catch (error) {
			throwIfCancelled(options.signal);
			if (!isRetryableInitRaceError(error)) throw error;
			lastError = error;
		}
	}

	throw new StorageError("init-race", `另一个进程正在初始化知识库，请稍后重试：${layout.registryPath}`, {
		path: layout.registryPath,
		detail: lastError instanceof Error ? lastError.message : undefined,
		cause: lastError,
	});
}

export type ProjectBindingQuery = {
	workspacePath?: string;
	biosProjectId?: string;
	desktopProjectId?: string;
};

export type ProjectBindingResolution =
	| { status: "resolved"; project: RegistryProjectEntry; workspace: RegistryWorkspaceEntry }
	| { status: "missing"; reason: "no-query" | "no-match" | "no-workspace" }
	| {
			status: "conflict";
			reason: "ambiguous-workspace" | "ambiguous-desktop-project" | "contradictory-filters" | "inconsistent-registry";
			candidates: string[];
	  };

function uniqueSorted(values: string[]): string[] {
	return [...new Set(values)].sort();
}

/** 空串等同于"未提供"：否则 `""` 会被当成"查询某个空 ID"并得到 no-match，掩盖调用方的拼写错误。 */
function normalizeFilter(value: string | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * 依据已有 registry 解析绑定。
 *
 * **不按相同远端猜合并**：registry 里没有远端信息，同一路径若被多个项目声称就是冲突，
 * 由调用方提示用户显式改绑。
 *
 * BM-02AR / S5 修掉三处"猜"：
 * 1. 唯一性是解析的前提——整份 registry 自身矛盾（重复 workspaceId、同一路径归属两个项目、
 *    同一 desktopProjectId 对应多个知识项目）时，任何"解析成功"都不可信，
 *    直接返回 `inconsistent-registry` 并列出冲突项；调用方应先用 `readRegistry` 报错给用户。
 * 2. 组合过滤必须自洽——同时给出 `biosProjectId` 与 `desktopProjectId` 时，
 *    旧实现只看第一个、把矛盾过滤**静默忽略**，于是"问的是 A 项目、答的是 B 项目的路径"。
 *    现在两个过滤条件都参与匹配，指向不同项目即 `contradictory-filters`。
 * 3. 多工作区不能取 `workspaces[0]`——同一项目有多个 worktree 时"第一个"是任意顺序，
 *    等于随机绑定。此时必须给出 `workspacePath`，否则返回 `ambiguous-workspace` 与候选列表。
 */
export function resolveProjectBinding(registry: Registry, query: ProjectBindingQuery, platform: NodeJS.Platform = process.platform): ProjectBindingResolution {
	const workspacePath = normalizeFilter(query.workspacePath);
	const biosProjectId = normalizeFilter(query.biosProjectId);
	const desktopProjectId = normalizeFilter(query.desktopProjectId);

	if (workspacePath === undefined && biosProjectId === undefined && desktopProjectId === undefined) {
		return { status: "missing", reason: "no-query" };
	}

	// 1) 唯一性先于解析。
	const registryIssues = inspectBindingIssues(registry, platform);
	if (registryIssues.length > 0) {
		return { status: "conflict", reason: "inconsistent-registry", candidates: uniqueSorted(registryIssues.flatMap((issue) => issue.conflicts)) };
	}

	// 2) 项目级过滤：两个身份条件都参与，不能只挑一个。
	const projectFiltered = registry.projects.filter((entry) => {
		if (biosProjectId !== undefined && entry.biosProjectId !== biosProjectId) return false;
		if (desktopProjectId !== undefined && entry.desktopProjectId !== desktopProjectId) return false;
		return true;
	});

	if (biosProjectId !== undefined && desktopProjectId !== undefined && projectFiltered.length === 0) {
		const byId = registry.projects.find((entry) => entry.biosProjectId === biosProjectId);
		if (byId === undefined) return { status: "missing", reason: "no-match" };
		return { status: "conflict", reason: "contradictory-filters", candidates: uniqueSorted([biosProjectId, desktopProjectId]) };
	}

	// 3) 路径查询（最具体，优先）。
	if (workspacePath !== undefined) {
		const key = workspacePathKey(workspacePath, platform);
		const matches: Array<{ project: RegistryProjectEntry; workspace: RegistryWorkspaceEntry }> = [];
		for (const project of projectFiltered) {
			for (const workspace of project.workspaces) {
				if (workspacePathKey(workspace.path, platform) === key) matches.push({ project, workspace });
			}
		}
		if (matches.length === 0) return { status: "missing", reason: "no-match" };

		const projectIds = uniqueSorted(matches.map((match) => match.project.biosProjectId));
		if (projectIds.length > 1) return { status: "conflict", reason: "ambiguous-workspace", candidates: projectIds };

		// 同一项目内同一路径对应多个工作区的重复绑定已在步骤 1 被拒绝，
		// 因此这里最多只有一个匹配：取它是确定结论，不是猜。
		const chosen = matches[0];
		if (chosen === undefined) return { status: "missing", reason: "no-match" };
		return { status: "resolved", project: chosen.project, workspace: chosen.workspace };
	}

	// 4) 项目级查询。
	if (projectFiltered.length === 0) return { status: "missing", reason: "no-match" };
	if (projectFiltered.length > 1) {
		// 只可能是"仅按 desktopProjectId 查询且重复"（biosProjectId 唯一性已保证）。
		return { status: "conflict", reason: "ambiguous-desktop-project", candidates: uniqueSorted(projectFiltered.map((entry) => entry.biosProjectId)) };
	}

	const project = projectFiltered[0];
	if (project === undefined) return { status: "missing", reason: "no-match" };

	// 5) 多工作区必须显式指定路径，不能替调用方挑一个。
	if (project.workspaces.length === 0) return { status: "missing", reason: "no-workspace" };
	if (project.workspaces.length > 1) {
		return { status: "conflict", reason: "ambiguous-workspace", candidates: uniqueSorted(project.workspaces.map((workspace) => workspace.workspaceId)) };
	}

	const workspace = project.workspaces[0];
	if (workspace === undefined) return { status: "missing", reason: "no-workspace" };
	return { status: "resolved", project, workspace };
}
