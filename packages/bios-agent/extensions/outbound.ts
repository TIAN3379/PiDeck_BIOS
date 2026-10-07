/**
 * R31-1 / R31-3：**模型可见输出的统一外发守卫与预算**。
 *
 * 专业工具、预览与自动注入共用这一份守卫，原因是"只读"不等于"允许发给当前模型"：
 * - 端点 `denied` / `unknown` 时**不输出任何商业正文**（身份字段、需求/待办/阻塞、经验根因方案、
 *   客户别名、证据备注等），只保留 ID/状态/计数/缺口；
 * - 模型可见的 `content` 与正文型 `details` 共用**同一份硬上限**（12,000 字符 / 24 KiB），
 *   参数只能收紧；自动注入的标记与免责声明也计入预算，不把包装当免费字节；
 * - 有限诊断另设更小的硬上限，并做**防御性投影**：内部 IO 计账（读取条数/字节）不出现，
 *   隐藏记录的 ID/path/revision 不出现（用户自己给出的查询串不在此列，那是模型已知输入）。
 */
import { Buffer } from "node:buffer";
import { MODEL_CONTENT_MAX_BYTES, MODEL_CONTENT_MAX_CHARS, MODEL_DETAILS_MAX_CHARS, MODEL_DIAGNOSTIC_MAX_CHARS, MODEL_DIAGNOSTIC_MAX_ITEMS, outboundPolicy, resolveModelBudget, type EndpointPolicy, type ModelBudget, type OutboundPolicy } from "../core/context/index.ts";

// R33-4：上限与解析搬进 `core/context/policy.ts`（桌面适配层也要共用同一份），
// 这里**原样再导出**，保持既有调用方（工具/注入/测试）的导入路径不变。
export { MODEL_CONTENT_MAX_CHARS, MODEL_CONTENT_MAX_BYTES, MODEL_DETAILS_MAX_CHARS, MODEL_DIAGNOSTIC_MAX_CHARS, MODEL_DIAGNOSTIC_MAX_ITEMS, resolveModelBudget, type ModelBudget };

export type BoundText = { readonly text: string; readonly truncated: boolean; readonly usedChars: number; readonly usedBytes: number };

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/**
 * 截断标记：从长到短依次尝试。
 *
 * R32-3：固定长标记会在**极小预算**下自己越限（预算 1 字符时提示本身 29 字符）。
 * 规则改为"能放长提示就放长的，放不下就退到更短的，最短也放不下就只留空正文"——
 * 任何合法正整数预算下最终正文（含提示）都不越限。
 */
const TRUNCATION_MARKERS = ["\n…（达到宿主输出上限，内容已截断；请缩小查询或分次读取）", "\n…（已截断）", "…", ""] as const;

/** 按字符与字节双上限截断（截断提示本身也计入，且随预算退化为更短提示或空正文）。 */
export function boundText(text: string, budget: ModelBudget): BoundText {
	if ([...text].length <= budget.maxChars && byteLength(text) <= budget.maxBytes) {
		return { text, truncated: false, usedChars: [...text].length, usedBytes: byteLength(text) };
	}
	for (const marker of TRUNCATION_MARKERS) {
		const markerChars = [...marker].length;
		if (markerChars > budget.maxChars || byteLength(marker) > budget.maxBytes) continue;
		let kept = [...text].slice(0, budget.maxChars - markerChars).join("");
		while (kept.length > 0 && byteLength(kept + marker) > budget.maxBytes) kept = [...kept].slice(0, -1).join("");
		const bounded = `${kept}${marker}`;
		// 双保险：即便预算极小（例如 1 字符）也只返回真正放得下的内容。
		if ([...bounded].length <= budget.maxChars && byteLength(bounded) <= budget.maxBytes) {
			return { text: bounded, truncated: true, usedChars: [...bounded].length, usedBytes: byteLength(bounded) };
		}
	}
	return { text: "", truncated: true, usedChars: 0, usedBytes: 0 };
}

export function endpointOf(config: { readonly endpoint: EndpointPolicy }): { outbound: OutboundPolicy; budget: ModelBudget } {
	return { outbound: outboundPolicy(config.endpoint), budget: resolveModelBudget() };
}

/**
 * 商业正文门：`counter` 在拒绝策略下返回**计数投影**（不是把正文偷偷塞进另一个字段）。
 */
export function gate<T>(outbound: OutboundPolicy, allowed: () => T, withheld: () => T): T {
	return outbound.allowCommercialBody ? allowed() : withheld();
}

const UUID_LIKE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LONG_HEX = /\b[0-9a-f]{16,}\b/i;

/**
 * 有限诊断投影：只保留受控码值，去掉路径/UUID/长 hash/超长文本，并有条数与字符上限。
 *
 * 内部 IO 计账（读取条数、字节数）不在这里——那是实现成本，不是模型需要的业务事实。
 */
export function projectDiagnostics(problems: readonly string[], counts: Record<string, number> = {}): { readonly problems: readonly string[]; readonly counts: Record<string, number>; readonly truncated: boolean } {
	const kept: string[] = [];
	let used = 0;
	let truncated = false;
	for (const problem of problems) {
		if (kept.length >= MODEL_DIAGNOSTIC_MAX_ITEMS) {
			truncated = true;
			break;
		}
		// 路径、UUID、长 hash 都可能是内部定位信息：投影掉整条，不做"打码后照发"。
		if (/[\\/]/.test(problem) || UUID_LIKE.test(problem) || LONG_HEX.test(problem) || [...problem].length > 240) {
			truncated = true;
			continue;
		}
		const next = used + [...problem].length;
		if (next > MODEL_DIAGNOSTIC_MAX_CHARS) {
			truncated = true;
			break;
		}
		kept.push(problem);
		used = next;
	}
	return { problems: kept, counts, truncated };
}

/** 结构化 details 的硬上限：超出即降级为调用方给的计数投影（避免"截断正文 + 完整 details"）。 */
export function boundDetails(details: Record<string, unknown>, fallback: Record<string, unknown>): Record<string, unknown> {
	const encoded = JSON.stringify(details);
	if (encoded === undefined) return fallback;
	if ([...encoded].length <= MODEL_DETAILS_MAX_CHARS) return details;
	return { ...fallback, detailsTruncated: true, detailsBudgetChars: MODEL_DETAILS_MAX_CHARS };
}
