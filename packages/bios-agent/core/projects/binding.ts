/**
 * BM-03 B1：**显式绑定与档案打开**。
 *
 * 三条纪律（对应 bm03_development_plan.md §3 B1）：
 * 1. **授权先于 IO**：目标目录必须能由会话 cwd + 适配层注入的授权根解析出来；
 *    模型参数不能扩大授权范围（`resolveAuthorizedTargetDir` 负责真实路径判定）。
 * 2. **不猜合并**：同一个远端、同一个目录名、同一块板子都**不**构成"同一项目"的证据。
 *    新项目/新工作区用稳定 UUID；已存在的绑定只能由调用方显式给出身份后复用。
 * 3. **不做通用事务**：registry 与 profile 是两个文件，没有跨文件原子性。
 *    这里限定固定步骤、逐步记录发布事实；失败/取消后如实报告"部分完成"，
 *    重复执行先读现状再判定，**不**自动回滚、不无条件删档案。
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectProfile } from "../contracts/records.ts";
import type { Registry, RegistryProjectEntry, RegistryWorkspaceEntry } from "../contracts/registry.ts";
import { createRecord, isNotFoundError, isStorageError, isStorageErrorCode, readRecord, readRegistry, resolveProjectBinding, updateRecord, updateRegistry, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { AuthorizedTargetError, authorizeWorkspacePath, resolveAuthorizedTargetDir } from "./authorization.ts";
import { inconsistent, invalidArgument, notAuthorized, optionalAbsolutePath, optionalBoundedText, ProjectServiceError, type ProjectServiceErrorCode, type ProjectServiceLimits } from "./contract.ts";
import { createEmptyIdentity } from "./fields.ts";
import { collectWriteNotes, mergeWriteNotes, type WriteOutcomeNotes } from "./writeNotes.ts";

/** 单步写入的发布事实（每步独立，失败不回滚已成功的那一步）。 */
export type ProjectWriteStep = {
	readonly step: "registry" | "profile";
	readonly status: "published" | "skipped" | "failed";
	readonly revision?: number;
	readonly detail?: string;
};

export type BindProjectInput = {
	readonly root: string;
	/** 会话工作目录：默认授权根。 */
	readonly cwd: string;
	/** 适配层注入的额外授权根（模型无法设置）。 */
	readonly authorizedRoots?: readonly string[];
	/** 要绑定的工作区目录（绝对路径，或相对 cwd）。 */
	readonly workspacePath: string;
	/** 显式项目身份：给出时按它复用（registry 里没有就按这个 ID 新建）。 */
	readonly biosProjectId?: string;
	readonly desktopProjectId?: string;
	readonly displayName?: string;
	/** 显式工作区身份：给出时表示"把这份检出接到该工作区"（路径迁移保持 workspaceId）。 */
	readonly workspaceId?: string;
	readonly limits?: Partial<ProjectServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type BindProjectResult = {
	/**
	 * - `bound`：本次确实发布了写入；
	 * - `already-bound`：读到的现状已经是绑定的（本次没有写入）；
	 * - `needs-review`：写入已经提交，但底层报告了需要人工核对的事实（journal 终态未写、清理/锁释放异常）；
	 * - `partial`：只完成了部分步骤（另有 `steps` 说明哪一步没成）；
	 * - `failed`：registry 步骤失败，本次没有写入任何内容。
	 */
	readonly status: "bound" | "already-bound" | "needs-review" | "partial" | "failed";
	readonly projectId: string | null;
	readonly workspaceId: string | null;
	readonly workspacePath: string | null;
	readonly registryRevision: number | null;
	readonly profileRevision: number | null;
	readonly steps: readonly ProjectWriteStep[];
	/** 半完成时的人工接续方法（明确写出下一步，不承诺自动修复）。 */
	readonly resume: readonly string[];
	readonly problems: readonly string[];
	/** 存储层报告的"提交成立但有遗留"诊断（透传，不吞）。 */
	readonly warnings: readonly string[];
	/** 需要人工/巡检核对的原因（已提交但记账/清理未完成）。 */
	readonly needsReview: readonly string[];
};

/**
 * 目录授权 + 规范化。
 *
 * 先授权后扫描/dispatch：拒绝时不返回目录内任何信息，也不把非法参数回显成路径探针。
 */
function resolveWorkspaceDirectory(input: { cwd: string; authorizedRoots?: readonly string[]; workspacePath: string }): string {
	try {
		const authorized = resolveAuthorizedTargetDir({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, requested: input.workspacePath });
		return authorized.targetDir;
	} catch (error) {
		if (error instanceof AuthorizedTargetError) {
			if (error.code === "outside-authorized-roots") throw notAuthorized(`工作区不在已授权范围内：${error.message}`, error.code);
			if (error.code === "invalid-authorized-root" || error.code === "invalid-cwd") throw invalidArgument(error.message, error.code);
			throw new ProjectServiceError("not-found", error.message, { detail: error.code, cause: error });
		}
		throw error;
	}
}

function assertNotCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new ProjectServiceError("cancelled", "项目操作已取消");
}

/**
 * "知识库还不存在"的两种存储错误：`not-found`（缺 registry.json）与 `invalid-root`（根本身不存在）。
 *
 * 两者对调用方的意义相同：**这不是一次可用的读取**，而是"还没有可读的知识库"，
 * CLI 应提示先初始化，而不是把它当成 IO 故障。
 */
function isMissingStoreError(error: unknown): boolean {
	return isNotFoundError(error) || isStorageErrorCode(error, "not-found") || isStorageErrorCode(error, "invalid-root");
}

/** 把存储层错误映射成受控的服务错误码（调用方只需处理一种错误分类）。 */
function mapStorageError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code: ProjectServiceErrorCode = error.code === "revision-conflict" ? "revision-conflict" : error.code === "cancelled" ? "cancelled" : error.code === "not-found" ? "not-found" : error.code === "binding-conflict" || error.code === "invalid-record" ? "inconsistent" : "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

function workspaceEntry(workspaceId: string, path: string, now: number): RegistryWorkspaceEntry {
	return { workspaceId, path, boundAt: now };
}

/** profile 里的工作区绑定（availability 先按"刚绑定、马上核对"处理，采集由 B4 负责）。 */
function profileWorkspace(workspaceId: string, path: string, now: number): ProjectProfile["workspaces"][number] {
	return { workspaceId, path, availability: "unknown", capturedAt: now };
}

export async function bindProjectWorkspace(input: BindProjectInput): Promise<BindProjectResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("绑定参数必须是对象");
	const root = optionalAbsolutePath(input.root, "知识根");
	if (root === undefined) throw invalidArgument("必须显式指定知识根");
	const workspacePath = optionalAbsolutePath(input.workspacePath, "工作区路径");
	if (workspacePath === undefined) throw invalidArgument("必须显式指定要绑定的工作区路径");
	const displayName = optionalBoundedText(input.displayName, "显示名", 120);
	const now = input.now ?? Date.now();

	assertNotCancelled(input.signal);
	// 授权在 IO 之前：目标不在授权根内时不会读到任何知识库内容。
	const workspaceDir = resolveWorkspaceDirectory({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, workspacePath });

	const steps: ProjectWriteStep[] = [];
	const problems: string[] = [];
	const resume: string[] = [];
	/** 每一步写入的底层事实（warnings / journal / 清理 / 锁）：最后合并进结果，绝不静默丢弃。 */
	const notes: WriteOutcomeNotes[] = [];

	let registry: Registry;
	try {
		registry = await readRegistry({ root, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	} catch (error) {
		if (isMissingStoreError(error)) {
			throw new ProjectServiceError("not-found", `知识库尚未初始化（缺少 registry.json）：${root}`, { detail: "store-not-initialized" });
		}
		throw mapStorageError(error, "读取 registry 失败");
	}

	// ---- 步骤 1：registry 绑定（已存在则跳过，先把"现状"读清楚） ----
	const existing = resolveProjectBinding(registry, { workspacePath: workspaceDir });
	let projectId: string | null = null;
	let workspaceId: string | null = null;
	let registryRevision = registry.revision;
	let registryPublished = false;

	if (existing.status === "resolved") {
		projectId = existing.project.biosProjectId;
		workspaceId = existing.workspace.workspaceId;
		if (input.biosProjectId !== undefined && input.biosProjectId !== projectId) {
			throw inconsistent(`该工作区已绑定到另一个项目（registry：${projectId}，参数：${input.biosProjectId}），拒绝按参数改绑`, "workspace-claimed-by-other-project");
		}
		if (input.desktopProjectId !== undefined && existing.project.desktopProjectId !== undefined && existing.project.desktopProjectId !== input.desktopProjectId) {
			throw inconsistent(`该工作区所属项目的桌面项目 ID 与参数不一致（registry：${existing.project.desktopProjectId}）`, "desktop-project-mismatch");
		}
		// Explicit binding also repairs legacy path-only entries. Preserve the original
		// project/workspace IDs and all history; never replace a foreign desktop owner.
		if (input.desktopProjectId !== undefined && existing.project.desktopProjectId === undefined) {
			const projects = registry.projects.map((entry) => (entry.biosProjectId === projectId ? { ...entry, desktopProjectId: input.desktopProjectId, updatedAt: now } : entry));
			try {
				const written = await updateRegistry({ root, projects, expectedRevision: registry.revision, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits, lockTimeoutMs: input.lockTimeoutMs, lockPollMs: input.lockPollMs });
				registry = written.registry;
				registryRevision = written.revision;
				registryPublished = true;
				notes.push(collectWriteNotes(written, "registry 桌面绑定补齐"));
				steps.push({ step: "registry", status: "published", revision: written.revision });
			} catch (error) {
				const mapped = mapStorageError(error, "补齐桌面绑定失败");
				return {
					status: "failed",
					projectId,
					workspaceId,
					workspacePath: workspaceDir,
					registryRevision: null,
					profileRevision: null,
					steps: [{ step: "registry", status: "failed", detail: mapped.detail ?? mapped.code }],
					resume: ["重新预览并确认接入；原有知识保留，不会重复创建项目。"],
					problems: [mapped.message],
					warnings: [],
					needsReview: [],
				};
			}
		} else {
			steps.push({ step: "registry", status: "skipped", revision: registry.revision, detail: "already-bound" });
		}
	} else if (existing.status === "conflict") {
		throw inconsistent(`无法唯一定位工作区绑定：${existing.reason}（候选：${existing.candidates.join("、") || "无"}）`, existing.reason);
	} else {
		const requestedProjectId = optionalBoundedText(input.biosProjectId, "项目 ID", 64);
		const targetProject = requestedProjectId === undefined ? undefined : registry.projects.find((entry) => entry.biosProjectId === requestedProjectId);
		const requestedWorkspaceId = optionalBoundedText(input.workspaceId, "工作区 ID", 64);

		projectId = targetProject?.biosProjectId ?? requestedProjectId ?? randomUUID();
		workspaceId = requestedWorkspaceId ?? randomUUID();

		if (targetProject !== undefined && requestedWorkspaceId !== undefined && !targetProject.workspaces.some((workspace) => workspace.workspaceId === requestedWorkspaceId)) {
			throw inconsistent(`显式指定的工作区 ${requestedWorkspaceId} 不在项目 ${projectId} 的已绑定工作区里`, "workspace-not-in-project");
		}

		// registry 写入是**完整替换**：先复制一份再改，避免把读取到的对象原地改掉。
		const projects: RegistryProjectEntry[] = registry.projects.map((entry) => ({ ...entry, workspaces: entry.workspaces.map((workspace) => ({ ...workspace })) }));
		if (targetProject === undefined) {
			projects.push({
				biosProjectId: projectId,
				...(input.desktopProjectId === undefined ? {} : { desktopProjectId: input.desktopProjectId }),
				...(displayName === undefined ? {} : { displayName }),
				workspaces: [workspaceEntry(workspaceId, workspaceDir, now)],
				createdAt: now,
				updatedAt: now,
			});
		} else {
			const entry = projects.find((candidate) => candidate.biosProjectId === projectId);
			if (entry === undefined) throw inconsistent(`registry 里找不到项目 ${projectId}（读取与写入之间发生了变化？）`, "project-vanished");
			// 显式给出的 workspaceId 已存在 ⇒ 这是**路径迁移**：替换那一条，不追加（追加会造成同一 workspaceId 出现两次）。
			const migrating = entry.workspaces.some((workspace) => workspace.workspaceId === workspaceId);
			entry.workspaces = migrating ? entry.workspaces.map((workspace) => (workspace.workspaceId === workspaceId ? workspaceEntry(workspaceId, workspaceDir, now) : workspace)) : [...entry.workspaces, workspaceEntry(workspaceId, workspaceDir, now)];
			entry.updatedAt = now;
			if (displayName !== undefined) entry.displayName = displayName;
		}

		try {
			const written = await updateRegistry({ root, projects, expectedRevision: registry.revision, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits, lockTimeoutMs: input.lockTimeoutMs, lockPollMs: input.lockPollMs });
			registryRevision = written.revision;
			registryPublished = true;
			registry = written.registry;
			notes.push(collectWriteNotes(written, "registry 绑定"));
			steps.push({ step: "registry", status: "published", revision: written.revision });
		} catch (error) {
			const mapped = mapStorageError(error, "registry 绑定失败");
			steps.push({ step: "registry", status: "failed", detail: mapped.detail ?? mapped.code });
			problems.push(mapped.message);
			// 绑定未发布 ⇒ 档案不能建：否则会出现"档案说属于某项目、registry 里没有这个绑定"的半成品。
			resume.push("修正原因后重新执行同一条 bind 命令；本步骤失败时不会写入档案。");
			const merged = mergeWriteNotes(notes);
			return { status: "failed", projectId, workspaceId, workspacePath: workspaceDir, registryRevision: null, profileRevision: null, steps, resume, problems, warnings: merged.warnings, needsReview: merged.needsReview };
		}
	}

	// ---- 步骤 2：档案（新建或补齐工作区；只改必要字段，CAS 保护） ----
	let profileRevision: number | null = null;
	let profile: ProjectProfile | null = null;
	try {
		const read = await readRecord({ root, kind: "project-profile", id: projectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		profile = read.record;
		profileRevision = read.record.revision;
	} catch (error) {
		if (isNotFoundError(error) || isStorageErrorCode(error, "not-found")) {
			// 正常路径：档案还不存在，下面会创建。
		} else {
			// 旧行为是直接抛错，于是"registry 已经发布"这件事连同 projectId/revision 一起消失，
			// 调用方只看到一句 io-error（R28-1）。这里必须把已发布的**事实**留在结果里。
			const mapped = mapStorageError(error, "读取项目档案失败");
			steps.push({ step: "profile", status: "failed", detail: mapped.detail ?? mapped.code });
			problems.push(mapped.message);
			resume.push(registryPublished ? "registry 绑定已发布但档案未确认：重新执行同一条 bind 命令即可继续（会先读现状，不会重复建项目）。" : "绑定已存在但档案未能读取：修正原因后重新执行同一条 bind 命令（不会重复建项目）。");
			const merged = mergeWriteNotes(notes);
			return { status: "partial", projectId, workspaceId, workspacePath: workspaceDir, registryRevision, profileRevision: null, steps, resume, problems, warnings: merged.warnings, needsReview: merged.needsReview };
		}
	}

	try {
		if (profile === null) {
			const created = await createRecord({
				kind: "project-profile",
				id: projectId,
				data: { identity: createEmptyIdentity(now), workspaces: [profileWorkspace(workspaceId, workspaceDir, now)], buildTargets: [], keyEntryPoints: [], gaps: [] },
				expectedRevision: null,
				root,
				now,
				signal: input.signal,
				ioHooks: input.ioHooks,
				limits: input.storageLimits,
				lockTimeoutMs: input.lockTimeoutMs,
				lockPollMs: input.lockPollMs,
			});
			notes.push(collectWriteNotes(created, "项目档案"));
			profileRevision = created.revision;
			steps.push({ step: "profile", status: "published", revision: created.revision });
		} else {
			const existingWorkspace = profile.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
			const pathChanged = existingWorkspace !== undefined && existingWorkspace.path !== workspaceDir;
			if (existingWorkspace !== undefined && !pathChanged) {
				steps.push({ step: "profile", status: "skipped", revision: profile.revision, detail: "workspace-already-in-profile" });
			} else {
				// 路径迁移 / 新增工作区：**保留**未触达字段、其它工作区、证据与资料缺口。
				const workspaces = existingWorkspace === undefined ? [...profile.workspaces, profileWorkspace(workspaceId, workspaceDir, now)] : profile.workspaces.map((workspace) => (workspace.workspaceId === workspaceId ? { ...workspace, path: workspaceDir, capturedAt: now } : workspace));
				const updated = await updateRecord({
					kind: "project-profile",
					id: projectId,
					data: { identity: profile.identity, workspaces, buildTargets: profile.buildTargets, keyEntryPoints: profile.keyEntryPoints, gaps: profile.gaps },
					expectedRevision: profile.revision,
					root,
					now,
					signal: input.signal,
					ioHooks: input.ioHooks,
					limits: input.storageLimits,
					lockTimeoutMs: input.lockTimeoutMs,
					lockPollMs: input.lockPollMs,
				});
				notes.push(collectWriteNotes(updated, "项目档案"));
				profileRevision = updated.revision;
				steps.push({ step: "profile", status: "published", revision: updated.revision, detail: pathChanged ? "workspace-path-migrated" : "workspace-added" });
			}
		}
	} catch (error) {
		const mapped = mapStorageError(error, "写入项目档案失败");
		steps.push({ step: "profile", status: "failed", detail: mapped.detail ?? mapped.code });
		problems.push(mapped.message);
		if (registryPublished) resume.push("registry 绑定已发布但档案未写入：重新执行同一条 bind 命令即可继续（会先读现状，不会重复建项目）。");
		const merged = mergeWriteNotes(notes);
		return {
			status: "partial",
			projectId,
			workspaceId,
			workspacePath: workspaceDir,
			registryRevision,
			profileRevision,
			steps,
			resume,
			problems,
			warnings: merged.warnings,
			needsReview: merged.needsReview,
		};
	}

	const merged = mergeWriteNotes(notes);
	const publishedAnything = registryPublished || steps.some((step) => step.step === "profile" && step.status === "published");
	// 已提交但底层报告了需要核对的事实 ⇒ 不能报"干净成功"。
	const status: BindProjectResult["status"] = merged.needsReview.length > 0 && publishedAnything ? "needs-review" : publishedAnything ? "bound" : "already-bound";
	return { status, projectId, workspaceId, workspacePath: workspaceDir, registryRevision, profileRevision, steps, resume, problems, warnings: merged.warnings, needsReview: merged.needsReview };
}

/* ------------------------------------------------------------------ 只读打开 */

export type OpenProjectInput = {
	readonly root: string;
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	readonly workspacePath?: string;
	readonly biosProjectId?: string;
	readonly desktopProjectId?: string;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	/** 是否核对工作区目录可达性（默认 true；纯知识库盘点时可关掉以避免不必要的 IO）。 */
	readonly checkWorkspace?: boolean;
};

export type ProjectOpenProblem = { readonly code: string; readonly detail: string };

export type OpenProjectResult = {
	/**
	 * `not-authorized`：入档的工作区路径不在本次会话的 cwd/授权根内（R28-4）。
	 * 它是**拒绝**，不是"不可达"：不可达时授权仍然成立（目录只是暂时不在）。
	 */
	readonly status: "usable" | "inconsistent" | "missing" | "unreachable" | "not-authorized";
	readonly usable: boolean;
	readonly projectId: string | null;
	readonly workspaceId: string | null;
	readonly workspacePath: string | null;
	readonly registryRevision: number | null;
	readonly profileRevision: number | null;
	readonly profile: ProjectProfile | null;
	readonly workspace: ProjectProfile["workspaces"][number] | null;
	readonly workspaceAvailability: "reachable" | "missing" | "permission-denied" | "unknown";
	readonly problems: readonly ProjectOpenProblem[];
};

function baseResult(status: OpenProjectResult["status"], problems: ProjectOpenProblem[]): OpenProjectResult {
	return { status, usable: false, projectId: null, workspaceId: null, workspacePath: null, registryRevision: null, profileRevision: null, profile: null, workspace: null, workspaceAvailability: "unknown", problems };
}

/**
 * 只读打开：把 registry ↔ profile ↔ 工作区目录三者的**一致性状态**如实报告出来。
 *
 * 只有 `status === "usable"` 时调用方才可以把它当成"打开的完整结果"用于后续业务；
 * 其余状态都必须先由人工处理（这里不自动修绑定、不删档案、不挑一个工作区代替）。
 */
export async function openProjectProfile(input: OpenProjectInput): Promise<OpenProjectResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("打开参数必须是对象");
	const root = optionalAbsolutePath(input.root, "知识根");
	if (root === undefined) throw invalidArgument("必须显式指定知识根");
	assertNotCancelled(input.signal);

	let registry: Registry;
	try {
		registry = await readRegistry({ root, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	} catch (error) {
		if (isMissingStoreError(error)) {
			return baseResult("missing", [{ code: "store-not-initialized", detail: `知识库尚未初始化或知识根不可用：${root}` }]);
		}
		throw mapStorageError(error, "读取 registry 失败");
	}

	const binding = resolveProjectBinding(registry, {
		...(input.workspacePath === undefined ? {} : { workspacePath: input.workspacePath }),
		...(input.biosProjectId === undefined ? {} : { biosProjectId: input.biosProjectId }),
		...(input.desktopProjectId === undefined ? {} : { desktopProjectId: input.desktopProjectId }),
	});
	if (binding.status === "missing") {
		return { ...baseResult("missing", [{ code: binding.reason === "no-query" ? "no-query" : "binding-not-found", detail: `按给定条件找不到工作区绑定（${binding.reason}）` }]), registryRevision: registry.revision };
	}
	if (binding.status === "conflict") {
		return {
			...baseResult("inconsistent", [{ code: binding.reason, detail: `绑定解析不唯一或 registry 自身矛盾：${binding.reason}（候选：${binding.candidates.join("、") || "无"}）` }]),
			registryRevision: registry.revision,
		};
	}

	const project = binding.project;
	const workspaceEntryValue = binding.workspace;

	// 绑定记录是**过去的**授权结果，不能当成长期通行证：
	// 每次打开都按本次会话的 cwd/授权根重新判定工作区路径（R28-4）。
	const authorization = authorizeWorkspacePath({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, path: workspaceEntryValue.path });
	if (!authorization.authorized) {
		return {
			...baseResult("not-authorized", [{ code: "workspace-not-authorized", detail: `工作区 ${workspaceEntryValue.path} 不在本次会话的授权范围内；绑定保留，请显式把它加入授权根或改用已授权的工作区` }]),
			projectId: project.biosProjectId,
			workspaceId: workspaceEntryValue.workspaceId,
			workspacePath: workspaceEntryValue.path,
			registryRevision: registry.revision,
		};
	}

	const problems: ProjectOpenProblem[] = [];

	let profile: ProjectProfile | null = null;
	let profileRevision: number | null = null;
	try {
		const read = await readRecord({ root, kind: "project-profile", id: project.biosProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		profile = read.record;
		profileRevision = read.record.revision;
	} catch (error) {
		if (isNotFoundError(error) || (isStorageError(error) && error.code === "not-found")) {
			problems.push({ code: "profile-missing", detail: `registry 绑定了项目 ${project.biosProjectId}，但档案不存在` });
		} else {
			throw mapStorageError(error, "读取项目档案失败");
		}
	}

	let workspace: ProjectProfile["workspaces"][number] | null = null;
	if (profile !== null) {
		workspace = profile.workspaces.find((candidate) => candidate.workspaceId === workspaceEntryValue.workspaceId) ?? null;
		if (workspace === null) problems.push({ code: "workspace-not-in-profile", detail: `registry 里的工作区 ${workspaceEntryValue.workspaceId} 不在档案的 workspaces 里` });
		else if (workspace.path !== workspaceEntryValue.path) {
			problems.push({ code: "workspace-path-mismatch", detail: `registry 路径（${workspaceEntryValue.path}）与档案路径（${workspace.path}）不一致` });
		}
	}

	// 可达性：不可达只报告，**不删除**绑定（目录移动要靠显式改绑）。
	let availability: OpenProjectResult["workspaceAvailability"] = "unknown";
	if (input.checkWorkspace !== false) {
		try {
			const stats = await stat(workspaceEntryValue.path);
			availability = stats.isDirectory() ? "reachable" : "missing";
			if (!stats.isDirectory()) problems.push({ code: "workspace-not-directory", detail: "绑定路径当前不是目录" });
		} catch (error) {
			const code = isNotFoundError(error) ? "missing" : "permission-denied";
			availability = code;
			problems.push({ code: `workspace-${code}`, detail: `工作区目录当前${code === "missing" ? "不存在" : "不可访问"}；绑定保留，等待显式改绑` });
		}
	} else if (workspace !== null) {
		availability = workspace.availability;
	}

	const status: OpenProjectResult["status"] = problems.some((problem) => problem.code === "profile-missing" || problem.code === "workspace-not-in-profile" || problem.code === "workspace-path-mismatch") ? "inconsistent" : problems.length > 0 ? "unreachable" : "usable";

	return {
		status,
		usable: status === "usable",
		projectId: project.biosProjectId,
		workspaceId: workspaceEntryValue.workspaceId,
		workspacePath: workspaceEntryValue.path,
		registryRevision: registry.revision,
		profileRevision,
		profile,
		workspace,
		workspaceAvailability: availability,
		problems,
	};
}

/** 便于 CLI/测试把"失败的绑定"折叠成一行结论。 */
export function describeBindResult(result: BindProjectResult): string {
	const published = result.steps.filter((step) => step.status === "published").map((step) => `${step.step}#${step.revision ?? "?"}`);
	const skipped = result.steps.filter((step) => step.status === "skipped").map((step) => step.step);
	const failed = result.steps.filter((step) => step.status === "failed").map((step) => `${step.step}(${step.detail ?? "failed"})`);
	return [
		`status=${result.status}`,
		published.length > 0 ? `已发布：${published.join("、")}` : "未发布写入",
		skipped.length > 0 ? `已跳过：${skipped.join("、")}` : "",
		failed.length > 0 ? `失败：${failed.join("、")}` : "",
		result.needsReview.length > 0 ? `需人工核对：${result.needsReview.join("；")}` : "",
		result.warnings.length > 0 ? `遗留诊断：${result.warnings.join("；")}` : "",
	]
		.filter((part) => part !== "")
		.join("；");
}
