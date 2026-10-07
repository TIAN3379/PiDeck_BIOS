/**
 * D4（§13.4.2）：**端点服务身份的纯解析**。
 *
 * 三个来源各不相同，必须分清：
 * - `serviceIdentityOf(model)`：从 **Pi 报告的实际模型快照**派生（provider / modelId / baseUrl 的源），
 *   这是"资料到底会发给谁"的唯一事实来源；
 * - `parseEndpointGrant(raw)`：解析**宿主注入**的具名许可（用户明确确认过的身份 + 版本）；
 * - 两者相等 ⇒ 许可仍然对得上当前服务；不等 ⇒ 这是旧许可，发送前必须拒绝。
 *
 * 边界：只读地址的 HTTP(S) **源**，不读取密钥、不带路径/query/fragment，也不发起任何网络请求。
 * 任何一项缺失一律返回 `null`（不猜、不用策略枚举冒充实际身份）。
 */
import type { EndpointGrant, EndpointServiceIdentity } from "./policy.ts";

/** 从 `baseUrl` 取 HTTP(S) 源；带凭据/非 HTTP(S)/非法一律 `undefined`。 */
export function endpointOriginOf(baseUrl: unknown): string | undefined {
	if (typeof baseUrl !== "string" || baseUrl.length === 0 || baseUrl.length > 4096) return undefined;
	try {
		const url = new URL(baseUrl);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		// `origin` 不含 user:password、API 路径、query 或 fragment。
		return url.origin;
	} catch {
		return undefined;
	}
}

/** 从 Pi 模型快照派生可核验身份；provider/modelId/origin 任一缺失即 `null`。 */
export function serviceIdentityOf(model: unknown): EndpointServiceIdentity | null {
	if (model === null || typeof model !== "object") return null;
	const record = model as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const modelId = typeof record.id === "string" ? record.id.trim() : "";
	const origin = endpointOriginOf(record.baseUrl);
	if (provider === "" || modelId === "" || origin === undefined) return null;
	return { provider, modelId, origin };
}

/**
 * 只接受"值本身就是 HTTP(S) 源"的写法（拒绝带路径/参数/哈希/凭据）。
 *
 * 为什么不复用 `endpointOriginOf`：它按设计允许省略路径（`https://host/v1` ⇒ `https://host`），
 * 那对"实际 baseUrl"是对的，但对**存储在配置里的许可**太宽松——把 "https://host/v1?k=secret"
 * 收窄成 origin 会掩盖配置里混入了不该出现的内容。
 */
function strictOrigin(value: unknown): string | undefined {
	if (typeof value !== "string" || value === "" || value.length > 2048) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
		if (url.pathname !== "" && url.pathname !== "/") return undefined;
		return url.origin;
	} catch {
		return undefined;
	}
}

/** 解析宿主注入的具名许可（JSON）；非法/不完整/版本非正一律 `null`。 */
export function parseEndpointGrant(raw: string | undefined): EndpointGrant | null {
	const text = (raw ?? "").trim();
	if (text === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const record = parsed as Record<string, unknown>;
	const provider = typeof record.provider === "string" ? record.provider.trim() : "";
	const modelId = typeof record.modelId === "string" ? record.modelId.trim() : "";
	const origin = strictOrigin(record.origin);
	const version = typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version > 0 ? record.version : 0;
	// 三件套 + 正版本号缺一不可：半截许可比没有许可更危险（看起来已绑定，其实管不住）。
	if (provider === "" || modelId === "" || origin === undefined || version === 0) return null;
	return { provider, modelId, origin, version };
}
