/**
 * 离线备份清单的**契约**（BM-02D1）：`backupVersion=1` 的唯一结构与有界诊断码。
 *
 * 为什么单独一份**版本**而不是复用业务 `schemaVersion`：清单描述"哪些文件被复制了、
 * 每个多少字节、hash 是多少"，与记录结构无关；把两者绑在一起，一次记录格式升级
 * 就会让所有旧备份清单看起来"需要迁移"。`backupVersion` 只描述**清单自身**的结构。
 *
 * 边界（本轮刻意不做的事，写在这里防止后来者顺手加进来）：
 * - 不含源绝对路径、机器名、客户名称或正文——清单可能被贴进工单，绝不能成为泄漏面；
 * - 不含工具版本、时间区间、迁移结论：那是预检/业务的事，清单只说"抄了哪些字节"；
 * - `consistency: "offline-copy"` 是**声明**而不是证明：它要求操作者关闭所有写入者，
 *   由后续入口显式确认；它不等于在线原子快照，也不被预检 `complete` 背书。
 */
import type { StorageErrorCode } from "../errors.ts";

/** 清单结构版本。未来若改变字段语义必须新增 literal，不做"尽力解释"。 */
export const BACKUP_MANIFEST_VERSION = 1;

/**
 * 一致性标记：**固定**为离线复制。
 *
 * 不接受 `online`/`atomic` 之类的"更强"标记——当前协议没有任何机制能证明它们，
 * 写上去只会变成一句无法验证的承诺。
 */
export const BACKUP_CONSISTENCY = "offline-copy";

/**
 * 明确排除、**其内容不进入备份**的两个目录，按知识根内的名字书写。
 *
 * 它们是唯一被允许排除的东西：`cache/` 是可重建缓存，`locks/` 是运行期协作锁。
 * 其它任何业务/审核/journal 工件都不得借"排除"之名从清单里消失。
 */
export const BACKUP_EXCLUDED_DIRECTORIES = ["cache", "locks"] as const;
export type BackupExclusion = (typeof BACKUP_EXCLUDED_DIRECTORIES)[number];

/**
 * 备份容器的对外形状：`<备份根>/manifest.json` + `<备份根>/data/`（D2 导出，D3 恢复）。
 *
 * 定义在契约层而不是导出实现里：恢复侧必须按**同一个**形状读取，
 * 从 `export.ts` 取常量会让"容器长什么样"随导出实现一起漂移。
 */
export const BACKUP_DATA_DIR_NAME = "data";
export const BACKUP_MANIFEST_FILE_NAME = "manifest.json";

/** SHA-256 十六进制文本的长度与形态（与 journal/audit 同一口径：小写、64 位）。 */ export const BACKUP_SHA256_LENGTH = 64;
export const BACKUP_SHA256_PATTERN_SOURCE = "^[0-9a-f]{64}$";

/**
 * 时间戳上界：`Date` 可表示的最大毫秒值（与锁/审核模块同一口径）。
 *
 * `createdAt` 只表示"这次复制是什么时候发生的"，**不得**被当作业务有效时间或版本依据。
 */
export const BACKUP_MAX_DATE_MS = 8_640_000_000_000_000;

/**
 * 规范化清单的字段顺序（**唯一**序列化形态）。
 *
 * `maxManifestBytes` 按"规范化对象 JSON.stringify 的 UTF-8 字节"计量，因此顺序必须固定，
 * 否则同一份语义的清单会因键序不同而得到不同字节数——预算就不再可复现。
 */
export const BACKUP_MANIFEST_FIELD_ORDER = ["backupVersion", "backupId", "createdAt", "consistency", "exclusions", "directories", "files"] as const;

/** 文件项：相对 `data/` 的规范路径 + 实际 payload 字节数 + 该字节的 SHA-256（小写十六进制）。 */
export type BackupManifestFile = {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
};

/** 通过校验的完整清单（`verifyBackupPayload` 只接受这种形状）。 */
export type BackupManifest = {
	readonly backupVersion: typeof BACKUP_MANIFEST_VERSION;
	readonly backupId: string;
	readonly createdAt: number;
	readonly consistency: typeof BACKUP_CONSISTENCY;
	readonly exclusions: BackupExclusion[];
	readonly directories: string[];
	readonly files: BackupManifestFile[];
};

/**
 * 失败类别（与 `StorageErrorCode` 同域，便于调用方按类别分流）。
 *
 * 只有两个：**清单协议非法**与**清单与所给字节不一致**。更细的定位放在 `issues` 里，
 * 不把失败语义拆成十几种调用方必须都认识的码。
 */
export type BackupFailureCode = Extract<StorageErrorCode, "invalid-backup-manifest" | "backup-payload-mismatch">;

/**
 * 有界诊断码。
 *
 * 每一条都对应一个**可复现的拒绝理由**；刻意不合并成 `invalid-record` 之类的粗码，
 * 否则"清单缺 registry"与"路径里有反斜杠"在报告里长得一模一样。
 */
export type BackupIssueCode =
	/** 顶层不是普通对象（数组 / 类实例 / null / 原型对象）。 */
	| "not-object"
	/** 期望数组的字段不是数组。 */
	| "not-array"
	/** 缺少必填字段。 */
	| "missing-field"
	/** 出现未知字段（名称不回显）。 */
	| "unknown-field"
	/** `backupVersion` 不是本实现支持的 1。 */
	| "invalid-version"
	/** `consistency` 不是 `offline-copy`。 */
	| "invalid-consistency"
	/** `exclusions` 不是恰好 `cache` + `locks`（缺项 / 多项 / 重复）。 */
	| "invalid-exclusions"
	/** `backupId` 不符合既有知识 ID 判据。 */
	| "invalid-backup-id"
	/** `createdAt` 不是合法时间戳范围。 */
	| "invalid-created-at"
	/** files 条目数超限。 */
	| "too-many-files"
	/** directories 条目数超限。 */
	| "too-many-directories"
	/** 规范化清单序列化字节超限。 */
	| "manifest-too-large"
	/** 单个文件项声明的字节数超限。 */
	| "file-too-large"
	/** 声明或实际 payload 总字节超限（含累加溢出前的拒绝）。 */
	| "payload-too-large"
	/** 路径不是规范受控相对路径（绝对/盘符/UNC/反斜杠/`.`/`..`/重复分隔符/别名/非法字符…）。 */
	| "invalid-path"
	/** 形态合法但不在受控落点表内。 */
	| "unknown-landing"
	/** 落在受控落点里，但 ID / 文件名的形状不符合既有规则。 */
	| "invalid-file-name"
	/** directories 或 files 内部重复。 */
	| "duplicate-path"
	/** 同一路径同时是文件与目录，或文件路径被当成父目录使用。 */
	| "path-conflict"
	/** 文件或子目录的祖先目录没有登记。 */
	| "missing-ancestor"
	/** 缺少必需的 `registry.json`。 */
	| "missing-registry"
	/** 缺少必需的固定目录（`projects` / `experiences` / `features` / `audit`）。 */
	| "missing-required-directory"
	/** 文件项的 `bytes` 不是安全非负整数。 */
	| "invalid-bytes"
	/** 文件项的 `sha256` 不是 64 位小写十六进制。 */
	| "invalid-hash"
	/** payload 条目不是 `{ path, bytes }`（`bytes` 必须是 `Uint8Array`）。 */
	| "payload-entry"
	/** payload 里出现了清单未声明的路径。 */
	| "payload-unknown-path"
	/** payload 里同一路径出现多次。 */
	| "payload-duplicate"
	/** 清单声明的文件在 payload 里缺席。 */
	| "payload-missing"
	/** payload 实际长度与清单声明不符。 */
	| "payload-size-mismatch"
	/** payload 实际 SHA-256 与清单声明不符。 */
	| "payload-hash-mismatch";

/**
 * 一条有界诊断。
 *
 * `where` 只放**受控定位**（字段名或 `数组[下标]`），message 只放固定文案：
 * 两者都不回显输入内容——恶意路径、客户正文、绝对路径都不能借诊断逃出报告
 * （与预检 `placeholderPath` 同一纪律）。
 */
export type BackupIssue = {
	readonly code: BackupIssueCode;
	readonly where: string;
	readonly message: string;
};

/** 清单校验结果：成功给完整类型化清单，失败给唯一失败码 + 有界问题清单。 */
export type BackupManifestValidation = { readonly ok: true; readonly manifest: BackupManifest } | { readonly ok: false; readonly code: "invalid-backup-manifest"; readonly issues: BackupIssue[]; readonly droppedIssues: number };

/**
 * payload 核验结果：成功只表示"字节与清单一致"，不表示业务能读、更不表示已恢复。
 *
 * 失败码有两种可能：清单本身非法（`invalid-backup-manifest`，核验第一步就失败）
 * 或清单与所给字节不一致（`backup-payload-mismatch`）。刻意不把后者说成"清单非法"——
 * 字节不一致不代表任何一侧格式错误，只代表"这不是同一次复制"。
 */
export type BackupPayloadVerification = { readonly ok: true; readonly files: number; readonly totalBytes: number } | { readonly ok: false; readonly code: BackupFailureCode; readonly issues: BackupIssue[]; readonly droppedIssues: number };
