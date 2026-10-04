/**
 * 知识库 CLI 的**输出契约与退出码映射**（BM-02D4）。
 *
 * 为什么从 `knowledge.mjs` 拆出来：入口文件同时装"参数解析 + 三个命令的编排 + 结果/退出码契约"
 * 会越过单文件 400 行的目标。这里只放**纯函数与常量**（不含 IO、不含 process），因此可以
 * 脱离进程单独断言，也让"已提交需复核/残留必须非 0"这类规则只有一个落点——
 * 不为 CLI 另造第二套发布逻辑。
 *
 * 本文件参与 `npm run typecheck`（tsconfig 的 checkJs）。
 */
import { isStorageError } from "../core/storage/index.ts";

/**
 * @typedef {import("../core/storage/index.ts").ExportKnowledgeBackupResult} ExportKnowledgeBackupResult
 * @typedef {import("../core/storage/index.ts").RestoreKnowledgeBackupResult} RestoreKnowledgeBackupResult
 * @typedef {import("../core/storage/index.ts").PreflightReport} PreflightReport
 * @typedef {{ command: string, status: string, [key: string]: unknown }} ResultPayload
 */

/** 受控退出码。 */
export const EXIT_OK = 0;
export const EXIT_OPERATION = 1;
export const EXIT_USAGE = 2;
export const EXIT_COMMITTED_REVIEW = 3;

/** 参数/命令错误：与"操作被拒绝"分开，专门对应退出码 2。 */
export class CliUsageError extends Error {
	/** @param {string} message */
	constructor(message) {
		super(message);
		this.name = "CliUsageError";
	}
}

export const HELP_TEXT = `bios-agent 知识库管理（离线）

用法：
  knowledge <命令> [选项]

命令：
  inspect   只读预检一份知识库：版本分布、截断与人工事项（不写任何字节）
  export    把知识库离线导出为备份容器（manifest.json + data/），源库只读
  restore   把备份容器恢复到**尚不存在**的新知识根，registry 最后非覆盖发布

选项：
  --root <绝对路径>           inspect/export 的源知识根；restore 的新知识根（必须不存在）
  --backup-root <绝对路径>    export 的新备份容器；restore 的已完成备份容器
  --offline-confirmed        调用者声明：备份容器不被修改、目标不被其它进程使用（写命令必需）
  --confirm-write            调用者确认要写盘（写命令必需；不做交互确认）
  --json                     stdout 只输出一个结果对象，诊断走 stderr
  -h, --help                 显示本帮助（不读取知识库、不创建文件）

退出码：
  0  成功且无清理/预检/复核问题
  1  操作被拒绝、已取消，或预检不完整/存在阻断项
  2  命令或参数错误（未知/重复/缺值/相对路径/缺写确认）
  3  已发布或已提交，但存在残留或需要人工复核

局限（与 core 同口径，不做超额承诺）：
  * 只承诺 offline-copy：要求调用者先关闭所有写入者，本工具不做在线快照；
  * 只承诺本机可验证的发布点，不承诺网络盘/断电原子恢复；
  * 不迁移 BIOS 源码，也不重写 registry 里的旧工作区绝对路径。
`;

/* ------------------------------------------------------------------ 退出码映射 */

/**
 * 失败事实 → 退出码：已提交/已发布一律 3，其余 1。
 *
 * @param {unknown} error
 * @returns {number}
 */
export function exitCodeForFailure(error) {
	const facts = isStorageError(error) ? error.facts : undefined;
	return facts?.published === true ? EXIT_COMMITTED_REVIEW : EXIT_OPERATION;
}

/**
 * 导出结果 → 退出码：有残留/清理失败是"已提交需复核"，不能返回 0。
 *
 * @param {ExportKnowledgeBackupResult} result
 * @returns {number}
 */
export function exitCodeForExportResult(result) {
	if (result.published !== true) return EXIT_OPERATION;
	return result.cleanup === "ok" ? EXIT_OK : EXIT_COMMITTED_REVIEW;
}

/**
 * 恢复结果 → 退出码：`committed-needs-review` 必须非 0。
 *
 * @param {RestoreKnowledgeBackupResult} result
 * @returns {number}
 */
export function exitCodeForRestoreResult(result) {
	if (result.published !== true) return EXIT_OPERATION;
	return result.status === "restored" && result.cleanup === "ok" && result.reviewReasons.length === 0 ? EXIT_OK : EXIT_COMMITTED_REVIEW;
}

/**
 * 预检报告 → 退出码：只有"完整且无需迁移"才是 0。
 *
 * @param {PreflightReport} report
 * @returns {number}
 */
export function exitCodeForInspectReport(report) {
	return report.complete === true && report.outcome === "no-migration-needed" && report.blockingProblems === 0 && report.manualItems === 0 ? EXIT_OK : EXIT_OPERATION;
}

/**
 * 预检是否可视为"通过"（与退出码同一判据，避免两处各写一遍）。
 *
 * @param {PreflightReport} report
 * @returns {boolean}
 */
function inspectOk(report) {
	return report.complete && report.outcome === "no-migration-needed" && report.blockingProblems === 0 && report.manualItems === 0;
}

/* ------------------------------------------------------------------ 结果对象（有界、无正文） */

/**
 * @param {PreflightReport} report
 * @returns {ResultPayload}
 */
export function inspectPayload(report) {
	return {
		command: "inspect",
		status: inspectOk(report) ? "ok" : report.complete ? "blocked" : "incomplete",
		outcome: report.outcome,
		complete: report.complete,
		truncatedBy: [...report.truncatedBy],
		scannedEntries: report.scannedEntries,
		readFiles: report.readFiles,
		readBytes: report.readBytes,
		blockingProblems: report.blockingProblems,
		problems: report.problems.length,
		manualItems: report.manualItems,
		versions: report.versions.map((entry) => ({ family: entry.family, version: entry.version, files: entry.files })),
	};
}

/**
 * @param {ExportKnowledgeBackupResult} result
 * @returns {ResultPayload}
 */
export function exportPayload(result) {
	return { command: "export", status: result.status, published: result.published, files: result.files, directories: result.directories, totalBytes: result.totalBytes, cleanup: result.cleanup, residuals: [...result.residuals] };
}

/**
 * @param {RestoreKnowledgeBackupResult} result
 * @returns {ResultPayload}
 */
export function restorePayload(result) {
	return {
		command: "restore",
		status: result.status,
		published: result.published,
		files: result.files,
		directories: result.directories,
		totalBytes: result.totalBytes,
		cleanup: result.cleanup,
		residuals: [...result.residuals],
		reviewReasons: [...result.reviewReasons],
	};
}

/**
 * 受控失败对象：只带类别、受控 detail 与结构化事实，不含 stack/原始正文/路径。
 *
 * @param {string} command
 * @param {unknown} error
 * @returns {ResultPayload}
 */
export function failurePayload(command, error) {
	if (error instanceof CliUsageError) return { command, status: "usage-error", message: error.message };
	if (isStorageError(error)) {
		const facts = error.facts;
		return {
			command,
			status: "error",
			code: error.code,
			detail: typeof error.detail === "string" ? error.detail : null,
			published: facts?.published ?? null,
			cleanup: facts?.cleanup ?? null,
			residuals: facts?.residuals === undefined ? null : [...facts.residuals],
			phase: facts?.phase ?? null,
		};
	}
	// 未分类异常：不透传 message/cause（存储层/预检的原始正文可能带绝对路径）。
	return { command, status: "error", code: "unclassified", detail: null, published: null, cleanup: null, residuals: null, phase: null };
}

/**
 * 受控 JSON 行（stdout 只放一个对象；调用方负责写出去）。
 *
 * @param {ResultPayload} payload
 * @returns {string}
 */
export function jsonLine(payload) {
	return `${JSON.stringify(payload)}\n`;
}

/* ------------------------------------------------------------------ 解析失败时的保守意图识别 */

/** 需要取值的选项：它们后面的那个 token 是**值**，不是选项（哪怕长得像 `--json`）。 */
const VALUE_TAKING_OPTIONS = new Set(["--root", "--backup-root"]);
const KNOWN_COMMANDS = new Set(["inspect", "export", "restore"]);

/**
 * 参数解析**失败**时判断"调用方要的是 JSON 输出吗"。
 *
 * 为什么不能直接 `argv.includes("--json")`：`inspect --root --json` 里的 `--json` 是 `--root` 的
 * **值**，把它当成输出开关会让一个明确错误的调用被报成 JSON 结果（R26-3 的实现要求"不要误将路径值视为选项"）。
 * 因此这里按解析器同一套取值规则走一遍，只看**未被取值选项消费**的独立 `--json` token。
 *
 * 保守的含义是：只按 token 判定，不解析值内容、不做猜测；判不出来就当"没有请求 JSON"。
 *
 * @param {string[]} argv
 * @returns {boolean}
 */
export function jsonRequested(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--json") return true;
		if (VALUE_TAKING_OPTIONS.has(arg)) index += 1;
	}
	return false;
}

/**
 * 参数解析失败时推断调用方想跑哪个命令（用于结果对象里的 `command`）。
 *
 * 只接受**已知命令**，其余一律 `"unknown"`：解析失败时不该把任意正文当成命令名回显。
 *
 * @param {string[]} argv
 * @returns {string}
 */
export function requestedCommand(argv) {
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (VALUE_TAKING_OPTIONS.has(arg)) {
			index += 1;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return KNOWN_COMMANDS.has(arg) ? arg : "unknown";
	}
	return "unknown";
}
