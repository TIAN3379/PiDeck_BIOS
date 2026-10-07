import test from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createProjectSandbox, writeDsc } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore, readRegistry, updateRegistry } from "../packages/bios-agent/core/storage/index.ts";
import { BiosOnboardingService } from "../src/main/bios/BiosOnboardingService.ts";
import { BiosKnowledgeService } from "../src/main/bios/BiosKnowledgeService.ts";
import { BiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { BIOS_SETTINGS_DEFAULTS } from "../src/shared/types/bios.ts";

async function fixture(extra = {}) {
	const sb = await createProjectSandbox("bios-onboarding-");
	await initializeKnowledgeStore({ root: sb.root });
	await writeDsc(sb.workspaceA, "Sample.dsc", { platformName: "Sample" });
	await mkdir(sb.workspaceB, { recursive: true });
	const state = { settings: { ...BIOS_SETTINGS_DEFAULTS, knowledgeRoot: sb.root }, path: sb.workspaceA, saves: 0, failSave: false };
	const knowledge = new BiosKnowledgeService({ readSettings: () => state.settings });
	const business = new BiosBusinessService({ readSettings: () => state.settings, resolveDesktopProjectPath: () => state.path, readConfigurationVersion: () => knowledge.currentConfigurationVersion() });
	const service = new BiosOnboardingService({
		readSettings: () => state.settings,
		readConfigurationVersion: () => knowledge.currentConfigurationVersion(),
		resolveProject: (id) => (id === "desktop-sample" ? { name: "Sample Board", path: state.path } : null),
		saveAuthorization: async (patch) => {
			const outcome = await knowledge.updateSettings(patch);
			if (state.failSave) throw new Error("synthetic save failed");
			state.settings = outcome.settings;
			state.saves += 1;
			return outcome;
		},
		bindProject: (request) => business.bindProject(request),
		...extra,
	});
	return { ...sb, state, service };
}

test("legacy authorized path without desktop binding still proposes onboarding and reuses its knowledge ID", async () => {
	const f = await fixture();
	try {
		const initial = await f.service.prepare("desktop-sample");
		await f.service.complete({ token: initial.token, confirmed: true });
		const registry = await readRegistry({ root: f.root });
		await updateRegistry({ root: f.root, expectedRevision: registry.revision, projects: registry.projects.map(({ desktopProjectId, ...entry }) => entry) });
		const preview = await f.service.prepare("desktop-sample");
		assert.equal(preview.existing, true);
		assert.equal(preview.biosProjectId, initial.biosProjectId);
		assert.equal(preview.authorized, false, "path authorization must not hide the missing desktop binding confirmation");
		const result = await f.service.complete({ token: preview.token, confirmed: true });
		assert.equal(result.status, "completed");
		const repaired = await readRegistry({ root: f.root });
		assert.equal(repaired.projects.length, 1);
		assert.equal(repaired.projects[0].desktopProjectId, "desktop-sample");
		assert.equal(f.state.settings.endpoint, "unknown");
	} finally {
		await f.cleanup();
	}
});

test("project lifecycle: ordinary chat is rejected before preview or writes", async () => {
	const f = await fixture({ resolveProject: () => ({ name: "Chat", kind: "chat", path: "invalid" }) });
	try {
		await assert.rejects(() => f.service.prepare("builtin-chat"), /普通聊天/);
		await assert.rejects(() => f.service.prepare("custom-chat"), /普通聊天/);
		assert.equal(f.state.saves, 0);
	} finally {
		await f.cleanup();
	}
});

test("project lifecycle: explicit disconnect preserves history, revokes only target and permits reconnect", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		await f.service.complete({ token: preview.token, confirmed: true });
		const before = await readRegistry({ root: f.root });
		f.state.settings = { ...f.state.settings, authorizedProjectIds: [...f.state.settings.authorizedProjectIds, "unrelated-project"], authorizedRoots: [...f.state.settings.authorizedRoots, f.workspaceB] };
		const request = { projectId: preview.biosProjectId, expectedRevision: before.revision, configurationVersion: (await f.service.connections()).configurationVersion, confirmed: true };
		await assert.rejects(() => f.service.disconnect({ ...request, confirmed: false }), /确认/);
		await assert.rejects(() => f.service.disconnect({ ...request, expectedRevision: before.revision - 1 }), /变化/);
		await assert.rejects(() => f.service.disconnect({ ...request, configurationVersion: -1 }), /变化/);
		const result = await f.service.disconnect(request);
		assert.equal(result.status, "completed");
		assert.deepEqual(f.state.settings.authorizedProjectIds, ["unrelated-project"]);
		assert.deepEqual(f.state.settings.authorizedRoots, [f.workspaceB]);
		const after = await readRegistry({ root: f.root });
		assert.equal(after.projects.length, 1);
		assert.equal(after.projects[0].desktopProjectId, undefined);
		assert.deepEqual(after.projects[0].workspaces, before.projects[0].workspaces);
		const reconnect = await f.service.prepare("desktop-sample");
		assert.equal(reconnect.biosProjectId, preview.biosProjectId);
		assert.equal(reconnect.authorized, false);
		assert.equal((await f.service.complete({ token: reconnect.token, confirmed: true })).status, "completed");
	} finally {
		await f.cleanup();
	}
});

test("UX-03: 预览不写库，未确认不得授权；确认后仅授权真实目录和自动 ID", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		assert.match(preview.biosProjectId, /^[a-f0-9-]{36}$/);
		assert.equal(preview.displayName, "Sample Board");
		assert.equal((await readRegistry({ root: f.root })).projects.length, 0);
		assert.equal(f.state.saves, 0);
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: false }), /确认/);
		assert.equal(f.state.saves, 0);
		const outcome = await f.service.complete({ token: preview.token, confirmed: true, displayName: "Edited Board" });
		assert.equal(outcome.status, "completed");
		assert.deepEqual(f.state.settings.authorizedProjectIds, [preview.biosProjectId]);
		assert.deepEqual(f.state.settings.authorizedRoots, [preview.workspacePath]);
		assert.equal(f.state.settings.endpoint, "unknown");
		assert.deepEqual(f.state.settings.approvedCustomers, []);
		assert.deepEqual(f.state.settings.allowedFeatureIds, []);
		assert.equal((await readRegistry({ root: f.root })).projects[0].displayName, "Edited Board");
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true }), /预览/);
		const reopened = await f.service.prepare("desktop-sample");
		assert.equal(reopened.existing, true);
		assert.equal(reopened.biosProjectId, preview.biosProjectId);
		await assert.rejects(() => f.service.complete({ token: reopened.token, confirmed: true, displayName: "Not persisted rename" }), /重命名/);
		assert.equal((await f.service.complete({ token: reopened.token, confirmed: true })).binding.result.status, "already-bound");
		assert.equal((await readRegistry({ root: f.root })).projects.length, 1);
		const foreign = new BiosOnboardingService({
			readSettings: () => f.state.settings,
			readConfigurationVersion: () => 0,
			resolveProject: () => ({ name: "Duplicate desktop", path: f.state.path }),
			saveAuthorization: async () => {
				throw new Error("must not save");
			},
			bindProject: async () => {
				throw new Error("must not bind");
			},
		});
		await assert.rejects(() => foreign.prepare("other-desktop"), /冲突|迁移/);
		const connections = await f.service.connections();
		await f.service.disconnect({ projectId: preview.biosProjectId, expectedRevision: connections.revision, configurationVersion: connections.configurationVersion, confirmed: true });
		const recovered = await foreign.prepare("other-desktop");
		assert.equal(recovered.existing, true);
		assert.equal(recovered.biosProjectId, preview.biosProjectId, "explicit disconnect allows a new desktop identity to reuse retained knowledge");
	} finally {
		await f.cleanup();
	}
});

test("UX-03: oversized project names are rejected before authorization persistence", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true, displayName: "x".repeat(121) }), /120/);
		assert.equal(f.state.saves, 0);
	} finally {
		await f.cleanup();
	}
});

test("UX-03: concurrent previews cannot create duplicate projects", async () => {
	const f = await fixture();
	try {
		const a = await f.service.prepare("desktop-sample");
		const b = await f.service.prepare("desktop-sample");
		const results = await Promise.allSettled([f.service.complete({ token: a.token, confirmed: true }), f.service.complete({ token: b.token, confirmed: true })]);
		assert.equal(results.filter((entry) => entry.status === "fulfilled").length, 1);
		assert.equal(f.state.saves, 1);
		assert.equal((await readRegistry({ root: f.root })).projects.length, 1);
	} finally {
		await f.cleanup();
	}
});

test("UX-03: binding failure reports already-persisted authorization, without fictional rollback", async () => {
	const f = await fixture({
		bindProject: async () => {
			throw new Error("synthetic binding failure");
		},
	});
	try {
		const preview = await f.service.prepare("desktop-sample");
		const result = await f.service.complete({ token: preview.token, confirmed: true });
		assert.equal(result.status, "partial");
		assert.ok(result.authorization);
		assert.equal(result.binding, null);
		assert.match(result.problem, /binding failure/);
		assert.deepEqual(f.state.settings.authorizedProjectIds, [preview.biosProjectId]);
		assert.equal((await readRegistry({ root: f.root })).projects.length, 0);
	} finally {
		await f.cleanup();
	}
});

test("UX-03: expired token and unknown desktop cannot authorize", async () => {
	let now = 0;
	const f = await fixture({ now: () => now });
	try {
		await assert.rejects(() => f.service.prepare("missing-desktop"), /找不到/);
		const preview = await f.service.prepare("desktop-sample");
		now = preview.expiresAt;
		await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true }), /失效/);
		assert.equal(f.state.saves, 0);
	} finally {
		await f.cleanup();
	}
});

test("UX-03: 配置变化/真实目录变化让预览作废，不授权另一项目", async () => {
	for (const mode of ["config", "path"]) {
		const f = await fixture();
		try {
			const preview = await f.service.prepare("desktop-sample");
			if (mode === "config") f.state.settings = { ...f.state.settings, endpoint: "denied" };
			else f.state.path = f.workspaceB;
			await assert.rejects(() => f.service.complete({ token: preview.token, confirmed: true }), /变化|重新/);
			assert.equal(f.state.saves, 0);
			assert.equal((await readRegistry({ root: f.root })).projects.length, 0);
		} finally {
			await f.cleanup();
		}
	}
});

test("UX-03: 授权保存失败不绑定，不伪称完成", async () => {
	const f = await fixture();
	try {
		const preview = await f.service.prepare("desktop-sample");
		f.state.failSave = true;
		const result = await f.service.complete({ token: preview.token, confirmed: true });
		assert.equal(result.status, "partial");
		assert.equal(result.binding, null);
		assert.match(result.problem, /save failed/);
		assert.equal((await readRegistry({ root: f.root })).projects.length, 0);
	} finally {
		await f.cleanup();
	}
});
