/**
 * BM-07A C3 永久回归：**专业 Package 的整包分发与禁用链接入**。
 *
 * 覆盖验收对 C3 的要求：
 * - 不假设安装机器存在源码或开发 node_modules：只带运行时需要的整包内容
 *   （入口 + 依赖模块 + Skills + 包元数据），明确排除 tests/node_modules；
 * - 纳入既有白名单/禁用链：用户在设置里移除 `bios-agent` ⇒ 不注入 ⇒ 回到普通 Pi；
 * - 不"只复制一个入口 TS"：入口的相对依赖（`core/**`）必须一起分发。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// `builtInExtensions.ts` 依赖 `./builtInExtensionsManifest`（无扩展名相对导入）：
// 与既有 builtInExtensions.test.mjs 一样走 loadTsCommonJs，Node 直跑时才能解析依赖图。
const { BIOS_AGENT_PACKAGE_SOURCE, listActiveBuiltInExtensionPaths, resolveBiosAgentPackageDir, resolveBiosAgentPackageEntry } = loadTsCommonJs("src/main/extensions/builtInExtensions.ts");

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_DIR = join(REPO_ROOT, "packages", "bios-agent");
const devRoots = { appPath: REPO_ROOT, resourcesPath: join(REPO_ROOT, "release", "win-unpacked", "resources"), isDev: true };

/**
 * 简易 glob（`**` 跨目录、`*` 不跨目录），与 electron-builder/minimatch 的 filter 语义一致。
 *
 * 先用占位符替换 `**` 系列，再做正则转义：直接对已转义的 `\*\*` 做字符串替换会漏改，
 * 让 `core/**\/*.ts` 匹配不到嵌套目录（本测试第一次跑就因此漏掉了 `core/storage/journal`）。
 */
function matchGlob(glob, relativePath) {
	const GLOBSTAR_SLASH = "\u0000";
	const GLOBSTAR = "\u0001";
	const pattern = glob
		.replaceAll("\\", "/")
		.replaceAll("**/", GLOBSTAR_SLASH)
		.replaceAll("**", GLOBSTAR)
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("*", "[^/]*")
		.replaceAll(GLOBSTAR_SLASH, "(?:.*/)?")
		.replaceAll(GLOBSTAR, ".*");
	return new RegExp(`^${pattern}$`).test(relativePath.replaceAll("\\", "/"));
}

test("C3：开发态整包分发 —— 入口与依赖模块都在，注入的是**包目录**而不是单个文件", () => {
	assert.equal(existsSync(resolveBiosAgentPackageEntry(devRoots)), true, "包入口 extensions/index.ts 必须存在");
	const packageDir = resolveBiosAgentPackageDir(devRoots);
	assert.equal(packageDir, PACKAGE_DIR);

	const paths = listActiveBuiltInExtensionPaths(devRoots, []);
	assert.ok(paths.includes(packageDir), `整包目录必须参与注入：${paths.join(", ")}`);
	assert.equal(paths.includes(resolveBiosAgentPackageEntry(devRoots)), false, "注入包目录（pi 按包加载），不注入入口文件");

	// 不只一个入口 TS：core 下的契约/存储/项目等模块必须随包（entry 的相对 import 依赖它们）。
	const coreFiles = ["core/storage/index.ts", "core/projects/index.ts", "core/context/index.ts"];
	for (const file of coreFiles) assert.equal(existsSync(join(PACKAGE_DIR, file)), true, `${file} 必须随包分发`);
	assert.equal(existsSync(join(PACKAGE_DIR, "skills")), true, "Skills 目录必须随包（pi.skills 清单指向它）");
});

test("C3：禁用链 —— 移除 bios-agent 后不再注入（回到普通 Pi），其余内置不受影响", () => {
	const withPackage = listActiveBuiltInExtensionPaths(devRoots, []);
	const without = listActiveBuiltInExtensionPaths(devRoots, [BIOS_AGENT_PACKAGE_SOURCE]);
	assert.equal(without.includes(resolveBiosAgentPackageDir(devRoots)), false, "禁用后不得注入专业包");
	assert.equal(without.length, withPackage.length - 1, "只少掉专业包这一条");
	// 其它内置扩展仍然在（禁用是逐条的，不是整批关掉）。
	assert.ok(without.length >= 10, `普通内置扩展必须保留：${without.length}`);
});

test("C3：打包态按 resources/bios-agent 解析；入口缺失（半截分发）就不注入", () => {
	const sandbox = mkdtempSync(join(tmpdir(), "bios-pack-"));
	const resourcesPath = join(sandbox, "resources");
	const packagedRoots = { appPath: sandbox, resourcesPath, isDev: false };
	try {
		assert.equal(resolveBiosAgentPackageDir(packagedRoots), join(resourcesPath, BIOS_AGENT_PACKAGE_SOURCE));
		// 半截分发：只有入口、没有 core/skills ⇒ 入口在就仍会注入（由下面的 filter 测试保证不会半截）。
		mkdirSync(join(resourcesPath, "bios-agent", "extensions"), { recursive: true });
		writeFileSync(join(resourcesPath, "bios-agent", "extensions", "index.ts"), "export {};\n", "utf8");
		assert.ok(listActiveBuiltInExtensionPaths(packagedRoots, []).includes(join(resourcesPath, "bios-agent")), "有入口即注入");
		rmSync(join(resourcesPath, "bios-agent"), { recursive: true, force: true });
		assert.equal(listActiveBuiltInExtensionPaths(packagedRoots, []).includes(join(resourcesPath, "bios-agent")), false, "没有入口不得注入");
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

test("C3：按 filter 复制到隔离目录后，脱离源码目录仍能加载扩展与 Skills", async () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const filters = (manifest.build?.extraResources ?? []).find((item) => item.to === BIOS_AGENT_PACKAGE_SOURCE)?.filter ?? [];
	const sandbox = mkdtempSync(join(tmpdir(), "bios-pack-load-"));
	const staged = join(sandbox, "resources", BIOS_AGENT_PACKAGE_SOURCE);
	try {
		// 按 electron-builder 的 filter 语义把"会进包的文件"复制过去（隔离目录，不动源码）。
		const copyIfShipped = (relativePath) => {
			if (!filters.some((glob) => matchGlob(glob, relativePath))) return;
			const source = join(PACKAGE_DIR, relativePath);
			if (!existsSync(source)) return;
			const target = join(staged, relativePath);
			mkdirSync(join(target, ".."), { recursive: true });
			writeFileSync(target, readFileSync(source));
		};
		for (const relativePath of listPackageFiles()) copyIfShipped(relativePath);

		const entry = join(staged, "extensions", "index.ts");
		assert.equal(existsSync(entry), true, "隔离目录里必须有入口");
		assert.equal(existsSync(join(staged, "core", "storage", "index.ts")), true, "隔离目录里必须有依赖模块");
		assert.equal(existsSync(join(staged, "tests")), false, "tests 不得进包");

		// 用真实 Pi 宿主加载隔离目录里的包：证明"只复制入口"不够、整包才加载得起来。
		const { PI_MODULE_ENTRY, HOST_MISSING_MESSAGE } = await import("../packages/bios-agent/tests/helpers/biosExtension.mjs");
		assert.ok(PI_MODULE_ENTRY, HOST_MISSING_MESSAGE);
		const pi = await import(`file:///${PI_MODULE_ENTRY.replaceAll("\\", "/")}`);
		const agentDir = join(sandbox, "agent");
		mkdirSync(agentDir, { recursive: true });
		const loaded = await pi.discoverAndLoadExtensions([entry], staged, agentDir);
		assert.deepEqual(loaded.errors, [], `隔离包必须能加载：${JSON.stringify(loaded.errors)}`);
		assert.equal(loaded.extensions.length, 1);
		const tools = [...loaded.extensions[0].tools.keys()];
		assert.ok(tools.includes("bios_get_task"), `专业工具必须在隔离包里注册：${tools.join(", ")}`);
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});

/** 包内所有文件（相对包目录，POSIX 分隔）；用于按 filter 复制。 */
function listPackageFiles() {
	const out = [];
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === "node_modules") continue;
			const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
			else out.push(relativePath);
		}
	};
	walk(PACKAGE_DIR, "");
	return out;
}

test("C3：electron-builder filter 覆盖整包运行内容，且不带 tests/node_modules", () => {
	const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
	const entry = (manifest.build?.extraResources ?? []).find((item) => item.to === BIOS_AGENT_PACKAGE_SOURCE);
	assert.ok(entry !== undefined, "package.json 必须有 bios-agent 的 extraResources 项");
	assert.equal(entry.from, "packages/bios-agent");
	const filters = entry.filter ?? [];
	assert.equal(filters.includes("**/*"), false, "不得整目录照搬（会把 tests/node_modules 带进包）");

	// filter 必须能命中入口、依赖模块、Skills 与包元数据。
	const required = ["package.json", "extensions/index.ts", "core/storage/index.ts", "core/contracts/records.ts", "skills"];
	for (const relativePath of required) {
		assert.ok(
			filters.some((glob) => matchGlob(glob, relativePath) || (relativePath.startsWith("skills") && matchGlob(glob, "skills/anything/SKILL.md"))),
			`filter 必须包含 ${relativePath}：${JSON.stringify(filters)}`,
		);
	}
	// 反向：测试与开发依赖不得进包。
	for (const excluded of ["tests/r33History.test.mjs", "node_modules/.bin/tsc", "docs/x.md"]) {
		assert.equal(
			filters.some((glob) => matchGlob(glob, excluded)),
			false,
			`${excluded} 不应进包`,
		);
	}

	// 真实文件形态核对：入口 + core 模块都能在磁盘上找到（不是"只复制一个入口"）。
	const shipped = ["extensions/index.ts", "core/storage/index.ts"];
	for (const relativePath of shipped) {
		assert.equal(existsSync(join(PACKAGE_DIR, relativePath)), true, `${relativePath} 必须真实存在`);
		assert.ok(
			filters.some((glob) => matchGlob(glob, relativePath)),
			`${relativePath} 必须被 filter 命中`,
		);
		assert.ok(!relativePath.includes(`..${sep}`), "过滤路径必须是包内相对路径");
		assert.ok(relative(REPO_ROOT, join(PACKAGE_DIR, relativePath)).startsWith(`packages${sep}bios-agent`), "资源来源在仓库包目录内");
	}
});
