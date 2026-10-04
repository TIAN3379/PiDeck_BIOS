/**
 * 路径边界的**纯判定**（BM-02C1 从 `boundary.ts` 抽出）。
 *
 * 抽取理由：`boundary.ts` 同时承担"能访问什么"（路径/链接判定，本文件）与"怎么有界地读写"
 * （IO 与预算），两者没有共享状态，混在一个文件里只会越过 600 行红线。
 * 这里全部是同步、无 IO 副作用的判定，因此可以独立推理与复用。
 *
 * 注意：这些是**词法/单次 lstat** 层面的判定，不是操作系统级沙箱，也不阻止同机其他进程
 * 在检查与操作之间替换路径。
 */
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import { isNotFoundError, mapFsError, StorageError } from "./errors.ts";

/**
 * 把 JSON.parse 的错误压成**不带原文**的诊断（BM-02AR / AR-2）。
 *
 * Node 20+ 的 `SyntaxError.message` 会把输入片段拼进消息里
 * （形如 `Unexpected token '}', "{"problem":"客户…" is not valid JSON`），
 * 直接透传等于把客户正文写进日志和错误对象。这里只保留位置与错误类型；
 * 调用方**不得**把原始错误放进 `cause`，否则同一条泄漏会从 `cause.message` 漏出去。
 */
export function describeJsonParseFailure(error: unknown): string {
	if (!(error instanceof SyntaxError)) return "无法解析为 JSON";
	const position = /at position (\d+)/.exec(error.message)?.[1];
	return position === undefined ? "无法解析为 JSON（语法错误）" : `无法解析为 JSON（位置 ${position}）`;
}

/** 从目标向上逐级检查，直到遇到第一个存在的路径段；存在段若是链接则拒绝。 */
export function assertNoSymlinkAlongExistingPath(targetPath: string): void {
	let current = targetPath;
	while (true) {
		let stats;
		try {
			stats = lstatSync(current);
		} catch (error) {
			if (!isNotFoundError(error)) throw mapFsError(error, "permission-denied", `无法检查路径：${current}`, current);
			const parent = dirname(current);
			if (parent === current) return;
			current = parent;
			continue;
		}
		if (stats.isSymbolicLink()) throw new StorageError("symlink-rejected", `路径中包含符号链接，本策略一律拒绝：${current}`, { path: current });
		return;
	}
}

/** 目标是否落在根内（纯词法比较，不做 realpath）。 */
export function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	if (rel === "") return true;
	return !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`));
}
