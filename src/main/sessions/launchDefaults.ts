import type { ResolveLaunchDefaultsInput, ResolvedLaunchDefaults } from "../../shared/types";
import { createSessionModelPreference } from "../../shared/modelDisplayName";

/**
 * 会话「默认启动偏好」解析器：createDraft 缺省填充与引导页展示共用，保证
 * 「底栏/选择器预选的默认值」与「首次发送时真实套用的默认值」永远一致。
 *
 * 规则（引导页点选优先——本条规则取代更早的「显式默认 > 偏好」排序，见下）：
 * - 模型仅对非 DSH 后端解析——pi 模型配置不适用于 DSH（模型路由由 DSH host
 *   自己的 settings 决定）。解析优先级：
 *     1. 引导页点选模型（渲染层传入的 welcomeModel：用户在「新建 agent 页」刚做的
 *        显式选择。用户规则：本会话就用我选的，点选不得被静态配置静默覆盖）；
 *     2. settings.defaultProvider + defaultModel（用户显式配置的默认模型，有效才算）；
 *     3. settings.enabledModels（pi 的模型切换列表，用户显式维护，glob 匹配）；
 *     4. 用户最后一次实际使用的模型（desktop settings.lastUsedModel，发送时自动记录）；
 *     5. 以上皆无／全部失效 → 空（不再回退 models.json 第一个模型：用户规则
 *        「上次也没有就是默认是空的」，避免在用户删光模型后仍预选到残留项）。
 *   为什么点选排第一：welcomeModel 只有引导页提升为真实会话这一条链路会传（见
 *   main/ipc/sessionIpc.ts createDraft），它表达的是「这一次新建要用哪个模型」的即时
 *   意图；而默认模型/切换列表是长期配置，只应在用户本次没有点选时充当预选值。
 *   旧排序把点选压在第 3 级，导致配置了有效默认模型时引导页选择 100% 静默失效
 *   （症状：切不动的一直显示默认模型；页面看似切了、发送后仍用旧模型）。
 *   **每个来源都会校验目标模型确实仍存在于 models.json**：供应商/模型被删除后，
 *   失效来源自动跳过，保证新会话（底栏预选与真实套用）不再默认已删除的模型。
 * - defaultModelConfigured 仅标记「是否存在有效的显式配置默认模型」，供调用方做文案
 *   与诊断用；它**不再**作为渲染层展示回退的闸门（展示与创建必须同序，否则再次分叉）。
 * - 思考档位对两种后端都填充（值域 off/high/max 兼容），一律取 settings.defaultThinkingLevel
 *   （用户规则：思考级别只跟"默认级别"走，欢迎页偏好级别不参与）。
 *
 * 输入是磁盘 JSON（pi settings / models.json / desktop settings），字段类型不可信：
 * 用 unknown 收窄，任何字段缺失/类型异常都不抛错，而是逐级降级为 undefined。
 */
export function resolveLaunchDefaultOptions(input: {
	backend?: ResolveLaunchDefaultsInput["backend"];
	settings: unknown;
	models: unknown;
	/** 桌面端记录的「用户最后一次使用的模型」（userData/settings.json 的 lastUsedModel）。 */
	lastUsedModel?: unknown;
	/** 渲染层欢迎页（引导页）偏好模型；仅在无显式默认时参与回退。 */
	welcomeModel?: unknown;
}): ResolvedLaunchDefaults {
	const defaults: ResolvedLaunchDefaults = {};
	if (input.backend !== "dsh") {
		// 显式默认只解析一次：defaultModelConfigured 仅作「是否存在有效显式默认」的诊断标记
		// 返回（供文案/排查用）；渲染层展示不再拿它当闸门——展示与创建统一按点选优先。
		const explicit = strictModelPair(input.settings, input.models);
		if (explicit) defaults.defaultModelConfigured = true;
		// 仅在解析成功时落键：空结果必须是真 {}，调用方才能用 presence 判断是否预选
		// 优先级：引导页点选 > 显式默认 > enabledModels（pi 模型切换列表）> 上次使用 > 空。
		const model = welcomeModelOfModelsConfig(input.welcomeModel, input.models) ?? explicit ?? enabledModelsOfModelsConfig(input.settings, input.models) ?? lastUsedModelOfModelsConfig(input.lastUsedModel, input.models);
		if (model) defaults.model = model;
	}
	const thinkingLevel = optionalString(input.settings, "defaultThinkingLevel");
	if (thinkingLevel) defaults.thinkingLevel = thinkingLevel;
	return defaults;
}

/**
 * settings.defaultProvider/defaultModel 同时为字符串、且两者确实存在于 models.json
 * 才算有效配对（避免半配置进入回退歧义；避免默认指向已删除的供应商/模型）。
 */
function strictModelPair(settings: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	const provider = optionalString(settings, "defaultProvider");
	const modelId = optionalString(settings, "defaultModel");
	if (!provider || !modelId) return undefined;
	return modelPreferenceFromModelsConfig(models, provider, modelId);
}

/** 显式传入的 model（如欢迎页偏好）是否存在：不存在视为无效，调用方应回退解析默认。 */
export function isModelInModelsConfig(models: unknown, model: { provider: string; modelId: string }): boolean {
	return modelExistsInModelsConfig(models, model.provider, model.modelId);
}

/** lastUsedModel（桌面端记录）同样必须仍存在于 models.json，删除后自动失效回退。 */
function lastUsedModelOfModelsConfig(lastUsed: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(lastUsed)) return undefined;
	const provider = lastUsed.provider;
	const modelId = lastUsed.modelId;
	if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
	if (!provider || !modelId) return undefined;
	return modelPreferenceFromModelsConfig(models, provider, modelId);
}

function modelPreferenceFromModelsConfig(models: unknown, provider: string, modelId: string): ResolvedLaunchDefaults["model"] {
	if (!isRecord(models)) return undefined;
	const providers = models.providers;
	if (!isRecord(providers)) return undefined;
	const providerEntry = providers[provider];
	if (!isRecord(providerEntry) || !Array.isArray(providerEntry.models)) return undefined;
	const model = providerEntry.models.find((candidate) => isRecord(candidate) && candidate.id === modelId);
	if (!isRecord(model)) return undefined;
	return createSessionModelPreference(provider, modelId, model.name);
}

/** 模型是否存在于 models.json（provider 键 + models 数组 id 精确匹配）。 */
function modelExistsInModelsConfig(models: unknown, provider: string, modelId: string): boolean {
	if (!isRecord(models)) return false;
	const providers = models.providers;
	if (!isRecord(providers)) return false;
	const providerEntry = providers[provider];
	if (!isRecord(providerEntry) || !Array.isArray(providerEntry.models)) return false;
	return providerEntry.models.some((model) => isRecord(model) && model.id === modelId);
}

/** 欢迎页偏好模型：必须形如 { provider, modelId } 且仍存在于 models.json，否则视为无偏好。 */
function welcomeModelOfModelsConfig(welcome: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(welcome)) return undefined;
	const provider = welcome.provider;
	const modelId = welcome.modelId;
	if (typeof provider !== "string" || typeof modelId !== "string") return undefined;
	if (!provider || !modelId || !modelExistsInModelsConfig(models, provider, modelId)) return undefined;
	// 引导页已在用户点选的瞬间保存名称快照。这里只做存在性校验，不能再次以当前
	// models.json 的别名覆盖它，否则用户配置在两次操作之间更新会让底栏跳变。
	return createSessionModelPreference(provider, modelId, welcome.modelName);
}

/** settings.enabledModels（pi 的 Ctrl+P 模型切换列表，glob 模式，格式同 --models）：
 *  顺序取第一个能在 models.json 中匹配到实际模型的 pattern，返回匹配的模型。
 *  pattern 含 / 视为 provider/modelId（两段各自 glob 匹配），否则按 modelId 匹配任意 provider。 */
function enabledModelsOfModelsConfig(settings: unknown, models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(settings)) return undefined;
	const enabled = settings.enabledModels;
	if (!Array.isArray(enabled)) return undefined;
	for (const pattern of enabled) {
		if (typeof pattern !== "string" || !pattern) continue;
		const matched = matchEnabledModelPattern(pattern, models);
		if (matched) return matched;
	}
	return undefined;
}

/** 一个 enabledModels pattern 匹配 models.json 中的第一个模型（models.json provider 顺序）。 */
function matchEnabledModelPattern(pattern: string, models: unknown): ResolvedLaunchDefaults["model"] {
	if (!isRecord(models)) return undefined;
	const providers = models.providers;
	if (!isRecord(providers)) return undefined;
	// pattern 含 / 时对应 provider/modelId（两段分别 glob）；bare pattern 只匹配 modelId
	const [patternProvider, patternModelId] = pattern.includes("/") ? pattern.split("/") : [undefined, pattern];
	for (const [providerName, provider] of Object.entries(providers)) {
		if (patternProvider && !globMatch(patternProvider, providerName)) continue;
		if (!isRecord(provider) || !Array.isArray(provider.models)) continue;
		for (const model of provider.models) {
			if (!isRecord(model) || typeof model.id !== "string") continue;
			if (globMatch(patternModelId, model.id)) {
				return createSessionModelPreference(providerName, model.id, model.name);
			}
		}
	}
	return undefined;
}

/** 极简 glob 匹配（支持 * 与 ?；* 不跨越 /，与 minimatch 单段语义一致）。 */
function globMatch(pattern: string, value: string): boolean {
	// 逐字符构建正则：* → [^/]*，? → [^/]，其余转义字面量
	let regex = "^";
	for (const char of pattern) {
		if (char === "*") regex += "[^/]*";
		else if (char === "?") regex += "[^/]";
		else regex += char.replace(/[.+^${}()[\]\\|]/g, "\\$&");
	}
	regex += "$";
	return new RegExp(regex).test(value);
}

function optionalString(source: unknown, key: string): string | undefined {
	if (!isRecord(source)) return undefined;
	const value = source[key];
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
