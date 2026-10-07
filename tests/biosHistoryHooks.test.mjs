import test from "node:test";
import assert from "node:assert/strict";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";

function harness(api) {
	return biosHookHarness("src/renderer/src/hooks/useBiosHistory.ts", "useBiosHistory", { desktopProjectId: "desktop-a", projectId: "bios-a" }, api);
}
test("HX history hook invalidates late scan on project, authorization and session changes", async () => {
	for (const change of [(h) => h.setProps({ desktopProjectId: "desktop-b", projectId: "bios-b" }), (h) => h.changed(), (h) => h.setClaim({ sessionRef: { agentId: "other", sessionId: "other" }, runtimeGeneration: 2 })]) {
		const pending = deferred();
		let calls = 0;
		const h = harness({
			scanHistory: () => {
				calls++;
				return pending.promise;
			},
		});
		await h.flush();
		const run = h.current.scan("HEAD", 20, "");
		void h.current.scan("HEAD", 20, "");
		assert.equal(calls, 1);
		change(h);
		await h.flush();
		pending.resolve({ token: "old", commits: [] });
		await run;
		await h.flush();
		assert.equal(h.current.preview, null);
		assert.equal(h.current.busy, false);
		h.unmount();
	}
});
test("HX history hook exposes read errors and never applies stale diff or async side effects", async () => {
	const pending = deferred();
	const h = harness({ scanHistory: async () => ({ token: "scan", commits: [{ sha: "abc" }] }), historyEvidence: () => pending.promise });
	await h.flush();
	await h.current.scan("HEAD", 20, "");
	await h.flush();
	assert.equal(h.current.preview.token, "scan");
	const run = h.current.select("abc");
	h.changed();
	await h.flush();
	pending.resolve({ diff: "old-secret" });
	await run;
	await h.flush();
	assert.equal(h.current.evidence, null);
	await h.current.run(async () => {
		throw new Error("Git output budget");
	});
	await h.flush();
	assert.match(h.current.problem, /budget/);
	const delayed = deferred();
	let applied = false;
	const write = h.current.run(async (fresh) => {
		await delayed.promise;
		if (fresh()) applied = true;
	});
	h.unmount();
	delayed.resolve();
	await write;
	assert.equal(applied, false);
});
