/**
 * journal 模块出口（BM-02C1）。
 *
 * 对外只暴露三类东西：
 * 1. 契约（类型/常量/校验）：供调用方与测试按同一份规则理解 journal；
 * 2. `inspectPendingJournal`：只读巡检；
 * 3. `reconcileJournalOperation`：持锁核对与收口。
 *
 * 写入侧（`prepareJournalEntry` / `finalizeJournalEntry`）由 `write.ts` 内部使用，
 * 一并导出是为了让测试能在低层复现"prepared 已落盘但数据未提交"等窗口，
 * **不是**给调用方拼装自己的写入流程用的。
 */
export * from "./contract.ts";
export * from "./writer.ts";
export * from "./wiring.ts";
export * from "./inspect.ts";
export * from "./reconcile.ts";
