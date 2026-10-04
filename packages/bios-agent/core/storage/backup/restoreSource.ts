/**
 * 恢复侧的**只读备份准入**（BM-02D3）。
 *
 * 为什么单独一个模块：恢复要先把"这份备份能不能被信任为一次完整离线复制"问清楚，
 * 再谈往哪儿写。这一层**不创建、不删除、不改写任何东西**，只读三件事：
 *
 * 1. **完成标记**：有界读取 `manifest.json` 原始字节 → `JSON.parse` → `validateBackupManifest`
 *    （严格字段、版本、受控落点、预算）。未来版本一律拒绝，不做"尽力解释"。
 * 2. **容器真实集合**：有界枚举 `<备份根>/` 与 `data/` 子树，与清单**全量**比对；
 *    链接、未知条目、缺失目录、`.tmp` 残留都不通过（D2-2 的同一判据）。
 * 3. **逐文件原始字节**：长度 + SHA-256 与清单核对（D1 判据），并另外跑一次
 *    `inspectKnowledgeStore({ root: <备份根>/data })`：业务/工件版本必须能被当前实现解释。
 *
 * 边界（刻意不做的事）：
 * - 校验通过**不代表**来源可信。没有签名的 hash 只证明"这些字节与清单一致"，
 *   首版不引入认证系统；调用方仍需自行确认备份来源。
 * - 这一层不冒充"自有写入会话"：备份侧的文件**不属于**本次调用，
 *   因此不复用 `target.ts` 的身份/祖先归属检查，只用只读容器原语。
 * - `cache`/`locks` 缺席是 D1 的明确排除项，按预检"可选目录"语义处理，不额外放宽准入。
 */
import { Buffer } from "node:buffer";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { fsErrorCode, isCancelledError, isNotFoundError, isStorageError, StorageError } from "../errors.ts";
import { inspectKnowledgeStore, type PreflightLimits, type PreflightReport } from "../preflight/index.ts";
import { assertContainerMatchesManifest, enumerateContainer } from "./container.ts";
import { BACKUP_DATA_DIR_NAME, BACKUP_MANIFEST_FILE_NAME, type BackupManifest, type BackupManifestFile } from "./contract.ts";
import type { BackupLimits } from "./limits.ts";
import { validateBackupManifest } from "./manifest.ts";
import { readBoundedFile, type TargetRuntime } from "./target.ts";
import { measureBackupPayload } from "./verify.ts";

/** 备份容器里某个文件的绝对路径（`path` 已由清单校验为规范受控相对路径）。 */
export function backupPayloadAbsolute(backupRoot: string, relativePath: string): string {
	return join(backupRoot, BACKUP_DATA_DIR_NAME, ...relativePath.split("/"));
}

function mismatch(message: string, detail: string): StorageError {
	return new StorageError("backup-payload-mismatch", message, { detail });
}

/**
 * 有界读取并核验备份容器里的**一个**文件；长度或 SHA-256 与清单不符即受控拒绝。
 *
 * 单文件上限用 `limits.maxFileBytes`：超预算的文件在读取阶段就会被判 `too-large`，
 * 不会"先读完 2 GB 再说不一致"。
 */
export async function readBackupPayload(runtime: TargetRuntime, backupRoot: string, file: BackupManifestFile, limits: BackupLimits, signal?: AbortSignal): Promise<Buffer> {
	const bytes = await readBoundedFile(runtime, backupPayloadAbsolute(backupRoot, file.path), limits.maxFileBytes, signal);
	const measured = measureBackupPayload(bytes);
	if (measured === undefined || measured.byteLength !== file.bytes || measured.sha256 !== file.sha256) {
		throw mismatch("备份容器内的文件字节与清单不一致，拒绝恢复", "payload-mismatch");
	}
	return bytes;
}

/** 完成标记的绝对路径（受控派生，用于读取与身份核对）。 */
export function backupManifestAbsolute(backupRoot: string): string {
	return join(backupRoot, BACKUP_MANIFEST_FILE_NAME);
}

/**
 * 完成标记必须是**常规文件**：链接（含 junction）会让"我读到的清单"与"真实数据位置"不是同一个。
 *
 * 这一层只做一次 `lstat` 类型判定，**不声称**消除检查与读取之间的竞态（也不替代容器盘点）。
 */
async function assertRegularManifestFile(absolute: string): Promise<void> {
	let stats;
	try {
		stats = await lstat(absolute);
	} catch (error) {
		if (isNotFoundError(error)) throw mismatch("备份容器缺少完成标记 manifest.json，拒绝当作已完成备份", "manifest-missing");
		throw new StorageError("permission-denied", "无法核对备份完成标记", { detail: fsErrorCode(error) });
	}
	if (stats.isSymbolicLink() || !stats.isFile()) throw mismatch("备份完成标记不是常规文件（不接受链接或非常规类型）", "manifest-not-regular-file");
}

function parseManifestBytes(bytes: Buffer, limits: BackupLimits): BackupManifest {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bytes.toString("utf8"));
	} catch {
		// 不传 cause：原始 SyntaxError 的 message 会带上输入片段（清单可能含客户 ID）。
		throw new StorageError("invalid-backup-manifest", "备份完成标记不是合法 JSON，拒绝恢复", { detail: "invalid-json" });
	}
	const validated = validateBackupManifest(parsed, limits);
	if (!validated.ok) {
		throw new StorageError("invalid-backup-manifest", "备份完成标记未通过协议校验，拒绝恢复", { detail: validated.issues[0]?.code ?? "invalid-backup-manifest" });
	}
	return validated.manifest;
}

/**
 * 准入时读到的完成标记**快照**：类型化清单 + 原始字节指纹。
 *
 * 为什么必须留指纹：恢复要在完成点之前回答"备份容器内容没有变"。
 * 只保留解析后的对象会让"现场清单被换成另一份同样合法的清单/未来版本"完全不可见
 * （第二十六轮 R26-1 的实际复现）。
 */
export type BackupManifestSnapshot = {
	readonly manifest: BackupManifest;
	/** 准入时**原始磁盘字节**的 SHA-256（与 D1/payload 同一口径）。 */
	readonly fingerprint: string;
	/** 准入时的原始字节数。 */
	readonly byteLength: number;
};

/**
 * 读完成标记：缺文件按"容器不完整"处理（不是 `not-found`，否则调用方会以为换个路径就好），
 * 坏 JSON 按"清单未通过协议校验"处理。
 */
export async function readBackupManifestWithFingerprint(runtime: TargetRuntime, backupRoot: string, limits: BackupLimits, signal?: AbortSignal): Promise<BackupManifestSnapshot> {
	const absolute = backupManifestAbsolute(backupRoot);
	await assertRegularManifestFile(absolute);
	let bytes: Buffer;
	try {
		bytes = await readBoundedFile(runtime, absolute, limits.maxManifestBytes, signal);
	} catch (error) {
		if (isStorageError(error) && error.code === "not-found") throw mismatch("备份容器缺少完成标记 manifest.json，拒绝当作已完成备份", "manifest-missing");
		throw error;
	}
	const measured = measureBackupPayload(bytes);
	if (measured === undefined) throw mismatch("无法计量备份完成标记字节，拒绝恢复", "manifest-unreadable");
	return { manifest: parseManifestBytes(bytes, limits), fingerprint: measured.sha256, byteLength: measured.byteLength };
}

/**
 * 完成点之前复核"备份没变"：**有界重读**完成标记原字节，与准入指纹逐字节比较。
 *
 * 任何差异（合法等长改写、未来版本、删除、替换成另一份合法清单）都按"源发生变化"受控拒绝——
 * 不把"读到另一份合法清单"当成允许继续恢复那个备份。备份现场只读保留。
 */
export async function assertBackupManifestUnchanged(runtime: TargetRuntime, backupRoot: string, snapshot: BackupManifestSnapshot, limits: BackupLimits, signal?: AbortSignal): Promise<void> {
	const absolute = backupManifestAbsolute(backupRoot);
	let bytes: Buffer;
	try {
		await assertRegularManifestFile(absolute);
		bytes = await readBoundedFile(runtime, absolute, limits.maxManifestBytes, signal);
	} catch (error) {
		if (isCancelledError(error)) throw error;
		// 清单在读第二次时不可读/被替换成链接：与"内容变化"同一结论（源不再是一次一致复制）。
		throw changed("备份完成标记在恢复期间不可读或被替换，拒绝继续", "manifest-unreadable");
	}
	const measured = measureBackupPayload(bytes);
	if (measured === undefined || measured.byteLength !== snapshot.byteLength || measured.sha256 !== snapshot.fingerprint) {
		throw changed("备份完成标记在恢复期间发生变化，拒绝发布", "manifest-changed");
	}
	// 字节完全一致时再跑一次协议校验：确认"同一份字节仍然可解释"（防御未来校验规则变化）。
	try {
		parseManifestBytes(bytes, limits);
	} catch {
		throw changed("备份完成标记在恢复期间不再通过协议校验，拒绝发布", "manifest-changed");
	}
}

function changed(message: string, detail: string): StorageError {
	return new StorageError("backup-source-changed", message, { detail });
}

/** 容器真实条目：根必须恰好 `manifest.json` + `data/`，`data/` 内部不得有清单以外的条目或链接。 */
export async function verifyBackupContainer(runtime: TargetRuntime, backupRoot: string, manifest: BackupManifest, limits: BackupLimits, signal?: AbortSignal): Promise<void> {
	// 显式传入**已验证清单集合**（R24-2）：盘点遇到未声明的目录/文件就地拒绝，不进入未知子树。
	const inventory = await enumerateContainer(runtime, backupRoot, limits, signal, {
		directories: new Set(manifest.directories),
		files: new Set(manifest.files.map((file) => file.path)),
	});
	assertContainerMatchesManifest(inventory, manifest, { manifestPresent: true });
}

/** 只读预检结论是否可作为恢复准入（与导出侧同一套"完整、无需迁移、无截断/裁剪/阻断/人工事项"）。 */
export function backupContentReasons(report: PreflightReport): string[] {
	const reasons: string[] = [];
	if (!report.complete) reasons.push("预检不完整");
	if (report.outcome !== "no-migration-needed") reasons.push(`预检结论为 ${report.outcome}`);
	if (report.truncatedBy.length > 0) reasons.push(`存在截断（${report.truncatedBy.join("/")}）`);
	if (report.droppedSummaries > 0 || report.droppedProblems > 0) reasons.push("诊断被预算裁剪");
	if (report.blockingProblems > 0 || report.problems.length > 0) reasons.push("存在问题/阻断条目");
	if (report.manualItems > 0 || report.manual.length > 0) reasons.push("存在人工核对事项（锁、残留或审核状态）");
	return reasons;
}

/**
 * 在 `<备份根>/data` 上跑现有只读预检，要求备份内容能被**当前实现**解释。
 *
 * 注意与"字节一致"是两件事：hash 相符的坏 JSON 依然会被这里拒绝——
 * 那正是"校验通过不等于业务版本可解释"的落点。
 */
export async function assertBackupContentEligible(backupRoot: string, preflightLimits: Partial<PreflightLimits> | undefined, signal: AbortSignal | undefined, stage: string): Promise<PreflightReport> {
	const report = await inspectKnowledgeStore({ root: join(backupRoot, BACKUP_DATA_DIR_NAME), limits: preflightLimits, signal });
	const reasons = backupContentReasons(report);
	if (reasons.length === 0) return report;
	throw new StorageError("backup-source-not-eligible", `备份内容不满足恢复准入（${stage}）：${reasons.join("；")}`, { detail: "preflight-not-eligible" });
}
