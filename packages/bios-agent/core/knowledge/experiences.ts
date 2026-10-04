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
import type { EvidenceRef } from "../contracts/common.ts";
import type { ValidationKind, ValidationResult } from "../contracts/common.ts";
import type { AuditAction } from "../contracts/audit.ts";
import type { ExperienceCard } from "../contracts/records.ts";
import { createRecord, isStorageError, readRecord, recordReviewDecision, updateRecord, type ReviewDecisionResult, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { collectWriteNotes } from "../projects/writeNotes.ts";
import { invalidArgument, ProjectServiceError, requireBody, requireKnowledgeId, requireRelativePath, requireShortItem, requireShortItems, resolveKnowledgeLimits, type KnowledgeServiceLimits } from "./contract.ts";

export type ExperienceValidationInput = {
	readonly kind: ValidationKind;
	readonly scope: string;
	readonly result: ValidationResult;
	readonly performedAt: number;
	readonly performedBy: string;
	readonly evidence?: readonly { readonly relativePath: string; readonly contentHash: string; readonly workspaceId?: string }[];
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
	readonly reuse?: {
		readonly level: "current-project" | "customer" | "internal-general";
		readonly customers?: readonly string[];
		readonly authorization?: string | null;
	};
};

export type ExperienceWriteOptions = {
	readonly root: string;
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

function assertNoManagedFields(source: object, label: string): void {
	for (const field of MANAGED_FIELDS) {
		if (Object.hasOwn(source, field)) throw invalidArgument(`${label} 不接受 ${field}：审核状态与审核人只能由审核入口修改（不能绕过审核）`);
	}
}

function validationEvidence(entries: ExperienceValidationInput["evidence"], label: string): EvidenceRef[] {
	if (entries === undefined) return [];
	const refs: EvidenceRef[] = [];
	for (const entry of entries) {
		if (typeof entry !== "object" || entry === null) throw invalidArgument(`${label} 的证据项必须是对象`);
		const relativePath = requireRelativePath(entry.relativePath, `${label} 的证据路径`);
		if (typeof entry.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(entry.contentHash)) throw invalidArgument(`${label} 的证据必须带小写 64 位 SHA-256`);
		refs.push({ type: "source-file", ...(typeof entry.workspaceId === "string" ? { workspaceId: entry.workspaceId } : {}), relativePath, contentHash: entry.contentHash, capturedAt: 0, validity: "active" });
	}
	return refs;
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
			evidence: validationEvidence(entry.evidence, "验证").map((ref) => ({ ...ref, capturedAt: now })),
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
			evidence: [],
			validations: normalizeValidations(card.validations, limits, now),
			reuseScope: normalizeReuse(card.reuse, limits),
		},
	};
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
	if (current.revision !== expected) {
		return { status: "revision-conflict", experienceId, revision: current.revision, actualRevision: current.revision, status_after: current.status, changedFields: [], warnings: [], needsReview: [], problems: [`期望 revision=${expected}，实际 revision=${current.revision}；未写入任何内容。`] };
	}
	if (current.status !== "draft") {
		return { status: "not-draft", experienceId, revision: current.revision, actualRevision: current.revision, status_after: current.status, changedFields: [], warnings: [], needsReview: [], problems: [`当前状态是 ${current.status}：请先走审核动作（request-changes）回到 draft，普通编辑不能绕过审核结论。`] };
	}

	const changes = input.changes ?? {};
	assertNoManagedFields(changes, "草稿更新");
	const changedFields: string[] = [];
	const next = { ...current };
	if (changes.problem !== undefined) {
		next.problem = requireBody(changes.problem, "问题/现象", limits.maxBodyChars);
		changedFields.push("problem");
	}
	if (changes.symptom !== undefined) next.symptom = requireBody(changes.symptom, "症状", limits.maxBodyChars);
	if (changes.rootCause !== undefined) {
		next.rootCause = requireBody(changes.rootCause, "根因", limits.maxBodyChars);
		changedFields.push("rootCause");
	}
	if (changes.solution !== undefined) {
		next.solution = requireBody(changes.solution, "解决办法", limits.maxBodyChars);
		changedFields.push("solution");
	}
	if (changes.appliesWhen !== undefined) {
		next.appliesWhen = requireShortItems(changes.appliesWhen, "适用条件", limits);
		changedFields.push("appliesWhen");
	}
	if (changes.doesNotApplyWhen !== undefined) {
		next.doesNotApplyWhen = requireShortItems(changes.doesNotApplyWhen, "不适用条件", limits);
		changedFields.push("doesNotApplyWhen");
	}
	if (changes.validations !== undefined) {
		next.validations = normalizeValidations(changes.validations, limits, now);
		changedFields.push("validations");
	}
	if (changes.reuse !== undefined) {
		next.reuseScope = normalizeReuse(changes.reuse, limits);
		changedFields.push("reuseScope");
	}
	if (changes.featureId !== undefined) {
		next.featureId = requireKnowledgeId(changes.featureId, "关联需求 ID");
		changedFields.push("featureId");
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

	let result: ReviewDecisionResult;
	try {
		result = await recordReviewDecision({
			root: input.root,
			recordId: experienceId,
			expectedRevision: expected,
			action: input.action,
			operatorLabel,
			reason,
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

/** 经验卡详情（含"声明的验证级别"与复用范围；不做推荐判定，推荐在 search 里）。 */
export async function readExperienceDetail(input: {
	readonly root: string;
	readonly experienceId: string;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
}): Promise<{ readonly status: "ok" | "not-found"; readonly experienceId: string; readonly revision: number | null; readonly card: ExperienceCard | null }> {
	const experienceId = requireKnowledgeId(input.experienceId, "经验卡 ID");
	try {
		const read = await readRecord({ root: input.root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal });
		return { status: "ok", experienceId, revision: read.record.revision, card: read.record };
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return { status: "not-found", experienceId, revision: null, card: null };
		throw mapWriteError(error, "读取经验卡失败");
	}
}
