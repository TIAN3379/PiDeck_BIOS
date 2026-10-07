import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore } from "../packages/bios-agent/core/storage/index.ts";
import { randomUUID } from "node:crypto";
import { BiosBusinessService } from "../src/main/bios/BiosBusinessService.ts";
import { BiosHistoryService, validateHistoryRequest, runHistoryGit } from "../src/main/bios/BiosHistoryService.ts";
import { BIOS_SETTINGS_DEFAULTS } from "../src/shared/types/bios.ts";

async function fixture() {
	const f = await createProjectSandbox("bios-history-");
	await initializeKnowledgeStore({ root: f.root });
	await mkdir(f.workspaceA, { recursive: true });
	const git = (...args) => execFileSync("git", args, { cwd: f.workspaceA, encoding: "utf8", windowsHide: true });
	git("init");
	git("config", "user.name", "Synthetic");
	git("config", "user.email", "synthetic@example.invalid");
	await writeFile(join(f.workspaceA, "Board.c"), "initial\n");
	git("add", ".");
	git("commit", "-m", "Initial CRB");
	await writeFile(join(f.workspaceA, "Board.c"), "fixed\n");
	git("add", ".");
	git("commit", "-m", "Fix synthetic S3 issue");
	const projectId = randomUUID();
	const settings = { ...BIOS_SETTINGS_DEFAULTS, knowledgeRoot: f.root, authorizedRoots: [f.workspaceA], authorizedProjectIds: [projectId] };
	const business = new BiosBusinessService({ readSettings: () => settings, resolveDesktopProjectPath: () => f.workspaceA });
	await business.bindProject({ desktopProjectId: "desktop-a", biosProjectId: projectId, displayName: "Historical Board" });
	const state = { version: 0, path: f.workspaceA, now: 1000 };
	const service = new BiosHistoryService({ readSettings: () => settings, readConfigurationVersion: () => state.version, resolveProject: () => ({ path: state.path }), now: () => state.now });
	return { ...f, git, settings, state, service, request: { desktopProjectId: "desktop-a", projectId, ref: "HEAD", limit: 1, keyword: "" } };
}
test("HX-02 bounded history and immutable diff read never write registry or source", async () => {
	const f = await fixture();
	try {
		const before = await readFile(join(f.root, "registry.json"), "utf8");
		const preview = await f.service.scan(f.request);
		assert.equal(preview.scanned, 1);
		assert.equal(preview.hasMore, true);
		assert.equal(preview.commits.length, 1);
		const evidence = await f.service.evidence(preview.token, preview.commits[0].sha);
		assert.match(evidence.diff, /\+fixed/);
		assert.equal(evidence.maySendToModel, false);
		assert.equal(await readFile(join(f.root, "registry.json"), "utf8"), before);
		assert.equal(f.git("status", "--porcelain"), "");
		assert.equal((await f.service.scan({ ...f.request, keyword: "PXE" })).commits.length, 0);
	} finally {
		await f.cleanup();
	}
});
test("HX-02 refuses no authorization, foreign binding, out-of-root path and expired/changed previews", async () => {
	const f = await fixture();
	try {
		await assert.rejects(() => f.service.scan({ ...f.request, desktopProjectId: "other" }), /不一致/);
		const preview = await f.service.scan(f.request);
		await assert.rejects(() => f.service.evidence(preview.token, "0".repeat(40)), /范围/);
		f.state.version++;
		await assert.rejects(() => f.service.evidence(preview.token, preview.commits[0].sha), /变化/);
		const fresh = await f.service.scan(f.request);
		f.state.now += 600001;
		await assert.rejects(() => f.service.evidence(fresh.token, fresh.commits[0].sha), /过期/);
		f.settings.authorizedRoots = [];
		await assert.rejects(() => f.service.scan(f.request), /目录/);
		f.settings.authorizedProjectIds = [];
		await assert.rejects(() => f.service.scan(f.request), /未授权/);
	} finally {
		await f.cleanup();
	}
});
test("HX-02 rejects option/range injection and output overflow rather than reporting empty history", async () => {
	for (const ref of ["--all", "HEAD..main", "HEAD;evil", "HEAD\nmain"]) assert.throws(() => validateHistoryRequest({ desktopProjectId: "a", projectId: "b", ref, limit: 20, keyword: "" }));
	assert.throws(() => validateHistoryRequest({ desktopProjectId: "a", projectId: "b", ref: "HEAD", limit: 101, keyword: "" }));
	const f = await fixture();
	try {
		await assert.rejects(() => runHistoryGit(f.workspaceA, ["log", "--format=%B", "HEAD", "--"], 1), /预算/);
		const preview = await f.service.scan(f.request);
		await writeFile(join(f.workspaceA, "Board.c"), "third\n");
		f.git("add", ".");
		f.git("commit", "-m", "Revert candidate fix");
		await assert.rejects(() => f.service.evidence(preview.token, preview.commits[0].sha), /变化/);
	} finally {
		await f.cleanup();
	}
});

test("HX-02 bounds concurrent work and rejects repo subdirectories and revoked model policy", async () => {
	const f = await fixture();
	try {
		const first = f.service.scan(f.request);
		await assert.rejects(() => f.service.scan(f.request), /正在进行/);
		await first;
		f.settings.endpoint = "allowed";
		const p = await f.service.scan({ ...f.request, limit: 2 });
		const rootCommit = p.commits[1];
		assert.match((await f.service.evidence(p.token, rootCommit.sha)).diff, /initial/);
		assert.equal((await f.service.evidence(p.token, rootCommit.sha)).maySendToModel, true);
		f.settings.endpoint = "denied";
		await assert.rejects(() => f.service.evidence(p.token, rootCommit.sha), /变化/);
		const sub = join(f.workspaceA, "sub");
		await mkdir(sub);
		const projectId = randomUUID();
		f.settings.authorizedProjectIds.push(projectId);
		const business = new BiosBusinessService({ readSettings: () => f.settings, resolveDesktopProjectPath: () => sub });
		await business.bindProject({ desktopProjectId: "sub", biosProjectId: projectId });
		f.state.path = sub;
		await assert.rejects(() => f.service.scan({ ...f.request, desktopProjectId: "sub", projectId }), /仓库根/);
	} finally {
		await f.cleanup();
	}
});

test("HX-02 refuses metadata delimiter injection instead of treating commit text as Git arguments", async () => {
	const f = await fixture();
	try {
		await writeFile(join(f.workspaceA, "Board.c"), "malicious metadata\n");
		f.git("add", ".");
		f.git("commit", "-m", "Untrusted\x1e" + "a".repeat(40) + "\n--output=unwanted");
		await assert.rejects(() => f.service.scan(f.request), /元数据/);
		assert.equal(f.git("status", "--porcelain"), "");
	} finally {
		await f.cleanup();
	}
});
