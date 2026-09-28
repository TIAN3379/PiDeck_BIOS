import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

// resolveLaunchDefaultOptions：会话「默认启动偏好」解析器。
// createDraft 缺省填充与引导页底栏预选共用同一解析，保证「展示的默认」与
// 「首次发送真实套用的默认」一致——这里锁住降级规则，防止两边再次分叉。
//
// 用户规则（引导页点选优先）：点选（welcomeModel）> 显式默认 > enabledModels > 上次使用 > 空。
// 长期配置（显式默认 / 模型切换列表）只在用户本次没有点选时充当预选值。
// 思考级别一律取 settings.defaultThinkingLevel（偏好级别不参与）。

function loadResolver() {
	const source = readFileSync("src/main/sessions/launchDefaults.ts", "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: "launchDefaults.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) => {
				if (specifier === "../../shared/modelDisplayName") {
					return {
						createSessionModelPreference: (provider, modelId, modelName) => ({
							provider,
							modelId,
							modelName: typeof modelName === "string" && modelName.trim() ? modelName.trim() : modelId,
						}),
					};
				}
				return {};
			},
		},
		{ filename: "launchDefaults.ts" },
	);
	return module.exports.resolveLaunchDefaultOptions;
}

const resolve = loadResolver();

// vm 独立 realm 里创建的对象原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const fullPlain = (value) => (value && typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value);
// 既有优先级用例只关心 provider/id；显示快照由下方专门用例逐字段断言。
const plain = (value) => {
	const normalized = fullPlain(value);
	if (!normalized || typeof normalized !== "object" || !("modelName" in normalized)) return normalized;
	const { modelName: _modelName, ...identity } = normalized;
	return identity;
};

const OPENAI = { providers: { openai: { models: [{ id: "gpt-5.2" }] } } };
const MANY = {
	providers: {
		openai: { models: [{ id: "gpt-5.2" }] },
		zhipu: { models: [{ id: "glm-5" }] },
		anthropic: { models: [{ id: "claude-opus-4-6" }] },
	},
};

test("默认和欢迎页模型都会产出完整名称快照", () => {
	const models = {
		providers: {
			router9: { models: [{ id: "qd/qfmodel", name: " Config alias " }] },
		},
	};
	const configured = resolve({
		settings: { defaultProvider: "router9", defaultModel: "qd/qfmodel" },
		models,
	});
	assert.deepEqual(fullPlain(configured.model), {
		provider: "router9",
		modelId: "qd/qfmodel",
		modelName: "Config alias",
	});

	const picked = resolve({
		settings: {},
		models,
		welcomeModel: { provider: "router9", modelId: "qd/qfmodel", modelName: " Selected locally " },
	});
	assert.deepEqual(fullPlain(picked.model), {
		provider: "router9",
		modelId: "qd/qfmodel",
		modelName: "Selected locally",
	});

	const blank = resolve({
		settings: {},
		models,
		welcomeModel: { provider: "router9", modelId: "qd/qfmodel", modelName: "   " },
	});
	assert.deepEqual(fullPlain(blank.model), {
		provider: "router9",
		modelId: "qd/qfmodel",
		modelName: "qd/qfmodel",
	});
});

test("引导页点选优先于显式默认（用户规则第 1 条），但 configured 标记仍为 true", () => {
	const result = resolve({
		settings: { defaultProvider: "anthropic", defaultModel: "claude-opus-4-6" },
		models: MANY,
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
		welcomeModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	// 用户在「新建 agent 页」显式点选的模型必须胜出：它表达的是本次新建的即时意图；
	// 旧规则把它压在第 3 级，导致配置了有效默认模型时点选 100% 静默失效。
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
	// 标记仍为 true：确实存在有效的显式配置默认（供文案/诊断用，不再作为展示闸门）。
	assert.equal(result.defaultModelConfigured, true);
});

test("无点选时：显式默认优先于 enabledModels 与 lastUsed（用户规则第 2 条）", () => {
	const result = resolve({
		settings: {
			defaultProvider: "anthropic",
			defaultModel: "claude-opus-4-6",
			enabledModels: ["openai/*"],
		},
		models: MANY,
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
	});
	assert.deepEqual(plain(result.model), { provider: "anthropic", modelId: "claude-opus-4-6" });
	assert.equal(result.defaultModelConfigured, true);
});

test("无显式默认：引导页点选优先于 lastUsed（用户规则第 1 条）", () => {
	const result = resolve({
		settings: {},
		models: MANY,
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
		welcomeModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
	assert.equal(result.defaultModelConfigured, undefined);
});

test("无显式默认与偏好：lastUsed 兜底（用户规则第 4 条）", () => {
	const result = resolve({
		settings: {},
		models: MANY,
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
	});
	assert.deepEqual(plain(result.model), { provider: "zhipu", modelId: "glm-5" });
	assert.equal(result.defaultModelConfigured, undefined);
});

test("无显式默认、无偏好、无 lastUsed：默认是空的（用户规则第 5 条，不再回退第一个模型）", () => {
	const result = resolve({ settings: {}, models: MANY });
	assert.equal(result.model, undefined);
	assert.equal(result.defaultModelConfigured, undefined);
});

test("显式默认指向已删除供应商/模型 → 视为未配置，回退偏好/lastUsed", () => {
	const result = resolve({
		settings: { defaultProvider: "deleted-provider", defaultModel: "deleted-model" },
		models: MANY,
		welcomeModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
	assert.equal(result.defaultModelConfigured, undefined);
});

test("偏好指向已删除模型 → 跳过偏好，回退 lastUsed", () => {
	const result = resolve({
		settings: {},
		models: MANY,
		lastUsedModel: { provider: "zhipu", modelId: "glm-5" },
		welcomeModel: { provider: "deleted-provider", modelId: "old" },
	});
	assert.deepEqual(plain(result.model), { provider: "zhipu", modelId: "glm-5" });
});

test("lastUsed 非法形状（非对象/半结构）被忽略，返回空（无可回退来源）", () => {
	for (const bad of [null, "zhipu/glm-5", { provider: "zhipu" }, { modelId: "glm-5" }, { provider: 42, modelId: "x" }]) {
		const result = resolve({ settings: {}, models: OPENAI, lastUsedModel: bad });
		assert.equal(result.model, undefined);
	}
});

test("welcome 偏好非法形状被忽略，返回空", () => {
	for (const bad of [null, "openai/gpt-5.2", { provider: "openai" }, { modelId: "gpt-5.2" }, { provider: 42, modelId: "x" }]) {
		const result = resolve({ settings: {}, models: OPENAI, welcomeModel: bad });
		assert.equal(result.model, undefined);
	}
});

test("dsh 后端忽略模型来源（模型归属 host settings），思考档位仍填充", () => {
	const result = resolve({
		backend: "dsh",
		settings: { defaultThinkingLevel: "high" },
		models: OPENAI,
		lastUsedModel: { provider: "openai", modelId: "gpt-5.2" },
		welcomeModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.equal(result.model, undefined);
	assert.equal(result.defaultModelConfigured, undefined);
	assert.equal(result.thinkingLevel, "high");
});

test("思考级别一律取 settings.defaultThinkingLevel（偏好/模型来源不影响）", () => {
	const result = resolve({
		settings: { defaultThinkingLevel: "max", defaultProvider: "openai", defaultModel: "gpt-5.2" },
		models: OPENAI,
	});
	assert.equal(result.thinkingLevel, "max");
	// 无 defaultThinkingLevel 时为空（不回落）
	const none = resolve({ settings: {}, models: OPENAI });
	assert.equal(none.thinkingLevel, undefined);
});

test("half-configured settings（只有 defaultProvider）不进回退歧义", () => {
	const result = resolve({
		settings: { defaultProvider: "anthropic" },
		models: MANY,
	});
	// 无法配对 → 无显式默认、无偏好、无 lastUsed → 空
	assert.equal(result.model, undefined);
	assert.equal(result.defaultModelConfigured, undefined);
});

test("dirty inputs degrade to empty defaults instead of throwing", () => {
	const cases = [
		{ settings: null, models: undefined },
		{ settings: ["not", "an", "object"], models: 42 },
		{ settings: { defaultThinkingLevel: 3 }, models: { providers: {} } },
	];
	for (const input of cases) {
		assert.deepEqual(plain(resolve({ ...input })), {});
	}
});

// ---- enabledModels（pi 模型切换列表，用户规则：优先级在显式默认之后）----

test("无显式默认：enabledModels 第一个可用模型成为默认（用户规则）", () => {
	const result = resolve({
		settings: { enabledModels: ["ai88/deepseek-v4-flash-vision-exp"] },
		models: {
			providers: {
				ai88: { models: [{ id: "deepseek-v4-flash-vision-exp" }] },
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "ai88", modelId: "deepseek-v4-flash-vision-exp" });
	assert.equal(result.defaultModelConfigured, undefined);
});

test("显式默认存在时 enabledModels 不参与（优先级在默认之后）", () => {
	const result = resolve({
		settings: {
			defaultProvider: "openai",
			defaultModel: "gpt-5.2",
			enabledModels: ["ai88/deepseek-v4-flash-vision-exp"],
		},
		models: {
			providers: {
				ai88: { models: [{ id: "deepseek-v4-flash-vision-exp" }] },
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
	assert.equal(result.defaultModelConfigured, true);
});

test("enabledModels glob 匹配（provider/modelId 段分别 glob）", () => {
	const result = resolve({
		settings: { enabledModels: ["ai88/*", "openai/*"] },
		models: {
			providers: {
				ai88: { models: [{ id: "deepseek-v4-flash-vision-exp" }] },
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "ai88", modelId: "deepseek-v4-flash-vision-exp" });
});

test("bare modelId pattern 匹配任意 provider", () => {
	const result = resolve({
		settings: { enabledModels: ["gpt-*"] },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }, { id: "gpt-5.2-mini" }] },
				zhipu: { models: [{ id: "glm-5" }] },
			},
		},
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
});

test("引导页点选优先于 enabledModels；无点选时 enabledModels 优先于 lastUsed（第 3 条）", () => {
	const settings = { enabledModels: ["ai88/deepseek-v4-flash-vision-exp"] };
	const models = {
		providers: {
			ai88: { models: [{ id: "deepseek-v4-flash-vision-exp" }] },
			openai: { models: [{ id: "gpt-5.2" }] },
		},
	};
	const lastUsedModel = { provider: "openai", modelId: "gpt-5.2" };
	// 点选胜出：旧规则下这里会返回 ai88，即「页面看似切了、发送后变回旧模型」的根因。
	const picked = resolve({
		settings,
		models,
		lastUsedModel,
		welcomeModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.deepEqual(plain(picked.model), { provider: "openai", modelId: "gpt-5.2" });
	// 无点选时 enabledModels 仍优先于 lastUsed（长期配置次序不变）。
	const noPick = resolve({ settings, models, lastUsedModel });
	assert.deepEqual(plain(noPick.model), { provider: "ai88", modelId: "deepseek-v4-flash-vision-exp" });
});

test("enabledModels 全部失效（已被删除）→ 回退欢迎偏好/lastUsed", () => {
	const result = resolve({
		settings: { enabledModels: ["deleted/*", "zhipu/nonexistent"] },
		models: {
			providers: {
				openai: { models: [{ id: "gpt-5.2" }] },
			},
		},
		lastUsedModel: { provider: "openai", modelId: "gpt-5.2" },
	});
	assert.deepEqual(plain(result.model), { provider: "openai", modelId: "gpt-5.2" });
});

test("enabledModels 脏形状（非数组/非字符串项）被忽略", () => {
	const models = { providers: { openai: { models: [{ id: "gpt-5.2" }] } } };
	for (const bad of [null, "ai88/x", [42], [{}, null], []]) {
		const result = resolve({ settings: { enabledModels: bad }, models });
		assert.equal(result.model, undefined);
	}
});
