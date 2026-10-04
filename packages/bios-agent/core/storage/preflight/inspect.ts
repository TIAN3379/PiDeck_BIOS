/**
 * 知识库版本盘点与迁移预检（BM-02C3）——**入口**。
 *
 * 只回答"这份知识库包含哪些格式版本 / 哪些文件无法解释 / 是否需要迁移 / 有哪些阻断事项"。
 * 它**不是**整库一致性证明，也不是备份许可：
 *
 * - 只有**观察式**扫描语义（逐文件看，不是原子快照）；
 * - 不写任何字节：不初始化、不建目录、不加锁、不发布临时文件、不调用 reconcile、不清理残留；
 * - 不判断迁移：当前只有一套业务 `schemaVersion=1`，普通 journal v1 与审核 journal v2
 *   **合法共存**（不是新旧业务格式），因此没有 v0→v1 之类的迁移规则可编造；
 * - 任何截断都只能得到 `incomplete`，永远不会返回"可以迁移 / 无需迁移"的假通过。
 *
 * 分工：本文件只做入口与结论组装；**落点遍历**在 `categories.ts`，**分类策略**在 `verdicts.ts`，
 * **预算与报告原语**在 `scan.ts`。
 */
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { isCancelledError, isStorageError, StorageError, throwIfAnyCancelled } from "../errors.ts";
import { scanAuditDirectory, scanJournalDirectory, scanProjects, scanRecordDirectory, scanRegistry } from "./categories.ts";
import { scanCacheDirectory, scanLocksDirectory, scanRootExtras } from "./auxiliaryCategories.ts";
import { PREFLIGHT_SCAN_SEMANTICS, SUPPORTED_PREFLIGHT_VERSIONS, type PreflightOutcome, type PreflightReport, type PreflightVersionCount } from "./contract.ts";
import { resolvePreflightLimits, type PreflightLimits } from "./limits.ts";
import { assertNotCancelled, createScanState, isScanStopped, type ScanState } from "./scan.ts";

export type InspectKnowledgeStoreOptions = {
	/** 完全限定的知识根（预检**不会**自动读取默认用户知识库）。 */
	root: string;
	limits?: Partial<PreflightLimits>;
	signal?: AbortSignal;
	/** 受控 IO 故障注入（仅测试；见 boundary.ts 的 StorageIoHooks）。 */
	ioHooks?: StorageIoHooks;
};

export async function inspectKnowledgeStore(options: InspectKnowledgeStoreOptions): Promise<PreflightReport> {
	const limits = resolvePreflightLimits(options.limits);
	// 根非法/链接/不存在在这里就失败：预检**不**降级成"空库"，也不调用初始化 API。
	const boundary = await createStorageBoundary({ root: options.root, signal: options.signal, ioHooks: options.ioHooks });
	const scan = createScanState(boundary, limits);

	assertNotCancelled(scan);
	const registered = await scanRegistry(scan);
	// 门控用 `isScanStopped`（`stopped` 或条目预算锁存）：条目预算一旦锁存，
	// 连只做一次 `stat` 的 `cache/` 探测（不经 `listEntriesBounded`）也必须跳过（S3）。
	if (!isScanStopped(scan)) await scanProjects(scan, registered);
	if (!isScanStopped(scan)) await scanRecordDirectory(scan, { directory: boundary.resolve("experiences"), kind: "experience-card", collection: "experiences" });
	if (!isScanStopped(scan)) await scanRecordDirectory(scan, { directory: boundary.resolve("features"), kind: "feature-record", collection: "features" });
	if (!isScanStopped(scan)) await scanJournalDirectory(scan);
	if (!isScanStopped(scan)) await scanAuditDirectory(scan);
	if (!isScanStopped(scan)) await scanLocksDirectory(scan);
	if (!isScanStopped(scan)) await scanCacheDirectory(scan);
	if (!isScanStopped(scan)) await scanRootExtras(scan);
	assertNotCancelled(scan);
	throwIfAnyCancelled([boundary.signal]);

	return buildReport(scan, boundary);
}

function buildReport(scan: ScanState, boundary: StorageBoundary): PreflightReport {
	const truncatedBy = [...scan.truncatedBy];
	// 唯一总体结论：截断优先（"看不完"不能算通过），其次才是阻断事项。
	const complete = !isScanStopped(scan) && truncatedBy.length === 0;
	const outcome: PreflightOutcome = !complete ? "incomplete" : scan.blockingProblems > 0 ? "blocked" : "no-migration-needed";
	const versions: PreflightVersionCount[] = [...scan.versions.values()].map((entry) => ({ family: entry.family, version: entry.version, files: entry.files })).sort((left, right) => (left.family === right.family ? (left.version ?? -1) - (right.version ?? -1) : left.family < right.family ? -1 : 1));
	return {
		root: boundary.root,
		scanSemantics: PREFLIGHT_SCAN_SEMANTICS,
		outcome,
		complete,
		truncatedBy,
		scannedEntries: scan.scannedEntries,
		readBytes: scan.readBytes,
		reservedBytes: scan.reservedBytes,
		readFiles: scan.readFiles,
		supportedVersions: SUPPORTED_PREFLIGHT_VERSIONS,
		versions,
		summaries: scan.summaries,
		droppedSummaries: scan.droppedSummaries,
		problems: scan.problems,
		droppedProblems: scan.droppedProblems,
		blockingProblems: scan.blockingProblems,
		manual: scan.manual,
		manualItems: scan.manualItems,
		limits: scan.limits,
		outputBytes: scan.outputBytes,
	};
}

/** 预检自身的失败都是结构化错误（根非法、限额非法、取消）：便于调用方分类处理。 */
export function isPreflightError(error: unknown): error is StorageError {
	return isStorageError(error);
}

/** 取消必须穿透（不得被吞成"扫描完成"）。 */
export function isPreflightCancelled(error: unknown): boolean {
	return isCancelledError(error);
}
