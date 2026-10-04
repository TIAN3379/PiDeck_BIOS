/**
 * **原始字节**的有界读取（BM-02D2）。
 *
 * 为什么单独一个模块：`boundary.ts` 的 `readJson` 把"读字节"和"解析 JSON"绑在一起，
 * 而离线导出要复制的是**原始字节**——对 payload 做一次 parse/stringify 往返，
 * 就等于把"备份"从"抄字节"变成"按我们的序列化习惯重写一遍"（键序、缩进、空白全变）。
 * 复制必须逐字节保真，所以这里只做"有界读字节"，不做任何解析。
 *
 * 与 `readJson` 同一套边界纪律：
 * - **读到 EOF 或上限+1**（不用 `stat.size` 决定停止位置）：文件在读取期间增长必须被发现；
 * - 每个 IO 等待点之后检查取消，`finally` 关闭句柄；
 * - 指纹按**实际读到的原始字节**计算（不是字符串口径），供调用方与磁盘字节同源比较。
 *
 * 它不重复实现路径/链接判定：调用方传入的 `assertNoSymlinks` 就是 boundary 里那一份。
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import type { StorageIoOperation } from "./commit.ts";
import { mapFsError, StorageError, throwIfAnyCancelled } from "./errors.ts";

/** 单次读取的分块大小（与 boundary 同一口径）：不为"上限+1"一次性分配缓冲。 */
const MAX_READ_CHUNK_BYTES = 64 * 1024;

export type BoundedByteRead = {
	/** 实际读到的原始字节（长度 === `total`）。 */
	readonly bytes: Buffer;
	readonly total: number;
	/** 这些**原始字节**的 SHA-256（小写十六进制）。 */
	readonly fingerprint: string;
};

/** 调用方（boundary）注入的最小运行时：取消信号、IO 钩子与链接判定。 */
export type ByteReadRuntime = {
	readonly signal: AbortSignal | undefined;
	readonly beforeIo: (operation: StorageIoOperation, target: string) => Promise<void>;
	readonly assertNoSymlinks: (absolutePath: string) => void;
};

/** 原始字节的 SHA-256（与 journal/audit/D1 的 hash 同口径：小写 64 位十六进制）。 */
export function bytesFingerprint(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 有界读取一个常规文件的**全部原始字节**。
 *
 * `maxBytes` 是硬上限：实际读到 `maxBytes + 1` 字节即判 `too-large`
 * （唯一允许的超限探测字节），不返回"看起来完整"的前缀。
 */
export async function readBytesBounded(runtime: ByteReadRuntime, absolutePath: string, maxBytes: number, callSignal?: AbortSignal): Promise<BoundedByteRead> {
	const signals = [callSignal, runtime.signal];
	throwIfAnyCancelled(signals);
	runtime.assertNoSymlinks(absolutePath);

	let handle;
	try {
		await runtime.beforeIo("open", absolutePath);
		handle = await open(absolutePath, "r");
	} catch (error) {
		throw mapFsError(error, "not-found", `无法打开文件：${absolutePath}`, absolutePath);
	}

	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new StorageError("not-a-file", `不是常规文件：${absolutePath}`, { path: absolutePath });
		// 提前拒绝明显超限；它**不是**最终判定（见下）。
		if (stats.size > maxBytes) throw new StorageError("too-large", `文件大小 ${stats.size} 字节超过上限 ${maxBytes}：${absolutePath}`, { path: absolutePath, detail: String(stats.size) });

		const chunks: Buffer[] = [];
		let total = 0;
		let reachedEof = false;
		while (total <= maxBytes) {
			throwIfAnyCancelled(signals);
			const readSize = Math.min(MAX_READ_CHUNK_BYTES, maxBytes + 1 - total);
			if (readSize <= 0) break;
			const buffer = Buffer.allocUnsafe(readSize);
			await runtime.beforeIo("read", absolutePath);
			const { bytesRead } = await handle.read(buffer, 0, readSize, total);
			if (bytesRead === 0) {
				reachedEof = true;
				break;
			}
			total += bytesRead;
			chunks.push(bytesRead === readSize ? buffer : buffer.subarray(0, bytesRead));
		}

		// 循环顶部只在有新迭代时检查：恰好一次读完（含空文件）走不到那里，必须在这里再查一次。
		throwIfAnyCancelled(signals);
		if (total > maxBytes) {
			throw new StorageError("too-large", `实际读取 ${total} 字节超过上限 ${maxBytes}（stat 报告 ${stats.size}，文件可能在读取期间增长）：${absolutePath}`, {
				path: absolutePath,
				detail: `read=${total} stat=${stats.size}`,
			});
		}
		if (!reachedEof) throw new StorageError("too-large", `未能读到文件末尾，拒绝把可能不完整的内容当成完整文件：${absolutePath}`, { path: absolutePath });

		const bytes = Buffer.concat(chunks, total);
		return { bytes, total, fingerprint: bytesFingerprint(bytes) };
	} finally {
		await handle.close().catch(() => undefined);
	}
}
