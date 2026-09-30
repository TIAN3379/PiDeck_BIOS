import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { sessionRecordToSummary } = loadTsCommonJs("src/renderer/src/atoms/session-selectors.ts");

const baseRecord = {
	id: "session-1",
	projectId: "project-1",
	title: "BIOS Agent session",
	source: "pi",
	environment: "native",
	status: "active",
	createdAt: 1000,
	updatedAt: 2000,
	preview: "",
	messageCount: 0,
};

test("pi 会话无 filePath 仍不投影（文件会话必须有路径）", () => {
	const summary = sessionRecordToSummary({ ...baseRecord, filePath: undefined });
	assert.equal(summary, undefined);
});

test("有 filePath 的会话投影保持不变", () => {
	const summary = sessionRecordToSummary({
		...baseRecord,
		filePath: "C:\\work\\session.jsonl",
	});
	assert.ok(summary);
	assert.equal(summary.filePath, "C:\\work\\session.jsonl");
});
