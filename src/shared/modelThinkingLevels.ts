/**
 * 每模型「默认思考档位」的统一读写工具（pi settings.json 的 modelThinkingLevels）。
 *
 * 为什么需要 shared：同一张映射有三个消费方，各自手写键格式/裁剪必然漂移——
 *   1. 主进程 resolveLaunchDefaultOptions / createDraft：解析新会话的预选思考档位；
 *   2. 配置页模型表：读写单个模型的默认档位（与全局 defaultThinkingLevel 共用
 *      settings.json 的保存链路）；
 *   3. 引导页展示：按当前展示的模型反查档位，保证「创建前显示 = 创建时套用」。
 *
 * 键格式与 pi 自己的 settings-manager 完全一致：`${provider}/${modelId}`。
 * 值域是 pi 的规范档位；这里**不**对值做白名单裁剪——档位最终由 pi 裁决
 *（setThinkingLevel 会按该模型 available levels 收敛），PiDeck 只存用户的选择，
 * 不落第二份能力副本。解析函数同样只做「非空字符串」过滤，脏形状逐级降级。
 *
 * 纯函数、无依赖（shared 层约束）。
 */

/** pi 的规范思考档位（与 ThinkingLevelMap 的键一致），供选择器在能力未知时兜底列全量。 */
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

/** pi settings-manager 使用的映射键（provider/modelId，不做任何转义）。 */
export function modelThinkingLevelsKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/**
 * 把任意档位列表按 pi 的规范档位顺序排列，供配置页下拉与只读展示共用。
 * pi capability 探测返回的顺序不保证稳定；不认识的档位（未来新增）按原序排在后面，不丢项。
 */
export function orderModelThinkingLevels(levels: readonly string[]): string[] {
	const known: string[] = MODEL_THINKING_LEVELS.filter((level) => levels.includes(level));
	const extra = levels.filter((level) => !(MODEL_THINKING_LEVELS as readonly string[]).includes(level));
	return [...known, ...extra];
}

/**
 * 从 pi settings 对象里解析「每模型默认档位」表。
 * 逐项只保留非空字符串值；整表为空/形状不对时返回 undefined（调用方据此走全局默认）。
 */
export function parseModelThinkingLevels(settings: unknown): Record<string, string> | undefined {
	if (!isRecord(settings)) return undefined;
	const raw = settings.modelThinkingLevels;
	if (!isRecord(raw)) return undefined;
	const levels: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw)) {
		// 值两端空白顺手裁掉：它会一路流到会话记录与 pi 的档位入参，带空白等于无法识别的档位。
		if (key && typeof value === "string" && value.trim()) levels[key] = value.trim();
	}
	return Object.keys(levels).length > 0 ? levels : undefined;
}

/**
 * 按 provider/modelId 从已解析的映射表里取默认档位。
 * provider/modelId 缺失（旧数据、半结构偏好）或值非法时返回 undefined。
 */
export function modelThinkingLevelOfMap(map: unknown, provider: string | undefined, modelId: string | undefined): string | undefined {
	if (!provider || !modelId) return undefined;
	if (!isRecord(map)) return undefined;
	const value = map[modelThinkingLevelsKey(provider, modelId)];
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** 直接从 pi settings 对象里取某模型的默认档位（内部读 modelThinkingLevels 子表）。 */
export function modelThinkingLevelOf(settings: unknown, provider: string | undefined, modelId: string | undefined): string | undefined {
	return modelThinkingLevelOfMap(isRecord(settings) ? settings.modelThinkingLevels : undefined, provider, modelId);
}

/**
 * 写入/清除某模型的默认档位，返回新的 settings 对象（不可变更新，供 React setState 使用）。
 * level 为空/空白 = 删除该键；表被清空时连 modelThinkingLevels 一起删（不留空对象）。
 * 表内其它键原样保留（含用户手写的自定义键），不整表重建。
 */
export function withModelThinkingLevelDefault(settings: Record<string, unknown>, provider: string, modelId: string, level: string | undefined): Record<string, unknown> {
	const current = isRecord(settings.modelThinkingLevels) ? settings.modelThinkingLevels : {};
	const next = { ...current };
	const trimmed = typeof level === "string" ? level.trim() : "";
	if (trimmed) next[modelThinkingLevelsKey(provider, modelId)] = trimmed;
	else delete next[modelThinkingLevelsKey(provider, modelId)];
	const updated: Record<string, unknown> = { ...settings };
	if (Object.keys(next).length > 0) updated.modelThinkingLevels = next;
	else delete updated.modelThinkingLevels;
	return updated;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
