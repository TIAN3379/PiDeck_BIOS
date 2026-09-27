/**
 * 正式包装后的 userData 解析：安装版与便携版必须隔离。
 * 便携 exe 若仍落到与安装版同一目录，同版本单实例锁会让第二次启动静默退出。
 * 安装版数据目录已更名 PiDeck（旧 pi-desktop 根由 userDataNameMigration 首启改名接管）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { PACKAGED_USER_DATA_NAME, PACKAGED_USER_DATA_NAME_NEW, PORTABLE_USER_DATA_DIR_NAME, resolvePackagedUserDataDir, isPortablePackagedEnv } = loadTsCommonJs("src/main/portableUserData.ts");

test("安装版 userData 用新名 PiDeck", () => {
	assert.equal(PACKAGED_USER_DATA_NAME_NEW, "PiDeck");
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: {},
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("C:\\Users\\me\\AppData\\Roaming", PACKAGED_USER_DATA_NAME_NEW),
	);
});

test("历史名仍导出（迁移器旧根解析的唯一来源）", () => {
	assert.equal(PACKAGED_USER_DATA_NAME, "pi-desktop");
});

test("Windows 便携 exe 落到 exe 同级 data/，不与安装版抢锁", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "win32",
			env: { PORTABLE_EXECUTABLE_DIR: "D:\\tools\\phids" },
			appData: "C:\\Users\\me\\AppData\\Roaming",
		}),
		join("D:\\tools\\phids", PORTABLE_USER_DATA_DIR_NAME),
	);
	assert.equal(isPortablePackagedEnv({ PORTABLE_EXECUTABLE_DIR: "D:\\tools\\phids" }, "win32"), true);
});

test("非 Windows 忽略 PORTABLE_EXECUTABLE_DIR", () => {
	assert.equal(
		resolvePackagedUserDataDir({
			platform: "linux",
			env: { PORTABLE_EXECUTABLE_DIR: "/tmp/phids" },
			appData: "/home/me/.config",
		}),
		join("/home/me/.config", PACKAGED_USER_DATA_NAME_NEW),
	);
	assert.equal(isPortablePackagedEnv({ PORTABLE_EXECUTABLE_DIR: "/tmp/phids" }, "linux"), false);
});

test("主进程正式版先跑 userData 更名迁移再 setPath，启动失败有 catch", () => {
	const src = readFileSync("src/main/index.ts", "utf8");
	assert.match(src, /from "\.\/portableUserData"/);
	assert.match(src, /runUserDataNameMigration\(\{/);
	assert.match(src, /portableOrExplicit:\s*isPortablePackagedEnv\(\)/);
	assert.match(src, /app\.setPath\("userData",\s*userDataNameMigrationResult\.userDataPath\)/);
	assert.match(src, /registerIpc\(\);\s*registerFeishuIpc\(\);\s*(?:\/\/[^\n]*\n\s*)*configBackupManager\?\.ensureInitialBackups\(\);\s*await createWindow\(\);/s);
	assert.match(src, /Application startup failed/);
	assert.match(src, /showErrorBox/);
});
