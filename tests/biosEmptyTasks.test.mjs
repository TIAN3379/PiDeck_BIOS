import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { createProjectSandbox } from "../packages/bios-agent/tests/helpers/projectFixtures.mjs";
import { initializeKnowledgeStore, listRecords } from "../packages/bios-agent/core/storage/index.ts";
import { bindProjectWorkspace } from "../packages/bios-agent/core/projects/binding.ts";

test("HX-01 newly bound project has empty tasks without writing directories; absent/corrupt parent is not empty success", async () => {
	const f = await createProjectSandbox("bios-empty-tasks-");
	try {
		await initializeKnowledgeStore({ root: f.root });
		await mkdir(f.workspaceA, { recursive: true });
		const projectId = randomUUID();
		await bindProjectWorkspace({ root: f.root, cwd: f.workspaceA, workspacePath: f.workspaceA, biosProjectId: projectId });
		for (const kind of ["task-record", "context-manifest"]) {
			const listed = await listRecords({ root: f.root, projectId, kind });
			assert.deepEqual(listed.entries, []);
			assert.equal(listed.truncated, false);
		}
		const tasks = join(f.root, "projects", projectId, "tasks");
		await assert.rejects(() => lstat(tasks), { code: "ENOENT" });
		await assert.rejects(() => listRecords({ root: f.root, projectId: randomUUID(), kind: "task-record" }));
		await writeFile(tasks, "not a directory");
		await assert.rejects(() => listRecords({ root: f.root, projectId, kind: "task-record" }));
		await writeFile(join(f.root, "projects", projectId, "profile.json"), "{}");
		await assert.rejects(() => listRecords({ root: f.root, projectId, kind: "context-manifest" }));
	} finally {
		await f.cleanup();
	}
});
