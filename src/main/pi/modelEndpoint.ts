/** 从实际 Pi 模型快照取服务器地址；不读取配置、密钥或向模型发请求。 */
export function modelEndpointOriginOf(model: unknown): string | undefined {
	if (model === null || typeof model !== "object" || !("baseUrl" in model)) return undefined;
	const value = model.baseUrl;
	if (typeof value !== "string" || value.length === 0 || value.length > 4096) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
		// origin 不包含 user:password、API 路径、query 或 fragment。
		return url.origin;
	} catch {
		return undefined;
	}
}
