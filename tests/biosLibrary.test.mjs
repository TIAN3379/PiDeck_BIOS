import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore, readRecord, readRegistry } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/index.ts";
import { createExperienceDraft, createFeature, reviewExperience } from "../packages/bios-agent/core/knowledge/index.ts";
import { BIOS_SETTINGS_DEFAULTS } from "../src/shared/types/bios.ts";
import { BiosLibraryService } from "../src/main/bios/BiosLibraryService.ts";
import { BiosStoreWriteGate } from "../src/main/bios/BiosStoreWriteGate.ts";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

async function fixture() {
	const sb = await createProjectSandbox("bios-local-library-");
	await initializeKnowledgeStore({ root: sb.root });
	const binding = await bindProjectWorkspace({ root: sb.root, cwd: sb.workspaceA, workspacePath: sb.workspaceA, authorizedRoots: [sb.workspaceA], displayName: "Synthetic board" });
	await createExperienceDraft({
		root: sb.root,
		authorizedProjectIds: [binding.projectId],
		experience: { experienceId: "exp-local", sourceProjectId: binding.projectId, problem: "S3 black screen", rootCause: "Synthetic root cause", solution: "Synthetic solution", appliesWhen: ["Synthetic platform"], doesNotApplyWhen: ["Different board"] },
	});
	await createFeature({ root: sb.root, feature: { featureId: "feature-local", originalRequirement: "Customer PXE policy", aliases: ["network boot"] } });
	const state = { settings: { ...BIOS_SETTINGS_DEFAULTS, knowledgeRoot: sb.root }, version: 0 };
	const gate = new BiosStoreWriteGate();
	const service = new BiosLibraryService({ readSettings: () => state.settings, readConfigurationVersion: () => state.version, writeGate: gate });
	return { ...sb, binding, state, service, gate };
}

test("human library lists retained knowledge without session, model consent or AI project grants", async () => {
	const f = await fixture();
	try {
		const before = JSON.stringify(f.state.settings);
		const page = await f.service.list({ kind: "experience-card" });
		assert.equal(page.entries[0].title, "S3 black screen");
		assert.equal(page.entries[0].source, "Synthetic board");
		assert.equal(page.entries[0].state, "draft");
		assert.equal(page.next, null);
		assert.equal((await f.service.detail({ kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey })).record.solution, "Synthetic solution");
		assert.equal((await f.service.list({ kind: "feature-record", query: "NETWORK" })).entries[0].id, "feature-local");
		assert.equal((await f.service.list({ kind: "experience-card", query: "no-match" })).entries.length, 0);
		assert.equal(JSON.stringify(f.state.settings), before, "local browsing must not grant AI access");
	} finally {
		await f.cleanup();
	}
});

test("local editing persists via CAS and keeps evidence/history/source identity", async () => {
	const f = await fixture();
	try {
		const page = await f.service.list({ kind: "experience-card" });
		const before = await f.service.detail({ kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey });
		const request = { kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey, expectedRevision: before.record.revision, changes: { solution: "Manually corrected solution" } };
		assert.equal((await f.service.update(request)).result.status, "updated");
		assert.equal((await f.service.update({ ...request, changes: { solution: "Stale overwrite" } })).result.status, "revision-conflict");
		const disk = JSON.parse(await readFile(join(f.root, "experiences", "exp-local.json"), "utf8"));
		assert.equal(disk.solution, "Manually corrected solution");
		assert.equal(disk.sourceProjectId, before.record.sourceProjectId);
		assert.equal(disk.createdAt, before.record.createdAt);
		assert.deepEqual(disk.evidence, before.record.evidence);
		assert.equal(disk.status, "draft");
		const feature = await f.service.detail({ kind: "feature-record", id: "feature-local", libraryKey: page.libraryKey });
		assert.equal((await f.service.update({ kind: "feature-record", id: "feature-local", libraryKey: page.libraryKey, expectedRevision: feature.record.revision, changes: { originalRequirement: "Corrected customer requirement" } })).result.status, "updated");
		assert.equal((await readRecord({ root: f.root, kind: "feature-record", id: "feature-local" })).record.originalRequirement, "Corrected customer requirement");
	} finally {
		await f.cleanup();
	}
});

test("reviewed knowledge cannot be overwritten: explicit audited return-to-draft is required", async () => {
	const f = await fixture();
	try {
		const page = await f.service.list({ kind: "experience-card" });
		const detail = await f.service.detail({ kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey });
		const reviewed = await reviewExperience({ root: f.root, experienceId: "exp-local", expectedRevision: detail.record.revision, action: "submit-review", operatorLabel: "Synthetic reviewer", reason: "Review fixture", authorizedProjectIds: [f.binding.projectId] });
		const request = { kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey, expectedRevision: reviewed.revision };
		assert.equal((await f.service.update({ ...request, changes: { solution: "Cannot overwrite" } })).result.status, "not-draft");
		await assert.rejects(() => f.service.review({ ...request, confirmed: false, action: "request-changes", reason: "Needs correction" }), /确认/);
		const result = await f.service.review({ ...request, confirmed: true, action: "request-changes", reason: "Needs correction" });
		assert.equal(result.result.stateAfter, "draft");
		assert.ok(result.result.audit);
		assert.equal((await f.service.update({ ...request, expectedRevision: result.result.revision, changes: { solution: "Corrected after review" } })).result.status, "updated");
	} finally {
		await f.cleanup();
	}
});

test("changed knowledge root/configuration rejects stale reads and edits; malformed records are not empty results", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.root, "experiences", "broken.json"), "{bad-json");
		const page = await f.service.list({ kind: "experience-card" });
		assert.equal(page.entries.length, 1);
		assert.equal(page.problems.length, 1);
		f.state.version += 1;
		await assert.rejects(() => f.service.detail({ kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey }), /配置已变化/);
		await assert.rejects(() => f.service.update({ kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey, expectedRevision: 0, changes: { solution: "Stale" } }), /配置已变化/);
		f.state.settings = { ...f.state.settings, knowledgeRoot: null };
		await assert.rejects(() => f.service.list({ kind: "experience-card" }), /尚未配置/);
	} finally {
		await f.cleanup();
	}
});

test("human library writer participates in the same offline-backup exclusion", async () => {
	const f = await fixture();
	try {
		const page = await f.service.list({ kind: "feature-record" });
		await f.gate.export(f.root, async () => {
			await assert.rejects(() => f.service.update({ kind: "feature-record", id: "feature-local", libraryKey: page.libraryKey, expectedRevision: page.entries[0].revision, changes: { originalRequirement: "Do not write during backup" } }), /备份/);
		});
	} finally {
		await f.cleanup();
	}
});

test("bounded library pages can advance beyond 40 without losing record IDs", async () => {
	const f = await fixture();
	try {
		for (let i = 0; i < 41; i++) await createFeature({ root: f.root, feature: { featureId: `page-${String(i).padStart(3, "0")}`, originalRequirement: `Synthetic feature ${i}` } });
		const first = await f.service.list({ kind: "feature-record" });
		assert.equal(first.entries.length, 40);
		assert.ok(first.next);
		const second = await f.service.list({ kind: "feature-record", after: first.next, libraryKey: first.libraryKey });
		assert.equal(second.entries.length, 2);
		assert.equal(new Set([...first.entries, ...second.entries].map((item) => item.id)).size, 42);
		assert.equal(second.next, null);
	} finally {
		await f.cleanup();
	}
});

test("library IPC rejects path/grant/managed-field injection, fake revision and approval bypass", async () => {
	const handlers = new Map();
	const { registerBiosLibraryIpc } = loadTsCommonJs("src/main/ipc/biosLibraryIpc.ts", { stubs: { electron: { ipcMain: { handle: (channel, fn) => handlers.set(channel, fn), removeHandler: (channel) => handlers.delete(channel) } } } });
	const f = await fixture();
	const off = registerBiosLibraryIpc(f.service);
	const call = (channel, payload) => Promise.resolve().then(() => handlers.get(channel)(null, payload));
	try {
		const page = await call("bios:library-list", { kind: "experience-card" });
		const request = { kind: "experience-card", id: "exp-local", libraryKey: page.libraryKey, expectedRevision: page.entries[0].revision };
		await assert.rejects(() => call("bios:library-list", { kind: "experience-card", root: "C:/elsewhere" }), /未知|托管/);
		await assert.rejects(() => call("bios:library-update", { ...request, changes: { status: "verified" } }), /未知|托管/);
		await assert.rejects(() => call("bios:library-update", { ...request, expectedRevision: -1, changes: { solution: "invalid" } }), /expectedRevision/);
		await assert.rejects(() => call("bios:library-detail", { ...request, id: "../outside" }), /未知|托管/);
		await assert.rejects(() => call("bios:library-detail", { kind: request.kind, libraryKey: request.libraryKey, id: "../outside" }), /不合法|非法|拒绝/);
		await assert.rejects(() => call("bios:library-review", { ...request, action: "approve", confirmed: true, reason: "Bypass" }), /确认/);
		assert.deepEqual(f.state.settings.authorizedProjectIds, []);
		assert.equal((await readRegistry({ root: f.root })).projects.length, 1);
	} finally {
		off();
		await f.cleanup();
	}
});
