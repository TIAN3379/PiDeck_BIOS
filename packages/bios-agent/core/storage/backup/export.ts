/**
 * 离线导出：把一份**已通过准入**的知识库复制成根外的 `manifest.json` ＋ `data/`（BM-02D2 / D2R）。
 *
 * 顺序是这份实现的核心，任何一步都不能省：
 *
 * 1. **参数与限额**先于任何 IO（含显式离线确认；不自动创建父目录、不读默认真实用户库）；
 * 2. **父链链接拒绝与 canonical 重叠判定**（按路径段，不用字符串前缀）与**排他创建目标**
 *    ——目标靠"我创建成功了"取得，并且**取得即登记身份**；
 * 3. **预检准入**：`complete`、`no-migration-needed`、无截断/裁剪、无阻断问题、无人工事项；
 * 4. **受控 inventory**（固定深度，与 D1 落点表同一份判据）：未知落点/链接/`.tmp` 即失败；
 * 5. **原字节复制**：有界读 + 实际字节计量 + SHA-256 + 独占写入（不 parse/stringify 改写 payload）；
 * 6. **源变化检测**：重新盘点、重跑预检、重读源 payload 比对 hash；
 * 7. **容器实际集合核对**（D2-2）：根条目、目录、文件、类型与清单**全量**比对，多一个少一个都不发布；
 * 8. **逐文件回读复核**：只回读仍归本调用所有的文件，按 D1 口径重算长度与 hash；
 * 9. **最后发布 `manifest.json`**：非覆盖发布成功才是提交点；此前失败/取消都要按归属清理本次创建的内容。
 *
 * 失败一律经 `sanitizeBackupFailure` 收口：受控类别 + 受控阶段 + 结构化收尾事实，
 * 不透传原始异常正文、源绝对路径或未知条目名。
 */
import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { isValidKnowledgeId } from "../../contracts/index.ts";
import { isFullyQualifiedPath } from "../../paths.ts";
import { createStorageBoundary, type StorageBoundary, type StorageIoHooks } from "../boundary.ts";
import { StorageError, throwIfAnyCancelled } from "../errors.ts";
import { inspectKnowledgeStore, type PreflightLimits, type PreflightReport } from "../preflight/index.ts";
import { assertContainerMatchesManifest, enumerateContainer } from "./container.ts";
import { BACKUP_CONSISTENCY, BACKUP_DATA_DIR_NAME, BACKUP_EXCLUDED_DIRECTORIES, BACKUP_MANIFEST_FILE_NAME, BACKUP_MANIFEST_VERSION, BACKUP_MAX_DATE_MS, type BackupManifest, type BackupManifestFile } from "./contract.ts";
import { sanitizeBackupFailure, type BackupPhase } from "./failure.ts";
import { collectSourceInventory, inventorySignature, type SourceInventory } from "./inventory.ts";
import { resolveBackupLimits, type BackupLimits } from "./limits.ts";
import { measureBackupManifestBytes, validateBackupManifest } from "./manifest.ts";
import { assertPathsDisjoint } from "./pathCompare.ts";
import { acquireTargetRoot, cleanupOwned, createOwnedDirectory, createTargetSession, publishOwnedManifest, readOwnedFileBounded, rejectParentChainLink, resolveTargetParent, targetName, targetRootOf, writeOwnedFile, type TargetSession } from "./target.ts";
import { measureBackupPayload } from "./verify.ts";

/** `data/` 目录名与完成标记文件名在契约层定义（`contract.ts`），导出/恢复共用同一形状。 */
export { BACKUP_DATA_DIR_NAME, BACKUP_MANIFEST_FILE_NAME } from "./contract.ts";

export type ExportKnowledgeBackupOptions = {
	/** 完全限定的源知识根（不读默认真实用户库）。 */
	readonly root: string;
	/** 完全限定、**尚不存在**的目标目录；其父目录必须已存在。 */
	readonly backupRoot: string;
	/** 调用者声明已关闭使用该知识根的所有写入者；不是 `true` 就在任何输出创建前拒绝。 */
	readonly offlineConfirmed: true;
	readonly limits?: Partial<BackupLimits>;
	readonly preflightLimits?: Partial<PreflightLimits>;
	readonly signal?: AbortSignal;
	/** 注入（测试用）：确定化 `backupId` / `createdAt`。 */
	readonly backupId?: string;
	readonly now?: number;
	/**
	 * 受控 IO 注入（仅测试；与 storage 的 `StorageIoHooks` 同一个出口）。
	 *
	 * 取消、源在复制期间变化、目标回读被改坏这些时序如果只能用 sleep 或目录偶然顺序去碰，
	 * 测试就变成"偶尔红"。它只影响时序钩子与句柄关闭策略，**默认行为仍是真实 fs**。
	 */
	readonly ioHooks?: StorageIoHooks;
};

export type ExportKnowledgeBackupResult = {
	readonly status: "exported";
	/** 调用方显式指定的目标目录（canonical）。 */
	readonly backupRoot: string;
	readonly backupId: string;
	readonly createdAt: number;
	readonly consistency: typeof BACKUP_CONSISTENCY;
	readonly files: number;
	readonly directories: number;
	readonly totalBytes: number;
	/** 完成标记已经发布（提交点）。 */
	readonly published: true;
	/** 提交点之后的清理结果；`failed` 时残留已如实报告，需人工处理。 */
	readonly cleanup: "ok" | "failed";
	/** 未能清理的有界残留样本（相对容器的受控路径，最多 5 条）。 */
	readonly residuals: readonly string[];
};

type Lifecycle = { phase: BackupPhase; published: boolean; cleanup: "ok" | "failed"; residuals: string[] };

/* ------------------------------------------------------------------ 判定辅助 */

function argumentError(message: string, detail: string): StorageError {
	return new StorageError("backup-argument-invalid", message, { detail });
}

/** 预检准入：只有"完整、无阻断、无人工事项、无诊断裁剪"的源才允许导出。 */
function assertEligible(report: PreflightReport, stage: string): void {
	const reasons: string[] = [];
	if (!report.complete) reasons.push("预检不完整");
	if (report.outcome !== "no-migration-needed") reasons.push(`预检结论为 ${report.outcome}`);
	if (report.truncatedBy.length > 0) reasons.push(`存在截断（${report.truncatedBy.join("/")}）`);
	if (report.droppedSummaries > 0 || report.droppedProblems > 0) reasons.push("诊断被预算裁剪");
	if (report.blockingProblems > 0 || report.problems.length > 0) reasons.push("存在问题/阻断条目");
	if (report.manualItems > 0 || report.manual.length > 0) reasons.push("存在人工核对事项（锁、残留或审核状态）");
	if (reasons.length === 0) return;
	throw new StorageError("backup-source-not-eligible", `源知识库不满足备份准入（${stage}）：${reasons.join("；")}`, { detail: "preflight-not-eligible" });
}

/** 复制前就把明显的资源超限挡掉（真正的逐文件计量仍会发生）。 */
function assertInventoryWithinBudgets(inventory: SourceInventory, limits: BackupLimits): void {
	if (inventory.files.length > limits.maxFiles) throw new StorageError("too-large", `文件项数超过备份预算 ${limits.maxFiles}`, { detail: "too-many-files" });
	if (inventory.directories.length > limits.maxDirectories) throw new StorageError("too-large", `目录项数超过备份预算 ${limits.maxDirectories}`, { detail: "too-many-directories" });
}

/* ------------------------------------------------------------------ 主流程 */

export async function exportKnowledgeBackup(options: ExportKnowledgeBackupOptions): Promise<ExportKnowledgeBackupResult> {
	const lifecycle: Lifecycle = { phase: "argument", published: false, cleanup: "ok", residuals: [] };
	let session: TargetSession | undefined;
	try {
		return await runExport(options, lifecycle, (created) => {
			session = created;
		});
	} catch (error) {
		// 取消与任何失败走同一收尾：未提交则按归属清理本次创建的内容，再统一脱敏。
		if (session !== undefined && !lifecycle.published) {
			try {
				const cleanup = await cleanupOwned(session);
				lifecycle.cleanup = cleanup.cleanup;
				lifecycle.residuals = [...cleanup.residuals];
			} catch {
				lifecycle.cleanup = "failed";
			}
		}
		throw sanitizeBackupFailure(error, "export", { phase: lifecycle.phase, published: lifecycle.published, cleanup: lifecycle.cleanup, residuals: lifecycle.residuals });
	}
}

async function runExport(options: ExportKnowledgeBackupOptions, lifecycle: Lifecycle, register: (session: TargetSession) => void): Promise<ExportKnowledgeBackupResult> {
	// ---- 1. 参数与限额（任何输出创建之前）----
	const limits = resolveBackupLimits(options.limits);
	if (options.offlineConfirmed !== true) throw argumentError("必须显式确认已关闭使用该知识根的所有写入者（offlineConfirmed: true）", "offline-not-confirmed");
	if (typeof options.root !== "string" || !isFullyQualifiedPath(options.root)) throw argumentError("root 必须是完全限定的绝对路径", "invalid-root");
	if (typeof options.backupRoot !== "string" || !isFullyQualifiedPath(options.backupRoot)) throw argumentError("backupRoot 必须是完全限定的绝对路径", "invalid-backup-root");
	const createdAt = options.now ?? Date.now();
	if (!Number.isSafeInteger(createdAt) || createdAt < 0 || createdAt > BACKUP_MAX_DATE_MS) throw argumentError("now 必须是合法时间戳范围内的安全整数", "invalid-now");
	const backupId = options.backupId ?? randomUUID();
	if (!isValidKnowledgeId(backupId)) throw argumentError("backupId 不符合既有知识 ID 判据", "invalid-backup-id");

	// ---- 2. 源边界 / 目标 canonical 父链 / 重叠判定 ----
	const boundary = await createStorageBoundary({ root: options.root, signal: options.signal, ioHooks: options.ioHooks });
	const parent = await resolveTargetParent(options.backupRoot, "备份目标");
	const backupRoot = targetRootOf(parent.canonicalParent, targetName(options.backupRoot));
	// 顺序有意如此：先按 canonical 判重叠（"词法分离但解析后重叠"必须报 overlap），再拒父链链接。
	assertPathsDisjoint(backupRoot, boundary.canonicalRoot, "备份目标与源知识根重叠（相同、目标在源内或源在目标内），拒绝导出");
	if (parent.chainLink) rejectParentChainLink("备份目标");

	const session = createTargetSession({
		signal: options.signal,
		beforeIo: boundary.beforeIo,
		closeFile: options.ioHooks?.closeFile ?? ((handle) => handle.close()),
		targetRoot: backupRoot,
	});
	register(session);

	// ---- 3. 准入（复制前）----
	lifecycle.phase = "admission";
	assertEligible(await inspectKnowledgeStore({ root: boundary.root, limits: options.preflightLimits, signal: options.signal }), "复制前");

	// ---- 4. 受控 inventory ----
	lifecycle.phase = "inventory";
	const before = await collectSourceInventory(boundary, limits, options.signal);
	assertInventoryWithinBudgets(before, limits);

	// ---- 5. 排他创建目标：成功后目标里的一切都属于本次调用 ----
	lifecycle.phase = "acquire-target";
	await acquireTargetRoot(session, options.signal);

	// ---- 6. 目录与文件复制 ----
	lifecycle.phase = "copy";
	const { files, totalBytes } = await copyPayload(session, boundary, before, limits, options.signal);

	// ---- 7. 源变化检测：集合、准入结论与逐文件字节都要和复制时一致 ----
	lifecycle.phase = "recheck-source";
	const after = await collectSourceInventory(boundary, limits, options.signal);
	if (inventorySignature(after) !== inventorySignature(before)) throw new StorageError("backup-source-changed", "复制期间源目录/文件集合发生变化，本次导出不是一致复制", { detail: "inventory-changed" });
	assertEligible(await inspectKnowledgeStore({ root: boundary.root, limits: options.preflightLimits, signal: options.signal }), "复制后");
	for (const entry of files) {
		const recheck = await boundary.readRawBytes(boundary.resolve(...entry.path.split("/")), Math.min(limits.maxFileBytes, limits.maxTotalPayloadBytes), options.signal);
		if (recheck.total !== entry.bytes || recheck.fingerprint !== entry.sha256) throw new StorageError("backup-source-changed", "复制期间源文件内容发生变化，本次导出不是一致复制", { detail: "payload-changed" });
	}

	// ---- 8. 清单（先按协议校验，再用于核对容器实际集合）----
	const manifest: BackupManifest = {
		backupVersion: BACKUP_MANIFEST_VERSION,
		backupId,
		createdAt,
		consistency: BACKUP_CONSISTENCY,
		exclusions: [...BACKUP_EXCLUDED_DIRECTORIES],
		directories: [...before.directories],
		files,
	};
	const validated = validateBackupManifest(manifest, options.limits);
	if (!validated.ok) throw new StorageError("invalid-backup-manifest", "内部构造的清单未通过协议校验，拒绝发布", { detail: validated.issues[0]?.code ?? "invalid-backup-manifest" });

	// ---- 9. 逐文件回读复核：只回读仍归本调用所有的文件 ----
	lifecycle.phase = "verify-hash";
	for (const entry of validated.manifest.files) {
		const bytes = await readOwnedFileBounded(session, `${BACKUP_DATA_DIR_NAME}/${entry.path}`, limits.maxFileBytes, options.signal);
		const measured = measureBackupPayload(bytes);
		if (measured === undefined || measured.byteLength !== entry.bytes || measured.sha256 !== entry.sha256) {
			throw new StorageError("backup-payload-mismatch", "备份目标回读与清单不一致，拒绝发布完成标记", { detail: "readback-mismatch" });
		}
	}

	// ---- 10. 容器实际集合核对（D2-2）：**最后**一道复核，多一个少一个都不发布 ----
	// 放在逐文件回读**之后**：这样"回读前被塞进来的额外文件/删掉的空目录/换成的链接"都还在
	// 最终验证的窗口里，而不是落在两次复核之间。
	lifecycle.phase = "verify-container";
	// 传入**已验证的清单集合**（R24-2）：盘点遇到未声明的目录/文件就地拒绝，不进入未知子树。
	const inventory = await enumerateContainer(session.runtime, backupRoot, limits, options.signal, {
		directories: new Set(validated.manifest.directories),
		files: new Set(validated.manifest.files.map((file) => file.path)),
	});
	assertContainerMatchesManifest(inventory, validated.manifest, { manifestPresent: false });

	// ---- 11. 最后发布完成标记 ----
	const manifestBytes = Buffer.from(JSON.stringify(validated.manifest), "utf8");
	if (measureBackupManifestBytes(validated.manifest) > limits.maxManifestBytes) throw new StorageError("too-large", `清单字节超过预算 ${limits.maxManifestBytes}`, { detail: "manifest-too-large" });
	lifecycle.phase = "publish";
	const outcome = await publishOwnedManifest(session, BACKUP_MANIFEST_FILE_NAME, manifestBytes, options.signal);
	// 提交点已过：迟到取消/临时残留失败都只如实报告，**不回滚**已完成的备份。
	lifecycle.published = true;
	if (!outcome.tempRemoved) {
		lifecycle.cleanup = "failed";
		lifecycle.residuals = [outcome.tempRelative];
	}

	return {
		status: "exported",
		backupRoot,
		backupId: validated.manifest.backupId,
		createdAt: validated.manifest.createdAt,
		consistency: BACKUP_CONSISTENCY,
		files: validated.manifest.files.length,
		directories: validated.manifest.directories.length,
		totalBytes,
		published: true,
		cleanup: lifecycle.cleanup,
		residuals: [...lifecycle.residuals],
	};
}

/** 建目录 + 逐文件复制；长度、总量与 hash 都来自这一次真实读取。 */
async function copyPayload(session: TargetSession, boundary: StorageBoundary, source: SourceInventory, limits: BackupLimits, signal: AbortSignal | undefined): Promise<{ files: BackupManifestFile[]; totalBytes: number }> {
	const files: BackupManifestFile[] = [];
	let totalBytes = 0;

	await createOwnedDirectory(session, BACKUP_DATA_DIR_NAME, signal);
	for (const relative of source.directories) await createOwnedDirectory(session, `${BACKUP_DATA_DIR_NAME}/${relative}`, signal);

	for (const file of source.files) {
		throwIfAnyCancelled([signal, session.runtime.signal]);
		const remainingTotal = limits.maxTotalPayloadBytes - totalBytes;
		if (remainingTotal <= 0) throw new StorageError("too-large", `payload 总字节达到预算 ${limits.maxTotalPayloadBytes}，拒绝继续复制`, { detail: "payload-too-large" });
		const read = await boundary.readRawBytes(file.absolute, Math.min(limits.maxFileBytes, remainingTotal), signal);
		await writeOwnedFile(session, `${BACKUP_DATA_DIR_NAME}/${file.path}`, read.bytes, signal);
		files.push({ path: file.path, bytes: read.total, sha256: read.fingerprint });
		totalBytes += read.total;
	}
	return { files, totalBytes };
}
