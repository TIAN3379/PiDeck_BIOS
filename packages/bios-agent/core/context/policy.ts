/**
 * R30-1 外发策略（R32-3 从 context.ts 拆出）：端点 allowed/denied/unknown 决定本次是否允许输出商业正文。
 *
 * R33-4：**预算硬上限**也归到这里，让"工具/注入"与"桌面适配层"共用同一份常量与解析，
 * 不许某一条入口自己放宽（曾经桌面预览能传 100,000 字符绕开 12,000 的宿主上限）。
 */
import { invalidArgument } from "../knowledge/contract.ts";

/** 模型可见正文的宿主硬上限：任何入口（工具/注入/桌面预览）都不得超过。 */
export const MODEL_CONTENT_MAX_CHARS = 12_000;
export const MODEL_CONTENT_MAX_BYTES = 24 * 1024;
/** 结构化 `details` 的正文型硬上限（超出即降级为计数投影）。 */
export const MODEL_DETAILS_MAX_CHARS = 4_000;
/** 有限诊断/来源元数据的独立硬上限。 */
export const MODEL_DIAGNOSTIC_MAX_CHARS = 1_200;
export const MODEL_DIAGNOSTIC_MAX_ITEMS = 6;

export type ModelBudget = {
	/** 本次生效的字符上限（≤ `MODEL_CONTENT_MAX_CHARS`）。 */
	readonly maxChars: number;
	/** 本次生效的字节上限（≤ `MODEL_CONTENT_MAX_BYTES`）。 */
	readonly maxBytes: number;
	/** 调用方请求被宿主上限夹紧时为 true（如实说明，不假装"按你要求"）。 */
	readonly clamped: boolean;
};

function positiveIntegerOrUndefined(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	// NaN / Infinity / 小数 / 负数都拒绝：静默取整会让"预算"变成猜谜。
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw invalidArgument(`${label} 必须是正整数（不支持 NaN/Infinity/小数/非正数）`);
	return value;
}

/** 预算解析：参数只能**收紧**宿主上限；超限夹紧并在结果里说明。 */
export function resolveModelBudget(requested?: { readonly maxChars?: unknown; readonly maxBytes?: unknown }): ModelBudget {
	const chars = positiveIntegerOrUndefined(requested?.maxChars, "预算 maxChars");
	const bytes = positiveIntegerOrUndefined(requested?.maxBytes, "预算 maxBytes");
	return {
		maxChars: chars === undefined ? MODEL_CONTENT_MAX_CHARS : Math.min(chars, MODEL_CONTENT_MAX_CHARS),
		maxBytes: bytes === undefined ? MODEL_CONTENT_MAX_BYTES : Math.min(bytes, MODEL_CONTENT_MAX_BYTES),
		clamped: (chars !== undefined && chars > MODEL_CONTENT_MAX_CHARS) || (bytes !== undefined && bytes > MODEL_CONTENT_MAX_BYTES),
	};
}

/** D4：一个模型服务的**可核验身份**（provider / modelId / API 源）。 */
export type EndpointServiceIdentity = { readonly provider: string; readonly modelId: string; readonly origin: string };

/** D4：具名端点许可 = 服务身份 + 许可版本（版本只增不减，旧版本一律视为旧许可）。 */
export type EndpointGrant = EndpointServiceIdentity & { readonly version: number };

export type EndpointPolicy = {
	readonly endpointAllowed: boolean | null;
	readonly allowInternalGeneral: boolean;
	readonly customers?: readonly string[];
	/** D4：宿主绑定的具名许可；`null`/缺省 = 未绑定（沿用全局策略）。 */
	readonly grant?: EndpointGrant | null;
	/** D4：**当前实际**模型服务身份（由调用上下文从 Pi 模型快照派生）；读不到为 null。 */
	readonly actual?: EndpointServiceIdentity | null;
};

/** 统一的**外发策略**（R30-1）：决定本次是否允许输出商业正文。 */
export type OutboundPolicy = {
	/** 允许输出需求/待办/阻塞/经验正文等商业内容。 */
	readonly allowCommercialBody: boolean;
	/** 不允许时需要向调用方说明的受控原因。 */
	readonly note: string | null;
};

/** D4：两个服务身份是否完全相同（逐字段，不做前缀/包含匹配）。 */
export function sameServiceIdentity(left: EndpointServiceIdentity | null | undefined, right: EndpointServiceIdentity | null | undefined): boolean {
	if (left === null || left === undefined || right === null || right === undefined) return false;
	return left.provider === right.provider && left.modelId === right.modelId && left.origin === right.origin;
}

/** D4：具名许可是否与当前实际服务一致（`origin` 为空串时不匹配任何事实）。 */
export function grantMatchesService(grant: EndpointGrant | null | undefined, actual: EndpointServiceIdentity | null | undefined): boolean {
	if (grant === null || grant === undefined) return false;
	if (grant.origin === "") return false;
	return sameServiceIdentity(grant, actual);
}

/**
 * `allowed` ⇒ 允许；`denied` ⇒ 拒绝；`unknown` ⇒ **默认不自动注入商业正文**
 * （"资料在本地"不等于"允许发给当前模型"）。文案警告不能代替策略。
 *
 * D4：当宿主绑定了**具名许可**时，还必须核对**当前实际**服务身份——provider/modelId/API 源
 * 任一变化（换模型、改 baseUrl、旧许可）都在这里、也就是**发送前**拒绝，而不是靠界面提示。
 * 未绑定（旧配置）时保持既有语义，不新增拦截。
 */
export function outboundPolicy(endpoint: EndpointPolicy): OutboundPolicy {
	if (endpoint.endpointAllowed === false) return { allowCommercialBody: false, note: "端点策略为 deny：不输出商业正文（只给 ID、状态与缺口）" };
	if (endpoint.grant !== null && endpoint.grant !== undefined) {
		if (endpoint.actual === null || endpoint.actual === undefined) return { allowCommercialBody: false, note: "已绑定具名端点许可，但读不到当前模型服务身份（provider/model/地址）：按保守策略不外发，请在有运行会话时重新确认接入" };
		if (!grantMatchesService(endpoint.grant, endpoint.actual))
			return { allowCommercialBody: false, note: `具名端点许可与当前模型服务不一致（已许可 ${endpoint.grant.provider}/${endpoint.grant.modelId}@${endpoint.grant.origin}，当前 ${endpoint.actual.provider}/${endpoint.actual.modelId}@${endpoint.actual.origin}）：这是旧许可，拒绝外发，请重新确认接入` };
	}
	if (endpoint.endpointAllowed === null) return { allowCommercialBody: false, note: "端点策略未知：默认不自动注入商业正文（只给引用元数据与缺口）" };
	return { allowCommercialBody: true, note: null };
}
