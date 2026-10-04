/**
 * BM-04 知识与经验服务出口。
 *
 * 分层：
 * - `contract.ts`：受控错误、资源预算、纯输入判定（无 IO）；
 * - `features.ts`：需求（Feature）录入/更新/详情（v1 复用，不升 schema）；
 * - `experiences.ts`：经验草稿 + 人工审核（复用 `recordReviewDecision` 与审计）；
 * - `search.ts`：有界关键词/别名检索与跨项目参考详情（调用 M1 决策）。
 *
 * 仍然**不提供**：自动批准、模型写知识工具、向量/语义检索、UI、迁移与字段历史。
 */
export * from "./contract.ts";
export * from "./features.ts";
export * from "./experiences.ts";
export * from "./search.ts";
