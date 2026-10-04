/**
 * 备份目标侧的 IO 原语（BM-02D2 / D2R）。
 *
 * 目标在**知识根之外**，因此不能复用 boundary（它的 `resolve`/`assertNoSymlinks` 按根内路径判定）。
 * D2R 把这里从"词法路径 + 无脑删除"改成"**带身份的自有目标会话**"，因为 round22 §3 证明：
 * 非 recursive 删除**不等于**不会逃逸——只要祖先目录被换成 junction，`unlink(<target>/data/x.json)`
 * 就会删掉指向目录里的同名文件（D2-1）。四条底线：
 *
 * 1. **取得即登记身份**：根/目录 `mkdir` 成功、文件 `open` 成功的**当下**记录 `dev+ino+类型`；
 *    "这条路径曾经由我创建"不是所有权证据，每次写/读/发布/清理前都要**重新核对**。
 * 2. **祖先链必须仍是我建的目录**：删除/写入前逐级 `lstat`，出现链接、缺失、类型变化或身份不符
 *    就**停手**（保留现场、计入残留），绝不穿过未知祖先。
 * 3. **完成标记最后发布**：独占临时文件（创建即登记）→ `sync` → `close` → `link` 到最终名 → 删临时文件；
 *    硬链接不可用**受控失败**，不退化成"直接覆盖写"（那会暴露半截清单）。取消在真实 `link` **之前**必须生效。
 * 4. **清理只删证明还归我所有的分支**：删不掉/被替换/未知归属一律保留并结构化报告，不用递归删除。
 */
import { Buffer } from "node:buffer";
import { link, lstat, mkdir, open, realpath, rmdir, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import type { StorageIoOperation } from "../commit.ts";
import { fsErrorCode, isNotFoundError, StorageError, throwIfAnyCancelled } from "../errors.ts";

/** 目标侧运行时：取消信号、IO 钩子（测试可注入确定性时序）与句柄关闭策略。 */
export type TargetRuntime = {
	readonly signal: AbortSignal | undefined;
	/** 与源边界同一个钩子出口：测试能在真实操作发起前注入取消或故障。 */
	readonly beforeIo: (operation: StorageIoOperation, target: string) => Promise<void>;
	/**
	 * 句柄关闭策略（沿用已有 `StorageIoHooks.closeFile`）。
	 *
	 * 为什么让它可注入：round22 §3 的"close 实际关闭后抛 EIO"必须能确定性复现，
	 * 而 `close().catch(() => undefined)` 会把这种失败吞掉。默认就是真实的 `handle.close()`。
	 */
	readonly closeFile: (handle: FileHandle) => Promise<void>;
	/** 目标根（调用方指定，仍是**词法**路径；canonical 校验后写入）。 */
	readonly targetRoot: string;
};

/** 一处自有目标的身份（取得时登记，使用前复核）。 */
export type OwnedEntry = {
	readonly relative: string;
	readonly absolute: string;
	readonly kind: "dir" | "file";
	readonly dev: number;
	readonly ino: number;
};

/** 自有目标会话：登记本次调用创建过的每一个根/目录/文件。 */
export type TargetSession = {
	readonly runtime: TargetRuntime;
	/** 相对目标根（`""` 表示根自身）→ 身份。 */
	readonly owned: Map<string, OwnedEntry>;
};

export function createTargetSession(runtime: TargetRuntime): TargetSession {
	return { runtime, owned: new Map<string, OwnedEntry>() };
}

/** 目标内相对路径 → 绝对路径（只做词法派生；边界由 `assertInsideRoot` 与祖先身份检查负责）。 */
export function targetAbsolute(runtime: TargetRuntime, relativePath: string): string {
	return join(runtime.targetRoot, ...relativePath.split("/").filter((segment) => segment.length > 0));
}

function segments(value: string): string[] {
	return value
		.split(/[\\/]+/)
		.filter((segment) => segment.length > 0)
		.map((segment) => (process.platform === "win32" ? segment.toLowerCase() : segment));
}

/** 词法判据：候选路径必须**严格**位于目标根之下，且相对部分是受控相对路径。 */
export function assertInsideRoot(runtime: TargetRuntime, absolute: string): string {
	const target = segments(runtime.targetRoot);
	const candidate = segments(normalize(absolute));
	if (candidate.length <= target.length || !target.every((segment, index) => candidate[index] === segment)) {
		throw new StorageError("path-escape", "拒绝访问备份目录之外的路径", { detail: "outside-target" });
	}
	return candidate.slice(target.length).join("/");
}

/** 目标内相对路径的**形状**判据（不依赖平台分隔符，供身份登记与清理复用）。 */
function requireRelative(relativePath: string): string[] {
	const parts = relativePath.split("/").filter((segment) => segment.length > 0);
	// 绝对路径、`.`、`..`、盘符或 UNC 一律拒绝：清理只能按**我们登记过的**相对路径进行。
	if (isAbsolute(relativePath) || parts.some((segment) => segment === "." || segment === "..") || parts.join("/") !== relativePath.replace(/\/+$/, "")) {
		throw new StorageError("path-escape", "拒绝按非受控相对路径访问备份目标", { detail: "invalid-relative" });
	}
	return parts;
}

/* ------------------------------------------------------------------ 身份登记与复核 */

async function readIdentity(absolute: string): Promise<{ kind: "dir" | "file"; dev: number; ino: number } | undefined> {
	let stats;
	try {
		stats = await lstat(absolute);
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new StorageError("permission-denied", "无法核对备份目标路径", { detail: fsErrorCode(error) });
	}
	// 链接（含 Windows junction）一律不是"我创建的东西"：它的目标不在我的边界里。
	if (stats.isSymbolicLink()) return undefined;
	if (stats.isDirectory()) return { kind: "dir", dev: stats.dev, ino: stats.ino };
	if (stats.isFile()) return { kind: "file", dev: stats.dev, ino: stats.ino };
	return undefined;
}

function recordOwned(session: TargetSession, relativePath: string, absolute: string, identity: { kind: "dir" | "file"; dev: number; ino: number }): void {
	session.owned.set(relativePath, { relative: relativePath, absolute, kind: identity.kind, dev: identity.dev, ino: identity.ino });
}

/** 当前是否仍归我所有（身份 + 类型都相符）。 */
async function stillOwned(session: TargetSession, relativePath: string): Promise<boolean> {
	const entry = session.owned.get(relativePath);
	if (entry === undefined) return false;
	const identity = await readIdentity(entry.absolute);
	return identity !== undefined && identity.kind === entry.kind && identity.dev === entry.dev && identity.ino === entry.ino;
}

/**
 * 逐级复核**祖先链**：从目标根到给定相对路径的父目录，每一级都必须仍是我登记过的目录。
 *
 * 这是 D2-1 的正面防线：`data/` 被 rename 走并换成 junction 之后，这里的身份核对不通过，
 * 后续写入/删除都会被拦下，而不是穿过链接去操作别人的文件。
 *
 * 注意它**不检查取消**：调用方负责在需要时先查。清理路径必须在信号已 abort 之后仍然能跑完
 * （否则一次取消就会把本次创建的空目录全部留成"无主残留"）。
 */
async function checkAncestorsOwned(session: TargetSession, relativePath: string): Promise<void> {
	const parts = requireRelative(relativePath);
	try {
		assertInsideRoot(session.runtime, targetAbsolute(session.runtime, relativePath));
	} catch {
		throw new StorageError("path-escape", "拒绝访问备份目录之外的路径", { detail: "outside-target" });
	}
	if (!(await stillOwned(session, ""))) throw new StorageError("backup-target-exists", "备份目标根已不再归本次调用所有，停止操作", { detail: "root-not-owned" });
	for (let depth = 1; depth < parts.length; depth += 1) {
		const ancestor = parts.slice(0, depth).join("/");
		if (!(await stillOwned(session, ancestor))) throw new StorageError("backup-target-exists", "备份目标目录已不是本次创建的目录（被移动、替换或改成链接），停止操作", { detail: "ancestor-not-owned" });
	}
}

/** 写入/读取前使用：先看取消，再核对祖先身份。 */
export async function assertAncestorsOwned(session: TargetSession, relativePath: string, callSignal?: AbortSignal): Promise<void> {
	throwIfAnyCancelled([callSignal, session.runtime.signal]);
	await checkAncestorsOwned(session, relativePath);
}

/* ------------------------------------------------------------------ 取得目标（排他创建 + 登记） */

async function acceptCreated(session: TargetSession, relativePath: string, absolute: string, expect: "dir" | "file"): Promise<void> {
	// 创建**成功之后立刻**登记：等待期间的取消也必须能清理到这一条（D2-3）。
	const identity = await readIdentity(absolute);
	if (identity === undefined || identity.kind !== expect) {
		// 拿到手却不是常规目录/文件（例如被换成链接）：不登记、不写、留给人工。
		throw new StorageError("backup-target-exists", "创建后路径不是预期的常规目录/文件，拒绝继续", { detail: "unexpected-type" });
	}
	recordOwned(session, relativePath, absolute, identity);
}

/**
 * 文件归属登记（R23-1）：身份以**已取得的句柄**为准，再与路径当前的 `lstat` 交叉核对。
 *
 * 为什么不是"按路径 lstat 一次就登记"：`open` 与登记之间如果路径被换成指向别处的 junction，
 * 按路径登记就会把**别人的文件**记成自有，后续回读/发布/清理都会作用在替换物上。
 * 句柄的 `fstat` 是这次真实打开的对象；两者不一致 ⇒ 拒绝登记（调用方在关闭保护内抛出）。
 */
async function acceptCreatedFile(session: TargetSession, relativePath: string, absolute: string, handle: FileHandle): Promise<void> {
	const fromHandle = await handle.stat();
	let fromPath;
	try {
		fromPath = await lstat(absolute);
	} catch (error) {
		// 登记路径不可核对：受控失败（原始 fs 错误不进入控制流），调用方仍在关闭保护内。
		if (isNotFoundError(error)) throw new StorageError("backup-target-exists", "创建后的路径已消失，拒绝登记为本次创建", { detail: "vanished-after-create" });
		throw new StorageError("permission-denied", "无法核对创建后的路径身份", { detail: fsErrorCode(error) });
	}
	if (fromHandle.isSymbolicLink() || !fromHandle.isFile() || fromPath.isSymbolicLink() || !fromPath.isFile()) {
		throw new StorageError("backup-target-exists", "创建后路径不是预期的常规文件，拒绝继续", { detail: "unexpected-type" });
	}
	if (fromHandle.dev !== fromPath.dev || fromHandle.ino !== fromPath.ino) {
		throw new StorageError("backup-target-exists", "创建后的路径已被替换（句柄与路径不是同一对象），拒绝登记为本次创建", { detail: "replaced-after-create" });
	}
	recordOwned(session, relativePath, absolute, { kind: "file", dev: fromHandle.dev, ino: fromHandle.ino });
}

/** 排他创建目标根；已存在（空目录、旧备份、半成品、文件或链接）即冲突。 */
export async function acquireTargetRoot(session: TargetSession, callSignal?: AbortSignal): Promise<void> {
	const runtime = session.runtime;
	throwIfAnyCancelled([callSignal, runtime.signal]);
	await runtime.beforeIo("mkdir", runtime.targetRoot);
	try {
		// 非 recursive：父目录不存在必须失败，不由我们顺手造父链。
		await mkdir(runtime.targetRoot);
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") throw new StorageError("backup-target-exists", "备份目标已存在，拒绝复用或覆盖", { detail: "exists" });
		throw new StorageError("permission-denied", "无法创建备份目标目录", { detail: fsErrorCode(error) });
	}
	// 领取之后（可能已经历取消等待）先登记归属，再让取消生效——否则空目标会成为无主残留。
	await acceptCreated(session, "", runtime.targetRoot, "dir");
	throwIfAnyCancelled([callSignal, runtime.signal]);
}

/** 在目标内排他创建目录并登记；EEXIST 是**冲突**，不当作"本次创建"。 */
export async function createOwnedDirectory(session: TargetSession, relativePath: string, callSignal?: AbortSignal): Promise<void> {
	const runtime = session.runtime;
	requireRelative(relativePath);
	await assertAncestorsOwned(session, relativePath, callSignal);
	throwIfAnyCancelled([callSignal, runtime.signal]);
	const absolute = targetAbsolute(runtime, relativePath);
	await runtime.beforeIo("mkdir", absolute);
	// 等待之后、真实 mkdir 之前重查（R23-1），与写入路径同一纪律。
	await assertAncestorsOwned(session, relativePath, callSignal);
	try {
		await mkdir(absolute);
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") throw new StorageError("backup-target-exists", "备份目标内已存在同名目录，拒绝复用", { detail: "mkdir-exists" });
		throw new StorageError("permission-denied", "无法创建备份目录", { detail: fsErrorCode(error) });
	}
	await acceptCreated(session, relativePath, absolute, "dir");
	throwIfAnyCancelled([callSignal, runtime.signal]);
}

/* ------------------------------------------------------------------ 写入与回读 */

/**
 * 独占写入一个文件并登记：`wx` 打开（撞名说明有别的写者）、循环处理短写、`sync()`、
 * 用注入的关闭策略 `close()`。**close 失败必须抛出**——正常准备阶段关不掉句柄就不能进入发布（D2-3）。
 */
export async function writeOwnedFile(session: TargetSession, relativePath: string, bytes: Uint8Array, callSignal?: AbortSignal): Promise<void> {
	const runtime = session.runtime;
	await assertAncestorsOwned(session, relativePath, callSignal);
	throwIfAnyCancelled([callSignal, runtime.signal]);
	const absolute = targetAbsolute(runtime, relativePath);
	await runtime.beforeIo("backup-write", absolute);
	// **等待之后、真实 open 之前**重查取消与祖先身份（R23-1）：hook 期间 `data/` 被 rename 走再换成
	// junction 时，这一查必须在这里就挡住——不能等到 open 把文件写进目标之外之后才发现。
	await assertAncestorsOwned(session, relativePath, callSignal);
	let handle: FileHandle;
	try {
		handle = await open(absolute, "wx");
	} catch (error) {
		if (fsErrorCode(error) === "EEXIST") throw new StorageError("backup-target-exists", "备份目录内已有同名文件，拒绝覆盖", { detail: "file-exists" });
		throw new StorageError("permission-denied", "无法创建备份文件", { detail: fsErrorCode(error) });
	}
	let failure: unknown;
	try {
		// open 成功即进入关闭保护：登记失败（含 lstat/类型/替换核对）也必须关掉句柄（R23-2），
		// 之后的写入/sync/取消同样在这一段里，任何失败都不会漏关。
		await acceptCreatedFile(session, relativePath, absolute, handle);
		const buffer = Buffer.from(bytes);
		let written = 0;
		while (written < buffer.byteLength) {
			throwIfAnyCancelled([callSignal, runtime.signal]);
			const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written);
			if (bytesWritten <= 0) throw new StorageError("permission-denied", "备份文件写入没有进展", { detail: "short-write" });
			written += bytesWritten;
		}
		await handle.sync();
	} catch (error) {
		failure = error;
	}
	// 关闭永远尽力执行，但**异常路径不覆盖首错**；正常路径关闭失败必须让本次写入失败。
	try {
		await runtime.closeFile(handle);
	} catch (error) {
		if (failure === undefined) failure = new StorageError("permission-denied", "备份文件句柄关闭失败", { detail: fsErrorCode(error) });
	}
	if (failure !== undefined) throw failure;
	throwIfAnyCancelled([callSignal, runtime.signal]);
}

/** 只读回读的期望身份：给了就要求句柄的 `fstat` 与它一致（防"读的是被替换后的文件"）。 */
export type ExpectedIdentity = { readonly dev: number; readonly ino: number };

/**
 * 有界回读一个文件（目标或备份容器均可）；只接受常规文件。
 *
 * R23-2 的修正点：旧版把 `return Buffer.concat(...)` 写在 `try` **内部**，正常路径先返回结果，
 * `finally` 里记下的"关闭失败"就再也不会被检查——读句柄关不掉却照常发布。现在把结果缓存到局部
 * 变量，**读与正常关闭都成功**才返回；异常路径的关闭失败不覆盖首错。
 */
export async function readBoundedFile(runtime: TargetRuntime, absolute: string, maxBytes: number, callSignal?: AbortSignal, expect?: ExpectedIdentity): Promise<Buffer> {
	throwIfAnyCancelled([callSignal, runtime.signal]);
	await runtime.beforeIo("open", absolute);
	let handle: FileHandle;
	try {
		handle = await open(absolute, "r");
	} catch (error) {
		throw new StorageError("not-found", "无法读取文件", { detail: fsErrorCode(error) });
	}
	let failure: unknown;
	let result: Buffer | undefined;
	try {
		const stats = await handle.stat();
		if (!stats.isFile()) throw new StorageError("not-a-file", "目标不是常规文件", { detail: "not-a-file" });
		// R23-1：以**句柄**为准核对身份——路径可能在等待期间被换掉，打开的对象才是真正要读的那个。
		if (expect !== undefined && (expect.dev !== stats.dev || expect.ino !== stats.ino)) throw new StorageError("backup-target-exists", "被读取的文件已被替换，拒绝继续", { detail: "replaced-before-read" });
		if (stats.size > maxBytes) throw new StorageError("too-large", `文件超过单文件预算 ${maxBytes}`, { detail: String(stats.size) });
		const chunks: Buffer[] = [];
		let total = 0;
		let reachedEof = false;
		while (total <= maxBytes) {
			throwIfAnyCancelled([callSignal, runtime.signal]);
			const readSize = Math.min(64 * 1024, maxBytes + 1 - total);
			if (readSize <= 0) break;
			const buffer = Buffer.allocUnsafe(readSize);
			const { bytesRead } = await handle.read(buffer, 0, readSize, total);
			if (bytesRead === 0) {
				reachedEof = true;
				break;
			}
			total += bytesRead;
			chunks.push(bytesRead === readSize ? buffer : buffer.subarray(0, bytesRead));
		}
		if (total > maxBytes || !reachedEof) throw new StorageError("too-large", "文件回读不完整或超限", { detail: "read-incomplete" });
		result = Buffer.concat(chunks, total);
	} catch (error) {
		failure = error;
	}
	try {
		await runtime.closeFile(handle);
	} catch (error) {
		if (failure === undefined) failure = new StorageError("permission-denied", "读取句柄关闭失败", { detail: fsErrorCode(error) });
	}
	if (failure !== undefined) throw failure;
	if (result === undefined) throw new StorageError("permission-denied", "读取未返回结果", { detail: "unreachable" });
	return result;
}

/** 只读回读**自有**文件：先复核祖先与自身身份，读时再要求句柄身份一致。 */
export async function readOwnedFileBounded(session: TargetSession, relativePath: string, maxBytes: number, callSignal?: AbortSignal): Promise<Buffer> {
	await assertAncestorsOwned(session, relativePath, callSignal);
	const entry = session.owned.get(relativePath);
	if (entry === undefined || !(await stillOwned(session, relativePath))) throw new StorageError("backup-target-exists", "备份文件已不是本次写入的文件，拒绝回读", { detail: "file-not-owned" });
	return readBoundedFile(session.runtime, targetAbsolute(session.runtime, relativePath), maxBytes, callSignal, { dev: entry.dev, ino: entry.ino });
}

/* ------------------------------------------------------------------ 完成标记发布 */

export type PublishOutcome = {
	readonly published: true;
	/** 临时文件是否已删除；`false` 表示存在有界残留（published 仍为 true）。 */
	readonly tempRemoved: boolean;
	/** 本次发布的临时文件相对路径（自有受控命名，供残留报告使用）。 */
	readonly tempRelative: string;
};

/**
 * 发布完成标记：独占临时文件（创建即登记）→ 写 → `sync` → `close` → `link` 到最终名 → 删临时文件。
 *
 * 取消在真实 `link` **之前**必须生效（round22 §3：hook/等待中的取消曾仍发布 manifest）；
 * `link` 成功后即使删临时文件失败也**不回滚**——那是已提交的事实，只结构化报告残留。
 */
export async function publishOwnedManifest(session: TargetSession, relativePath: string, bytes: Uint8Array, callSignal?: AbortSignal): Promise<PublishOutcome> {
	const runtime = session.runtime;
	await assertAncestorsOwned(session, relativePath, callSignal);
	throwIfAnyCancelled([callSignal, runtime.signal]);
	const finalPath = targetAbsolute(runtime, relativePath);
	const tempRelative = `${relativePath}.${process.pid}.${Date.now()}.tmp`;
	const tempPath = targetAbsolute(runtime, tempRelative);

	await runtime.beforeIo("backup-write", tempPath);
	// 等待之后、真实创建之前重查祖先（R23-1）：发布临时文件不能因为一次 hook 落进替换物。
	await assertAncestorsOwned(session, tempRelative, callSignal);
	let handle: FileHandle;
	try {
		handle = await open(tempPath, "wx");
	} catch (error) {
		throw new StorageError("permission-denied", "无法创建发布临时文件", { detail: fsErrorCode(error) });
	}
	let failure: unknown;
	try {
		// open 成功即进入关闭保护（R23-2）：身份登记失败同样必须关掉句柄。
		await acceptCreatedFile(session, tempRelative, tempPath, handle);
		const buffer = Buffer.from(bytes);
		let written = 0;
		while (written < buffer.byteLength) {
			throwIfAnyCancelled([callSignal, runtime.signal]);
			const { bytesWritten } = await handle.write(buffer, written, buffer.byteLength - written);
			if (bytesWritten <= 0) throw new StorageError("permission-denied", "发布临时文件写入没有进展", { detail: "short-write" });
			written += bytesWritten;
		}
		await handle.sync();
	} catch (error) {
		failure = error;
	}
	try {
		await runtime.closeFile(handle);
	} catch (error) {
		if (failure === undefined) failure = new StorageError("permission-denied", "发布临时文件关闭失败", { detail: fsErrorCode(error) });
	}
	if (failure !== undefined) throw failure;

	// 真正的提交点之前再查一次取消与归属：等待/hook 期间的取消不得发布完成标记，
	// 目标祖先或临时文件被替换时也不得用它去发布（R23-1）。
	throwIfAnyCancelled([callSignal, runtime.signal]);
	await runtime.beforeIo("link", finalPath);
	throwIfAnyCancelled([callSignal, runtime.signal]);
	await assertAncestorsOwned(session, relativePath, callSignal);
	if (!(await stillOwned(session, tempRelative))) throw new StorageError("backup-target-exists", "发布临时文件已不再归本次调用所有，拒绝发布", { detail: "temp-not-owned" });
	try {
		await link(tempPath, finalPath);
	} catch (error) {
		const code = fsErrorCode(error);
		if (code === "EEXIST") throw new StorageError("backup-target-exists", "完成标记已存在，拒绝覆盖", { detail: "manifest-exists" });
		// 硬链接不可用即受控失败：没有"先写目标再回滚"这种会暴露半截清单的退路。
		throw new StorageError("publish-unsupported", "无法非覆盖发布完成标记（平台不支持硬链接或权限不足）", { detail: code });
	}

	// 已提交：临时文件删除失败只影响清理事实，绝不回滚完成标记。
	// 删除前先确认它仍归本次调用所有：被替换成链接/别的文件时保留并报告残留，不删别人的东西。
	let tempRemoved = true;
	try {
		if (!(await stillOwned(session, tempRelative))) {
			tempRemoved = false;
		} else {
			await unlink(tempPath);
		}
	} catch {
		tempRemoved = false;
	}
	if (tempRemoved) session.owned.delete(tempRelative);
	return { published: true, tempRemoved, tempRelative };
}

/* ------------------------------------------------------------------ 清理（只删还归我所有的分支） */

/**
 * 路径是否存在（只看存在性，不做类型判断）。
 *
 * R24-1：**只有 ENOENT 才是"不存在"**。EACCES/EIO 表示"不能确认"，它不是"没有内容"——
 * 旧实现把所有异常都当成 false，清理于是把仍有文件的目录当成已消失，虚报 `cleanup=ok`。
 * 不可核对一律抛出（由清理的 catch 记为该条残留，不删 owned、不计 removed）。
 */
async function pathExists(absolute: string): Promise<boolean> {
	try {
		await lstat(absolute);
		return true;
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new StorageError("permission-denied", "无法确认备份目标路径是否存在", { detail: fsErrorCode(error) });
	}
}

export type CleanupOutcome = {
	readonly cleanup: "ok" | "failed";
	readonly removed: number;
	/** 未能删除的**有界**相对路径样本（最多 5 条）。 */
	readonly residuals: readonly string[];
	readonly residualCount: number;
};

/**
 * 按归属清理本次创建的路径：文件先删、目录自深到浅。
 *
 * 任一条的祖先链/身份核对不通过就**跳过该分支**并计为残留（不穿过未知祖先、不递归删除），
 * 其余已证明自有且互不依赖的分支仍然清理。
 */
export async function cleanupOwned(session: TargetSession): Promise<CleanupOutcome> {
	const entries = [...session.owned.values()].sort((left, right) => right.relative.split("/").length - left.relative.split("/").length || (left.relative < right.relative ? 1 : -1));
	const residuals: string[] = [];
	let residualCount = 0;
	let removed = 0;
	for (const entry of entries) {
		let ok = false;
		try {
			const isRoot = entry.relative === "";
			// 已经不存在 = 没有可清理的东西（例如被外部删掉的空目录）：不是残留。
			if (!(await pathExists(entry.absolute))) {
				session.owned.delete(entry.relative);
				removed += 1;
				continue;
			}
			// 清理**不看取消**：信号已 abort 也要把本次创建的内容收干净。
			if (!isRoot) await checkAncestorsOwned(session, entry.relative);
			// 存在但不是"我创建的那一个"（被移动/替换成链接或别的文件）⇒ 停手、保留、报告。
			if (!(await stillOwned(session, entry.relative))) throw new StorageError("backup-target-exists", "归属核对失败", { detail: "not-owned" });
			if (entry.kind === "dir") {
				// 不用 recursive：非空说明还有未知归属的残留，保留并报告。
				await rmdir(entry.absolute);
			} else {
				await unlink(entry.absolute);
			}
			ok = true;
		} catch {
			ok = false;
		}
		if (ok) {
			removed += 1;
			session.owned.delete(entry.relative);
		} else {
			residualCount += 1;
			if (residuals.length < 5) residuals.push(entry.relative === "" ? "." : entry.relative);
		}
	}
	return { cleanup: residualCount === 0 ? "ok" : "failed", removed, residuals, residualCount };
}

/* ------------------------------------------------------------------ 路径与父链校验 */

/** 目标文件名（父目录之外的最后一个路径段）。 */
export function targetName(targetRoot: string): string {
	return basename(normalize(targetRoot));
}

/** 目标根（父 canonical + 名字）。 */
export function targetRootOf(canonicalParent: string, name: string): string {
	return join(canonicalParent, name);
}

/** 目标父目录的解析结果：canonical 供重叠判定，`chainLink` 表示词法父链里有链接。 */
export type ResolvedTargetParent = {
	readonly canonicalParent: string;
	readonly chainLink: boolean;
};

/**
 * 解析一个"新目标"的规范父目录，并**报告词法父链里是否存在链接**。
 *
 * D2R 的修正点：旧实现只 `realpath` 父目录再 `lstat` 一次 canonical —— 那只能发现**父目录自身**
 * 是链接，发现不了父链里更上层的 junction，等于注释里的承诺没有兑现。这里逐级核对
 * `realpath(level) === normalize(level)`：某一级是链接时 realpath 会把它解开，两级字符串就不再相等。
 *
 * **不在这里抛链接错误**：canonical 结果先交调用方做重叠判定（"词法分离但解析后重叠"必须仍报
 * `backup-target-overlap`），随后调用方按 `chainLink` 决定拒绝。顺序变了会改变受控类别。
 */
export async function resolveTargetParent(targetRoot: string, label: string): Promise<ResolvedTargetParent> {
	const parent = dirname(normalize(targetRoot));
	let canonical: string;
	try {
		canonical = await realpath(parent);
	} catch (error) {
		if (isNotFoundError(error)) throw new StorageError("backup-argument-invalid", `${label}的父目录不存在或无法解析`, { detail: "parent-missing" });
		throw new StorageError("backup-argument-invalid", `无法解析${label}的父目录`, { detail: fsErrorCode(error) });
	}
	const stats = await lstat(canonical);
	if (!stats.isDirectory() || stats.isSymbolicLink()) throw new StorageError("backup-argument-invalid", `${label}的父路径不是常规目录`, { detail: "parent-not-directory" });

	const same = (left: string, right: string): boolean => {
		const a = normalize(left);
		const b = normalize(right);
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	};
	let current = normalize(parent);
	let chainLink = false;
	for (;;) {
		let resolved: string;
		try {
			resolved = await realpath(current);
		} catch {
			throw new StorageError("backup-argument-invalid", `${label}的父链无法解析`, { detail: "parent-unresolvable" });
		}
		if (!same(resolved, current)) {
			chainLink = true;
			break;
		}
		const next = dirname(current);
		if (next === current) break;
		current = next;
	}
	return { canonicalParent: canonical, chainLink };
}

/** 父链含链接时的受控拒绝（供调用方在重叠判定之后调用）。 */
export function rejectParentChainLink(label: string): never {
	throw new StorageError("backup-argument-invalid", `${label}的父链中存在符号链接或 junction，拒绝在其下创建`, { detail: "parent-chain-link" });
}

/** 目标根存在性（供调用方在失败清理后判断"目标是否还在"）；同上，不可核对不算"不存在"。 */
export async function targetExists(targetRoot: string): Promise<boolean> {
	try {
		await lstat(targetRoot);
		return true;
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw new StorageError("permission-denied", "无法确认备份目标是否存在", { detail: fsErrorCode(error) });
	}
}

/** 目标根是否**空**（供 D3 判定"已有空目录也拒绝"与残留诊断）。 */
export async function isEmptyDirectory(absolute: string): Promise<boolean> {
	try {
		const stats = await lstat(absolute);
		if (stats.isSymbolicLink() || !stats.isDirectory()) return false;
		const { readdir } = await import("node:fs/promises");
		return (await readdir(absolute)).length === 0;
	} catch {
		return false;
	}
}

/** 相对路径标准化（供调用方把绝对路径转成有界定位）。 */
export function toRelative(from: string, absolute: string): string {
	return relative(from, absolute).split(sep).join("/");
}
