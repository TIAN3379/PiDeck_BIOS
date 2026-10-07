import assert from "node:assert/strict";
import test from "node:test";
import { biosHookHarness, businessResult, deferred } from "./helpers/biosHookHarness.mjs";

const hooks = "src/renderer/src/hooks/";

test("WM 刷新接管详情代次时清掉旧 busy，迟到详情不得锁死高级按钮", async () => {
	const pending = deferred();
	const h = biosHookHarness(
		`${hooks}useBiosTasks.ts`,
		"useBiosTasks",
		{ projectId: "a" },
		{
			listTasks: async () => ({ items: [{ taskId: "one" }], gap: null }),
			readTaskDetail: () => pending.promise,
		},
	);
	await h.flush();
	const selecting = h.current.selectTask("one");
	assert.equal(h.current.busy, "detail");
	assert.equal(await h.current.refresh({ keepSelection: true }), true);
	assert.equal(h.current.busy, null);
	pending.resolve(businessResult({ status: "ok", task: { id: "one" } }));
	await selecting;
	assert.equal(h.current.busy, null);
	assert.equal(h.current.detail, null, "旧详情回执已被刷新淘汰");
	h.unmount();
});

test("knowledge save/review retains its receipt after its own detail refresh", async () => {
	const outcome = businessResult({ status: "updated", revision: 2 }, true);
	const review = businessResult({ status: "audit-pending", stateAfter: "reviewed", revision: 3 }, true);
	const h = biosHookHarness(
		`${hooks}useBiosKnowledge.ts`,
		"useBiosKnowledge",
		{ projectId: "a" },
		{
			updateFeature: async () => outcome,
			readFeatureDetail: async () => businessResult({ status: "ok", revision: 2, feature: { id: "f" } }),
			reviewExperience: async () => review,
			readExperienceDetail: async () => businessResult({ status: "ok", revision: 3, card: { id: "e" } }),
		},
	);
	await h.flush();
	assert.equal(await h.current.updateFeature("f", 1, { title: "new" }), outcome);
	assert.equal(h.current.featureOutcome, outcome.result);
	assert.equal(await h.current.reviewExperience("e", 2, "approve", "reason", "operator"), review);
	assert.equal(h.current.reviewOutcome, review.result);
	h.unmount();
});

test("knowledge delayed save does not reopen an old record after a new selection", async () => {
	const pending = deferred();
	const reads = [];
	const h = biosHookHarness(
		`${hooks}useBiosKnowledge.ts`,
		"useBiosKnowledge",
		{ projectId: "a" },
		{
			updateFeature: () => pending.promise,
			readFeatureDetail: async ({ featureId }) => {
				reads.push(featureId);
				return businessResult({ status: "ok", feature: { id: featureId } });
			},
		},
	);
	await h.flush();
	const saving = h.current.updateFeature("old", 1, {});
	await h.current.loadFeature("new");
	pending.resolve(businessResult({ status: "updated" }, true));
	assert.equal(await saving, null);
	assert.deepEqual(reads, ["new"]);
	assert.equal(h.current.featureId, "new");
	h.unmount();
});

test("task delayed save after settings invalidation cannot reload old detail", async () => {
	const pending = deferred();
	const reads = [];
	const h = biosHookHarness(
		`${hooks}useBiosTasks.ts`,
		"useBiosTasks",
		{ projectId: "a" },
		{
			listTasks: async () => ({ items: [], gap: null }),
			updateTask: () => pending.promise,
			readTaskDetail: async ({ taskId }) => {
				reads.push(taskId);
				return businessResult({ status: "ok", task: { id: taskId } });
			},
		},
	);
	await h.flush();
	const saving = h.current.updateTask("old", 1, {});
	h.changed();
	await h.flush();
	pending.resolve(businessResult({ status: "updated" }, true));
	assert.equal(await saving, null);
	assert.deepEqual(reads, []);
	assert.equal(h.current.detail, null);
	assert.equal(h.current.busy, null);
	h.unmount();
});

test("continuation discards preview on task switch and configuration notification", async () => {
	const h = biosHookHarness(`${hooks}useBiosContinuation.ts`, "useBiosContinuation", { projectId: "a", taskId: "one", profileRevision: 1 }, { preview: async () => ({ text: "one", stable: true }) });
	await h.flush();
	await h.current.buildPreview("one", "w");
	assert.equal(h.current.preview.text, "one");
	h.setProps({ projectId: "a", taskId: "two", profileRevision: 1 });
	await h.flush();
	assert.equal(h.current.preview, null);
	await h.current.buildPreview("two", "w");
	h.changed();
	await h.flush();
	assert.equal(h.current.preview, null);
	h.unmount();
});

test("sediment invalidates pending prefill when configuration changes", async () => {
	const pending = deferred();
	const h = biosHookHarness(`${hooks}useBiosSediment.ts`, "useBiosSediment", { projectId: "a", taskId: "one" }, { prepareDraft: () => pending.promise });
	await h.flush();
	h.changed();
	pending.resolve(businessResult({ prefill: { taskId: "one", requirement: "old authorization" }, problems: [] }));
	await h.flush();
	assert.equal(h.current.prefill, null);
	assert.equal(h.current.busy, null);
	h.unmount();
});

test("backup configuration change drops late completion and selected directories", async () => {
	const pending = deferred();
	const h = biosHookHarness(
		`${hooks}useBiosBackup.ts`,
		"useBiosBackup",
		{},
		{
			storeStatus: async () => ({ kind: "ready" }),
			pickBackupDir: async () => ({ canceled: false, path: "C:/synthetic" }),
			exportBackup: () => pending.promise,
		},
	);
	await h.flush();
	await h.current.pickDir("export-parent", "bios.workbench.backup.pickExportParent");
	const exporting = h.current.exportBackup("test", true);
	h.changed();
	pending.resolve(businessResult({ status: "exported", published: true }, true));
	assert.equal(await exporting, null);
	assert.equal(h.current.exportOutcome, null);
	assert.equal(h.current.exportParentDir, null);
	assert.equal(h.current.busy, null);
	h.unmount();
});

test("task own selection notification preserves detail and the subsequent ACK", async () => {
	let h;
	const receipt = { accepted: true, receipt: "ack" };
	h = biosHookHarness(
		`${hooks}useBiosTasks.ts`,
		"useBiosTasks",
		{ projectId: "a" },
		{
			listTasks: async () => ({ items: [], gap: null }),
			readTaskDetail: async () => businessResult({ status: "ok", task: { id: "one", workspace: { workspaceId: "w" } } }),
			applySelection: async (selection) => {
				h.changed({ kind: "selection", selection });
				return receipt;
			},
		},
	);
	await h.flush();
	await h.current.selectTask("one");
	assert.equal(await h.current.applyContext(true), receipt);
	assert.equal(h.current.selection, receipt);
	assert.equal(h.current.detail.task.id, "one");
	h.unmount();
});

test("continuation manifest keeps the task/workspace identity from its preview", async () => {
	let saved;
	const h = biosHookHarness(
		`${hooks}useBiosContinuation.ts`,
		"useBiosContinuation",
		{ projectId: "a", taskId: "one", profileRevision: 1 },
		{
			preview: async () => ({ text: "one", stable: true, retainedSources: [], expiredSources: [], budget: { maxChars: 200, maxBytes: 400, usedChars: 3, truncated: false } }),
			saveManifest: async (request) => {
				saved = request;
				return businessResult({ status: "saved" }, true);
			},
		},
	);
	await h.flush();
	await h.current.buildPreview("one", "w");
	await h.current.saveManifest("manifest-one", null);
	assert.equal(saved.taskId, "one");
	assert.equal(saved.workspaceId, "w");
	h.unmount();
});

test("project confirmation cannot reopen an old project after a new selection", async () => {
	const pending = deferred();
	const reads = [];
	const h = biosHookHarness(
		`${hooks}useBiosWorkbench.ts`,
		"useBiosWorkbench",
		{ desktopProjectId: "desktop-a" },
		{
			getSettings: async () => ({}),
			readiness: async () => ({}),
			runtimeState: async () => ({}),
			storeStatus: async () => ({ kind: "ready" }),
			listProjects: async () => ({ items: [], gap: null }),
			confirmProfile: () => pending.promise,
			readProjectView: async ({ biosProjectId }) => {
				reads.push(biosProjectId);
				return businessResult({ projectId: biosProjectId });
			},
		},
	);
	await h.flush();
	const confirming = h.current.confirmFields("old", 1, []);
	await h.current.selectProject("new");
	pending.resolve(businessResult({ status: "confirmed" }, true));
	assert.equal(await confirming, null);
	assert.deepEqual(reads, ["new"]);
	assert.equal(h.current.selectedProjectId, "new");
	h.unmount();
});

test("CAS conflicts preserve task/feature detail and do not remount the user's draft", async () => {
	let taskReads = 0;
	const taskDetail = { status: "ok", revision: 1, task: { id: "one" } };
	const task = biosHookHarness(
		`${hooks}useBiosTasks.ts`,
		"useBiosTasks",
		{ projectId: "a" },
		{
			listTasks: async () => ({ items: [], gap: null }),
			readTaskDetail: async () => {
				++taskReads;
				return businessResult(taskDetail);
			},
			updateTask: async () => businessResult({ status: "revision-conflict", actualRevision: 2 }),
		},
	);
	await task.flush();
	await task.current.selectTask("one");
	await task.current.updateTask("one", 1, { requirement: "unsaved local draft" });
	assert.equal(taskReads, 1);
	assert.equal(task.current.detail, taskDetail);
	task.unmount();
	let featureReads = 0;
	const featureDetail = { status: "ok", revision: 1, feature: { id: "f" } };
	const knowledge = biosHookHarness(
		`${hooks}useBiosKnowledge.ts`,
		"useBiosKnowledge",
		{ projectId: "a" },
		{
			readFeatureDetail: async () => {
				++featureReads;
				return businessResult(featureDetail);
			},
			updateFeature: async () => businessResult({ status: "revision-conflict", actualRevision: 2 }),
		},
	);
	await knowledge.flush();
	await knowledge.current.loadFeature("f");
	await knowledge.current.updateFeature("f", 1, { originalRequirement: "unsaved feature draft" });
	assert.equal(featureReads, 1);
	assert.equal(knowledge.current.featureDetail, featureDetail);
	knowledge.unmount();
});
