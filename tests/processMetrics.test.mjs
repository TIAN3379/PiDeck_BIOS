import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePrivateMemoryBytes, parsePsRssKb, parseTasklistMemoryKb } from "../src/main/process/pidMemoryParsers.ts";
import { formatBytes, formatMb } from "../src/shared/formatBytes.ts";

test("process memory parsers accept valid platform output and reject malformed values", () => {
	assert.equal(parseTasklistMemoryKb('"node.exe","12345","Console","1","32,456 K"'), 32456);
	assert.equal(parseTasklistMemoryKb("bad"), null);
	assert.equal(parsePsRssKb(" 123456\n"), 123456);
	assert.equal(parsePsRssKb("abc"), null);
	assert.equal(parsePrivateMemoryBytes("\uFEFF 123,456 \r\n"), 123456);
	assert.equal(parsePrivateMemoryBytes("-5"), null);
});

test("process memory formatters use stable human-readable units", () => {
	assert.equal(formatBytes(1024), "1.0 KB");
	assert.equal(formatMb(1048576), "1.0 MB");
	assert.equal(formatMb(Number.NaN), "-");
});

test("Pi process monitor uses bounded array-form platform commands", () => {
	const source = readFileSync("src/main/process/ProcessMonitor.ts", "utf8");
	assert.match(source, /spawn\(args\[0\], args\.slice\(1\)/);
	assert.match(source, /PrivateMemorySize64/);
	assert.match(source, /\["ps", "-o", "rss=", "-p", String\(pid\)\]/);
	assert.match(source, /timeout: timeoutMs/);
});

test("process monitor IPC and preload expose Pi agent snapshots", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	assert.match(ipc, /processMetrics: "system:process-metrics"/);
	assert.match(systemIpc, /ipcMain\.handle\(ipcChannels\.processMetrics/);
	assert.match(systemIpc, /getProcessSnapshot\(agents\)/);
	assert.match(preload, /getProcessMetrics: \(\) =>/);
});
