/**
 * 离线备份协议（BM-02D1）的**窄出口**。
 *
 * 只暴露"契约 + 两类纯校验"：落点分类表、问题收集器与限额解析细节留在模块内部——
 * 调用方不该自己拼装落点表（那是"能恢复什么"的唯一判据），也不该绕过
 * `validateBackupManifest` 直接构造一个"看起来像清单"的对象。
 *
 * 本模块**没有任何导出会碰文件系统**：D1 不导出、不恢复、不建目录。
 */
export { DEFAULT_BACKUP_LIMITS, resolveBackupLimits, type BackupLimits } from "./limits.ts";
export { BACKUP_LAYOUT_SEGMENTS, BACKUP_REQUIRED_DIRECTORIES, type BackupLandingKind } from "./paths.ts";
export { measureBackupManifestBytes, validateBackupManifest } from "./manifest.ts";
export { measureBackupPayload, verifyBackupPayload, type BackupPayloadEntry } from "./verify.ts";
export { exportKnowledgeBackup, type ExportKnowledgeBackupOptions, type ExportKnowledgeBackupResult } from "./export.ts";
export { restoreKnowledgeBackup, type RestoreKnowledgeBackupOptions, type RestoreKnowledgeBackupResult, type RestoreReviewReason } from "./restore.ts";
export {
	BACKUP_CONSISTENCY,
	BACKUP_DATA_DIR_NAME,
	BACKUP_EXCLUDED_DIRECTORIES,
	BACKUP_MANIFEST_FIELD_ORDER,
	BACKUP_MANIFEST_FILE_NAME,
	BACKUP_MANIFEST_VERSION,
	BACKUP_MAX_DATE_MS,
	BACKUP_SHA256_LENGTH,
	type BackupExclusion,
	type BackupFailureCode,
	type BackupIssue,
	type BackupIssueCode,
	type BackupManifest,
	type BackupManifestFile,
	type BackupManifestValidation,
	type BackupPayloadVerification,
} from "./contract.ts";
