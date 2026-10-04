/**
 * 迁移预检（BM-02C3）的资源限额。
 *
 * 为什么**另立一份**而不是扩 `StorageLimits`：预检是只读扫描，需要"条目/读取/输出"三类预算；
 * 把这些字段塞进 `StorageLimits` 等于给每个写入接口也加一遍无关的旋钮（写路径根本不用它们），
 * 而且会让"写入限额"这个已经被验证过的契约发生非必要变化。
 *
 * 语义要点（与 `StorageLimits` 同一口径）：
 * - 显式 `undefined` 保持默认（`{ ...DEFAULT, ...overrides }` 会把默认值抹成 `undefined`，
 *   于是所有 `> limit` 比较恒为 false，限额静默失效）；
 * - 非数字 / 非安全整数 / 负数一律抛 `invalid-limits`（`NaN`/`Infinity` 会让预算形同不存在）；
 * - **0 是合法值**，含义逐字段写明，不做"0 = 无上限"的暗示。
 */
import { StorageError } from "../errors.ts";

export type PreflightLimits = {
	/**
	 * 一次预检最多检查的目录条目数（所有目录**共享**同一个预算）。
	 *
	 * 被跳过的链接、未知条目、子目录本身都消耗它——只统计"成功读到的记录"会让
	 * 一个装满怪东西的目录看起来不需要任何预算（BM-02AR / S4 的同一教训）。
	 * **有界列举一返回就把已观察条目计入**（不是等候选处理完成），所以真实观察总数不超过
	 * `maxScanEntries + 1`（唯一允许的超限探测条目）；`scannedEntries` 因此可能等于
	 * `maxScanEntries + 1`（BM-02C3R / PF-4 / S1）。
	 *
	 * 本预算同时覆盖少量**逻辑核对**（如 registry 已登记但磁盘上没有项目目录）：
	 * 这类核对不产生新的目录观察、也不计入 `scannedEntries`，但仍受同一上限约束，
	 * 以免登记表异常时核对次数无界。
	 * 0 = 不检查任何条目（仍会观察一次用于判定截断，结论必然是 `incomplete`）。
	 */
	maxScanEntries: number;
	/**
	 * 单次读取允许的最大字节数（单文件硬上限）。
	 *
	 * 它同时是**失败尝试的预留额度**：读失败时按这个值计入 `reservedBytes`（见下），
	 * 因为"实际读了多少字节"在失败路径上拿不到；宁可高估，也不能把失败当成零成本。
	 * 0 = 一次读取都不发起：读取预算立即视为耗尽，标记 `read-bytes` 截断并得到 `incomplete`
	 * （**不是**"逐个候选报超限"）。
	 */
	maxFileBytes: number;
	/**
	 * 一次预检累计可用的读取字节预算。
	 *
	 * 成功读取按**实际**返回字节计入 `readBytes`；失败尝试按预留额度计入 `reservedBytes`
	 * （两个字段分开报告，不混称"读取字节"）。预算耗尽即停止扫描并标记截断。
	 * 0 = 一次读取都不做（结论必然是 `incomplete`）。
	 */
	maxReadBytes: number;
	/** 文件摘要最多返回条数。0 = 不返回摘要（仍计数，截断照实标记）。 */
	maxFileSummaries: number;
	/**
	 * `problems` 与 `manual` **合计**最多返回的条数（同一份额度，与处理顺序无关）。
	 *
	 * 即 `problems.length + manual.length <= maxProblems`（BM-02C3R / PF-2）。
	 * 0 = 两类明细都不返回。
	 *
	 * 注意：**阻断计数与人工总计不受此上限影响**——明细被裁剪时结论仍是
	 * `blocked`/`incomplete`，不允许用"没地方写问题"冒充"没有问题"。
	 */
	maxProblems: number;
	/** 单条诊断文案的字符上限（超出截断并加显式标记；避免坏文件把报告打满）。0 = 空文案。 */
	maxIssueChars: number;
	/**
	 * `summaries` / `problems` / `manual` 三类明细的**实际 UTF-8 序列化字节**预算。
	 *
	 * 唯一口径：三类明细按「摘要 → 问题 → 人工事项」合并成一个 JSON 数组后的字节数，
	 * **含数组括号与逗号分隔符**，空明细计 0；固定报告信封不计入（BM-02C3R / PF-3）。
	 * 刻意用字节而不是字符数：中文/控制字符按字符数计量会低估 3~6 倍。
	 * 0 = 不返回任何明细；预算耗尽即停止扫描并标记截断。
	 */
	maxOutputBytes: number;
};

export const DEFAULT_PREFLIGHT_LIMITS: PreflightLimits = {
	maxScanEntries: 5_000,
	maxFileBytes: 256 * 1024,
	maxReadBytes: 16 * 1024 * 1024,
	maxFileSummaries: 512,
	maxProblems: 200,
	maxIssueChars: 200,
	maxOutputBytes: 512 * 1024,
};

/** 合并默认值并校验限额本身合法（显式 `undefined` 保持默认）。 */
export function resolvePreflightLimits(overrides?: Partial<PreflightLimits>): PreflightLimits {
	const merged: PreflightLimits = { ...DEFAULT_PREFLIGHT_LIMITS };
	if (overrides) {
		for (const key of Object.keys(DEFAULT_PREFLIGHT_LIMITS) as Array<keyof PreflightLimits>) {
			const value = overrides[key];
			if (value !== undefined) merged[key] = value;
		}
	}
	for (const [key, value] of Object.entries(merged) as Array<[keyof PreflightLimits, number]>) {
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			throw new StorageError("invalid-limits", `预检限额 ${key} 必须是有限非负整数，收到：${String(value)}`, { detail: `preflight-${key}` });
		}
	}
	return merged;
}
