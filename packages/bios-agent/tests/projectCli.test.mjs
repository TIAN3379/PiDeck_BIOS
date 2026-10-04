/**
 * R28-4 后的 `cli/project.mjs` 子进程回归。
 *
 * 断言的是"外面看得见的行为"：退出码、stdout 恰好一个带 `code`/`exitCode` 的 JSON 对象、
 * 参数白名单（未知/拼错/重复在任何 IO 之前拒绝）、写确认、越权拒绝，
 * 以及**被拒绝时知识库真的没变**。
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeKnowledgeStore } from "../core/storage/index.ts";
import { createProjectSandbox, writeDsc } from "./helpers/projectFixtures.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PACKAGE_ROOT, "cli", "project.mjs");
const NOW = 1_700_000_000_000;

function runCli(args) {
	try {
		const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		return { code: typeof error.status === "number" ? error.status : 1, stdout: typeof error.stdout === "string" ? error.stdout : "", stderr: typeof error.stderr === "string" ? error.stderr : "" };
	}
}

/** 同时启动两个**真实子进程**（跨进程竞争用）。 */
function spawnCli(args) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [CLI, ...args], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
	});
}

/** `--json` 时 stdout 必须恰好是一个可解析对象（不夹带其它输出）。 */
function parseSingleJson(text) {
	const trimmed = text.trim();
	assert.notEqual(trimmed, "", "stdout 不能为空");
	const parsed = JSON.parse(trimmed);
	assert.equal(Array.isArray(parsed), false);
	assert.equal(typeof parsed, "object");
	return parsed;
}

async function sandboxWithStore() {
	const sandbox = await createProjectSandbox("bm03-cli-");
	await mkdir(sandbox.workspaceA, { recursive: true });
	await writeDsc(sandbox.workspaceA, "Platform/SamplePkg/Sample.dsc", { platformName: "SamplePlatform" });
	await initializeKnowledgeStore({ root: sandbox.root, now: NOW });
	return sandbox;
}

async function readJson(path) {
	return JSON.parse(await readFile(path, "utf8"));
}

test("CLI：help 与未知命令；命令与选项顺序无关；超长参数有界", () => {
	const help = runCli(["help"]);
	assert.equal(help.code, 0);
	assert.match(help.stdout, /用法：node cli\/project\.mjs/);
	assert.match(help.stdout, /exit 8|退出码/, "帮助必须写出退出码含义");

	const helpJson = runCli(["help", "--json"]);
	assert.equal(helpJson.code, 0);
	const helpPayload = parseSingleJson(helpJson.stdout);
	assert.equal(helpPayload.code, "ok");
	assert.equal(helpPayload.exitCode, 0);

	const unknown = runCli(["deploy", "--json"]);
	assert.equal(unknown.code, 2);
	const payload = parseSingleJson(unknown.stdout);
	assert.equal(payload.status, "error");
	assert.equal(payload.code, "invalid-argument");
	assert.equal(payload.exitCode, 2);

	assert.equal(runCli(["--json", "help"]).code, 0, "命令与选项顺序无关");

	const huge = "x".repeat(5_000);
	const noisy = runCli([huge, "--json"]);
	assert.equal(noisy.code, 2);
	assert.ok(noisy.stdout.length < 1_000, `输出必须被截断，实际 ${noisy.stdout.length} 字节`);
	assert.equal(noisy.stdout.includes(huge), false);
});

test("CLI：参数白名单——未知/拼错/重复/越界整数在任何 IO 之前拒绝", async () => {
	const sandbox = await sandboxWithStore();
	try {
		const base = ["--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--json"];

		// 拼错的复验选项必须报错，而不是"照常读库"。
		const typo = runCli(["read", ...base, "--workspace", sandbox.workspaceA, "--verify-evidnce"]);
		assert.equal(typo.code, 2);
		assert.equal(parseSingleJson(typo.stdout).code, "invalid-argument");

		// 不属于该命令的选项（open 不接受 --write）。
		assert.equal(runCli(["open", ...base, "--write"]).code, 2);
		// 单值选项重复出现。
		const duplicated = runCli(["open", "--root", sandbox.root, "--root", sandbox.root, "--cwd", sandbox.workspaceA, "--json"]);
		assert.equal(duplicated.code, 2);
		// 安全整数越界与非法形态。
		assert.equal(runCli(["confirm", ...base, "--project-id", "11111111-1111-4111-8111-111111111111", "--revision", "1e30", "--set", "boardName=X", "--write"]).code, 2);
		assert.equal(runCli(["refresh", ...base, "--project-id", "11111111-1111-4111-8111-111111111111", "--workspace-id", "22222222-2222-4222-8222-222222222222", "--revision", "-1", "--write"]).code, 2);

		// 写命令带未知选项时**不得写入**：先 bind 建立基线，再确认失败后比对原字节。
		const bound = parseSingleJson(runCli(["bind", ...base, "--workspace", sandbox.workspaceA, "--write"]).stdout);
		const opened = parseSingleJson(runCli(["open", ...base, "--workspace", sandbox.workspaceA]).stdout);
		const profilePath = join(sandbox.root, "projects", bound.projectId, "profile.json");
		const before = await readFile(profilePath, "utf8");
		const rejected = runCli(["confirm", ...base, "--project-id", bound.projectId, "--revision", String(opened.profileRevision), "--set", "boardName=Hijack", "--unknown-option", "--write"]);
		assert.equal(rejected.code, 2);
		assert.equal(await readFile(profilePath, "utf8"), before, "参数非法时不得写入任何内容");
	} finally {
		await sandbox.cleanup();
	}
});

test("CLI：缺少必填 --root 时拒绝；missing 不误报成功", async () => {
	const missing = runCli(["open", "--json"]);
	assert.equal(missing.code, 2);
	assert.match(parseSingleJson(missing.stdout).message, /--root/);

	const sandbox = await createProjectSandbox("bm03-cli-");
	try {
		const result = runCli(["open", "--root", join(sandbox.base, "no-store"), "--cwd", sandbox.workspaceA, "--json"]);
		assert.equal(result.code, 6, "missing 必须用退出码表达（不是 0）");
		const payload = parseSingleJson(result.stdout);
		assert.equal(payload.status, "missing");
		assert.equal(payload.code, "missing");
		assert.equal(payload.exitCode, 6);
		assert.equal(payload.usable, false);
	} finally {
		await sandbox.cleanup();
	}
});

test("CLI：未确认写入被拒绝，且知识库完全没变", async () => {
	const sandbox = await sandboxWithStore();
	try {
		const base = ["--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--json"];

		const refused = runCli(["bind", ...base, "--workspace", sandbox.workspaceA]);
		assert.equal(refused.code, 3);
		const payload = parseSingleJson(refused.stdout);
		assert.equal(payload.code, "write-not-confirmed");
		assert.equal(payload.exitCode, 3);
		assert.ok(Array.isArray(payload.wouldDo) && payload.wouldDo.length > 0, "必须说明【本来会做什么】");
		const registry = await readJson(join(sandbox.root, "registry.json"));
		assert.equal(registry.projects.length, 0, "被拒绝的写入不得改动 registry");
		assert.equal(registry.revision, 0);

		const bound = runCli(["bind", ...base, "--workspace", sandbox.workspaceA, "--write"]);
		assert.equal(bound.code, 0);
		const boundPayload = parseSingleJson(bound.stdout);
		assert.equal(boundPayload.status, "bound");
		assert.equal(boundPayload.code, "ok");
		assert.equal(boundPayload.exitCode, 0);
		assert.equal(boundPayload.steps.filter((step) => step.status === "published").length, 2);
		assert.deepEqual(boundPayload.needsReview, [], "正常写入不应有需要核对的事实");
		assert.equal((await readJson(join(sandbox.root, "registry.json"))).projects.length, 1);

		// 越权路径：exit 3 且 registry 不变。
		const outside = runCli(["bind", ...base, "--workspace", sandbox.base, "--write"]);
		assert.equal(outside.code, 3);
		assert.equal(parseSingleJson(outside.stdout).code, "not-authorized");
		assert.equal((await readJson(join(sandbox.root, "registry.json"))).projects.length, 1);

		// 越权 detect/open：入档的工作区路径不在本次授权范围内 ⇒ 拒绝（不是"空候选"）。
		// 注意 cwd 必须是一个**不包含**工作区的目录（父目录天然授权其子目录）。
		const elsewhere = join(sandbox.base, "elsewhere");
		await mkdir(elsewhere, { recursive: true });
		const narrowed = runCli(["detect", "--root", sandbox.root, "--cwd", elsewhere, "--workspace", sandbox.workspaceA, "--json"]);
		assert.equal(narrowed.code, 3);
		assert.equal(parseSingleJson(narrowed.stdout).code, "not-authorized");
		const reopened = runCli(["open", "--root", sandbox.root, "--cwd", elsewhere, "--workspace", sandbox.workspaceA, "--json"]);
		assert.equal(reopened.code, 3);
		assert.equal(parseSingleJson(reopened.stdout).code, "not-authorized");
	} finally {
		await sandbox.cleanup();
	}
});

test("CLI：confirm 的 CAS 冲突用退出码 4 表达，refresh 需要写确认", async () => {
	const sandbox = await sandboxWithStore();
	try {
		const base = ["--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--json"];
		const bound = parseSingleJson(runCli(["bind", ...base, "--workspace", sandbox.workspaceA, "--write"]).stdout);
		const opened = parseSingleJson(runCli(["open", ...base, "--workspace", sandbox.workspaceA]).stdout);
		const projectId = bound.projectId;
		const workspaceId = bound.workspaceId;

		const noWrite = runCli(["confirm", ...base, "--project-id", projectId, "--revision", String(opened.profileRevision), "--set", "boardName=BoardCli"]);
		assert.equal(noWrite.code, 3);
		assert.equal(parseSingleJson(noWrite.stdout).code, "write-not-confirmed");

		const badField = runCli(["confirm", ...base, "--project-id", projectId, "--revision", String(opened.profileRevision), "--set", "notAField=x", "--write"]);
		assert.equal(badField.code, 2);
		assert.equal(parseSingleJson(badField.stdout).detail, "unknown-field");

		const ok = runCli(["confirm", ...base, "--project-id", projectId, "--workspace-id", workspaceId, "--revision", String(opened.profileRevision), "--set", "boardName=BoardCli", "--operator", "cli-test", "--write"]);
		assert.equal(ok.code, 0, ok.stderr);
		const okPayload = parseSingleJson(ok.stdout);
		assert.equal(okPayload.status, "confirmed");
		assert.equal(okPayload.code, "ok");
		assert.equal(okPayload.revision, opened.profileRevision + 1);

		const conflict = runCli(["confirm", ...base, "--project-id", projectId, "--revision", String(opened.profileRevision), "--set", "boardName=Hijack", "--write"]);
		assert.equal(conflict.code, 4);
		const conflictPayload = parseSingleJson(conflict.stdout);
		assert.equal(conflictPayload.code, "revision-conflict");
		assert.equal(conflictPayload.exitCode, 4);
		assert.equal(conflictPayload.actualRevision, opened.profileRevision + 1);

		const refreshRefused = runCli(["refresh", ...base, "--project-id", projectId, "--workspace-id", workspaceId, "--revision", String(opened.profileRevision + 1)]);
		assert.equal(refreshRefused.code, 3);

		const stored = await readJson(join(sandbox.root, "projects", projectId, "profile.json"));
		assert.equal(stored.identity.boardName.value, "BoardCli");
	} finally {
		await sandbox.cleanup();
	}
});

test("CLI：两个真实子进程用同一 revision 竞争确认——一成一败且无覆盖", async () => {
	const sandbox = await sandboxWithStore();
	try {
		const base = ["--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--json"];
		const bound = parseSingleJson(runCli(["bind", ...base, "--workspace", sandbox.workspaceA, "--write"]).stdout);
		const opened = parseSingleJson(runCli(["open", ...base, "--workspace", sandbox.workspaceA]).stdout);
		const revision = String(opened.profileRevision);

		// 两个独立进程、同一个 expectedProfileRevision：CAS 必须只让一个成功。
		const [left, right] = await Promise.all([spawnCli(["confirm", ...base, "--project-id", bound.projectId, "--revision", revision, "--set", "boardName=Winner-A", "--write"]), spawnCli(["confirm", ...base, "--project-id", bound.projectId, "--revision", revision, "--set", "boardName=Winner-B", "--write"])]);
		const codes = [left.code, right.code].sort((a, b) => a - b);
		assert.deepEqual(codes, [0, 4], `必须一成一败（实际 ${JSON.stringify(codes)}：${left.stdout} ${right.stdout}`);

		const stored = await readJson(join(sandbox.root, "projects", bound.projectId, "profile.json"));
		assert.equal(stored.revision, opened.profileRevision + 1, "只允许一次递增");
		assert.match(stored.identity.boardName.value, /^Winner-[AB]$/, "胜者的值必须完整写下去（不是半截）");
		const winner = stored.identity.boardName.value;
		const loser = winner === "Winner-A" ? "Winner-B" : "Winner-A";
		assert.notEqual(loser, winner);
		// 失败方不能留下任何痕迹：整份档案里不出现它的值。
		const whole = await readFile(join(sandbox.root, "projects", bound.projectId, "profile.json"), "utf8");
		assert.equal(whole.includes(loser), false, "失败方不得留下半截写入");
	} finally {
		await sandbox.cleanup();
	}
});

test("CLI：read 输出结构化视图；未就绪/预算不足用退出码表达", async () => {
	const sandbox = await sandboxWithStore();
	try {
		const base = ["--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--json"];

		// 尚未绑定 ⇒ missing（不是"空结论"）。
		const unbound = runCli(["read", ...base, "--workspace", sandbox.workspaceA]);
		assert.equal(unbound.code, 6);
		const unboundPayload = parseSingleJson(unbound.stdout);
		assert.equal(unboundPayload.status, "not-usable");
		assert.equal(unboundPayload.decision, null);
		assert.equal(unboundPayload.code, "not-found");
		assert.ok(unboundPayload.problems.length > 0);

		const bound = parseSingleJson(runCli(["bind", ...base, "--workspace", sandbox.workspaceA, "--write"]).stdout);
		const opened = parseSingleJson(runCli(["open", ...base, "--workspace", sandbox.workspaceA]).stdout);
		runCli(["confirm", ...base, "--project-id", bound.projectId, "--workspace-id", bound.workspaceId, "--revision", String(opened.profileRevision), "--set", "boardName=BoardCli", "--write"]);
		const view = runCli(["read", ...base, "--workspace", sandbox.workspaceA, "--detect"]);
		assert.equal(view.code, 0, view.stderr);
		const payload = parseSingleJson(view.stdout);
		assert.equal(payload.status, "ok");
		assert.equal(payload.code, "ok");
		assert.equal(payload.exitCode, 0);
		const board = payload.decision.items.find((item) => item.family === "project-profile" && item.factKey === "project-profile.boardName");
		assert.equal(board.class, "current");
		assert.equal(
			payload.detectedCandidates.some((candidate) => candidate.value === "SamplePlatform"),
			true,
		);
		assert.equal(
			payload.gaps.some((gap) => gap.field === "boardName"),
			true,
		);

		// `--max-output-bytes` 只约束 **M1 条目数组**：极小额度下条目为空、整体不完整，
		// 但外壳仍是一个合法的受控对象（有独立上限）。
		const tiny = runCli(["read", ...base, "--workspace", sandbox.workspaceA, "--max-output-bytes", "1"]);
		assert.equal(tiny.code, 7);
		const tinyPayload = parseSingleJson(tiny.stdout);
		assert.equal(tinyPayload.status, "incomplete");
		assert.equal(tinyPayload.code, "incomplete");
		assert.deepEqual(tinyPayload.decision.items, []);
		assert.ok(tinyPayload.decision.dropped > 0);
		assert.ok(tinyPayload.shellTruncated.length >= 0);
		assert.ok(tiny.stdout.length < 8_000, `外壳必须有独立上限（实际 ${tiny.stdout.length} 字节）`);

		// 人类可读模式也能跑（JSON 模式才保证"恰好一个对象"）。
		const human = runCli(["read", "--root", sandbox.root, "--cwd", sandbox.workspaceA, "--authorized-root", sandbox.workspaceA, "--workspace", sandbox.workspaceA]);
		assert.equal(human.code, 0);
		assert.match(human.stdout, /读取：/);
	} finally {
		await sandbox.cleanup();
	}
});
