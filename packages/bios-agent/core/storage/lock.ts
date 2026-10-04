/**
 * 知识库的**协作式跨进程锁**（BM-02B / B2）。
 *
 * 为什么需要它：`updateRecord` 这类操作是"读 → 组装 → 原子替换"三步，
 * 原子替换只保证"读者不会看到半成品"，**不保证"两个写者不会互相覆盖"**——
 * 两个进程同时读到 revision 5、各自写成 revision 6，后写的那个会把先写的成果整段丢掉。
 *
 * 实现选择与边界（不夸大）：
 *
 * 1. 锁是**目录**，靠 `mkdir` 的原子性判定归属：`mkdir` 成功 = 拿到锁，
 *    `EEXIST` = 已被持有。不用"先 exists 再创建"（中间会被插空），
 *    也不用"创建文件当锁"（`O_EXCL` 在部分网络盘上不可靠，且无法携带元数据）。
 * 2. 锁键 = 锁目录所在的知识根 + **受控相对目标**，再散列成定长文件名。
 *    Windows 上大小写归一，避免同一目标产生两个锁名。
 * 3. **不抢占、不判定死锁**：持锁进程崩溃会留下锁目录，
 *    但"凭时间戳或 pid 存活判断把别人的锁删掉"在没有原子 compare-and-swap 的
 *    文件系统上无法做对（判活与删除之间原持有者可能刚好写完）。
 *    因此这里只做**有界等待 + 明确的诊断信息**，把"要不要人工清理"交给人。
 * 4. 元数据缺失/损坏一律按**忙碌**处理，绝不当成"可以拿"。
 *    否则"元数据还没写完"的窗口就成了抢占窗口。
 * 5. 释放前校验 `ownerId`：不是自己的锁**不删除**。
 *    这防的是"我超时放弃了，但锁后来真的归我，于是我在别人持有期间把它删掉"。
 *
 * 这些是**协作**约束：只对遵守同一协议的本地进程有效，不阻止绕过协议的编辑器或
 * 其它写者，也不承诺未经验证的网络盘（NFS/SMB）语义。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { delayWithCancellation, type StorageBoundary } from "./boundary.ts";
import { isAlreadyExistsError, isCancelledError, isNotFoundError, isStorageError, mapFsError, StorageError, throwIfAnyCancelled } from "./errors.ts";

/** 默认等待上限：写操作是交互式的，10s 已经足够表达"别人正在写，稍后再来"。 */
export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
/** 默认轮询间隔：文件系统上没有可用的条件变量，只能退避轮询。 */
export const DEFAULT_LOCK_POLL_MS = 50;
/** 锁元数据上限：它只有四个小字段，超出即视为损坏。 */
const LOCK_META_MAX_BYTES = 4096;
/**
 * 等待上限的合法上界。
 *
 * 取 `2^31 - 1`：这是 Node 定时器不发出"超过 2^31 毫秒"警告的上限，
 * 也远小于 `Date` 的可表示范围，`Date.now() + timeoutMs` 不会溢出成 `NaN`。
 * 传更大的值只会让调用方以为自己设置了"无限等待"，实际拿到一个不可信的截止时间。
 */
export const MAX_LOCK_TIMEOUT_MS = 2_147_483_647;
/** 元数据里字符串字段的长度上界：不是自己的东西，就不能按自己的大小假设去读。 */
const LOCK_META_OWNER_MAX_CHARS = 128;
const LOCK_META_TARGET_MAX_CHARS = 1024;
/**
 * `Date` 可表示的最大时间戳（8640000000000000）；超出即 `toISOString()` 会抛 `RangeError`。
 *
 * 导出给 BM-02C1 的 journal 契约复用：时间字段的上界只有一份定义，
 * 两处各写一个数字迟早漂移成"锁认为合法、journal 认为非法"。
 */
export const MAX_DATE_MS = 8_640_000_000_000_000;

/** 已解析并校验过的锁时序参数。 */
export type LockTiming = {
	timeoutMs: number;
	pollMs: number;
	now: number;
};

function invalidTiming(field: string, value: unknown, requirement: string): StorageError {
	return new StorageError("invalid-limits", `锁参数 ${field} 不合法：${String(value)}（${requirement}）`, { detail: field });
}

function assertBoundedInteger(field: string, value: unknown, min: number, max: number, requirement: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
		throw invalidTiming(field, value, requirement);
	}
	return value;
}

/**
 * 时序参数校验（**纯输入判定**，不碰文件系统）。
 *
 * 为什么必须显式拒绝而不是"用默认值兜底"：`NaN` 会让 `Date.now() + NaN >= deadline`
 * 永远为假——等待循环就此变成**无界自旋**；`Infinity` 同理；
 * `pollMs: 0` 是忙等；`now` 超出 `Date` 范围会让元数据里的时间戳在诊断时炸出 `RangeError`。
 * 这些都属于"调用方写错了"，报错比猜测意图更有用。
 */
export function resolveLockTiming(options: { timeoutMs?: number; pollMs?: number; now?: number }): LockTiming {
	const timeoutMs = options.timeoutMs === undefined ? DEFAULT_LOCK_TIMEOUT_MS : assertBoundedInteger("timeoutMs", options.timeoutMs, 0, MAX_LOCK_TIMEOUT_MS, "必须是 0（只试一次）到 2^31-1 之间的整数");
	const pollMs = options.pollMs === undefined ? DEFAULT_LOCK_POLL_MS : assertBoundedInteger("pollMs", options.pollMs, 1, MAX_LOCK_TIMEOUT_MS, "必须是正的安全整数（0 会退化成忙等）");
	const now = options.now === undefined ? Date.now() : assertBoundedInteger("now", options.now, 0, MAX_DATE_MS, "必须是 Date 可表示范围内的安全整数");
	return { timeoutMs, pollMs, now };
}

/** 锁持有者的受控诊断信息（**不含**任何记录正文）。 */
export type LockDiagnostics = {
	ownerId: string;
	pid: number | null;
	createdAt: number | null;
	target: string | null;
};

/**
 * 释放结果（含"释放动作本身抛错"这一种由调用方收敛出的状态）。
 *
 * 放在锁模块而不是写入模块：它是 `release()` 的语义延伸，"failed" 只是调用方对
 * "抛错"的归类；写在锁旁边可以让 journal 一侧（reconcile）复用同一份定义，
 * 而不必反向依赖 `write.ts` 形成循环。
 */
export type LockReleaseOutcome = "released" | "not-owner" | "missing" | "failed";

export type StorageLockHandle = {
	/** 锁的受控标识（散列后的锁名）。 */
	key: string;
	/** 锁目录的绝对路径。 */
	path: string;
	ownerId: string;
	/** 本次等待经历的尝试次数（1 = 一次拿到）。 */
	attempts: number;
	/**
	 * 释放锁：只有元数据里的 `ownerId` 与本次持有者一致才真正删除。
	 * 返回 `missing` / `not-owner` 表示"没删"——这是如实报告，不是失败。
	 */
	release(): Promise<"released" | "not-owner" | "missing">;
};

export type AcquireStorageLockOptions = {
	/** 被保护的**绝对**目标路径（必须在知识根内）。 */
	target: string;
	timeoutMs?: number;
	pollMs?: number;
	signal?: AbortSignal;
	/** 可注入时钟（测试记录元数据时间戳用）。 */
	now?: number;
};

/**
 * 由受控相对目标派生锁名。
 *
 * 为什么要散列而不是直接用路径：目标相对路径可能很长（超过文件名上限）、
 * 含分隔符（无法当文件名），且 Windows 大小写不敏感——不归一会让
 * `Projects/A/...` 与 `projects/a/...` 指向同一个文件却拿到两个锁。
 */
export function lockNameFor(relativeTarget: string, platform: NodeJS.Platform = process.platform): string {
	const normalized = platform === "win32" ? relativeTarget.toLowerCase() : relativeTarget;
	return `lock-${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/** 把知识根内的绝对目标换算成锁用的相对键。 */
export function lockRelativeTarget(boundary: StorageBoundary, absoluteTarget: string): string {
	const rel = relative(boundary.canonicalRoot, absoluteTarget);
	if (rel === "") return ".";
	if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
		throw new StorageError("path-escape", `锁目标不在知识根内：${absoluteTarget}`, { path: absoluteTarget });
	}
	return rel;
}

/**
 * 解析锁元数据：**它是不可信输入**。
 *
 * `owner.json` 可能来自旧版本、被人手工改过、或被上一次崩溃写了一半。
 * 这里的每条上界都对应一个真实故障：
 * - 不设长度上界 → 诊断消息被塞进几 MB 的 `ownerId`；
 * - `createdAt` 不做范围判定 → 格式化时 `new Date(1e100).toISOString()` 抛 `RangeError`，
 *   把"等待超时"变成一条看不懂的内部错误；
 * - `pid` 允许 `NaN`/负数 → 打印出来的"持有者"根本不存在。
 * 任一项不满足都返回 `null`（= 元数据不可读）。调用方只按**忙碌**处理，绝不抢占。
 */
function parseLockMeta(value: unknown): LockDiagnostics | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.ownerId !== "string" || record.ownerId.length === 0 || record.ownerId.length > LOCK_META_OWNER_MAX_CHARS) return null;
	const target = typeof record.target === "string" && record.target.length <= LOCK_META_TARGET_MAX_CHARS ? record.target : null;
	const pid = typeof record.pid === "number" && Number.isSafeInteger(record.pid) && record.pid >= 0 ? record.pid : null;
	const createdAt = typeof record.createdAt === "number" && Number.isSafeInteger(record.createdAt) && record.createdAt >= 0 && record.createdAt <= MAX_DATE_MS ? record.createdAt : null;
	return { ownerId: record.ownerId, pid, createdAt, target };
}

/** 时间戳格式化：只在已通过范围校验的值上调用，`RangeError` 不会发生。 */
function formatLockTimestamp(value: number): string {
	return new Date(value).toISOString();
}

/** 把诊断信息压成一行描述，供超时错误使用；**不含正文**。 */
export function describeLockHolder(diagnostics: LockDiagnostics | null): string {
	if (!diagnostics) return "，当前持有者元数据不可读（按忙碌处理，不抢占）";
	const parts = [`ownerId=${diagnostics.ownerId.slice(0, 8)}`];
	if (diagnostics.pid !== null) parts.push(`pid=${diagnostics.pid}`);
	if (diagnostics.createdAt !== null) parts.push(`createdAt=${formatLockTimestamp(diagnostics.createdAt)}`);
	return `，当前持有者：${parts.join(" ")}`;
}

async function readLockMeta(boundary: StorageBoundary, metaPath: string): Promise<LockDiagnostics | null> {
	return readLockMetaWith(boundary, metaPath, false);
}

/**
 * 释放前的元数据读取：**忽略取消信号**。
 *
 * 释放是清理"本次调用自己创建的锁"，而锁没有回收器。若这里受调用方取消影响，
 * 一次"用户取消了写入"就会把锁永久留在磁盘上，之后所有写者都会超时。
 * 等待期间读取持锁者诊断信息则相反：一旦取消就该立刻停，不必再读。
 */
async function readLockMetaForCleanup(boundary: StorageBoundary, metaPath: string): Promise<LockDiagnostics | null> {
	return readLockMetaWith(boundary, metaPath, true);
}

async function readLockMetaWith(boundary: StorageBoundary, metaPath: string, forCleanup: boolean): Promise<LockDiagnostics | null> {
	try {
		await boundary.beforeIo("lock-read", metaPath);
		// 复用有界 JSON 读取：损坏、超限、链接都会抛错，统一落到"不可读"。
		const { value } = forCleanup ? await boundary.readJsonForCleanup(metaPath, LOCK_META_MAX_BYTES) : await boundary.readJson(metaPath, LOCK_META_MAX_BYTES);
		return parseLockMeta(value);
	} catch (error) {
		// 普通等待期间的读取**必须**传播取消：读取本身可能很慢（比如被 antivirus 拖着），
		// 一旦用户取消，这里再吞掉就变成"取消了还在等锁"。释放专用读取相反，见函数头注释。
		if (!forCleanup && isCancelledError(error)) throw error;
		// 其余错误刻意吞掉：它对调用方没有可行动信息，
		// 而"能不能读到元数据"本身**不是**判定能否拿锁的依据（判定只看 mkdir）。
		return null;
	}
}

/** 只读取锁当前状态的诊断视图（测试与人工排查用；不产生副作用）。 */
export async function readStorageLockDiagnostics(boundary: StorageBoundary, target: string): Promise<LockDiagnostics | null> {
	const metaPath = join(boundary.resolve("locks"), lockNameFor(lockRelativeTarget(boundary, target)), "owner.json");
	return readLockMeta(boundary, metaPath);
}

/**
 * 取锁：有界等待 + 可取消。
 *
 * 失败语义：
 * - 超时 → `lock-timeout`（`detail` 带持锁者诊断）；
 * - 取消 → `cancelled`（等待期间取消立即生效，不会"等完这一次再抛"）。
 */
export async function acquireStorageLock(boundary: StorageBoundary, options: AcquireStorageLockOptions): Promise<StorageLockHandle> {
	// 时序参数在任何 IO 之前校验：非法参数不该建目录、不该产生锁等待。
	const timing = resolveLockTiming(options);
	const signals: Array<AbortSignal | undefined> = [options.signal, boundary.signal];

	throwIfAnyCancelled(signals);

	const relativeTarget = lockRelativeTarget(boundary, options.target);
	const key = lockNameFor(relativeTarget);
	const locksDir = boundary.resolve("locks");
	const lockDir = join(locksDir, key);
	const metaPath = join(lockDir, "owner.json");
	const ownerId = randomUUID();

	// 锁目录本身先就位：`mkdir`（非 recursive）要求父目录存在。
	await boundary.ensureDirectory(locksDir, options.signal);

	const deadline = Date.now() + timing.timeoutMs;
	let attempts = 0;
	let observed: LockDiagnostics | null = null;

	const release = async (): Promise<"released" | "not-owner" | "missing"> => {
		const current = await readLockMetaForCleanup(boundary, metaPath);
		// 元数据不可读 = 无法证明这是自己的锁 = 不删（宁可留下可诊断的残留）。
		if (current === null) return "missing";
		if (current.ownerId !== ownerId) return "not-owner";
		await boundary.beforeIo("lock-remove", lockDir);
		await rm(lockDir, { recursive: true, force: true });
		return "released";
	};

	while (true) {
		throwIfAnyCancelled(signals);
		attempts += 1;
		await boundary.beforeIo("lock-mkdir", lockDir);

		try {
			await mkdir(lockDir);
		} catch (error) {
			if (isAlreadyExistsError(error)) {
				// 已被持有：这是**唯一的**"拿不到"来源。下面只等待，不抢占。
				observed = await readLockMeta(boundary, metaPath);
			} else if (isNotFoundError(error)) {
				// 父目录在竞争中被删（持有者刚释放）：下一轮重试即可。
				observed = null;
			} else {
				throw mapFsError(error, "permission-denied", `无法创建锁目录：${lockDir}`, lockDir);
			}

			// 读诊断之后、判定超时之前**再查一次取消**：读取可能耗时（磁盘/杀毒扫描），
			// 期间用户取消 + 截止时间同时到达时，应当报"已取消"，而不是报一个看起来
			// 像"对方一直占着锁"的超时——那会把调用方的注意力引到错误的排查方向。
			throwIfAnyCancelled(signals);

			if (Date.now() >= deadline) {
				throw new StorageError("lock-timeout", `等待锁超时（${timing.timeoutMs}ms，尝试 ${attempts} 次）：${key}${describeLockHolder(observed)}`, {
					path: lockDir,
					detail: describeLockHolder(observed),
				});
			}

			// 等待量取 `pollMs` 与**剩余预算**的较小值：`pollMs` 是合法参数（只要求正整数），
			// 它完全可以大于 `timeoutMs`——直接睡足 `pollMs` 会让"我只等 10ms"变成实际
			// 等 1s，参数校验合法 ≠ 等待被限制在调用方给的预算内。
			// 这里 `Date.now() < deadline` 已成立，所以剩余量至少 1ms，不会退化成零间隔忙等。
			await delayWithCancellation(Math.min(timing.pollMs, deadline - Date.now()), signals);
			continue;
		}

		// 拿到锁：写元数据。写失败必须**放弃**刚拿到的锁，
		// 否则留下一个"无主锁"把所有人挡在外面（且违反"元数据必须可归属"）。
		try {
			await writeFile(metaPath, `${JSON.stringify({ ownerId, pid: process.pid, createdAt: timing.now, target: relativeTarget }, null, "\t")}\n`, { encoding: "utf8", flag: "wx" });
		} catch (error) {
			await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
			if (isStorageError(error)) throw error;
			throw mapFsError(error, "permission-denied", `无法写入锁元数据：${metaPath}`, metaPath);
		}

		return { key, path: lockDir, ownerId, attempts, release };
	}
}
