/**
 * 备份/恢复公共边界的**统一失败映射**（BM-02D2 / D2R，D3 复用）。
 *
 * round22 §3（D2-4）证明两件事：清理成功时原始异常会**直接透传**（调用方拿到带客户正文的裸 `Error`），
 * 而真实错误（如零预算）的消息里带着**源知识库绝对路径**。两者都发生在公共 API 上，是阻塞项。
 *
 * 因此这里做一次收口，无论有没有取得目标、无论清理成功与否：
 * - 类别：保留原受控码；未分类异常一律收敛成 `backup-io-failed`（不透传原始正文/cause）；
 * - 阶段：`facts.phase` 是固定枚举标签，不是路径；
 * - 定位：只保留**受控格式**的 `detail`（形如 `container-files`、`read=3 stat=2` 里的空格形式会被丢弃），
 *   不保留 `path`、不保留原始 message；
 * - 收尾：`published` / `cleanup` / 残留样本与主错误**同时**返回，cleanup 失败不覆盖主码。
 */
import { isCancelledError, isStorageError, StorageError, type OperationFailureFacts, type StorageErrorCode } from "../errors.ts";

/** 受控阶段标签；调用方据它判断"卡在哪一步"，不依赖消息文本。 */
export type BackupPhase = "argument" | "admission" | "inventory" | "acquire-target" | "copy" | "recheck-source" | "verify-hash" | "verify-container" | "verify-target" | "publish" | "verify-restored";

/** 每个受控码对应的**固定**文案：不含路径、条目名或正文。 */
const BACKUP_FAILURE_MESSAGES: Partial<Record<StorageErrorCode, string>> = {
	"invalid-limits": "备份预算不合法",
	"backup-argument-invalid": "备份/恢复参数不合法",
	"backup-source-not-eligible": "源知识库不满足准入",
	"backup-target-exists": "目标不可用（已存在或被替换）",
	"backup-target-overlap": "源与目标路径重叠",
	"backup-source-changed": "过程中源发生变化",
	"backup-payload-mismatch": "字节或容器集合与清单不一致",
	"invalid-backup-manifest": "备份清单未通过协议校验",
	"too-large": "超出预算",
	cancelled: "操作已取消",
	"permission-denied": "目标或源不可访问",
	"not-found": "引用的路径缺失",
	"not-a-file": "引用的路径不是常规文件",
	"path-escape": "拒绝访问边界之外的路径",
	"symlink-rejected": "拒绝跟随链接",
	"invalid-json": "内容不是合法 JSON",
	"publish-unsupported": "平台不支持非覆盖发布",
	"backup-io-failed": "出现未分类失败",
};

/** `detail` 白名单：短、小写、无空格/斜杠/反斜杠/冒号（路径与条目名因此进不来）。 */
function safeDetail(detail: string | undefined): string | undefined {
	if (detail === undefined) return undefined;
	return /^[a-z0-9][a-z0-9._=-]{0,39}$/.test(detail) ? detail : undefined;
}

function messageFor(code: StorageErrorCode): string {
	return BACKUP_FAILURE_MESSAGES[code] ?? "备份/恢复失败";
}

/**
 * 把任意失败映射成受控 `StorageError`。
 *
 * `kind` 只用于文案前缀，不参与类别判断；取消保留 `cancelled` 类别（调用方仍需能区分"用户取消"
 * 与"真的坏了"），但同样只带受控阶段与收尾事实。
 */
export function sanitizeBackupFailure(error: unknown, kind: "export" | "restore", facts: OperationFailureFacts): StorageError {
	const phase = facts.phase;
	const label = kind === "export" ? "离线导出" : "备份恢复";
	if (isCancelledError(error)) return new StorageError("cancelled", `${label}已取消（阶段：${phase}）`, { detail: `cancelled-${phase}`, facts });
	if (isStorageError(error)) {
		return new StorageError(error.code, `${messageFor(error.code)}（${label}阶段：${phase}）`, { detail: safeDetail(error.detail), facts });
	}
	// 未分类异常：不透传 message/cause/未知名称，只给受控类别与阶段。
	return new StorageError("backup-io-failed", `${messageFor("backup-io-failed")}（${label}阶段：${phase}）`, { detail: "unclassified", facts });
}
