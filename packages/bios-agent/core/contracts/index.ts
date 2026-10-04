/**
 * 契约统一出口。
 * 调用方（extensions／cli／测试／后续 storage）只 import 这里，
 * 避免每加一个记录类型就散落式改多处 import。
 */
export * from "./version.ts";
// ID 规则（含运行时校验与错误类型）只在这里出一次口：
// schema 与路径拼接共享同一份定义，调用方不需要知道它在哪个文件。
export * from "./ids.ts";
export * from "./common.ts";
export * from "./records.ts";
export * from "./validate.ts";
// 审核审计是**独立类别**（自己的 auditVersion），不进入 RECORD_SCHEMAS，也不复用 schemaVersion 闸门。
// 事件 → 意图（决定）→ 关联（意图/投影/已有事件的纯比较）三层各自成文件，公共出口只在这里加一次。
export * from "./audit.ts";
export * from "./auditValidation.ts";
export * from "./auditIntent.ts";
export * from "./auditAssociation.ts";
// registry 是知识库索引的契约（不是"记录"），因此不进入 RECORD_SCHEMAS。
export * from "./registry.ts";
