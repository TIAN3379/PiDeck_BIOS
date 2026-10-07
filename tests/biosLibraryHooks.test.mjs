import assert from "node:assert/strict";
import test from "node:test";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";

const file = "src/renderer/src/hooks/useBiosLibrary.ts";
const page = (key) => ({ libraryKey: key, root: `/${key}`, entries: [], next: null, problems: [], scanIncomplete: false });

test("local library browsing does not require an active AI session", async () => {
	const h = biosHookHarness(file, "useBiosLibrary", {}, { libraryList: async () => page("local") });
	h.setClaim(null);
	await h.current.list("experience-card");
	await h.flush();
	assert.equal(h.current.page.libraryKey, "local");
	h.unmount();
});

test("switching library/configuration discards late list and detail responses", async () => {
	const pending = deferred();
	const detail = deferred();
	let request = 0;
	const h = biosHookHarness(file, "useBiosLibrary", {}, { libraryList: () => (++request === 1 ? pending.promise : Promise.resolve(page("new"))), libraryDetail: () => detail.promise });
	const old = h.current.list("experience-card");
	h.changed({ kind: "settings" });
	await h.current.list("feature-record");
	await h.flush();
	pending.resolve(page("old"));
	await old;
	assert.equal(h.current.page.libraryKey, "new");
	const opening = h.current.open("feature-record", "one");
	h.changed({ kind: "settings" });
	detail.resolve({ kind: "feature-record", record: { id: "one" } });
	await opening;
	assert.equal(h.current.detail, null);
	assert.equal(h.current.page, null);
	h.unmount();
});

test("CAS failure keeps the old baseline; save receipts do not invent success", async () => {
	const result = { status: "revision-conflict", problems: ["Conflict"], warnings: [], needsReview: [] };
	const h = biosHookHarness(file, "useBiosLibrary", {}, { libraryList: async () => page("local"), libraryDetail: async () => ({ kind: "feature-record", record: { id: "one", revision: 2 } }), libraryUpdate: async () => ({ stable: true, result }) });
	await h.current.list("feature-record");
	await h.flush();
	await h.current.open("feature-record", "one");
	await h.flush();
	await h.current.write({ kind: "feature-record", id: "one", libraryKey: "local", expectedRevision: 2, changes: { originalRequirement: "edited" } });
	await h.flush();
	assert.equal(h.current.detail.record.revision, 2);
	assert.equal(h.current.receipt.result.status, "revision-conflict");
	h.unmount();
});

test("successful edit reloads detail with only the read contract and shows the persisted revision", async () => {
	const h = biosHookHarness(
		file,
		"useBiosLibrary",
		{},
		{
			libraryList: async () => page("local"),
			libraryUpdate: async () => ({ stable: true, result: { status: "updated", warnings: [], needsReview: [] } }),
			libraryDetail: async (request) => {
				assert.deepEqual(Object.keys(request).sort(), ["id", "kind", "libraryKey"]);
				return { kind: "feature-record", record: { id: "one", revision: 3, originalRequirement: "edited", customer: { status: "unknown" } } };
			},
		},
	);
	await h.current.list("feature-record");
	await h.flush();
	await h.current.write({ kind: "feature-record", id: "one", libraryKey: "local", expectedRevision: 2, changes: { originalRequirement: "edited" } });
	await h.flush();
	assert.equal(h.current.problem, null);
	assert.equal(h.current.receipt.result.status, "updated");
	assert.equal(h.current.detail.record.revision, 3);
	h.unmount();
});
