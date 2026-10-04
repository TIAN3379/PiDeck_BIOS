/**
 * BM-02D4：知识库管理薄 CLI 的参数/输出/退出码与真实子进程端到端。
 *
 * 三层判据：
 * 1. **参数层**：未知/重复/缺值/相对路径/缺写确认一律退出码 2，且**不创建输出**；
 * 2. **端到端**：合成富库 inspect → export → restore → 新子进程 reader 独立核对原字节；
 * 3. **退出码映射**：`--json` 一次可解析、错误脱敏；"已提交需复核/残留"必须非 0。
 *
 * 全部在自建临时沙箱里跑，不读真实客户资料；子进程都有超时与 finally 收尾。
 */
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StorageError, exportKnowledgeBackup, initializeKnowledgeStore, restoreKnowledgeBackup } from "../core/storage/index.ts";
import { exitCodeForExportResult, exitCodeForFailure, exitCodeForInspectReport, exitCodeForRestoreResult } from "../cli/knowledge.mjs";
import { assertRestoredByteIdentical, makeRichStore } from "./helpers/restoreFixtures.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(PACKAGE_ROOT, "cli", "knowledge.mjs");
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-knowledge-cli-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let counter = 0;
function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

/** 运行 CLI 子进程并返回 { code, stdout, stderr }（超时即失败，不挂死测试）。 */
function cli(args, options = {}) {
	const outcome = { code: null, stdout: "", stderr: "" };
	const nodeArgs = options.nodeArgs ?? [];
	try {
		outcome.stdout = execFileSync(process.execPath, [...nodeArgs, CLI, ...args], {
			cwd: options.cwd ?? PACKAGE_ROOT,
			encoding: "utf8",
			timeout: 60_000,
			env: { ...process.env, ...(options.env ?? {}) },
		});
		outcome.code = 0;
	} catch (error) {
		outcome.code = typeof error.status === "number" ? error.status : null;
		outcome.stdout = error.stdout ?? "";
		outcome.stderr = error.stderr ?? "";
	}
	return outcome;
}

function parseJsonObject(text) {
	const trimmed = text.trim();
	assert.ok(trimmed.length > 0, "stdout 必须有结果对象");
	const value = JSON.parse(trimmed);
	assert.equal(typeof value, "object");
	return value;
}

/* ------------------------------------------------------------------ 1. help 与参数 */

test("D4 CLI：help 与参数错误都在创建输出之前结束，且退出码为 2", async (t) => {
	await t.test("--help / 无参数：只读帮助，退出码 0，不创建任何文件", () => {
		const cwd = sandboxPath("help-cwd");
		mkdirSync(cwd, { recursive: true });
		for (const args of [["--help"], []]) {
			const outcome = cli(args, { cwd });
			assert.equal(outcome.code, 0);
			assert.match(outcome.stdout, /inspect/);
			assert.match(outcome.stdout, /export/);
			assert.match(outcome.stdout, /restore/);
			assert.equal(outcome.stderr, "");
		}
		assert.deepEqual(readdirSync(cwd), [], "help 不得创建任何文件");
	});

	await t.test("未知命令 / 未知参数 / 重复参数 / 缺值 / 不适用参数：退出码 2", () => {
		const cwd = sandboxPath("usage-cwd");
		mkdirSync(cwd, { recursive: true });
		const cases = [["nope"], ["inspect", "--wat"], ["inspect", "--root", "a", "--root", "b"], ["inspect", "--root"], ["inspect", "--backup-root", join(cwd, "x")], ["inspect", "extra-positional"]];
		for (const args of cases) {
			const outcome = cli(args, { cwd });
			assert.equal(outcome.code, 2, `${args.join(" ")} 必须退出码 2，实际 ${outcome.code}`);
		}
		assert.deepEqual(readdirSync(cwd), [], "参数错误不得创建任何文件");
	});

	await t.test("相对路径与缺失写确认：拒绝且不创建输出", () => {
		const cwd = sandboxPath("usage-write-cwd");
		mkdirSync(cwd, { recursive: true });
		const root = join(cwd, "store");
		mkdirSync(root, { recursive: true });
		const backupRoot = join(cwd, "backup");
		const cases = [
			// 相对路径
			["inspect", "--root", "relative/root"],
			// 缺 --confirm-write
			["export", "--root", root, "--backup-root", backupRoot, "--offline-confirmed"],
			// 缺 --offline-confirmed
			["export", "--root", root, "--backup-root", backupRoot, "--confirm-write"],
			// restore 缺确认
			["restore", "--backup-root", backupRoot, "--root", join(cwd, "restored"), "--confirm-write"],
		];
		for (const args of cases) {
			const outcome = cli(args, { cwd });
			assert.equal(outcome.code, 2, `${args.join(" ")} 必须退出码 2，实际 ${outcome.code}`);
		}
		assert.equal(existsSync(backupRoot), false, "拒绝的写命令不得创建备份容器");
		assert.equal(existsSync(join(cwd, "restored")), false, "拒绝的恢复不得创建目标");
	});

	await t.test("inspect 缺 --root / 根不存在：受控非 0，无 stack", () => {
		const cwd = sandboxPath("inspect-missing");
		mkdirSync(cwd, { recursive: true });
		assert.equal(cli(["inspect"], { cwd }).code, 2);
		const missing = cli(["inspect", "--root", join(cwd, "nope"), "--json"], { cwd });
		assert.equal(missing.code, 1);
		const payload = parseJsonObject(missing.stdout);
		assert.equal(payload.status, "error");
		assert.equal(typeof payload.code, "string");
		assert.doesNotMatch(missing.stderr, /at .*\.mjs:/, "不得输出 stack");
	});
});

/* ------------------------------------------------------------------ 2. 端到端 */

test("D4 CLI 端到端：合成富库 inspect → export → restore → 新子进程 reader 独立核对", async () => {
	const root = join(SANDBOX, "e2e-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "e2e-backup");
	const restoredRoot = join(SANDBOX, "e2e-restored");

	// inspect：只读、可解析、不出现业务正文（不进正文输出面）。
	const inspected = cli(["inspect", "--root", root, "--json"]);
	assert.equal(inspected.code, 0, `inspect 必须成功：${inspected.stderr}`);
	const inspectPayload = parseJsonObject(inspected.stdout);
	assert.equal(inspectPayload.status, "ok");
	assert.equal(inspectPayload.complete, true);
	assert.equal(inspectPayload.outcome, "no-migration-needed");
	assert.ok(inspectPayload.versions.length >= 2, "必须报告 registry/record/journal/audit 的版本分布");
	assert.doesNotMatch(inspected.stdout, /PXE/, "结果对象不得包含业务正文");

	// export：published、无残留 ⇒ 0。
	const exported = cli(["export", "--root", root, "--backup-root", backupRoot, "--offline-confirmed", "--confirm-write", "--json"]);
	assert.equal(exported.code, 0, `export 必须成功：${exported.stderr}`);
	const exportPayload = parseJsonObject(exported.stdout);
	assert.equal(exportPayload.status, "exported");
	assert.equal(exportPayload.published, true);
	assert.equal(exportPayload.cleanup, "ok");

	// restore：registry 最后发布 ⇒ restored。
	const restored = cli(["restore", "--backup-root", backupRoot, "--root", restoredRoot, "--offline-confirmed", "--confirm-write", "--json"]);
	assert.equal(restored.code, 0, `restore 必须成功：${restored.stderr}`);
	const restorePayload = parseJsonObject(restored.stdout);
	assert.equal(restorePayload.status, "restored");
	assert.equal(restorePayload.published, true);
	assert.deepEqual(restorePayload.reviewReasons, []);

	// 独立原字节核对（不借助实现字段）。
	assertRestoredByteIdentical(root, restoredRoot);
	assert.deepEqual(readdirSync(join(restoredRoot, "locks")), []);

	// 真实新子进程用现有 reader 读取恢复后的库。
	const script = `
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.env.CLI_READER_CONFIG);
const storage = await import(config.entryUrl);
const registry = await storage.readRegistry({ root: config.root });
const read = await storage.readRecord({ root: config.root, kind: "experience-card", id: "exp-a" });
process.stdout.write(JSON.stringify({ schemaVersion: registry.schemaVersion, recordId: read.id, problem: read.record.problem }));
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		timeout: 60_000,
		env: { ...process.env, CLI_READER_CONFIG: JSON.stringify({ root: restoredRoot, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
		encoding: "utf8",
	});
	const read = JSON.parse(stdout);
	assert.equal(read.recordId, "exp-a");
	assert.equal(read.problem, "PXE 默认开启");
	assert.ok(Number.isSafeInteger(read.schemaVersion));
});

test("D4 CLI：已有目标 sentinel 不变，坏备份受控失败且 stdout 只有一个对象", async () => {
	const root = join(SANDBOX, "guard-store");
	await initializeKnowledgeStore({ root });
	const backupRoot = join(SANDBOX, "guard-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, backupId: "cli-guard" });

	// 已有目标：不得覆盖，sentinel 逐字节不变。
	const occupied = join(SANDBOX, "guard-target");
	mkdirSync(occupied, { recursive: true });
	const sentinel = join(occupied, "sentinel.txt");
	writeFileSync(sentinel, "UNRELATED SENTINEL", "utf8");
	const blocked = cli(["restore", "--backup-root", backupRoot, "--root", occupied, "--offline-confirmed", "--confirm-write", "--json"]);
	assert.equal(blocked.code, 1, "目标冲突必须非 0");
	const blockedPayload = parseJsonObject(blocked.stdout);
	assert.equal(blockedPayload.status, "error");
	assert.equal(blockedPayload.code, "backup-target-exists");
	assert.equal(readFileSync(sentinel, "utf8"), "UNRELATED SENTINEL");
	assert.deepEqual(readdirSync(occupied), ["sentinel.txt"]);

	// 坏备份：受控失败，且不把 stack / 原始正文写到任何输出面。
	const badBackup = join(SANDBOX, "guard-bad-backup");
	mkdirSync(badBackup, { recursive: true });
	writeFileSync(join(badBackup, "manifest.json"), "{ broken", "utf8");
	const failed = cli(["restore", "--backup-root", badBackup, "--root", join(SANDBOX, "guard-bad-target"), "--offline-confirmed", "--confirm-write", "--json"]);
	assert.equal(failed.code, 1);
	const failedPayload = parseJsonObject(failed.stdout);
	assert.equal(failedPayload.code, "invalid-backup-manifest");
	assert.equal(failedPayload.published, false);
	assert.doesNotMatch(failed.stdout, /at .*\.mjs:/, "stdout 不得含 stack");
	assert.doesNotMatch(failed.stderr, /PRIVATE|at .*\.mjs:/, "stderr 不得含正文或 stack");
	assert.equal(existsSync(join(SANDBOX, "guard-bad-target")), false);

	// 人类可读模式：同样只给受控类别，不打印 stack。
	const humanReadable = cli(["restore", "--backup-root", badBackup, "--root", join(SANDBOX, "guard-bad-target-2"), "--offline-confirmed", "--confirm-write"]);
	assert.equal(humanReadable.code, 1);
	assert.match(humanReadable.stderr, /invalid-backup-manifest/);
	assert.doesNotMatch(humanReadable.stderr, /at .*\.mjs:/);
});

/* ------------------------------------------------------------------ 2b. R26-3 解析失败的 JSON 契约 */

test("R26-3：解析失败时显式 --json 仍返回一个受控对象，且不误判被取值的选项", async (t) => {
	const cwd = sandboxPath("r26-3-cwd");
	mkdirSync(cwd, { recursive: true });

	await t.test("缺值 / 未知参数 / 未知命令 / 重复 / 不适用选项：退出 2 且 stdout 恰好一个 JSON 对象", () => {
		const cases = [
			{ args: ["inspect", "--json", "--root"], command: "inspect" },
			{ args: ["inspect", "--json", "--unknown"], command: "inspect" },
			{ args: ["bad-command", "--json"], command: "unknown" },
			{ args: ["inspect", "--root", join(cwd, "a"), "--root", join(cwd, "b"), "--json"], command: "inspect" },
			{ args: ["inspect", "--json", "--backup-root", join(cwd, "x")], command: "inspect" },
		];
		for (const { args, command } of cases) {
			const outcome = cli(args, { cwd });
			assert.equal(outcome.code, 2, `${args.join(" ")} 必须退出 2`);
			const payload = parseJsonObject(outcome.stdout);
			assert.equal(payload.status, "usage-error");
			assert.equal(payload.command, command);
			assert.equal(typeof payload.message, "string");
			assert.ok(payload.message.length > 0);
		}
		assert.deepEqual(readdirSync(cwd), [], "解析失败不得创建任何文件");
	});

	await t.test("未知参数正文被有界省略，不回显超长输入", () => {
		const long = `--${"z".repeat(4000)}`;
		const outcome = cli(["inspect", "--json", long], { cwd });
		assert.equal(outcome.code, 2);
		const payload = parseJsonObject(outcome.stdout);
		assert.ok(payload.message.length < 200, "错误文案必须有界");
		assert.ok(!payload.message.includes("z".repeat(400)), "不得原样回显超长输入");
	});

	await t.test("--json 前置位置同样生效；被取值选项消费的 --json 不算请求 JSON", () => {
		const root = join(SANDBOX, "r26-3-store");
		// 前置 --json：解析器把它当输出开关（命令在后）。
		const store = cli(["--json", "inspect", "--root", root], { cwd });
		assert.equal(store.code, 1, "根不存在 ⇒ 操作拒绝");
		assert.equal(parseJsonObject(store.stdout).status, "error");

		// `--root --json`：`--json` 是 `--root` 的值位置 ⇒ 缺值错误，且**没有**请求 JSON。
		const consumed = cli(["inspect", "--root", "--json"], { cwd });
		assert.equal(consumed.code, 2);
		assert.equal(consumed.stdout.trim(), "", "未请求 JSON 时 stdout 必须为空");
		assert.match(consumed.stderr, /参数缺少值/);

		// 无 JSON：人类可读诊断走 stderr。
		const human = cli(["inspect", "--root"], { cwd });
		assert.equal(human.code, 2);
		assert.equal(human.stdout.trim(), "", "未请求 JSON 时 stdout 必须为空");
		assert.match(human.stderr, /参数错误/);
		assert.deepEqual(readdirSync(cwd), [], "解析失败不得创建任何文件");
	});
});

/** R26-2 的真实入口证据：预加载模块在 CLI 进程里制造"已发布后目标 registry 被合法改写"。 */
function driftPreloadPath() {
	const path = join(SANDBOX, "r26-2-drift-preload.mjs");
	writeFileSync(
		path,
		`import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const config = JSON.parse(process.env.CLI_DRIFT_CONFIG);
const fsPromises = require("node:fs/promises");
const realOpen = fsPromises.open;
let fired = false;
fsPromises.open = async (...args) => {
	if (!fired && args[0] === config.registry && (args[1] === "r" || args[1] === undefined)) {
		fired = true;
		const parsed = JSON.parse(readFileSync(config.registry, "utf8"));
		writeFileSync(config.registry, Buffer.from(JSON.stringify({ ...parsed, revision: parsed.revision + 1 }) + "\\n", "utf8"));
	}
	return realOpen(...args);
};
`,
		"utf8",
	);
	return path;
}

test("R26-2/R26-3：真实 CLI 子进程在“已提交需复核”时返回退出码 3", async () => {
	const root = join(SANDBOX, "exit3-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "exit3-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, backupId: "cli-exit3" });
	const target = join(SANDBOX, "exit3-target");

	const outcome = cli(["restore", "--backup-root", backupRoot, "--root", target, "--offline-confirmed", "--confirm-write", "--json"], {
		nodeArgs: ["--import", pathToFileURL(driftPreloadPath()).href],
		env: { CLI_DRIFT_CONFIG: JSON.stringify({ registry: join(target, "registry.json") }) },
	});
	assert.equal(outcome.code, 3, `已提交需复核必须退出 3，实际 ${outcome.code}；stderr=${outcome.stderr}`);
	const payload = parseJsonObject(outcome.stdout);
	assert.equal(payload.status, "committed-needs-review");
	assert.equal(payload.published, true);
	assert.ok(payload.reviewReasons.includes("verify-restored-drift"));
	// 库保留、内容确实与被发布的原字节不同（可观察的漂移）。
	assert.equal(existsSync(join(target, "registry.json")), true);
	assert.notDeepEqual(readFileSync(join(target, "registry.json")), readFileSync(join(backupRoot, "data", "registry.json")));
});

/* ------------------------------------------------------------------ 3. 退出码映射（薄适配层） */

test("D4 退出码：已提交/需复核/残留一律非 0（薄适配层，不复制发布逻辑）", () => {
	// 已提交但需复核 ⇒ 3，不是 0。
	assert.equal(exitCodeForRestoreResult({ published: true, status: "committed-needs-review", cleanup: "ok", reviewReasons: ["verify-restored-failed"] }), 3);
	// 已提交但残留 ⇒ 3。
	assert.equal(exitCodeForRestoreResult({ published: true, status: "restored", cleanup: "failed", reviewReasons: [] }), 3);
	// 正常 ⇒ 0。
	assert.equal(exitCodeForRestoreResult({ published: true, status: "restored", cleanup: "ok", reviewReasons: [] }), 0);
	// 未提交（不该出现的形状）⇒ 非 0。
	assert.equal(exitCodeForRestoreResult({ published: false, status: "committed-needs-review", cleanup: "ok", reviewReasons: [] }), 1);

	assert.equal(exitCodeForExportResult({ published: true, cleanup: "ok" }), 0);
	assert.equal(exitCodeForExportResult({ published: true, cleanup: "failed" }), 3);
	assert.equal(exitCodeForExportResult({ published: false, cleanup: "ok" }), 1);

	const committed = new StorageError("cancelled", "已提交后取消", { facts: { phase: "verify-restored", published: true, cleanup: "ok" } });
	assert.equal(exitCodeForFailure(committed), 3, "已提交的失败必须映射成 3");
	const rejected = new StorageError("backup-target-exists", "目标冲突", { facts: { phase: "acquire-target", published: false, cleanup: "ok" } });
	assert.equal(exitCodeForFailure(rejected), 1);
	assert.equal(exitCodeForFailure(new Error("未分类")), 1);

	assert.equal(exitCodeForInspectReport({ complete: true, outcome: "no-migration-needed", blockingProblems: 0, manualItems: 0 }), 0);
	assert.equal(exitCodeForInspectReport({ complete: true, outcome: "blocked", blockingProblems: 1, manualItems: 0 }), 1);
	assert.equal(exitCodeForInspectReport({ complete: false, outcome: "incomplete", blockingProblems: 0, manualItems: 0 }), 1);
	assert.equal(exitCodeForInspectReport({ complete: true, outcome: "no-migration-needed", blockingProblems: 0, manualItems: 1 }), 1);
});

/* ------------------------------------------------------------------ 4. SIGINT 生命周期 */

test("D4 CLI：SIGINT 后安全收尾，不留 .tmp 半成品，listener 不阻断退出", async () => {
	const root = join(SANDBOX, "sigint-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "sigint-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, backupId: "cli-sigint" });
	const target = join(SANDBOX, "sigint-target");

	const child = spawn(process.execPath, [CLI, "restore", "--backup-root", backupRoot, "--root", target, "--offline-confirmed", "--confirm-write"], { cwd: PACKAGE_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	// 让进程先进入主流程再打断（早期 SIGINT 走 Node 默认处理，不属于本契约）。
	setTimeout(() => child.kill("SIGINT"), 300).unref();
	const exit = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error("SIGINT 后未在超时内退出（listener 可能没有移除）"));
		}, 30_000);
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			resolve({ code, signal });
		});
	});
	assert.ok(exit.code !== null || exit.signal !== null, "必须以某种受控方式结束");

	// 无论打断落在哪一步，不变量都必须成立：没有半截发布，也没有临时文件残留。
	if (existsSync(target)) {
		assert.deepEqual(
			readdirSync(target).filter((name) => name.endsWith(".tmp")),
			[],
			"不得留下发布临时文件",
		);
	}
	const registryPath = join(target, "registry.json");
	if (existsSync(registryPath)) {
		assert.deepEqual(readFileSync(registryPath), readFileSync(join(backupRoot, "data", "registry.json")), "已发布的 registry 必须是完整原字节");
	}
});

/* ------------------------------------------------------------------ 5. 与 API 同源 */

test("D4 CLI 是薄适配层：同一份备份用 API 与 CLI 恢复结果一致", async () => {
	const root = join(SANDBOX, "same-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "same-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, backupId: "cli-same" });

	const viaApi = join(SANDBOX, "same-api-target");
	const apiResult = await restoreKnowledgeBackup({ backupRoot, root: viaApi, offlineConfirmed: true });
	const viaCli = join(SANDBOX, "same-cli-target");
	const cliOutcome = cli(["restore", "--backup-root", backupRoot, "--root", viaCli, "--offline-confirmed", "--confirm-write", "--json"]);
	assert.equal(cliOutcome.code, 0);
	const cliResult = parseJsonObject(cliOutcome.stdout);
	assert.equal(cliResult.status, apiResult.status);
	assert.equal(cliResult.published, apiResult.published);
	assert.equal(cliResult.files, apiResult.files);
	assert.equal(cliResult.directories, apiResult.directories);
	assert.equal(cliResult.totalBytes, apiResult.totalBytes);
	assert.equal(cliResult.cleanup, apiResult.cleanup);
	// 两个目标逐字节相同。
	for (const relative of ["registry.json", join("experiences", "exp-a.json")]) {
		assert.deepEqual(readFileSync(join(viaCli, relative)), readFileSync(join(viaApi, relative)));
	}
});

// 让"子进程执行"这一层也被显式覆盖：execFile 路径（与 execFileSync 不同的实现）只在这里用一次。
test("D4 CLI：execFile 子进程执行路径同样受控（非法参数 ⇒ 2）", async () => {
	const outcome = await new Promise((resolve) => {
		execFile(process.execPath, [CLI, "inspect"], { cwd: PACKAGE_ROOT, timeout: 60_000, encoding: "utf8" }, (error, stdout, stderr) =>
			// 异步 execFile 的退出码在 `error.code`（`error.status` 只存在于同步版）。
			resolve({ status: typeof error?.code === "number" ? error.code : 0, stdout, stderr }),
		);
	});
	assert.equal(outcome.status, 2);
	assert.match(outcome.stderr, /缺少必需参数/);
});
