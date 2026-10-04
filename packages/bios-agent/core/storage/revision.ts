/**
 * 公共头（`RecordBase`）的 revision 语义，**记录与 registry 共用同一份实现**。
 *
 * 为什么单独成模块：`write.ts`（记录写入）已经依赖 `registry.ts`（复用初始化的
 * `validateRegistry` / `inspectBindingIssues`），如果 registry 的更新再反向 import
 * `write.ts` 就会形成循环依赖。把"下一版公共头"抽出来，两边都只依赖本模块。
 *
 * 为什么不能让两边各写一份：上一轮实现里 registry 用 `current.revision + 1` 裸加，
 * 记录走 `nextHeader` 的上限判断——同一个概念两套溢出/守卫逻辑，
 * 迟早出现"记录挡住了、registry 没挡住"的漏洞。这里只保留一份。
 *
 * **不允许**把"提升 schemaVersion"当作整数溢出的修复手段：那是两件事。
 * 版本闸门管的是结构兼容，revision 上限管的是乐观并发控制还能不能成立。
 */

import type { RecordBase } from "../contracts/common.ts";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../contracts/version.ts";
import { StorageError } from "./errors.ts";

/** `expectedRevision`：`null` = 要求目标不存在；数字 = 要求 revision 恰好相等。 */
export type ExpectedRevision = number | null;

/**
 * 错误消息里的短描述。
 *
 * 刻意**不**做深度序列化：错误消息会被写进日志/展示给用户，
 * 把客户正文（可能很大、可能含隐私）带进去是信息泄漏。
 */
export function describeValue(value: unknown): string {
	if (typeof value === "string") return `"${value}"`;
	if (value === undefined) return "undefined";
	return String(value);
}

/**
 * 读到的**当前** revision 必须是可安全递增的整数。
 *
 * 超过 `Number.MAX_SAFE_INTEGER` 的值虽然仍是合法 JS number，但 `x + 1 === x`，
 * 乐观并发控制就此失效（永远"相等"）。这种文件只能来自外部篡改或历史缺陷，
 * 必须明确拒绝并让人工介入，而不是当普通冲突或继续递增。
 */
export function assertSafeRevision(value: unknown, label: string, relativePath: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new StorageError("revision-conflict", `${label} 当前 revision 不是可安全递增的整数：${describeValue(value)}（${relativePath}）。` + `超过 Number.MAX_SAFE_INTEGER（${Number.MAX_SAFE_INTEGER}）的值已无法作为并发校验依据，需人工修复该文件。`, { path: relativePath, detail: "unsafe-current-revision" });
	}
	return value;
}

/** `expectedRevision` 的形态校验：非法值不能当成"随便写"，而要明确拒绝。 */
export function assertExpectedRevisionShape(value: unknown, label: string, allowNull: boolean): ExpectedRevision {
	if (value === null) {
		if (!allowNull) {
			throw new StorageError("revision-conflict", `${label} 的 expectedRevision 不能为 null（null 只用于新建，表示"要求目标不存在"）`, { detail: "unexpected-null-revision" });
		}
		return null;
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		throw new StorageError("revision-conflict", `${label} 的 expectedRevision 不合法：${describeValue(value)}（必须是 >= 0 的安全整数，且不超过 ${Number.MAX_SAFE_INTEGER}；新建时用 null）`, { detail: "invalid-expected-revision" });
	}
	return value;
}

/**
 * 组装下一版公共头：create 从 0 起，update 递增。
 *
 * 三项不变量：
 * - `createdAt` 沿用旧值（记录"这条记录什么时候出现"，不是"什么时候被写"）；
 * - `schemaVersion` **沿用读到的那一版**（写入不是升级结构的机会，升级要另走迁移）；
 * - `updatedAt = max(now, 旧值)`，注入时钟回拨也不会倒退。
 */
export function nextRecordHeader(previous: RecordBase | undefined, now: number, label: string, relativePath: string): RecordBase {
	if (previous === undefined) {
		return { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: now, updatedAt: now };
	}
	const revision = assertSafeRevision(previous.revision, label, relativePath);
	if (revision >= Number.MAX_SAFE_INTEGER) {
		// 溢出后 `revision + 1` 会等于自身，乐观并发控制就此失效（永远"相等"）。
		throw new StorageError("revision-conflict", `${label} 的 revision 已达可表示上限，无法继续递增：${relativePath}`, { path: relativePath, detail: "revision-overflow" });
	}
	return { schemaVersion: previous.schemaVersion, revision: revision + 1, createdAt: previous.createdAt, updatedAt: Math.max(now, previous.updatedAt) };
}
