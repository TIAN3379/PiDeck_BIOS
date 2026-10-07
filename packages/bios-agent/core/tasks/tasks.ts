/**
 * BM-05 B1/B2 + R30-1/R30-3：**任务事实服务**（v1 `TaskRecord`，不升 schema）。
 *
 * 复用 `projects/<projectId>/tasks/<taskId>.json` 的既有落点与 `createRecord`/`updateRecord` 的
 * CAS + journal 事实透传；不新建事务框架、不新增任务审计状态机。
 *
 * 八条纪律：
 * 1. **公开入口显式授权**（R30-1）：创建/读取/更新/状态全部要求 `authorizedProjectIds` 显式包含
 *    该任务所属项目；缺省或空集合**在返回冲突/状态/revision 之前**就拒绝，不泄漏任何状态；
 * 2. **项目绑定真实**：`projectId` 必须存在于 registry，`workspaceId` 必须属于该项目，
 *    工作区路径按本次 `cwd`/授权根**重新**判定（绑定记录不是长期通行证）；
 * 3. **服务身份 = projectId + taskId**：相同裸 taskId 可以在不同项目里各有一条，互不串；
 * 4. **默认 planned**：首建不接受任意状态；状态变更只能走具名 CAS 动作（见 `changeTaskStatus`）；
 * 5. **一切有界**：正文/数组/文件路径/关联 ID/验证证据数量在 IO 前判定；
 * 6. **普通更新只改点名字段**，必须带 `expectedRevision`；未触达字段原样保留；同值不制造 revision；
 * 7. **经验引用只是引用**：按授权与现时审核状态重读，草稿/废弃/不可读/越权只提示缺口，
 *    不复制整卡正文，也不把缺口当作当前依据；**发布之后**的核对失败保留提交事实（R30-3）；
 * 8. **done 只代表工程师声明任务结束**：不代表硬件已验证、经验已审核或源码已提交。
 */
import type { EvidenceRef, EvidenceSourceType, TaskStatus, ValidationKind, ValidationRecord, ValidationResult } from "../contracts/common.ts";
import type { TaskRecord } from "../contracts/records.ts";
import { createRecord, isStorageError, readRecord, updateRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { authorizeWorkspacePath } from "../projects/authorization.ts";
import { collectWriteNotes } from "../projects/writeNotes.ts";
import { requireSourceProject } from "../knowledge/access.ts";
import { invalidArgument, notAuthorized, ProjectServiceError, requireBody, requireKnowledgeId, requireKnowledgeIds, requireRelativePath, requireShortItem, requireShortItems, resolveKnowledgeLimits, type KnowledgeServiceLimits } from "../knowledge/contract.ts";

/** 任务正文/数组的预算：与知识服务共用同一份来源（`KnowledgeServiceLimits`）。 */
export type TaskServiceLimits = KnowledgeServiceLimits;

export const TASK_STATUSES: readonly TaskStatus[] = ["planned", "in_progress", "blocked", "done", "archived"];

/**
 * 有限合法状态转换表（B2）。
 *
 * - `done → in_progress` 是**显式重开**：重开后新 revision 才是真相，旧交接的 done 不得覆盖；
 * - `archived → in_progress` 是显式恢复，不能靠编辑正文悄悄复活；
 * - 其余一律非法（受控拒绝）。
 */
export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
	planned: ["in_progress", "blocked", "archived"],
	in_progress: ["blocked", "done", "archived"],
	blocked: ["in_progress", "archived"],
	done: ["in_progress", "archived"],
	archived: ["in_progress"],
};

/** 任务验证证据（v1 `EvidenceRef` 的合法子集；给出时按类型校验，不静默落成空数组）。 */
export type TaskEvidenceInput = {
	readonly type: EvidenceSourceType;
	readonly relativePath?: string | null;
	readonly contentHash?: string | null;
	readonly workspaceId?: string | null;
	readonly commit?: string | null;
	readonly location?: string | null;
};

export type TaskValidationInput = {
	readonly kind: ValidationKind;
	readonly scope: string;
	readonly result: ValidationResult;
	readonly performedAt: number;
	readonly performedBy: string;
	/** v1 合法的验证证据（可选；给出时保留，不再静默丢弃）。 */
	readonly evidence?: readonly TaskEvidenceInput[];
};

export type TaskCreateInput = {
	readonly root: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly workspaceId: string;
	/** 会话工作目录（默认授权根），用于重新判定工作区路径授权。 */
	readonly cwd: string;
	readonly authorizedRoots?: readonly string[];
	requirement: string;
	/** 首建只接受 `planned`（缺省即 planned）；不给别的状态。 */
	readonly status?: "planned";
	readonly branch?: string;
	readonly baseCommit?: string;
	readonly decisions?: readonly string[];
	readonly todos?: readonly string[];
	readonly blockers?: readonly string[];
	readonly relatedFiles?: readonly string[];
	readonly sourceExperienceIds?: readonly string[];
	readonly validations?: readonly TaskValidationInput[];
	/** 被授权读取/修改该项目的显式声明（**必填**；缺省即拒绝）。 */
	readonly authorizedProjectIds: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type TaskWriteOptions = {
	readonly root: string;
	readonly projectId: string;
	readonly taskId: string;
	/** 被授权读取/修改该项目的显式声明（**必填**；缺省即拒绝）。 */
	readonly authorizedProjectIds: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type TaskWriteResult = {
	readonly status: "created" | "updated" | "unchanged" | "revision-conflict" | "not-found" | "not-authorized" | "inconsistent";
	readonly taskId: string;
	readonly projectId: string;
	readonly revision: number | null;
	readonly actualRevision: number | null;
	readonly changedFields: readonly string[];
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	/** 经验引用的核对缺口（草稿/废弃/不可读/越权）；引用仍然保存，但不能当作当前依据。 */
	readonly referenceGaps: readonly string[];
	readonly problems: readonly string[];
};

export type TaskExperienceRef = {
	readonly experienceId: string;
	readonly found: boolean;
	readonly status: string | null;
	readonly sourceProjectId: string | null;
	/** 是否可作为任务当前依据（来源已授权、可读、且状态是 reviewed/verified）。 */
	readonly usableAsBasis: boolean;
	readonly reason: string | null;
};

export type TaskDetailResult = {
	readonly status: "ok" | "not-found" | "not-authorized";
	readonly taskId: string;
	readonly projectId: string;
	readonly revision: number | null;
	readonly task: TaskRecord | null;
	readonly references: readonly TaskExperienceRef[];
	/** 入档工作区路径当前是否仍在本次授权范围内（不可达不等于未授权）。 */
	readonly workspaceAuthorized: boolean;
	readonly problems: readonly string[];
};

function assertRoot(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument("必须显式指定知识根");
	return value;
}

/**
 * 公开写入口的授权闸门（R30-1）。
 *
 * 必须在**任何**读写之前调用：这样"未授权"不会以 `revision-conflict`（带实际 revision）或
 * `illegal-transition`（带当前状态）的形式泄漏状态。空集合与省略都按未授权处理。
 */
function requireProjectAuthorization(authorizedProjectIds: readonly string[] | undefined, projectId: string): void {
	if (authorizedProjectIds === undefined || authorizedProjectIds.length === 0) throw notAuthorized("必须显式给出项目授权（authorizedProjectIds）；缺省即拒绝", "project-not-authorized");
	if (!authorizedProjectIds.includes(projectId)) throw notAuthorized(`项目 ${projectId} 不在本次授权范围内`, "project-not-authorized");
}

/** 存储层错误 → 受控服务错误码（与知识服务同一口径）。 */
function mapStorageError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code = error.code === "revision-conflict" ? "revision-conflict" : error.code === "cancelled" ? "cancelled" : error.code === "not-found" ? "not-found" : error.code === "invalid-record" || error.code === "audit-conflict" || error.code === "unsupported-schema-version" ? "inconsistent" : "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

const VALIDATION_KINDS: readonly ValidationKind[] = ["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"];
const VALIDATION_RESULTS: readonly ValidationResult[] = ["passed", "failed", "inconclusive"];
const EVIDENCE_TYPES: readonly EvidenceSourceType[] = ["source-file", "commit", "document", "session", "human-note"];
const EVIDENCE_KEYS = ["type", "relativePath", "contentHash", "workspaceId", "commit", "location"] as const;

/** 任务验证证据 → v1 `EvidenceRef`：给出就保留，未知键拒绝，必填项按类型校验。 */
function normalizeEvidence(entries: readonly TaskEvidenceInput[] | undefined, limits: KnowledgeServiceLimits, now: number): EvidenceRef[] {
	if (entries === undefined) return [];
	if (!Array.isArray(entries)) throw invalidArgument("验证证据必须是数组");
	if (entries.length > limits.maxEvidenceRefs) throw invalidArgument(`验证证据超过 ${limits.maxEvidenceRefs} 条上限`);
	return entries.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw invalidArgument("验证证据的每一项必须是对象");
		for (const key of Object.keys(entry)) {
			if (!(EVIDENCE_KEYS as readonly string[]).includes(key)) throw invalidArgument(`验证证据不接受未知字段：${key}`);
		}
		if (!EVIDENCE_TYPES.includes(entry.type)) throw invalidArgument("验证证据 type 必须是受控来源类型之一");
		const relativePath = entry.relativePath === undefined || entry.relativePath === null ? undefined : requireRelativePath(entry.relativePath, "验证证据路径");
		const contentHash = entry.contentHash === undefined || entry.contentHash === null ? undefined : entry.contentHash;
		if (contentHash !== undefined && (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash))) throw invalidArgument("验证证据 contentHash 必须是小写 64 位 SHA-256");
		const commit = entry.commit === undefined || entry.commit === null ? undefined : requireShortItem(entry.commit, "验证证据提交号", 128);
		const location = entry.location === undefined || entry.location === null ? undefined : requireShortItem(entry.location, "验证证据位置", limits.maxShortItemChars);
		const workspaceId = entry.workspaceId === undefined || entry.workspaceId === null ? undefined : requireShortItem(entry.workspaceId, "验证证据工作区 ID", 128);
		if (entry.type === "source-file" && (relativePath === undefined || contentHash === undefined)) throw invalidArgument("source-file 验证证据必须同时给出相对路径与小写 64 位 SHA-256");
		if (entry.type === "commit" && commit === undefined) throw invalidArgument("commit 验证证据必须给出提交号");
		return {
			type: entry.type,
			...(workspaceId === undefined ? {} : { workspaceId }),
			...(relativePath === undefined ? {} : { relativePath }),
			...(location === undefined ? {} : { location }),
			...(commit === undefined ? {} : { commit }),
			...(contentHash === undefined ? {} : { contentHash }),
			capturedAt: now,
			validity: "active" as const,
		};
	});
}

/** 任务验证记录：只按实际声明报告，不把编译升级成板卡启动。 */
function normalizeValidations(input: readonly TaskValidationInput[] | undefined, limits: KnowledgeServiceLimits, now: number): ValidationRecord[] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw invalidArgument("validations 必须是数组");
	if (input.length > limits.maxListItems) throw invalidArgument(`validations 超过 ${limits.maxListItems} 条上限`);
	return input.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw invalidArgument("validations 的每一项必须是对象");
		if (!VALIDATION_KINDS.includes(entry.kind)) throw invalidArgument("验证类别必须是受控枚举之一（不把编译当成板卡启动）");
		if (!VALIDATION_RESULTS.includes(entry.result)) throw invalidArgument("验证结论必须是 passed / failed / inconclusive");
		if (typeof entry.performedAt !== "number" || !Number.isSafeInteger(entry.performedAt) || entry.performedAt < 0) throw invalidArgument("验证时间必须是安全非负整数");
		return { kind: entry.kind, scope: requireShortItem(entry.scope, "验证范围", limits.maxShortItemChars), result: entry.result, performedAt: entry.performedAt, performedBy: requireShortItem(entry.performedBy, "验证执行者标签", limits.maxReviewTextChars), evidence: normalizeEvidence(entry.evidence, limits, now) };
	});
}

/** 验证证据里的工作区引用必须真实属于任务所属项目（否则相对路径/行号无法归属到检出）。 */
function assertEvidenceWorkspaces(project: { readonly workspaces: readonly { readonly workspaceId: string }[] }, validations: readonly ValidationRecord[]): void {
	for (const validation of validations) {
		for (const ref of validation.evidence) {
			if (ref.workspaceId !== undefined && !project.workspaces.some((workspace) => workspace.workspaceId === ref.workspaceId)) {
				throw invalidArgument(`验证证据的 workspaceId（${ref.workspaceId}）不属于任务所属项目`, "workspace-not-in-project");
			}
		}
	}
}

/** 任务工作区：workspaceId 必须属于项目，路径按**本次**授权重新判定。 */
async function resolveTaskWorkspace(input: {
	root: string;
	projectId: string;
	workspaceId: string;
	cwd: string;
	authorizedRoots?: readonly string[];
	branch?: string;
	baseCommit?: string;
	storageLimits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	ioHooks?: StorageIoHooks;
}): Promise<{ workspace: TaskRecord["workspace"]; project: Awaited<ReturnType<typeof requireSourceProject>> }> {
	if (typeof input.cwd !== "string" || input.cwd.trim() === "") throw invalidArgument("必须显式给出会话工作目录（cwd）以判定工作区授权");
	const project = await requireSourceProject({ root: input.root, sourceProjectId: input.projectId, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const entry = project.workspaces.find((workspace) => workspace.workspaceId === input.workspaceId);
	if (entry === undefined) throw invalidArgument(`工作区 ${input.workspaceId} 不属于项目 ${input.projectId}`, "workspace-not-in-project");
	const authorization = authorizeWorkspacePath({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, path: entry.path });
	if (!authorization.authorized) throw notAuthorized(`工作区 ${entry.path} 不在本次会话的授权范围内`, "workspace-not-authorized");
	return { workspace: { workspaceId: input.workspaceId, path: entry.path, ...(input.branch === undefined ? {} : { branch: input.branch }), ...(input.baseCommit === undefined ? {} : { baseCommit: input.baseCommit }) }, project };
}

/** 相对路径数组：非空、有界、保持顺序。 */
function requirePaths(value: unknown, label: string, limits: KnowledgeServiceLimits, max: number): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) throw invalidArgument(`${label} 必须是数组`);
	if (value.length > max) throw invalidArgument(`${label} 超过 ${max} 条上限`);
	return value.map((entry) => requireRelativePath(entry, `${label} 的路径`));
}

/** 写入体：公共头、`id`、归属字段 `projectId` 都由存储层管理，不接受调用方覆盖。 */
type TaskWriteBody = Omit<TaskRecord, "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "id" | "projectId">;

/* ------------------------------------------------------------------ 创建 */

export async function createTask(input: TaskCreateInput): Promise<TaskWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	// 授权闸门在**任何 IO 之前**：未授权不会读到 registry、不会泄漏项目/工作区状态。
	requireProjectAuthorization(input.authorizedProjectIds, projectId);
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();
	if (input.status !== undefined && input.status !== "planned") throw invalidArgument("首建任务只能是 planned（状态变更走具名 CAS 动作）");

	const resolved = await resolveTaskWorkspace({
		root,
		projectId,
		workspaceId: requireKnowledgeId(input.workspaceId, "工作区 ID"),
		cwd: input.cwd,
		authorizedRoots: input.authorizedRoots,
		...(input.branch === undefined ? {} : { branch: requireShortItem(input.branch, "分支名", limits.maxShortItemChars) }),
		...(input.baseCommit === undefined ? {} : { baseCommit: requireShortItem(input.baseCommit, "基线提交", 128) }),
		storageLimits: input.storageLimits,
		signal: input.signal,
		ioHooks: input.ioHooks,
	});
	const validations = normalizeValidations(input.validations, limits, now);
	assertEvidenceWorkspaces(resolved.project, validations);

	const body: TaskWriteBody = {
		workspace: resolved.workspace,
		requirement: requireBody(input.requirement, "任务需求", limits.maxBodyChars),
		status: "planned",
		decisions: requireShortItems(input.decisions, "决定", limits),
		todos: requireShortItems(input.todos, "待办", limits),
		blockers: requireShortItems(input.blockers, "阻塞", limits),
		relatedFiles: requirePaths(input.relatedFiles, "相关文件", limits, limits.maxListItems),
		sourceExperienceIds: requireKnowledgeIds(input.sourceExperienceIds, "经验引用", limits, limits.maxRelatedIds),
		validations,
	};

	try {
		const written = await createRecord({ kind: "task-record", id: taskId, projectId, data: body, expectedRevision: null, root, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits, lockTimeoutMs: input.lockTimeoutMs, lockPollMs: input.lockPollMs });
		const notes = collectWriteNotes(written, "任务记录");
		// 提交之后的核对失败**不回滚、不假称失败**：保留 created/revision，把问题合并为需核对（R30-3）。
		const checked = await checkExperienceReferencesSafely({ root, projectId, ids: body.sourceExperienceIds, authorizedProjectIds: input.authorizedProjectIds, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks, signalIgnored: true });
		return { status: "created", taskId, projectId, revision: written.revision, actualRevision: written.revision, changedFields: ["requirement", "status"], warnings: notes.warnings, needsReview: [...notes.needsReview, ...checked.needsReview], referenceGaps: checked.gaps, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", taskId, projectId, revision: actual, actualRevision: actual, changedFields: [], warnings: [], needsReview: [], referenceGaps: [], problems: [error.message] };
		}
		throw mapStorageError(error, "创建任务失败");
	}
}

/* ------------------------------------------------------------------ 读取 */

export async function readTaskDetail(input: {
	readonly root: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly cwd?: string;
	readonly authorizedRoots?: readonly string[];
	readonly authorizedProjectIds?: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
}): Promise<TaskDetailResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	const limits = resolveKnowledgeLimits(input.limits);
	const authorized = input.authorizedProjectIds;
	// 公开入口缺省拒绝：必须显式授权该任务所属项目。
	if (authorized === undefined || !authorized.includes(projectId)) {
		return { status: "not-authorized", taskId, projectId, revision: null, task: null, references: [], workspaceAuthorized: false, problems: ["未提供该任务所属项目的授权：拒绝读取任务内容"] };
	}
	let task: TaskRecord;
	let revision: number;
	try {
		const read = await readRecord({ root, kind: "task-record", id: taskId, projectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		task = read.record;
		revision = read.record.revision;
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return { status: "not-found", taskId, projectId, revision: null, task: null, references: [], workspaceAuthorized: false, problems: [] };
		throw mapStorageError(error, "读取任务失败");
	}
	// 入档路径按本次 cwd/授权根重新判定（不给 cwd 时如实报 false，不猜）。
	const workspaceAuthorized = input.cwd === undefined ? false : authorizeWorkspacePath({ cwd: input.cwd, authorizedRoots: input.authorizedRoots, path: task.workspace.path }).authorized;
	const references = await resolveExperienceReferences({ root, projectId, ids: task.sourceExperienceIds.slice(0, limits.maxDetailLinks), authorizedProjectIds: authorized, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	return { status: "ok", taskId, projectId, revision, task, references, workspaceAuthorized, problems: [] };
}

/* ------------------------------------------------------------------ 更新（点名正文/待办/阻塞/引用/验证） */

export type TaskChanges = {
	readonly requirement?: string;
	readonly decisions?: readonly string[];
	readonly todos?: readonly string[];
	readonly blockers?: readonly string[];
	readonly relatedFiles?: readonly string[];
	readonly sourceExperienceIds?: readonly string[];
	readonly validations?: readonly TaskValidationInput[];
};

const CHANGES_KEYS = ["requirement", "decisions", "todos", "blockers", "relatedFiles", "sourceExperienceIds", "validations"] as const;

export async function updateTask(input: TaskWriteOptions & { readonly expectedRevision: number; readonly changes: TaskChanges }): Promise<TaskWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	// 授权闸门在任何读取之前：未授权不会返回 revision/状态。
	requireProjectAuthorization(input.authorizedProjectIds, projectId);
	const expected = input.expectedRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedRevision 必须是安全非负整数（CAS 前置条件必填）");
	const changes = input.changes ?? {};
	for (const key of Object.keys(changes)) {
		if (!(CHANGES_KEYS as readonly string[]).includes(key)) throw invalidArgument(`任务更新不接受未知字段：${key}（状态只能走具名 CAS 动作）`);
	}
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();

	const current = await readTaskForWrite({ root, projectId, taskId, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	if (current.revision !== expected) return conflictResult(taskId, projectId, current.status, current.revision, expected);

	const changedFields: string[] = [];
	const next: TaskRecord = { ...current };
	const assignList = (field: "decisions" | "todos" | "blockers" | "validations", parsed: unknown): void => {
		if (JSON.stringify(parsed) === JSON.stringify(next[field])) return;
		(next as Record<string, unknown>)[field] = parsed;
		changedFields.push(field);
	};
	if (changes.requirement !== undefined) {
		const value = requireBody(changes.requirement, "任务需求", limits.maxBodyChars);
		if (value !== next.requirement) {
			next.requirement = value;
			changedFields.push("requirement");
		}
	}
	if (changes.decisions !== undefined) assignList("decisions", requireShortItems(changes.decisions, "决定", limits));
	if (changes.todos !== undefined) assignList("todos", requireShortItems(changes.todos, "待办", limits));
	if (changes.blockers !== undefined) assignList("blockers", requireShortItems(changes.blockers, "阻塞", limits));
	if (changes.validations !== undefined) {
		const parsed = normalizeValidations(changes.validations, limits, now);
		assertEvidenceWorkspaces(await requireSourceProject({ root, sourceProjectId: projectId, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks }), parsed);
		assignList("validations", parsed);
	}
	if (changes.relatedFiles !== undefined) {
		const value = requirePaths(changes.relatedFiles, "相关文件", limits, limits.maxListItems);
		if (JSON.stringify(value) !== JSON.stringify(next.relatedFiles)) {
			next.relatedFiles = value;
			changedFields.push("relatedFiles");
		}
	}
	if (changes.sourceExperienceIds !== undefined) {
		const value = requireKnowledgeIds(changes.sourceExperienceIds, "经验引用", limits, limits.maxRelatedIds);
		if (JSON.stringify(value) !== JSON.stringify(next.sourceExperienceIds)) {
			next.sourceExperienceIds = value;
			changedFields.push("sourceExperienceIds");
		}
	}
	if (changedFields.length === 0) return { status: "unchanged", taskId, projectId, revision: current.revision, actualRevision: current.revision, changedFields: [], warnings: [], needsReview: [], referenceGaps: [], problems: [] };

	try {
		const written = await updateRecord({ kind: "task-record", id: taskId, projectId, data: taskData(next), expectedRevision: current.revision, root, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits, lockTimeoutMs: input.lockTimeoutMs, lockPollMs: input.lockPollMs });
		const notes = collectWriteNotes(written, "任务记录");
		const checked = changedFields.includes("sourceExperienceIds")
			? await checkExperienceReferencesSafely({ root, projectId, ids: next.sourceExperienceIds, authorizedProjectIds: input.authorizedProjectIds, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks, signalIgnored: true })
			: { gaps: [], needsReview: [] };
		return { status: "updated", taskId, projectId, revision: written.revision, actualRevision: written.revision, changedFields, warnings: notes.warnings, needsReview: [...notes.needsReview, ...checked.needsReview], referenceGaps: checked.gaps, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", taskId, projectId, revision: actual, actualRevision: actual, changedFields: [], warnings: [], needsReview: [], referenceGaps: [], problems: [error.message] };
		}
		throw mapStorageError(error, "更新任务失败");
	}
}

/* ------------------------------------------------------------------ 状态与重开（具名 CAS 动作） */

export type TaskStatusResult = {
	readonly status: "changed" | "unchanged" | "revision-conflict" | "not-found" | "illegal-transition";
	readonly taskId: string;
	readonly projectId: string;
	readonly from: TaskStatus | null;
	readonly to: TaskStatus;
	readonly revision: number | null;
	readonly actualRevision: number | null;
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

export async function changeTaskStatus(input: TaskWriteOptions & { readonly expectedRevision: number; readonly to: TaskStatus; readonly reason: string }): Promise<TaskStatusResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	// 授权闸门：未授权不得改状态，也不得通过冲突/非法迁移响应泄漏当前状态（R30-1）。
	requireProjectAuthorization(input.authorizedProjectIds, projectId);
	const expected = input.expectedRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedRevision 必须是安全非负整数（CAS 前置条件必填）");
	if (!TASK_STATUSES.includes(input.to)) throw invalidArgument(`任务状态必须是 ${TASK_STATUSES.join(" / ")} 之一`);
	const limits = resolveKnowledgeLimits(input.limits);
	const reason = requireBody(input.reason, "状态变更理由", limits.maxReviewTextChars);
	const now = input.now ?? Date.now();

	const current = await readTaskForWrite({ root, projectId, taskId, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	if (current.revision !== expected) {
		return { status: "revision-conflict", taskId, projectId, from: current.status, to: input.to, revision: current.revision, actualRevision: current.revision, warnings: [], needsReview: [], problems: [`期望 revision=${expected}，实际 revision=${current.revision}；未写入任何内容。`] };
	}
	if (current.status === input.to) {
		return { status: "unchanged", taskId, projectId, from: current.status, to: input.to, revision: current.revision, actualRevision: current.revision, warnings: [], needsReview: [], problems: [] };
	}
	if (!TASK_STATUS_TRANSITIONS[current.status].includes(input.to)) {
		return {
			status: "illegal-transition",
			taskId,
			projectId,
			from: current.status,
			to: input.to,
			revision: current.revision,
			actualRevision: current.revision,
			warnings: [],
			needsReview: [],
			problems: [`非法状态迁移：${current.status} → ${input.to}（允许：${TASK_STATUS_TRANSITIONS[current.status].join(" / ") || "无"}）；理由：${reason}`],
		};
	}

	const next: TaskRecord = { ...current, status: input.to };
	try {
		const written = await updateRecord({ kind: "task-record", id: taskId, projectId, data: taskData(next), expectedRevision: current.revision, root, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits, lockTimeoutMs: input.lockTimeoutMs, lockPollMs: input.lockPollMs });
		const notes = collectWriteNotes(written, "任务状态");
		return { status: "changed", taskId, projectId, from: current.status, to: input.to, revision: written.revision, actualRevision: written.revision, warnings: notes.warnings, needsReview: notes.needsReview, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", taskId, projectId, from: current.status, to: input.to, revision: actual, actualRevision: actual, warnings: [], needsReview: [], problems: [error.message] };
		}
		throw mapStorageError(error, "变更任务状态失败");
	}
}

/* ------------------------------------------------------------------ 内部 */

function taskData(record: TaskRecord): TaskWriteBody {
	return { workspace: record.workspace, requirement: record.requirement, status: record.status, decisions: record.decisions, todos: record.todos, blockers: record.blockers, relatedFiles: record.relatedFiles, sourceExperienceIds: record.sourceExperienceIds, validations: record.validations };
}

async function readTaskForWrite(input: { root: string; projectId: string; taskId: string; storageLimits?: Partial<StorageLimits>; signal?: AbortSignal; ioHooks?: StorageIoHooks }): Promise<TaskRecord> {
	try {
		const read = await readRecord({ root: input.root, kind: "task-record", id: input.taskId, projectId: input.projectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		return read.record;
	} catch (error) {
		throw mapStorageError(error, "读取任务失败");
	}
}

function conflictResult(taskId: string, projectId: string, statusAfter: string, actual: number, expected: number): TaskWriteResult {
	return { status: "revision-conflict", taskId, projectId, revision: actual, actualRevision: actual, changedFields: [], warnings: [], needsReview: [], referenceGaps: [], problems: [`期望 revision=${expected}，实际 revision=${actual}（当前状态 ${statusAfter}）；未写入任何内容。`] };
}

/**
 * **发布之后**的经验引用核对（R30-3）。
 *
 * 任务/状态已经写进磁盘，此处的取消或 IO 失败**不能**把结果变成"干净失败"：
 * 保留 created/updated/revision，把核对问题合并为 `needsReview`，且不提示盲重试创建。
 * 取消不在这里抛出——取消属于调用方，但已提交事实必须留下。
 */
async function checkExperienceReferencesSafely(input: {
	root: string;
	projectId: string;
	ids: readonly string[];
	authorizedProjectIds?: readonly string[];
	storageLimits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	ioHooks?: StorageIoHooks;
	signalIgnored?: boolean;
}): Promise<{ readonly gaps: readonly string[]; readonly needsReview: readonly string[] }> {
	try {
		const gaps = await checkExperienceReferences({ ...input, signal: input.signalIgnored === true ? undefined : input.signal });
		return { gaps, needsReview: [] };
	} catch (error) {
		const code = isStorageError(error) ? error.code : error instanceof ProjectServiceError ? error.code : "io-error";
		return { gaps: [], needsReview: [`已提交的任务已完成写入，但后置的经验引用核对未完成（${code}）：请人工核对引用状态，不要重复创建同一任务。`] };
	}
}

/** 经验引用核对：只回报缺口，不复制正文，也不把缺口当依据。 */
async function checkExperienceReferences(input: { root: string; projectId: string; ids: readonly string[]; authorizedProjectIds?: readonly string[]; storageLimits?: Partial<StorageLimits>; signal?: AbortSignal; ioHooks?: StorageIoHooks }): Promise<string[]> {
	const refs = await resolveExperienceReferences({ root: input.root, projectId: input.projectId, ids: input.ids, authorizedProjectIds: input.authorizedProjectIds, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	return refs.filter((ref) => !ref.usableAsBasis).map((ref) => `经验引用 ${ref.experienceId}：${ref.reason ?? "不可作为当前依据"}`);
}

async function resolveExperienceReferences(input: { root: string; projectId: string; ids: readonly string[]; authorizedProjectIds?: readonly string[]; storageLimits?: Partial<StorageLimits>; signal?: AbortSignal; ioHooks?: StorageIoHooks }): Promise<TaskExperienceRef[]> {
	const refs: TaskExperienceRef[] = [];
	for (const experienceId of input.ids) {
		try {
			const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			const card = read.record;
			const authorized = input.authorizedProjectIds === undefined || input.authorizedProjectIds.includes(card.sourceProjectId);
			const reviewed = card.status === "reviewed" || card.status === "verified";
			const usableAsBasis = authorized && reviewed;
			const reason = !authorized ? "来源项目不在本次授权范围内：不能作为任务当前依据" : card.status === "draft" ? "经验仍是草稿（未审核）：只能作提示，不是当前依据" : card.status === "deprecated" ? "经验已废弃：不能作为任务当前依据" : null;
			refs.push({ experienceId, found: true, status: card.status, sourceProjectId: card.sourceProjectId, usableAsBasis, reason });
		} catch (error) {
			if (isStorageError(error) && error.code === "cancelled") throw new ProjectServiceError("cancelled", "核对经验引用已取消", { detail: "cancelled", cause: error });
			refs.push({ experienceId, found: false, status: null, sourceProjectId: null, usableAsBasis: false, reason: isStorageError(error) && error.code === "not-found" ? "引用的经验卡不存在（引用可能已失效）" : `引用的经验卡不可读（${isStorageError(error) ? error.code : "io-error"}）` });
		}
	}
	return refs;
}
