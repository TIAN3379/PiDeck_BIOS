/**
 * BM-02D3（节点 B / D3）：**恢复成功往返**的永久用例。
 *
 * 交付顺序（方案 §10.1/§11.1）：先有永久最小用例，再实现窄入口，使其转绿。
 * 本文件覆盖：最小闭环 → 富库原字节往返 → 真实新进程用现有 reader 读取 →
 * 非覆盖/路径与链接拒绝 → 双进程同目标竞争。
 *
 * 只读/写自建合成临时库，不读真实客户资料；容器与目标集合一律用**独立 fs/crypto 重算**判定。
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { exportKnowledgeBackup, initializeKnowledgeStore, readRecord, readRegistry } from "../core/storage/index.ts";
import * as storage from "../core/storage/index.ts";
import { EXPERIENCE_ID, FEATURE_ID, NOW, PROJECT_ID, assertRestoredByteIdentical, makeRichStore, readManifest } from "./helpers/restoreFixtures.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-backup-restore-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let counter = 0;
function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

/** 新建一个**尚不存在**的恢复目标（父目录已存在，避免实现顺手造父链）。 */
function newTarget(name) {
	const parent = sandboxPath(`${name}-parent`);
	mkdirSync(parent, { recursive: true });
	return join(parent, "restored");
}

/** 恢复入口（对外窄出口）：先取引用而不是具名 import，缺 API 时给出清楚的红。 */
function restoreEntry() {
	const entry = storage.restoreKnowledgeBackup;
	assert.equal(typeof entry, "function", "restoreKnowledgeBackup 尚未实现（本批第一项交付）");
	return entry;
}

/** 只有已知的权限/平台不可用码才允许 skip（错误成功不得被记成"平台不支持"）。 */
const LINK_UNAVAILABLE_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL", "UNKNOWN"]);
function linkUnavailable(error) {
	return error !== undefined && LINK_UNAVAILABLE_CODES.has(String(error.code));
}
function makeDirLink(targetPath, linkPath) {
	symlinkSync(targetPath, linkPath, process.platform === "win32" ? "junction" : "dir");
}

/** 在真实子进程里跑恢复（双进程竞争用；不共享本进程的模块状态）。 */
function restoreInChild({ backupRoot, root }) {
	const script = `
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.env.RESTORE_CHILD_CONFIG);
const storage = await import(config.entryUrl);
try {
	const result = await storage.restoreKnowledgeBackup({ backupRoot: config.backupRoot, root: config.root, offlineConfirmed: true });
	process.stdout.write(JSON.stringify({ ok: true, status: result.status }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "unclassified" }));
}
`;
	return new Promise((resolve) => {
		execFile(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: PACKAGE_ROOT,
				timeout: 60_000,
				env: { ...process.env, RESTORE_CHILD_CONFIG: JSON.stringify({ backupRoot, root, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
				encoding: "utf8",
			},
			(error, stdout) => {
				if (error !== null && stdout.trim() === "") return resolve({ ok: false, code: `child-failed:${String(error.code ?? "unknown")}` });
				resolve(JSON.parse(stdout));
			},
		);
	});
}

/* ------------------------------------------------------------------ 1. 最小闭环 */

test("D3 最小闭环：导出 → 恢复到不存在的新根 → 字节一致", async () => {
	const root = join(SANDBOX, "min-store");
	await initializeKnowledgeStore({ root });
	await storage.createRecord({
		root,
		kind: "experience-card",
		id: "exp-a",
		expectedRevision: null,
		now: NOW,
		data: { problem: "PXE 默认开启", rootCause: "默认值", solution: "关闭 PXE", appliesWhen: [], doesNotApplyWhen: [], sourceProjectId: PROJECT_ID, evidence: [], validations: [], reuseScope: { level: "current-project", customers: [] }, status: "reviewed" },
	});
	const backupRoot = join(SANDBOX, "min-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3" });

	const restoredRoot = join(SANDBOX, "min-restored");
	const result = await restoreEntry()({ backupRoot, root: restoredRoot, offlineConfirmed: true });
	assert.equal(result.status, "restored");
	assert.equal(result.published, true, "恢复完成点是 registry 非覆盖发布");
	assert.deepEqual(result.reviewReasons, [], "成功路径不应带任何复核警告");

	// 独立字节对照：registry 与记录必须与源逐字节一致（不是"能 parse"）。
	const pairs = [
		["registry.json", "registry.json"],
		[join("experiences", "exp-a.json"), join("experiences", "exp-a.json")],
	];
	for (const [sourceRelative, restoredRelative] of pairs) {
		assert.deepEqual(readFileSync(join(restoredRoot, restoredRelative)), readFileSync(join(root, sourceRelative)), `${sourceRelative} 字节不一致`);
	}
	assert.equal(statSync(join(restoredRoot, "registry.json")).size, statSync(join(root, "registry.json")).size);
	// 空 cache/locks 必须存在且为空。
	for (const empty of ["cache", "locks"]) {
		assert.deepEqual(readdirSync(join(restoredRoot, empty)), [], `${empty}/ 必须为空`);
	}
});

test("D3 最小闭环：真实新进程用现有 reader 读取恢复后的库", async () => {
	const root = join(SANDBOX, "reader-store");
	await initializeKnowledgeStore({ root });
	await storage.createRecord({
		root,
		kind: "experience-card",
		id: "exp-b",
		expectedRevision: null,
		now: NOW,
		data: { problem: "PXE 默认开启", rootCause: "默认值", solution: "关闭 PXE", appliesWhen: [], doesNotApplyWhen: [], sourceProjectId: PROJECT_ID, evidence: [], validations: [], reuseScope: { level: "current-project", customers: [] }, status: "reviewed" },
	});
	const backupRoot = join(SANDBOX, "reader-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3-reader" });
	const restoredRoot = join(SANDBOX, "reader-restored");
	await restoreEntry()({ backupRoot, root: restoredRoot, offlineConfirmed: true });

	// 新进程：不是 parse JSON，而是调用现有 reader（readRegistry / readRecord）。
	const script = `
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.env.RESTORE_READER_CONFIG);
const storage = await import(config.entryUrl);
const registry = await storage.readRegistry({ root: config.root });
const read = await storage.readRecord({ root: config.root, kind: "experience-card", id: "exp-b" });
process.stdout.write(JSON.stringify({ schemaVersion: registry.schemaVersion, recordId: read.id, revision: read.record.revision, problem: read.record.problem }));
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		env: { ...process.env, RESTORE_READER_CONFIG: JSON.stringify({ root: restoredRoot, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
		encoding: "utf8",
	});
	const read = JSON.parse(stdout);
	assert.equal(read.recordId, "exp-b");
	assert.equal(read.problem, "PXE 默认开启", "恢复后的记录必须可解释");
	assert.ok(Number.isSafeInteger(read.revision));
});

/* ------------------------------------------------------------------ 2. 富库原字节往返 */

test("D3 富库：五类记录 + v1/v2 journal + 意图/事件 + 空目录全部恢复，字节逐字节保真", async () => {
	const root = join(SANDBOX, "rich-store");
	const workspacePath = join(SANDBOX, "ws-main");
	await makeRichStore(root, workspacePath);
	const backupRoot = join(SANDBOX, "rich-backup");
	const exported = await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3-rich" });

	const restoredRoot = join(SANDBOX, "rich-restored");
	const result = await restoreEntry()({ backupRoot, root: restoredRoot, offlineConfirmed: true });
	assert.equal(result.status, "restored");
	assert.equal(result.files, exported.files);
	assert.equal(result.totalBytes, exported.totalBytes, "恢复的 payload 总量必须与导出一致");

	// 独立集合与原字节对照：除 registry 之外的文件集合必须完全一致，且逐字节相等。
	const { source, restored } = assertRestoredByteIdentical(root, restoredRoot);
	// 已知空目录必须被建回来（按清单登记，而不是"有文件才有目录"）。
	const manifest = readManifest(backupRoot);
	const emptyDir = `projects/${PROJECT_ID}/tasks`;
	assert.ok(manifest.directories.includes(emptyDir), "合成库必须留下一个清单登记过的空目录");
	assert.ok(restored.directories.includes(emptyDir), `${emptyDir} 必须被恢复`);
	assert.ok(
		source.files.some((file) => file.endsWith(".json") && file.startsWith("journal/")),
		"富库必须含 journal 工件",
	);
	// 排除项恢复为空（旧锁/缓存不得随备份进入新库）。
	for (const empty of ["cache", "locks"]) assert.deepEqual(readdirSync(join(restoredRoot, empty)), []);
	assert.equal(readManifest(backupRoot).exclusions.join(","), "cache,locks");
});

test("D3 富库：中文 / 缩进 / CRLF / 尾空格逐字节保真，且真实新进程读得懂全部工件", async () => {
	const root = join(SANDBOX, "bytes-store");
	// 这一组要读回五类记录，因此保留 task 文件（空目录恢复在上一组验证）。
	await makeRichStore(root, join(SANDBOX, "ws-main"), { emptyTasks: false });
	// 字节保真样本：把一条**合法**记录改写成 CRLF + 缩进 + 行尾/末尾空白的原始字节。
	// 只有仍然通过业务准入的内容才允许导出（坏 JSON 的拒绝对照在失败组）。
	const rawPath = join(root, "experiences", `${EXPERIENCE_ID}.json`);
	const parsed = JSON.parse(readFileSync(rawPath, "utf8"));
	writeFileSync(rawPath, Buffer.from(`${JSON.stringify(parsed, null, 2).split("\n").join("\r\n")}  \r\n`, "utf8"));
	const featurePath = join(root, "features", `${FEATURE_ID}.json`);
	const featureParsed = JSON.parse(readFileSync(featurePath, "utf8"));
	writeFileSync(featurePath, Buffer.from(`${JSON.stringify(featureParsed, null, "\t")}\n`, "utf8"));

	const backupRoot = join(SANDBOX, "bytes-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3-bytes" });
	const restoredRoot = join(SANDBOX, "bytes-restored");
	await restoreEntry()({ backupRoot, root: restoredRoot, offlineConfirmed: true });

	assertRestoredByteIdentical(root, restoredRoot);
	// 逐字节（含 CRLF 与尾空格）必须与源一致：原始字节带 CRLF，且末尾是"缩进结尾 + 两个空格 + CRLF"。
	const rawRestored = readFileSync(join(restoredRoot, "experiences", `${EXPERIENCE_ID}.json`));
	assert.ok(rawRestored.includes(Buffer.from("\r\n")), "CRLF 必须保真");
	assert.ok(rawRestored.toString("utf8").endsWith("}  \r\n"), "行尾空白必须保真");
	for (const relative of ["experiences", "features"]) {
		for (const name of readdirSync(join(restoredRoot, relative))) {
			assert.deepEqual(readFileSync(join(restoredRoot, relative, name)), readFileSync(join(root, relative, name)));
		}
	}

	// 真实新进程：现 readRegistry / readRecord 五类 + 只读预检判定整库可解释（含审核工件与 journal）。
	const script = `
import { pathToFileURL } from "node:url";
const config = JSON.parse(process.env.RESTORE_READER_CONFIG);
const storage = await import(config.entryUrl);
const registry = await storage.readRegistry({ root: config.root });
const kinds = [
	["project-profile", config.projectId, undefined],
	["experience-card", "exp-a", undefined],
	["feature-record", "feat-1", undefined],
	["task-record", "task-1", config.projectId],
	["context-manifest", "ctx-1", config.projectId],
];
const read = [];
for (const [kind, id, projectId] of kinds) {
	const result = await storage.readRecord(projectId === undefined ? { root: config.root, kind, id } : { root: config.root, kind, id, projectId });
	read.push({ kind, id: result.id, revision: result.record.revision, schemaVersion: result.record.schemaVersion });
}
const report = await storage.inspectKnowledgeStore({ root: config.root });
process.stdout.write(JSON.stringify({ registrySchema: registry.schemaVersion, read, outcome: report.outcome, complete: report.complete, blocking: report.blockingProblems, manual: report.manualItems }));
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		env: { ...process.env, RESTORE_READER_CONFIG: JSON.stringify({ root: restoredRoot, projectId: PROJECT_ID, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
		encoding: "utf8",
	});
	const read = JSON.parse(stdout);
	assert.equal(read.read.length, 5, "五类记录必须都能被新进程解释");
	for (const entry of read.read) assert.equal(entry.schemaVersion, read.registrySchema);
	assert.equal(read.complete, true);
	assert.equal(read.outcome, "no-migration-needed", "恢复后的库（含审核工件与 journal）必须可被现有预检解释");
	assert.equal(read.blocking, 0);
	assert.equal(read.manual, 0);
	// 本进程 reader 也复核一次 ID/revision（与子进程独立）。
	const local = await readRecord({ root: restoredRoot, kind: "experience-card", id: EXPERIENCE_ID });
	assert.equal(local.id, EXPERIENCE_ID);
	assert.ok(Number.isSafeInteger(local.record.revision));
	assert.equal((await readRegistry({ root: restoredRoot })).schemaVersion, read.registrySchema);
});

/* ------------------------------------------------------------------ 3. 非覆盖、路径与链接 */

test("D3 非覆盖与路径：已有目标一律保护，重叠与父链链接一律拒绝", async (t) => {
	const root = join(SANDBOX, "path-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "path-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3-path" });

	await t.test("目标已存在（空目录也算）必须拒绝", async () => {
		const occupied = newTarget("existing-empty");
		mkdirSync(occupied, { recursive: true });
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: occupied, offlineConfirmed: true }),
			(error) => error.code === "backup-target-exists",
		);
	});

	await t.test("目标已有非空内容：拒绝且原 sentinel 逐字节不变", async () => {
		const occupied = newTarget("existing-nonempty");
		mkdirSync(occupied, { recursive: true });
		const sentinel = join(occupied, "sentinel.txt");
		writeFileSync(sentinel, "UNRELATED SENTINEL", "utf8");
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: occupied, offlineConfirmed: true }),
			(error) => error.code === "backup-target-exists",
		);
		assert.equal(readFileSync(sentinel, "utf8"), "UNRELATED SENTINEL");
		assert.deepEqual(readdirSync(occupied), ["sentinel.txt"]);
	});

	await t.test("目标是同名文件：拒绝且文件内容不变", async () => {
		const parent = sandboxPath("existing-file-parent");
		mkdirSync(parent, { recursive: true });
		const occupied = join(parent, "restored");
		writeFileSync(occupied, "NOT A DIRECTORY", "utf8");
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: occupied, offlineConfirmed: true }),
			(error) => error.code === "backup-target-exists",
		);
		assert.equal(readFileSync(occupied, "utf8"), "NOT A DIRECTORY");
	});

	await t.test("canonical 重叠（目标就是备份容器，或落在备份容器内）必须拒绝", async () => {
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: backupRoot, offlineConfirmed: true }),
			(error) => error.code === "backup-target-overlap",
		);
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: join(backupRoot, "data"), offlineConfirmed: true }),
			(error) => error.code === "backup-target-overlap",
		);
	});

	await t.test("恢复目标父链含链接（真实 junction / dir symlink）必须拒绝，且不创建输出", async (ctx) => {
		const parent = sandboxPath("chain-parent");
		const real = sandboxPath("chain-real");
		mkdirSync(parent, { recursive: true });
		mkdirSync(real, { recursive: true });
		const linkParent = join(parent, "linked");
		let unavailable;
		try {
			makeDirLink(real, linkParent);
		} catch (error) {
			unavailable = error;
		}
		if (unavailable !== undefined) {
			assert.ok(linkUnavailable(unavailable), `链接创建失败必须是已知权限码，实际：${String(unavailable.code)}`);
			ctx.skip(`本机无法创建目录链接（${String(unavailable.code)}），跳过该对照`);
			return;
		}
		const target = join(linkParent, "restored");
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: target, offlineConfirmed: true }),
			(error) => error.code === "backup-argument-invalid",
		);
		assert.deepEqual(readdirSync(real), [], "拒绝后不得在链接目标里创建任何内容");
	});

	await t.test("恢复目标本身是链接：拒绝且不穿透", async (ctx) => {
		const parent = sandboxPath("target-link-parent");
		const real = sandboxPath("target-link-real");
		mkdirSync(parent, { recursive: true });
		mkdirSync(real, { recursive: true });
		const linkTarget = join(parent, "restored");
		let unavailable;
		try {
			makeDirLink(real, linkTarget);
		} catch (error) {
			unavailable = error;
		}
		if (unavailable !== undefined) {
			assert.ok(linkUnavailable(unavailable), `链接创建失败必须是已知权限码，实际：${String(unavailable.code)}`);
			ctx.skip(`本机无法创建目录链接（${String(unavailable.code)}），跳过该对照`);
			return;
		}
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: linkTarget, offlineConfirmed: true }),
			(error) => error.code === "backup-target-exists",
		);
		assert.deepEqual(readdirSync(real), [], "拒绝后不得往链接目标里写");
	});

	await t.test("相对路径 / 缺离线确认：在任何输出创建前拒绝", async () => {
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: "relative/restored", offlineConfirmed: true }),
			(error) => error.code === "backup-argument-invalid",
		);
		await assert.rejects(
			() => restoreEntry()({ backupRoot, root: newTarget("no-confirm") }),
			(error) => error.code === "backup-argument-invalid",
		);
	});
});

/* ------------------------------------------------------------------ 4. 双进程同目标竞争 */

test("D3 双进程：同一恢复目标只有一方取得，另一方不动赢家产物", async () => {
	const root = join(SANDBOX, "race-store");
	await makeRichStore(root, join(SANDBOX, "ws-main"));
	const backupRoot = join(SANDBOX, "race-backup");
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d3-race" });
	const target = newTarget("race");

	const [left, right] = await Promise.all([restoreInChild({ backupRoot, root: target }), restoreInChild({ backupRoot, root: target })]);
	const winners = [left, right].filter((entry) => entry.ok === true);
	const losers = [left, right].filter((entry) => entry.ok === false);
	assert.equal(winners.length, 1, `必须恰好一方取得目标：${JSON.stringify([left, right])}`);
	assert.equal(losers.length, 1);
	assert.equal(losers[0].code, "backup-target-exists", "失败一方必须是受控的目标冲突，不得动赢家产物");
	assert.equal(winners[0].status, "restored");

	// 赢家产物完整：逐字节等于源，且没有残留临时文件。
	assertRestoredByteIdentical(root, target);
	assert.deepEqual(
		readdirSync(target).filter((name) => name.endsWith(".tmp")),
		[],
		"竞争结束后不得留下发布临时文件",
	);
});
