/**
 * 预检的**预算与遍历原语**（BM-02C3）。
 *
 * 与"这是一份什么知识库"的分类策略分开：限额怎么算、什么时候停止、输出怎么按真实字节计量，
 * 都必须只有一份实现——否则"预算用完了但结论是好的"这类错误会在每个类别里各犯一次。
 *
 * 五条硬规则：
 * 1. **条目预算共享、观察即时计费**：被跳过的链接、未知条目、子目录本身都消耗扫描条目；
 *    底层**每观察到一个条目**就通过受控回调交回计数并立刻计入统计（S1 / S2），
 *    不等候选处理完成才扣账，也不因为迭代中途失败而丢掉已观察成本；
 *    成功/截断/失败共用这一个计费出口；列举与候选处理职责分开，同一条目不重复扣账；
 *    **超限探测条目一旦交出，停止就锁存**（S3：收尾/关闭失败也不能绕过，见 `isScanStopped`）；
 * 2. **读取预算分账**：成功读取按实际字节（`readBytes`），失败尝试按单文件上限预留
 *    （`reservedBytes`）——失败路径上拿不到实际字节，宁可高估也不当零成本；
 * 3. **共同问题额度**：`problems` 与 `manual` 共享 `maxProblems`（两者合计不超过它，与处理顺序无关），
 *    明细可以裁剪，但 `blockingProblems` / `manualItems` 两个总计永不被裁剪（BM-02C3R / PF-2）；
 * 4. **输出字节按真实包络**：摘要/问题/人工事项三类可变明细按「摘要 → 问题 → 人工事项」合并成
 *    一个 JSON 数组后计量 UTF-8 字节（含数组括号与逗号），空明细计 0；固定报告信封不计入
 *    `maxOutputBytes`（BM-02C3R / PF-3）；
 * 5. **错误出口统一**：非根目录的探测/列举失败按受控类别收集成"问题"后继续检查后续类别，
 *    未知异常不透传原始正文；IO 取消始终结构化穿透。
 */
import { Buffer } from "node:buffer";
import type { StorageBoundary } from "../boundary.ts";
import { isCancelledError, isStorageError, throwIfAnyCancelled } from "../errors.ts";
import { knowledgeLayout } from "../registry.ts";
import type { PreflightCategory, PreflightCode, PreflightFileStatus, PreflightFileSummary, PreflightManualItem, PreflightManualReason, PreflightProblem, PreflightTruncation, PreflightVersionFamily } from "./contract.ts";
import type { PreflightLimits } from "./limits.ts";
import { probePath } from "./pathProbe.ts";

/** 单文件观察结论（分类策略与遍历之间的唯一接口）。 */
export type FileVerdict = {
	readonly status: PreflightFileStatus;
	/** 观察到的版本（不支持/缺失也照实报告，缺失 = null）。 */
	readonly version: number | null;
	readonly code: PreflightCode | null;
	/** 不通过时的有界说明；通过时省略。 */
	readonly message?: string;
	/** 不通过时是否阻断结论（默认阻断）。 */
	readonly blocks?: boolean;
	/** 需要人工核对的事项（不改变"读得懂"的事实）。 */
	readonly manualReason?: PreflightManualReason;
	readonly ok: boolean;
};

export type ScanState = {
	readonly boundary: StorageBoundary;
	readonly limits: PreflightLimits;
	scannedEntries: number;
	/**
	 * 逻辑核对次数（**不是**物理目录观察）：目前只有"registry 已登记但磁盘上没有项目目录"。
	 *
	 * 它与 `scannedEntries` 共用同一份条目预算，但分开计数——否则"登记表里有、磁盘上没有"
	 * 会被报告成"观察了这么多目录条目"（S1 明确要求两者不互相伪装）。
	 */
	logicalChecks: number;
	readBytes: number;
	reservedBytes: number;
	readFiles: number;
	outputBytes: number;
	droppedSummaries: number;
	droppedProblems: number;
	blockingProblems: number;
	manualItems: number;
	stopped: boolean;
	summaries: PreflightFileSummary[];
	problems: PreflightProblem[];
	manual: PreflightManualItem[];
	versions: Map<string, { family: PreflightVersionFamily; version: number | null; files: number }>;
	truncatedBy: Set<PreflightTruncation>;
};

export function createScanState(boundary: StorageBoundary, limits: PreflightLimits): ScanState {
	return {
		boundary,
		limits,
		scannedEntries: 0,
		logicalChecks: 0,
		readBytes: 0,
		reservedBytes: 0,
		readFiles: 0,
		outputBytes: 0,
		droppedSummaries: 0,
		droppedProblems: 0,
		blockingProblems: 0,
		manualItems: 0,
		stopped: false,
		summaries: [],
		problems: [],
		manual: [],
		versions: new Map(),
		truncatedBy: new Set(),
	};
}

/** 预算耗尽即停止扫描（不是"跳过这一条继续"——继续只会把同一批条目重复报告一遍）。 */
export function stopScan(scan: ScanState, reason: PreflightTruncation): void {
	scan.truncatedBy.add(reason);
	scan.stopped = true;
}

/**
 * 扫描是否已停止（`stopped` 全面停止，**或** 条目预算已锁存）。
 *
 * 条目预算锁存的判据是 `truncatedBy` 含 `scan-entries`：真实观察一旦越过 `maxScanEntries`，
 * 唯一超限探测条目就已消耗——该原因的三个写入点（成功截断、逻辑核对触顶、超限探测回调）都只在
 * 耗尽时发生，所以它是持久的停止条件，不依赖 `listEntries` 是否成功返回（S3）。
 */
export function isScanStopped(scan: ScanState): boolean {
	return scan.stopped || scan.truncatedBy.has("scan-entries");
}

export function assertNotCancelled(scan: ScanState): void {
	throwIfAnyCancelled([scan.boundary.signal]);
}

/** 已用读取预算：成功读取 + 失败预留（两者都算"读过"）。 */
function usedReadBytes(scan: ScanState): number {
	return scan.readBytes + scan.reservedBytes;
}

/** 条目预算的已用额度：真实观察条目 + 逻辑核对（共用同一份预算）。 */
function usedEntryBudget(scan: ScanState): number {
	return scan.scannedEntries + scan.logicalChecks;
}

/**
 * 逻辑核对（**不是**物理目录观察）：消耗条目预算，但**不计入** `scannedEntries`。
 *
 * 为什么仍要限额：登记表异常（大量已登记项目在磁盘上缺席）时核对次数必须有界，
 * 否则一次预检会无限产出问题对象。它不产生额外 IO（只对照已读到的 registry 与目录清单）。
 * 返回 `false` 表示预算耗尽、必须停止。
 */
export function chargeLogicalCheck(scan: ScanState): boolean {
	if (scan.stopped) return false;
	if (usedEntryBudget(scan) >= scan.limits.maxScanEntries) {
		stopScan(scan, "scan-entries");
		return false;
	}
	scan.logicalChecks += 1;
	return true;
}

/**
 * 为一次读取预留额度；返回 `null` 表示读取预算已耗尽（已标记截断）。
 *
 * `perFileCap` 用于"类别硬上限比通用上限更小"的工件（审核意图/事件是 16 KiB）：
 * 预留额度取三者最小，读到的字节才与真实预算同源。
 */
export function reserveRead(scan: ScanState, perFileCap?: number): number | null {
	const cap = perFileCap === undefined ? scan.limits.maxFileBytes : Math.min(scan.limits.maxFileBytes, perFileCap);
	const remaining = scan.limits.maxReadBytes - usedReadBytes(scan);
	if (cap <= 0 || remaining <= 0) {
		stopScan(scan, "read-bytes");
		return null;
	}
	return Math.min(cap, remaining);
}

export function settleRead(scan: ScanState, actualBytes: number): void {
	scan.readBytes += actualBytes;
	scan.readFiles += 1;
}

export function failRead(scan: ScanState, reserved: number): void {
	scan.reservedBytes += reserved;
}

/** 序列化字节（真实 UTF-8，不用字符数冒充）。 */
function measure(entry: unknown): number {
	return Buffer.byteLength(JSON.stringify(entry), "utf8");
}

/** 已保留的三类可变明细条数（输出字节包络的括号/逗号判据）。 */
function retainedDetails(scan: ScanState): number {
	return scan.summaries.length + scan.problems.length + scan.manual.length;
}

/** 已保留的"问题 + 人工事项"条数：`maxProblems` 只约束这两类，不含摘要。 */
function retainedIssues(scan: ScanState): number {
	return scan.problems.length + scan.manual.length;
}

/**
 * 三类明细共享的**输出字节包络**（BM-02C3R / PF-3）。
 *
 * 口径：把三类明细按「摘要 → 问题 → 人工事项」合并成一个 JSON 数组，计其 UTF-8 字节数。
 * 增量记账规则与 `JSON.stringify([…])` 逐字节等价：
 * - 第一条：`JSON.stringify(entry)` 的字节 + `[` + `]` 共 2 字节；
 * - 之后每条：前一条的 `,` 1 字节 + 本条字节（最后一条的 `]` 已在第一条时计入）；
 * - 没有任何明细 = 0 字节（空载荷不预留空数组括号，也不计固定报告信封）。
 *
 * 这样既避免每次全量重算的平方成本，又不会漏掉数组括号/分隔符（旧实现逐条累加，
 * 少算 `n+1` 字节，`outputBytes` 恒低于真实序列化结果）。
 * 返回 `false` 表示按字节预算被拒（调用方负责标记截断）。
 */
function chargeDetail(scan: ScanState, entry: unknown): boolean {
	const bytes = measure(entry) + (retainedDetails(scan) === 0 ? 2 : 1);
	if (scan.outputBytes + bytes > scan.limits.maxOutputBytes) return false;
	scan.outputBytes += bytes;
	return true;
}

/** 摘要条数/输出字节双预算；返回 `false` 表示已停止扫描。 */
export function addSummary(scan: ScanState, entry: PreflightFileSummary): boolean {
	if (scan.stopped) return false;
	if (scan.summaries.length >= scan.limits.maxFileSummaries) {
		scan.droppedSummaries += 1;
		scan.truncatedBy.add("file-summaries");
		return true;
	}
	if (!chargeDetail(scan, entry)) {
		scan.droppedSummaries += 1;
		stopScan(scan, "output-bytes");
		return false;
	}
	scan.summaries.push(entry);
	return true;
}

/**
 * 问题条数/输出字节双预算。
 *
 * 条数走**与人工事项共享**的额度（`problems.length + manual.length <= maxProblems`），
 * 阻断计数**先于**预算累加，永远不被裁剪。
 */
export function addProblem(scan: ScanState, problem: PreflightProblem): void {
	if (problem.blocks) scan.blockingProblems += 1;
	if (scan.stopped) return;
	if (retainedIssues(scan) >= scan.limits.maxProblems) {
		scan.droppedProblems += 1;
		scan.truncatedBy.add("problems");
		return;
	}
	if (!chargeDetail(scan, problem)) {
		scan.droppedProblems += 1;
		stopScan(scan, "output-bytes");
		return;
	}
	scan.problems.push(problem);
}

/** 人工核对事项：与问题共用同一份条数额度，但**总计永不被裁剪**。 */
export function addManual(scan: ScanState, item: PreflightManualItem): void {
	scan.manualItems += 1;
	scan.blockingProblems += 1;
	if (scan.stopped) return;
	if (retainedIssues(scan) >= scan.limits.maxProblems) {
		scan.droppedProblems += 1;
		scan.truncatedBy.add("problems");
		return;
	}
	if (!chargeDetail(scan, item)) {
		scan.droppedProblems += 1;
		stopScan(scan, "output-bytes");
		return;
	}
	scan.manual.push(item);
}

export function countVersion(scan: ScanState, family: PreflightVersionFamily, version: number | null): void {
	const key = `${family}:${version === null ? "unknown" : String(version)}`;
	const current = scan.versions.get(key);
	if (current === undefined) {
		scan.versions.set(key, { family, version, files: 1 });
		return;
	}
	current.files += 1;
}

/** 诊断文案统一截断（含显式标记）；**空上限 = 空文案**，不是"不截断"。 */
export function boundMessage(scan: ScanState, message: string): string {
	const max = scan.limits.maxIssueChars;
	if (max <= 0) return "";
	if (message.length <= max) return message;
	return `${message.slice(0, max - 1)}…`;
}

/** 不受控条目名的占位路径（名称本身省略：诊断不能成为泄漏通道）。 */
export function placeholderPath(parent: string): string {
	return `${parent}/#unknown-name`;
}

/** 单文件读取（有界 + 预算分账）。`stopped` 表示预算已耗尽且**不**产生问题条目。 */
export type BoundedRead = { kind: "ok"; value: unknown; bytes: number } | { kind: "failed"; code: PreflightCode; message: string } | { kind: "stopped" };

export async function readJsonBounded(scan: ScanState, absolute: string, perFileCap?: number): Promise<BoundedRead> {
	assertNotCancelled(scan);
	// 预算已停止（含 S3 的条目预算锁存）：不再读取新候选，也不另报问题条目。
	if (isScanStopped(scan)) return { kind: "stopped" };
	const reserved = reserveRead(scan, perFileCap);
	if (reserved === null) return { kind: "stopped" };
	try {
		const { value, bytes } = await scan.boundary.readJson(absolute, reserved, scan.boundary.signal);
		settleRead(scan, bytes);
		return { kind: "ok", value, bytes };
	} catch (error) {
		if (isCancelledError(error)) throw error;
		failRead(scan, reserved);
		if (isStorageError(error)) {
			const detail = error.detail === undefined ? "" : `（${error.detail}）`;
			return { kind: "failed", code: error.code, message: `无法读取：${error.code}${detail}` };
		}
		return { kind: "failed", code: "unreadable", message: "无法读取（未分类错误）" };
	}
}

/** 记录一次"读取失败"问题（状态由错误码推导，避免各处各写一套）。 */
export function statusForCode(code: PreflightCode): PreflightFileStatus {
	if (code === "permission-denied" || code === "unreadable") return "unreadable";
	if (code === "not-found") return "missing";
	if (code === "unsupported-schema-version" || code === "unsupported-journal-version" || code === "unsupported-audit-version" || code === "unsupported-audit-intent-version") return "unsupported-version";
	return "invalid";
}

export function reportReadFailure(scan: ScanState, args: { category: PreflightCategory; relativePath: string; family: PreflightVersionFamily; code: PreflightCode; message: string; blocks?: boolean }): void {
	const status = statusForCode(args.code);
	countVersion(scan, args.family, null);
	addSummary(scan, { category: args.category, relativePath: args.relativePath, status, version: null, code: args.code });
	addProblem(scan, { category: args.category, relativePath: args.relativePath, status, code: args.code, message: boundMessage(scan, args.message), blocks: args.blocks ?? true });
}

/** 把一次"读到的值"变成摘要 +（必要时）问题 +（必要时）人工事项。 */
export function recordVerdict(scan: ScanState, args: { category: PreflightCategory; relativePath: string; family: PreflightVersionFamily; verdict: FileVerdict }): void {
	const { category, relativePath, family, verdict } = args;
	countVersion(scan, family, verdict.version);
	addSummary(scan, { category, relativePath, status: verdict.status, version: verdict.version, code: verdict.code });
	if (verdict.ok) {
		if (verdict.manualReason !== undefined) {
			addManual(scan, { category, relativePath, reason: verdict.manualReason, message: boundMessage(scan, verdict.message ?? "需要人工核对") });
		}
		return;
	}
	addProblem(scan, {
		category,
		relativePath,
		status: verdict.status,
		code: verdict.code,
		message: boundMessage(scan, verdict.message ?? "不符合当前支持的格式"),
		blocks: verdict.blocks ?? true,
	});
}

export type DirectoryListing = { entries: readonly string[] } | { error: { code: PreflightCode; message: string } } | { absent: true } | { stopped: true };

/**
 * 有界列目录（不跟随链接；条目数与扫描预算共享）。
 *
 * `required=false` 时"目录不存在"是**未使用**而不是问题（旧初始化库没有 journal/audit）。
 * 探测/列举失败一律以 `{ error }` 交回（由调用方按受控类别收集成问题后继续检查后续类别），
 * **只有取消**会继续向外抛。
 */
export async function listEntriesBounded(scan: ScanState, absolute: string, required: boolean): Promise<DirectoryListing> {
	assertNotCancelled(scan);
	// 预算已耗尽（`stopped`），或条目预算因唯一超限探测已消耗而锁存（S3）：都不再发起新的列举 IO。
	if (isScanStopped(scan)) return { stopped: true };
	const probe = await probePath(scan, absolute);
	if (probe.kind === "failed") return { error: { code: probe.code, message: probe.message } };
	if (probe.kind === "absent") return required ? { error: { code: "not-found", message: "目录不存在" } } : { absent: true };
	if (probe.kind === "link") return { error: { code: "symlink-rejected", message: "拒绝扫描链接目录（不跟随、不读取链接目标）" } };

	const remaining = scan.limits.maxScanEntries - usedEntryBudget(scan);
	// **唯一计费来源（S1 / S2）**：观察计量走 Boundary 的受控回调——它每实际观察到一个条目
	// 就回调一次（累计值），于是"成功 / 截断 / 迭代中途失败"三种出口都只经过这一段代码。
	// 因此这里**不再**叠加 `listing.scanned`：成功路径不会双计，失败路径也不会丢掉成本。
	const baseline = scan.scannedEntries;
	try {
		const listing = await scan.boundary.listEntries(absolute, {
			filesOnly: false,
			maxEntries: Math.max(0, remaining),
			signal: scan.boundary.signal,
			includeSymlinks: true,
			observe: (observed) => {
				scan.scannedEntries = baseline + observed;
				// **S3 锁存点**：这一条已让真实观察越过条目预算 ⇒ 它就是唯一的超限探测条目。
				// 停止必须**就地**成立，不能等 `listEntries` 成功返回后再 `stopScan`：收尾（break 的
				// `return()`）或关闭失败时函数会走 catch，那段"已触顶"会随异常丢掉，下一类别就会拿
				// 剩余 0 额度再列举、再探测一次。这里只记截断原因、**不设** `stopped`——本类别紧接着
				// 要把这条受控错误记进问题列表，而 `stopped` 会挡掉明细记录。
				if (usedEntryBudget(scan) > scan.limits.maxScanEntries) scan.truncatedBy.add("scan-entries");
			},
		});
		if (listing.truncated) {
			// 截断时底层观察到 `remaining + 1` 条（末条是**唯一**允许的超限探测条目）：
			// 因此真实观察总数 ≤ `maxScanEntries + 1`。名字不再交给调用方处理，
			// 所以这里返回 `stopped` 不会让同一条目重复扣账。
			stopScan(scan, "scan-entries");
			return { stopped: true };
		}
		return { entries: listing.names };
	} catch (error) {
		// 迭代中途失败（S2）：`observe` 已把失败前交出的条目计入 `scannedEntries`，
		// 后续类别只能用**真实剩余额度**；这里照旧把错误收敛成受控问题（不提交原始正文），
		// 取消仍然穿透。零观察失败不会制造虚假成本（回调从未触发）。
		if (isCancelledError(error)) throw error;
		if (isStorageError(error)) {
			// `ENOTDIR`（这里应该是目录却是个文件）在 `mapFsError` 里落成 `not-found`：
			// 靠 `detail` 把它还原成"不是目录"，否则一个占位文件会被当成"目录不存在"。
			if (error.detail === "ENOTDIR") return { error: { code: "not-a-file", message: "这里应该是目录，但存在同名文件" } };
			return { error: { code: error.code, message: `无法列出目录：${error.code}` } };
		}
		return { error: { code: "unreadable", message: "无法列出目录" } };
	}
}

/** 预检只走固定落点（不递归未知目录），布局仍由存储层同一份实现给出。 */
export function layoutOf(boundary: StorageBoundary): ReturnType<typeof knowledgeLayout> {
	return knowledgeLayout(boundary);
}
