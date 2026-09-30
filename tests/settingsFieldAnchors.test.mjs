import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const require = createRequire(import.meta.url);

function transpile(filePath) {
	return ts.transpileModule(readFileSync(filePath, "utf8"), {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
}

/**
 * 加载设置项锚点清单。
 * 该模块只有 `import type`，转译后不留 require，因此可以在裸沙箱里跑。
 */
function loadAnchors() {
	const sandbox = { exports: {}, require };
	vm.runInNewContext(transpile("src/renderer/src/utils/settingsFieldAnchors.ts"), sandbox, {
		filename: "utils/settingsFieldAnchors.ts",
	});
	return sandbox.exports.SETTINGS_FIELD_ANCHORS;
}

const SETTINGS_DIR = "src/renderer/src/components/app/settings";

/**
 * 设置页全部源码。
 * 不按 tab 精确映射文件：锚点可能落在 tab 主文件、也可能落在被它引用的子组件，
 * 逐个维护映射只会引入与代码结构无关的脆弱耦合。
 * 这里只确认「锚点确实写在了设置页的某个文件里」。
 */
function settingsSources() {
	const files = readdirSync(SETTINGS_DIR)
		.filter((name) => name.endsWith(".tsx"))
		.map((name) => path.join(SETTINGS_DIR, name));
	files.push("src/renderer/src/components/app/SettingsModal.tsx");
	return files.map((file) => ({ file, text: readFileSync(file, "utf8") }));
}

test("锚点 slug 唯一", () => {
	const anchors = loadAnchors();
	const slugs = anchors.map((anchor) => anchor.slug);
	assert.equal(new Set(slugs).size, slugs.length, "slug 重复会让命令面板两条目的 id 相同");
});

/**
 * 本轮最重要的一条：索引里写了、源码里没写锚点 → 用户搜到后点进去
 * `getElementById` 返回 null，**页面毫无反应且不报错**，是最难自查的失效模式。
 */
test("每个锚点在设置页源码里真实渲染（防「搜到却跳不动」）", () => {
	const anchors = loadAnchors();
	const sources = settingsSources();
	const missing = [];
	for (const anchor of anchors) {
		const fullId = `settings-section-${anchor.slug}`;
		const hit = sources.some(
			({ text }) =>
				// SettingRow / SettingSwitchRow / SettingTextarea 的 anchor prop
				text.includes(`anchor="${anchor.slug}"`) ||
				// SettingsSection 直接写完整 id
				text.includes(`"${fullId}"`),
		);
		if (!hit) missing.push(`settings-section-${anchor.slug} (${anchor.tab})`);
	}
	assert.deepEqual(missing, [], `以下锚点在设置页源码里找不到，命令面板点进去会静默无反应：\n  ${missing.join("\n  ")}`);
});

test("每条锚点都带标题 key 与搜索别名", () => {
	const anchors = loadAnchors();
	assert.ok(anchors.length > 0, "锚点清单不应为空");
	for (const anchor of anchors) {
		assert.ok(anchor.labelKey.startsWith("settings."), `labelKey 应指向设置页文案: ${anchor.slug} → ${anchor.labelKey}`);
		assert.ok(Array.isArray(anchor.keywords) && anchor.keywords.length > 0, `缺少搜索别名会让「中文标题搜不到」的场景失效: ${anchor.slug}`);
	}
});

test("锚点标题的 i18n key 在中英两份文案里都存在", () => {
	const anchors = loadAnchors();
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const missing = [];
	for (const anchor of anchors) {
		const marker = `"${anchor.labelKey}":`;
		if (!zh.includes(marker)) missing.push(`zh-CN 缺 ${anchor.labelKey} (${anchor.slug})`);
		if (!en.includes(marker)) missing.push(`en-US 缺 ${anchor.labelKey} (${anchor.slug})`);
	}
	assert.deepEqual(missing, [], `\n  ${missing.join("\n  ")}`);
});
