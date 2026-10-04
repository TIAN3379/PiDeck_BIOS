/**
 * 离线备份（BM-02D1）的**独立资源限额**。
 *
 * 为什么不复用 `StorageLimits`：那是"在真正的知识根上读写一条记录"的预算
 * （单条记录字节、目录扫描条目、journal 体量……），而备份清单描述的是**整库的另一份表示**——
 * 条目按 10^4 量级、单文件按 16 MiB、总 payload 按 256 MiB。混进同一份类型里，
 * 任何一边调参都会悄悄改变另一边的安全边界，这一轮又恰好只交付纯协议（没有真实 IO 兜底）。
 *
 * 语义与既有限额保持同一口径：
 * - 显式 `undefined` 保持默认（`{ ...DEFAULT, ...overrides }` 会把默认值抹成 `undefined`，
 *   于是所有 `> limit` 比较恒为 false，限额静默失效）；
 * - 非数字 / 非安全整数 / 负数 / `NaN` / `Infinity` 一律抛 `invalid-limits`；
 * - 未知字段也拒绝（拼错 `maxFiles` 会静默变成"用默认值"，在备份协议里等于换了一份预算）；
 * - **0 表示不允许该项消耗**，不是"无限"：清单里有必需的 `registry.json`，
 *   因此零/过小的预算会被明确拒绝，而不是返回一份"通过"的空壳。
 */
import { StorageError } from "../errors.ts";

export type BackupLimits = {
	/** manifest 规范化后 JSON 序列化的 UTF-8 字节上限（不是磁盘读取上限，见实施记录 §未测）。 */
	maxManifestBytes: number;
	/** files 数组允许的条目数。0 = 一个文件项都不允许（必然拒绝：registry.json 是必需的）。 */
	maxFiles: number;
	/** directories 数组允许的条目数。0 = 一个目录都不允许（必然拒绝：四个固定目录是必需的）。 */
	maxDirectories: number;
	/** 单个文件项声明的字节数上限。0 = 只允许长度 0 的 payload。 */
	maxFileBytes: number;
	/** 全部文件项声明字节数的总上限。0 = 所有文件都必须是空 payload。 */
	maxTotalPayloadBytes: number;
	/** 单条受控相对路径的字符数上限（`/` 计入）。0 = 任何路径都超限（必然拒绝）。 */
	maxRelativePathChars: number;
	/**
	 * 返回的问题条目上限。
	 *
	 * 0 = 不返回问题对象，但 `droppedIssues` 如实计数、结果仍然是失败——
	 * "没地方写错误"永远不等于"没有错误"（与 PF-2 同一教训）。
	 */
	maxIssues: number;
};

export const DEFAULT_BACKUP_LIMITS: BackupLimits = {
	maxManifestBytes: 2 * 1024 * 1024,
	maxFiles: 10_000,
	maxDirectories: 2_000,
	maxFileBytes: 16 * 1024 * 1024,
	maxTotalPayloadBytes: 256 * 1024 * 1024,
	maxRelativePathChars: 240,
	maxIssues: 50,
};

/** 已知限额字段名（未知字段在解析默认值之前就拒绝）。 */
const BACKUP_LIMIT_KEYS: ReadonlySet<string> = new Set(Object.keys(DEFAULT_BACKUP_LIMITS));

/**
 * 合并默认值并校验限额本身合法（显式 `undefined` 保持默认）。
 *
 * 与 `resolveStorageLimits` 的两点差异都来自"纯协议、无 IO 兜底"：
 * 1. **未知字段直接拒绝**（`invalid-limits`）：备份预算写错一个名字就等于换了一套安全边界；
 * 2. 非法值同样在**处理任何数据之前**抛出，而不是带着假预算继续跑。
 */
export function resolveBackupLimits(overrides?: Partial<BackupLimits>): BackupLimits {
	const merged: BackupLimits = { ...DEFAULT_BACKUP_LIMITS };

	if (overrides !== undefined) {
		for (const key of Object.keys(overrides)) {
			if (!BACKUP_LIMIT_KEYS.has(key)) {
				throw new StorageError("invalid-limits", `备份限额存在未知字段：${key}`, { detail: `backup-${key}` });
			}
		}
		for (const key of Object.keys(DEFAULT_BACKUP_LIMITS) as Array<keyof BackupLimits>) {
			const value = overrides[key];
			if (value !== undefined) merged[key] = value;
		}
	}

	for (const [key, value] of Object.entries(merged) as Array<[keyof BackupLimits, number]>) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new StorageError("invalid-limits", `备份限额 ${key} 必须是有限非负整数，收到：${String(value)}`, { detail: `backup-${key}` });
		}
	}

	return merged;
}
