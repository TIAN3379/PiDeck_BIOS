/**
 * BM-05 B3：**从任务显式沉淀经验草稿**。
 *
 * 这是一个**人工**入口，不是后台反思 / 自学习 / AutoDream：
 * 1. 先读指定任务当前 revision（要求项目授权），把可预填的事实摆出来；
 * 2. 根因/方案/适用与不适用条件**必须由人工提供或确认**——任务没有这些字段时保留待填写，
 *    绝不从 todos 或 `done` 编造结论；
 * 3. 保存走 BM-04 的草稿创建（`status` 恒为 draft），**不**自动 submit-review / approve，
 *    也不把任务 done 当作经验 verified；
 * 4. 若要顺带把新经验 ID 关联回任务，用**两个已有 CAS 步骤**分别报告（卡片是否已发布、
 *    任务是否已关联）；第二步冲突/取消不撤销草稿，重试先读现状；不创建多文件事务。
 */
import type { ExperienceDraft } from "../knowledge/experiences.ts";
import { createExperienceDraft, type ExperienceWriteResult } from "../knowledge/experiences.ts";
import { invalidArgument, notAuthorized, requireKnowledgeId, resolveKnowledgeLimits } from "../knowledge/contract.ts";
import { readTaskDetail, updateTask, type TaskValidationInput } from "./tasks.ts";
import type { StorageIoHooks, StorageLimits } from "../storage/index.ts";

/** 需要**人工提供或确认**的字段（任务不携带结论，不能编造）。 */
export const REQUIRED_HUMAN_FIELDS: readonly string[] = ["problem", "rootCause", "solution", "appliesWhen", "doesNotApplyWhen"];

export type TaskExperiencePrefill = {
	readonly taskId: string;
	readonly projectId: string;
	readonly taskRevision: number | null;
	/** 可直接预填的事实（来自任务记录本身）。 */
	readonly suggested: {
		readonly sourceProjectId: string;
		readonly requirement: string;
		readonly decisions: readonly string[];
		readonly relatedFiles: readonly string[];
		readonly sourceExperienceIds: readonly string[];
		readonly validations: readonly TaskValidationInput[];
		/** 来源已授权且已审核、可作为当前依据的经验 ID（可作 featureId 之外的参考）。 */
		readonly usableExperienceIds: readonly string[];
	};
	readonly requiredHumanFields: readonly string[];
	readonly problems: readonly string[];
};

export type TaskExperiencePrefillResult = { readonly status: "ok" | "not-found" | "not-authorized"; readonly prefill: TaskExperiencePrefill | null; readonly problems: readonly string[] };

/** 读取指定任务当前 revision 并展示可预填事实（不写任何东西）。 */
export async function prepareExperienceDraftFromTask(input: {
	readonly root: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly cwd?: string;
	readonly authorizedRoots?: readonly string[];
	readonly authorizedProjectIds?: readonly string[];
	readonly limits?: Partial<import("../knowledge/contract.ts").KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
}): Promise<TaskExperiencePrefillResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	const authorized = input.authorizedProjectIds;
	if (authorized === undefined || !authorized.includes(projectId)) return { status: "not-authorized", prefill: null, problems: ["未提供该任务所属项目的授权：拒绝读取任务内容"] };
	const detail = await readTaskDetail({
		root: input.root,
		projectId,
		taskId,
		authorizedProjectIds: authorized,
		storageLimits: input.storageLimits,
		signal: input.signal,
		ioHooks: input.ioHooks,
		...(input.cwd === undefined ? {} : { cwd: input.cwd }),
		...(input.authorizedRoots === undefined ? {} : { authorizedRoots: input.authorizedRoots }),
	});
	if (detail.status !== "ok" || detail.task === null) return { status: detail.status === "not-found" ? "not-found" : "not-authorized", prefill: null, problems: detail.problems };
	const task = detail.task;
	const prefill: TaskExperiencePrefill = {
		taskId,
		projectId,
		taskRevision: detail.revision,
		suggested: {
			sourceProjectId: projectId,
			requirement: task.requirement,
			decisions: [...task.decisions],
			relatedFiles: [...task.relatedFiles],
			sourceExperienceIds: [...task.sourceExperienceIds],
			validations: task.validations.map((validation) => ({
				kind: validation.kind,
				scope: validation.scope,
				result: validation.result,
				performedAt: validation.performedAt,
				performedBy: validation.performedBy,
				evidence: validation.evidence.map((ref) => ({
					type: ref.type,
					...(ref.relativePath === undefined ? {} : { relativePath: ref.relativePath }),
					...(ref.contentHash === undefined ? {} : { contentHash: ref.contentHash }),
					...(ref.workspaceId === undefined ? {} : { workspaceId: ref.workspaceId }),
					...(ref.commit === undefined ? {} : { commit: ref.commit }),
					...(ref.location === undefined ? {} : { location: ref.location }),
				})),
			})),
			usableExperienceIds: detail.references.filter((reference) => reference.usableAsBasis).map((reference) => reference.experienceId),
		},
		requiredHumanFields: REQUIRED_HUMAN_FIELDS,
		problems: [...detail.problems, ...detail.references.filter((reference) => !reference.usableAsBasis).map((reference) => `经验引用 ${reference.experienceId}：${reference.reason ?? "不可作为当前依据"}`)],
	};
	return { status: "ok", prefill, problems: prefill.problems };
}

export type TaskDraftStep = {
	readonly step: "card" | "link";
	readonly status: string;
	readonly revision: number | null;
	readonly warnings: readonly string[];
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

export type TaskDraftSaveResult = {
	readonly status: "draft-saved" | "card-conflict" | "card-rejected" | "task-not-authorized" | "link-conflict" | "link-failed";
	readonly experienceId: string;
	readonly steps: readonly TaskDraftStep[];
	/** 只报告实际发生的步骤；第二步冲突/取消**不撤销**已发布的草稿。 */
	readonly card: ExperienceWriteResult | null;
	readonly needsReview: readonly string[];
	readonly problems: readonly string[];
};

/**
 * 保存经验草稿（`status` 恒为 draft）。
 *
 * `experience.sourceProjectId` 必须与任务所属项目一致（由服务强制，不接受把经验挂到别的项目）；
 * 若提供 `expectedTaskRevision`，保存成功后用一个**独立的 CAS 步骤**把新经验 ID 关联回任务。
 */
export async function saveExperienceDraftFromTask(input: {
	readonly root: string;
	readonly projectId: string;
	readonly taskId: string;
	readonly experience: Omit<ExperienceDraft, "sourceProjectId"> & { readonly sourceProjectId?: string };
	readonly expectedTaskRevision?: number;
	readonly authorizedProjectIds?: readonly string[];
	readonly limits?: Partial<import("../knowledge/contract.ts").KnowledgeServiceLimits>;
	readonly storageLimits?: Partial<StorageLimits>;
	readonly signal?: AbortSignal;
	readonly ioHooks?: StorageIoHooks;
	readonly now?: number;
}): Promise<TaskDraftSaveResult> {
	if (typeof input !== "object" || input === null) throw invalidArgument("参数必须是对象");
	const projectId = requireKnowledgeId(input.projectId, "项目 ID");
	const taskId = requireKnowledgeId(input.taskId, "任务 ID");
	const authorized = input.authorizedProjectIds;
	if (authorized === undefined || !authorized.includes(projectId)) throw notAuthorized(`项目 ${projectId} 不在本次授权范围内`, "project-not-authorized");

	// 记录任务当前 revision：关联步骤的 CAS 前置条件（不能拿"记忆里的 rev"当真相）。
	const detail = await readTaskDetail({ root: input.root, projectId, taskId, authorizedProjectIds: authorized, storageLimits: input.storageLimits, signal: input.signal, ioHooks: input.ioHooks });
	if (detail.status === "not-found") throw invalidArgument(`任务 ${taskId} 不存在（项目 ${projectId}）`, "task-not-found");
	if (detail.status !== "ok" || detail.task === null || detail.revision === null) throw notAuthorized(`任务 ${taskId} 不可读（项目 ${projectId}）`, "task-not-readable");

	const experienceId = requireKnowledgeId(input.experience.experienceId, "经验卡 ID");
	const steps: TaskDraftStep[] = [];

	// ---- 步骤 1：草稿卡片（状态恒为 draft；不自动审核） ----
	const cardResult = await createExperienceDraft({
		root: input.root,
		authorizedProjectIds: authorized,
		experience: { ...input.experience, experienceId, sourceProjectId: projectId },
		limits: input.limits,
		storageLimits: input.storageLimits,
		signal: input.signal,
		ioHooks: input.ioHooks,
		now: input.now,
	});
	steps.push({ step: "card", status: cardResult.status, revision: cardResult.revision, warnings: cardResult.warnings, needsReview: cardResult.needsReview, problems: cardResult.problems });
	const needsReview = [...cardResult.needsReview];
	const problems = [...cardResult.problems];
	if (cardResult.status !== "created") {
		return { status: cardResult.status === "revision-conflict" ? "card-conflict" : "card-rejected", experienceId, steps, card: cardResult, needsReview, problems };
	}

	// ---- 步骤 2（可选）：把新经验 ID 关联回任务（独立 CAS；冲突不撤销草稿） ----
	if (input.expectedTaskRevision === undefined) return { status: "draft-saved", experienceId, steps, card: cardResult, needsReview, problems };

	const task = detail.task;
	const sourceExperienceIds = task.sourceExperienceIds.includes(experienceId) ? [...task.sourceExperienceIds] : [...task.sourceExperienceIds, experienceId];
	// 第二步是**独立** CAS：冲突/IO/取消都不撤销已发布的草稿，也不丢弃第一步事实（R30-3）。
	let link;
	try {
		link = await updateTask({
			root: input.root,
			projectId,
			taskId,
			expectedRevision: input.expectedTaskRevision,
			changes: { sourceExperienceIds },
			authorizedProjectIds: authorized,
			limits: input.limits,
			storageLimits: input.storageLimits,
			signal: input.signal,
			ioHooks: input.ioHooks,
			now: input.now,
		});
	} catch (error) {
		const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "io-error";
		steps.push({ step: "link", status: code === "cancelled" ? "cancelled" : "io-error", revision: null, warnings: [], needsReview: [], problems: [error instanceof Error ? error.message : String(error)] });
		problems.push(`草稿 ${experienceId} 已提交，但关联回任务未完成（${code}）：请先读任务现状再决定是否重试，不要重复创建同一草稿 ID。`);
		return { status: "link-failed", experienceId, steps, card: cardResult, needsReview, problems };
	}
	steps.push({ step: "link", status: link.status, revision: link.revision, warnings: link.warnings, needsReview: link.needsReview, problems: link.problems });
	needsReview.push(...link.needsReview);
	problems.push(...link.problems);
	const status = link.status === "updated" || link.status === "unchanged" ? "draft-saved" : link.status === "revision-conflict" || link.status === "not-found" ? "link-conflict" : "link-failed";
	return { status, experienceId, steps, card: cardResult, needsReview, problems };
}
