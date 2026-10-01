/**
 * 存储层的资源限额。
 *
 * 全部有默认值，并可整体注入更小预算（测试与大文件场景）；
 * 上限必须**先于**读取内容生效：先看文件大小、再限定实际读取字节数，
 * 不能"读完整个文件再判断大小"（bm02a_development_plan.md §3.5）。
 *
 * 默认值按"单条记录是人工整理的档案/经验卡"来定，不按"把所有历史塞进一个文件"来定。
 */
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
};

export const DEFAULT_STORAGE_LIMITS: StorageLimits = {
	maxRecordBytes: 256 * 1024,
	maxRegistryBytes: 1024 * 1024,
	maxListEntries: 200,
	maxListBytes: 256 * 1024,
	maxScanEntries: 5_000,
	maxJsonChars: 1024 * 1024,
};

/** 合并默认值与调用方覆盖值（`undefined` 字段保持默认）。 */
export function resolveStorageLimits(overrides?: Partial<StorageLimits>): StorageLimits {
	if (!overrides) return DEFAULT_STORAGE_LIMITS;
	return { ...DEFAULT_STORAGE_LIMITS, ...overrides };
}
