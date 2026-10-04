/**
 * BM-04 B1：**Feature（需求本体）录入、更新与详情**。
 *
 * 复用 v1 `FeatureRecord`（`originalRequirement` / `aliases` / `customer` / `productLine` /
 * `acceptanceCriteria` / `relatedExperienceIds`），不升 schema、不新增字段。
 *
 * 六条纪律：
 * 1. **原文只进不改**：需求与别名按人工给的顺序原样保存；检索键是派生值；
 * 2. **不猜身份**：客户/产品线的确认程度由调用方显式声明（`candidate` / `confirmed`），
 *    服务不从自由文本推断；未确认的身份不进入"可直接复用"结论；
 * 3. **v1 没有项目归属**：不编造 `sourceProjectId`，可见范围由调用方显式给出；
 * 4. **关联只是引用**：`relatedExperienceIds` 指向经验卡，读取时按记录族/ID/revision/授权核对，
 *    缺失或不读就显式显示（不补造来源）；
 * 5. **CAS**：更新必须带 `expectedRevision`，冲突不写；
 * 6. **写入事实透传**：底层 warnings / journal 终态未写都如实报告（与 BM-03 同一口径）。
 */
import type { ProjectField } from "../contracts/common.ts";
import type { FeatureRecord } from "../contracts/records.ts";
import { createRecord, isStorageError, listRecords, readRecord, updateRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { collectWriteNotes } from "../projects/writeNotes.ts";
import { invalidArgument, optionalBoundedText, ProjectServiceError, requireBody, requireDeclaredStatus, requireKnowledgeId, requireKnowledgeIds, requireShortItems, resolveKnowledgeLimits, type KnowledgeServiceLimits } from "./contract.ts";

/** 一个可确认字段的输入：值 + **显式**确认程度（可选证据）。 */
export type FeatureFieldInput = {
	readonly value: string | null;
	readonly status: "candidate" | "confirmed";
	readonly relativePath?: string | null;
	readonly contentHash?: string | null;
	readonly workspaceId?: string | null;
};

export type FeatureDraft = {
	readonly featureId: string;
	readonly originalRequirement: string;
	readonly aliases?: readonly string[];
	readonly customer?: FeatureFieldInput;
	readonly productLine?: FeatureFieldInput;
	readonly acceptanceCriteria?: readonly string[];
	readonly relatedExperienceIds?: readonly string[];
};

export type FeatureWriteOptions = {
	readonly root: string;
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
	readonly lockTimeoutMs?: number;
	readonly lockPollMs?: number;
};

export type FeatureWriteResult = {
	readonly status: "created" | "updated" | "unchanged" | "revision-conflict" | "not-found";
	readonly featureId: string;
	readonly revision: number | null;
	readonly actualRevision: number | null;
	readonly changedFields: readonly string[];
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

const FEATURE_FIELDS = ["originalRequirement", "aliases", "customer", "productLine", "acceptanceCriteria", "relatedExperienceIds"] as const;

function assertRoot(value: unknown): string {
	if (typeof value !== "string" || value.trim() === "") throw invalidArgument("必须显式指定知识根");
	return value;
}

/** 字段输入 → v1 `ProjectField`（证据只写引用，不复制正文）。 */
function toProjectField(input: FeatureFieldInput | undefined, label: string, limits: KnowledgeServiceLimits, now: number): ProjectField {
	if (input === undefined || input === null) return { value: null, status: "unknown", evidence: [], updatedAt: now };
	const status = requireDeclaredStatus(input.status, `${label} 的确认程度`);
	const value = input.value === null ? null : requireBody(input.value, `${label} 的值`, limits.maxShortItemChars);
	if (value === null && status === "confirmed") throw invalidArgument(`${label} 不能把"未知"声明成已确认`);
	const evidence: ProjectField["evidence"] = [];
	if (input.relativePath !== undefined && input.relativePath !== null) {
		const relativePath = requireBody(input.relativePath, `${label} 的证据路径`, 1024);
		if (typeof input.contentHash !== "string" || !/^[0-9a-f]{64}$/.test(input.contentHash)) throw invalidArgument(`${label} 的证据必须带小写 64 位 SHA-256`);
		evidence.push({ type: "source-file", ...(typeof input.workspaceId === "string" ? { workspaceId: input.workspaceId } : {}), relativePath, contentHash: input.contentHash, capturedAt: now, validity: "active" });
	}
	return { value, status, evidence, updatedAt: now };
}

/**
 * 校验并规范化一份 Feature 草稿（所有判定都在 IO 之前）。
 *
 * 返回的 `body` **不含 `id`**：`id` 由存储层的 `recordRelativeSegments` 派生路径，
 * 把它塞进 `data` 会被 `createRecord` 拒绝（这正是"托管字段不接受调用方覆盖"的现场）。
 */
function normalizeFeature(draft: FeatureDraft, limits: KnowledgeServiceLimits, now: number): { readonly id: string; readonly body: Omit<FeatureRecord, "schemaVersion" | "revision" | "createdAt" | "updatedAt" | "id"> } {
	if (typeof draft !== "object" || draft === null) throw invalidArgument("feature 必须是对象");
	const featureId = requireKnowledgeId(draft.featureId, "需求 ID");
	const originalRequirement = requireBody(draft.originalRequirement, "原始需求", limits.maxBodyChars);
	const aliases = requireShortItems(draft.aliases, "需求别名", limits);
	const acceptanceCriteria = requireShortItems(draft.acceptanceCriteria, "验收条件", limits);
	const relatedExperienceIds = requireKnowledgeIds(draft.relatedExperienceIds, "关联经验", limits, limits.maxRelatedIds);
	return {
		id: featureId,
		body: {
			originalRequirement,
			aliases,
			customer: toProjectField(draft.customer, "客户", limits, now),
			productLine: toProjectField(draft.productLine, "产品线", limits, now),
			acceptanceCriteria,
			relatedExperienceIds,
		},
	};
}

function mapWriteError(error: unknown, context: string): ProjectServiceError {
	if (isStorageError(error)) {
		const code = error.code === "revision-conflict" ? "revision-conflict" : error.code === "cancelled" ? "cancelled" : error.code === "not-found" ? "not-found" : "io-error";
		return new ProjectServiceError(code, `${context}：${error.message}`, { detail: error.code, cause: error });
	}
	return new ProjectServiceError("io-error", `${context}：${error instanceof Error ? error.message : String(error)}`, { cause: error });
}

/** 新建一条需求记录（`expectedRevision = null`：目标必须不存在）。 */
export async function createFeature(input: FeatureWriteOptions & { readonly feature: FeatureDraft }): Promise<FeatureWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();
	const normalized = normalizeFeature(input.feature, limits, now);
	try {
		const written = await createRecord({
			kind: "feature-record",
			id: normalized.id,
			data: normalized.body,
			expectedRevision: null,
			root,
			now,
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		const notes = collectWriteNotes(written, "需求记录");
		return { status: "created", featureId: normalized.id, revision: written.revision, actualRevision: written.revision, changedFields: [...FEATURE_FIELDS], warnings: notes.warnings, needsReview: notes.needsReview, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			// 目标已经存在：这是"先读现状再判定"的典型场景，如实报告当前 revision。
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", featureId: normalized.id, revision: actual, actualRevision: actual, changedFields: [], warnings: [], needsReview: [], problems: [error.message] };
		}
		throw mapWriteError(error, "创建需求失败");
	}
}

/** 更新一条需求：只接受显式给出的字段，未给出的字段原样保留。 */
export async function updateFeature(
	input: FeatureWriteOptions & {
		readonly featureId: string;
		readonly expectedRevision: number;
		readonly changes: Partial<Omit<FeatureDraft, "featureId">>;
	},
): Promise<FeatureWriteResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const featureId = requireKnowledgeId(input.featureId, "需求 ID");
	const expected = input.expectedRevision;
	if (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 0) throw invalidArgument("expectedRevision 必须是安全非负整数（CAS 前置条件必填）");
	const limits = resolveKnowledgeLimits(input.limits);
	const now = input.now ?? Date.now();

	const read = await readRecord({ root, kind: "feature-record", id: featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	const current = read.record;
	if (current.revision !== expected) {
		return { status: "revision-conflict", featureId, revision: current.revision, actualRevision: current.revision, changedFields: [], warnings: [], needsReview: [], problems: [`期望 revision=${expected}，实际 revision=${current.revision}；未写入任何内容。`] };
	}

	const changes = input.changes ?? {};
	const changedFields: string[] = [];
	const next: FeatureRecord = { ...current };
	if (changes.originalRequirement !== undefined) {
		const value = requireBody(changes.originalRequirement, "原始需求", limits.maxBodyChars);
		if (value !== current.originalRequirement) {
			next.originalRequirement = value;
			changedFields.push("originalRequirement");
		}
	}
	if (changes.aliases !== undefined) {
		const value = requireShortItems(changes.aliases, "需求别名", limits);
		if (JSON.stringify(value) !== JSON.stringify(current.aliases)) {
			next.aliases = value;
			changedFields.push("aliases");
		}
	}
	if (changes.acceptanceCriteria !== undefined) {
		const value = requireShortItems(changes.acceptanceCriteria, "验收条件", limits);
		if (JSON.stringify(value) !== JSON.stringify(current.acceptanceCriteria)) {
			next.acceptanceCriteria = value;
			changedFields.push("acceptanceCriteria");
		}
	}
	if (changes.relatedExperienceIds !== undefined) {
		const value = requireKnowledgeIds(changes.relatedExperienceIds, "关联经验", limits, limits.maxRelatedIds);
		if (JSON.stringify(value) !== JSON.stringify(current.relatedExperienceIds)) {
			next.relatedExperienceIds = value;
			changedFields.push("relatedExperienceIds");
		}
	}
	for (const name of ["customer", "productLine"] as const) {
		const change = changes[name];
		if (change === undefined) continue;
		const value = toProjectField(change, name === "customer" ? "客户" : "产品线", limits, now);
		const before = current[name];
		if (value.value !== before.value || value.status !== before.status) {
			// 修订字段时**保留**已有证据并追加本次证据（不静默丢掉可复核出处）。
			next[name] = { ...value, evidence: [...before.evidence, ...value.evidence] };
			changedFields.push(name);
		}
	}

	if (changedFields.length === 0) {
		return { status: "unchanged", featureId, revision: current.revision, actualRevision: current.revision, changedFields: [], warnings: [], needsReview: [], problems: [] };
	}

	try {
		const written = await updateRecord({
			kind: "feature-record",
			id: featureId,
			data: { originalRequirement: next.originalRequirement, aliases: next.aliases, customer: next.customer, productLine: next.productLine, acceptanceCriteria: next.acceptanceCriteria, relatedExperienceIds: next.relatedExperienceIds },
			expectedRevision: current.revision,
			root,
			now,
			signal: input.signal,
			ioHooks: input.ioHooks,
			limits: input.storageLimits,
			lockTimeoutMs: input.lockTimeoutMs,
			lockPollMs: input.lockPollMs,
		});
		const notes = collectWriteNotes(written, "需求记录");
		return { status: "updated", featureId, revision: written.revision, actualRevision: written.revision, changedFields, warnings: notes.warnings, needsReview: notes.needsReview, problems: [] };
	} catch (error) {
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", featureId, revision: actual, actualRevision: actual, changedFields: [], warnings: [], needsReview: [], problems: [error.message] };
		}
		throw mapWriteError(error, "更新需求失败");
	}
}

/* ------------------------------------------------------------------ 详情 */

/** 可见范围：由**调用方显式给出**（v1 Feature 没有项目归属，不能替它猜一个）。 */
export type FeatureVisibility = {
	/** 允许读取的需求记录 ID；给出时不在其中的记录一律拒绝。 */
	readonly allowedFeatureIds?: readonly string[];
	/** 被授权读取源项目的经验卡（用于关联核对）。 */
	readonly authorizedProjectIds?: readonly string[];
};

export type FeatureLinkResult = {
	readonly experienceId: string;
	/** 关联目标是否真的存在且可读（不补造来源）。 */
	readonly found: boolean;
	readonly status: string | null;
	readonly reason: string | null;
};

export type FeatureDetailResult = {
	readonly status: "ok" | "not-found" | "not-authorized" | "inconsistent";
	readonly featureId: string;
	readonly revision: number | null;
	readonly feature: FeatureRecord | null;
	readonly links: readonly FeatureLinkResult[];
	/** 是否可作为"可直接复用"的结论（未确认身份 / 范围不匹配时为 false + 原因）。 */
	readonly usableAsReference: boolean;
	readonly referenceReasons: readonly string[];
	readonly problems: readonly string[];
};

export async function readFeatureDetail(input: {
	readonly root: string;
	readonly featureId: string;
	readonly visibility?: FeatureVisibility;
	/** 本次目标的客户（给出时用于筛选：未确认或不匹配都不进"可直接复用"）。 */
	readonly customerId?: string | null;
	readonly limits?: Partial<KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
}): Promise<FeatureDetailResult> {
	const root = assertRoot(input.root);
	const featureId = requireKnowledgeId(input.featureId, "需求 ID");
	const limits = resolveKnowledgeLimits(input.limits);
	const problems: string[] = [];

	// 授权先于读取内容：不在允许集合里的记录连"存在与否"都不透露。
	const allowed = input.visibility?.allowedFeatureIds;
	if (allowed !== undefined && !allowed.includes(featureId)) {
		return { status: "not-authorized", featureId, revision: null, feature: null, links: [], usableAsReference: false, referenceReasons: ["该需求不在本次授权可见范围内"], problems: ["不在授权范围：未读取任何需求内容"] };
	}

	let feature: FeatureRecord;
	let revision: number;
	try {
		const read = await readRecord({ root, kind: "feature-record", id: featureId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		feature = read.record;
		revision = read.record.revision;
	} catch (error) {
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) {
			return { status: "not-found", featureId, revision: null, feature: null, links: [], usableAsReference: false, referenceReasons: [], problems: [`需求 ${featureId} 不存在或不可读`] };
		}
		throw mapWriteError(error, "读取需求失败");
	}

	// 关联核对：逐条按记录族 + ID 读取；缺失/不可读显式显示，不编造来源。
	const links: FeatureLinkResult[] = [];
	for (const experienceId of feature.relatedExperienceIds.slice(0, limits.maxDetailLinks)) {
		try {
			const link = await readRecord({ root, kind: "experience-card", id: experienceId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			const authorized = input.visibility?.authorizedProjectIds;
			if (authorized !== undefined && !authorized.includes(link.record.sourceProjectId)) {
				links.push({ experienceId, found: false, status: null, reason: "关联经验属于未授权项目，不能确认其内容" });
				continue;
			}
			links.push({ experienceId, found: true, status: link.record.status, reason: null });
		} catch (error) {
			const code = isStorageError(error) ? error.code : "io-error";
			links.push({ experienceId, found: false, status: null, reason: code === "not-found" ? "关联的经验卡不存在（引用可能已失效）" : `关联的经验卡不可读（${code}）` });
		}
	}

	// 可直接复用的条件：身份字段必须**已确认**，且与目标客户一致（未知不等于公开）。
	const referenceReasons: string[] = [];
	const customer = feature.customer;
	if (customer.status !== "confirmed" || customer.value === null) referenceReasons.push("客户身份未确认：只能作为候选参考，不能直接复用");
	else if (input.customerId !== undefined && input.customerId !== null && customer.value !== input.customerId) referenceReasons.push(`客户范围不匹配（记录：${customer.value}）`);
	if (feature.productLine.status !== "confirmed" || feature.productLine.value === null) referenceReasons.push("产品线未确认：范围无法证明");
	if (links.some((link) => !link.found)) referenceReasons.push("存在无法核对的关联经验：需求沿革不完整");

	return {
		status: "ok",
		featureId,
		revision,
		feature,
		links,
		usableAsReference: referenceReasons.length === 0,
		referenceReasons,
		problems,
	};
}

/** 需求清单（有界扫描；不做未授权的枚举）。 */
export async function listFeatureIds(input: { readonly root: string; readonly visibility?: FeatureVisibility; readonly storageLimits?: Partial<StorageLimits>; readonly signal?: AbortSignal }): Promise<{ readonly ids: readonly string[]; readonly truncated: boolean }> {
	const root = assertRoot(input.root);
	const listing = await listRecords({ root, kind: "feature-record", limits: input.storageLimits, signal: input.signal });
	const allowed = input.visibility?.allowedFeatureIds;
	const ids = listing.entries.map((entry) => entry.id).filter((id) => allowed === undefined || allowed.includes(id));
	return { ids, truncated: listing.truncated };
}

export { optionalBoundedText };
