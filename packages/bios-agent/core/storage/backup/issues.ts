/**
 * 备份协议内部的**有界诊断原语**（BM-02D1）。
 *
 * 为什么单独一份：清单校验与 payload 核验必须共用同一套"严格对象 + 有界问题 + 不回显输入"
 * 实现。两处各写一遍，迟早在"未知字段算不算错""预算用完了还算不算失败"上出现分歧——
 * 而这两个问题的答案直接决定"清单能不能被信任"。
 */
import type { BackupIssue, BackupIssueCode } from "./contract.ts";

/**
 * 有界问题收集器。
 *
 * 超预算只**计数**，不抛错、不提前返回：结论始终由 `count()` 决定，因此
 * `maxIssues=0` 也会失败并如实给出 `droppedIssues`——"没地方写错误"永远不等于"没有问题"。
 */
export type IssueSink = {
	add(code: BackupIssueCode, where: string, message: string): void;
	count(): number;
	issues(): BackupIssue[];
	dropped(): number;
};

export function createIssueSink(maxIssues: number): IssueSink {
	const collected: BackupIssue[] = [];
	let dropped = 0;
	return {
		add: (code, where, message) => {
			if (collected.length >= maxIssues) {
				dropped += 1;
				return;
			}
			collected.push({ code, where, message });
		},
		count: () => collected.length + dropped,
		issues: () => [...collected],
		dropped: () => dropped,
	};
}

/** 普通对象判定：数组、类实例、`null`、带自定义原型的对象一律不是可信输入。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/**
 * 未知字段计数（含 symbol 键）。
 *
 * 非字符串键无法落进受控字段表，因此与"没定义过的字符串键"同等对待。
 */
export function unknownFieldCount(value: Record<string, unknown>, allowed: ReadonlySet<string>): number {
	let count = 0;
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !allowed.has(key)) count += 1;
	}
	return count;
}
