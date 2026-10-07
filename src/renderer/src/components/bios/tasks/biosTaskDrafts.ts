/**
 * BM-07B B-04：任务表单的**纯函数**部分（便于单测，不依赖 React）。
 *
 * 验证记录相关的转换已上移到 `components/bios/validationDrafts.ts`（任务与经验卡共用同一套
 * 形状与校验口径），这里只保留任务专有的部分并**继续按原路径导出**，避免调用方与测试改路径。
 */
export {
	EVIDENCE_TYPES,
	VALIDATION_KINDS,
	VALIDATION_RESULTS,
	emptyValidationDraft,
	formatList,
	fromLocalDateTime,
	parseList,
	toLocalDateTime,
	toValidationInput,
	validationDraftFrom,
	validationDraftMatchesRecord,
	validationHasExtraEvidence,
	type BiosValidationDraft,
	type BiosValidationRecord,
} from "../validationDrafts";

export const TASK_STATUS_ORDER = ["planned", "in_progress", "blocked", "done", "archived"] as const;
