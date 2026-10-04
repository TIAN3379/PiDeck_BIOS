/**
 * 候选路径探测（BM-02C3R / PF-1）：把"探测失败"变成**显式状态**而不是异常。
 *
 * 为什么单独一个文件：这是"路径存在性"这一类语义的唯一实现，既被有界列举（`scan.ts`）用，
 * 也被 `cache/` 落点用；同时预检的体量红线要求它别把 `scan.ts` 撑过 400 行。
 *
 * 三条硬规则：
 * 1. **非根目录的 `stat`/打开失败是问题，不是"不存在"**：必须能按受控类别/路径收集后继续检查；
 * 2. **取消始终结构化穿透**（不被收集成普通问题）；
 * 3. **未知异常不透传原始正文**：报告是公开产物，可能被贴到工单里。
 */
import { isCancelledError, isStorageError, StorageError, throwIfAnyCancelled } from "../errors.ts";
import type { PreflightCode } from "./contract.ts";
import type { ScanState } from "./scan.ts";

/** 候选路径的探测结果。 */
export type PathProbe = { readonly kind: "absent" } | { readonly kind: "present" } | { readonly kind: "link" } | { readonly kind: "failed"; readonly code: PreflightCode; readonly message: string };

function probeFailure(error: unknown, what: string): PathProbe {
	if (isStorageError(error)) return { kind: "failed", code: error.code, message: `${what}：${error.code}` };
	// 未知异常只给受控说明：报告是公开产物，不能把原始错误正文（可能含客户路径）带出去。
	return { kind: "failed", code: "unreadable", message: `${what}（未分类错误）` };
}

/**
 * 探测候选路径（不跟随链接、失败不抛出；取消照旧穿透）。
 *
 * 取消检查与 `scan.ts` 的 `assertNotCancelled` 同义（同一个 `throwIfAnyCancelled` 出口），
 * 在这里直接内联是为了不形成 `scan.ts ↔ pathProbe.ts` 的运行时循环依赖。
 */
export async function probePath(scan: ScanState, absolute: string): Promise<PathProbe> {
	throwIfAnyCancelled([scan.boundary.signal]);
	let exists: boolean;
	try {
		exists = await scan.boundary.pathExists(absolute, scan.boundary.signal);
	} catch (error) {
		if (isCancelledError(error)) throw error;
		return probeFailure(error, "无法探测路径");
	}
	if (!exists) return { kind: "absent" };
	try {
		scan.boundary.assertNoSymlinks(absolute);
		return { kind: "present" };
	} catch (error) {
		if (isCancelledError(error)) throw error;
		if (error instanceof StorageError && error.code === "symlink-rejected") return { kind: "link" };
		return probeFailure(error, "无法探测路径");
	}
}
