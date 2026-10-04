/**
 * BM-03 测试夹具：**自建临时知识根 + 合成工作区**。
 *
 * 纪律：
 * - 只写操作系统临时目录下的合成内容，不读任何真实知识库或客户源码；
 * - 合成的是**通用 EDK II 形状**（`[Defines] PLATFORM_NAME`），不是某家客户的真实树；
 * - 提供独立观察手段（直接读文件字节、独立算 SHA-256），
 *   断言不能只依赖产品自己的 helper 互证。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export const PACKAGE_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** 合成知识根 + 两个合成工作区。 */
export async function createProjectSandbox(prefix = "bm03-") {
	const base = await mkdtemp(join(tmpdir(), prefix));
	const root = join(base, "knowledge");
	const workspaceA = join(base, "ws-a");
	const workspaceB = join(base, "ws-b");
	await mkdir(workspaceA, { recursive: true });
	await mkdir(workspaceB, { recursive: true });
	return { base, root, workspaceA, workspaceB, cleanup: () => rm(base, { recursive: true, force: true }) };
}

/** 合成一个 EDK II 形状的 DSC（只有通用字段，没有客户信息）。 */
export async function writeDsc(dir, relativePath, options = {}) {
	const platformName = options.platformName ?? "SamplePlatform";
	const extra = options.extra ?? [];
	const lines = ["# synthetic EDK II platform description", "[Defines]", `  PLATFORM_NAME = ${platformName}`, "  SUPPORTED_ARCHITECTURES = X64", "", ...(options.include ? [`!include ${options.include}`, ""] : []), "[Components]", ...extra, "  SamplePkg/Sample.inf", ""];
	const absolute = join(dir, relativePath);
	await mkdir(join(absolute, ".."), { recursive: true });
	await writeFile(absolute, lines.join("\n"));
	return absolute;
}

export async function writeDec(dir, relativePath, packageName = "SamplePkg") {
	const absolute = join(dir, relativePath);
	await mkdir(join(absolute, ".."), { recursive: true });
	await writeFile(absolute, ["[Defines]", `  PACKAGE_NAME = ${packageName}`, ""].join("\n"));
	return absolute;
}

/** 独立计算文件字节的 SHA-256（不调用产品代码）。 */
export async function fileHash(path) {
	return createHash("sha256")
		.update(await readFile(path))
		.digest("hex");
}

export async function readJsonFile(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

/** 直接读磁盘上的档案文件（独立观察产品写入结果，不经过产品读取 API）。 */
export async function readProfileFile(root, projectId) {
	return readJsonFile(join(root, "projects", projectId, "profile.json"));
}

export async function readRegistryFile(root) {
	return readJsonFile(join(root, "registry.json"));
}

/* ------------------------------------------------------------------ Git 夹具 */

let gitAvailability;
export function gitAvailable() {
	if (gitAvailability !== undefined) return gitAvailability;
	try {
		execFileSync("git", ["--version"], { stdio: "pipe" });
		gitAvailability = true;
	} catch {
		gitAvailability = false;
	}
	return gitAvailability;
}

/** 固定 argv、无 shell 的 git 调用（与产品实现同一纪律，避免测试自身引入变量）。 */
export function git(dir, args) {
	return execFileSync("git", ["-C", dir, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			// 不写任何仓库/全局配置：身份只通过本次进程的环境变量给出。
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_TERMINAL_PROMPT: "0",
		},
	});
}

/** 初始化一个真实 Git 仓库并提交一次。 */
export async function initGitRepo(dir, message = "init") {
	git(dir, ["init", "-q"]);
	git(dir, ["add", "-A"]);
	git(dir, ["commit", "-q", "-m", message]);
	return { branch: git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), head: git(dir, ["rev-parse", "HEAD"]).trim() };
}

export function hasPath(path) {
	return existsSync(path);
}
