/**
 * BM-04 B2：**经验草稿、人工审核与废弃**。
 *
 * 复用 v1 `ExperienceCard` 与**既有审核入口** `recordReviewDecision`
 * （意图/事件工件 + 审核专用 journal v2 + 审计事件），不新增状态机、不改旧协议。
 *
 * 五条纪律：
 * 1. **托管字段不可绕过**：`status` / `reviewer` 只能由审核入口改；
 *    普通草稿写入带这两个键一律拒绝（不能靠 `updateRecord` 或"塞 JSON"跳过审核）；
 * 2. **草稿只写非托管正文**；`sourceProjectId` 必须由调用方显式给出（不猜平台/项目）；
 * 3. **审核是独立动作**：引擎/检测**永远不**自动调用它；审核前必须由调用方给出实际 revision；
 * 4. **验证级别只按实际声明报告**：`compile` 不会被说成板卡启动/压力验证；
 * 5. **来源与授权显式**：`reuseScope.level = internal-general` 必须带显式授权说明。
 */
import type { EvidenceRef, EvidenceSourceType } from "../contracts/common.ts";
import type { ValidationKind, ValidationResult } from "../contracts/common.ts";
import type { AuditAction } from "../contracts/audit.ts";
import type { ExperienceCard } from "../contracts/records.ts";
import { createRecord, isStorageError, readRecord, recordReviewDecision, updateRecord, type ReviewDecisionResult, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { collectWriteNotes } from "../projects/writeNotes.ts";
import { assertWorkspaceBelongsToProject, requireExplicitProjectAuthorization, requireSourceProject } from "./access.ts";
import { invalidArgument, ProjectServiceError, requireBody, requireKnowledgeId, requireRelativePath, requireShortItem, requireShortItems, resolveKnowledgeLimits, type KnowledgeServiceLimits } from "./contract.ts";

export type ExperienceValidationInput = {
	readonly kind: ValidationKind;
	readonly scope: string;
	readonly result: ValidationResult;
	readonly performedAt: number;
	readonly performedBy: string;
	/** v1 合法的验证证据（与顶层证据同形；给出时保留范围/commit，不静默落成空数组）。 */
	readonly evidence?: readonly ExperienceEvidenceInput[];
};

/**
 * 经验**顶层**证据引用（R29-2）。
 *
 * 之前草稿写入直接把 `evidence` 写死成 `[]`，于是"源项目 ID + 根因/方案"成了唯一来源，
 * 无法构成完整的来源证据闭环。这里把顶层证据做成一等输入：
 * - `source-file` 必须有相对路径 + 小写 64 位 SHA-256；
 * - `commit` 必须有提交号；
 * - 其它类型（document / session / human-note）至少给一个可定位提示。
 * 未知键一律拒绝（拼错的字段名不能静默落成空证据）。
 */
export type ExperienceEvidenceInput = {
	readonly type: EvidenceSourceType;
	readonly workspaceId?: string | null;
	readonly relativePath?: string | null;
	readonly location?: string | null;
	readonly commit?: string | null;
	readonly contentHash?: string | null;
};

export type ExperienceDraft = {
	readonly experienceId: string;
	readonly problem: string;
	readonly symptom?: string;
	readonly rootCause: string;
	readonly solution: string;
	readonly appliesWhen?: readonly string[];
	readonly doesNotApplyWhen?: readonly string[];
	/** 来源项目：必须由调用方显式给出（服务不猜平台/客户）。 */
	readonly sourceProjectId: string;
	readonly featureId?: string;
	readonly validations?: readonly ExperienceValidationInput[];
	/** 顶层来源证据（可选；给出时按类型校验，不静默丢弃）。 */
	readonly evidence?: readonly ExperienceEvidenceInput[];
	readonly reuse?: {
		readonly level: "current-project" | "customer" | "internal-general";
		readonly customers?: readonly string[];
		readonly authorization?: string | null;
	};
};

export type ExperienceWriteOptions = {
	readonly root: string;
	/** 被授权读取/引用来源项目的显式声明（给出时核对 `sourceProjectId` 是否在内）。 */
	readonly authorizedProjectIds?: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type ExperienceWriteResult = {
	readonly status: "created" | "updated" | "unchanged" | "revision-conflict" | "not-found" | "not-draft" | "rejected";
	readonly experienceId: string;
	readonly revision: number | null;
	readonly actualRevision: number | null;
	readonly status_after: ExperienceCard["status"] | null;
	readonly changedFields: readonly string[];
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

/** 托管字段：只允许审核入口写。任何普通写入里出现它们都直接拒绝。 */
const MANAGED_FIELDS = ["status", "reviewer"] as const;

const DRAFT_KEYS = ["experienceId", "problem", "symptom", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen", "sourceProjectId", "featureId", "validations", "evidence", "reuse"] as const;
const DRAFT_UPDATE_KEYS = ["problem", "symptom", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen", "featureId", "validations", "evidence", "reuse"] as const;

function assertNoManagedFields(source: object, label: string): void {
	for (const field of MANAGED_FIELDS) {
		if (Object.hasOwn(source, field)) throw invalidArgument(`${label} 不接受 ${field}：审核状态与审核人只能由审核入口修改（不能绕过审核）`);
	}
}

/** 未知键拒绝：拼错字段名不能静默落成"没有这个字段"（否则一条证据/条件会被悄悄丢掉）。 */
function assertKnownKeys(source: object, allowed: readonly string[], label: string): void {
	for (const key of Object.keys(source)) {
		if (!allowed.includes(key)) throw invalidArgument(`${label} 不接受未知字段：${key}`);
	}
}

const EVIDENCE_TYPES: readonly EvidenceSourceType[] = ["source-file", "commit", "document", "session", "human-note"];
const EVIDENCE_KEYS = ["type", "workspaceId", "relativePath", "location", "commit", "contentHash"] as const;

/** 顶层证据输入 → v1 `EvidenceRef`（只存引用，不复制正文；每条按类型校验必填项）。 */
function normalizeEvidence(input: readonly ExperienceEvidenceInput[] | undefined, limits: KnowledgeServiceLimits, now: number): EvidenceRef[] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw invalidArgument("evidence 必须是数组");
	if (input.length > limits.maxEvidenceRefs) throw invalidArgument(`evidence 超过 ${limits.maxEvidenceRefs} 条上限`);
	return input.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw invalidArgument("evidence 的每一项必须是对象");
		assertKnownKeys(entry, EVIDENCE_KEYS, "evidence");
		if (!EVIDENCE_TYPES.includes(entry.type)) throw invalidArgument("evidence.type 必须是受控来源类型之一");
		const relativePath = entry.relativePath === undefined || entry.relativePath === null ? undefined : requireRelativePath(entry.relativePath, "证据路径");
		const location = entry.location === undefined || entry.location === null ? undefined : requireShortItem(entry.location, "证据位置", limits.maxShortItemChars);
		const commit = entry.commit === undefined || entry.commit === null ? undefined : requireShortItem(entry.commit, "证据提交号", 128);
		const contentHash = entry.contentHash === undefined || entry.contentHash === null ? undefined : entry.contentHash;
		if (contentHash !== undefined && (typeof contentHash !== "string" || !/^[0-9a-f]{64}$/.test(contentHash))) throw invalidArgument("证据的 contentHash 必须是小写 64 位 SHA-256");
		if (entry.type === "source-file" && (relativePath === undefined || contentHash === undefined)) throw invalidArgument("source-file 证据必须同时给出相对路径与小写 64 位 SHA-256");
		if (entry.type === "commit" && commit === undefined) throw invalidArgument("commit 证据必须给出提交号");
		if (entry.type !== "source-file" && entry.type !== "commit" && location === undefined && commit === undefined) throw invalidArgument(`${entry.type} 证据至少要有位置或引用说明`);
		const workspaceId = entry.workspaceId === undefined || entry.workspaceId === null ? undefined : requireShortItem(entry.workspaceId, "证据工作区 ID", 128);
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

const VALIDATION_KINDS: readonly ValidationKind[] = ["code-review", "compile", "board-boot", "stress-loop", "customer-acceptance"];
const VALIDATION_RESULTS: readonly ValidationResult[] = ["passed", "failed", "inconclusive"];

function normalizeValidations(input: readonly ExperienceValidationInput[] | undefined, limits: KnowledgeServiceLimits, now: number): ExperienceCard["validations"] {
	if (input === undefined) return [];
	if (!Array.isArray(input)) throw invalidArgument("validations 必须是数组");
	if (input.length > limits.maxListItems) throw invalidArgument(`validations 超过 ${limits.maxListItems} 条上限`);
	return input.map((entry) => {
		if (typeof entry !== "object" || entry === null) throw invalidArgument("validations 的每一项必须是对象");
		if (!VALIDATION_KINDS.includes(entry.kind)) throw invalidArgument("验证类别必须是受控枚举之一（不把编译当成板卡启动）");
		if (!VALIDATION_RESULTS.includes(entry.result)) throw invalidArgument("验证结论必须是 passed / failed / inconclusive");
		if (typeof entry.performedAt !== "number" || !Number.isSafeInteger(entry.performedAt) || entry.performedAt < 0) throw invalidArgument("验证时间必须是安全非负整数");
		return {
			kind: entry.kind,
			scope: requireShortItem(entry.scope, "验证范围", limits.maxShortItemChars),
			result: entry.result,
			performedAt: entry.performedAt,
			performedBy: requireShortItem(entry.performedBy, "验证执行者标签", limits.maxReviewTextChars),
			evidence: normalizeEvidence(entry.evidence, limits, now),
		};
	});
}

function normalizeReuse(input: ExperienceDraft["reuse"], limits: KnowledgeServiceLimits): ExperienceCard["reuseScope"] {
	if (input === undefined) return { level: "current-project", customers: [] };
	if (typeof input !== "object" || input === null) throw invalidArgument("reuse 必须是对象");
	if (input.level !== "current-project" && input.level !== "customer" && input.level !== "internal-general") throw invalidArgument("复用范围必须是 current-project / customer / internal-general");
	const customers = requireShortItems(input.customers, "复用客户", limits);
	const authorization = input.authorization === undefined || input.authorization === null ? undefined : requireShortItem(input.authorization, "跨客户授权说明", limits.maxReviewTextChars);
	// 跨客户复用需要**显式**授权说明：缺失即未授权，可以留档但不能带进别的客户任务。
	if (input.level === "internal-general" && authorization === undefined) throw invalidArgument("internal-general 复用必须带显式授权说明（缺失即未授权，可以留档但不能带进别的客户任务）");
	if (input.level === "customer" && customers.length === 0) throw invalidArgument("customer 复用必须显式列出适用客户（空数组等于未指定 ⇒ 不授权）");
	return { level: input.level, customers, ...(authorization === undefined ? {} : { authorization }) };
}

/** 草稿正文 → v1 记录体（`status` 恒为 draft；`id` 由存储层派生，不放进 `data`）。 */
function normalizeDraft(card: ExperienceDraft, limits: KnowledgeServiceLimits, now: number): { readonly id: string; readonly body: Omit<ExperienceCard, "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "status" | "reviewer" | "id"> } {
	if (typeof card !== "object" || card === null) throw invalidArgument("experience 必须是对象");
	assertNoManagedFields(card, "经验草稿");
	assertKnownKeys(card, DRAFT_KEYS, "经验草稿");
	const experienceId = requireKnowledgeId(card.experienceId, "经验卡 ID");
	const sourceProjectId = requireKnowledgeId(card.sourceProjectId, "来源项目 ID");
	const featureId = card.featureId === undefined ? undefined : requireKnowledgeId(card.featureId, "关联需求 ID");
	return {
		id: experienceId,
		body: {
			...(featureId === undefined ? {} : { featureId }),
			problem: requireBody(card.problem, "问题/现象", limits.maxBodyChars),
			...(card.symptom === undefined ? {} : { symptom: requireBody(card.symptom, "症状", limits.maxBodyChars) }),
			rootCause: requireBody(card.rootCause, "根因", limits.maxBodyChars),
			solution: requireBody(card.solution, "解决办法", limits.maxBodyChars),
			appliesWhen: requireShortItems(card.appliesWhen, "适用条件", limits),
			doesNotApplyWhen: requireShortItems(card.doesNotApplyWhen, "不适用条件", limits),
			sourceProjectId,
			evidence: normalizeEvidence(card.evidence, limits, now),
			validations: normalizeValidations(card.validations, limits, now),
			reuseScope: normalizeReuse(card.reuse, limits),
		},
	};
}

/** 顶层/验证证据里的工作区引用必须真实属于来源项目（否则相对路径无法归属到检出）。 */
function assertEvidenceWorkspaces(project: Awaited<ReturnType<typeof requireSourceProject>>, evidence: readonly EvidenceRef[], label: string): void {
	for (const ref of evidence) assertWorkspaceBelongsToProject(project, ref.workspaceId, label);
}

function mapWriteError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code =
			error.code === "revision-conflict"
				? "revision-conflict"
				: error.code === "cancelled"
					? "cancelled"
					: error.code === "not-found"
						? "not-found"
						: error.code === "invalid-record" || error.code === "audit-conflict" || error.code === "unsupported-schema-version"
							? // 非法状态迁移 / 审计不一致是**受控的业务拒绝**，不是 IO 故障：
								// 报成 io-error 会让调用方（与 CLI）分不清"该重试"还是"这个动作本来就不允许"。
								"inconsistent"
							: "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/** 新建经验**草稿**：状态恒为 `draft`，必须走审核入口才能变成 reviewed/verified。 */
export async function createExperienceDraft(input: ExperienceWriteOptions & { readonly experience: ExperienceDraft }): Promise<ExperienceWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();
	const draft = normalizeDraft(input.experience, limits, now);
	// 来源核对必须在**任何写入之前**（R29-1）：项目不存在/未授权时直接拒绝，不留卡片。
	// R30-1：授权不再"可选放行"——省略/空集合一律拒绝。
	requireExplicitProjectAuthorization(input.authorizedProjectIds, draft.body.sourceProjectId, "来源项目");
	const project = await requireSourceProject({ root: input.root, sourceProjectId: draft.body.sourceProjectId, authorizedProjectIds: input.authorizedProjectIds, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	assertEvidenceWorkspaces(project, draft.body.evidence, "经验证据");
	for (const validation of draft.body.validations) assertEvidenceWorkspaces(project, validation.evidence, "验证证据");
	try {
		const written = await createRecord({
			kind: "experience-card",
			id: draft.id,
			data: { ...draft.body, status: "draft" },
			expectedRevision: null,
			root: input.root,
			now,
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		const notes = collectWriteNotes(written, "经验卡");
		return { status: "created", experienceId: draft.id, revision: written.revision, actualRevision: written.revision, status_after: written.record.status, changedFields: ["problem", "rootCause", "solution"], warnings: notes.warnings, needsReview: notes.needsReview, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", experienceId: draft.id, revision: actual, actualRevision: actual, status_after: null, changedFields: [], warnings: [], needsReview: [], problems: [error.message] };
		}
		throw mapWriteError(error, "创建经验草稿失败");
	}
}

/**
 * 更新经验**草稿**正文。
 *
 * 只有当前状态是 `draft` 才能改：reviewed/verified 的卡必须先 `request-changes`
 * 回到 draft（审核动作），否则"编辑"就能绕过审核结论。
 */
export async function updateExperienceDraft(
	input: ExperienceWriteOptions & {
		readonly experienceId: string;
		readonly expectedRevision: number;
		readonly changes: Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">>;
	},
): Promise<ExperienceWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	const expected = input.expectedRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedRevision 必须是安全非负整数");
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();
	const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const current = read.record;
	// 授权在**返回冲突/状态/revision 之前**生效（R30-1）：未授权不得通过 revision-conflict 泄漏状态。
	requireExplicitProjectAuthorization(input.authorizedProjectIds, current.sourceProjectId, "来源项目");
	if (current.revision !== expected) {
		return { status: "revision-conflict", experienceId, revision: current.revision, actualRevision: current.revision, status_after: current.status, changedFields: [], warnings: [], needsReview: [], problems: [`期望 revision=${expected}，实际 revision=${current.revision}；未写入任何内容。`] };
	}
	if (current.status !== "draft") {
		return { status: "not-draft", experienceId, revision: current.revision, actualRevision: current.revision, status_after: current.status, changedFields: [], warnings: [], needsReview: [], problems: [`当前状态是 ${current.status}：请先走审核动作（request-changes）回到 draft，普通编辑不能绕过审核结论。`] };
	}

	const changes = input.changes ?? {};
	assertNoManagedFields(changes, "草稿更新");
	assertKnownKeys(changes, DRAFT_UPDATE_KEYS, "草稿更新");
	const changedFields: string[] = [];
	const next = { ...current };
	/** 只有**实际变化**才计入 changedFields：同值更新不制造无意义的 revision（也不谎报"已更新"）。 */
	const assignText = (field: "problem" | "symptom" | "rootCause" | "solution", label: string): void => {
		const value = changes[field];
		if (value === undefined) return;
		const parsed = requireBody(value, label, limits.maxBodyChars);
		if (parsed !== next[field]) {
			next[field] = parsed;
			changedFields.push(field);
		}
	};
	assignText("problem", "问题/现象");
	assignText("symptom", "症状");
	assignText("rootCause", "根因");
	assignText("solution", "解决办法");

	/** 数组/对象字段：按规范化后的值比较，同值不计变更。 */
	const assignStructural = (field: "appliesWhen" | "doesNotApplyWhen" | "validations" | "evidence" | "reuseScope", parsed: unknown): void => {
		if (JSON.stringify(parsed) === JSON.stringify(next[field])) return;
		(next as Record<string, unknown>)[field] = parsed;
		changedFields.push(field);
	};
	if (changes.appliesWhen !== undefined) assignStructural("appliesWhen", requireShortItems(changes.appliesWhen, "适用条件", limits));
	if (changes.doesNotApplyWhen !== undefined) assignStructural("doesNotApplyWhen", requireShortItems(changes.doesNotApplyWhen, "不适用条件", limits));
	if (changes.validations !== undefined) assignStructural("validations", normalizeValidations(changes.validations, limits, now));
	if (changes.evidence !== undefined) assignStructural("evidence", normalizeEvidence(changes.evidence, limits, now));
	if (changes.reuse !== undefined) assignStructural("reuseScope", normalizeReuse(changes.reuse, limits));
	if (changes.featureId !== undefined) {
		const value = requireKnowledgeId(changes.featureId, "关联需求 ID");
		if (value !== next.featureId) {
			next.featureId = value;
			changedFields.push("featureId");
		}
	}
	// 顶层证据/验证证据的工作区归属在写入前核对（与创建同一口径）。
	if (changedFields.includes("evidence") || changedFields.includes("validations")) {
		const project = await requireSourceProject({ root: input.root, sourceProjectId: current.sourceProjectId, authorizedProjectIds: input.authorizedProjectIds, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		assertEvidenceWorkspaces(project, next.evidence, "经验证据");
		for (const validation of next.validations) assertEvidenceWorkspaces(project, validation.evidence, "验证证据");
	}
	if (changedFields.length === 0) {
		return { status: "unchanged", experienceId, revision: current.revision, actualRevision: current.revision, status_after: current.status, changedFields: [], warnings: [], needsReview: [], problems: [] };
	}

	try {
		const written = await updateRecord({
			kind: "experience-card",
			id: experienceId,
			data: {
				...(next.featureId === undefined ? {} : { featureId: next.featureId }),
				problem: next.problem,
				...(next.symptom === undefined ? {} : { symptom: next.symptom }),
				rootCause: next.rootCause,
				solution: next.solution,
				appliesWhen: next.appliesWhen,
				doesNotApplyWhen: next.doesNotApplyWhen,
				sourceProjectId: next.sourceProjectId,
				evidence: next.evidence,
				validations: next.validations,
				reuseScope: next.reuseScope,
				status: next.status,
				...(next.reviewer === undefined ? {} : { reviewer: next.reviewer }),
			},
			expectedRevision: current.revision,
			root: input.root,
			now,
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		const notes = collectWriteNotes(written, "经验卡");
		return { status: "updated", experienceId, revision: written.revision, actualRevision: written.revision, status_after: written.record.status, changedFields, warnings: notes.warnings, needsReview: notes.needsReview, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", experienceId, revision: actual, actualRevision: actual, status_after: null, changedFields: [], warnings: [], needsReview: [], problems: [error.message] };
		}
		throw mapWriteError(error, "更新经验草稿失败");
	}
}

/* ------------------------------------------------------------------ 审核 */

export type ExperienceReviewResult = {
	readonly status: "applied" | "audit-pending" | "journal-pending";
	readonly experienceId: string;
	readonly revision: number;
	readonly action: AuditAction;
	/** 审核后的实际状态（从写回的记录里读出来的，不是预测值）。 */
	readonly stateAfter: ExperienceCard["status"];
	readonly operatorLabel: string;
	readonly audit: { readonly eventId: string; readonly intentRelativePath: string } | null;
	readonly journal: { readonly operationId: string; readonly relativePath: string; readonly state: "committed" | "prepared" };
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
};

/**
 * 人工审核经验卡（`submit-review` / `request-changes` / `approve` / `deprecate` / `restore`）。
 *
 * 直接转发给既有的 `recordReviewDecision`：状态机、审计事件、审核专用 journal 都由它负责，
 * 这里只做"参数形态 + 结果折叠"。`operatorLabel` 是**标签**，不是企业身份认证。
 */
export async function reviewExperience(input: {
	readonly root: string;
	readonly experienceId: string;
	readonly expectedRevision: number;
	readonly action: AuditAction;
	readonly operatorLabel: string;
	readonly reason: string;
	/** 审核关联证据：受控人工入口构造，只存 ID/revision 引用。 */
	readonly evidence?: readonly import("../contracts/audit.ts").AuditEvidenceRef[];
	/** 被授权读取/审核的来源项目（**必填**；缺省即拒绝）。 */
	readonly authorizedProjectIds: readonly string[];
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
}): Promise<ExperienceReviewResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	const expected = input.expectedRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedRevision 必须是安全非负整数（审核前必须给出实际 revision）");
	const limits = resolveKnowledgeLimits(input.limits);
	const operatorLabel = requireShortItem(input.operatorLabel, "执行者标签", limits.maxReviewTextChars);
	const reason = requireBody(input.reason, "审核理由", limits.maxReviewTextChars);
	// 审核是写动作（R30-1）：先读当前卡确认来源项目在授权范围内，再走既有审核入口。
	// 未授权在返回任何状态/审计事实之前拒绝。
	const preRead = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	requireExplicitProjectAuthorization(input.authorizedProjectIds, preRead.record.sourceProjectId, "来源项目");

	let result: ReviewDecisionResult;
	try {
		result = await recordReviewDecision({
			root: input.root,
			recordId: experienceId,
			expectedRevision: expected,
			action: input.action,
			operatorLabel,
			reason,
			evidence: input.evidence,
			limits: input.storageLimits,
			signal: input.signal,
			ioHooks: input.ioHooks,
			now: input.now,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
	} catch (error) {
		throw mapWriteError(error, "审核经验卡失败");
	}

	const needsReview: string[] = [];
	if (result.kind === "applied-audit-pending") needsReview.push("业务状态已提交，但审计事件未发布：需要随后核对审核审计并补记（不能用【已审核】覆盖这个事实）。");
	if (result.kind === "applied-journal-pending") needsReview.push(`业务与审计事件已提交，但 journal 终态待收口（operationId=${result.operationId}）。`);
	return {
		status: result.kind === "applied" ? "applied" : result.kind === "applied-audit-pending" ? "audit-pending" : "journal-pending",
		experienceId,
		revision: result.revision,
		action: input.action,
		stateAfter: result.record.status,
		operatorLabel,
		audit: result.audit === null ? null : { eventId: result.eventId, intentRelativePath: result.intentRelativePath },
		journal: { operationId: result.journal.operationId, relativePath: result.journal.relativePath, state: result.journal.state },
		warnings: result.warnings ?? [],
		needsReview,
	};
}

/**
 * 经验卡详情（含"声明的验证级别"、顶层证据与复用范围；不做推荐判定，推荐在 search 里）。
 *
 * **公开入口缺省拒绝**（R29-1）：必须显式给出被授权读取的来源项目；
 * 省略或空集合时连"记录是否存在"都不读取（不泄漏存在性、状态、正文与路径）。
 * 授权集合非空时才读取记录，并核对 `sourceProjectId` 是否在内。
 */
export async function readExperienceDetail(input: {
	readonly root: string;
	readonly experienceId: string;
	/** 被授权读取的来源项目（公开入口缺省拒绝：不给等于没有授权）。 */
	readonly authorizedProjectIds?: readonly string[];
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
}): Promise<{ readonly status: "ok" | "not-found" | "not-authorized"; readonly experienceId: string; readonly revision: number | null; readonly card: ExperienceCard | null; readonly problems: readonly string[] }> {
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	const authorized = input.authorizedProjectIds;
	if (authorized === undefined || authorized.length === 0) {
		return { status: "not-authorized", experienceId, revision: null, card: null, problems: ["未提供来源项目授权：公开入口缺省拒绝读取经验内容"] };
	}
	try {
		const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		if (!authorized.includes(read.record.sourceProjectId)) {
			return { status: "not-authorized", experienceId, revision: null, card: null, problems: ["来源项目不在本次授权范围内：不展示经验内容"] };
		}
		return { status: "ok", experienceId, revision: read.record.revision, card: read.record, problems: [] };
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return { status: "not-found", experienceId, revision: null, card: null, problems: [] };
		throw mapWriteError(error, "读取经验卡失败");
	}
}
