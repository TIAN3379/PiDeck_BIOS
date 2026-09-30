import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";

const source = readFileSync("src/renderer/src/sessionManagerModel.ts", "utf8");
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const sandbox = { exports: {} };
vm.runInNewContext(output, sandbox, { filename: "sessionManagerModel.ts" });

const { isManagerSessionSummary, sessionManagerRowKey, worktreeFamilyProjects, canonicalWorkspacePath, filterArchivedPiByFamily, managerArchivedRowKey } = sandbox.exports;
const summary = (overrides = {}) => ({ id: "s1", filePath: "", name: "t", preview: "", updatedAt: 1, messageCount: 1, source: "pi", ...overrides });
const project = (id, path, worktreeParentId) => ({ id, name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path, path, ...(worktreeParentId ? { worktreeParentId } : {}) });

test("session manager includes persisted sessions and uses stable record ids", () => {
	assert.equal(isManagerSessionSummary(summary({ filePath: "a.jsonl" })), true);
	assert.equal(isManagerSessionSummary(summary()), false);
	assert.equal(sessionManagerRowKey(summary({ id: "uuid-1" })), "uuid-1");
});

test("worktree family includes the root and all children", () => {
	const projects = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root"), project("other", "D:/other")];
	assert.equal(
		worktreeFamilyProjects(projects, "wt-a")
			.map((item) => item.id)
			.join(","),
		"root,wt-a",
	);
});

test("native workspace paths are case-insensitive while WSL paths are not", () => {
	assert.equal(canonicalWorkspacePath("C:\\Work\\A\\", false), "c:/work/a");
	assert.equal(canonicalWorkspacePath("/home/Work/A/", true), "/home/Work/A");
});

test("archived Pi sessions are filtered by project family", () => {
	const family = [project("root", "C:/work/repo"), project("wt-a", "C:/work/repo-wt-a", "root")];
	const items = [
		{ summary: summary({ id: "p1", projectPath: "C:/work/repo" }), originalPath: "C:/archive/a.jsonl" },
		{ summary: summary({ id: "p2", projectPath: "D:/other" }), originalPath: "C:/archive/b.jsonl" },
	];
	assert.equal(
		filterArchivedPiByFamily(items, family)
			.map((item) => item.summary.id)
			.join(","),
		"p1",
	);
	assert.equal(managerArchivedRowKey({ kind: "pi", item: items[0] }), "p1");
});
