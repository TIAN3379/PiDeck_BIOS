/**
 * BIOS 知识契约的版本与兼容性基线。
 *
 * 契约版本与 Package 版本彼此独立：`schemaVersion` 描述**记录结构**，
 * 决定读写兼容性；Package 版本描述代码版本。两者都不随 Pi 版本走。
 */

/** 知识记录结构版本。写入方必须显式携带；读取方遇到未知版本只读或拒绝写入。 */
export const BIOS_CONTRACTS_SCHEMA_VERSION = 1;

/** Package 身份（清单同名字段的单一来源，供自检与工具 details 输出）。 */
export const BIOS_AGENT_PACKAGE_NAME = "bios-agent";
export const BIOS_AGENT_PACKAGE_VERSION = "0.1.0";

/**
 * 已实测的 Pi 宿主版本区间。
 *
 * 为什么不能只依赖 peer 的 `"*"`：`"*"` 只表达「由宿主提供、不要打包」，
 * 不表达「已验证兼容」。本 Package 的工具与事件签名是按 0.87.1 的导出类型写的，
 * 超出该区间必须在升级时重新核对 `dist/index.d.ts` 后再放宽，而不是默默宣称兼容。
 */
export const TESTED_PI_CODING_AGENT_VERSION = "0.87.1";
export const TESTED_PI_CODING_AGENT_RANGE = ">=0.87.1 <0.88.0";
