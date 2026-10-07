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
 * 4. **非覆盖发布，且不暴露半成品**（BM-02AR / S1）：写同目录临时文件 → `link()` 到目标
 *    （目标已存在则 EEXIST，不覆盖）。**没有回退路径**：硬链接不可用或权限不足时
 *    抛 `publish-unsupported` / `permission-denied`，目标保持不存在。
 *    为什么删掉原来的 `O_EXCL` 回退：`writeFile(target, { flag: "wx" })` 只保证"不覆盖"，
 *    它的"创建"与"写入"之间目标已可见——并发读者会读到 0 字节或半截 JSON，
 *    写进程此刻退出还会把半成品永久留在知识库里。也无法靠"先 exists 再 writeFile"补救（会被并发插空）。
 *    硬链接发布则是原子的：读者只可能看到 ENOENT 或完整文件。
 *
 * 5. **取消必须真实生效**（BM-02B / B0）：`callSignal` 与 boundary 自身信号任一取消，
 *    都在"提交 IO 发起之前"拦住本次发布；提交 IO 成功即提交点，之后迟到的取消
 *    只返回真实状态，不撤销已提交内容、也不假称回滚。
 *
 * 信任假设与竞态（不夸大）：本模块检查的是**本进程**在操作时刻看到的路径状态；
 * 它不提供操作系统级沙箱，也不阻止同一台机器上的其他进程在检查与操作之间替换路径。
 * 跨进程互斥由 `lock.ts` 提供的**协作式**锁负责（BM-02B）：只约束遵守同一协议的本地进程，
 * 不保证绕过协议的编辑器/其它进程，也不承诺未经验证的网络盘语义。
 */
import { lstatSync, realpathSync, statSync } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { dirname, join, normalize, relative, sep } from "node:path";
import { requireFullyQualifiedRoot } from "../paths.ts";
import { type CommitContext, type StorageIoOperation, assertPayloadWithinLimits, attachCleanupFailureNote, buildTempPath, delayWithCancellation, payloadFingerprint, prepareTempFile, removeTempFile, renameWithRetry, serializeJsonPayload } from "./commit.ts";
import type { DirectoryEntryListing, ListEntriesOptions } from "./directoryListing.ts";
import { readBytesBounded, type BoundedByteRead } from "./readBytes.ts";
import { classifyLinkFailure, fsErrorCode, isCancelledError, isNotFoundError, isStorageError, mapFsError, StorageError, throwIfAnyCancelled, throwIfCancelled } from "./errors.ts";
import { resolveStorageLimits, type StorageLimits } from "./limits.ts";
import { assertNoSymlinkAlongExistingPath, describeJsonParseFailure, isWithinRoot } from "./pathBoundary.ts";

export type { StorageIoOperation };
// 有界列举的输入/输出契约在 `directoryListing.ts`：这里原样再导出，既有调用方的 import 不变。
export type { DirectoryEntryListing, ListEntriesOptions } from "./directoryListing.ts";
/** 兼容既有导入（`lock.ts` 与下层测试从本模块取这个工具）。 */
export { delayWithCancellation };

/**
 * 受控 IO 故障注入（**仅供测试**；不传时完全走真实 `node:fs`）。
 *
 * 为什么需要注入面：本轮要关闭的边界都发生在**两次 await 之间**——
 * "不支持硬链接时不创建目标""stat 之后文件增长不解析合法前缀""取消发生在 IO 等待期间"。
 * 靠真实磁盘时序去碰这些窗口是碰运气的测试，而收尾文档明确要求
 * "测试时序明确且有超时，不靠碰运气"。这里的注入面不改变生产默认路径：
 * 不传 hooks 时，`link` 与 `stat` 就是 `node:fs/promises` 的真实实现。
 */
export type StorageIoHooks = {
	/** 在每个 IO 操作发起**之前**调用，可 await。测试用它把"等待期间取消"变成确定时序。 */
	beforeIo?: (operation: StorageIoOperation, target: string) => Promise<void> | void;
	/** 替换发布第二步的 `link`（默认 `node:fs/promises.link`），用于注入 ENOSYS/EPERM 等发布失败。 */
	link?: (existingPath: string, newPath: string) => Promise<void>;
	/** 替换预检 `stat`（默认真实 `FileHandle.stat`），用于复现"stat 给出的大小已经过期"。 */
	stat?: (handle: FileHandle) => Promise<{ isFile(): boolean; size: number }>;
	/**
	 * 替换临时文件句柄的 `close`（默认 `handle.close()`）。
	 *
	 * 为什么需要这个注入点：本轮要关闭的边界之一是"准备阶段的 close 失败**必须**中止提交"
	 * （见 `commit.ts` 的 `prepareTempFile`）。真实 `close` 失败在本地磁盘上无法稳定复现，
	 * 而"实际先关后抛"正是最常见的形态（文件描述符已释放，但驱动/杀毒软件返回了错误）。
	 */
	closeFile?: (handle: FileHandle) => Promise<void>;
};

export type StorageBoundaryOptions = {
	/** 知识根（完全限定绝对路径）。 */
	root: string;
	limits?: Partial<StorageLimits>;
	signal?: AbortSignal;
	/** 初始化场景允许创建知识根本身；读取场景要求根已存在。 */
	createIfMissing?: boolean;
	/** 受控 IO 故障注入（仅测试）。 */
	ioHooks?: StorageIoHooks;
};

export type ReplaceJsonResult = {
	/** 实际写入目标的 UTF-8 字节数（按序列化结果计量，不是估算）。 */
	bytes: number;
	/**
	 * 临时文件清理结果。
	 *
	 * 为什么要把"清理失败"当成结果而不是异常：`rename` 成功即**提交点**，
	 * 此时内容已经生效，把"没删掉临时文件"升级成调用方失败会让人以为没写进去，
	 * 反而诱发重复写入。这里如实报告，由上层决定是否清理。
	 */
	cleanup: "ok" | "failed";
	/** 提交前经历的 `rename` 重试次数（Windows 共享冲突诊断用）。 */
	renameAttempts: number;
	/**
	 * 本次实际写下去的那份字节的 SHA-256（BM-02C1）。
	 *
	 * 为什么由提交原语返回而不是上层自己算：journal 的 `after.hash` 要对应**实际提交**的字节，
	 * 上层再序列化一次只是在"相信两次序列化结果相同"；这里直接给事实。
	 */
	fingerprint: string;
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
	/** 创建目录；`callSignal` 与 boundary 自身信号任一取消都立即失败。 */
	ensureDirectory(absolutePath: string, callSignal?: AbortSignal): Promise<void>;
	/**
	 * 有界读取 + 解析 JSON；`callSignal` 与 boundary 自身信号任一取消都立即失败
	 * （显式传入的信号更接近用户意图，但不会因此放行另一个已取消的信号）。
	 */
	readJson(absolutePath: string, maxBytes?: number, callSignal?: AbortSignal): Promise<{ value: unknown; bytes: number; fingerprint: string }>;
	/**
	 * **原始字节**的有界读取（BM-02D2）：只给"逐字节保真地复制文件"用，不做任何解析。
	 *
	 * 为什么不复用 `readJson`：离线导出必须原样抄字节，parse/stringify 往返会改写键序、
	 * 缩进与空白——那已经不是在备份"这些字节"了。上限语义与 `readJson` 相同
	 * （读到 EOF 或上限+1，增长会被发现），指纹按原始字节计算。
	 */
	readRawBytes(absolutePath: string, maxBytes?: number, callSignal?: AbortSignal): Promise<BoundedByteRead>;
	/**
	 * `readJson` 的**清理专用**变体：忽略一切取消信号。
	 *
	 * 只给"撤销本次调用自己创建的状态"用（目前只有锁释放）。锁没有回收器，
	 * 清理若可被取消，一次取消就会留下永久锁。读取类/写入类操作**不得**用它。
	 */
	readJsonForCleanup(absolutePath: string, maxBytes?: number): Promise<{ value: unknown; bytes: number; fingerprint: string }>;
	/**
	 * 非覆盖发布：同目录完整临时文件 → `link()` → 删临时文件。
	 *
	 * `callSignal` 与 boundary 自身信号**任一**取消都在提交 IO 发起之前生效
	 * （第五轮验收 §4：旧实现声明了这个参数却没有接收，只检查 boundary 自己的 signal）。
	 * 提交 IO 一旦成功即提交点，之后迟到的取消只报告真实状态，不撤销已提交内容。
	 *
	 * 准备阶段是**完整 + 受预算**的：序列化后按实际 UTF-8 字节数与字符数判定 `maxBytes`
	 * （默认记录上限），超限时连临时文件都不会创建；随后 `sync` + `close`
	 * 都在 `link` 之前完成（W3）。
	 */
	publishJson(absolutePath: string, value: unknown, callSignal?: AbortSignal, maxBytes?: number): Promise<"created" | "exists">;
	/**
	 * 与 `publishJson` 同一实现，但额外返回可观测结果。
	 *
	 * 为什么不做成独立实现：记录写入要如实上报"写入字节数"和"临时文件清理结果"，
	 * 而在上层重复序列化一遍只为拿字节数纯属浪费，更糟的是它可能与真正写下去的内容不一致。
	 */
	publishJsonMeasured(absolutePath: string, value: unknown, options?: { callSignal?: AbortSignal; maxBytes?: number }): Promise<{ status: "created" | "exists"; bytes: number; cleanup: "ok" | "failed"; fingerprint: string }>;
	/**
	 * 原子**替换**已有文件的完整内容（BM-02B / B3）：
	 * 同目录临时文件（`wx`）→ 写完整内容 → `sync()` → `close()` → `rename()` 到目标。
	 *
	 * 与 `publishJson` 的分工：`publishJson` 用于"目标必须不存在"的创建（硬链接天然不覆盖），
	 * 这里是"目标必须已被持有者读过并校验过"的更新（rename 是替换语义）。
	 * 提交前按**实际** UTF-8 字节数与字符数检查上限，不用序列化前估算。
	 */
	replaceJson(absolutePath: string, value: unknown, options?: { maxBytes?: number; callSignal?: AbortSignal }): Promise<ReplaceJsonResult>;
	/**
	 * 受控 IO 时序/故障注入的统一入口（**仅测试**传入 hooks 时才有效）。
	 *
	 * 暴露出来是为了让 `lock.ts` 也能在自己的 IO 等待点前后参与同一套确定性时序，
	 * 而不必各自复制一份 hook 传递链。
	 */
	beforeIo(operation: StorageIoOperation, target: string): Promise<void>;
	/**
	 * 目标**本身**是否存在（`lstat`，不跟随链接、不读取内容）。
	 *
	 * 为什么要有单独的探测而不是复用 `readJson` + 捕获 `not-found`：
	 * "文件不存在"和"文件存在但读不动/是链接"是两种不同的结论，
	 * 用读取失败来推断存在性会把后者误判成前者（写入前会据此以为可以新建）。
	 */
	pathExists(absolutePath: string, callSignal?: AbortSignal): Promise<boolean>;
	listEntries(absolutePath: string, options?: ListEntriesOptions): Promise<DirectoryEntryListing>;
	/**
	 * 删除根内**单个普通文件**（不递归、不跟随链接）。
	 *
	 * 为什么需要：附属工作记录（检查点）需要有界磁盘管理——被轮换出近期集合的记录必须能清理，
	 * 但清理不能变成"用 `rm -rf` 绕过边界"。三条约束：
	 * - 路径必须先经 `resolve()`（词法停在根内）与 `assertNoSymlinks()`；
	 * - `lstat` 必须是普通文件（目录/链接一律拒绝）；
	 * - 只 `unlink` 该文件，不动任何目录。
	 */
	removeFile(absolutePath: string, callSignal?: AbortSignal): Promise<void>;
};

/** 单次读取的分块大小：不为"上限+1"一次性分配缓冲（BM-02AR / AR-2）。 */
const MAX_READ_CHUNK_BYTES = 64 * 1024;

// 路径/链接的**纯判定**在 `pathBoundary.ts`（本模块只负责"怎么有界地读写"）。
// `describeJsonParseFailure` 仍从这里对外导出，保持既有公共 API 不变。
export { describeJsonParseFailure } from "./pathBoundary.ts";

export async function createStorageBoundary(options: StorageBoundaryOptions): Promise<StorageBoundary> {
	const limits = resolveStorageLimits(options.limits);
	const signal = options.signal;
	const ioHooks = options.ioHooks;
	const statHandle = ioHooks?.stat ?? ((handle: FileHandle) => handle.stat());

	/**
	 * 每个 IO 操作发起前调用一次。
	 *
	 * 这也是"取消发生在等待期间"的确定性复现点：测试可以在真实操作发起前 abort，
	 * 于是操作返回后的取消检查**必然**看到 aborted——不依赖机器快慢。
	 */
	const beforeIo = async (operation: StorageIoOperation, target: string): Promise<void> => {
		if (ioHooks?.beforeIo) await ioHooks.beforeIo(operation, target);
	};

	/** 提交原语需要的上下文：把时序钩子与句柄关闭策略一起交给 `commit.ts`。 */
	const commitContext: CommitContext = {
		beforeIo,
		closeFile: ioHooks?.closeFile ?? ((handle: FileHandle) => handle.close()),
	};

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

	const ensureDirectory = async (absolutePath: string, callSignal?: AbortSignal): Promise<void> => {
		throwIfAnyCancelled([callSignal, signal]);
		assertNoSymlinks(absolutePath);
		await beforeIo("mkdir", absolutePath);
		try {
			await mkdir(absolutePath, { recursive: true });
		} catch (error) {
			throw mapFsError(error, "permission-denied", `无法创建目录：${absolutePath}`, absolutePath);
		}
		// mkdir 是 IO 等待点：等待期间取消必须生效，不能"建完目录再返回成功"（BM-02AR / S3）。
		throwIfAnyCancelled([callSignal, signal]);
		// mkdir 之后再确认一次：目标可能是"本次运行期间被换成的链接"。
		const stats = await lstat(absolutePath);
		if (stats.isSymbolicLink()) throw new StorageError("symlink-rejected", `知识根内部不允许符号链接：${absolutePath}`, { path: absolutePath });
		if (!stats.isDirectory()) throw new StorageError("not-a-file", `路径存在但不是目录：${absolutePath}`, { path: absolutePath });
	};

	const readJsonWith = async (absolutePath: string, maxBytes: number, signals: Array<AbortSignal | undefined>): Promise<{ value: unknown; bytes: number; fingerprint: string }> => {
		throwIfAnyCancelled(signals);
		assertNoSymlinks(absolutePath);

		let handle;
		/** 实际读到字节的 SHA-256；在解析之前赋值，因此解析失败时不会用到它。 */
		let fingerprint: string;
		try {
			await beforeIo("open", absolutePath);
			handle = await open(absolutePath, "r");
		} catch (error) {
			throw mapFsError(error, "not-found", `无法打开文件：${absolutePath}`, absolutePath);
		}

		try {
			// open 也是 IO 等待点：等待期间取消必须生效（第四轮 S3 的实际缺口就是"等待之后没再检查"）。
			throwIfAnyCancelled(signals);

			await beforeIo("stat", absolutePath);
			// 预检用的 stat 可被注入替换：用于复现"stat 给的大小已经过期（文件之后增长）"。
			const stats = await statHandle(handle);
			if (!stats.isFile()) throw new StorageError("not-a-file", `不是常规文件：${absolutePath}`, { path: absolutePath });
			// 快速预检：明显超限的文件不必读。它**不是**最终长度判定（见下）。
			if (stats.size > maxBytes) {
				throw new StorageError("too-large", `文件大小 ${stats.size} 字节超过上限 ${maxBytes}：${absolutePath}`, { path: absolutePath, detail: String(stats.size) });
			}

			// 读到 **EOF 或上限+1**（BM-02AR / S3）：不允许用 stat.size 决定停止位置。
			// 旧写法 `min(maxBytes, stat.size) + 1` 在"stat 报 2 字节、文件实际 1003 字节"时
			// 只读 3 字节，拿到的恰好是合法前缀（`{} `）并被解析成功——既漏掉超限，也漏掉后部垃圾。
			// 注意：每轮都新建缓冲，不复用同一个 buffer，否则 Buffer.concat 会读到被覆盖的内容。
			const chunks: Buffer[] = [];
			let total = 0;
			let reachedEof = false;
			while (total <= maxBytes) {
				throwIfAnyCancelled(signals);
				const readSize = Math.min(MAX_READ_CHUNK_BYTES, maxBytes + 1 - total);
				if (readSize <= 0) break;
				const buffer = Buffer.allocUnsafe(readSize);
				await beforeIo("read", absolutePath);
				const { bytesRead } = await handle.read(buffer, 0, readSize, total);
				if (bytesRead === 0) {
					reachedEof = true;
					break;
				}
				total += bytesRead;
				chunks.push(bytesRead === readSize ? buffer : buffer.subarray(0, bytesRead));
			}

			// 迭代结束（尤其"最后一次 read 直接返回 EOF"）后、进入解析之前必须再检查一次取消：
			// 循环顶部只在有新迭代时检查，文件恰好一次读完就走不到那里，
			// 旧实现因此让"EOF 时 abort"变成了一次成功返回（BM-02AR / S3）。
			throwIfAnyCancelled(signals);

			if (total > maxBytes) {
				throw new StorageError("too-large", `实际读取 ${total} 字节超过上限 ${maxBytes}（stat 报告 ${stats.size}，文件可能在读取期间增长）：${absolutePath}`, {
					path: absolutePath,
					detail: `read=${total} stat=${stats.size}`,
				});
			}
			if (!reachedEof) {
				// 防御：循环退出条件已保证"要么 EOF、要么超限"。走到这里说明读取被意外中断，
				// 此时绝不能按"看起来合法"解析。
				throw new StorageError("too-large", `未能读到文件末尾，拒绝解析可能不完整的内容：${absolutePath}`, { path: absolutePath });
			}

			const text = Buffer.concat(chunks, total).toString("utf8");
			if (text.length > limits.maxJsonChars) {
				throw new StorageError("too-large", `JSON 文本长度超过上限 ${limits.maxJsonChars}：${absolutePath}`, { path: absolutePath });
			}
			// fingerprint 取**实际读到的磁盘字节**（BM-02C1）：journal 的 `before.hash` 必须能
			// 代表"这文件当时就是这些字节"，而不是"按我们的序列化习惯重算出来的值"。
			fingerprint = payloadFingerprint(text);

			try {
				return { value: JSON.parse(text), bytes: total, fingerprint };
			} catch (error) {
				// 不传 cause：原始 SyntaxError 的 message 携带输入片段（可能是客户正文）。
				throw new StorageError("invalid-json", `JSON 解析失败：${absolutePath}`, {
					path: absolutePath,
					detail: describeJsonParseFailure(error),
				});
			}
		} finally {
			await handle.close().catch(() => undefined);
		}
	};

	const readJson = (absolutePath: string, maxBytes = limits.maxRecordBytes, callSignal?: AbortSignal) => readJsonWith(absolutePath, maxBytes, [callSignal, signal]);

	/**
	 * `readJson` 的**清理专用**变体：忽略所有取消信号。
	 *
	 * 为什么必须存在：`release()` 是"删掉本次调用自己创建的锁"的清理动作，
	 * 而锁**没有回收器**（遗留锁只能人工处理）。若清理也受调用方取消影响，
	 * 一次正常的"用户取消了写入"就会变成"这个目标此后永远写不进去"。
	 * 与之相对，`publishJson` / `replaceJson` 的取消**必须**生效——那些是**新增**状态。
	 */
	const readJsonForCleanup = (absolutePath: string, maxBytes = limits.maxRecordBytes) => readJsonWith(absolutePath, maxBytes, []);

	/** 原始字节读取（BM-02D2）：分块循环在 `readBytes.ts`，这里只注入取消/钩子/链接判定。 */
	const readRawBytes = (absolutePath: string, maxBytes = limits.maxRecordBytes, callSignal?: AbortSignal): Promise<BoundedByteRead> => readBytesBounded({ signal, beforeIo, assertNoSymlinks }, absolutePath, maxBytes, callSignal);

	const publishJsonMeasured = async (absolutePath: string, value: unknown, publishOptions: { callSignal?: AbortSignal; maxBytes?: number } = {}): Promise<{ status: "created" | "exists"; bytes: number; cleanup: "ok" | "failed"; fingerprint: string }> => {
		const callSignal = publishOptions.callSignal;
		const maxBytes = publishOptions.maxBytes ?? limits.maxRecordBytes;

		// 入口检查（B0）：调用方 signal 必须真实生效。旧实现签名里没有 callSignal，
		// 于是"用户已取消"在发布路径上被完全忽略（第五轮验收 §4 的 P2）。
		throwIfAnyCancelled([callSignal, signal]);
		assertNoSymlinks(absolutePath);

		const payload = serializeJsonPayload(value);
		// 预算判定放在**创建临时文件之前**：超限时连临时文件都不该出现（W3 的"完整、受预算"）。
		const bytes = assertPayloadWithinLimits(absolutePath, payload, maxBytes, limits.maxJsonChars);
		// 提交原语返回"这次真正写下去的字节"的哈希，供 journal 记录 after fingerprint（BM-02C1）。
		const fingerprint = payloadFingerprint(payload);

		const tempPath = buildTempPath(absolutePath);
		let status: "created" | "exists" = "created";
		let failure: unknown;

		try {
			// 第一步：完整内容 + `sync` + **正常路径 close**（失败即中止本次发布）。
			// 此时目标路径仍然不存在，并发读者看不到任何东西（这正是"不暴露半成品"的关键）。
			await prepareTempFile(tempPath, payload, commitContext);

			// 临时写等待结束后复查：此刻目标仍未创建，取消 = 干净失败（清理本次临时文件）。
			throwIfAnyCancelled([callSignal, signal]);

			// 第二步：硬链接发布。目标已存在时失败（EEXIST），因此天然不会覆盖既有数据。
			// 硬链接是原子的：读者要么看到 ENOENT，要么看到完整文件。
			//
			// 提交钩子本身是等待点（测试在这里 abort 复现"等待期间取消"），
			// 因此等待返回后、**真正发起提交 IO 之前**必须再查一次：这是 B0 的核心修复。
			await beforeIo("link", absolutePath);
			throwIfAnyCancelled([callSignal, signal]);

			try {
				// 注入点：默认就是 node:fs/promises.link；测试用它强制 ENOSYS/EPERM 分支，
				// 验证"不支持硬链接时明确失败、且不创建目标文件"。
				await (ioHooks?.link ?? link)(tempPath, absolutePath);
				// 提交 IO 成功即**提交点**：此后（含清理失败、迟到的 abort）
				// 都不撤销已提交内容，调用方拿到的是真实状态（"不假装回滚已提交文件"）。
			} catch (error) {
				if (isCancelledError(error)) throw error;
				switch (classifyLinkFailure(error)) {
					case "exists":
						status = "exists";
						break;
					case "unsupported":
						// 不再回退直写：回退只能保证"不覆盖"，无法保证"写完整前不可见"。
						throw new StorageError("publish-unsupported", `该文件系统不支持硬链接，无法在不暴露半成品的情况下发布文件（已放弃回退直写）：${absolutePath}`, {
							path: absolutePath,
							detail: fsErrorCode(error) ?? "link-unsupported",
							cause: error,
						});
					default:
						throw mapFsError(error, "permission-denied", `无法发布文件：${absolutePath}`, absolutePath);
				}
			}
		} catch (error) {
			failure = error;
		}

		// 清理**恰好执行一次**，且覆盖全部结果分支（成功 / 目标已存在 / 取消 / 失败）。
		// `exists` 尤其容易漏：它是"正常返回"而不是抛错，如果只在 catch 里清理，
		// 就会给每次"目标已被别人抢先创建"都留下一个临时文件。
		const cleanup: "ok" | "failed" = (await removeTempFile(tempPath, commitContext)) ? "ok" : "failed";
		if (failure !== undefined) {
			// 清理失败只作为**附加诊断**，原错误码（cancelled / publish-unsupported /
			// permission-denied …）保持不变——调用方要处理的是"为什么没发布成功"。
			throw cleanup === "ok" ? failure : attachCleanupFailureNote(failure);
		}
		return { status, bytes, cleanup, fingerprint };
	};

	const publishJson = async (absolutePath: string, value: unknown, callSignal?: AbortSignal, maxBytes?: number): Promise<"created" | "exists"> => {
		return (await publishJsonMeasured(absolutePath, value, { callSignal, maxBytes })).status;
	};

	const pathExists = async (absolutePath: string, callSignal?: AbortSignal): Promise<boolean> => {
		throwIfAnyCancelled([callSignal, signal]);
		if (!isWithinRoot(canonicalRoot, absolutePath)) {
			throw new StorageError("path-escape", `路径超出知识根：${absolutePath}`, { path: absolutePath });
		}
		await beforeIo("stat", absolutePath);
		try {
			// `lstat` 而不是 `stat`：链接本身"存在"也是一个事实，
			// 这里不替调用方决定要不要跟随它。
			await lstat(absolutePath);
			throwIfAnyCancelled([callSignal, signal]);
			return true;
		} catch (error) {
			if (isNotFoundError(error)) return false;
			throw mapFsError(error, "permission-denied", `无法探测路径：${absolutePath}`, absolutePath);
		}
	};

	const removeFile = async (absolutePath: string, callSignal?: AbortSignal): Promise<void> => {
		throwIfAnyCancelled([callSignal, signal]);
		if (!isWithinRoot(canonicalRoot, absolutePath)) {
			throw new StorageError("path-escape", `路径超出知识根：${absolutePath}`, { path: absolutePath });
		}
		// 拒绝根内链接（含最终文件）：删除必须作用在真实普通文件上。
		assertNoSymlinks(absolutePath);
		await beforeIo("remove-file", absolutePath);
		const stats = await lstat(absolutePath).catch((error: unknown) => {
			if (isNotFoundError(error)) return null;
			throw mapFsError(error, "permission-denied", `无法检查待删除文件：${absolutePath}`, absolutePath);
		});
		if (stats === null) return;
		if (!stats.isFile()) throw new StorageError("invalid-record", `只允许删除普通文件：${absolutePath}`, { path: absolutePath });
		await unlink(absolutePath).catch((error: unknown) => {
			if (isNotFoundError(error)) return;
			throw mapFsError(error, "permission-denied", `无法删除文件：${absolutePath}`, absolutePath);
		});
		throwIfAnyCancelled([callSignal, signal]);
	};

	const replaceJson = async (absolutePath: string, value: unknown, replaceOptions: { maxBytes?: number; callSignal?: AbortSignal } = {}): Promise<ReplaceJsonResult> => {
		const callSignal = replaceOptions.callSignal;
		const maxBytes = replaceOptions.maxBytes ?? limits.maxRecordBytes;

		throwIfAnyCancelled([callSignal, signal]);
		assertNoSymlinks(absolutePath);

		const payload = serializeJsonPayload(value);
		const bytes = assertPayloadWithinLimits(absolutePath, payload, maxBytes, limits.maxJsonChars);
		const fingerprint = payloadFingerprint(payload);

		const tempPath = buildTempPath(absolutePath);
		const signals: Array<AbortSignal | undefined> = [callSignal, signal];
		let renameAttempts = 0;

		try {
			// 准备阶段：完整内容 + `sync` + **正常路径 close**。
			// `close` 失败属于"提交尚未成立"，必须中止（见 commit.ts 的 prepareTempFile）。
			await prepareTempFile(tempPath, payload, commitContext);

			// 临时写完、目标尚未改动：此处取消 = 干净失败（catch 清理临时文件）。
			throwIfAnyCancelled(signals);

			// 提交前**再查一次路径边界**：从函数入口到这里已经过去了完整的一次写入，
			// 期间目标路径可能被替换成链接（本地恶意进程的典型手法），
			// 而 `rename` 会跟随链接把内容写到根外。
			assertNoSymlinks(absolutePath);

			// `renameWithRetry` 内部负责"等待点之后、发起提交 IO 之前"的取消复查（B0 规则）。
			renameAttempts = await renameWithRetry(tempPath, absolutePath, signals, commitContext);
			// 提交点：`rename` 返回即内容生效。此后迟到的取消只报告真实状态。
		} catch (error) {
			// 失败路径：清理自己的临时文件。清理失败**如实附加**到原错误上，
			// 但**不替换**错误码——调用方要处理的是"为什么没提交成功"。
			const cleaned = await removeTempFile(tempPath, commitContext);
			throw cleaned ? error : attachCleanupFailureNote(error);
		}

		// 提交点已过：此时才删临时文件，且**删不掉不改写"已提交"这一事实**，
		// 只如实报告 cleanup 状态（调用方据此决定要不要提示/清理）。
		const cleanup: "ok" | "failed" = (await removeTempFile(tempPath, commitContext)) ? "ok" : "failed";
		return { bytes, cleanup, renameAttempts, fingerprint };
	};

	const listEntries = async (absolutePath: string, listOptions: ListEntriesOptions = {}): Promise<DirectoryEntryListing> => {
		const callSignal = listOptions.signal;
		throwIfAnyCancelled([callSignal, signal]);
		assertNoSymlinks(absolutePath);

		const maxEntries = listOptions.maxEntries ?? limits.maxScanEntries;
		let directory;
		try {
			await beforeIo("opendir", absolutePath);
			directory = await opendir(absolutePath);
		} catch (error) {
			throw mapFsError(error, "not-found", `无法打开目录：${absolutePath}`, absolutePath);
		}

		const names: string[] = [];
		let scanned = 0;
		let truncated = false;
		try {
			// opendir 是 IO 等待点：空目录/小目录在等待期间取消时，
			// 旧实现会一路走到 return 并返回"成功空列表"（BM-02AR / S3）。
			throwIfAnyCancelled([callSignal, signal]);

			for await (const entry of directory) {
				throwIfAnyCancelled([callSignal, signal]);
				scanned += 1;
				// 观察计量在**判定截断与跳过之前**发出：超限探测条目、被跳过的链接/子目录
				// 都是真实观察，且迭代中途抛错时这段计数已经交回调用方（S2）。
				listOptions.observe?.(scanned);
				// 截断判定基于**扫描过的条目数**：被跳过的链接/子目录同样消耗扫描预算。
				if (scanned > maxEntries) {
					truncated = true;
					break;
				}
				if (entry.isSymbolicLink()) {
					// 链接策略：默认跳过，且**不读取链接目标正文**；
					// `includeSymlinks` 为真时把名字交回调用方，由 `assertNoSymlinks`
					// 在 `open` 之前明确拒绝——这样链接既不会静默消失，也不会被读成记录。
					if (!listOptions.includeSymlinks) continue;
					names.push(entry.name);
					continue;
				}
				if (listOptions.filesOnly && !entry.isFile()) continue;
				names.push(entry.name);
			}

			// 迭代结束（含空目录）后、return 之前再复查一次：
			// "等待期间取消"不能因为目录恰好是空的就变成一次成功返回。
			throwIfAnyCancelled([callSignal, signal]);
		} finally {
			await directory.close().catch(() => undefined);
		}

		return { names, truncated, scanned };
	};

	return { root: configuredRoot, canonicalRoot, limits, signal, resolve, assertNoSymlinks, ensureDirectory, readJson, readJsonForCleanup, readRawBytes, publishJson, publishJsonMeasured, replaceJson, beforeIo, pathExists, listEntries, removeFile };
}
