/**
 * BM-05 任务事实服务出口。
 *
 * 分层：
 * - `tasks.ts`：任务创建/读取/点名更新/具名状态 CAS（含 done→in_progress 显式重开）；
 * - `drafts.ts`：从任务**显式**沉淀经验草稿（人工提供根因/方案，不自动审核）。
 *
 * 复用 v1 `TaskRecord` 与既有存储/审核入口；**不提供** UI、Pi Session 注入、
 * 模型可调用的写工具、自动审核或任务语义历史（那属于 M2）。
 */
export * from "./tasks.ts";
export * from "./drafts.ts";
