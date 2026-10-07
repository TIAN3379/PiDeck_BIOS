/**
 * R36-3 永久回归：**专业 Package 在扩展管理里的入口与禁用/恢复链**。
 *
 * 验收 §3 的诊断：以空 Pi 列表调用生产 `ExtensionManager.list()` 只会补出 14 个旧内置源，
 * `hasBiosSource=false` —— 普通用户没有可见的单包禁用/恢复入口。这里用同一个生产管理器
 * （只桩掉 pi list 与 npm 版本查询）证明：专业包出现在列表里（来源/实际目录/启用状态/版本/Skills），
 * 禁用写进 `removedBuiltInExtensions` 且解析层不再注入，恢复后回来，且**不删除知识库**。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_DIR = join(REPO_ROOT, "packages", "bios-agent");

function loadModules() {
	const builtIn = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");
	const manager = loadTsCommonJs("src/main/extensions/ExtensionManager.ts");
	return { builtIn, manager };
}

function createHarness() {
	const { builtIn, manager } = loadModules();
	const settings = { removedBuiltInExtensions: [] };
	const roots = { appPath: REPO_ROOT, resourcesPath: join(REPO_ROOT, "release", "win-unpacked", "resources"), isDev: true };
	const instance = new manager.ExtensionManager(
		{},
		() => ({}),
		() => settings,
		async (patch) => {
			Object.assign(settings, patch);
			return settings;
		},
		() => "built-in extensions cannot be uninstalled",
		roots,
	);
	// 隔离 pi/npm/用户目录 IO，但**保留** loadList 的真实合并逻辑（内置补齐就在里面）。
	instance.runPi = async () => "";
	instance.scanLocalExtensions = async () => [];
	instance.enrichExtensionVersion = async (extension) => extension;
	instance.getPiVersion = async () => "0.87.1";
	return { instance, settings, builtIn, roots };
}

/** Register the real IPC handlers: renderer calls these, not Manager.disableBuiltIn directly. */
function ipcHarness() {
	const harness = createHarness();
	const handlers = new Map();
	const { registerStoreIpc } = loadTsCommonJs("src/main/ipc/storeIpc.ts", {
		stubs: {
			electron: { ipcMain: { handle: (name, handler) => handlers.set(name, handler) } },
			"../extensions/piPackageCatalog": { getPiPackageCatalog: async () => ({}) },
		},
	});
	registerStoreIpc({ extensionManager: harness.instance, appLogger: { info() {}, error() {} } });
	const { ipcChannels } = loadTsCommonJs("src/shared/ipc.ts");
	return { ...harness, invoke: (key, ...args) => handlers.get(ipcChannels[key])({}, ...args) };
}

test("R37-3：实际 toggle IPC 禁用整包，列表和默认注入必须同时关闭，再恢复", async () => {
	const { invoke, instance, settings, builtIn, roots } = ipcHarness();
	await invoke("extensionsToggle", "bios-agent", false, "user");
	assert.equal((await instance.list()).extensions.find((e) => e.source === "bios-agent")?.enabled, false);
	assert.equal(builtIn.listActiveBuiltInExtensionPaths(roots, settings.removedBuiltInExtensions).includes(PACKAGE_DIR), false);
	await invoke("extensionsToggle", "bios-agent", true, "user");
	assert.equal((await instance.list()).extensions.find((e) => e.source === "bios-agent")?.enabled, true);
});

test("R37-3：实际移除/恢复 IPC 不删除整包，恢复兼容旧 disabledExtensions 误写", async () => {
	const { invoke, settings, instance } = ipcHarness();
	settings.disabledExtensions = [
		{ scope: "user", source: "bios-agent" },
		{ scope: "user", source: "other" },
	];
	await invoke("extensionsRemoveBuiltIn", "bios-agent");
	await invoke("extensionsRestoreBuiltIn", "bios-agent");
	assert.equal(existsSync(PACKAGE_DIR), true);
	assert.equal(
		settings.disabledExtensions.some((e) => e.source === "bios-agent"),
		false,
	);
	assert.equal(
		settings.disabledExtensions.some((e) => e.source === "other"),
		true,
	);
	assert.equal((await instance.list()).extensions.find((e) => e.source === "bios-agent")?.enabled, true);
});

test("R37-3：专业包版本不能被普通内置扩展清单覆盖", async () => {
	const { instance } = createHarness();
	const expected = JSON.parse(readFileSync(join(PACKAGE_DIR, "package.json"), "utf8")).version;
	assert.equal((await instance.list()).extensions.find((e) => e.source === "bios-agent")?.currentVersion, expected);
});

test("R37-3：注册 IPC 到真实启动 resolver，白名单与默认模式禁用/恢复一致", async () => {
	const temporary = mkdtempSync(join(tmpdir(), "bios-resolvers-"));
	try {
		const { invoke, settings, instance } = ipcHarness();
		const { createPiProcessExtensionResolvers } = loadTsCommonJs("src/main/extensions/piProcessExtensionResolvers.ts", { stubs: { electron: { app: { getAppPath: () => REPO_ROOT, getPath: () => temporary, isPackaged: false } }, "node:os": { homedir: () => temporary } } });
		// 强制返回显式白名单，不让 null（正常默认加载）掩盖断言。
		settings.disabledExtensions = [{ scope: "user", source: "other" }];
		const resolvers = createPiProcessExtensionResolvers(temporary, settings);
		for (const enabled of [false, true, false, true]) {
			await invoke("extensionsToggle", "bios-agent", enabled, "user");
			assert.equal(resolvers.resolveBuiltInExtensionPaths(settings).includes(PACKAGE_DIR), enabled);
			assert.equal(resolvers.resolveEnabledExtensionPaths(settings).includes(PACKAGE_DIR), enabled);
		}
		settings.disabledExtensions.push({ scope: "user", source: "bios-agent" });
		instance.invalidateListCache();
		assert.equal((await instance.list()).extensions.find((e) => e.source === "bios-agent")?.enabled, false);
		assert.equal(resolvers.resolveBuiltInExtensionPaths(settings).includes(PACKAGE_DIR), false, "旧误写在恢复前也应尊重禁用意图");
		await invoke("extensionsRestoreBuiltIn", "bios-agent");
		assert.equal(resolvers.resolveEnabledExtensionPaths(settings).includes(PACKAGE_DIR), true);
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});

test("R36-3：空 Pi 列表下，生产管理器必须列出 bios-agent（来源/目录/版本/Skills）", async () => {
	const { instance } = createHarness();
	const listed = await instance.list(false);
	const bios = listed.extensions.find((extension) => extension.source === "bios-agent");
	assert.ok(bios !== undefined, `必须出现专业包条目：${listed.extensions.map((e) => e.source).join(", ")}`);
	assert.equal(bios.builtIn, true, "它是内置源（不可卸载）");
	assert.equal(bios.packageDirectory, true, "必须标记为整包目录（界面不能按普通 TS 文件处理）");
	assert.equal(bios.path, PACKAGE_DIR, "必须给实际目录");
	assert.equal(bios.enabled, true, "默认启用");
	assert.equal(typeof bios.currentVersion, "string", "必须显示专业包版本");
	// AW-07：新增通用 UEFI 定位（common-uefi）与 BIOS 调查方法（bios-investigation）两份 Skill。
	assert.equal(bios.skillCount, 4, `必须显示 Skills 数量：${bios.skillCount}`);
	// 旧内置源仍在（不是替换）。
	const oldSources = listed.extensions.filter((extension) => extension.builtIn && extension.source !== "bios-agent");
	assert.equal(oldSources.length, 14, `旧内置源必须保留：${oldSources.length}`);
});

test("R36-3：禁用 ⇒ 记入 removedBuiltInExtensions 且解析层不再注入；恢复后回来；知识库不受影响", async () => {
	const knowledgeRoot = mkdtempSync(join(tmpdir(), "bios-kb-"));
	const { instance, settings, builtIn, roots } = createHarness();
	try {
		await instance.disableBuiltIn("bios-agent");
		// 跨 vm realm 的数组原型不同，比较前展开到宿主数组。
		assert.deepEqual([...settings.removedBuiltInExtensions], ["bios-agent"], "禁用必须写进 removedBuiltInExtensions");
		const injected = builtIn.listActiveBuiltInExtensionPaths(roots, settings.removedBuiltInExtensions);
		assert.equal(injected.includes(PACKAGE_DIR), false, "禁用后不得再注入专业包");
		// 空列表里仍然显示它（用户要能恢复），只是 enabled=false。
		const disabled = await instance.list(false);
		const bios = disabled.extensions.find((extension) => extension.source === "bios-agent");
		assert.equal(bios?.enabled, false, "禁用后仍必须可见（否则无法恢复）");
		assert.equal(existsSync(knowledgeRoot), true, "禁用不得删除知识库");

		await instance.restoreBuiltIn("bios-agent");
		assert.deepEqual([...settings.removedBuiltInExtensions], []);
		const restored = builtIn.listActiveBuiltInExtensionPaths(roots, settings.removedBuiltInExtensions);
		assert.ok(restored.includes(PACKAGE_DIR), "恢复后必须重新注入专业包");
		assert.equal((await instance.list(false)).extensions.find((extension) => extension.source === "bios-agent")?.enabled, true);
	} finally {
		rmSync(knowledgeRoot, { recursive: true, force: true });
	}
});

test("R36-3：专业包不能被卸载（只能禁用/恢复）", async () => {
	const { instance } = createHarness();
	await assert.rejects(() => instance.uninstall("bios-agent"), /cannot be uninstalled/i);
});
