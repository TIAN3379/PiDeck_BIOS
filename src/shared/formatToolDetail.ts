import type { MainProcessTranslationKey } from "./i18n/mainProcessCopy";
import { mainProcessT } from "./i18n/mainProcessCopy";

/**
 * 工具卡展开区文案（PI / DSH 共用）：整理成「工具 / 状态 / 参数 / 结果」写入 meta.detailText。
 * 渲染层 getToolDetailText 优先读这段字；主进程投影时按当前 locale 烘焙，不随语言切换重算。
 */

/** 单段 args/result/details 与整段 detailText 的首尾截断上限（与历史 PI 投影器同值）。 */
export const TOOL_DETAIL_MAX_CHARS = 8000;

export type ToolDetailTranslate = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

/** 投影器未注入 translate 时的兜底（中文）；装配层应传入当前主进程 locale。 */
export function defaultToolDetailTranslate(key: MainProcessTranslationKey, params?: Record<string, string | number>): string {
	return mainProcessT("zh-CN", key, params);
}

export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/**
 * 从 pi 风格 result.content[].text 抽出正文；纯字符串（DSH textFromBlocks）原样返回。
 */
export function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (!result || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((item) => {
			if (!item || typeof item !== "object") return "";
			const text = (item as { text?: unknown }).text;
			return typeof text === "string" ? text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function extractToolDetails(result: unknown): unknown {
	if (!result || typeof result !== "object") return undefined;
	return (result as { details?: unknown }).details;
}

function extractRawCommand(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || !("command" in args)) return undefined;
	const command = args.command;
	return typeof command === "string" ? command : undefined;
}

/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
export function truncateForDetail(text: unknown, translate: ToolDetailTranslate, maxChars = TOOL_DETAIL_MAX_CHARS): string {
	// safeJson/extractToolResultText 在某些输入下可能返回 undefined（如 JSON.stringify(undefined)），
	// 必须在此归一化为字符串，否则后续 .length 访问会抛 TypeError 导致主进程未捕获异常弹窗。
	const str = typeof text === "string" ? text : text == null ? "" : String(text);
	if (str.length <= maxChars) return str;
	const keep = Math.floor(maxChars / 2);
	const omitted = str.length - keep * 2;
	return `${str.slice(0, keep)}\n` + `${translate("mainTool.truncated", { omitted, total: str.length })}\n` + str.slice(-keep);
}

/**
 * 与 truncateForDetail 同规则的整体截断，但额外返回是否截断与原始长度，
 * 供下发 meta 标记 truncated/fullLength（渲染层据此提供「查看完整输出」按需加载入口）。
 */
export function truncateDetailWithMeta(text: string, translate: ToolDetailTranslate, maxChars = TOOL_DETAIL_MAX_CHARS): { text: string; truncated: boolean; fullLength: number } {
	if (text.length <= maxChars) {
		return { text, truncated: false, fullLength: text.length };
	}
	const keep = Math.floor(maxChars / 2);
	const omitted = text.length - keep * 2;
	return {
		text: `${text.slice(0, keep)}\n` + `${translate("mainTool.truncated", { omitted, total: text.length })}\n` + text.slice(-keep),
		truncated: true,
		fullLength: text.length,
	};
}

/**
 * 把一次工具调用整理成工具卡展开区可读文案。
 * args 在 end/update 事件里可能已是序列化字符串，先反解再 stringify，避免二次编码。
 */
export function formatToolDetail(toolName: string, args: unknown, result: unknown, isError: boolean, translate: ToolDetailTranslate): string {
	const details = extractToolDetails(result);
	let argsObj = args;
	if (typeof args === "string" && args.trim()) {
		try {
			argsObj = JSON.parse(args) as unknown;
		} catch {
			// truncated/不可解析时保持原样
		}
	}
	const argsText = argsObj ? truncateForDetail(safeJson(argsObj), translate) : "";
	const rawCommand = toolName.trim().toLowerCase() === "bash" ? extractRawCommand(argsObj) : undefined;
	const commandText = rawCommand === undefined ? "" : truncateForDetail(rawCommand, translate);
	const resultText = result ? truncateForDetail(extractToolResultText(result) || safeJson(result), translate) : "";
	const detailsText = details ? truncateForDetail(safeJson(details), translate) : "";
	const status = translate(isError ? "mainTool.failed" : "mainTool.done");
	const argsSection = args ? (rawCommand !== undefined ? translate("mainTool.command", { command: commandText }) : translate("mainTool.arguments", { value: argsText })) : "";
	const sections = [translate("mainTool.name", { name: toolName || "tool" }), translate("mainTool.status", { status }), argsSection, result ? translate("mainTool.result", { value: resultText }) : "", details ? translate("mainTool.details", { value: detailsText }) : ""].filter(Boolean);
	return sections.join("\n\n");
}
