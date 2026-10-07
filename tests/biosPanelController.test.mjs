/** Production commands, not manually assembled reducer sequences. All data is synthetic. */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createBiosPanelController } = loadTsCommonJs("src/renderer/src/components/app/settings/biosPanelController.ts");
const project = { projectId: "p", profileRevision: 1, identity: [], workspaces: [], needsReviewCount: 0, problems: [] };
const task = (taskId) => ({ projectId: "p", taskId, revision: 1, status: "planned", requirement: "synthetic", workspaceId: "w", updatedAt: 1, blockerCount: 0, todoCount: 0 });
const settings = { knowledgeRoot: null, authorizedProjectIds: [], allowedFeatureIds: [], approvedCustomers: [], authorizedRoots: [], endpoint: "unknown" };
const preview = (text) => ({
	status: "ok",
	text,
	maySendToModel: false,
	identityUsable: true,
	stable: true,
	outboundNote: "denied",
	budget: { maxChars: 100, maxBytes: 100, usedChars: 1, usedBytes: 1, truncated: false, clamped: false },
	retainedSources: [],
	inspectedSources: [],
	retainedSourceCount: 0,
	inspectedSourceCount: 0,
	sourcesTruncated: false,
	expiredSources: [],
	problems: ["synthetic gap"],
});
const ack = (synced = true) => ({ mode: "rpc", applied: synced, currentSessionSynced: synced, receipt: "synthetic ACK", reason: synced ? null : "refused" });
function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
function harness() {
	let scope = { key: "A|agent|1", claim: { sessionRef: { agentId: "a", sessionId: "A" }, runtimeGeneration: 1 } };
	let changed;
	let runtime = { configVersion: 1, pendingRestart: false, stoppedRuntimes: [], note: null };
	const calls = [];
	const api = {
		readiness: async () => ({ ready: true, reason: null }),
		getSettings: async () => settings,
		runtimeState: async () => runtime,
		onChanged: (fn) => {
			changed = fn;
			return () => {
				changed = null;
			};
		},
		listProjects: async () => ({ items: [project], gap: null }),
		listTasks: async (request) => {
			calls.push(request);
			return { items: [task("a"), task("b")], gap: null };
		},
		applySelection: async () => ack(),
		preview: async () => preview("synthetic preview"),
		pickKnowledgeRoot: async () => ({ canceled: false, path: "synthetic" }),
	};
	const controller = createBiosPanelController(
		api,
		() => scope,
		(key) => key,
	);
	const stop = controller.start();
	return {
		api,
		controller,
		calls,
		stop,
		change: (event) => changed?.(event),
		version: (v) => {
			runtime = { ...runtime, configVersion: v };
		},
		switch: (align = true) => {
			scope = { key: "B|agent|2", claim: { sessionRef: { agentId: "b", sessionId: "B" }, runtimeGeneration: 2 } };
			if (align) controller.alignScope();
		},
	};
}
async function selected(h) {
	await tick();
	await h.controller.refreshProjects();
	assert.equal(h.controller.getSnapshot().panel.projectId, null, "list refresh is not human confirmation");
	await h.controller.selectProject("p");
	h.controller.selectTask("a");
}

test("R37-1: real controller can enable, disable and preview consecutively", async () => {
	const h = harness();
	await selected(h);
	for (const enabled of [true, false]) {
		await h.controller.applySelection(enabled);
		assert.equal(h.controller.getSnapshot().panel.busy, null);
		assert.equal(h.controller.getSnapshot().panel.synced.contextEnabled, enabled);
	}
	await h.controller.buildPreview();
	assert.equal(h.controller.getSnapshot().panel.preview.text, "synthetic preview");
	assert.equal(h.controller.getSnapshot().panel.problem, "synthetic gap");
	h.stop();
});
test("R37-1: unsynced and thrown results release busy and allow retry", async () => {
	const h = harness();
	await selected(h);
	h.api.applySelection = async () => ack(false);
	await h.controller.applySelection(true);
	assert.equal(h.controller.getSnapshot().panel.busy, null);
	assert.equal(h.controller.getSnapshot().panel.synced, null);
	h.api.applySelection = async () => {
		throw new Error("timeout");
	};
	await h.controller.applySelection(true);
	assert.equal(h.controller.getSnapshot().panel.busy, null);
	assert.match(h.controller.getSnapshot().panel.problem, /timeout/);
	h.api.applySelection = async () => ack();
	await h.controller.applySelection(false);
	assert.equal(h.controller.getSnapshot().panel.receipt.synced, true);
	h.stop();
});
test("R37-2: late ACK cannot mark B synced or unlock B's active request", async () => {
	const h = harness();
	await selected(h);
	const old = deferred();
	h.api.applySelection = () => old.promise;
	const pending = h.controller.applySelection(true);
	h.switch();
	const fresh = deferred();
	h.api.listProjects = () => fresh.promise;
	const listing = h.controller.refreshProjects();
	old.resolve(ack());
	await pending;
	assert.equal(h.controller.getSnapshot().panel.receipt, null);
	assert.equal(h.controller.getSnapshot().panel.busy, "projects");
	fresh.resolve({ items: [project], gap: null });
	await listing;
	assert.equal(h.controller.getSnapshot().panel.busy, null);
	h.stop();
});
test("R37-2: rejected late project list must not select a project or start task IO", async () => {
	const h = harness();
	await selected(h);
	const old = deferred();
	h.api.listProjects = () => old.promise;
	const pending = h.controller.refreshProjects();
	const before = h.calls.length;
	h.switch();
	old.resolve({ items: [project], gap: null });
	await pending;
	assert.equal(h.calls.length, before);
	assert.equal(h.controller.getSnapshot().panel.projectId, null);
	assert.equal(h.controller.getSnapshot().panel.projects.length, 0);
	h.stop();
});
test("R37-2: switching tasks invalidates old preview and old selection ACK", async () => {
	const h = harness();
	await selected(h);
	const old = deferred();
	h.api.preview = () => old.promise;
	const pending = h.controller.buildPreview();
	h.controller.selectTask("b");
	old.resolve(preview("old task a"));
	await pending;
	assert.equal(h.controller.getSnapshot().panel.taskId, "b");
	assert.equal(h.controller.getSnapshot().panel.preview, null);
	const ackLater = deferred();
	h.api.applySelection = () => ackLater.promise;
	const selecting = h.controller.applySelection(true);
	h.controller.selectTask("a");
	ackLater.resolve(ack());
	await selecting;
	assert.equal(h.controller.getSnapshot().panel.synced, null);
	h.stop();
});
test("R37-2: changed notification clears old body immediately, before reload resolves", async () => {
	const h = harness();
	await selected(h);
	await h.controller.buildPreview();
	const blocked = deferred();
	h.api.getSettings = () => blocked.promise;
	h.change();
	assert.equal(h.controller.getSnapshot().panel.preview, null);
	assert.equal(h.controller.getSnapshot().panel.projects.length, 0);
	blocked.resolve(settings);
	await tick();
	h.stop();
});
test("R37-2: disposed controller ignores late ACK, error and settings reload", async () => {
	const h = harness();
	await selected(h);
	const old = deferred();
	h.api.applySelection = () => old.promise;
	const pending = h.controller.applySelection(true);
	h.stop();
	const before = h.controller.getSnapshot();
	old.resolve(ack());
	await pending;
	assert.equal(h.controller.getSnapshot(), before);
});
test("R37-2: a scope change seen before the hook effect still rejects old result", async () => {
	const h = harness();
	await selected(h);
	const old = deferred();
	h.api.preview = () => old.promise;
	const pending = h.controller.buildPreview();
	h.switch(false);
	old.resolve(preview("old"));
	await pending;
	assert.equal(h.controller.getSnapshot().panel.preview, null);
	h.stop();
});

test("GUI regression: own selection broadcast before IPC completion must preserve ACK and selection", async () => {
	const h = harness();
	await selected(h);
	h.api.applySelection = async (selection) => {
		h.change({ kind: "selection", selection });
		return ack();
	};
	for (const enabled of [true, false]) {
		await h.controller.applySelection(enabled);
		assert.equal(h.controller.getSnapshot().panel.taskId, "a");
		assert.equal(h.controller.getSnapshot().panel.synced?.contextEnabled, enabled);
		assert.equal(h.controller.getSnapshot().panel.busy, null);
	}
	await h.controller.buildPreview();
	h.change({ kind: "selection", selection: { sessionRef: { agentId: "b", sessionId: "B" }, runtimeGeneration: 1, projectId: "p", taskId: "b", workspaceId: null, contextEnabled: true } });
	assert.equal(h.controller.getSnapshot().panel.preview?.text, "synthetic preview");
	h.change({ kind: "selection", selection: { sessionRef: { agentId: "a", sessionId: "A" }, runtimeGeneration: 1, projectId: "p", taskId: "b", workspaceId: null, contextEnabled: true } });
	assert.equal(h.controller.getSnapshot().panel.preview, null);
	assert.equal(h.controller.getSnapshot().panel.synced, null);
	h.stop();
});

test("production BIOS IPC emits distinct selection/settings notifications before returning", async () => {
	const handlers = new Map();
	const { registerBiosIpc } = loadTsCommonJs("src/main/ipc/biosIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) }, dialog: {} },
			"../bios/BiosKnowledgeService": { normalizeBiosHostSettings: (value) => value },
		},
	});
	const h = harness();
	await selected(h);
	const events = [];
	const unregister = registerBiosIpc({
		biosService: {
			applySelection: async () => ack(),
			updateSettings: async () => ({ settings, droppedRoots: [], runtime: await h.api.runtimeState(), invalidated: [], pushedOff: [], stopped: [], stopFailed: [], stopFailureDetails: [] }),
		},
		readBiosSettings: () => settings,
		updateBiosSettings: async () => {},
		readBiosSelections: () => null,
		updateBiosSelections: async () => {},
		appLogger: { info() {} },
		onChanged: (event) => {
			events.push(event);
			h.change(event);
		},
	});
	h.api.applySelection = (request) => handlers.get("bios:apply-selection")(null, request);
	await h.controller.applySelection(true);
	assert.equal(events[0].kind, "selection");
	assert.equal(h.controller.getSnapshot().panel.synced?.taskId, "a");
	await handlers.get("bios:update-settings")(null, settings);
	assert.equal(events[1].kind, "settings");
	assert.equal(h.controller.getSnapshot().panel.synced, null);
	unregister();
	h.stop();
});
test("save: changed event emitted during update still yields latest failure receipt", async () => {
	const h = harness();
	await selected(h);
	h.api.updateSettings = async () => {
		h.version(2);
		h.change();
		return { settings, runtime: await h.api.runtimeState(), droppedRoots: [], invalidated: ["a@1"], pushedOff: [], stopped: [], stopFailed: ["a@1"] };
	};
	await h.controller.saveSettings(settings);
	await tick();
	assert.equal(h.controller.getSnapshot().panel.busy, null);
	assert.equal(h.controller.getSnapshot().panel.receipt?.synced, false);
	h.stop();
});
