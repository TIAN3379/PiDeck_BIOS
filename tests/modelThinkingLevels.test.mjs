import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// shared/modelThinkingLevels：pi settings.json 的「每模型默认思考档位」读写工具。
// 三个消费方（主进程默认解析 / 配置页模型表 / 引导页展示）共用这一份纯逻辑，
// 这里锁住键格式、脏形状降级与不可变写回语义，防止任一路径自行漂移。
const { MODEL_THINKING_LEVELS, modelThinkingLevelsKey, orderModelThinkingLevels, parseModelThinkingLevels, modelThinkingLevelOf, modelThinkingLevelOfMap, withModelThinkingLevelDefault } = loadTsCommonJs("src/shared/modelThinkingLevels.ts");

// vm 独立 realm 里创建的对象/数组原型不同，deepEqual 会误报；JSON 往返归一到宿主 realm。
const plain = (value) => JSON.parse(JSON.stringify(value));

// ── 键格式：与 pi settings-manager 完全一致（provider/modelId） ──

test("modelThinkingLevelsKey 用 provider/modelId 拼接，不做转义", () => {
	assert.equal(modelThinkingLevelsKey("openai", "gpt-5.2"), "openai/gpt-5.2");
	// 模型 id 本身含斜杠（中转站常见别名）时也必须原样拼接，否则查不到 pi 写的键。
	assert.equal(modelThinkingLevelsKey("router9", "qd/qfmodel"), "router9/qd/qfmodel");
});

// ── 解析：脏形状逐级降级 ──

test("parseModelThinkingLevels 只保留非空字符串值并裁剪两端空白", () => {
	const parsed = parseModelThinkingLevels({
		modelThinkingLevels: {
			"openai/gpt-5.2": "high",
			"zhipu/glm-5": "  max  ",
			// 以下都不算有效档位：非字符串 / 空串 / 纯空白 / 数组
			"a/1": 3,
			"a/2": "",
			"a/3": "   ",
			"a/4": ["high"],
		},
	});
	assert.deepEqual(plain(parsed), { "openai/gpt-5.2": "high", "zhipu/glm-5": "max" });
});

test("parseModelThinkingLevels 对缺失/空表/非对象返回 undefined（调用方回退全局默认）", () => {
	for (const settings of [null, undefined, 42, "high", [], {}, { modelThinkingLevels: null }, { modelThinkingLevels: [] }, { modelThinkingLevels: {} }, { modelThinkingLevels: { "a/b": "" } }]) {
		assert.equal(parseModelThinkingLevels(settings), undefined);
	}
});

test("modelThinkingLevelOf / modelThinkingLevelOfMap 按 provider+modelId 取，缺项与脏值返回 undefined", () => {
	const settings = { modelThinkingLevels: { "openai/gpt-5.2": " xhigh " } };
	assert.equal(modelThinkingLevelOf(settings, "openai", "gpt-5.2"), "xhigh");
	assert.equal(modelThinkingLevelOf(settings, "openai", "gpt-4"), undefined);
	assert.equal(modelThinkingLevelOf(settings, "zhipu", "gpt-5.2"), undefined);
	// provider/modelId 缺失（旧数据半结构）不猜键。
	assert.equal(modelThinkingLevelOf(settings, undefined, "gpt-5.2"), undefined);
	assert.equal(modelThinkingLevelOf(settings, "openai", undefined), undefined);
	assert.equal(modelThinkingLevelOf(settings, "openai", ""), undefined);
	// 映射表本身脏形状时按「无表」处理。
	assert.equal(modelThinkingLevelOfMap(null, "openai", "gpt-5.2"), undefined);
	assert.equal(modelThinkingLevelOfMap({ "openai/gpt-5.2": 7 }, "openai", "gpt-5.2"), undefined);
});

// ── 写回：不可变更新，空值 = 删键 ──

test("withModelThinkingLevelDefault 写入新键并保留 settings 其它字段与表内其它键", () => {
	const settings = { defaultThinkingLevel: "low", modelThinkingLevels: { "zhipu/glm-5": "high" }, defaultProvider: "openai" };
	const next = withModelThinkingLevelDefault(settings, "openai", "gpt-5.2", "xhigh");
	assert.deepEqual(plain(next), {
		defaultThinkingLevel: "low",
		defaultProvider: "openai",
		modelThinkingLevels: { "zhipu/glm-5": "high", "openai/gpt-5.2": "xhigh" },
	});
	// 不可变：原对象不被改动（React setState 依赖这一点）。
	assert.deepEqual(plain(settings.modelThinkingLevels), { "zhipu/glm-5": "high" });
});

test("withModelThinkingLevelDefault 空值/空白 = 删键；表清空时连子表一起删", () => {
	const one = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high" } }, "openai", "gpt-5.2", "");
	assert.equal("modelThinkingLevels" in one, false);
	assert.deepEqual(plain(one), {});

	const blank = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high" } }, "openai", "gpt-5.2", "   ");
	assert.equal("modelThinkingLevels" in blank, false);

	const kept = withModelThinkingLevelDefault({ modelThinkingLevels: { "openai/gpt-5.2": "high", "zhipu/glm-5": "max" } }, "openai", "gpt-5.2", "");
	assert.deepEqual(plain(kept.modelThinkingLevels), { "zhipu/glm-5": "max" });
});

// ── 展示顺序：规范档位顺序，未知档位追加在后 ──

test("orderModelThinkingLevels 按 pi 规范档位排序，未知档位原序追加", () => {
	assert.deepEqual(plain(orderModelThinkingLevels(["high", "off", "medium"])), ["off", "medium", "high"]);
	assert.deepEqual(plain(orderModelThinkingLevels(MODEL_THINKING_LEVELS)), [...MODEL_THINKING_LEVELS]);
	// 未来 pi 新增档位：不丢项，按原序排在后面。
	assert.deepEqual(plain(orderModelThinkingLevels(["ultra", "low"])), ["low", "ultra"]);
	assert.deepEqual(plain(orderModelThinkingLevels([])), []);
});
