/**
 * BM-02D3（节点 B / D3）：恢复的**拒绝、预算、源变化、IO/完成点与取消**矩阵。
 *
 * 分组（方案 §10.1）：备份拒绝 / 预算与预检 / 恢复中源变化 / 生命周期与提交事实 / 只读与兼容。
 * 全部使用自建临时沙箱与合成库；不读真实客户资料；字节判定用 fs/crypto 独立重算。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StorageError, exportKnowledgeBackup, initializeKnowledgeStore, restoreKnowledgeBackup } from "../core/storage/index.ts";
import { NOW, PROJECT_ID, assertRestoredByteIdentical, makeRichStore, readManifest, snapshotTree } from "./helpers/restoreFixtures.mjs";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-backup-restore-f-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let counter = 0;
function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

/** 目标 + 备份的父目录都先建好；恢复目标本身必须不存在。 */
function newTarget(name) {
	const parent = sandboxPath(`${name}-parent`);
	mkdirSync(parent, { recursive: true });
	return join(parent, "restored");
}

/** 建一个最小/富库并导出，返回 { root, backupRoot }。 */
async function exportedBackup(name, { rich = false } = {}) {
	const root = sandboxPath(`${name}-store`);
	if (rich) await makeRichStore(root, join(SANDBOX, "ws-main"));
	else await initializeKnowledgeStore({ root });
	const backupRoot = sandboxPath(`${name}-backup`);
	await exportKnowledgeBackup({ root, backupRoot, offlineConfirmed: true, now: NOW, backupId: `backup-${name}` });
	return { root, backupRoot };
}

/** 按契约字段顺序重写完成标记（模拟"重新配好 hash 的坏备份"）。 */
function rewriteManifest(backupRoot, mutate) {
	const manifest = readManifest(backupRoot);
	mutate(manifest);
	const ordered = {
		backupVersion: manifest.backupVersion,
		backupId: manifest.backupId,
		createdAt: manifest.createdAt,
		consistency: manifest.consistency,
		exclusions: manifest.exclusions,
		directories: manifest.directories,
		files: manifest.files,
	};
	writeFileSync(join(backupRoot, "manifest.json"), JSON.stringify(ordered), "utf8");
}

/** 独立重算（不借助实现的字段）：与 D1 同一口径的小写十六进制 SHA-256。 */
function sha256Of(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * **等长**改写：把首个字节在 `{` 与 `[` 之间翻转。
 *
 * 为什么刻意保持长度不变：这一组要证明的正是"只比长度不看内容的检查不够"，
 * 长度变了会让用例退化成另一个更弱的检查。
 */
function flipFirstByte(path) {
	const bytes = Buffer.from(readFileSync(path));
	bytes[0] = bytes[0] === 0x7b ? 0x5b : 0x7b;
	writeFileSync(path, bytes);
	return bytes.byteLength;
}

/** 恢复必须受控拒绝，且**不得创建目标**；返回错误对象供进一步断言。 */
async function rejectWithoutTarget(backupRoot, target) {
	let caught;
	try {
		await restoreKnowledgeBackup({ backupRoot, root: target, offlineConfirmed: true });
	} catch (error) {
		caught = error;
	}
	assert.ok(caught instanceof Error, "必须抛出受控错误对象");
	assert.ok(typeof caught.code === "string" && caught.code.length > 0, "错误必须带受控类别");
	assert.equal(existsSync(target), false, "拒绝的恢复不得留下任何目标目录");
	return caught;
}

/* ------------------------------------------------------------------ 1. 备份拒绝 */

test("D3 备份拒绝：容器与清单的任何不一致都必须在创建目标前拒绝", async (t) => {
	await t.test("无 manifest：按容器不完整拒绝", async () => {
		const { backupRoot } = await exportedBackup("no-manifest");
		unlinkSync(join(backupRoot, "manifest.json"));
		const error = await rejectWithoutTarget(backupRoot, newTarget("no-manifest"));
		assert.equal(error.code, "backup-payload-mismatch");
	});

	await t.test("manifest 坏 JSON / 未来版本 / 未知字段：按清单协议非法拒绝", async () => {
		const bad = await exportedBackup("bad-json");
		writeFileSync(join(bad.backupRoot, "manifest.json"), "{ not json", "utf8");
		assert.equal((await rejectWithoutTarget(bad.backupRoot, newTarget("bad-json"))).code, "invalid-backup-manifest");

		const future = await exportedBackup("future-version");
		rewriteManifest(future.backupRoot, (manifest) => {
			manifest.backupVersion = 2;
		});
		assert.equal((await rejectWithoutTarget(future.backupRoot, newTarget("future-version"))).code, "invalid-backup-manifest");

		const unknown = await exportedBackup("unknown-field");
		const raw = readManifest(unknown.backupRoot);
		writeFileSync(join(unknown.backupRoot, "manifest.json"), JSON.stringify({ ...raw, extra: 1 }), "utf8");
		assert.equal((await rejectWithoutTarget(unknown.backupRoot, newTarget("unknown-field"))).code, "invalid-backup-manifest");
	});

	await t.test("容器根出现未声明条目：拒绝", async () => {
		const { backupRoot } = await exportedBackup("root-extra");
		writeFileSync(join(backupRoot, "extra.txt"), "x", "utf8");
		assert.equal((await rejectWithoutTarget(backupRoot, newTarget("root-extra"))).code, "backup-payload-mismatch");
	});

	await t.test("data 下出现清单未声明的文件：拒绝且不进入未知子树", async () => {
		const { backupRoot } = await exportedBackup("data-extra");
		writeFileSync(join(backupRoot, "data", "experiences", "surprise.json"), "{}", "utf8");
		assert.equal((await rejectWithoutTarget(backupRoot, newTarget("data-extra"))).code, "backup-payload-mismatch");
	});

	await t.test("缺文件 / 缺已登记空目录：拒绝", async () => {
		const missingFile = await exportedBackup("missing-file", { rich: true });
		unlinkSync(join(missingFile.backupRoot, "data", "experiences", "exp-a.json"));
		assert.equal((await rejectWithoutTarget(missingFile.backupRoot, newTarget("missing-file"))).code, "backup-payload-mismatch");

		const missingDir = await exportedBackup("missing-dir", { rich: true });
		rmdirSync(join(missingDir.backupRoot, "data", "projects", PROJECT_ID, "tasks"));
		assert.equal((await rejectWithoutTarget(missingDir.backupRoot, newTarget("missing-dir"))).code, "backup-payload-mismatch");
	});

	await t.test("错 hash（等长改写）：拒绝", async () => {
		const changed = await exportedBackup("wrong-hash");
		flipFirstByte(join(changed.backupRoot, "data", "registry.json"));
		assert.equal((await rejectWithoutTarget(changed.backupRoot, newTarget("wrong-hash"))).code, "backup-payload-mismatch");
	});

	await t.test("错长度（追加一个字节）：拒绝", async () => {
		const changed = await exportedBackup("wrong-length");
		const target = join(changed.backupRoot, "data", "registry.json");
		writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from("\n", "utf8")]));
		assert.equal((await rejectWithoutTarget(changed.backupRoot, newTarget("wrong-length"))).code, "backup-payload-mismatch");
	});

	await t.test("容器内链接（data 被顶替成目录链接）：拒绝", async (ctx) => {
		const { backupRoot } = await exportedBackup("container-link");
		const data = join(backupRoot, "data");
		const elsewhere = sandboxPath("container-link-elsewhere");
		mkdirSync(elsewhere, { recursive: true });
		renameSync(data, sandboxPath("container-link-real"));
		try {
			symlinkSync(elsewhere, data, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			assert.ok(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL", "UNKNOWN"].includes(String(error.code)), `链接失败必须是已知权限码：${String(error.code)}`);
			ctx.skip(`本机无法创建目录链接（${String(error.code)}），跳过该对照`);
			return;
		}
		assert.equal((await rejectWithoutTarget(backupRoot, newTarget("container-link"))).code, "backup-payload-mismatch");
	});

	await t.test("坏 JSON 业务文件：即使重新配好长度与 hash 也必须拒绝", async () => {
		const { backupRoot } = await exportedBackup("bad-business-json");
		const target = join(backupRoot, "data", "registry.json");
		const broken = Buffer.from("{ broken", "utf8");
		writeFileSync(target, broken);
		rewriteManifest(backupRoot, (manifest) => {
			const entry = manifest.files.find((file) => file.path === "registry.json");
			entry.bytes = broken.byteLength;
			entry.sha256 = sha256Of(broken);
		});
		const error = await rejectWithoutTarget(backupRoot, newTarget("bad-business-json"));
		assert.equal(error.code, "backup-source-not-eligible", "字节一致但业务不可解释，必须按准入失败拒绝");
	});

	await t.test("未来业务版本（schemaVersion=2）：即使重新配好 hash 也必须拒绝", async () => {
		const { backupRoot } = await exportedBackup("future-schema");
		const target = join(backupRoot, "data", "registry.json");
		const registry = JSON.parse(readFileSync(target, "utf8"));
		const future = Buffer.from(`${JSON.stringify({ ...registry, schemaVersion: registry.schemaVersion + 1 })}\n`, "utf8");
		writeFileSync(target, future);
		rewriteManifest(backupRoot, (manifest) => {
			const entry = manifest.files.find((file) => file.path === "registry.json");
			entry.bytes = future.byteLength;
			entry.sha256 = sha256Of(future);
		});
		assert.equal((await rejectWithoutTarget(backupRoot, newTarget("future-schema"))).code, "backup-source-not-eligible");
	});

	await t.test("备份容器本身不存在 / 是链接：受控参数类拒绝", async () => {
		const missingParent = sandboxPath("missing-backup-parent");
		mkdirSync(missingParent, { recursive: true });
		assert.equal((await rejectWithoutTarget(join(missingParent, "nope"), newTarget("missing-backup"))).code, "backup-argument-invalid");
	});
});

/* ------------------------------------------------------------------ 2. 预算与预检 */

test("D3 预算：0 不是无限、精确上限可过、差一必须拒绝", async (t) => {
	await t.test("maxFiles / maxFileBytes = 0：清单协议直接拒绝（0 ≠ unlimited）", async () => {
		const { backupRoot } = await exportedBackup("budget");
		// 先确认基线：默认预算下同一份备份能恢复（否则下面的拒绝可能只是备份本身坏了）。
		const baseline = newTarget("budget-baseline");
		const baselineResult = await restoreKnowledgeBackup({ backupRoot, root: baseline, offlineConfirmed: true });
		assert.equal(baselineResult.status, "restored");

		await assert.rejects(
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("budget-files0"), offlineConfirmed: true, limits: { maxFiles: 0 } }),
			(error) => error.code === "invalid-backup-manifest",
		);
		await assert.rejects(
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("budget-filebytes0"), offlineConfirmed: true, limits: { maxFileBytes: 0 } }),
			(error) => error.code === "invalid-backup-manifest",
		);
	});

	await t.test("maxTotalPayloadBytes 精确可过、差一拒绝；maxManifestBytes 同理", async () => {
		const { backupRoot } = await exportedBackup("budget-exact");
		const manifest = readManifest(backupRoot);
		const totalBytes = manifest.files.reduce((sum, file) => sum + file.bytes, 0);
		const manifestBytes = statSync(join(backupRoot, "manifest.json")).size;

		const exact = newTarget("budget-exact-ok");
		const result = await restoreKnowledgeBackup({ backupRoot, root: exact, offlineConfirmed: true, limits: { maxTotalPayloadBytes: totalBytes, maxManifestBytes: manifestBytes } });
		assert.equal(result.status, "restored");

		await assert.rejects(
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("budget-total-minus1"), offlineConfirmed: true, limits: { maxTotalPayloadBytes: totalBytes - 1 } }),
			(error) => error.code === "invalid-backup-manifest",
		);
		await assert.rejects(
			// 差一可能落在"读取上限"（too-large）或"清单协议"（invalid-backup-manifest）上，
			// 两者都是受控拒绝；关键是**不能通过**。
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("budget-manifest-minus1"), offlineConfirmed: true, limits: { maxManifestBytes: manifestBytes - 1 } }),
			(error) => ["invalid-backup-manifest", "too-large"].includes(error.code),
		);
	});

	await t.test("预检截断 / 摘要裁剪：不得当通过，必须按准入失败拒绝", async () => {
		const { backupRoot } = await exportedBackup("preflight-budget");
		await assert.rejects(
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("preflight-scan1"), offlineConfirmed: true, preflightLimits: { maxScanEntries: 1 } }),
			(error) => error.code === "backup-source-not-eligible",
			"预检截断（incomplete）不能当成可恢复",
		);
		await assert.rejects(
			() => restoreKnowledgeBackup({ backupRoot, root: newTarget("preflight-summaries0"), offlineConfirmed: true, preflightLimits: { maxFileSummaries: 0 } }),
			(error) => error.code === "backup-source-not-eligible",
			"诊断被预算裁剪也不能当成可恢复",
		);
	});
});

/* ------------------------------------------------------------------ 3. 恢复中源变化 */

test("D3 源变化：复制期间备份增删或等长改写都不得完成", async (t) => {
	/** 在目标侧第一次出现读操作时改写备份（复制阶段之后、复核之前）。 */
	function mutateBackupOnTargetRead(targetRoot, mutate) {
		let fired = false;
		return {
			beforeIo: (operation, path) => {
				if (fired || operation !== "open" || !path.startsWith(targetRoot) || !path.endsWith(".json")) return undefined;
				fired = true;
				mutate();
				return undefined;
			},
		};
	}

	const cases = {
		等长改写一个数据文件: (backupRoot) => {
			flipFirstByte(join(backupRoot, "data", "experiences", "exp-a.json"));
		},
		新增一个未声明文件: (backupRoot) => {
			writeFileSync(join(backupRoot, "data", "experiences", "injected.json"), "{}", "utf8");
		},
		删除一个已声明文件: (backupRoot) => {
			unlinkSync(join(backupRoot, "data", "features", "feat-1.json"));
		},
		"把 registry 等长改写": (backupRoot) => {
			flipFirstByte(join(backupRoot, "data", "registry.json"));
		},
		增长一个已声明文件: (backupRoot) => {
			const target = join(backupRoot, "data", "features", "feat-1.json");
			writeFileSync(target, Buffer.concat([readFileSync(target), Buffer.from(" ", "utf8")]));
		},
	};

	for (const [label, mutate] of Object.entries(cases)) {
		await t.test(label, async () => {
			const { backupRoot } = await exportedBackup(`change-${label.length}`, { rich: true });
			const target = newTarget("change");
			let caught;
			try {
				await restoreKnowledgeBackup({ backupRoot, root: target, offlineConfirmed: true, ioHooks: mutateBackupOnTargetRead(target, () => mutate(backupRoot)) });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error, `复制期间备份变化必须导致失败：${label}`);
			assert.ok(["backup-payload-mismatch", "not-found", "backup-source-not-eligible"].includes(caught.code), `受控类别应可预期，实际 ${caught.code}`);
			assert.equal(caught.facts.published, false, "未发布");
			assert.equal(existsSync(join(target, "registry.json")), false, "不得发布 registry");
		});
	}
});

/* ------------------------------------------------------------------ 4. 生命周期、IO 与提交事实 */

/** 在独立子进程里包装 `fs.promises`（句柄/list/lstat），复现真实 IO 缺陷。 */
function restoreInChildWithIoDefect({ mode, backupRoot, root, extra = {} }) {
	const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const config = JSON.parse(process.env.RESTORE_IO_CONFIG);
const fsPromises = require("node:fs/promises");
const realOpen = fsPromises.open;
const realLstat = fsPromises.lstat;
let linkFailed = false;
if (config.mode === "short-write") {
	fsPromises.open = async (...args) => {
		const handle = await realOpen(...args);
		return new Proxy(handle, {
			get(target, prop) {
				if (prop === "write") return async (buffer, offset, length, ...rest) => target.write(buffer, offset, Math.min(3, length), ...rest);
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
}
if (config.mode === "sync-fail") {
	fsPromises.open = async (...args) => {
		const handle = await realOpen(...args);
		return new Proxy(handle, {
			get(target, prop) {
				if (prop === "sync") return async () => { const error = new Error("injected sync failure"); error.code = "EIO"; throw error; };
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
	};
}
if (config.mode === "link-fail" || config.mode === "link-fail-cleanup-eio") {
	fsPromises.link = async () => { linkFailed = true; const error = new Error("injected link failure"); error.code = "ENOSYS"; throw error; };
}
if (config.mode === "link-fail-cleanup-eio") {
	// 只在 link 失败**之后**让目标临时文件的 lstat 不可核对：清理必须如实报残留，不能虚报 ok。
	fsPromises.lstat = async (path, ...rest) => {
		if (linkFailed && typeof path === "string" && path.endsWith(".tmp")) { const error = new Error("injected lstat failure"); error.code = "EIO"; throw error; }
		return realLstat(path, ...rest);
	};
}
const storage = await import(config.entryUrl);
try {
	const result = await storage.restoreKnowledgeBackup({ backupRoot: config.backupRoot, root: config.root, offlineConfirmed: true });
	process.stdout.write(JSON.stringify({ ok: true, status: result.status, cleanup: result.cleanup, residuals: result.residuals, reviewReasons: result.reviewReasons }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error?.code ?? "unclassified", detail: error?.detail ?? null, published: error?.facts?.published ?? null, cleanup: error?.facts?.cleanup ?? null, residuals: error?.facts?.residuals ?? null }));
}
`;
	return JSON.parse(
		execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: PACKAGE_ROOT,
			timeout: 60_000,
			env: { ...process.env, RESTORE_IO_CONFIG: JSON.stringify({ mode, backupRoot, root, ...extra, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
			encoding: "utf8",
		}),
	);
}

test("D3 生命周期：短写写完整、sync/link 失败阻止发布、清理不可核对如实报残留", async (t) => {
	await t.test("短写（每次最多 3 字节）：仍必须逐字节恢复成功", async () => {
		const { root, backupRoot } = await exportedBackup("io-short-write", { rich: true });
		const target = newTarget("io-short-write");
		const outcome = restoreInChildWithIoDefect({ mode: "short-write", backupRoot, root: target });
		assert.equal(outcome.ok, true, `短写必须被循环处理：${JSON.stringify(outcome)}`);
		assert.equal(outcome.status, "restored");
		// 独立对照：目标与源逐字节一致（不是"只写了前 3 字节"）。
		for (const relative of ["registry.json", join("experiences", "exp-a.json"), join("features", "feat-1.json")]) {
			assert.deepEqual(readFileSync(join(target, relative)), readFileSync(join(root, relative)), `${relative} 必须逐字节一致`);
		}
	});

	await t.test("sync 失败：不发布 registry，按归属清理本次创建内容", async () => {
		const { backupRoot } = await exportedBackup("io-sync-fail", { rich: true });
		const target = newTarget("io-sync-fail");
		const outcome = restoreInChildWithIoDefect({ mode: "sync-fail", backupRoot, root: target });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.published, false, "未到提交点");
		assert.equal(existsSync(join(target, "registry.json")), false, "不得发布 registry");
		assert.equal(existsSync(target), false, "提交点前的失败必须把目标清干净");
	});

	await t.test("link 失败（平台不支持非覆盖发布）：受控拒绝且无完成标记", async () => {
		const { backupRoot } = await exportedBackup("io-link-fail");
		const target = newTarget("io-link-fail");
		const outcome = restoreInChildWithIoDefect({ mode: "link-fail", backupRoot, root: target });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.code, "publish-unsupported");
		assert.equal(outcome.published, false);
		assert.equal(existsSync(join(target, "registry.json")), false);
	});

	await t.test("提交前失败 + 清理 lstat 不可核对（单路径 EIO）：cleanup=failed、有界残留、现场保留", async () => {
		const { backupRoot } = await exportedBackup("io-cleanup-eio");
		const target = newTarget("io-cleanup-eio");
		const outcome = restoreInChildWithIoDefect({ mode: "link-fail-cleanup-eio", backupRoot, root: target });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.published, false);
		assert.equal(outcome.cleanup, "failed", "不可核对不得被当成已清理");
		assert.ok(Array.isArray(outcome.residuals) && outcome.residuals.length >= 1, "必须报告有界残留");
		assert.equal(existsSync(join(target, "registry.json")), false);
		assert.ok(
			readdirSync(target).some((name) => name.endsWith(".tmp")),
			"无法核对的临时文件必须留在磁盘上（不妄删）",
		);
	});
});

test("D3 IO 与取消：句柄关闭失败、取得后取消、发布前/后取消的事实都可观察", async (t) => {
	await t.test("恢复目标写入句柄关闭失败（真实关闭后抛 EIO）：不发布，不留假成功", async () => {
		const { backupRoot } = await exportedBackup("close-target", { rich: true });
		const target = newTarget("close-target");
		let injected = false;
		let writeSeen = false;
		await assert.rejects(
			() =>
				restoreKnowledgeBackup({
					backupRoot,
					root: target,
					offlineConfirmed: true,
					ioHooks: {
						// 只在目标侧写过一次之后才注入，确保打的是"恢复目标写入句柄"的关闭。
						beforeIo: (operation) => {
							if (operation === "backup-write") writeSeen = true;
							return undefined;
						},
						closeFile: async (handle) => {
							// 真实关闭完成之后再抛受控 EIO：证明"关掉了却报错"也必须中止。
							await handle.close();
							if (injected || !writeSeen) return;
							injected = true;
							throw new StorageError("permission-denied", "injected close failure", { detail: "close-eio" });
						},
					},
				}),
			(error) => error.facts?.published === false,
		);
		assert.equal(injected, true, "注入必须真的触发");
		assert.equal(existsSync(join(target, "registry.json")), false, "不得发布 registry");
	});

	await t.test("取得目标后取消（mkdir 等待期间）：cancelled + 目标被清理", async () => {
		const { backupRoot } = await exportedBackup("cancel-after-acquire");
		const target = newTarget("cancel-after-acquire");
		const controller = new AbortController();
		let injected = false;
		await assert.rejects(
			() =>
				restoreKnowledgeBackup({
					backupRoot,
					root: target,
					offlineConfirmed: true,
					signal: controller.signal,
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "mkdir" || path !== target) return undefined;
							injected = true;
							controller.abort();
							return undefined;
						},
					},
				}),
			(error) => error.code === "cancelled" && error.facts.published === false,
		);
		assert.equal(injected, true);
		assert.equal(existsSync(target), false, "取消必须把本次创建的空目标清掉");
	});

	await t.test("registry 发布前取消（link 等待期间）：不发布、目标清理、无残留", async () => {
		const { backupRoot } = await exportedBackup("cancel-before-publish", { rich: true });
		const target = newTarget("cancel-before-publish");
		const controller = new AbortController();
		let injected = false;
		await assert.rejects(
			() =>
				restoreKnowledgeBackup({
					backupRoot,
					root: target,
					offlineConfirmed: true,
					signal: controller.signal,
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "link" || path !== join(target, "registry.json")) return undefined;
							injected = true;
							controller.abort();
							return undefined;
						},
					},
				}),
			(error) => error.code === "cancelled" && error.facts.published === false,
		);
		assert.equal(injected, true);
		assert.equal(existsSync(target), false, "发布前的取消必须按归属清干净");
	});

	await t.test("registry 发布后取消：报告已提交需复核，绝不删除已恢复的库", async () => {
		const { backupRoot } = await exportedBackup("cancel-after-publish", { rich: true });
		const target = newTarget("cancel-after-publish");
		const controller = new AbortController();
		let injected = false;
		const result = await restoreKnowledgeBackup({
			backupRoot,
			root: target,
			offlineConfirmed: true,
			signal: controller.signal,
			ioHooks: {
				beforeIo: (operation, path) => {
					if (injected || operation !== "open" || path !== join(target, "registry.json")) return undefined;
					injected = true;
					controller.abort();
					return undefined;
				},
			},
		});
		assert.equal(injected, true, "发布后复核必须真的被触发");
		assert.equal(result.published, true, "提交点已过");
		assert.equal(result.status, "committed-needs-review", "发布后取消只能报需复核，不能报未写入");
		assert.ok(result.reviewReasons.length >= 1);
		assert.equal(existsSync(join(target, "registry.json")), true, "不得删除已恢复的库");
		assert.deepEqual(readFileSync(join(target, "registry.json")), readFileSync(join(backupRoot, "data", "registry.json")));
	});
});

/* ------------------------------------------------------------------ 6. R26-1 源完成标记变化 */

/** 在**第一次目标写入**（`backup-write`）时改写备份的完成标记；不抛错，让流程走到源复核。 */
function mutateManifestOnFirstTargetWrite(mutate) {
	let fired = false;
	return {
		beforeIo: (operation) => {
			if (fired || operation !== "backup-write") return undefined;
			fired = true;
			mutate();
			return undefined;
		},
	};
}

test("R26-1：复制期间备份完成标记变化必须拒绝完成（原字节指纹参与复核）", async (t) => {
	const cases = {
		"未来版本（backupVersion 1→2）": (backupRoot) => {
			rewriteManifest(backupRoot, (manifest) => {
				manifest.backupVersion = 2;
			});
		},
		"合法等长变化（换一个仍合法的 backupId）": (backupRoot) => {
			const before = statSync(join(backupRoot, "manifest.json")).size;
			rewriteManifest(backupRoot, (manifest) => {
				manifest.backupId = `${manifest.backupId[0] === "x" ? "y" : "x"}${manifest.backupId.slice(1)}`;
			});
			assert.equal(statSync(join(backupRoot, "manifest.json")).size, before, "等长改写必须保持字节数不变，否则用例退化成更弱的检查");
		},
		直接删除完成标记: (backupRoot) => {
			unlinkSync(join(backupRoot, "manifest.json"));
		},
	};

	for (const [label, mutate] of Object.entries(cases)) {
		await t.test(label, async () => {
			const { backupRoot } = await exportedBackup(`r26-1-${label.length}`, { rich: true });
			const backupBefore = snapshotTree(backupRoot);
			const target = newTarget("r26-1");
			let caught;
			try {
				await restoreKnowledgeBackup({ backupRoot, root: target, offlineConfirmed: true, ioHooks: mutateManifestOnFirstTargetWrite(() => mutate(backupRoot)) });
			} catch (error) {
				caught = error;
			}
			assert.ok(caught instanceof Error, `${label} 必须受控拒绝`);
			assert.equal(caught.code, "backup-source-changed", `必须是源变化类别，实际 ${caught.code}`);
			assert.equal(caught.facts.published, false, "完成点之前必须未发布");
			assert.equal(existsSync(join(target, "registry.json")), false, "不得发布 registry");
			// 备份现场只读保留：除被注入的 manifest 外，其余字节不变。
			if (label !== "直接删除完成标记") {
				assert.equal(
					snapshotTree(backupRoot)
						.filter((entry) => !entry.includes("manifest.json"))
						.join("\n"),
					backupBefore.filter((entry) => !entry.includes("manifest.json")).join("\n"),
				);
			}
		});
	}

	await t.test("静态合法原字节：同一份清单照常恢复成功（基线）", async () => {
		const { root, backupRoot } = await exportedBackup("r26-1-baseline");
		const target = newTarget("r26-1-baseline");
		const result = await restoreKnowledgeBackup({ backupRoot, root: target, offlineConfirmed: true });
		assert.equal(result.status, "restored");
		assertRestoredByteIdentical(root, target);
	});

	await t.test("换成另一份**同样合法**的清单（同一形状、不同 backupId）也必须拒绝", async () => {
		const { backupRoot } = await exportedBackup("r26-1-swap-a", { rich: true });
		const other = await exportedBackup("r26-1-swap-b", { rich: true });
		const target = newTarget("r26-1-swap");
		let caught;
		try {
			await restoreKnowledgeBackup({
				backupRoot,
				root: target,
				offlineConfirmed: true,
				ioHooks: mutateManifestOnFirstTargetWrite(() => {
					// 另一份备份的清单：目录/文件集合完全一致，只有 backupId/createdAt 不同，
					// 因此"只比集合"的复核会漏掉它 —— 指纹比较必须发现。
					writeFileSync(join(backupRoot, "manifest.json"), readFileSync(join(other.backupRoot, "manifest.json")));
				}),
			});
		} catch (error) {
			caught = error;
		}
		assert.ok(caught instanceof Error);
		assert.equal(caught.code, "backup-source-changed");
		assert.equal(caught.facts.published, false);
		assert.equal(existsSync(join(target, "registry.json")), false);
	});

	await t.test("完成标记被换成链接：类型核对拒绝且不跟随", async (ctx) => {
		const { backupRoot } = await exportedBackup("r26-1-link");
		const manifestPath = join(backupRoot, "manifest.json");
		const elsewhere = sandboxPath("r26-1-elsewhere.json");
		writeFileSync(elsewhere, readFileSync(manifestPath));
		unlinkSync(manifestPath);
		try {
			symlinkSync(elsewhere, manifestPath, "file");
		} catch (error) {
			assert.ok(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL", "UNKNOWN"].includes(String(error.code)), `链接失败必须是已知权限码：${String(error.code)}`);
			ctx.skip(`本机无法创建文件型链接（${String(error.code)}），跳过该对照`);
			return;
		}
		const error = await rejectWithoutTarget(backupRoot, newTarget("r26-1-link"));
		assert.equal(error.code, "backup-payload-mismatch", "完成标记必须是常规文件");
	});
});

/* ------------------------------------------------------------------ 7. R26-2 目标晚期漂移 */

/** 只在**第 n 次**打开指定路径之前触发一次（确定性阶段 hook，不靠 sleep）。 */
function onNthOpen(path, nth, action) {
	let seen = 0;
	return {
		beforeIo: (operation, target) => {
			if (operation !== "open" || target !== path) return undefined;
			seen += 1;
			if (seen === nth) action();
			return undefined;
		},
	};
}

test("R26-2：目标晚期合法改写不得返回无警告的原字节恢复成功", async (t) => {
	/**
	 * 源复核阶段的确定性标记：`manifest.json` 在整个流程里恰好被读两次
	 * （准入 1 次、`assertBackupManifestUnchanged` 1 次），**第 2 次**就是复核对完成点之前那段窗口的入口。
	 * 用阶段标记而不是 sleep，命中即断言。
	 */
	const atSourceRecheck = (backupRoot, action) => onNthOpen(join(backupRoot, "manifest.json"), 2, action);

	for (const [label, drift] of Object.entries({
		目标文件被合法改写: (target) => {
			const featureTarget = join(target, "features", "feat-1.json");
			const parsed = JSON.parse(readFileSync(featureTarget, "utf8"));
			// **合法** JSON：预检能解释它，但它不再是清单声明的那些字节。
			writeFileSync(featureTarget, `${JSON.stringify({ ...parsed, originalRequirement: "被晚期改写的需求" })}\n`, "utf8");
		},
		目标多出一个未声明文件: (target) => {
			writeFileSync(join(target, "features", "late-extra.json"), "{}", "utf8");
		},
		目标被删掉一个已声明文件: (target) => {
			unlinkSync(join(target, "features", "feat-1.json"));
		},
	})) {
		await t.test(`${label} ⇒ 完成点前拒绝发布`, async () => {
			const { backupRoot } = await exportedBackup(`r26-2-${label.length}`, { rich: true });
			const target = newTarget("r26-2-pre");
			let injected = false;
			let caught;
			try {
				await restoreKnowledgeBackup({
					backupRoot,
					root: target,
					offlineConfirmed: true,
					ioHooks: atSourceRecheck(backupRoot, () => {
						injected = true;
						drift(target);
					}),
				});
			} catch (error) {
				caught = error;
			}
			assert.equal(injected, true, "注入必须真的命中");
			assert.ok(caught instanceof Error, "完成点前的目标漂移必须拒绝发布");
			assert.equal(caught.facts.published, false, "完成点之前必须未发布");
			assert.equal(existsSync(join(target, "registry.json")), false, "不得发布 registry");
		});
	}

	await t.test("发布后 registry 被合法改写 ⇒ committed-needs-review，published=true，库保留", async () => {
		const { backupRoot } = await exportedBackup("r26-2-post", { rich: true });
		const target = newTarget("r26-2-post");
		const registryTarget = join(target, "registry.json");
		let injected = false;
		const result = await restoreKnowledgeBackup({
			backupRoot,
			root: target,
			offlineConfirmed: true,
			// 发布后第一次读目标 registry：改成"仍是合法 registry、但字节不同"的内容。
			ioHooks: onNthOpen(registryTarget, 1, () => {
				injected = true;
				const published = JSON.parse(readFileSync(registryTarget, "utf8"));
				writeFileSync(registryTarget, Buffer.from(`${JSON.stringify({ ...published, revision: published.revision + 1 })}\n`, "utf8"));
			}),
		});
		assert.equal(injected, true, "注入必须真的命中");
		assert.equal(result.status, "committed-needs-review", "可观察的字节漂移不能报 restored");
		assert.equal(result.published, true, "提交点已过");
		assert.ok(result.reviewReasons.includes("verify-restored-drift"));
		// 库保留：不许用清理删掉可观察到的变化来"强行通过"。
		assert.equal(existsSync(registryTarget), true);
		assert.notDeepEqual(readFileSync(registryTarget), readFileSync(join(backupRoot, "data", "registry.json")));
	});
});

/* ------------------------------------------------------------------ 5. 只读与兼容 */

test("D3 只读：成功与失败前后原库与备份的字节及完整集合都不变", async () => {
	const { root, backupRoot } = await exportedBackup("readonly", { rich: true });
	const sourceBefore = snapshotTree(root);
	const backupBefore = snapshotTree(backupRoot);

	// 成功一次。
	await restoreKnowledgeBackup({ backupRoot, root: newTarget("readonly-ok"), offlineConfirmed: true });
	assert.deepEqual(snapshotTree(root), sourceBefore, "恢复不得修改源知识库");
	assert.deepEqual(snapshotTree(backupRoot), backupBefore, "恢复不得修改备份容器");

	// 失败一次（目标已存在）。
	const occupied = newTarget("readonly-fail");
	mkdirSync(occupied, { recursive: true });
	await assert.rejects(
		() => restoreKnowledgeBackup({ backupRoot, root: occupied, offlineConfirmed: true }),
		(error) => error.code === "backup-target-exists",
	);
	assert.deepEqual(snapshotTree(root), sourceBefore, "失败不得修改源知识库");
	assert.deepEqual(snapshotTree(backupRoot), backupBefore, "失败不得修改备份容器");
});

test("D3 只读：恢复目标的目录集合由清单派生，不把旧 cache/locks 带进来", async () => {
	const { backupRoot } = await exportedBackup("layout", { rich: true });
	const target = newTarget("layout");
	await restoreKnowledgeBackup({ backupRoot, root: target, offlineConfirmed: true });
	const manifest = readManifest(backupRoot);
	const directories = snapshotTree(target)
		.filter((entry) => entry.startsWith("d:"))
		.map((entry) => entry.slice(2))
		.sort();
	const expected = [...manifest.directories, "cache", "locks"].sort();
	assert.deepEqual(directories, expected, "目标目录集合必须恰好是清单目录 + 空 cache/locks");
	assert.deepEqual(readdirSync(join(target, "cache")), []);
	assert.deepEqual(readdirSync(join(target, "locks")), []);
});
