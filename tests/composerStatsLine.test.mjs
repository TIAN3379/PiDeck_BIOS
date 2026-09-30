import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

function compile(filePath, stubs = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
			jsx: ts.JsxEmit.ReactJSX,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: (specifier) => stubs[specifier] ?? {},
			console,
		},
		{ filename: filePath },
	);
	return module.exports;
}

function loadStats() {
	return compile("src/renderer/src/components/session/ComposerStatsLine.tsx", {
		react: { Fragment: "Fragment", memo: (fn) => fn, useLayoutEffect: () => undefined, useRef: () => ({ current: null }), useState: (v) => [v, () => undefined] },
		"../../i18n": {
			t: (key, params = {}) => {
				const table = {
					"composerStats.turns": "{turns} 轮",
					"composerStats.tps": "{throughput} tok/s",
					"composerStats.cacheHit": "缓存命中 {percent}%",
					"composerStats.tokens": "输入 {input} tok · 输出 {output} tok",
					"composerStats.ttft": "首 token {duration}",
					"composerStats.reply": "回复 {duration}",
				};
				return (table[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ""));
			},
		},
		"./TimelineFormat": { formatDuration: (ms) => `${ms}ms` },
		"./SessionContextMeter": { formatTokens: (n) => String(n) },
	});
}

test("turn count and last-reply metrics fill counts, durations, speeds, then tokens", () => {
	const { buildComposerStatsGroups } = loadStats();
	const groups = buildComposerStatsGroups(
		{
			ttftMs: 2500,
			totalMs: 800,
			tps: 42.4,
			inputTokens: 1200,
			outputTokens: 340,
			cacheHitPercent: 88.2,
		},
		3,
	);
	assert.equal(groups[0], "3 轮");
	assert.equal(groups[1], "首 token 2500ms · 回复 800ms · 42 tok/s");
	assert.equal(groups[2], "缓存命中 88%");
	assert.equal(groups[3], "输入 1200 tok · 输出 340 tok");
});

test("turns-only when there is no last-reply metric", () => {
	const { buildComposerStatsGroups } = loadStats();
	const groups = buildComposerStatsGroups({}, 1);
	assert.equal(groups.length, 1);
	assert.equal(groups[0], "1 轮");
});

test("pi last-reply metrics fill the strip", () => {
	const { buildComposerStatsGroups } = loadStats();
	const groups = buildComposerStatsGroups({
		ttftMs: 210,
		totalMs: 4300,
		tps: 31,
		inputTokens: 800,
		outputTokens: 90,
	});
	assert.equal(groups[0], "首 token 210ms · 回复 4300ms · 31 tok/s");
	assert.equal(groups[1], "输入 800 tok · 输出 90 tok");
});

test("empty runtime produces no stats groups", () => {
	const { buildComposerStatsGroups } = loadStats();
	assert.equal(buildComposerStatsGroups(undefined).length, 0);
	assert.equal(buildComposerStatsGroups({}).length, 0);
	assert.equal(buildComposerStatsGroups({ inputTokens: 0, outputTokens: 0 }).length, 0);
});

test("composer area mounts the stats strip under the input card", () => {
	const area = readFileSync("src/renderer/src/components/session/ComposerArea.tsx", "utf8");
	const stats = readFileSync("src/renderer/src/components/session/ComposerStatsLine.tsx", "utf8");
	assert.match(area, /import \{ ComposerStatsLine \} from "\.\/ComposerStatsLine"/);
	assert.match(area, /statsLine=\{\s*<ComposerStatsLine state=\{composer\.runtime\?\.state\}(?: turnCount=\{props\.turnCount\})? \/>/);
	assert.match(area, /\{props\.statsLine\}/);
	// footer 固定保留 8px 底部留白；ComposerMeasuredExtras 会把它计入总高度，
	// StatsLine 自身仍只在有数字时渲染。
	assert.match(area, /className="composer[^\"]*px-0 pb-2"/);
	assert.match(stats, /if \(groups\.length === 0\) return null/);
	assert.match(stats, /truncate px-1 pb-0 pt-1/);
});

test("stats copy exists in both locales", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	for (const key of ["composerStats.turns", "composerStats.tps", "composerStats.cacheHit", "composerStats.tokens", "composerStats.ttft", "composerStats.reply"]) {
		assert.match(zh, new RegExp(`"${key.replace(".", "\\.")}"`));
		assert.match(en, new RegExp(`"${key.replace(".", "\\.")}"`));
	}
});
