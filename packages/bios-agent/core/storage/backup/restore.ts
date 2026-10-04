/**
 * 知识库恢复（BM-02D3）：把一份**已通过准入的离线备份**恢复到**尚不存在的新知识根**。
 *
 * 顺序是这份实现的核心，任何一步都不能省：
 *
 * 1. **参数与限额**先于任何 IO（含显式离线确认；不回退到默认真实用户库、不自动创建父链）；
 * 2. **两侧父链**都要解析：备份容器的真实父目录与"恢复目标"的规范父目录；
 *    先按 canonical 判**重叠**，再拒绝父链链接（顺序变了会改变受控类别）；
 * 3. **只读备份准入**（`restoreSource.ts`）：完成标记协议校验 → 容器真实集合全量比对 →
 *    逐文件长度/SHA-256 → `<备份根>/data` 的只读预检（业务/工件版本必须可解释）；
 * 4. **排他取得新根**：`mkdir` 非递归，已存在（空目录、旧库、半成品、文件或链接）即冲突；
 *    取得即登记身份，之后写入/删除前逐级复核祖先链（复用 D2R 修正后的原语）；
 * 5. **按清单建目录** + 另建**空** `cache`/`locks`；除 registry 外逐文件复制并**回读核对**；
 * 6. **目标集合核对**：实际目录/文件集合必须与清单派生布局全量相等（漏建空目录或外部多写都要暴露）；
 * 7. **复核备份未变**：重跑容器集合、逐文件字节与预检——等长改写也要被发现；
 * 8. **原 registry 字节最后非覆盖发布**（`publishOwnedManifest`）= **完成点**；
 * 9. **发布后复核**：用现有预检确认新库可解释；失败/取消只报告"已提交，需复核"，
 *    **不删掉已恢复的库**、不伪称未写入。
 *
 * 边界：只承诺 offline-copy 与可验证的发布点，不承诺网络盘/断电原子恢复，
 * 也不隔离同机恶意写入者；registry 里原来的工作区**绝对路径原样保留**（不迁移 BIOS 源码、
 * 不重新绑定、不证明原路径在本机仍在线）。
 */
import { lstat } from "node:fs/promises";
import { isFullyQualifiedPath } from "../../paths.ts";
import type { StorageIoHooks } from "../boundary.ts";
import { fsErrorCode, isCancelledError, isNotFoundError, StorageError } from "../errors.ts";
import { inspectKnowledgeStore, type PreflightLimits } from "../preflight/index.ts";
import { sanitizeBackupFailure, type BackupPhase } from "./failure.ts";
import { resolveBackupLimits, type BackupLimits } from "./limits.ts";
import { assertPathsDisjoint } from "./pathCompare.ts";
import { assertBackupContentEligible, assertBackupManifestUnchanged, backupContentReasons, readBackupManifestWithFingerprint, readBackupPayload, verifyBackupContainer } from "./restoreSource.ts";
import { RESTORE_EMPTY_DIRECTORIES, RESTORE_REGISTRY_RELATIVE, verifyTargetAgainstManifest } from "./restoreTarget.ts";
import { acquireTargetRoot, cleanupOwned, createOwnedDirectory, createTargetSession, publishOwnedManifest, readOwnedFileBounded, rejectParentChainLink, resolveTargetParent, targetName, targetRootOf, writeOwnedFile, type TargetRuntime, type TargetSession } from "./target.ts";
import { measureBackupPayload } from "./verify.ts";

export type RestoreKnowledgeBackupOptions = {
	/** 完全限定的**已完成备份容器**（`manifest.json` + `data/`），不是 `data/` 子目录。 */
	readonly backupRoot: string;
	/** 完全限定、**尚不存在**的新知识根；其父目录必须已存在。 */
	readonly root: string;
	/** 调用者声明备份容器不被修改、目标不被其它进程使用；不是 `true` 就在任何目标创建前拒绝。 */
	readonly offlineConfirmed: true;
	readonly limits?: Partial<BackupLimits>;
	readonly preflightLimits?: Partial<PreflightLimits>;
	readonly signal?: AbortSignal;
	/** 受控 IO 注入（仅测试；与 storage 的 `StorageIoHooks` 同一个出口）。 */
	readonly ioHooks?: StorageIoHooks;
};

/** 发布后的**受控**复核结论标签（固定枚举，不含路径/正文）。 */
export type RestoreReviewReason = "cleanup-failed" | "verify-restored-drift" | "verify-restored-failed" | "verify-restored-error" | "cancelled-after-publish";

export type RestoreKnowledgeBackupResult = {
	/** `restored` 仅在"已提交且复核无问题"时返回；其余都是 `committed-needs-review`。 */
	readonly status: "restored" | "committed-needs-review";
	/** 恢复目标（canonical 父目录 + 名字）。 */
	readonly root: string;
	readonly backupRoot: string;
	readonly backupId: string;
	readonly files: number;
	/** 恢复出的目录数（清单目录 + 空 `cache`/`locks`）。 */
	readonly directories: number;
	readonly totalBytes: number;
	/** registry 非覆盖发布成功（提交点已过）。 */
	readonly published: true;
	/** 提交点之后的清理结果；`failed` 时残留已如实报告，需人工处理。 */
	readonly cleanup: "ok" | "failed";
	/** 未能清理的有界残留样本（受控相对路径，最多 5 条）。 */
	readonly residuals: readonly string[];
	/** 需要人工复核的受控原因；空数组表示无警告。 */
	readonly reviewReasons: readonly RestoreReviewReason[];
};

type Lifecycle = { phase: BackupPhase; published: boolean; cleanup: "ok" | "failed"; residuals: string[] };

function argumentError(message: string, detail: string): StorageError {
	return new StorageError("backup-argument-invalid", message, { detail });
}

function payloadMismatch(message: string, detail: string): StorageError {
	return new StorageError("backup-payload-mismatch", message, { detail });
}

/** 目录按深度升序：父目录必须比子目录先创建（清单顺序不由调用者保证）。 */
function byDepth(relativePaths: readonly string[]): string[] {
	return [...relativePaths].sort((left, right) => left.split("/").length - right.split("/").length || (left < right ? -1 : 1));
}

/**
 * 恢复入口：失败/取消统一收口。
 *
 * 提交点之前失败 ⇒ 按归属清理本次创建的内容，再脱敏；
 * 提交点之后的问题（复核/取消/清理）**不在这里抛**——它们由 `runRestore` 变成
 * `committed-needs-review` 结果，让调用方看得见"库确实已经写出来了"。
 */
export async function restoreKnowledgeBackup(options: RestoreKnowledgeBackupOptions): Promise<RestoreKnowledgeBackupResult> {
	const lifecycle: Lifecycle = { phase: "argument", published: false, cleanup: "ok", residuals: [] };
	let session: TargetSession | undefined;
	try {
		return await runRestore(options, lifecycle, (created) => {
			session = created;
		});
	} catch (error) {
		if (session !== undefined && !lifecycle.published) {
			try {
				const cleanup = await cleanupOwned(session);
				lifecycle.cleanup = cleanup.cleanup;
				lifecycle.residuals = [...cleanup.residuals];
			} catch {
				lifecycle.cleanup = "failed";
			}
		}
		throw sanitizeBackupFailure(error, "restore", { phase: lifecycle.phase, published: lifecycle.published, cleanup: lifecycle.cleanup, residuals: lifecycle.residuals });
	}
}

async function runRestore(options: RestoreKnowledgeBackupOptions, lifecycle: Lifecycle, register: (session: TargetSession) => void): Promise<RestoreKnowledgeBackupResult> {
	// ---- 1. 参数与限额（任何目标创建之前）----
	const limits = resolveBackupLimits(options.limits);
	if (options.offlineConfirmed !== true) throw argumentError("必须显式确认备份容器不被修改、目标不被其它进程使用（offlineConfirmed: true）", "offline-not-confirmed");
	if (typeof options.backupRoot !== "string" || !isFullyQualifiedPath(options.backupRoot)) throw argumentError("backupRoot 必须是完全限定的绝对路径", "invalid-backup-root");
	if (typeof options.root !== "string" || !isFullyQualifiedPath(options.root)) throw argumentError("root 必须是完全限定的绝对路径", "invalid-root");

	// ---- 2. 父链解析、重叠与链接（对备份容器与恢复目标各一次）----
	const backupParent = await resolveTargetParent(options.backupRoot, "备份容器");
	const backupRoot = targetRootOf(backupParent.canonicalParent, targetName(options.backupRoot));
	const targetParent = await resolveTargetParent(options.root, "恢复目标");
	const targetRoot = targetRootOf(targetParent.canonicalParent, targetName(options.root));
	// 顺序有意如此：先按 canonical 判重叠，再拒父链链接（受控类别不同，不能合并成一条）。
	assertPathsDisjoint(backupRoot, targetRoot, "备份容器与恢复目标重叠（相同、目标在备份内或备份在目标内），拒绝恢复");
	if (backupParent.chainLink) rejectParentChainLink("备份容器");
	if (targetParent.chainLink) rejectParentChainLink("恢复目标");

	// 备份容器本身必须是常规目录：链接（含 junction）意味着"我解析到的位置"与"真实数据位置"不是同一个。
	await assertRegularBackupContainer(backupRoot);

	const ioHooks = options.ioHooks;
	const runtime: TargetRuntime = {
		signal: options.signal,
		beforeIo: async (operation, target) => {
			if (ioHooks?.beforeIo) await ioHooks.beforeIo(operation, target);
		},
		closeFile: ioHooks?.closeFile ?? ((handle) => handle.close()),
		targetRoot,
	};
	const session = createTargetSession(runtime);
	register(session);

	// ---- 3. 只读备份准入（取得目标之前）----
	lifecycle.phase = "admission";
	// 保留完成标记的**原始字节指纹**：完成点之前要能回答"这份备份没有变"（R26-1）。
	const snapshot = await readBackupManifestWithFingerprint(runtime, backupRoot, limits, options.signal);
	const manifest = snapshot.manifest;
	await verifyBackupContainer(runtime, backupRoot, manifest, limits, options.signal);
	let totalBytes = 0;
	for (const file of manifest.files) {
		const bytes = await readBackupPayload(runtime, backupRoot, file, limits, options.signal);
		totalBytes += bytes.byteLength;
	}
	if (totalBytes > limits.maxTotalPayloadBytes) throw new StorageError("too-large", `备份 payload 总字节超过预算 ${limits.maxTotalPayloadBytes}，拒绝恢复`, { detail: "payload-too-large" });
	await assertBackupContentEligible(backupRoot, options.preflightLimits, options.signal, "取得目标前");

	// ---- 4. 排他取得新根 ----
	lifecycle.phase = "acquire-target";
	await acquireTargetRoot(session, options.signal);

	// ---- 5. 目录布局 + 非 registry 逐文件复制与回读 ----
	lifecycle.phase = "copy";
	for (const empty of RESTORE_EMPTY_DIRECTORIES) await createOwnedDirectory(session, empty, options.signal);
	for (const relative of byDepth(manifest.directories)) await createOwnedDirectory(session, relative, options.signal);
	for (const file of manifest.files) {
		if (file.path === RESTORE_REGISTRY_RELATIVE) continue;
		const bytes = await readBackupPayload(runtime, backupRoot, file, limits, options.signal);
		await writeOwnedFile(session, file.path, bytes, options.signal);
		const readBack = await readOwnedFileBounded(session, file.path, limits.maxFileBytes, options.signal);
		const measured = measureBackupPayload(readBack);
		if (measured === undefined || measured.byteLength !== file.bytes || measured.sha256 !== file.sha256) throw payloadMismatch("恢复目标回读与备份清单不一致，拒绝发布 registry", "readback-mismatch");
	}

	// ---- 6. 复核备份未变：完成标记原字节、容器集合、逐文件字节与业务准入都要与准入时一致 ----
	// 完成标记**先查**（R26-1）：它是"这份备份是同一份"的锚点，被换成另一份合法清单/未来版本时，
	// 后面的逐文件核对仍会"看起来通过"，只有原字节比较能发现。
	lifecycle.phase = "recheck-source";
	await assertBackupManifestUnchanged(runtime, backupRoot, snapshot, limits, options.signal);
	await verifyBackupContainer(runtime, backupRoot, manifest, limits, options.signal);
	for (const file of manifest.files) await readBackupPayload(runtime, backupRoot, file, limits, options.signal);
	await assertBackupContentEligible(backupRoot, options.preflightLimits, options.signal, "复制后");

	// ---- 7. 完成点前的目标复核：集合、归属与**逐文件字节**（R26-2）----
	// 放在源复核之后、发布之前：这段时间里目标被合法改写也必须在这里止住，不能只比集合就发布。
	lifecycle.phase = "verify-target";
	await verifyTargetAgainstManifest(session, manifest, limits, options.signal);

	// ---- 8. 完成点：原 registry 字节最后非覆盖发布 ----
	const registryFile = manifest.files.find((file) => file.path === RESTORE_REGISTRY_RELATIVE);
	if (registryFile === undefined) throw new StorageError("invalid-backup-manifest", "备份清单缺少 registry.json，拒绝恢复", { detail: "missing-registry" });
	const registryBytes = await readBackupPayload(runtime, backupRoot, registryFile, limits, options.signal);
	lifecycle.phase = "publish";
	const outcome = await publishOwnedManifest(session, RESTORE_REGISTRY_RELATIVE, registryBytes, options.signal);
	// 提交点已过：迟到取消/临时残留失败都只如实报告，**不删掉已恢复的库**。
	lifecycle.published = true;
	if (!outcome.tempRemoved) {
		lifecycle.cleanup = "failed";
		lifecycle.residuals = [outcome.tempRelative];
	}

	// ---- 9. 发布后复核：**字节/布局仍吻合**与"能被预检解释"是两件事 ----
	// R26-2：预检能解释一份被改写过的 JSON，但那不证明它是被恢复的原始字节。
	// 因此先做有界的目标字节复核（集合/归属/长度/hash），再跑现有预检；
	// 任一问题都只报"已提交，需复核"，库保留、published 保持 true。
	lifecycle.phase = "verify-restored";
	const reviewReasons: RestoreReviewReason[] = [];
	const pushReason = (reason: RestoreReviewReason): void => {
		if (!reviewReasons.includes(reason)) reviewReasons.push(reason);
	};
	if (lifecycle.cleanup === "failed") pushReason("cleanup-failed");
	try {
		await verifyTargetAgainstManifest(session, manifest, limits, options.signal, { registryBytes });
	} catch (error) {
		pushReason(isCancelledError(error) ? "cancelled-after-publish" : "verify-restored-drift");
	}
	try {
		const report = await inspectKnowledgeStore({ root: targetRoot, limits: options.preflightLimits, signal: options.signal, ioHooks });
		if (backupContentReasons(report).length > 0) pushReason("verify-restored-failed");
	} catch (error) {
		pushReason(isCancelledError(error) ? "cancelled-after-publish" : "verify-restored-error");
	}

	return {
		status: reviewReasons.length === 0 ? "restored" : "committed-needs-review",
		root: targetRoot,
		backupRoot,
		backupId: manifest.backupId,
		files: manifest.files.length,
		directories: manifest.directories.length + RESTORE_EMPTY_DIRECTORIES.length,
		totalBytes,
		published: true,
		cleanup: lifecycle.cleanup,
		residuals: [...lifecycle.residuals],
		reviewReasons,
	};
}

/** 备份容器的存在性/类型核对（链接与非常规类型都在这里止住）。 */
async function assertRegularBackupContainer(absolute: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(absolute);
	} catch (error) {
		if (isNotFoundError(error)) throw argumentError("备份容器不存在", "backup-missing");
		throw new StorageError("permission-denied", "无法核对备份容器", { detail: fsErrorCode(error) });
	}
	if (stats.isSymbolicLink() || !stats.isDirectory()) throw argumentError("备份容器必须是常规目录（不接受链接）", "backup-not-directory");
}
