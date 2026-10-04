/**
 * 迁移预检（BM-02C3）的窄出口。
 *
 * 与 `journal/`、`review/` 同风格：只把**入口与契约**暴露出去，
 * 预算/扫描原语留在模块内部（调用方不该直接摆弄扫描状态）。
 */
export { inspectKnowledgeStore, isPreflightCancelled, isPreflightError, type InspectKnowledgeStoreOptions } from "./inspect.ts";
export { DEFAULT_PREFLIGHT_LIMITS, resolvePreflightLimits, type PreflightLimits } from "./limits.ts";
export {
	PREFLIGHT_SCAN_SEMANTICS,
	SUPPORTED_PREFLIGHT_VERSIONS,
	type PreflightCategory,
	type PreflightCode,
	type PreflightFileStatus,
	type PreflightFileSummary,
	type PreflightManualItem,
	type PreflightManualReason,
	type PreflightOutcome,
	type PreflightProblem,
	type PreflightReport,
	type PreflightTruncation,
	type PreflightVersionCount,
	type PreflightVersionFamily,
} from "./contract.ts";
