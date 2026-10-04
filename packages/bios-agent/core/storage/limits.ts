/**
 * 存储层的资源限额。
 *
 * 全部有默认值，并可整体注入更小预算（测试与大文件场景）；
 * 上限必须**先于**读取内容生效：先看文件大小、再限定实际读取字节数，
 * 不能"读完整个文件再判断大小"（bm02a_development_plan.md §3.5）。
 *
 * 默认值按"单条记录是人工整理的档案/经验卡"来定，不按"把所有历史塞进一个文件"来定。
 */
import { StorageError } from "./errors.ts";

export type StorageLimits = {
	/** 单个记录文件允许的最大字节数。 */
	maxRecordBytes: number;
	/** registry.json 允许的最大字节数。 */
	maxRegistryBytes: number;
	/** 列表单次返回的最大条目数。 */
	maxListEntries: number;
	/** 列表累计摘要字节预算（防止 200 条超大摘要把上下文打满）。 */
	maxListBytes: number;
	/** 单次列表最多检查的目录条目数（防止目录内海量文件拖死扫描）。 */
	maxScanEntries: number;
	/** 解析 JSON 时允许的最大字符串长度（与字节上限同量级，作为第二道闸）。 */
	maxJsonChars: number;
	/**
	 * 单次列表最多报告的异常条目数（BM-02AR / S4）。
	 *
	 * 为什么 problems 也要有预算：第四轮验收指出 `problems` 不在任何预算内，
	 * 一个装满坏文件的目录可以让"有界列表"返回无限多的错误对象。
	 */
	maxListProblems: number;
	/**
	 * 单条 journal 元数据的字节上限（BM-02C1）。
	 *
	 * journal 只存意图与 fingerprint，不复制正文；16 KiB 已远超它实际体积。
	 * 单独设限而不是复用 `maxRecordBytes`：journal 是**记账**，用业务记录上限兜底
	 * 等于让一次记账失败拖垮一次已经成功的业务写入（宁可判定"journal 不可读"）。
	 */
	maxJournalBytes: number;
	/** 一次 inspect 返回的最大候选（pending）条数。0 = 不返回候选（仍给出 scanned/truncated）。 */
	maxJournalInspectEntries: number;
	/**
	 * 一次 inspect 返回的 `pending` 候选数组的**实际 UTF-8 序列化字节**预算
	 * （含 `[` `]` 与逗号这些分隔符）。0 = 一条候选都放不下（空数组的信封开销已占满）。
	 *
	 * 它**不是**整个返回值的硬上限：`problems` 由 `maxJournalProblems`（条数）与单条诊断长度
	 * 上限独立约束，`scanned`/`truncatedBy` 等统计字段不计入本预算（BM-02C1R / J4）。
	 */
	maxJournalInspectBytes: number;
	/** 一次 inspect 最多扫描的 journal 目录条目数。0 = 不扫描（scanned=0 且 truncated）。 */
	maxJournalScanEntries: number;
	/** 一次 inspect 最多报告的问题条数。0 = 不返回问题对象，但 droppedProblems 如实计数。 */
	maxJournalProblems: number;
};

export const DEFAULT_STORAGE_LIMITS: StorageLimits = {
	maxRecordBytes: 256 * 1024,
	maxRegistryBytes: 1024 * 1024,
	maxListEntries: 200,
	maxListBytes: 256 * 1024,
	maxScanEntries: 5_000,
	maxJsonChars: 1024 * 1024,
	maxListProblems: 50,
	maxJournalBytes: 16 * 1024,
	maxJournalInspectEntries: 200,
	maxJournalInspectBytes: 256 * 1024,
	maxJournalScanEntries: 5_000,
	maxJournalProblems: 50,
};

/**
 * 合并默认值与调用方覆盖值（显式 `undefined` 保持默认），并**校验限额本身合法**。
 *
 * 两处都在修 BM-02AR / AR-2 指出的问题：
 *
 * 1. 显式 `undefined` 覆盖：旧实现直接 `{ ...DEFAULT, ...overrides }`，
 *    调用方传 `{ maxListBytes: undefined }` 会把默认值抹成 `undefined`，
 *    于是所有 `> limit` 比较恒为 false——限额静默失效。
 * 2. 非法数值：`NaN` / `Infinity` / 负数 / 非整数同样让预算形同不存在
 *    （`used > NaN` 恒为 false）。这是"配置错误静默变成无上限"的典型，
 *    所以直接抛 `invalid-limits`，而不是带着一个假的预算继续跑。
 */
export function resolveStorageLimits(overrides?: Partial<StorageLimits>): StorageLimits {
	const merged: StorageLimits = { ...DEFAULT_STORAGE_LIMITS };

	if (overrides) {
		for (const key of Object.keys(DEFAULT_STORAGE_LIMITS) as Array<keyof StorageLimits>) {
			const value = overrides[key];
			if (value !== undefined) merged[key] = value;
		}
	}

	for (const [key, value] of Object.entries(merged) as Array<[keyof StorageLimits, number]>) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new StorageError("invalid-limits", `存储限额 ${key} 必须是有限非负整数，收到：${String(value)}`, { detail: key });
		}
	}

	return merged;
}
