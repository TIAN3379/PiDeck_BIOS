#!/usr/bin/env node
/**
 * 知识库人工管理命令行（BM-02D4）：`inspect` / `export` / `restore` 的**薄适配层**。
 *
 * 它**不是**第二套存储实现：所有判断、限额、非覆盖发布与清理事实都由 `core/storage` 的
 * 预检 / 导出 / 恢复 API 给出；这里只负责"把参数解析清楚、把结果讲清楚、把退出码定清楚"。
 * 输出契约与退出码映射在 `knowledgeOutput.mjs`（纯函数，可脱离进程单测）。
 *
 * 四条硬约束（BM-02D3 方案 §11.2）：
 * 1. **显式绝对路径**：每个命令都必须给路径，绝不回退到默认真实用户库；
 * 2. **写操作双重确认**：`export`/`restore` 同时要求 `--offline-confirmed` 与 `--confirm-write`，
 *    缺任一项在调用写 API、创建任何输出之前就拒绝（不弹交互、不自动确认、不删锁）；
 * 3. **机器可读输出**：`--json` 时 stdout 只放**一个**有界结果对象，诊断走 stderr；
 *    不输出 stack、原始异常正文、业务正文或未知条目名；
 * 4. **退出码如实**：0=成功无问题；2=命令/参数错误；1=拒绝/取消/预检不完整；
 *    3=**已发布/已提交**但存在残留或需要复核——不能把所有"函数返回"都记成 0。
 *
 * 本文件参与 `npm run typecheck`（tsconfig 的 checkJs），因此"导入了不存在的导出"
 * 这类漂移会被类型检查挡住。
 */
import { pathToFileURL } from "node:url";
import { isFullyQualifiedPath } from "../core/paths.ts";
import { exportKnowledgeBackup, inspectKnowledgeStore, restoreKnowledgeBackup } from "../core/storage/index.ts";
import { CliUsageError, EXIT_OK, EXIT_USAGE, HELP_TEXT, exitCodeForExportResult, exitCodeForFailure, exitCodeForInspectReport, exitCodeForRestoreResult, exportPayload, failurePayload, inspectPayload, jsonLine, jsonRequested, requestedCommand, restorePayload } from "./knowledgeOutput.mjs";

// 输出契约与退出码是 CLI 的一部分：在这里再导出一次，测试与调用方只需认入口文件。
export { CliUsageError, EXIT_COMMITTED_REVIEW, EXIT_OK, EXIT_OPERATION, EXIT_USAGE, exitCodeForExportResult, exitCodeForFailure, exitCodeForInspectReport, exitCodeForRestoreResult, jsonRequested, requestedCommand } from "./knowledgeOutput.mjs";

/**
 * @typedef {import("./knowledgeOutput.mjs").ResultPayload} ResultPayload
 * @typedef {{ command: string, values: Map<string, string>, flags: Set<string> }} ParsedArgs
 * @typedef {{ stdout?: (text: string) => void, stderr?: (text: string) => void, signal?: AbortSignal }} CliIo
 */

const COMMANDS = ["inspect", "export", "restore"];

/** 每个命令允许出现的选项（不允许的选项一律受控拒绝，不做"忽略未知"）。 */
const ALLOWED_OPTIONS = {
	help: new Set(["--help"]),
	inspect: new Set(["--root", "--json"]),
	export: new Set(["--root", "--backup-root", "--offline-confirmed", "--confirm-write", "--json"]),
	restore: new Set(["--backup-root", "--root", "--offline-confirmed", "--confirm-write", "--json"]),
};

const VALUE_OPTIONS = new Set(["--root", "--backup-root"]);
const FLAG_OPTIONS = new Set(["--offline-confirmed", "--confirm-write", "--json"]);

/* ------------------------------------------------------------------ 参数解析 */

/**
 * 受控回显：解析错误里**不**原样吐出任意长度的输入正文。
 *
 * 未知参数/命令是外部输入（可能是路径、粘贴内容或超长字符串），
 * 只保留一小段受控字符并给出长度上限；判定结果（退出码、错误类别）不依赖这段文本。
 *
 * @param {string} value
 * @returns {string}
 */
function boundedToken(value) {
	const kept = value
		.slice(0, 64)
		.replace(/[^A-Za-z0-9._-]/g, "")
		.slice(0, 32);
	return kept === "" ? "（名称已省略）" : kept;
}

/**
 * @param {string[]} argv
 * @returns {ParsedArgs}
 */
export function parseArgs(argv) {
	/** @type {Map<string, string>} */
	const values = new Map();
	/** @type {Set<string>} */
	const flags = new Set();
	/** @type {string | undefined} */
	let command;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === undefined) continue;
		if (arg === "--help" || arg === "-h") return { command: "help", values, flags };
		if (arg.startsWith("-")) {
			if (FLAG_OPTIONS.has(arg)) {
				if (flags.has(arg)) throw new CliUsageError(`参数重复：${boundedToken(arg)}`);
				flags.add(arg);
				continue;
			}
			if (VALUE_OPTIONS.has(arg)) {
				if (values.has(arg)) throw new CliUsageError(`参数重复：${boundedToken(arg)}`);
				const value = argv[index + 1];
				// 缺值 / 下一个位置又是个选项：都算缺值，绝不把 "--json" 当成路径。
				if (value === undefined || value.startsWith("-")) throw new CliUsageError(`参数缺少值：${boundedToken(arg)}`);
				values.set(arg, value);
				index += 1;
				continue;
			}
			throw new CliUsageError(`未知参数：${boundedToken(arg)}`);
		}
		if (command !== undefined) throw new CliUsageError(`不允许的位置参数：${boundedToken(arg)}`);
		if (!COMMANDS.includes(arg)) throw new CliUsageError(`未知命令：${boundedToken(arg)}`);
		command = arg;
	}
	const resolved = command ?? "help";
	// `ALLOWED_OPTIONS` 与 `COMMANDS`/`help` 一一对应；取值缺失说明常量表漂移，按最严格处理。
	const allowed = /** @type {Record<string, Set<string>>} */ (ALLOWED_OPTIONS)[resolved] ?? new Set();
	for (const option of [...values.keys(), ...flags]) {
		if (!allowed.has(option)) throw new CliUsageError(`参数不适用于该命令：${option}（命令 ${resolved}）`);
	}
	return { command: resolved, values, flags };
}

/**
 * 路径参数必须是**完全限定绝对路径**：相对路径在调用任何 API 之前就拒绝。
 *
 * @param {Map<string, string>} values
 * @param {string} option
 * @param {string} label
 * @returns {string}
 */
function requireAbsolutePath(values, option, label) {
	const value = values.get(option);
	if (value === undefined) throw new CliUsageError(`缺少必需参数：${option}`);
	if (!isFullyQualifiedPath(value)) throw new CliUsageError(`${label}必须是完全限定的绝对路径：${option}`);
	return value;
}

/** @param {Set<string>} flags */
function requireWriteConfirmation(flags) {
	if (!flags.has("--offline-confirmed")) throw new CliUsageError("写操作必须显式声明离线：缺少 --offline-confirmed");
	if (!flags.has("--confirm-write")) throw new CliUsageError("写操作必须显式确认写入：缺少 --confirm-write");
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 执行一次 CLI 调用。
 *
 * `io` 允许注入 stdout/stderr 与信号（测试用）；默认是真实进程流。
 * 返回退出码而不是直接 `process.exit()`：入口负责设置 `process.exitCode`，
 * 这样 SIGINT 之后仍能让收尾/日志正常跑完。
 *
 * @param {string[]} argv
 * @param {CliIo} [io]
 * @returns {Promise<number>}
 */
export async function runKnowledgeCli(argv, io = {}) {
	/** @param {string} text */
	const stdout = io.stdout ?? ((text) => process.stdout.write(text));
	/** @param {string} text */
	const stderr = io.stderr ?? ((text) => process.stderr.write(text));
	const signal = io.signal ?? new AbortController().signal;

	/** @type {ParsedArgs} */
	let parsed;
	try {
		parsed = parseArgs(argv);
	} catch (error) {
		// 解析失败也要遵守输出契约（R26-3）：显式请求 `--json` 时 stdout 仍只放**一个**受控对象，
		// 否则自动化调用方拿不到可解析的错误结果。意图识别按取值规则走（见 `jsonRequested`）。
		writeFailure(stdout, stderr, jsonRequested(argv), failurePayload(requestedCommand(argv), error));
		return EXIT_USAGE;
	}

	if (parsed.command === "help") {
		stdout(HELP_TEXT);
		return EXIT_OK;
	}

	const json = parsed.flags.has("--json");
	try {
		return await runCommand(parsed, json, signal, stdout, stderr);
	} catch (error) {
		writeFailure(stdout, stderr, json, failurePayload(parsed.command, error));
		return error instanceof CliUsageError ? EXIT_USAGE : exitCodeForFailure(error);
	}
}

/**
 * @param {ParsedArgs} parsed
 * @param {boolean} json
 * @param {AbortSignal} signal
 * @param {(text: string) => void} stdout
 * @param {(text: string) => void} stderr
 * @returns {Promise<number>}
 */
async function runCommand(parsed, json, signal, stdout, stderr) {
	if (parsed.command === "inspect") {
		const root = requireAbsolutePath(parsed.values, "--root", "知识根");
		const report = await inspectKnowledgeStore({ root, signal });
		const payload = inspectPayload(report);
		if (json) {
			stdout(jsonLine(payload));
		} else {
			const versions = report.versions.map((entry) => `${entry.family}@${entry.version ?? "?"}×${entry.files}`).join(" ");
			stdout(`inspect: ${String(payload.status)}（outcome=${report.outcome}，complete=${String(report.complete)}）\n`);
			stdout(`  版本族：${versions === "" ? "（无）" : versions}\n`);
			stdout(`  阻断问题 ${report.blockingProblems} 项，人工事项 ${report.manualItems} 项，问题明细 ${report.problems.length} 条，截断 ${report.truncatedBy.length === 0 ? "无" : report.truncatedBy.join("/")}\n`);
		}
		return exitCodeForInspectReport(report);
	}

	if (parsed.command === "export") {
		const root = requireAbsolutePath(parsed.values, "--root", "源知识根");
		const backupRoot = requireAbsolutePath(parsed.values, "--backup-root", "备份容器");
		requireWriteConfirmation(parsed.flags);
		const result = await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, signal });
		if (json) {
			stdout(jsonLine(exportPayload(result)));
		} else {
			stdout(`export: ${result.status}（文件 ${result.files}，目录 ${result.directories}，字节 ${result.totalBytes}，清理 ${result.cleanup}）\n`);
			if (result.residuals.length > 0) stderr(`存在残留：${result.residuals.join(", ")}\n`);
		}
		return exitCodeForExportResult(result);
	}

	// restore
	const backupRoot = requireAbsolutePath(parsed.values, "--backup-root", "备份容器");
	const root = requireAbsolutePath(parsed.values, "--root", "新知识根");
	requireWriteConfirmation(parsed.flags);
	const result = await restoreKnowledgeBackup({ backupRoot, root, offlineConfirmed: true, signal });
	if (json) {
		stdout(jsonLine(restorePayload(result)));
	} else {
		stdout(`restore: ${result.status}（文件 ${result.files}，目录 ${result.directories}，字节 ${result.totalBytes}，清理 ${result.cleanup}${result.reviewReasons.length > 0 ? `，需复核：${result.reviewReasons.join("/")}` : ""}）\n`);
	}
	return exitCodeForRestoreResult(result);
}

/**
 * @param {(text: string) => void} stdout
 * @param {(text: string) => void} stderr
 * @param {boolean} json
 * @param {ResultPayload} payload
 */
function writeFailure(stdout, stderr, json, payload) {
	if (json) {
		stdout(jsonLine(payload));
		return;
	}
	if (payload.status === "usage-error") {
		stderr(`参数错误：${String(payload.message ?? "")}\n`);
		stderr("运行 `knowledge --help` 查看用法。\n");
		return;
	}
	const residuals = Array.isArray(payload.residuals) ? payload.residuals : [];
	const facts = payload.published === null || payload.published === undefined ? "" : `；已提交=${String(payload.published)}；清理=${String(payload.cleanup)}${residuals.length === 0 ? "" : `；残留=${residuals.join(",")}`}`;
	stderr(`操作失败：${String(payload.code ?? "unclassified")}${payload.detail === null || payload.detail === undefined ? "" : `（${String(payload.detail)}）`}${facts}\n`);
}

/* ------------------------------------------------------------------ 入口 */

/** 只有被当作脚本执行时才跑：被 import 时不产生副作用（测试可复用纯映射）。 */
function isMainEntry() {
	const entry = process.argv[1];
	if (entry === undefined) return false;
	return pathToFileURL(entry).href === import.meta.url;
}

if (isMainEntry()) {
	// 取消走 AbortSignal 传到 API：SIGINT 后**等待已有清理完成**，不用立即 process.exit 打断收尾。
	const controller = new AbortController();
	let interrupted = false;
	const onSigint = () => {
		if (interrupted) return;
		interrupted = true;
		process.stderr.write("已收到中断信号，正在安全收尾（取消会按归属清理本次创建的内容）……\n");
		controller.abort();
	};
	process.on("SIGINT", onSigint);
	try {
		process.exitCode = await runKnowledgeCli(process.argv.slice(2), { signal: controller.signal });
	} finally {
		// listener 必须与注册同域配对移除，否则重复运行/测试会累积。
		process.off("SIGINT", onSigint);
	}
}
