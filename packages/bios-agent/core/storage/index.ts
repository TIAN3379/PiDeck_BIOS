/**
 * 存储层统一出口（BM-02A）。
 *
 * 本轮范围：**只读** + 显式初始化。
 * 普通记录的 create/update、跨进程锁、原子替换、journal 与迁移分别是 BM-02B/02C/02D。
 */
export * from "./errors.ts";
export * from "./limits.ts";
export * from "./boundary.ts";
export * from "./registry.ts";
export * from "./records.ts";
