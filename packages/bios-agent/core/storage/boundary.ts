/**
 * 真实 IO 边界：知识库所有读写都必须经过这里。
 *
 * 策略（bm02a_development_plan.md §3.3，**写清并可验证**）：
 *
 * 1. **知识根必须是完全限定绝对路径**，复用 `core/paths.ts` 的同一份判定；
 *    根自身允许经 realpath 解析（用户可能把库放在链接路径下），
 *    解析结果作为**canonicalRoot**，之后所有 IO 都基于它。
 * 2. **拒绝根内任何符号链接／junction**（含目录段与最终文件）。
 *    理由：逐段校验 + realpath 无法覆盖"校验与操作之间被换链"的竞态，
 *    而本轮的写入面极小（只初始化空库），选择"一律拒绝"比"跟随并比较"更容易验证。
 *    因此"根内 junction 指向根外"与"最终记录文件是链接"都会直接被拒绝。
 * 3. **先限字节再解析**：stat 之后仍按上限读取（文件可能在 stat 之后增长），
 *    读取上限 +1 字节用于检测增长；所有路径都关闭 FileHandle。
 * 4. **非覆盖发布**：写同目录临时文件 → `link()` 到目标（目标已存在则 EEXIST，不覆盖）；
 *    文件系统不支持硬链接时回退到 `O_EXCL`（`flag: "wx"`）直接创建。
 *    绝不做"先 exists 判断、再 writeFile"这种会被并发插空的写法。
 *
 * 信任假设与竞态（不夸大）：本模块检查的是**本进程**在操作时刻看到的路径状态；
 * 它不提供操作系统级沙箱，也不阻止同一台机器上的其他进程在检查与操作之间替换路径。
 * 生产写入面在 BM-02B 引入跨进程锁之前保持为"只创建初始文件"。
 */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, opendir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { requireFullyQualifiedRoot } from "../paths.ts";
import { isAlreadyExistsError, isLinkUnsupportedError, isNotFoundError, isStorageError, mapFsError, StorageError, throwIfCancelled } from "./errors.ts";
import { resolveStorageLimits, type StorageLimits } from "./limits.ts";

/** 知识根内的相对路径片段（不含分隔符与 `..`）。 */
export type StorageBoundaryOptions = {
	/** 知识根（完全限定绝对路径）。 */
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 初始化场景允许创建知识根本身；读取场景要求根已存在。 */
	createIfMissing?: boolean;
};

export type DirectoryEntryListing = {
	names: string[];
	/** true 表示达到条目上限，结果不完整。 */
	truncated: boolean;
	scanned: number;
};

export type StorageBoundary = {
	/** 规范化后的知识根（调用方传入值的规范化形式）。 */
	root: string;
	/** realpath 之后的真实知识根：根内链接判定的基线。 */
	canonicalRoot: string;
	limits: StorageLimits;
	/** 创建 boundary 时传入的取消信号（供复用方做长流程检查）。 */
	signal: AbortSignal | undefined;
	/** 把根内相对路径解析为绝对路径（词法约束：必须停在根内）。 */
	resolve(...segments: string[]): string;
	/** 拒绝根内符号链接（含最终文件）；不存在的尾部按已存在父链检查。 */
	assertNoSymlinks(absolutePath: string): void;
	ensureDirectory(absolutePath: string): Promise<void>;
	readJson(absolutePath: string, maxBytes?: number): Promise<{ value: unknown; bytes: number }>;
	publishJson(absolutePath: string, value: unknown): Promise<"created" | "exists">;
	listEntries(absolutePath: string, options?: { filesOnly?: boolean; maxEntries?: number }): Promise<DirectoryEntryListing>;
};

/** 从目标向上逐级检查，直到遇到第一个存在的路径段；存在段若是链接则拒绝。 */
function assertNoSymlinkAlongExistingPath(targetPath: string): void {
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

function isWithinRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	if (rel === "") return true;
	return !(isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`));
}

export async function createStorageBoundary(options: StorageBoundaryOptions): Promise<StorageBoundary> {
	const limits = resolveStorageLimits(options.limits);
	const signal = options.signal;
	const configuredRoot = requireFullyQualifiedRoot(options.root, "知识根");

	throwIfCancelled(signal);

	let canonicalRoot: string;
	try {
		const stats = statSync(configuredRoot);
		if (!stats.isDirectory()) throw new StorageError("invalid-root", `知识根不是目录：${configuredRoot}`, { path: configuredRoot });
		canonicalRoot = realpathSync(configuredRoot);
	} catch (error) {
		if (isStorageError(error)) throw error;
		if (!isNotFoundError(error)) throw mapFsError(error, "invalid-root", `无法访问知识根：${configuredRoot}`, configuredRoot);

		if (!options.createIfMissing) throw new StorageError("invalid-root", `知识根不存在：${configuredRoot}`, { path: configuredRoot });

		// 初始化：先确认已存在的父链里没有链接，再创建根目录。
		assertNoSymlinkAlongExistingPath(configuredRoot);
		try {
			await mkdir(configuredRoot, { recursive: true });
		} catch (mkdirError) {
			throw mapFsError(mkdirError, "permission-denied", `无法创建知识根：${configuredRoot}`, configuredRoot);
		}
		canonicalRoot = realpathSync(configuredRoot);
	}

	const resolve = (...segments: string[]): string => {
		const target = normalize(join(canonicalRoot, ...segments));
		if (!isWithinRoot(canonicalRoot, target)) {
			throw new StorageError("path-escape", `拒绝访问知识根之外的路径：${target}`, { path: target });
		}
		return target;
	};

	const assertNoSymlinks = (absolutePath: string): void => {
		if (!isWithinRoot(canonicalRoot, normalize(absolutePath))) {
			throw new StorageError("path-escape", `拒绝访问知识根之外的路径：${absolutePath}`, { path: absolutePath });
		}
		const rel = relative(canonicalRoot, absolutePath);
		if (rel === "") return;

		let current = canonicalRoot;
		for (const segment of rel.split(sep)) {
			current = join(current, segment);
			let stats;
			try {
				stats = lstatSync(current);
			} catch (error) {
				// 尾部不存在是正常情况（新记录）；已存在的父链已经检查过了。
				if (isNotFoundError(error)) return;
				throw mapFsError(error, "permission-denied", `无法检查路径：${current}`, current);
			}
			if (stats.isSymbolicLink()) throw new StorageError("symlink-rejected", `知识根内部不允许符号链接：${current}`, { path: current });
		}
	};

	const ensureDirectory = async (absolutePath: string): Promise<void> => {
		throwIfCancelled(signal);
		assertNoSymlinks(absolutePath);
		try {
			await mkdir(absolutePath, { recursive: true });
		} catch (error) {
			throw mapFsError(error, "permission-denied", `无法创建目录：${absolutePath}`, absolutePath);
		}
		// mkdir 之后再确认一次：目标可能是"本次运行期间被换成的链接"。
		const stats = await lstat(absolutePath);
		if (stats.isSymbolicLink()) throw new StorageError("symlink-rejected", `知识根内部不允许符号链接：${absolutePath}`, { path: absolutePath });
		if (!stats.isDirectory()) throw new StorageError("not-a-file", `路径存在但不是目录：${absolutePath}`, { path: absolutePath });
	};

	const readJson = async (absolutePath: string, maxBytes = limits.maxRecordBytes): Promise<{ value: unknown; bytes: number }> => {
		throwIfCancelled(signal);
		assertNoSymlinks(absolutePath);

		let handle;
		try {
			handle = await open(absolutePath, "r");
		} catch (error) {
			throw mapFsError(error, "not-found", `无法打开文件：${absolutePath}`, absolutePath);
		}

		try {
			const stats = await handle.stat();
			if (!stats.isFile()) throw new StorageError("not-a-file", `不是常规文件：${absolutePath}`, { path: absolutePath });
			if (stats.size > maxBytes) {
				throw new StorageError("too-large", `文件大小 ${stats.size} 字节超过上限 ${maxBytes}：${absolutePath}`, { path: absolutePath, detail: String(stats.size) });
			}

			// 上限 +1 字节：文件若在 stat 之后增长，会在这里被检出，而不是静默读一半。
			const capacity = Math.min(maxBytes, stats.size) + 1;
			const buffer = Buffer.allocUnsafe(capacity);
			let total = 0;
			while (total < capacity) {
				throwIfCancelled(signal);
				const { bytesRead } = await handle.read(buffer, total, capacity - total, total);
				if (bytesRead === 0) break;
				total += bytesRead;
			}
			if (total > maxBytes) {
				throw new StorageError("too-large", `实际读取 ${total} 字节超过上限 ${maxBytes}（文件可能仍在增长）：${absolutePath}`, { path: absolutePath, detail: String(total) });
			}

			const text = buffer.subarray(0, total).toString("utf8");
			if (text.length > limits.maxJsonChars) {
				throw new StorageError("too-large", `JSON 文本长度超过上限 ${limits.maxJsonChars}：${absolutePath}`, { path: absolutePath });
			}

			try {
				return { value: JSON.parse(text), bytes: total };
			} catch (error) {
				throw new StorageError("invalid-json", `JSON 解析失败：${absolutePath}`, {
					path: absolutePath,
					detail: error instanceof Error ? error.message : String(error),
					cause: error,
				});
			}
		} finally {
			await handle.close().catch(() => undefined);
		}
	};

	const publishJson = async (absolutePath: string, value: unknown): Promise<"created" | "exists"> => {
		throwIfCancelled(signal);
		assertNoSymlinks(absolutePath);

		const payload = `${JSON.stringify(value, null, "\t")}\n`;
		const tempPath = join(dirname(absolutePath), `.${basename(absolutePath)}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`);

		try {
			await writeFile(tempPath, payload, { encoding: "utf8", flag: "wx" });

			try {
				// 硬链接发布：目标已存在时失败（EEXIST），因此天然不会覆盖既有数据。
				await link(tempPath, absolutePath);
				return "created";
			} catch (error) {
				if (isAlreadyExistsError(error)) return "exists";
				if (!isLinkUnsupportedError(error)) throw mapFsError(error, "permission-denied", `无法发布文件：${absolutePath}`, absolutePath);

				// 回退：O_EXCL 直接创建目标（同样不覆盖）。
				try {
					await writeFile(absolutePath, payload, { encoding: "utf8", flag: "wx" });
					return "created";
				} catch (fallbackError) {
					if (isAlreadyExistsError(fallbackError)) return "exists";
					throw mapFsError(fallbackError, "permission-denied", `无法发布文件：${absolutePath}`, absolutePath);
				}
			}
		} finally {
			await rm(tempPath, { force: true }).catch(() => undefined);
		}
	};

	const listEntries = async (absolutePath: string, listOptions: { filesOnly?: boolean; maxEntries?: number } = {}): Promise<DirectoryEntryListing> => {
		throwIfCancelled(signal);
		assertNoSymlinks(absolutePath);

		const maxEntries = listOptions.maxEntries ?? limits.maxScanEntries;
		let directory;
		try {
			directory = await opendir(absolutePath);
		} catch (error) {
			throw mapFsError(error, "not-found", `无法打开目录：${absolutePath}`, absolutePath);
		}

		const names: string[] = [];
		let scanned = 0;
		let truncated = false;
		try {
			for await (const entry of directory) {
				throwIfCancelled(signal);
				scanned += 1;
				// 截断判定基于**扫描过的条目数**：被跳过的链接/子目录同样消耗扫描预算。
				if (scanned > maxEntries) {
					truncated = true;
					break;
				}
				if (entry.isSymbolicLink()) continue;
				if (listOptions.filesOnly && !entry.isFile()) continue;
				names.push(entry.name);
			}
		} finally {
			await directory.close().catch(() => undefined);
		}

		return { names, truncated, scanned };
	};

	return { root: configuredRoot, canonicalRoot, limits, signal, resolve, assertNoSymlinks, ensureDirectory, readJson, publishJson, listEntries };
}
