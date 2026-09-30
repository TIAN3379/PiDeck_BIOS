import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// runtimeNodeInstall 依赖 DshRuntimeManager（sha256OfFile / IO 类型），后者 import electron
// 仅用于常量与类型；测试里给最小替身即可加载。
const { installPiRuntimeNode, detectPiRuntimeNode, piRuntimeNodeExePath, piRuntimeRootDir, probeNodeVersion } = loadTsCommonJs("src/main/pi/runtimeNodeInstall.ts", {
	stubs: { electron: { app: {} } },
});
const { PI_RUNTIME_NODE_VERSION, PI_RUNTIME_NODE_SHA256, piRuntimeNodeArchiveName, piRuntimeNodeDownloadUrls, piRuntimeNodeInnerDir, officialPiRuntimeNodeUrl, toPiRuntimePlatform, toPiRuntimeArch } = loadTsCommonJs("src/shared/types/piRuntimeNode.ts");

const EXPECTED_VERSION = `v${PI_RUNTIME_NODE_VERSION}`;

/**
 * 测试替身：解压出内层目录 + node.exe。
 * probeVersion 模拟真实语义：「文件存在且可执行才返回版本」——与真实 probeNodeVersion
 * 对缺失路径返回 undefined 的行为对齐。否则安装器的幂等短路分支（existing 检查）
 * 会误命中，download/extract 永远不会被执行。
 */
function fakeDeps({ probeVersion } = {}) {
	return {
		deps: {
			download: async (_url, destPath) => {
				await mkdir(join(destPath, ".."), { recursive: true });
				await writeFile(destPath, "archive-bytes");
			},
			extract: async (_zip, destDir) => {
				const dest = join(destDir, piRuntimeNodeInnerDir("win32", "x64"));
				await mkdir(dest, { recursive: true });
				await writeFile(join(dest, "node.exe"), "node-bin");
				return destDir;
			},
		},
		// 默认 probe：exe 已写入 userData 才成功（替身无法真的执行 node.exe）
		probeVersion: probeVersion ?? (async (nodePath) => (existsSync(nodePath) ? EXPECTED_VERSION : undefined)),
	};
}

test("契约：版本、哈希表、镜像回退链与 URL 拼接", () => {
	assert.equal(PI_RUNTIME_NODE_VERSION, "24.13.0");
	// 六个平台-架构组合都必须有固化哈希，缺一个就是引导链路里的硬失败
	for (const key of ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]) {
		assert.match(PI_RUNTIME_NODE_SHA256[key], /^[0-9a-f]{64}$/, `sha256 for ${key}`);
	}
	// Windows 是 zip，其余是 tar.gz，命名与 nodejs.org/dist 一致
	assert.equal(piRuntimeNodeArchiveName("win32", "x64"), "node-v24.13.0-win-x64.zip");
	assert.equal(piRuntimeNodeArchiveName("darwin", "arm64"), "node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(piRuntimeNodeInnerDir("win32", "x64"), "node-v24.13.0-win-x64");
	// 回退链：npmmirror → 自有 Release（win32 才有）→ 华为云 → 官方（国内网络优先）。
	// 逐元素断言：vm 沙箱跨 realm 下 deepEqual 比较原型会误报。
	const urls = piRuntimeNodeDownloadUrls("win32", "x64");
	assert.equal(urls.length, 5);
	assert.equal(urls[0], "https://npmmirror.com/mirrors/node/v24.13.0/node-v24.13.0-win-x64.zip");
	// 自有 Release 资产：与 DSH runner node 共用同一份官方完整 zip（sha256 与官方一致）
	assert.equal(urls[1], "https://atomgit.com/TIAN3379/PiDeck_BIOS/releases/download/latest/node-v24.13.0-win-x64.zip");
	assert.equal(urls[2], "https://github.com/TIAN3379/PiDeck_BIOS/releases/latest/download/node-v24.13.0-win-x64.zip");
	assert.equal(urls[3], "https://mirrors.huaweicloud.com/nodejs/v24.13.0/node-v24.13.0-win-x64.zip");
	assert.equal(urls[4], officialPiRuntimeNodeUrl("win32", "x64"));
	// 非 Windows：Release 上没有对应资产，回退链不含自有源
	const darwinUrls = piRuntimeNodeDownloadUrls("darwin", "arm64");
	assert.equal(darwinUrls.length, 3);
	assert.equal(darwinUrls[0], "https://npmmirror.com/mirrors/node/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(darwinUrls[1], "https://mirrors.huaweicloud.com/nodejs/v24.13.0/node-v24.13.0-darwin-arm64.tar.gz");
	assert.equal(darwinUrls[2], officialPiRuntimeNodeUrl("darwin", "arm64"));
	assert.match(officialPiRuntimeNodeUrl("linux", "x64"), /nodejs\.org\/dist/);
	// 平台白名单：认识的返回原值，不认识的一律 null（引导入口不支持）
	assert.equal(toPiRuntimePlatform("win32"), "win32");
	assert.equal(toPiRuntimePlatform("freebsd"), null);
	assert.equal(toPiRuntimeArch("x64"), "x64");
	assert.equal(toPiRuntimeArch("ia32"), null);
});

test("installPiRuntimeNode：不认识的平台直接拒绝，不下载不写盘", async () => {
	let downloaded = false;
	const result = await installPiRuntimeNode(
		{ userDataPath: "C:\\should-not-write", platform: "freebsd", arch: "x64" },
		{
			download: async () => {
				downloaded = true;
			},
			extract: async () => {
				throw new Error("should not extract");
			},
		},
	);
	assert.equal(result.ok, false);
	assert.match(result.error ?? "", /unsupported platform/);
	assert.equal(downloaded, false);
});

test("installPiRuntimeNode：镜像失败自动回退下一个源，最终成功并落盘 userData", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const attempted = [];
		const bytes = "archive-bytes";
		const { deps, probeVersion } = fakeDeps();
		const originalDownload = deps.download;
		deps.download = async (url, destPath) => {
			attempted.push(url);
			// 前 4 个源（npmmirror/AtomGit/GitHub/华为云）都模拟网络不可达，官方源成功
			if (attempted.length < 5) throw new Error("network unreachable");
			await originalDownload(url, destPath);
		};
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				probeVersion,
				// 用本地内容哈希做「官方归档校验通过」的替身（固化值不可能伪造本地内容）
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			deps,
		);
		assert.equal(result.ok, true, result.error);
		assert.equal(attempted.length, 5, "should try all 5 mirrors");
		assert.match(attempted[0], /npmmirror\.com/);
		assert.match(attempted[1], /atomgit\.com/);
		assert.match(attempted[2], /github\.com/);
		assert.match(attempted[3], /huaweicloud\.com/);
		assert.match(attempted[4], /nodejs\.org/);
		assert.equal(result.path, piRuntimeNodeExePath(root, "win32"));
		assert.equal(result.version, EXPECTED_VERSION);
		assert.equal(result.source, "download");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：sha256 不匹配时拒绝解压并换下一个源", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		let extractCalled = 0;
		let downloads = 0;
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				// 版本探测不应被走到（校验先失败）；真被走到说明防线失守。
				// 返回 undefined 对齐真实 probeNodeVersion 对缺失文件的行为，
				// 避免无状态替身误命中幂等 existing 分支。
				probeVersion: async () => undefined,
			},
			{
				download: async (_url, destPath) => {
					downloads += 1;
					await mkdir(join(destPath, ".."), { recursive: true });
					await writeFile(destPath, "tampered-bytes");
				},
				extract: async () => {
					extractCalled += 1;
					return tmpdir();
				},
			},
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /sha256 mismatch/);
		assert.equal(extractCalled, 0, "tampered archives must never be extracted");
		assert.equal(downloads, 5, "all mirrors must be tried before giving up");
		// 失败后不得在 userData 留下半截安装
		assert.equal(existsSync(piRuntimeNodeExePath(root, "win32")), false);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：版本探测不通过视为失败（半截安装防线）", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		// 解压产物存在但 node.exe 跑不起来（probe 返回 undefined）：
		// 对应真实场景「杀软拦截/下载中断导致文件在但不可执行」。
		const bytes = "archive-bytes";
		const { deps } = fakeDeps({ probeVersion: async () => undefined });
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			deps,
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /not executable/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：主版本不匹配视为失败（防御性校验）", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const bytes = "archive-bytes";
		const fake = fakeDeps({
			// probe 模拟「文件已存在时返回错误大版本」：existing 检查在下载前，
			// 无条件返回 v25.0.0 会误命中幂等分支 —— 必须与文件存在性绑定。
			probeVersion: async (nodePath) => (existsSync(nodePath) ? "v25.0.0" : undefined),
		});
		const result = await installPiRuntimeNode(
			{
				userDataPath: root,
				platform: "win32",
				arch: "x64",
				probeVersion: fake.probeVersion,
				expectedSha256: createHash("sha256").update(bytes).digest("hex"),
			},
			fake.deps,
		);
		assert.equal(result.ok, false);
		assert.match(result.error ?? "", /unexpected node version/);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("installPiRuntimeNode：已有可用副本时幂等返回，不重新下载", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		// 预置一个真的 exe 文件（幂等分支的判定是「文件存在且 probe 成功」，
		// 但 fakeDeps 默认 probe 也要求文件存在，所以这里用无条件成功的替身）
		const exePath = piRuntimeNodeExePath(root, "win32");
		await mkdir(join(exePath, ".."), { recursive: true });
		await writeFile(exePath, "node-bin");
		const result = await installPiRuntimeNode(
			{ userDataPath: root, platform: "win32", arch: "x64", probeVersion: async () => EXPECTED_VERSION },
			{
				download: async () => {
					throw new Error("should not download when copy already usable");
				},
				extract: async () => {
					throw new Error("should not extract when copy already usable");
				},
			},
		);
		assert.equal(result.ok, true, result.error);
		assert.equal(result.source, "existing");
		assert.equal(result.path, exePath);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("probeNodeVersion：不可执行路径返回 undefined 而不是抛错", async () => {
	// 目录不是可执行文件，execFile 必然失败；正确行为是返回 undefined。
	const result = await probeNodeVersion(tmpdir());
	assert.equal(result, undefined);
});

test("detectPiRuntimeNode：无副本时 installed=false 且透传系统 node 状态", async () => {
	const root = await mkdtemp(join(tmpdir(), "pideck-runtime-node-"));
	try {
		const status = await detectPiRuntimeNode(root, "v22.0.0", "win32");
		assert.equal(status.installed, false);
		assert.equal(status.systemNodeAvailable, true);
		assert.equal(status.systemNodeVersion, "v22.0.0");
		assert.equal(status.installSupported, true);
		// 安装目录约定：<userData>/pi-runtime/node/
		assert.ok(piRuntimeRootDir(root).endsWith(join("pi-runtime")));
		assert.ok(piRuntimeNodeExePath(root, "win32").endsWith(join("pi-runtime", "node", "node.exe")));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("IPC / preload 三处同步注册 pi 环境引导通道", () => {
	const ipc = readFileSync("src/shared/ipc.ts", "utf8");
	const systemIpc = readFileSync("src/main/ipc/systemIpc.ts", "utf8");
	const preload = readFileSync("src/preload/index.ts", "utf8");
	// 通道常量 + 主进程 handler + preload 暴露必须三处齐全（漏一处 = 运行时 undefined）
	assert.match(ipc, /piRuntimeNodeCheck:\s*"pi:runtime-node-check"/);
	assert.match(ipc, /piRuntimeNodeInstall:\s*"pi:runtime-node-install"/);
	assert.match(ipc, /piRuntimePiInstall:\s*"pi:runtime-pi-install"/);
	assert.match(systemIpc, /ipcChannels\.piRuntimeNodeCheck/);
	assert.match(systemIpc, /ipcChannels\.piRuntimeNodeInstall/);
	assert.match(systemIpc, /ipcChannels\.piRuntimePiInstall/);
	assert.match(systemIpc, /installPiRuntimeNode/);
	assert.match(preload, /runtimeNodeCheck:\s*\(\)\s*=>/);
	assert.match(preload, /runtimeNodeInstall:\s*\(\)\s*=>/);
	assert.match(preload, /runtimePiInstall:\s*\(useMirror:\s*boolean\)/);
	// 收紧通道断言：pi 安装只接受镜像布尔意图，不再让渲染层传任意命令字符串
	const body = preload.match(/runtimePiInstall:[\s\S]{0,220}/)?.[0] ?? "";
	assert.match(body, /useMirror === true/);
});

test("安装器复用通用归档 IO，index.ts 装配真实下载/解压实现", () => {
	const installer = readFileSync("src/main/pi/runtimeNodeInstall.ts", "utf8");
	assert.match(installer, /from "\.\.\/runtime\/archiveIo"/);
	const index = readFileSync("src/main/index.ts", "utf8");
	assert.match(index, /piRuntimeNodeInstaller:\s*\{/);
	assert.match(index, /createNetDownloader/);
	assert.match(index, /createTarExtractor/);
});
