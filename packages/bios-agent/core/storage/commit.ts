/**
 * 单文件提交的**共用原语**（BM-02B / B3，BM-02BR / W3）。
 *
 * 这里只有两类东西：
 * 1. 与"文件系统怎么写一个文件才算提交"有关的纯逻辑（临时文件准备、替换重试、清理）；
 * 2. 提交失败时的**有界诊断**（既不能吞掉原错误，也不能把客户正文带进去）。
 *
 * 为什么单独成模块：`boundary.ts` 同时承担路径边界、有界读取、发布/替换与目录列举，
 * 已经接近"一个文件里塞了两个子系统"。把提交原语抽出来之后，
 * `boundary.ts` 只负责"能访问什么"，提交细节集中在这里。
 * 抽取时**保持导出兼容**：`delayWithCancellation` 仍从 `boundary.ts` 导出（见那里的 re-export），
 * 不改变任何调用方。
 *
 * 依赖方向是单向的：本模块只依赖 `node:*` 与 `errors.ts`；
 * `boundary.ts` 反过来依赖本模块。这样不会形成运行时循环。
 */

import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fsErrorCode, isCancelledError, mapFsError, StorageError, throwIfAnyCancelled } from "./errors.ts";

/** IO 操作类别：用于取消时序与故障注入的可观测性。 */
export type StorageIoOperation = "mkdir" | "open" | "stat" | "read" | "write-temp" | "sync" | "close-temp" | "link" | "rename" | "unlink-temp" | "opendir" | "lock-mkdir" | "lock-read" | "lock-remove" | "backup-write" | "remove-file";

/** 提交原语需要的最小上下文；由 `boundary.ts` 注入（含测试用的故障注入面）。 */
export type CommitContext = {
	/** 每个 IO 发起**之前**调用（可 await）。 */
	beforeIo(operation: StorageIoOperation, target: string): Promise<void>;
	/**
	 * 关闭临时文件句柄。
	 *
	 * 之所以做成可注入：`close` 失败是本轮新关闭的一条边界——
	 * "写完、sync 完，但句柄关闭失败"意味着这次提交不算成立，必须中止；
	 * 而真实 `close` 失败在本地磁盘上几乎无法稳定复现。
	 *
	 * `tempPath` 是第二个参数（BM-02C1 新增）：接入 journal 之后"本次提交的临时文件"
	 * 不再只有业务目标一种（还有 journal 自己的临时文件），注入方必须能按路径区分，
	 * 否则用例会打到 journal 的提交上而失去原意。既有实现忽略多余参数，保持兼容。
	 */
	closeFile(handle: FileHandle, tempPath: string): Promise<void>;
};

/** Windows 共享冲突（另一个进程正持有目标）导致的替换失败码。 */
const RETRYABLE_RENAME_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
/**
 * 替换重试预算（**标称值，非实测结论**）。
 *
 * 为什么比"重试几次固定退避"更宽松：Windows 上的 `EBUSY/EPERM` 不只来自协作锁——
 * 杀毒软件扫描刚创建的临时文件、并发读者正在读旧目标、索引服务持有目录项，
 * 都会让 `rename` 短暂失败。这里用"指数退避 + 延迟上限 + 总预算"：
 * 常态下仍是一次成功（零延迟），真发生争用时最多等 {@link RENAME_RETRY_TOTAL_MS}，且每一步都可被取消。
 *
 * 预算构成：延迟序列为 20/40/80/160/250/250/… 毫秒，前 {@link MAX_RENAME_ATTEMPTS} 次尝试的
 * 理论退避总和约 2.05s，小于 {@link RENAME_RETRY_TOTAL_MS}——因此**先触达的是尝试次数上限**，
 * 总预算只是兜底闸门（两者都是"有界放弃"的必要条件，不能只留一个）。
 * 真实的 Windows 共享冲突持续时间没有可控实验数据，故不以此为"偶发失败已被消除"的依据。
 */
const MAX_RENAME_ATTEMPTS = 12;
const RENAME_RETRY_BASE_MS = 20;
const RENAME_RETRY_MAX_DELAY_MS = 250;
const RENAME_RETRY_TOTAL_MS = 4_000;

/**
 * 可取消的定时等待。
 *
 * 为什么不用 `setTimeout` + `await` 裸写法：锁等待与替换重试都可能持续一段时间，
 * 期间用户取消必须立刻生效，而不是"等完这一轮退避再说"。
 */
export function delayWithCancellation(ms: number, signals: Array<AbortSignal | undefined>): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const listeners: Array<{ signal: AbortSignal; handler: () => void }> = [];
		const timer = setTimeout(() => {
			cleanup();
			resolve();
		}, ms);

		const cleanup = (): void => {
			clearTimeout(timer);
			for (const { signal, handler } of listeners) signal.removeEventListener("abort", handler);
		};

		const handler = (): void => {
			cleanup();
			reject(new StorageError("cancelled", "存储操作已取消"));
		};

		for (const signal of signals) {
			if (!signal) continue;
			if (signal.aborted) {
				cleanup();
				reject(new StorageError("cancelled", "存储操作已取消"));
				return;
			}
			signal.addEventListener("abort", handler);
			listeners.push({ signal, handler });
		}
	});
}

/** 与读取路径完全一致的序列化形式（缩进制表符 + 结尾换行），保证"写进去的字节"可预期。 */
export function serializeJsonPayload(value: unknown): string {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/**
 * 提交前按**实际**序列化结果检查上限（BM-02B / B3）。
 *
 * 为什么不"序列化前估算"：中文、代理对、JSON 转义都会让实际字节数与
 * `JSON.stringify(...).length` 之外的东西产生偏差；估算偏小就会把超限内容写进去，
 * 之后任何有界读取都会拿 `too-large` 拒绝自己刚写的文件。
 */
export function assertPayloadWithinLimits(absolutePath: string, payload: string, maxBytes: number, maxJsonChars: number): number {
	const bytes = Buffer.byteLength(payload, "utf8");
	if (bytes > maxBytes) {
		throw new StorageError("too-large", `待写入内容 ${bytes} 字节超过上限 ${maxBytes}：${absolutePath}`, { path: absolutePath, detail: `bytes=${bytes}` });
	}
	if (payload.length > maxJsonChars) {
		throw new StorageError("too-large", `待写入文本长度 ${payload.length} 超过上限 ${maxJsonChars}：${absolutePath}`, { path: absolutePath, detail: `chars=${payload.length}` });
	}
	return bytes;
}

/** 同目录临时文件路径：与目标同目录才能保证 `rename`/`link` 不跨卷。 */
export function buildTempPath(absolutePath: string): string {
	return join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);
}

/**
 * 把**完整内容**写进同目录临时文件：`open(wx)` → `writeFile` → `sync` → `close`。
 *
 * 关于 `finally` 里的第二次 close，这是本轮（W3）明确区分开的两件事：
 * - **正常路径的 close 属于提交本身**：它失败说明句柄状态未知，必须中止这次提交
 *   （否则可能提交一个"数据还在页缓存、句柄未释放"的文件）；
 * - **异常路径的 close 是尽力而为**：此时已有错误在传播，close 再失败**不能覆盖**它。
 * 但无论哪条路径都要**显式**关闭：依赖 GC 去终结 `FileHandle`，
 * 意味着在诊断输出结束前目标/临时文件还可能被本进程持有，
 * 后续的清理与替换会以"莫名其妙失败"的形式呈现。
 */
export async function prepareTempFile(tempPath: string, payload: string, context: CommitContext): Promise<void> {
	let handle: FileHandle | undefined;
	let closed = false;
	try {
		await context.beforeIo("write-temp", tempPath);
		handle = await open(tempPath, "wx");
		// `wx` 保证这是**本次运行**新建的临时文件，不会覆盖别人的。
		await handle.writeFile(payload, { encoding: "utf8" });
		// 先落盘再替换：否则崩溃/断电后读者可能拿到"存在但内容为空"的目标。
		await context.beforeIo("sync", tempPath);
		await handle.sync();
		// 正常路径的 close：失败即本次提交失败（见上方注释）。
		await context.beforeIo("close-temp", tempPath);
		await context.closeFile(handle, tempPath);
		closed = true;
	} catch (error) {
		// 取消必须穿透普通 FS 错误包装（否则 abort 会被改写成 permission-denied）。
		if (isCancelledError(error)) throw error;
		throw mapFsError(error, "permission-denied", `无法写入提交临时文件：${tempPath}`, tempPath);
	} finally {
		if (handle && !closed) await context.closeFile(handle, tempPath).catch(() => undefined);
	}
}

/**
 * 删除临时文件。
 *
 * 返回 `false`（清理失败）而不是抛错：调用方需要按"原错误是否在传播"区别处理——
 * 成功提交后清理失败只是残留一个临时文件（**不能**报成提交失败）；
 * 失败路径上的清理失败才有必要作为诊断附加到原错误上。
 */
export async function removeTempFile(tempPath: string, context: CommitContext): Promise<boolean> {
	try {
		await context.beforeIo("unlink-temp", tempPath);
		await rm(tempPath, { force: true });
		return true;
	} catch {
		return false;
	}
}

/**
 * 有界、可取消的替换重试（BM-02B / B3）。
 *
 * 只重试"目标被另一个进程短暂持有"这一类（共享冲突）；**不**回退成"先删后写"——
 * 那会让目标在一瞬间不存在，把"原子替换"降级成"可能丢数据的两步操作"。
 */
export async function renameWithRetry(from: string, to: string, signals: Array<AbortSignal | undefined>, context: CommitContext): Promise<number> {
	const startedAt = Date.now();
	let attempts = 1;
	while (true) {
		throwIfAnyCancelled(signals);
		try {
			await context.beforeIo("rename", to);
			// 等待点之后、真正发起提交 IO 之前再查一次取消（B0 规则）：
			// `beforeIo` 是可 await 的等待钩子，期间 abort 必须拦在 `rename` 之前。
			throwIfAnyCancelled(signals);
			await rename(from, to);
			return attempts;
		} catch (error) {
			if (isCancelledError(error)) throw error;
			const code = fsErrorCode(error);
			const budgetLeft = Date.now() - startedAt < RENAME_RETRY_TOTAL_MS;
			if (attempts >= MAX_RENAME_ATTEMPTS || !budgetLeft || code === undefined || !RETRYABLE_RENAME_CODES.has(code)) {
				throw mapFsError(error, "permission-denied", `无法原子替换文件：${to}`, to);
			}
			attempts += 1;
			const delay = Math.min(RENAME_RETRY_BASE_MS * 2 ** (attempts - 2), RENAME_RETRY_MAX_DELAY_MS);
			await delayWithCancellation(delay, signals);
		}
	}
}

/**
 * 把"有界清理诊断"附加到正在传播的错误上。
 *
 * 为什么重建而不是原地改字段：字段是 `readonly` 的，原地写入只在运行时"碰巧"有效，
 * 会让类型与行为不一致。重建时逐一搬运全部字段（含 `cause` 引用），
 * 只把一句**固定文案**追加到消息末尾——不放路径以外的任何内容，更不放正文。
 */
export function attachCleanupNote(error: unknown, note: string): unknown {
	if (!(error instanceof StorageError)) return error;
	return new StorageError(error.code, `${error.message}（${note}）`, {
		path: error.path,
		detail: error.detail,
		conflicts: error.conflicts,
		expected: error.expected,
		actual: error.actual,
		cause: error.cause,
	});
}

/** 清理失败的固定诊断文案（写进错误消息或结果警告，二者共用）。 */
export const CLEANUP_FAILED_NOTE = "临时文件清理失败，原错误优先；请人工清理同目录下的 .tmp 残留";

/**
 * 带着"临时文件清理失败"的错误集合（C2BR2 / F2）。
 *
 * 为什么不是再往消息里加一个标记字符串：消息是给人、日志和外部文案看的，会被改写、会被翻译、
 * 也会被别处拼装；调用方（审核工件）需要的是一个**结构化、不可伪造**的事实：
 * "这个正在传播的错误里，有一次临时文件没删掉"。
 *
 * WeakSet 恰好只表达这件事，而且：
 * - 不改变 `StorageError` 的外形（不新增可枚举字段，不会被序列化进任何落盘内容）；
 * - 不阻止错误被回收（WeakSet 不持有强引用）；
 * - 与原错误码、原 `detail`、原 `cause` 完全解耦——调用方仍然按**首错**处理。
 */
const cleanupFailureErrors = new WeakSet<object>();

/**
 * 把"临时文件清理失败"附加到正在传播的错误上（文案 + 结构标记）。
 *
 * 与 {@link attachCleanupNote} 的区别：后者是通用的"追加一句说明"，
 * 本函数专门表示清理失败，因而可以被动词的提取器（`cleanupFailureFromError`）可靠识别。
 * 原错误码/`detail`/`cause` 全部保留，只是消息末尾多一句有界说明。
 */
export function attachCleanupFailureNote(error: unknown, note: string = CLEANUP_FAILED_NOTE): unknown {
	const attached = attachCleanupNote(error, note);
	if (attached instanceof StorageError) cleanupFailureErrors.add(attached);
	return attached;
}

/** 读取结构标记：这个错误是否带着"临时文件清理失败"（不比对文案）。 */
export function hasCleanupFailureMark(error: unknown): boolean {
	return typeof error === "object" && error !== null && cleanupFailureErrors.has(error);
}

/**
 * 序列化载荷的 SHA-256（BM-02C1）。
 *
 * 为什么直接对**将要写下去的字符串**取哈希：journal 的 `after.hash` 必须与
 * "实际提交的那份字节"逐字节一致。若改成"读回 JSON 再 `stringify` 重算"，
 * 缩进/换行/键序的差异会让哈希与磁盘内容脱钩，恢复时就会把"其实是新值"判成"与前后都不一致"。
 */
export function payloadFingerprint(payload: string): string {
	return createHash("sha256").update(Buffer.from(payload, "utf8")).digest("hex");
}
