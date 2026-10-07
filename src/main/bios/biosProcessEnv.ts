/**
 * BM-07A C3 / R33-3：**权威 BIOS 进程环境构造**（纯函数，零运行时依赖）。
 *
 * 为什么单独一个文件：这段逻辑必须出现在**进程装配层**（`PiProcess.start()`）里，而那里被
 * 既有 VM 沙箱测试用受限 `require` 加载——如果它 import 了 `packages/bios-agent` 的 core，
 * 那些测试会因为解析不到 `.ts` 依赖而整批 MODULE_NOT_FOUND。所以这里只做字符串/数组处理，
 * 类型用 `import type`（编译期擦除，运行时不产生 require）。
 *
 * 三条硬规则（R33-3）：
 * 1. **先清除、再写权威值**：宿主 `process.env` 可能带着上一次会话/上一次运行的 BIOS 配置，
 *    只"补非空值"会让旧知识根、旧授权、`BIOS_ALLOW_INTERNAL_GENERAL=1` 继续残留；
 * 2. **空值也要显式写**：空授权写空串、无选择写空串、默认关闭写 `0`——
 *    "未配置"必须能被扩展读成"未授权"，而不是"继承上一次"；
 * 3. **不留下开启意图**：禁用/未配置时只写 `BIOS_ENDPOINT=unknown` 与关闭状态，
 *    扩展据此保持惰性（不自动注入），也不会因为环境里残留的选择而"看起来已启用"。
 */
import { randomUUID } from "node:crypto";
import { BIOS_AUTOMATION_DEFAULTS, type BiosAutomationSettings, type BiosEndpointGrant, type BiosEndpointPolicy, type BiosHostSettings, type BiosSessionSelection } from "../../shared/types/bios.ts";

/**
 * 当前**进程启动标识**：让"上次运行留下的会话选择"在重启后保守关闭
 * （选择只存 ID 与非敏感开关；重启后即便记录还在也不沿用"已打开"，必须由扩展重新验证）。
 * 模块级常量 ⇒ 同一进程内稳定；不落盘，因此重启必然换值。
 */
const BOOT_ID = randomUUID();

/** 当前进程的启动标识（同一进程内稳定）。 */
export function currentBiosBootId(): string {
	return BOOT_ID;
}

/**
 * 本包**明确列举**的配置键（清除与写入都以这份清单为准）。
 *
 * 新增配置键必须同时登记在这里，否则旧值会从宿主环境继承进来。
 */
export const BIOS_CONFIG_ENV_KEYS = [
	"BIOS_KNOWLEDGE_ROOT",
	"BIOS_AUTHORIZED_PROJECTS",
	"BIOS_ALLOWED_FEATURE_IDS",
	"BIOS_APPROVED_CUSTOMERS",
	"BIOS_AUTHORIZED_ROOTS",
	"BIOS_ENDPOINT",
	"BIOS_ENDPOINT_GRANT",
	"BIOS_ALLOW_INTERNAL_GENERAL",
	"BIOS_SELECTED_PROJECT_ID",
	"BIOS_SELECTED_TASK_ID",
	"BIOS_SELECTED_WORKSPACE_ID",
	"BIOS_CONTEXT_ENABLED",
	"BIOS_AUTOMATION_ENABLED",
	"BIOS_AUTOMATION_BOOKKEEPING",
	"BIOS_AUTOMATION_INJECT",
	"BIOS_AUTOMATION_VERSION",
] as const;

/** 归一化自动化许可：非布尔/非法版本一律回到安全默认（未授予）。 */
export function normalizeBiosAutomationSettings(input: Partial<BiosAutomationSettings> | null | undefined): BiosAutomationSettings {
	const enabled = input?.enabled === true;
	const version = typeof input?.version === "number" && Number.isFinite(input.version) && input.version > 0 ? Math.floor(input.version) : enabled ? 1 : 0;
	if (!enabled) return { ...BIOS_AUTOMATION_DEFAULTS };
	return { enabled: true, localBookkeeping: input?.localBookkeeping === true, injectProjectData: input?.injectProjectData === true, version };
}

/** 归一化设置（缺省即拒绝：值非法一律回到安全默认）。 */
export function normalizeBiosHostSettings(input: Partial<BiosHostSettings> | null | undefined): BiosHostSettings {
	const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim()) : []);
	const endpoint: BiosEndpointPolicy = input?.endpoint === "allowed" || input?.endpoint === "denied" ? input.endpoint : "unknown";
	return {
		knowledgeRoot: typeof input?.knowledgeRoot === "string" && input.knowledgeRoot.trim() !== "" ? input.knowledgeRoot.trim() : null,
		authorizedProjectIds: strings(input?.authorizedProjectIds),
		allowedFeatureIds: strings(input?.allowedFeatureIds),
		approvedCustomers: strings(input?.approvedCustomers),
		authorizedRoots: strings(input?.authorizedRoots),
		endpoint,
		// D4：具名许可只接受**完整**身份（provider/modelId/origin 三件套 + 正版本号）；
		// 不完整的一律回到 null（宁可不绑定，也不绑一个半截许可）。
		// 不变式：策略不是 allowed 时许可无意义 ⇒ 一并清掉（撤权后不残留旧许可）。
		endpointGrant: endpoint === "allowed" ? normalizeEndpointGrant(input?.endpointGrant) : null,
		automation: normalizeBiosAutomationSettings(input?.automation),
	};
}

/**
 * D4：归一化具名端点许可。
 *
 * 三条安全规则：
 * - 三件套必须**都有非空值**（provider / modelId / origin），否则整体丢弃（不能只绑一半）；
 * - `origin` 只接受 HTTP(S) **源**（拒绝带凭据、路径、query、fragment 的值，避免把密钥写进配置）；
 * - 版本号必须是正整数，否则丢弃。
 */
export function normalizeEndpointGrant(input: unknown): BiosEndpointGrant | null {
	if (input === null || input === undefined || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
	const provider = text(record.provider);
	const modelId = text(record.modelId);
	const version = typeof record.version === "number" && Number.isSafeInteger(record.version) && record.version > 0 ? record.version : 0;
	if (provider === "" || provider.length > 200 || modelId === "" || modelId.length > 200 || version === 0) return null;
	const origin = normalizeOriginOnly(text(record.origin));
	if (origin === null) return null;
	return { provider, modelId, origin, version };
}

/** 只保留 HTTP(S) 源；带凭据/路径/参数/哈希或非 HTTP(S) 一律拒绝（返回 null）。 */
function normalizeOriginOnly(value: string): string | null {
	if (value === "" || value.length > 2048) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.username !== "" || url.password !== "") return null;
		if (url.search !== "" || url.hash !== "") return null;
		if (url.pathname !== "" && url.pathname !== "/") return null;
		return url.origin;
	} catch {
		return null;
	}
}

/** 注入子进程的选择（只含 ID 与非敏感开关）。 */
export type BiosEnvSelection = {
	readonly projectId: string | null;
	readonly taskId: string | null;
	readonly workspaceId: string | null;
	readonly contextEnabled: boolean;
};

/**
 * 权威值：**总是**给出全部列举键的当前取值（空授权=空串、无选择=空串、关闭=`0`）。
 *
 * 空字符串对扩展是安全的"未配置"：列表解析结果为空数组，知识根解析回退到默认来源后
 * 被 `readBiosHostConfig` 判为"未配置"，因此不会猜目录也不会读记录。
 */
export function biosProcessEnv(settings: BiosHostSettings, selection?: BiosEnvSelection): Record<string, string> {
	return {
		BIOS_KNOWLEDGE_ROOT: settings.knowledgeRoot ?? "",
		BIOS_AUTHORIZED_PROJECTS: settings.authorizedProjectIds.join(","),
		BIOS_ALLOWED_FEATURE_IDS: settings.allowedFeatureIds.join(","),
		BIOS_APPROVED_CUSTOMERS: settings.approvedCustomers.join(","),
		BIOS_AUTHORIZED_ROOTS: settings.authorizedRoots.join(";"),
		BIOS_ENDPOINT: settings.endpoint,
		// D4：具名端点许可（JSON）。没有绑定时写空串 —— 扩展按"未绑定"处理，沿用全局策略。
		BIOS_ENDPOINT_GRANT: settings.endpointGrant ? JSON.stringify(settings.endpointGrant) : "",
		// 桌面不授予 internal-general 复用：显式写 0，清掉可能继承来的 1。
		BIOS_ALLOW_INTERNAL_GENERAL: "0",
		BIOS_SELECTED_PROJECT_ID: selection?.projectId ?? "",
		BIOS_SELECTED_TASK_ID: selection?.taskId ?? "",
		BIOS_SELECTED_WORKSPACE_ID: selection?.workspaceId ?? "",
		BIOS_CONTEXT_ENABLED: selection?.contextEnabled === true ? "1" : "0",
		// AW：自动化许可总是显式写入（关闭时写 0/空，清掉可能继承来的旧许可）。
		BIOS_AUTOMATION_ENABLED: settings.automation.enabled ? "1" : "0",
		BIOS_AUTOMATION_BOOKKEEPING: settings.automation.localBookkeeping ? "1" : "0",
		BIOS_AUTOMATION_INJECT: settings.automation.injectProjectData ? "1" : "0",
		BIOS_AUTOMATION_VERSION: String(settings.automation.enabled ? settings.automation.version : 0),
	};
}

/** 先清除列举键、再写权威值（就地修改并返回同一个 env 对象，便于装配层直接使用）。 */
export function applyBiosEnv(env: Record<string, string | undefined>, settings: BiosHostSettings, selection?: BiosEnvSelection): Record<string, string | undefined> {
	for (const key of BIOS_CONFIG_ENV_KEYS) delete env[key];
	const authoritative = biosProcessEnv(settings, selection);
	for (const [key, value] of Object.entries(authoritative)) env[key] = value;
	return env;
}

/**
 * 会话选择解析（R33-2/R33-3）：**按稳定 sessionId 归属**，重启后保守关闭。
 *
 * - 只有当前进程启动标识（`bootId`）与记录一致时才沿用 `contextEnabled`；
 *   重启后即便记录还在也一律当作"未打开"，由扩展重新验证后再打开；
 * - 找不到该会话的条目 ⇒ 无选择（不回退到"别的会话的选择"，也不回退到全局意图）。
 */
export function resolveSessionSelection(stored: { readonly bySession: Record<string, BiosSessionSelection>; readonly bootId: string | null } | null | undefined, currentBootId: string, sessionId: string | null): BiosEnvSelection | undefined {
	if (sessionId === null || stored === null || stored === undefined) return undefined;
	const entry = stored.bySession?.[sessionId];
	if (entry === undefined) return undefined;
	const sameBoot = stored.bootId !== null && stored.bootId === currentBootId;
	return { projectId: entry.projectId, taskId: entry.taskId, workspaceId: entry.workspaceId, contextEnabled: sameBoot && entry.contextEnabled };
}
