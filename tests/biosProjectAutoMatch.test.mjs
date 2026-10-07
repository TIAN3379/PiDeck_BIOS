import assert from "node:assert/strict";
import test from "node:test";
import { biosHookHarness, deferred } from "./helpers/biosHookHarness.mjs";

function setup(projects, props = { desktopProjectId: "desktop-a" }) {
	return biosHookHarness("src/renderer/src/hooks/useBiosWorkbench.ts", "useBiosWorkbench", props, {
		getSettings: async () => ({}),
		readiness: async () => ({ ready: true }),
		runtimeState: async () => ({}),
		storeStatus: async () => ({ kind: "ready" }),
		listProjects: async () => ({ items: projects, gap: null }),
	});
}

test("HX-01 matches only the current desktop project's unique authorized BIOS entry", async () => {
	const h = setup([
		{ projectId: "bios-other", desktopProjectId: "other" },
		{ projectId: "bios-a", desktopProjectId: "desktop-a" },
	]);
	await h.flush();
	assert.equal(h.current.selectedProjectId, "bios-a");
	h.setProps({ desktopProjectId: "other" });
	await h.flush();
	assert.equal(h.current.selectedProjectId, "bios-other");
	h.unmount();
});
test("HX-01 never selects the first entry or ambiguous mappings", async () => {
	for (const projects of [
		[{ projectId: "one" }],
		[
			{ projectId: "one", desktopProjectId: "desktop-a" },
			{ projectId: "two", desktopProjectId: "desktop-a" },
		],
	]) {
		const h = setup(projects);
		await h.flush();
		assert.equal(h.current.selectedProjectId, null);
		h.unmount();
	}
});
test("HX-01 delayed project list cannot restore a previous desktop project's selection", async () => {
	const pending = deferred();
	let calls = 0;
	const h = biosHookHarness(
		"src/renderer/src/hooks/useBiosWorkbench.ts",
		"useBiosWorkbench",
		{ desktopProjectId: "desktop-a" },
		{
			getSettings: async () => ({}),
			readiness: async () => ({}),
			runtimeState: async () => ({}),
			storeStatus: async () => ({}),
			listProjects: () => (++calls === 1 ? pending.promise : Promise.resolve({ items: [{ projectId: "b", desktopProjectId: "desktop-b" }], gap: null })),
		},
	);
	await h.flush();
	h.setProps({ desktopProjectId: "desktop-b" });
	await h.flush();
	pending.resolve({ items: [{ projectId: "a", desktopProjectId: "desktop-a" }], gap: null });
	await h.flush();
	assert.equal(h.current.selectedProjectId, "b");
	h.unmount();
});
