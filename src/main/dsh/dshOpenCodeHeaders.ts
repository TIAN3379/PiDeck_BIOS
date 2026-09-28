/** DSH 请求级 OpenCode 兼容层：仅补传输元数据，不修改供应商配置或会话内容。 */
import { readFileSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Models, ProviderHeaders } from "@earendil-works/pi-ai";

type OpenCodeRoute = { provider: string; baseUrl?: string };
type RequestOptions = {
	sessionId?: string;
	transformHeaders?: (headers: ProviderHeaders) => ProviderHeaders | Promise<ProviderHeaders>;
};
type StreamMethods = Pick<Models, "streamSimple">;
type Installation = { users: number; restore: () => void };
const installations = new WeakMap<object, Installation>();

/** 兼容目录供应商和用户改名的官方端点；不对 URL 子串/子域做模糊匹配。 */
export function isOpenCodeRoute(model: OpenCodeRoute): boolean {
	if (model.provider === "opencode" || model.provider === "opencode-go") return true;
	try {
		const url = new URL(model.baseUrl ?? "");
		return (url.protocol === "https:" || url.protocol === "http:") && url.hostname === "opencode.ai";
	} catch {
		return false;
	}
}

/** 显式头（包括空串/null）按大小写不敏感优先；无会话 ID 时绝不伪造随机 ID。 */
export function addOpenCodeHeaders(headers: ProviderHeaders, sessionId?: string): ProviderHeaders {
	const names = new Set(Object.keys(headers).map((key) => key.toLowerCase()));
	const next = { ...headers };
	if (sessionId && !names.has("x-opencode-session")) next["x-opencode-session"] = sessionId;
	if (!names.has("x-opencode-client")) next["x-opencode-client"] = "pideck";
	return next;
}

/** 在 pi-ai 合并 model/auth/request headers 之后兜底，避免自动值反盖手动配置。 */
function requestOptions<T extends RequestOptions>(model: OpenCodeRoute, options: T): T {
	if (!isOpenCodeRoute(model)) return options;
	const transform = options.transformHeaders;
	return {
		...options,
		transformHeaders: transform ? async (headers: ProviderHeaders) => addOpenCodeHeaders(await transform(headers), options.sessionId) : (headers: ProviderHeaders) => addOpenCodeHeaders(headers, options.sessionId),
	};
}

/** 动态依赖先检查公开方法形状；不假定 app 内置 pi-ai 与 DSH runtime 是同一份。 */
function hasStreamMethods(value: unknown): value is StreamMethods {
	return typeof value === "object" && value !== null && "streamSimple" in value && typeof value.streamSimple === "function";
}

/**
 * 安装到实际 runtime 的 Models.streamSimple（DSH adapter 的唯一流入口），
 * 覆盖其后创建的配置快照；其它 pi-ai API 不动。DSH 的 llm/stream 事件只暴露冻结的业务 options，不提供 HTTP 头 hook；这里使用
 * pi-ai 的 transformHeaders 扩展点，保留原有惰性流、取消与鉴权，不碰私有 adapter 字段。
 * 每次请求闭包捕获自身 sessionId，不能以共享 profile.headers 承载并发会话身份。
 */
export function installDshOpenCodeHeaders(piAiModule: unknown): () => void {
	if (typeof piAiModule !== "object" || piAiModule === null || !("createModels" in piAiModule) || typeof piAiModule.createModels !== "function") {
		throw new Error("DSH pi-ai does not expose createModels");
	}
	const models: unknown = piAiModule.createModels();
	if (!hasStreamMethods(models)) throw new Error("DSH pi-ai Models stream API is unavailable");
	const prototype: unknown = Object.getPrototypeOf(models);
	if (!hasStreamMethods(prototype) || models.streamSimple !== prototype.streamSimple) {
		throw new Error("DSH pi-ai Models stream API layout has changed");
	}
	let installation = installations.get(prototype);
	if (!installation) {
		const originalSimple = prototype.streamSimple;
		const streamSimple: Models["streamSimple"] = function (this: Models, model, context, options) {
			return originalSimple.call(this, model, context, requestOptions(model, options ?? {}));
		};
		// 只写一个方法：若未来 runtime 冻结原型，安装失败也不会留下半安装状态。
		prototype.streamSimple = streamSimple;
		installation = {
			users: 0,
			restore: () => {
				// 不反盖后来安装的其它 wrapper；host 销毁与测试清理都可安全重复调用。
				if (prototype.streamSimple === streamSimple) prototype.streamSimple = originalSimple;
			},
		};
		installations.set(prototype, installation);
	}
	installation.users += 1;
	let disposed = false;
	return () => {
		if (disposed) return;
		disposed = true;
		installation.users -= 1;
		if (installation.users === 0) {
			installation.restore();
			installations.delete(prototype);
		}
	};
}

/** 对包清单做最小收窄；未知 exports 形状留给调用方诊断，不猜内部路径。 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 以 DSH adapter 为父模块解析其 pi-ai（可能是嵌套的旧版本）。该包只有 import export，
 * createRequire().resolve() 会报 ERR_PACKAGE_PATH_NOT_EXPORTED，不能退回 app 顶层同名包。
 * findPackageJSON 负责 Node 的就近查找，再读取声明的 import 入口；不硬编码 dist 路径。
 */
export function resolveDshPiAiEntry(adapterEntry: string): string {
	const manifestPath = findPackageJSON("@earendil-works/pi-ai", pathToFileURL(adapterEntry));
	if (!manifestPath) throw new Error("DSH pi-ai package could not be resolved");
	const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
	const exports = isRecord(manifest) && isRecord(manifest.exports) ? manifest.exports : undefined;
	const root = exports?.["."];
	const entry = typeof root === "string" ? root : isRecord(root) ? root.import : undefined;
	if (typeof entry !== "string" || !entry.startsWith("./")) throw new Error("DSH pi-ai import entry is unsupported");
	return fileURLToPath(new URL(entry, pathToFileURL(manifestPath)));
}

/** host 在 config-tree 挂载前调用；加载失败由 host 记录诊断并继续启动。 */
export async function loadDshOpenCodeHeaders(adapterEntry: string, loadModule: (url: string) => Promise<unknown> = (url) => import(url)): Promise<() => void> {
	const piAiModule = await loadModule(pathToFileURL(resolveDshPiAiEntry(adapterEntry)).href);
	return installDshOpenCodeHeaders(piAiModule);
}
