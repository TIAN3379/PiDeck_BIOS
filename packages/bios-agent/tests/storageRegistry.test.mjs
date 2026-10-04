/**
 * 存储层 registry 测试（BM-02A）。
 *
 * 覆盖：显式初始化、重复初始化不覆盖、损坏/未知版本/超大拒绝且原字节不变、
 * 绑定冲突、**真实子进程**重启读取与并发初始化竞争。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";
import { BIOS_CONTRACTS_SCHEMA_VERSION } from "../core/contracts/version.ts";
import { StorageError, initializeKnowledgeStore, readRegistry, resolveProjectBinding } from "../core/storage/index.ts";

const STORAGE_MODULE_PATH = fileURLToPath(new URL("../core/storage/index.ts", import.meta.url));
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-store-registry-")));

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

function makeRoot(name) {
	const root = join(SANDBOX, name);
	mkdirSync(root, { recursive: true });
	return realpathSync(root);
}

function hashFile(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function runNode(script, options = {}) {
	const args = ["--input-type=module", "-e", script];
	const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60_000, ...options });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

test("初始化空库：创建布局与合法空 registry", async () => {
	const root = makeRoot("init-basic");
	const created = await initializeKnowledgeStore({ root });

	assert.equal(created.status, "created");
	assert.equal(created.registry.revision, 0);
	assert.deepEqual(created.registry.projects, []);
	assert.equal(created.registry.schemaVersion, BIOS_CONTRACTS_SCHEMA_VERSION);
	assert.ok(created.createdDirectories.length >= 5, `应创建布局目录，实际：${created.createdDirectories.join(", ")}`);

	const layout = created.layout;
	for (const directory of [layout.projectsDir, layout.experiencesDir, layout.featuresDir, layout.auditDir, layout.cacheDir]) {
		assert.ok(existsSync(directory), `目录应存在：${directory}`);
	}
	assert.ok(existsSync(layout.registryPath));
});

test("重复初始化：返回 existing，registry 原字节与 revision 不变", async () => {
	const root = makeRoot("init-twice");
	const first = await initializeKnowledgeStore({ root, now: 1_700_000_000_000 });
	const before = hashFile(first.layout.registryPath);
	const beforeJson = readJson(first.layout.registryPath);

	// 第二次用不同的 now：不允许重置时间戳，也不允许再写一次文件。
	const second = await initializeKnowledgeStore({ root, now: 1_900_000_000_000 });
	assert.equal(second.status, "existing");
	assert.equal(second.registry.revision, beforeJson.revision);
	assert.equal(second.registry.createdAt, beforeJson.createdAt);
	assert.equal(hashFile(second.layout.registryPath), before, "重复初始化不得改动 registry 字节");
	assert.deepEqual(second.createdDirectories, [], "目录已存在时不应报告为新建");
});

test("损坏的 registry：初始化与读取都拒绝，且原字节不变", async () => {
	const root = makeRoot("init-broken");
	const created = await initializeKnowledgeStore({ root });
	writeFileSync(created.layout.registryPath, "{ this is not json", "utf8");
	const before = hashFile(created.layout.registryPath);

	await assert.rejects(
		() => initializeKnowledgeStore({ root }),
		(error) => error instanceof StorageError && error.code === "invalid-json",
	);
	await assert.rejects(
		() => readRegistry({ root }),
		(error) => error instanceof StorageError && error.code === "invalid-json",
	);
	assert.equal(hashFile(created.layout.registryPath), before, "损坏文件不得被修复或覆盖");
});

test("未来版本的 registry：拒绝解释且原字节不变", async () => {
	const root = makeRoot("init-future");
	const created = await initializeKnowledgeStore({ root });
	writeFileSync(created.layout.registryPath, `${JSON.stringify({ schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION + 1, revision: 0, createdAt: 1, updatedAt: 1, projects: [] })}\n`);
	const before = hashFile(created.layout.registryPath);

	await assert.rejects(
		() => initializeKnowledgeStore({ root }),
		(error) => error instanceof StorageError && error.code === "unsupported-schema-version",
	);
	assert.equal(hashFile(created.layout.registryPath), before);
});

test("超过字节上限的 registry：拒绝且不读取正文", async () => {
	const root = makeRoot("init-too-large");
	const created = await initializeKnowledgeStore({ root });
	// 造一个结构合法但超大的 registry：先限字节，再解析。
	const padding = "x".repeat(4096);
	const big = { schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION, revision: 0, createdAt: 1, updatedAt: 1, projects: [], padding };
	writeFileSync(created.layout.registryPath, JSON.stringify(big), "utf8");
	const before = hashFile(created.layout.registryPath);

	await assert.rejects(
		() => readRegistry({ root, limits: { maxRegistryBytes: 512 } }),
		(error) => error instanceof StorageError && error.code === "too-large",
	);
	assert.equal(hashFile(created.layout.registryPath), before);
});

test("registry 绑定冲突：同一路径归属两个项目被拒绝", async () => {
	const root = makeRoot("init-binding-conflict");
	const created = await initializeKnowledgeStore({ root });
	const workspace = join(root, "ws");
	const registry = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 0,
		createdAt: 1,
		updatedAt: 1,
		projects: [
			{ biosProjectId: "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e", workspaces: [{ workspaceId: "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50", path: workspace, boundAt: 1 }], createdAt: 1, updatedAt: 1 },
			{ biosProjectId: "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90", workspaces: [{ workspaceId: "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061", path: workspace, boundAt: 1 }], createdAt: 1, updatedAt: 1 },
		],
	};
	writeFileSync(created.layout.registryPath, `${JSON.stringify(registry, null, "\t")}\n`, "utf8");
	const before = hashFile(created.layout.registryPath);

	await assert.rejects(
		() => readRegistry({ root }),
		(error) => {
			assert.ok(error instanceof StorageError && error.code === "binding-conflict");
			assert.ok(Array.isArray(error.conflicts) && error.conflicts.length >= 2);
			return true;
		},
	);
	assert.equal(hashFile(created.layout.registryPath), before);
});

test("新进程读取同一知识根：ID 与 revision 与初始化结果一致", async () => {
	const root = makeRoot("restart-read");
	const created = await initializeKnowledgeStore({ root, now: 1_700_000_000_000 });

	const script = `
		import { readRegistry } from ${JSON.stringify(new URL("../core/storage/index.ts", import.meta.url).href)};
		const registry = await readRegistry({ root: ${JSON.stringify(root)} });
		process.stdout.write(JSON.stringify({ schemaVersion: registry.schemaVersion, revision: registry.revision, createdAt: registry.createdAt, projects: registry.projects.length }));
	`;
	const result = runNode(script);
	assert.equal(result.status, 0, `子进程失败：${result.stderr}`);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.schemaVersion, BIOS_CONTRACTS_SCHEMA_VERSION);
	assert.equal(payload.revision, created.registry.revision);
	assert.equal(payload.createdAt, created.registry.createdAt);
	assert.equal(payload.projects, 0);
});

test("两个真实子进程同时初始化：不产生半文件、不互相覆盖", async () => {
	const root = makeRoot("init-race");
	const script = `
		import { initializeKnowledgeStore } from ${JSON.stringify(new URL("../core/storage/index.ts", import.meta.url).href)};
		try {
			const result = await initializeKnowledgeStore({ root: ${JSON.stringify(root)} });
			process.stdout.write(JSON.stringify({ ok: true, status: result.status, revision: result.registry.revision }));
		} catch (error) {
			process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "unknown" }));
		}
	`;

	function spawnChild() {
		return new Promise((resolve) => {
			const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.on("close", (code) => resolve({ code, stdout, stderr }));
		});
	}

	const [first, second] = await Promise.all([spawnChild(), spawnChild()]);
	assert.equal(first.code, 0, `子进程 1 失败：${first.stderr}`);
	assert.equal(second.code, 0, `子进程 2 失败：${second.stderr}`);

	const outcomes = [JSON.parse(first.stdout), JSON.parse(second.stdout)];
	// 允许两种合法结果：一个 created 一个 existing；或竞争方拿到可重试的 init-race。
	const created = outcomes.filter((outcome) => outcome.ok && outcome.status === "created");
	const existing = outcomes.filter((outcome) => outcome.ok && outcome.status === "existing");
	const raced = outcomes.filter((outcome) => !outcome.ok);
	assert.ok(created.length + existing.length + raced.length === 2);
	assert.ok(created.length <= 1, "最多只能有一个进程报告 created");
	assert.ok(
		raced.every((outcome) => outcome.code === "init-race"),
		`竞争错误应是 init-race：${JSON.stringify(raced)}`,
	);

	// 无论竞争结果如何，最终文件必须是完整合法 JSON，且只有一个 registry。
	const registryPath = join(root, "registry.json");
	assert.ok(existsSync(registryPath));
	const registry = readJson(registryPath);
	assert.equal(registry.schemaVersion, BIOS_CONTRACTS_SCHEMA_VERSION);
	assert.deepEqual(registry.projects, []);

	// 重试读取必须得到合法的 existing（可恢复性）。
	const reread = await readRegistry({ root });
	assert.equal(reread.revision, registry.revision);
});

test("resolveProjectBinding：缺失、命中、多项目冲突、无查询条件", () => {
	const workspaceA = join(SANDBOX, "binding-ws-a");
	const registry = {
		schemaVersion: BIOS_CONTRACTS_SCHEMA_VERSION,
		revision: 1,
		createdAt: 1,
		updatedAt: 1,
		projects: [
			{
				biosProjectId: "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e",
				desktopProjectId: "desktop-1",
				workspaces: [{ workspaceId: "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50", path: workspaceA, boundAt: 1 }],
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};

	assert.equal(resolveProjectBinding(registry, {}).status, "missing");
	assert.equal(resolveProjectBinding(registry, {}).reason, "no-query");

	const byPath = resolveProjectBinding(registry, { workspacePath: workspaceA });
	assert.equal(byPath.status, "resolved");
	assert.equal(byPath.workspace.workspaceId, "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50");

	// 大小写差异在 Windows 上视为同一路径（不产生"假未命中"）。
	const cased = resolveProjectBinding(registry, { workspacePath: process.platform === "win32" ? workspaceA.toUpperCase() : workspaceA });
	assert.equal(cased.status, "resolved");

	assert.equal(resolveProjectBinding(registry, { workspacePath: join(SANDBOX, "binding-missing") }).status, "missing");
	assert.equal(resolveProjectBinding(registry, { workspacePath: join(SANDBOX, "binding-missing") }).reason, "no-match");
	assert.equal(resolveProjectBinding(registry, { biosProjectId: "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90" }).status, "missing");
	assert.equal(resolveProjectBinding(registry, { desktopProjectId: "desktop-1" }).status, "resolved");
	assert.equal(resolveProjectBinding(registry, { desktopProjectId: "desktop-unknown" }).status, "missing");

	// 同一路径归属两个项目：冲突而不是随便挑一个。
	const conflicting = {
		...registry,
		projects: [
			registry.projects[0],
			{
				biosProjectId: "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90",
				workspaces: [{ workspaceId: "c8e2f0a3-4d5b-4e6f-9a0b-1c2d3e4f5061", path: workspaceA, boundAt: 1 }],
				createdAt: 1,
				updatedAt: 1,
			},
		],
	};
	// 唯一性先于解析（BM-02AR / S5）：同一路径归属两个项目时，
	// 整份 registry 已经不成立，任何"解析成功"都不可信，因此报 inconsistent-registry 而不是挑一个。
	const conflict = resolveProjectBinding(conflicting, { workspacePath: workspaceA });
	assert.equal(conflict.status, "conflict");
	assert.equal(conflict.reason, "inconsistent-registry");
	assert.equal(conflict.candidates.length, 2);
});

test("不存在的知识根：读取报 invalid-root，初始化才允许创建", async () => {
	const missingRoot = join(SANDBOX, "not-created-yet");
	assert.equal(existsSync(missingRoot), false);

	await assert.rejects(
		() => readRegistry({ root: missingRoot }),
		(error) => error instanceof StorageError && error.code === "invalid-root",
	);

	const created = await initializeKnowledgeStore({ root: missingRoot });
	assert.equal(created.status, "created");
	assert.ok(existsSync(join(missingRoot, "registry.json")));
});
