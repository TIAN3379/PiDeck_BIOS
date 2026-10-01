/**
 * 知识根解析与 ID/路径规则测试（round1_acceptance.md R2、R3）。
 *
 * 这些规则同时服务桌面端与 CLI：回归测试是"两边读到同一份数据、且不会写到根外"的守卫。
 * 路径全部用**真实平台**的 node:path + 真实存在的临时目录，
 * 不切换 platform 字符串、也不写 POSIX 字面路径（那会在 Windows 上被 resolve 加上盘符，
 * 得到"测试自己在骗自己"的结论）。
 */
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { BIOS_KNOWLEDGE_ROOT_ENV, KnowledgePathError, defaultKnowledgeRoot, isFullyQualifiedPath, resolveKnowledgePaths, resolveKnowledgeRoot } from "../core/paths.ts";

const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";

/** realpath：macOS 的 /var 与 Windows 短名都会让字面路径与真实路径不同。 */
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-paths-")));
const KNOWLEDGE_ROOT = join(SANDBOX, "knowledge");

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

test("默认知识根是用户级目录，不写死盘符", () => {
	// 断言的是"由 home 推导"，因此任何机器都能直接跑，不需要存在某个特定盘符。
	assert.equal(defaultKnowledgeRoot(join(SANDBOX, "home")), join(SANDBOX, "home", "BIOS_Knowledge"));
	// 默认值不含任何盘符/目录名假设：换 home 就换结果。
	assert.notEqual(defaultKnowledgeRoot(join(SANDBOX, "home-a")), defaultKnowledgeRoot(join(SANDBOX, "home-b")));
});

test("解析优先级：显式注入 > 环境变量 > 用户级默认", () => {
	const overridePath = join(SANDBOX, "custom-knowledge");
	const envPath = join(SANDBOX, "from-env");

	const override = resolveKnowledgeRoot({ override: overridePath, env: { [BIOS_KNOWLEDGE_ROOT_ENV]: envPath }, home: join(SANDBOX, "home") });
	assert.equal(override.source, "override");
	assert.equal(override.root, overridePath);

	const fromEnv = resolveKnowledgeRoot({ env: { [BIOS_KNOWLEDGE_ROOT_ENV]: envPath }, home: join(SANDBOX, "home") });
	assert.equal(fromEnv.source, "env");
	assert.equal(fromEnv.root, envPath);

	const fallback = resolveKnowledgeRoot({ env: {}, home: join(SANDBOX, "home") });
	assert.equal(fallback.source, "default");
	assert.equal(fallback.root, join(SANDBOX, "home", "BIOS_Knowledge"));
});

test("相对知识根一律拒绝（桌面与 CLI 的 cwd 不同，相对路径会指向不同知识库）", () => {
	assert.throws(
		() => resolveKnowledgeRoot({ override: "knowledge", env: {} }),
		(error) => error instanceof KnowledgePathError && error.code === "relative-root",
	);
	assert.throws(
		() => resolveKnowledgeRoot({ env: { [BIOS_KNOWLEDGE_ROOT_ENV]: "./relative" } }),
		(error) => error instanceof KnowledgePathError && error.code === "relative-root",
	);
});

test("空白注入与环境变量按未提供处理", () => {
	const resolved = resolveKnowledgeRoot({ override: "   ", env: { [BIOS_KNOWLEDGE_ROOT_ENV]: "  " }, home: join(SANDBOX, "home") });
	assert.equal(resolved.source, "default");
	assert.equal(resolved.root, join(SANDBOX, "home", "BIOS_Knowledge"));
});

test("子路径全部落在知识根内，且布局与文档一致", () => {
	const paths = resolveKnowledgePaths({ root: KNOWLEDGE_ROOT, source: "override" });
	assert.equal(paths.registryPath, join(KNOWLEDGE_ROOT, "registry.json"));
	assert.equal(paths.projectProfilePath(PROJECT_ID), join(KNOWLEDGE_ROOT, "projects", PROJECT_ID, "profile.json"));
	assert.equal(paths.taskPath(PROJECT_ID, "task-1"), join(KNOWLEDGE_ROOT, "projects", PROJECT_ID, "tasks", "task-1.json"));
	assert.equal(paths.experiencePath("exp-1"), join(KNOWLEDGE_ROOT, "experiences", "exp-1.json"));
	assert.equal(paths.featurePath("feature-1"), join(KNOWLEDGE_ROOT, "features", "feature-1.json"));
	assert.equal(paths.auditPath("audit-1"), join(KNOWLEDGE_ROOT, "audit", "audit-1.json"));
	assert.equal(paths.cacheDir, join(KNOWLEDGE_ROOT, "cache"));
});

test("项目 ID 必须是 UUID：目录名形态被拒绝", () => {
	const paths = resolveKnowledgePaths({ root: KNOWLEDGE_ROOT, source: "override" });
	assert.throws(() => paths.projectProfilePath("bios-main"), { name: "KnowledgeIdError" });
	assert.throws(() => paths.projectDir(".."), { name: "KnowledgeIdError" });
	assert.ok(paths.projectProfilePath(PROJECT_ID).endsWith(join("projects", PROJECT_ID, "profile.json")));
});

test("非法 ID 被拒绝：分隔符、上级目录、隐藏文件、空白、超长、大写", () => {
	const paths = resolveKnowledgePaths({ root: KNOWLEDGE_ROOT, source: "override" });
	const invalid = ["../escape", "a/b", "a\\b", "", ".hidden", "..", "a b", "AAA", "Exp", "a".repeat(129)];
	for (const id of invalid) {
		assert.throws(() => paths.experiencePath(id), { name: "KnowledgeIdError" }, `应拒绝 ID: ${id}`);
	}
	assert.ok(paths.experiencePath("exp-1_2.3").endsWith("exp-1_2.3.json"));
});

test("Windows 设备保留名与尾随点被拒绝（跨平台统一规则）", () => {
	const paths = resolveKnowledgePaths({ root: KNOWLEDGE_ROOT, source: "override" });
	// 保留名不区分大小写，因此"限制为小写"并不足够，必须显式拒绝。
	for (const id of ["con", "prn", "aux", "nul", "com1", "lpt9", "con.json", "nul.txt"]) {
		assert.throws(() => paths.experiencePath(id), { name: "KnowledgeIdError" }, `应拒绝保留名: ${id}`);
	}
	// 尾随点：Windows 会静默去掉尾点，`exp.` 与 `exp` 会命中同一文件。
	assert.throws(() => paths.experiencePath("exp."), { name: "KnowledgeIdError" });
	assert.throws(() => paths.experiencePath("exp.."), { name: "KnowledgeIdError" });
	// 内部点仍然合法。
	assert.ok(paths.experiencePath("exp.1").endsWith("exp.1.json"));
});

test("词法根约束：根内路径通过，越界路径抛 path-escape", async () => {
	const { resolveInsideRoot } = await import("../core/paths.ts");
	assert.equal(resolveInsideRoot(KNOWLEDGE_ROOT, "projects", PROJECT_ID, "profile.json"), join(KNOWLEDGE_ROOT, "projects", PROJECT_ID, "profile.json"));
	assert.throws(
		() => resolveInsideRoot(KNOWLEDGE_ROOT, "..", "outside.json"),
		(error) => error instanceof KnowledgePathError && error.code === "path-escape",
	);
	assert.throws(
		() => resolveInsideRoot(KNOWLEDGE_ROOT, "projects", "..", "..", "outside.json"),
		(error) => error instanceof KnowledgePathError && error.code === "path-escape",
	);
	// 同前缀目录（`knowledge2`）不能被误判为根内。
	assert.throws(() => resolveInsideRoot(KNOWLEDGE_ROOT, "..", "knowledge2", "x.json"), { name: "KnowledgePathError" });
});

test("完全限定路径判定是纯函数，可按平台验证", () => {
	// Windows：必须有盘符或合法 UNC；`\name` 依赖当前盘符，`C:name` 是盘符相对。
	assert.equal(isFullyQualifiedPath("C:\\BIOS_Knowledge", "win32"), true);
	assert.equal(isFullyQualifiedPath("c:/BIOS_Knowledge", "win32"), true);
	assert.equal(isFullyQualifiedPath("\\\\server\\share\\knowledge", "win32"), true);
	assert.equal(isFullyQualifiedPath("\\BIOS_Knowledge", "win32"), false);
	assert.equal(isFullyQualifiedPath("/BIOS_Knowledge", "win32"), false);
	assert.equal(isFullyQualifiedPath("C:BIOS_Knowledge", "win32"), false);
	assert.equal(isFullyQualifiedPath("\\\\server", "win32"), false);
	assert.equal(isFullyQualifiedPath("knowledge", "win32"), false);
	// POSIX：以 / 开头才算完全限定。
	assert.equal(isFullyQualifiedPath("/srv/knowledge", "linux"), true);
	assert.equal(isFullyQualifiedPath("knowledge", "linux"), false);
	assert.equal(isFullyQualifiedPath("C:\\knowledge", "linux"), false);
	assert.equal(isFullyQualifiedPath("   ", "linux"), false);
});

test("依赖当前盘符/当前目录的根路径一律拒绝（不借 cwd 补全）", () => {
	// round2 F2：`\BIOS_Knowledge` 在 Windows 上 isAbsolute 为真，却会随进程盘符变化。
	// 输入按平台条件给出，只断言"在本平台确实不是完全限定"的那些。
	const bad = process.platform === "win32" ? ["\\BIOS_Knowledge", "/BIOS_Knowledge", "C:BIOS_Knowledge", "BIOS_Knowledge"] : ["BIOS_Knowledge", "./knowledge", "C:knowledge"];
	for (const value of bad) {
		assert.throws(
			() => resolveKnowledgeRoot({ override: value, env: {} }),
			(error) => error instanceof KnowledgePathError && error.code === "relative-root",
			`override 应拒绝：${value}`,
		);
		assert.throws(
			() => resolveKnowledgeRoot({ env: { [BIOS_KNOWLEDGE_ROOT_ENV]: value } }),
			(error) => error instanceof KnowledgePathError && error.code === "relative-root",
			`环境变量应拒绝：${value}`,
		);
	}
});

test("resolveKnowledgePaths 的字符串入口与对象入口复用同一校验", () => {
	// 以前字符串入口会把相对根 resolve 到 cwd，等于绕过 resolveKnowledgeRoot。
	assert.throws(
		() => resolveKnowledgePaths("knowledge"),
		(error) => error instanceof KnowledgePathError,
	);
	assert.throws(
		() => resolveKnowledgePaths({ root: "knowledge", source: "override" }),
		(error) => error instanceof KnowledgePathError,
	);
	assert.throws(
		() => resolveKnowledgePaths({ root: ".", source: "override" }),
		(error) => error instanceof KnowledgePathError,
	);

	// 合法的完全限定根：两个入口给出一致的规范化结果。
	const fromString = resolveKnowledgePaths(KNOWLEDGE_ROOT);
	const fromObject = resolveKnowledgePaths({ root: KNOWLEDGE_ROOT, source: "override" });
	assert.equal(fromString.root, fromObject.root);
	assert.equal(fromString.registryPath, fromObject.registryPath);
});

test("默认 home 也遵守完全限定契约", () => {
	assert.throws(
		() => defaultKnowledgeRoot("relative-home"),
		(error) => error instanceof KnowledgePathError && error.code === "relative-root",
	);
	assert.equal(defaultKnowledgeRoot(KNOWLEDGE_ROOT), join(KNOWLEDGE_ROOT, "BIOS_Knowledge"));
});

test("根内 ..cache 目录不是逃逸（精确识别 .. 段）", async () => {
	const { resolveInsideRoot } = await import("../core/paths.ts");
	// startsWith("..") 会把 `..cache` 当成父目录跳转，但它只是普通目录名。
	assert.equal(resolveInsideRoot(KNOWLEDGE_ROOT, "..cache"), join(KNOWLEDGE_ROOT, "..cache"));
	assert.equal(resolveInsideRoot(KNOWLEDGE_ROOT, "..cache", "deep"), join(KNOWLEDGE_ROOT, "..cache", "deep"));
	// 真正的父目录跳转仍然拒绝。
	assert.throws(() => resolveInsideRoot(KNOWLEDGE_ROOT, ".."), { name: "KnowledgePathError" });
	assert.throws(() => resolveInsideRoot(KNOWLEDGE_ROOT, "..", "sibling"), { name: "KnowledgePathError" });
});
