/**
 * userData 目录更名迁移（pi-desktop → PiDeck）：
 * 安装版首启整目录改名 + 持久化绝对路径改写 + ~/.pi/agent/sessions encoded 目录迁移，
 * 全链路幂等（中途失败下次启动重试）、便携/显式目录不参与、冲突保守回退。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { runUserDataNameMigration, replaceRootInText, encodeSessionDirName, consumeUserDataNameMigrationNotice, recordUserDataNameMigrationNotice } = loadTsCommonJs("src/main/projects/userDataNameMigration.ts");

function makeFixture({ legacyData = true, newData = false } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pideck-userdata-migration-"));
	const appData = join(root, "AppData");
	const home = join(root, "home");
	const oldRoot = join(appData, "pi-desktop");
	const newRoot = join(appData, "PiDeck");
	mkdirSync(home, { recursive: true });
	if (legacyData) mkdirSync(oldRoot, { recursive: true });
	if (newData) mkdirSync(newRoot, { recursive: true });
	return { root, appData, home, oldRoot, newRoot };
}

test("旧根整体改名到 PiDeck，返回新路径", () => {
	const fx = makeFixture();
	mkdirSync(join(fx.oldRoot, "chat-workspace"), { recursive: true });
	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "migrated");
	assert.equal(result.userDataPath, resolve(fx.newRoot));
	assert.ok(existsSync(join(fx.newRoot, "chat-workspace")));
	assert.ok(!existsSync(fx.oldRoot));
	rmSync(fx.root, { recursive: true, force: true });
});

test("新装机器（两代目录皆无）不动作", () => {
	const fx = makeFixture({ legacyData: false });
	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "new-install");
	assert.equal(result.userDataPath, resolve(fx.newRoot));
	rmSync(fx.root, { recursive: true, force: true });
});

test("两代目录并存（降级后回升级）保守用新目录，不合并", () => {
	const fx = makeFixture({ newData: true });
	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "collision");
	assert.equal(result.userDataPath, resolve(fx.newRoot));
	assert.ok(existsSync(fx.oldRoot));
	rmSync(fx.root, { recursive: true, force: true });
});

test("便携版 / 显式 user-data-dir 跳过改名", () => {
	const fx = makeFixture();
	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32", portableOrExplicit: true });
	assert.equal(result.kind, "skipped");
	assert.equal(result.reason, "explicit-user-data-dir");
	assert.ok(existsSync(fx.oldRoot));
	rmSync(fx.root, { recursive: true, force: true });
});

test("持久化 JSON 里的旧根绝对路径被换成新根（含 JSON 转义形态）", () => {
	const fx = makeFixture();
	const oldRoot = resolve(fx.oldRoot);
	const newRoot = resolve(fx.newRoot);
	const winEscaped = oldRoot.replace(/\\/g, "\\\\");
	const winEscapedNew = newRoot.replace(/\\/g, "\\\\");
	writeFileSync(join(fx.oldRoot, "chat-path.json"), JSON.stringify({ path: winEscaped + "\\chat-workspace" }));
	writeFileSync(
		join(fx.oldRoot, "session-catalog.json"),
		JSON.stringify({
			version: 1,
			sessions: [
				{ id: "s1", projectId: "builtin-chat", filePath: `${winEscaped}\\chat-workspace\\notes.md`, parentSessionPath: `${winEscaped}\\chat-workspace\\a.jsonl` },
				// 同前缀但不同根的路径不得误伤（dev 数据目录 / 无关目录）
				{ id: "s2", projectId: "p2", filePath: join(fx.appData, "pi-desktop-dev", "chat-workspace", "b.jsonl").replace(/\\/g, "\\\\") },
				{ id: "s3", projectId: "p3", filePath: "D:\\projects\\pi-desktop-notes\\c.jsonl" },
				// 精确等于根（无尾段）
				{ id: "s4", projectId: "p4", filePath: winEscaped },
			],
		}),
	);
	writeFileSync(join(fx.oldRoot, "projects.json"), JSON.stringify([{ id: "builtin-chat", kind: "chat", path: winEscaped + "\\chat-workspace" }]));
	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "migrated");

	const catalog = JSON.parse(readFileSync(join(fx.newRoot, "session-catalog.json"), "utf8"));
	assert.equal(catalog.sessions[0].filePath, `${winEscapedNew}\\chat-workspace\\notes.md`);
	assert.equal(catalog.sessions[0].parentSessionPath, `${winEscapedNew}\\chat-workspace\\a.jsonl`);
	assert.ok(catalog.sessions[1].filePath.includes("pi-desktop-dev"), "同前缀 dev 根不被改写");
	assert.ok(catalog.sessions[2].filePath.includes("pi-desktop-notes"), "路径中段含 pi-desktop 不被改写");
	assert.equal(catalog.sessions[3].filePath, winEscapedNew, "精确等于根也要替换");
	const chatPath = JSON.parse(readFileSync(join(fx.newRoot, "chat-path.json"), "utf8"));
	assert.equal(chatPath.path, `${winEscapedNew}\\chat-workspace`);
	const projects = JSON.parse(readFileSync(join(fx.newRoot, "projects.json"), "utf8"));
	assert.equal(projects[0].path, `${winEscapedNew}\\chat-workspace`);
	rmSync(fx.root, { recursive: true, force: true });
});

test("~/.pi/agent/sessions 下旧根 encoded 聊天目录整体改名，JSONL 原样保留", () => {
	const fx = makeFixture();
	const oldRoot = resolve(fx.oldRoot);
	const newRoot = resolve(fx.newRoot);
	// 真实安装态：userData 下有 chat-workspace 目录，chat-path.json 登记其绝对路径
	mkdirSync(join(fx.oldRoot, "chat-workspace"), { recursive: true });
	writeFileSync(join(fx.oldRoot, "chat-path.json"), JSON.stringify({ path: `${oldRoot.replace(/\\/g, "\\\\")}\\chat-workspace` }));
	const sessionsRoot = join(fx.home, ".pi", "agent", "sessions");
	// 磁盘目录混存大小写形态（历史命名不统一），匹配必须大小写不敏感
	const legacyDir = encodeSessionDirName(join(oldRoot, "chat-workspace"));
	mkdirSync(join(sessionsRoot, legacyDir), { recursive: true });
	writeFileSync(join(sessionsRoot, legacyDir, "2026-09-01_session.jsonl"), '{"type":"session","cwd":"x"}');
	// 真实 catalog 引用形态：filePath 保留磁盘目录名，originKey 全小写正斜杠
	writeFileSync(
		join(fx.oldRoot, "session-catalog.json"),
		JSON.stringify({
			version: 1,
			sessions: [{ id: "s1", filePath: join(sessionsRoot, legacyDir, "2026-09-01_session.jsonl").replace(/\\/g, "\\\\"), originKey: `pi:native:${sessionsRoot.replace(/\\/g, "/")}/${legacyDir}/2026-09-01_session.jsonl`.toLowerCase() }],
		}),
	);
	// 无关目录不得被触碰
	mkdirSync(join(sessionsRoot, "--d--other-project--"), { recursive: true });

	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "migrated");
	// vm 沙箱 realm 返回的数组与宿主字面量原型不同，只能做结构化比较
	assert.equal(JSON.stringify(result.migratedSessionDirs), JSON.stringify([legacyDir]));
	const targetDir = encodeSessionDirName(join(newRoot, "chat-workspace"));
	assert.ok(existsSync(join(sessionsRoot, targetDir, "2026-09-01_session.jsonl")));
	assert.ok(!existsSync(join(sessionsRoot, legacyDir)));
	assert.ok(existsSync(join(sessionsRoot, "--d--other-project--")));
	const catalog = readFileSync(join(fx.newRoot, "session-catalog.json"), "utf8");
	assert.ok(catalog.includes(targetDir), "filePath 里的 encoded 目录名同步改写");
	assert.ok(catalog.includes(targetDir.toLowerCase()), "originKey 的小写形态同步改写");
	assert.ok(!catalog.includes(legacyDir), "旧 encoded token 不再残留");
	rmSync(fx.root, { recursive: true, force: true });
});

test("聊天目录已从磁盘删除时，按 chat-path.json 登记路径仍能迁移会话目录", () => {
	const fx = makeFixture();
	const oldRoot = resolve(fx.oldRoot);
	const newRoot = resolve(fx.newRoot);
	const sessionsRoot = join(fx.home, ".pi", "agent", "sessions");
	const legacyDir = encodeSessionDirName(join(oldRoot, "chat-workspace"));
	mkdirSync(join(sessionsRoot, legacyDir), { recursive: true });
	writeFileSync(join(sessionsRoot, legacyDir, "s.jsonl"), "{}");
	// 只有 chat-path.json 还登记着旧聊天目录，userData 下并无该目录
	writeFileSync(join(fx.oldRoot, "chat-path.json"), JSON.stringify({ path: `${oldRoot.replace(/\\/g, "\\\\")}\\chat-workspace` }));

	const result = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(result.kind, "migrated");
	assert.equal(JSON.stringify(result.migratedSessionDirs), JSON.stringify([legacyDir]));
	assert.ok(existsSync(join(sessionsRoot, encodeSessionDirName(join(newRoot, "chat-workspace")), "s.jsonl")));
	rmSync(fx.root, { recursive: true, force: true });
});

test("二次运行全链路幂等（已迁移机器 no-op）", () => {
	const fx = makeFixture();
	const sessionsRoot = join(fx.home, ".pi", "agent", "sessions");
	mkdirSync(join(sessionsRoot, encodeSessionDirName(join(resolve(fx.oldRoot), "chat-workspace"))), { recursive: true });
	writeFileSync(join(fx.oldRoot, "chat-path.json"), JSON.stringify({ path: resolve(fx.oldRoot).replace(/\\/g, "\\\\") + "\\chat-workspace" }));
	const first = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	const catalogAfterFirst = readFileSync(join(fx.newRoot, "chat-path.json"), "utf8");
	const dirsAfterFirst = readdirSync(sessionsRoot).join(",");
	const second = runUserDataNameMigration({ appDataDir: fx.appData, homeDir: fx.home, platform: "win32" });
	assert.equal(first.kind, "migrated");
	assert.equal(second.kind, "skipped");
	assert.equal(second.reason, "already-migrated");
	assert.equal(readFileSync(join(fx.newRoot, "chat-path.json"), "utf8"), catalogAfterFirst);
	assert.equal(readdirSync(sessionsRoot).join(","), dirsAfterFirst);
	rmSync(fx.root, { recursive: true, force: true });
});

test("Linux 正斜杠根路径同样被替换", () => {
	const out = replaceRootInText('{"filePath":"/home/me/.config/pi-desktop/chat-workspace/a.jsonl"}', "/home/me/.config/pi-desktop", "/home/me/.config/PiDeck", false);
	assert.equal(out, '{"filePath":"/home/me/.config/PiDeck/chat-workspace/a.jsonl"}');
});

test("迁移提示消费式领取：只返回一次", () => {
	recordUserDataNameMigrationNotice({ kind: "migrated", oldPath: "/old", userDataPath: "/new", migratedSessionDirs: ["a", "b"] });
	// vm 加载的生产代码返回对象来自沙箱 realm，原型与宿主字面量不同，只能做结构化比较
	assert.equal(JSON.stringify(consumeUserDataNameMigrationNotice()), JSON.stringify({ oldPath: "/old", newPath: "/new", migratedSessionDirCount: 2 }));
	assert.equal(consumeUserDataNameMigrationNotice(), null);
	recordUserDataNameMigrationNotice({ kind: "skipped", reason: "new-install", userDataPath: "/new" });
	assert.equal(consumeUserDataNameMigrationNotice(), null);
});
