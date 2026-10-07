/**
 * AW 自动化附属层（纯策略 + 存储 + 只读 working + 摘要扫描 + 续接决策）。
 *
 * 边界：这里**不**依赖 Electron/React/Jotai/Pi Session；扩展层只做生命周期协调与闸门，
 * 具体策略与存储留在本目录，便于单测与跨进程复用。
 */
export * from "./contract.ts";
export * from "./policy.ts";
export * from "./resume.ts";
export * from "./store.ts";
export * from "./summary.ts";
export * from "./working.ts";
