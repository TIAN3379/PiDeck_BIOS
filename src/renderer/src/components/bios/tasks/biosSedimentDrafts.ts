/**
 * BM-07B B-06：任务沉淀的**纯函数**部分（便于单测）。
 *
 * 只做一件事：把 `prepareExperienceDraftFromTask` 的**有限预填**转成表单初值。
 *
 * 铁律（计划 §B-06 第 1 条）：
 * - 预填只来自**已经保存的任务**（需求、决策、相关文件、参考经验、验证记录）；
 * - **不补造**根因/方案/适用边界：这些一律留空，等工程师填（`requiredHumanFields` 逐项呈现）；
 * - 不猜测、不扩大：预填里没有的字段就不给默认值。
 */
import type { TaskExperiencePrefill, TaskValidationInput } from "../../../../../shared/types/biosBusiness";
import { validationDraftFrom, type BiosValidationDraft } from "../validationDrafts";

export type BiosSedimentSeed = {
	/** 预填到"问题"字段：任务需求原文（人是可以改的，改了什么以表单为准）。 */
	problem: string;
	/** 来源项目：必须是任务所属项目（服务端也会强制核对）。 */
	sourceProjectId: string;
	/** 任务里已保存的验证记录 → 表单草稿（原样带过来，不升级强度）。 */
	validations: readonly BiosValidationDraft[];
};

export function sedimentSeedOf(prefill: TaskExperiencePrefill): BiosSedimentSeed {
	return {
		problem: prefill.suggested.requirement,
		sourceProjectId: prefill.suggested.sourceProjectId,
		validations: prefill.suggested.validations.map((record: TaskValidationInput) => validationDraftFrom(record)),
	};
}

/**
 * 人工必填字段的展示清单（把 core 的 `requiredHumanFields` 原样带出）。
 *
 * 刻意不在这里"帮用户填默认值"：默认值会让"人没写"看起来像"人写了"。
 */
export function requiredHumanFieldsOf(prefill: TaskExperiencePrefill): readonly string[] {
	return prefill.requiredHumanFields;
}

/** 预填里可供参考但**不是**事实的线索（相关文件/决策/可作依据的经验 ID）。 */
export type BiosSedimentHints = {
	decisions: readonly string[];
	relatedFiles: readonly string[];
	sourceExperienceIds: readonly string[];
	usableExperienceIds: readonly string[];
};

export function sedimentHintsOf(prefill: TaskExperiencePrefill): BiosSedimentHints {
	return { decisions: prefill.suggested.decisions, relatedFiles: prefill.suggested.relatedFiles, sourceExperienceIds: prefill.suggested.sourceExperienceIds, usableExperienceIds: prefill.suggested.usableExperienceIds };
}
