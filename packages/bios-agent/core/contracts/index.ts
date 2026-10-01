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
// registry 是知识库索引的契约（不是"记录"），因此不进入 RECORD_SCHEMAS。
export * from "./registry.ts";
