import type { ContextManifest, ExperienceCard, ProjectProfile } from "../contracts/records.ts";
import { createRecord, isStorageError, readRecord, updateRecord, type StorageIoHooks, type StorageLimits } from "../storage/index.ts";
import { authorizeWorkspacePath } from "../projects/authorization.ts";
import { collectWriteNotes } from "../projects/writeNotes.ts";
import { invalidArgument, notAuthorized, ProjectServiceError, requireKnowledgeId, requireShortItem, resolveKnowledgeLimits, type KnowledgeServiceLimits } from "../knowledge/contract.ts";
import { outboundPolicy, type EndpointPolicy } from "./policy.ts";
import { assertRoot, mapStorageError, rethrowIfCancelled, type HandoffSourceKind } from "./sections.ts";
import { decideMemory, projectV1ExperienceCard } from "../memory/index.ts";
import { handoffTarget } from "./handoff.ts";
/* ------------------------------------------------------------------ C2：保存 Manifest */

export type ContextSourceInput = { readonly recordKind: string; readonly recordId: string; readonly revision: number; readonly reason: string };
export const SUPPORTED_SOURCE_KINDS: readonly HandoffSourceKind[] = ["project-profile", "task-record", "experience-card", "feature-record"];

/**
 * 来源**身份**守卫（R31-4）：save 与 verify **共用**同一份语义规则，因此"存量清单"不能因为
 * schema 合法就被信——族必须受支持、项目档案必须是目标项目、任务来源必须是**所选任务**、
 * 需求来源必须有显式 ID 授权。这里只做字符串层判定（不读 IO），IO 复验由调用方继续做。
 */
export function guardSourceIdentity(input: { readonly recordKind: string; readonly recordId: string; readonly targetProjectId: string; readonly taskId: string | undefined; readonly allowedFeatureIds?: readonly string[] }): string | null {
	if (!SUPPORTED_SOURCE_KINDS.includes(input.recordKind as HandoffSourceKind)) return `不支持的来源族：${input.recordKind}`;
	if (input.recordKind === "project-profile" && input.recordId !== input.targetProjectId) return `项目档案来源 ${input.recordId} 不是目标项目 ${input.targetProjectId}`;
	if (input.recordKind === "task-record" && (input.taskId === undefined || input.recordId !== input.taskId)) {
		return `任务来源 ${input.recordId} 不是所选当前任务 ${input.taskId ?? "（清单未声明任务）"}`;
	}
	if (input.recordKind === "feature-record" && input.allowedFeatureIds?.includes(input.recordId) !== true) {
		return `需求来源 ${input.recordId} 没有显式授权（需求没有项目字段，不能只凭项目授权）`;
	}
	return null;
}

export type SaveManifestResult = {
	readonly status: "saved" | "replaced" | "revision-conflict" | "not-authorized" | "not-found" | "invalid-sources";
	readonly manifestId: string;
	readonly targetProjectId: string;
	readonly revision: number | null;
	readonly changedFields: readonly string[];
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

/**
 * 创建（`expectedRevision === null`）或**替换**（`expectedRevision === n`）上下文清单（R30-4）。
 *
 * 保存前核对真实目标档案 revision、任务身份/工作区、以及每个来源的族/ID/授权/revision——
 * 存量字符串不能直接当可信输入。
 */
export async function saveContextManifest(input: {
	readonly root: string;
	readonly manifestId: string;
	readonly targetProjectId: string;
	readonly taskId?: string;
	readonly workspaceId?: string;
	readonly cwd?: string;
	readonly authorizedRoots?: readonly string[];
	readonly profileRevision: number;
	readonly sources: readonly ContextSourceInput[];
	readonly expiredSources?: readonly string[];
	readonly budget: { readonly maxChars: number; readonly maxBytes: number; readonly usedChars: number; readonly truncated: boolean };
	readonly generatedAt: number;
	readonly authorizedProjectIds: readonly string[];
	/** `null` = 要求目标不存在（创建）；数字 = 要求当前 revision（替换）。 */
	readonly expectedRevision?: number | null;
	readonly allowedFeatureIds?: readonly string[];
	readonly endpoint?: EndpointPolicy;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
}): Promise<SaveManifestResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const manifestId = requireKnowledgeId(input.manifestId, "上下文清单 ID");
	const targetProjectId = requireKnowledgeId(input.targetProjectId, "目标项目 ID");
	const reject = (status: SaveManifestResult["status"], problems: readonly string[]): SaveManifestResult => ({ status, manifestId, targetProjectId, revision: null, changedFields: [], warnings: [], needsReview: [], problems });
	if (input.authorizedProjectIds === undefined || input.authorizedProjectIds.length === 0 || !input.authorizedProjectIds.includes(targetProjectId)) return reject("not-authorized", ["目标项目不在本次授权范围内：拒绝保存上下文清单"]);
	if (!Number.isSafeInteger(input.profileRevision) || input.profileRevision < 0) throw invalidArgument("profileRevision 必须是安全非负整数");
	const expected = input.expectedRevision ?? null;
	if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) throw invalidArgument("expectedRevision 必须是 null 或安全非负整数");
	if (!Array.isArray(input.sources)) throw invalidArgument("sources 必须是数组");

	// ---- 核对真实目标档案 ----
	try {
		const profile = await readRecord({ root, kind: "project-profile", id: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		if (profile.record.revision !== input.profileRevision) return reject("invalid-sources", [`profileRevision 与当前档案不一致（清单 ${input.profileRevision}，当前 ${profile.record.revision}）：拒绝保存过期来源清单`]);
	} catch (error) {
		rethrowIfCancelled(error);
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return reject("not-found", [`目标项目 ${targetProjectId} 不存在或不可读`]);
		throw mapStorageError(error, "读取项目档案失败");
	}

	// ---- 核对任务身份/工作区 ----
	if (input.taskId !== undefined) {
		const taskId = requireKnowledgeId(input.taskId, "任务 ID");
		try {
			const read = await readRecord({ root, kind: "task-record", id: taskId, projectId: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			if (input.workspaceId !== undefined && read.record.workspace.workspaceId !== input.workspaceId) return reject("invalid-sources", [`任务 ${taskId} 属于工作区 ${read.record.workspace.workspaceId}，与清单选择的工作区 ${input.workspaceId} 不一致`]);
			if (input.cwd !== undefined) {
				const authorization = authorizeWorkspacePath({ cwd: input.cwd, ...(input.authorizedRoots === undefined ? {} : { authorizedRoots: input.authorizedRoots }), path: read.record.workspace.path });
				if (!authorization.authorized) return reject("invalid-sources", [`任务工作区 ${read.record.workspace.path} 不在本次会话授权范围内：拒绝保存清单`]);
			}
		} catch (error) {
			rethrowIfCancelled(error);
			if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return reject("invalid-sources", [`任务 ${taskId} 不在项目 ${targetProjectId} 里：拒绝保存清单`]);
			throw mapStorageError(error, "读取任务失败");
		}
	}

	// ---- 核对每个来源的族/ID/授权/revision ----
	const problems: string[] = [];
	for (const source of input.sources) {
		// 身份守卫与 verify 共用（R31-4）：不能因为"字符串合法"就写进清单。
		const identityProblem = guardSourceIdentity({ recordKind: source.recordKind, recordId: source.recordId, targetProjectId, taskId: input.taskId, ...(input.allowedFeatureIds === undefined ? {} : { allowedFeatureIds: input.allowedFeatureIds }) });
		requireKnowledgeId(source.recordId, "来源 ID");
		requireShortItem(source.reason, "来源理由", 300);
		if (!Number.isSafeInteger(source.revision) || source.revision < 0) return reject("invalid-sources", ["来源 revision 必须是安全非负整数"]);
		if (identityProblem !== null) return reject("invalid-sources", [identityProblem]);
		try {
			const read =
				source.recordKind === "task-record"
					? await readRecord({ root, kind: "task-record", id: source.recordId, projectId: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks })
					: await readRecord({ root, kind: source.recordKind as "project-profile" | "feature-record" | "experience-card", id: source.recordId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			if (read.record.revision !== source.revision) return reject("invalid-sources", [`来源 ${source.recordKind}/${source.recordId} revision 不一致（清单 ${source.revision}，当前 ${read.record.revision}）`]);
			if (source.recordKind === "experience-card") {
				const card = read.record as ExperienceCard;
				if (!input.authorizedProjectIds.includes(card.sourceProjectId)) return reject("invalid-sources", [`经验来源 ${source.recordId} 的来源项目未授权`]);
				if (card.status === "deprecated") return reject("invalid-sources", [`经验来源 ${source.recordId} 已废弃：不能写进当前来源清单`]);
			}
		} catch (error) {
			rethrowIfCancelled(error);
			if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return reject("invalid-sources", [`来源 ${source.recordKind}/${source.recordId} 不存在或不可读`]);
			throw mapStorageError(error, "读取来源失败");
		}
	}
	if (input.taskId !== undefined && !input.sources.some((source) => source.recordKind === "task-record" && source.recordId === input.taskId)) {
		return reject("invalid-sources", ["sources 必须包含所选当前任务的 revision（不能只写 profileRevision）"]);
	}

	const now = input.now ?? Date.now();
	const data = {
		...(input.taskId === undefined ? {} : { taskId: requireKnowledgeId(input.taskId, "任务 ID") }),
		profileRevision: input.profileRevision,
		sources: input.sources.map((source) => ({ recordKind: source.recordKind, recordId: requireKnowledgeId(source.recordId, "来源 ID"), revision: source.revision, reason: source.reason })),
		expiredSources: [...(input.expiredSources ?? [])].map((id) => requireKnowledgeId(id, "过期来源 ID")),
		budget: { maxChars: input.budget.maxChars, maxBytes: input.budget.maxBytes, usedChars: input.budget.usedChars, truncated: input.budget.truncated },
		generatedAt: input.generatedAt,
	};
	try {
		if (expected === null) {
			const written = await createRecord({ kind: "context-manifest", id: manifestId, projectId: targetProjectId, data, expectedRevision: null, root, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits });
			const notes = collectWriteNotes(written, "上下文清单");
			return { status: "saved", manifestId, targetProjectId, revision: written.revision, changedFields: [], warnings: notes.warnings, needsReview: notes.needsReview, problems: [...problems] };
		}
		const written = await updateRecord({ kind: "context-manifest", id: manifestId, projectId: targetProjectId, data, expectedRevision: expected, root, now, signal: input.signal, ioHooks: input.ioHooks, limits: input.storageLimits });
		const notes = collectWriteNotes(written, "上下文清单");
		return { status: "replaced", manifestId, targetProjectId, revision: written.revision, changedFields: ["sources", "profileRevision", "budget"], warnings: notes.warnings, needsReview: notes.needsReview, problems: [...problems] };
	} catch (error) {
		rethrowIfCancelled(error);
		if (isStorageError(error) && error.code === "revision-conflict") {
			const actual = typeof (error as { actual?: unknown }).actual === "number" ? (error as { actual: number }).actual : null;
			return { status: "revision-conflict", manifestId, targetProjectId, revision: actual, changedFields: [], warnings: [], needsReview: [], problems: [`清单 ${manifestId} 的 CAS 不匹配（期望 ${expected}，实际 ${actual}）：未写入任何内容`] };
		}
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return reject("not-found", ["知识库或项目目录不存在"]);
		throw mapStorageError(error, "保存上下文清单失败");
	}
}

/* ------------------------------------------------------------------ C2：新进程重验 */

export type ManifestSourceState = {
	readonly recordKind: string;
	readonly recordId: string;
	readonly expectedRevision: number;
	readonly actualRevision: number | null;
	/**
	 * `unreviewed`：来源是**未审核草稿**——可以作为明确提示，但不得获得"可作当前工程依据"的 clean ok。
	 * `unproven`：revision 一致但 v1 没有耐久字节/HEAD 指纹（历史字节无法证明）——与"审核资格不合格"**分开**。
	 * `identity`：来源身份与目标项目/所选任务/显式授权不符（存量清单也可能出现）。
	 */
	readonly state: "current" | "changed" | "missing" | "unreadable" | "deprecated" | "unauthorized" | "unproven" | "unreviewed" | "identity";
	readonly reason: string;
};

export type VerifyManifestResult = {
	readonly status: "ok" | "stale" | "incomplete" | "not-authorized" | "not-found";
	readonly manifestId: string;
	readonly targetProjectId: string;
	readonly taskId: string | null;
	readonly workspaceId: string | null;
	readonly manifestRevision: number | null;
	readonly profileRevision: number | null;
	readonly profileState: "current" | "changed" | "unreadable" | "missing";
	readonly sources: readonly ManifestSourceState[];
	readonly problems: readonly string[];
};

export async function verifyContextManifest(input: {
	readonly root: string;
	readonly manifestId: string;
	/** 清单所在项目（v1 context-manifest 按项目存放，必须显式给出）。 */
	readonly projectId: string;
	readonly authorizedProjectIds: readonly string[];
	readonly endpoint?: EndpointPolicy;
	readonly cwd?: string;
	readonly authorizedRoots?: readonly string[];
	readonly allowedFeatureIds?: readonly string[];
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
}): Promise<VerifyManifestResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const root = assertRoot(input.root);
	const manifestId = requireKnowledgeId(input.manifestId, "上下文清单 ID");
	const targetProjectId = requireKnowledgeId(input.projectId, "清单所在项目 ID");
	const notAuthorizedResult: VerifyManifestResult = { status: "not-authorized", manifestId, targetProjectId, taskId: null, workspaceId: null, manifestRevision: null, profileRevision: null, profileState: "missing", sources: [], problems: [] };
	if (input.authorizedProjectIds === undefined || !input.authorizedProjectIds.includes(targetProjectId)) return { ...notAuthorizedResult, problems: ["清单所在项目不在本次授权范围内"] };

	let manifest: ContextManifest;
	try {
		const read = await readRecord({ root, kind: "context-manifest", id: manifestId, projectId: targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		manifest = read.record;
	} catch (error) {
		rethrowIfCancelled(error);
		if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) return { ...notAuthorizedResult, problems: ["上下文清单不存在或不可读"] };
		throw mapStorageError(error, "读取上下文清单失败");
	}

	const problems: string[] = [];
	const sources: ManifestSourceState[] = [];
	// 存量清单按**不可信输入**处理：既有缺口（expiredSources / truncated）不能被忽略。
	if (manifest.expiredSources.length > 0) problems.push(`清单保存时已知 ${manifest.expiredSources.length} 个过期/不可用来源：不能当作可用`);
	if (manifest.budget.truncated) problems.push("清单保存时已标记预算截断：当时的内容不完整");
	const endpoint = input.endpoint ?? { endpointAllowed: null, allowInternalGeneral: false, customers: [] };
	const outbound = outboundPolicy(endpoint);
	if (outbound.note !== null) problems.push(outbound.note);

	let profileState: VerifyManifestResult["profileState"] = "missing";
	try {
		const profile = await readRecord({ root, kind: "project-profile", id: manifest.targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
		profileState = profile.record.revision === manifest.profileRevision ? "current" : "changed";
		if (profileState === "changed") problems.push(`项目档案 revision 已从 ${manifest.profileRevision} 变为 ${profile.record.revision}`);
	} catch (error) {
		rethrowIfCancelled(error);
		profileState = "unreadable";
		problems.push("项目档案当前不可读");
	}

	// 任务身份/工作区一致性 + 工作区授权（撤权即失败，不沿用旧依据）。
	let workspaceId: string | null = null;
	if (manifest.taskId !== undefined) {
		try {
			const task = await readRecord({ root, kind: "task-record", id: manifest.taskId, projectId: manifest.targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			workspaceId = task.record.workspace.workspaceId;
			if (input.cwd !== undefined) {
				const authorization = authorizeWorkspacePath({ cwd: input.cwd, ...(input.authorizedRoots === undefined ? {} : { authorizedRoots: input.authorizedRoots }), path: task.record.workspace.path });
				if (!authorization.authorized) problems.push(`任务工作区 ${task.record.workspace.path} 不在本次会话授权范围内：旧清单不可用作当前依据`);
			}
		} catch (error) {
			rethrowIfCancelled(error);
			if (isStorageError(error) && (error.code === "not-found" || error.code === "invalid-root")) problems.push(`清单引用的任务 ${manifest.taskId} 已不存在`);
			else throw mapStorageError(error, "读取任务失败");
		}
	}

	for (const source of manifest.sources) {
		// 身份守卫先于读取：存量清单里的跨项目/未选任务/无授权需求**不能**因为 schema 合法而被信。
		const identityProblem = guardSourceIdentity({ recordKind: source.recordKind, recordId: source.recordId, targetProjectId: manifest.targetProjectId, taskId: manifest.taskId, ...(input.allowedFeatureIds === undefined ? {} : { allowedFeatureIds: input.allowedFeatureIds }) });
		if (identityProblem !== null) {
			sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: null, state: "identity", reason: identityProblem });
			problems.push(`来源身份不符：${source.recordKind}/${source.recordId}（${identityProblem}）`);
			continue;
		}
		try {
			const read =
				source.recordKind === "task-record"
					? await readRecord({ root, kind: "task-record", id: source.recordId, projectId: manifest.targetProjectId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks })
					: await readRecord({ root, kind: source.recordKind as "project-profile" | "feature-record" | "experience-card", id: source.recordId, limits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
			const record = read.record;
			if (source.recordKind === "experience-card") {
				const card = record as ExperienceCard;
				if (!input.authorizedProjectIds.includes(card.sourceProjectId)) {
					sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: null, state: "unauthorized", reason: "来源项目不在本次授权范围内（不展示当前元数据）" });
					problems.push(`来源经验 ${source.recordId} 的来源项目已撤权`);
					continue;
				}
				const decision = decideMemory({
					intent: "current",
					now: manifest.generatedAt,
					candidates: [projectV1ExperienceCard(card)],
					relations: [],
					authorization: { endpointAllowed: endpoint.endpointAllowed, allowInternalGeneral: endpoint.allowInternalGeneral, customers: [...(endpoint.customers ?? [])] },
					target: handoffTarget({ root, targetProjectId: manifest.targetProjectId, authorizedProjectIds: input.authorizedProjectIds, endpoint, cwd: input.cwd ?? "" }, manifest.targetProjectId, workspaceId, null, null),
				});
				if (decision.items[0] === undefined) {
					sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "unauthorized", reason: "按当前端点/复用策略不再放行" });
					problems.push(`来源经验 ${source.recordId} 的复用范围不再放行`);
					continue;
				}
				if (card.status === "deprecated") {
					sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "deprecated", reason: "经验已废弃：旧清单不能恢复它的当前地位" });
					problems.push(`来源经验 ${source.recordId} 已废弃`);
					continue;
				}
				// revision 变化优先报告（"变了"比"资格不足"更具体），随后再判审核资格。
				if (record.revision !== source.revision) {
					sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "changed", reason: `revision 已从 ${source.revision} 变为 ${record.revision}` });
					problems.push(`来源 ${source.recordKind}/${source.recordId} 已变化`);
					continue;
				}
				// 审核资格与"历史字节不可证明"**分开**：草稿只能当提示，不能当当前工程依据（R31-4）。
				if (card.status !== "reviewed" && card.status !== "verified") {
					sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "unreviewed", reason: `经验状态为 ${card.status}（未审核）：只能作明确提示，不能作为当前可信依据` });
					problems.push(`来源经验 ${source.recordId} 尚未审核（${card.status}）`);
					continue;
				}
			}
			if (record.revision !== source.revision) {
				sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "changed", reason: `revision 已从 ${source.revision} 变为 ${record.revision}` });
				problems.push(`来源 ${source.recordKind}/${source.recordId} 已变化`);
				continue;
			}
			sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: record.revision, state: "unproven", reason: "revision 一致，但 v1 没有耐久来源指纹：不能宣称内容完全一致（历史字节不可证明；与审核资格无关）" });
		} catch (error) {
			rethrowIfCancelled(error);
			const code = isStorageError(error) ? error.code : "io-error";
			sources.push({ recordKind: source.recordKind, recordId: source.recordId, expectedRevision: source.revision, actualRevision: null, state: code === "not-found" ? "missing" : "unreadable", reason: code === "not-found" ? "来源已缺失" : `来源不可读（${code}）` });
			problems.push(`来源 ${source.recordKind}/${source.recordId} ${code === "not-found" ? "缺失" : "不可读"}`);
		}
	}

	// `ok` 的含义：档案当前、每个来源身份合格且未变化、无既有缺口、端点允许。
	const stale = profileState === "changed" || sources.some((source) => source.state === "changed" || source.state === "missing" || source.state === "deprecated" || source.state === "unauthorized" || source.state === "unreadable" || source.state === "identity");
	const status: VerifyManifestResult["status"] = stale ? "stale" : problems.length > 0 ? "incomplete" : "ok";
	return { status, manifestId, targetProjectId: manifest.targetProjectId, taskId: manifest.taskId ?? null, workspaceId, manifestRevision: manifest.revision, profileRevision: manifest.profileRevision, profileState, sources, problems };
}

export { invalidArgument, notAuthorized, resolveKnowledgeLimits };
