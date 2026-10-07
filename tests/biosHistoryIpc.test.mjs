import test from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
test("HX history IPC rejects malformed input and ignores forged path/policy/model fields", async () => {
	const handlers = new Map();
	const calls = [];
	const { registerBiosHistoryIpc } = loadTsCommonJs("src/main/ipc/biosHistoryIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (key, cb) => handlers.set(key, cb), removeHandler: (key) => handlers.delete(key) } },
			"../../shared/ipc": { ipcChannels: { biosScanHistory: "scan", biosHistoryEvidence: "evidence" } },
		},
	});
	const dispose = registerBiosHistoryIpc({ scan: async (request) => calls.push(request), evidence: async (...args) => calls.push(args) });
	const request = { desktopProjectId: "a", projectId: "b", ref: "HEAD", limit: 20, keyword: "" };
	for (const raw of [null, [], {}, { ...request, limit: "20" }, { ...request, ref: null }]) await assert.rejects(() => handlers.get("scan")({}, raw));
	await handlers.get("scan")({}, { ...request, cwd: "forged", endpoint: "allowed", authorizedRoots: ["all"] });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), request);
	await handlers.get("evidence")({}, { token: "t", sha: "s", diff: "forged", projectId: "forged" });
	assert.deepEqual(JSON.parse(JSON.stringify(calls[1])), ["t", "s"]);
	dispose();
	assert.equal(handlers.size, 0);
});
