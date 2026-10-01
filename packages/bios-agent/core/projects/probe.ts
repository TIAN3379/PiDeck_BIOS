/**
 * 项目线索探测（最小只读实现）。
 *
 * 三条硬性设计（round1 R1 + round2 F3 + round3 G1）：
 * 1. **异步且真正可取消**：目录用 `opendir` 流式迭代，每个条目与每个让出点之后都检查取消。
 * 2. **句柄生命周期可靠**：成功拿到目录句柄后，**所有可能抛错的取消检查都在 try 内部**，
 *    保证任何抛错路径都会经过 `finally` 关闭句柄。取消检查若留在保护范围之外，
 *    句柄只能等 GC 兜底——频繁取消会积累未释放的目录句柄（round3 G1）。
 * 3. **有界**：路径预算、深度预算、待处理目录上限、warnings 上限；
 *    `opendir` 逐条产出，因此单层超大目录也不会在检查预算前先物化整个目录列表。
 *
 * 本轮不做的事：不读文件内容（因此没有内容预算问题，也不会把源码带进上下文）、
 * 不判定厂商／板卡／代际（需要 BM-03 的真实样例规则，先猜等于造假）。
 */
import { opendir } from "node:fs/promises";
import { join, relative } from "node:path";

/** BIOS 源码里常见的构建/描述文件扩展名，用作定位线索（不代表平台支持）。 */
export const BIOS_HINT_EXTENSIONS = [".inf", ".dec", ".dsc", ".fdf", ".asl"] as const;
export type BiosHintExtension = (typeof BIOS_HINT_EXTENSIONS)[number];

/**
 * 遍历预算（对齐 mvp_development_plan.md §7.1 的单次检测上限）。
 * 上限只是资源预算，不是正确性保证：达到上限必须报 incomplete。
 */
export type ScanLimits = {
	maxPaths: number;
	maxDepth: number;
};

export const DEFAULT_SCAN_LIMITS: ScanLimits = { maxPaths: 20_000, maxDepth: 12 };

/** 每种线索保留的样例路径数（结果只做定位线索，不需要全量列表）。 */
export const HINT_SAMPLE_LIMIT = 8;

/** 每处理多少个条目让出一次事件循环；同时是"取消生效"的最大延迟粒度之一。 */
export const DEFAULT_YIELD_EVERY = 200;

/** 待处理目录队列上限：避免宽目录树把路径预算之外的内存吃掉。 */
export const MAX_PENDING_DIRECTORIES = 5_000;

/** warnings 上限：一次权限问题不应刷满上下文。 */
export const MAX_PROBE_WARNINGS = 50;

/** 忽略目录：版本控制、依赖、产物与二进制目录不参与检测。 */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([".git", ".hg", ".svn", "node_modules", "out", "dist", "build", "Build", "bin", "obj", "__pycache__", "cache", ".cache"]);

/** 取消：调用方（扩展层）应让它冒泡成失败的 tool result，而不是普通成功结果。 */
export class ProbeCancelledError extends Error {
	readonly code = "cancelled";

	constructor(message = "项目检测已取消") {
		super(message);
		this.name = "ProbeCancelledError";
	}
}

/** 目录句柄（Node `fs/promises` 的 `Dir`）。 */
export type DirectoryHandle = Awaited<ReturnType<typeof opendir>>;

/** 打开目录的实现。默认是 `fs/promises` 的 `opendir`；可替换以便断言句柄生命周期。 */
export type OpenDirectory = (path: string) => Promise<DirectoryHandle>;

export type ProjectProbeWarning = {
	path: string;
	message: string;
};

export type ProjectProbeResult = {
	root: string;
	/** 实际访问的目录项数。 */
	scannedPaths: number;
	/** true 表示达到任一预算（含 warnings 上限），结果不完整。 */
	truncated: boolean;
	/** 达到的预算维度（可解释"为什么不完整"）。 */
	truncatedBy: Array<"paths" | "depth" | "pending-directories" | "warnings">;
	maxDepthReached: number;
	hintCounts: Record<BiosHintExtension, number>;
	hintSamples: Record<BiosHintExtension, string[]>;
	warnings: ProjectProbeWarning[];
	/** 因 warnings 上限被丢弃的告警条数（0 表示没有丢弃）。 */
	droppedWarnings: number;
	/** 因待处理目录上限被跳过的目录数。 */
	skippedDirectories: number;
};

export type ProbeOptions = {
	limits?: ScanLimits;
	/** 取消信号；在每个异步等待点之后检查，因此"开始后取消"能真正生效。 */
	signal?: AbortSignal;
	yieldEvery?: number;
	/** 目录打开实现（默认 `fs/promises.opendir`）；测试可用它断言句柄是否被关闭。 */
	openDirectory?: OpenDirectory;
};

function emptyHintRecord<T>(make: () => T): Record<BiosHintExtension, T> {
	return {
		".inf": make(),
		".dec": make(),
		".dsc": make(),
		".fdf": make(),
		".asl": make(),
	};
}

function matchHintExtension(name: string): BiosHintExtension | undefined {
	const lower = name.toLowerCase();
	return BIOS_HINT_EXTENSIONS.find((extension) => lower.endsWith(extension));
}

/** 让出事件循环：取消事件与其他 IO 只有在这里才有机会运行。 */
function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

export async function probeProjectDirectory(root: string, options: ProbeOptions = {}): Promise<ProjectProbeResult> {
	const limits = options.limits ?? DEFAULT_SCAN_LIMITS;
	const yieldEvery = Math.max(1, options.yieldEvery ?? DEFAULT_YIELD_EVERY);
	const signal = options.signal;
	const openDirectory = options.openDirectory ?? opendir;

	const hintCounts = emptyHintRecord(() => 0);
	const hintSamples = emptyHintRecord<string[]>(() => []);
	const warnings: ProjectProbeWarning[] = [];
	const truncatedBy: ProjectProbeResult["truncatedBy"] = [];

	let scannedPaths = 0;
	let entriesSinceYield = 0;
	let maxDepthReached = 0;
	let droppedWarnings = 0;
	let skippedDirectories = 0;

	const throwIfAborted = () => {
		if (signal?.aborted) throw new ProbeCancelledError();
	};
	const pushWarning = (path: string, message: string) => {
		if (warnings.length < MAX_PROBE_WARNINGS) {
			warnings.push({ path, message });
			return;
		}
		// 触达上限本身就是"结果不完整"的一种：既要计数，也要让 truncated 反映出来，
		// 不能让调用方以为"只有 50 个目录有问题"（round2 第 4 节建议 4）。
		droppedWarnings += 1;
		if (!truncatedBy.includes("warnings")) truncatedBy.push("warnings");
	};
	const markTruncated = (reason: (typeof truncatedBy)[number]) => {
		if (!truncatedBy.includes(reason)) truncatedBy.push(reason);
	};

	// 调用即取消（signal 已经是 aborted）也要失败，而不是跑完再返回。
	throwIfAborted();

	const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (stack.length > 0) {
		throwIfAborted();
		if (scannedPaths >= limits.maxPaths) {
			markTruncated("paths");
			break;
		}

		const current = stack.pop();
		if (!current) break;
		if (current.depth > maxDepthReached) maxDepthReached = current.depth;

		let dir: DirectoryHandle | undefined;
		try {
			dir = await openDirectory(current.dir);
		} catch (error) {
			// 打开失败时还没有句柄，按现有规则记录 warning 后继续（取消不被吞掉：
			// 取消是在成功拿到句柄之后才检查的，见下面 try 块）。
			pushWarning(current.dir, error instanceof Error ? error.message : String(error));
			continue;
		}

		try {
			// 句柄已打开：**所有**可能抛错的操作（含取消检查）都必须在这个 try 内，
			// 否则取消会绕过 finally，句柄只能等 GC 兜底（round3 G1）。
			// `await openDirectory` 也是异步等待点，取消可能刚好落在这里。
			throwIfAborted();

			// `opendir` 逐条产出：单层超大目录在命中预算时会立刻 break，
			// 不会先把整个目录的 Dirent 列表物化出来。
			for await (const entry of dir) {
				// 每个条目都检查：`for await` 的 next() 本身也是等待点，
				// 只靠批次检查会让小目录的取消漏网。
				throwIfAborted();

				if (scannedPaths >= limits.maxPaths) {
					markTruncated("paths");
					break;
				}
				scannedPaths += 1;

				entriesSinceYield += 1;
				if (entriesSinceYield >= yieldEvery) {
					entriesSinceYield = 0;
					await yieldToEventLoop();
					// 让出点之后立刻检查：这是"长扫描中途取消"能生效的关键位置。
					throwIfAborted();
				}

				// 符号链接一律不跟随：既避免环，也避免跳出目标目录。
				if (entry.isSymbolicLink()) continue;

				const absolute = join(current.dir, entry.name);
				if (entry.isDirectory()) {
					if (IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
					if (current.depth + 1 > limits.maxDepth) {
						markTruncated("depth");
						continue;
					}
					if (stack.length >= MAX_PENDING_DIRECTORIES) {
						markTruncated("pending-directories");
						skippedDirectories += 1;
						continue;
					}
					stack.push({ dir: absolute, depth: current.depth + 1 });
					continue;
				}
				if (!entry.isFile()) continue;

				const hint = matchHintExtension(entry.name);
				if (!hint) continue;
				hintCounts[hint] += 1;
				if (hintSamples[hint].length < HINT_SAMPLE_LIMIT) hintSamples[hint].push(relative(root, absolute));
			}
			// 循环正常读完也要检查：此时可能已经没有待处理目录，函数会直接走到返回。
			throwIfAborted();
		} finally {
			// `for await` 在 break / 抛错时也会关闭目录；这里兜底一次，
			// 重复关闭的错误忽略（只容错"已经关闭"这一类预期错误）。
			await dir.close().catch(() => undefined);
		}
	}

	// 最终结果返回前的最后一道检查：取消不能被包装成一次"成功的空结果"。
	throwIfAborted();

	return {
		root,
		scannedPaths,
		truncated: truncatedBy.length > 0,
		truncatedBy,
		maxDepthReached,
		hintCounts,
		hintSamples,
		warnings,
		droppedWarnings,
		skippedDirectories,
	};
}

/** 线索总数（0 表示在预算内没有可用的 BIOS 线索）。 */
export function totalHintCount(result: ProjectProbeResult): number {
	return BIOS_HINT_EXTENSIONS.reduce((sum, extension) => sum + result.hintCounts[extension], 0);
}
