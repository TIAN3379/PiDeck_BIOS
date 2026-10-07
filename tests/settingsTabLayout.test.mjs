import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// settingsTabLayout.ts 只含 type-only import（编译期擦除），无运行时依赖，可直接加载。
const { SETTINGS_TAB_LAYOUT, SETTINGS_TAB_IDS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");

test("布局覆盖全部 18 个 tab 且不重复", () => {
	// loadTsCommonJs 在 vm 里执行，数组原型属于另一 realm，先展开到测试侧再比较
	const ids = [...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)];
	// 18 = 原 17 个 + BM-07A C2 的 bios（专业能力独立成簇）
	assert.equal(ids.length, 18);
	assert.equal(new Set(ids).size, ids.length);
	// SETTINGS_TAB_IDS 由布局派生，两者必须一致（单一事实来源）
	assert.deepEqual([...SETTINGS_TAB_IDS], ids);
});

test("展示顺序按 基础 → 扩展集成 → 开发者工具 → 开发与维护 → 专业能力 排列", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.map((entry) => entry.id)], ["common", "shortcuts", "notification", "appearance", "proxy", "im", "pet", "vision", "imagegen", "web", "editors", "git", "dev", "usage", "process", "storage", "backup", "bios"]);
});

test("分割线只出现在四个簇边界前，首项不带分割线", () => {
	assert.deepEqual([...SETTINGS_TAB_LAYOUT.filter((e) => e.dividerBefore).map((e) => e.id)], ["im", "web", "dev", "bios"]);
	assert.equal(SETTINGS_TAB_LAYOUT[0].dividerBefore, undefined);
});

test("每个 tab 都有标题 key 与搜索别名（含新增的 bios）", () => {
	const { SETTINGS_TAB_LABEL_KEYS, SETTINGS_TAB_KEYWORDS } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsTabLayout.ts");
	for (const id of [...SETTINGS_TAB_IDS]) {
		assert.equal(typeof SETTINGS_TAB_LABEL_KEYS[id], "string", `${id} 必须有标题 key`);
		assert.ok(Array.isArray(SETTINGS_TAB_KEYWORDS[id]) && SETTINGS_TAB_KEYWORDS[id].length > 0, `${id} 必须有搜索别名`);
	}
	assert.equal(SETTINGS_TAB_LABEL_KEYS.bios, "settings.tabs.bios");
	assert.ok(SETTINGS_TAB_KEYWORDS.bios.includes("bios"));
});
