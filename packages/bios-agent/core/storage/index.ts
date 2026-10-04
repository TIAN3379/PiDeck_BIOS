/**
 * 存储层统一出口。
 *
 * 当前范围：有界读取 + 显式初始化（BM-02A）+ 三类写入入口与跨进程锁（BM-02B/BM-02BR）
 * + 普通写 journal 与崩溃后核对（BM-02C1/C1R）
 * + **一次经验卡审核的真实持久化闭环**（BM-02C2B：意图/事件工件、审核专用 journal v2、
 *   域入口、只读巡检与显式收口）
 * + **知识库版本盘点与迁移预检**（BM-02C3：只读、有界、可取消的格式版本/阻断事项清点）
 * + **离线备份协议与纯校验**（BM-02D1：`backupVersion=1` 清单、受控落点、资源上限，
 *   以及内存原始字节的清单/长度/SHA-256 核验；**不含任何导出/恢复 IO**）。
 *
 * 仍不提供：通用 N 文件事务、跨项目批量修改、自动后台恢复、版本迁移与备份 IO、管理 CLI。
 * 这里不导出任何占位实现，避免调用方误以为已具备事务能力。
 */
export * from "./errors.ts";
export * from "./limits.ts";
export * from "./boundary.ts";
export * from "./lock.ts";
export * from "./registry.ts";
export * from "./records.ts";
export * from "./revision.ts";
export * from "./journal/index.ts";
export * from "./review/index.ts";
export * from "./preflight/index.ts";
export * from "./backup/index.ts";
export * from "./write.ts";
