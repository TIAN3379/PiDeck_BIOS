/**
 * 审核领域出口（BM-02C2B）。
 *
 * 对外只暴露四类东西：
 * 1. 契约：v2 的类型/常量/校验（供调用方与测试按同一份规则理解 journal）；
 * 2. `recordReviewDecision`：一次经验卡审核的域入口；
 * 3. `inspectPendingReviewOperations`：只读巡检；
 * 4. `reconcileReviewOperation`：持锁核对与收口。
 *
 * 工件读写（`artifacts.ts`）与提交序列的内部函数一并导出，是为了让测试能在低层复现
 * "意图已发布、v2 已发布、记录未提交"等窗口，**不是**给调用方拼装自己的审核流程用的。
 */
export * from "./artifacts.ts";
export * from "./commitSteps.ts";
export * from "./contract.ts";
export * from "./decisions.ts";
export * from "./inspect.ts";
export * from "./reconcile.ts";
export * from "./writer.ts";
