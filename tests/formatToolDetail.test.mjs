import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { formatToolDetail, extractToolResultText, truncateDetailWithMeta, defaultToolDetailTranslate } = loadTsCommonJs("src/shared/formatToolDetail.ts");

function enTranslate(key, params = {}) {
	if (key === "mainTool.name") return `Tool: ${params.name}`;
	if (key === "mainTool.status") return `Status: ${params.status}`;
	if (key === "mainTool.failed") return "Failed";
	if (key === "mainTool.done") return "Completed";
	if (key === "mainTool.arguments") return `Arguments:\n${params.value}`;
	if (key === "mainTool.command") return `Command: ${params.command}`;
	if (key === "mainTool.result") return `Result:\n${params.value}`;
	if (key === "mainTool.details") return `Details:\n${params.value}`;
	if (key === "mainTool.truncated") return `[truncated ${params.omitted}/${params.total}]`;
	return key;
}

test("formatToolDetail 拼出工具/状态/参数/结果（中文兜底文案）", () => {
	const text = formatToolDetail("read", { path: "F:/PiDeck/src/a.ts", offset: 1, limit: 50 }, { content: [{ type: "text", text: 'import fs from "node:fs";' }] }, false, defaultToolDetailTranslate);
	assert.match(text, /^工具：read/);
	assert.match(text, /状态：完成/);
	assert.match(text, /参数：/);
	assert.match(text, /"path": "F:\/PiDeck\/src\/a\.ts"/);
	assert.match(text, /结果：/);
	assert.match(text, /import fs from "node:fs";/);
	assert.doesNotMatch(text, /详情：/);
});

test("formatToolDetail 接受 DSH 纯字符串结果，不二次 JSON 编码", () => {
	const text = formatToolDetail("read", { file_path: "a.ts" }, "hello world", false, enTranslate);
	assert.match(text, /Result:\nhello world/);
	assert.doesNotMatch(text, /"hello world"/);
});

test("formatToolDetail args 已是 JSON 字符串时不二次编码", () => {
	const text = formatToolDetail("read", '{"path":"a.ts"}', { content: [{ type: "text", text: "ok" }] }, false, enTranslate);
	assert.match(text, /"path": "a.ts"/);
	assert.doesNotMatch(text, /\\\\"path\\\\"/);
});

test("formatToolDetail 无结果时省略结果段，失败态用 Failed", () => {
	const text = formatToolDetail("bash", { command: "false" }, undefined, true, enTranslate);
	assert.match(text, /Status: Failed/);
	assert.doesNotMatch(text, /Result:/);
});

test("formatToolDetail bash uses the raw multiline command instead of JSON escaping", () => {
	const command = "python3 -c 'import json,sys\nprint(json.load(sys.stdin)[\"a\"])' </dev/null";
	const text = formatToolDetail("bash", { command }, undefined, true, enTranslate);
	assert.match(text, /Command: python3 -c 'import json,sys\nprint\(json\.load\(sys\.stdin\)\[\"a\"\]\)' <\/dev\/null/);
	assert.doesNotMatch(text, /Arguments:/);
	assert.doesNotMatch(text, /\\n/);
});

test("extractToolResultText 拼接 content[].text，忽略非 text 块", () => {
	assert.equal(extractToolResultText("plain"), "plain");
	assert.equal(
		extractToolResultText({
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "x" },
				{ type: "text", text: "b" },
			],
		}),
		"a\nb",
	);
	assert.equal(extractToolResultText({ content: "not-array" }), "");
});

test("truncateDetailWithMeta 超长时首尾截断并标记 truncated", () => {
	const short = truncateDetailWithMeta("abc", enTranslate, 10);
	assert.equal(short.truncated, false);
	assert.equal(short.text, "abc");

	const long = "x".repeat(20);
	const cut = truncateDetailWithMeta(long, enTranslate, 10);
	assert.equal(cut.truncated, true);
	assert.equal(cut.fullLength, 20);
	assert.match(cut.text, /\[truncated 10\/20\]/);
	assert.ok(cut.text.startsWith("xxxxx"));
	assert.ok(cut.text.endsWith("xxxxx"));
});
