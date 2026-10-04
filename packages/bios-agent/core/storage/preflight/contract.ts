/**
 * 迁移预检（BM-02C3）的公开结果契约。
 *
 * 预检回答四个问题：**这份知识库有哪些格式版本 / 哪些文件无法解释 / 是否需要迁移 / 有哪些阻断事项**。
 * 因此结果里的每一类字段都必须"可行动且不越界"：
 *
 * - 版本来源只用既有常量与校验器（不复制字面量，也不与 Package/Pi/桌面版本混用）；
 * - 路径只由**受控 ID**派生；无法按受控规则解释的条目名一律省略、用位置占位
 *   （与审核契约"未声明字段名称已省略"同一口径：诊断本身不能变成泄漏通道）；
 * - 不返回记录正文、原始 JSON、客户字段或凭据；
 * - 唯一总体结论只有三种，且**任何截断都不能返回通过**。
 */
import { AUDIT_INTENT_SCHEMA_VERSION, AUDIT_SCHEMA_VERSION, type AuditIssueCode } from "../../contracts/index.ts";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../../contracts/version.ts";
import type { StorageErrorCode } from "../errors.ts";
import { JOURNAL_SCHEMA_VERSION, type JournalIssueCode } from "../journal/contract.ts";
import { REVIEW_JOURNAL_VERSION, type ReviewJournalIssueCode } from "../review/contract.ts";
import type { PreflightLimits } from "./limits.ts";

/** 预检覆盖的工件类别（与 §3 的布局表一一对应）。 */
export type PreflightCategory = "registry" | "project-profile" | "project-task" | "project-context" | "experience-card" | "feature-record" | "journal" | "audit-intent" | "audit-event" | "lock" | "residue" | "cache" | "unknown";

/**
 * 单个候选的观察结果。
 *
 * - `ok`：结构、版本、路径身份都落在本实现支持的范围内；
 * - `unsupported-version`：**版本**不认识（只报一条，不按当前结构猜字段）；
 * - `invalid`：版本认得、结构/身份不合法（坏 JSON、超限、ID 与路径不符……）；
 * - `missing`：这个位置**应该**有东西但没有（只对必需落点使用）；
 * - `unreadable`：读不动又无法进一步分类（权限、竞态消失……）；
 * - `unchecked`：明确**不检查**（`cache/` 可重建，不是事实记录）。
 */
export type PreflightFileStatus = "ok" | "unsupported-version" | "invalid" | "missing" | "unreadable" | "unchecked";

/**
 * 可行动错误码：**存储层与各校验器既有码域**的并集 + 预检自己的两个分类。
 *
 * 刻意不做"统一映射成少数几个码"：预检的价值在于把"为什么这份文件不可解释"如实带回
 * （`unsupported-journal-version` 与 `invalid-json` 的处置完全不同），
 * 而搬运码域不会引入新语义——它们本来就是同一套校验链产出的。
 */
export type PreflightCode = StorageErrorCode | AuditIssueCode | JournalIssueCode | ReviewJournalIssueCode | "unreadable" | "unknown-entry";

/** 格式版本族：版本号只在族内可比（journal v1/v2 不是新旧业务格式）。 */
export type PreflightVersionFamily = "registry" | "record" | "journal" | "audit-intent" | "audit-event";

/** 本实现支持的版本表（唯一来源是各契约的常量，不复制字面量）。 */
export const SUPPORTED_PREFLIGHT_VERSIONS: readonly { readonly family: PreflightVersionFamily; readonly version: number }[] = [
	{ family: "registry", version: BIOS_CONTRACTS_SCHEMA_VERSION },
	{ family: "record", version: BIOS_CONTRACTS_SCHEMA_VERSION },
	{ family: "journal", version: JOURNAL_SCHEMA_VERSION },
	{ family: "journal", version: REVIEW_JOURNAL_VERSION },
	{ family: "audit-intent", version: AUDIT_INTENT_SCHEMA_VERSION },
	{ family: "audit-event", version: AUDIT_SCHEMA_VERSION },
];

/**
 * 扫描语义：**逐文件观察**，不是原子快照。
 *
 * 并发中消失/变化的候选只会被报成问题，不会自动反复扫描；即便全部读到合法格式，
 * 也不承诺扫描结束后知识库状态不变（后续备份需要单独的协作一致性设计）。
 */
export const PREFLIGHT_SCAN_SEMANTICS = "observed-not-snapshot" as const;

/** 有界文件摘要（不含正文）。 */
export type PreflightFileSummary = {
	readonly category: PreflightCategory;
	/** 受控根内相对路径（只用已校验的 ID/固定名拼出）。 */
	readonly relativePath: string;
	readonly status: PreflightFileStatus;
	/** 观察到的格式版本；缺失/读不懂 = null（**不猜**）。 */
	readonly version: number | null;
	readonly code: PreflightCode | null;
};

/** 一条问题（单文件或单条目；`message` 有界且不含正文）。 */
export type PreflightProblem = {
	readonly category: PreflightCategory;
	readonly relativePath: string;
	readonly status: PreflightFileStatus;
	readonly code: PreflightCode | null;
	readonly message: string;
	/** 是否阻断"当前已检查范围无需迁移"的结论。 */
	readonly blocks: boolean;
};

/** 需要人工核对的事项（预检**不做**任何收口/清理动作）。 */
export type PreflightManualReason = "prepared-journal" | "conflict-journal" | "lock-present" | "temp-residue" | "registered-without-profile" | "unregistered-project";

export type PreflightManualItem = {
	readonly category: PreflightCategory;
	readonly relativePath: string;
	readonly reason: PreflightManualReason;
	/** 有界说明。 */
	readonly message: string;
};

/** 版本分布（按族与版本号计数）。 */
export type PreflightVersionCount = {
	readonly family: PreflightVersionFamily;
	readonly version: number | null;
	readonly files: number;
};

/**
 * 截断原因（任何一项出现 ⇒ `complete=false`）。
 *
 * `root-listing`：知识根**自身**无法列举（被拒/在扫描期间消失/被替换成非目录）。
 * 它是"没检查完"而不是预算耗尽，但同样**绝不允许**得到通过结论（BM-02C3R / PF-1）。
 */
export type PreflightTruncation = "scan-entries" | "read-bytes" | "file-summaries" | "problems" | "output-bytes" | "root-listing";

/** 唯一总体结论。 */
export type PreflightOutcome =
	/** 已检查范围只有支持的版本、没有未解释/需人工核对的条目。 */
	| "no-migration-needed"
	/** 有阻断事项（坏文件、未知/不支持版本、锁、残留、prepared/conflict journal、孤立项目……）。 */
	| "blocked"
	/** 预算截断或问题被丢弃导致"看不完"：**永远不能**当成通过。 */
	| "incomplete";

export type PreflightReport = {
	readonly root: string;
	readonly scanSemantics: typeof PREFLIGHT_SCAN_SEMANTICS;
	readonly outcome: PreflightOutcome;
	/** 是否在预算内**看完了**全部已知落点（根自身列举失败也算没看完，见 `root-listing`）。 */
	readonly complete: boolean;
	readonly truncatedBy: readonly PreflightTruncation[];
	/**
	 * 真实**观察过**的目录条目数（含被跳过的链接、未知条目与目录本身）。
	 *
	 * 观察由底层有界列举完成，**一返回就计入**（不等候选处理完成），所以：
	 * - 目录列举因条目预算截断时，已观察条目（**包含唯一的超限探测条目**）同样计入，
	 *   真实观察总数因此不超过 `maxScanEntries + 1`（BM-02C3R / PF-4 / S1）；
	 * - 某个候选被跳过、读取失败或其它预算先触顶，都不影响此前已观察条目的计数。
	 *
	 * 这里只统计**物理**目录条目：像"registry 已登记但磁盘上没有项目目录"这类**逻辑核对**
	 * 与它共用条目预算，但不计入本字段（两者不互相伪装）。
	 */
	readonly scannedEntries: number;
	/** 成功读取的**实际**字节数。 */
	readonly readBytes: number;
	/** 失败尝试按单文件上限预留的字节数（与 `readBytes` 分开报告，不混称）。 */
	readonly reservedBytes: number;
	/** 成功读取的文件数（含 `unchecked` 之前的实际读取）。 */
	readonly readFiles: number;
	readonly supportedVersions: readonly { readonly family: PreflightVersionFamily; readonly version: number }[];
	readonly versions: readonly PreflightVersionCount[];
	readonly summaries: readonly PreflightFileSummary[];
	readonly droppedSummaries: number;
	readonly problems: readonly PreflightProblem[];
	/**
	 * 因**共同条数额度**（`problems.length + manual.length <= maxProblems`）或输出字节预算
	 * 而未写进明细的条数：问题与人工事项合计，不只是 `problems`（BM-02C3R / PF-2）。
	 */
	readonly droppedProblems: number;
	/** 阻断计数**不受输出预算影响**（列表可能被截断，结论不会被截断）。 */
	readonly blockingProblems: number;
	readonly manual: readonly PreflightManualItem[];
	/** 观察到的人工事项**总数**（含额度外被丢弃的），同样不受输出预算裁剪。 */
	readonly manualItems: number;
	/** 本次实际生效的预算口径（便于复现"为什么会截断"）。 */
	readonly limits: PreflightLimits;
	/**
	 * 三类可变明细的真实 UTF-8 序列化字节数（BM-02C3R / PF-3）。
	 *
	 * 唯一口径：把 `summaries` + `problems` + `manual` 按「摘要 → 问题 → 人工事项」合并成
	 * 一个 JSON 数组后计量，**计入数组括号与逗号分隔符**（即
	 * `Buffer.byteLength(JSON.stringify([...summaries, ...problems, ...manual]), "utf8")`）。
	 * 空明细计 0 字节；`root`/`outcome`/计数等**固定报告信封不计入** `maxOutputBytes`。
	 */
	readonly outputBytes: number;
};
