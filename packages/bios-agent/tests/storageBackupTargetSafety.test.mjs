/**
 * BM-02D2R：目标边界/归属、容器完整集合、生命周期事实与公共错误脱敏的**永久回归**。
 *
 * 这一组用例逐条对应 [当前回归清单](docs/bios-agent/test_checklist.md)（历史编号保留） 的 D2-1～D2-4：
 * 旧实现下它们必须红（D2-1 会删掉目标外的 sentinel；D2-2 会照发完成标记；D2-3 会留空目标/
 * 迟到发布；D2-4 会把原始异常正文与源绝对路径传出去），修后必须绿。
 *
 * 全部使用自建临时沙箱与合成库，不读真实客户资料；junction 用真实 `symlinkSync(..., "junction")`，
 * 本机建不出来时**显式 skip**，不用空通过占位。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { StorageError, createRecord, exportKnowledgeBackup, initializeKnowledgeStore } from "../core/storage/index.ts";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-backup-d2r-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

/**
 * 只有**已知的权限/平台不可用码**才允许把 junction 对照 skip（R24 §5 纪律）：
 * 其它异常说明注入本身出了别的问题，必须让用例变红，不能把"错误成功"记成"平台不支持"。
 */
const JUNCTION_UNAVAILABLE_CODES = new Set(["EPERM", "EACCES", "ENOSYS", "ENOTSUP", "EINVAL", "UNKNOWN"]);
function junctionUnavailable(error) {
	return error !== undefined && JUNCTION_UNAVAILABLE_CODES.has(String(error.code));
}

const NOW = 1_700_000_000_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
let counter = 0;

function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

async function makeStore(name) {
	const root = sandboxPath(name);
	await initializeKnowledgeStore({ root });
	await createRecord({
		root,
		kind: "experience-card",
		id: "exp-a",
		expectedRevision: null,
		now: NOW,
		data: { problem: "PXE 默认开启", rootCause: "默认值", solution: "关闭 PXE", appliesWhen: [], doesNotApplyWhen: [], sourceProjectId: PROJECT_ID, evidence: [], validations: [], reuseScope: { level: "current-project", customers: [] }, status: "reviewed" },
	});
	return realpathSync(root);
}

function targetOf(name) {
	const parent = sandboxPath(`${name}-parent`);
	mkdirSync(parent, { recursive: true });
	return { parent, target: join(parent, "backup") };
}

/** 递归清单（含每个文件的字节），用于"源与外部目录未被改动"的断言。 */
function walk(root) {
	const out = [];
	const visit = (absolute) => {
		let entries;
		try {
			entries = readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1));
		} catch {
			return;
		}
		for (const entry of entries) {
			const path = join(absolute, entry.name);
			if (entry.isDirectory()) {
				out.push(`d:${path.slice(root.length)}`);
				visit(path);
				continue;
			}
			out.push(`f:${path.slice(root.length)}:${readFileSync(path).toString("base64")}`);
		}
	};
	visit(root);
	return out;
}

function exportOptions(root, backupRoot, extra = {}) {
	return { root, backupRoot, offlineConfirmed: true, now: NOW, backupId: "backup-d2r", ...extra };
}

function assertSanitized(error, expectedCode) {
	assert.ok(error instanceof Error, "必须抛出受控错误对象");
	assert.equal(error.code, expectedCode, `必须是受控类别 ${expectedCode}，实际 ${String(error.code)}`);
	assert.ok(error.facts !== undefined, "必须带结构化收尾事实");
	assert.equal(typeof error.facts.phase, "string");
	assert.equal(typeof error.facts.published, "boolean");
	assert.ok(["ok", "failed"].includes(error.facts.cleanup));
	return error;
}

/* ------------------------------------------------------------------ D2-1 归属与边界 */

test("D2R/D2-1：目标归属与边界", async (t) => {
	await t.test("原复现：data 被换成 junction 后清理不得删除目标外 sentinel（真实 junction）", async (ctx) => {
		const root = await makeStore("d2r-junction");
		const { target } = targetOf("d2r-junction");
		const ownedData = sandboxPath("d2r-owned-data");
		const outside = sandboxPath("d2r-outside");
		mkdirSync(outside, { recursive: true });
		const sentinel = join(outside, "registry.json");
		writeFileSync(sentinel, "UNRELATED SENTINEL", "utf8");
		const sourceBefore = walk(root);
		let injected = false;
		let error;

		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "open" || !path.startsWith(target) || !path.endsWith("registry.json")) return undefined;
							injected = true;
							// 第二十二轮 §3 的五步复现：把自有 data 挪走，再用 junction 顶替它的名字。
							renameSync(join(target, "data"), ownedData);
							try {
								symlinkSync(outside, join(target, "data"), "junction");
							} catch {
								throw new StorageError("backup-payload-mismatch", "本机无法创建 junction", { detail: "junction-unavailable" });
							}
							throw new StorageError("backup-payload-mismatch", "注入失败：触发清理", { detail: "injected" });
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}

		if (error?.detail === "junction-unavailable") {
			ctx.skip("本机无法创建 junction（EPERM），跳过该对照");
			return;
		}
		assert.equal(injected, true, "注入必须真的触发");
		assertSanitized(error, "backup-payload-mismatch");
		assert.equal(error.facts.published, false);
		assert.equal(error.facts.cleanup, "failed", "归属不明必须如实报告清理失败");
		assert.ok(error.facts.residuals.length >= 1, JSON.stringify(error.facts));

		// **核心断言**：目标外的 sentinel 与顶替上去的 junction 都必须还在，且内容不变。
		assert.equal(existsSync(sentinel), true, "目标外 sentinel 不得被删除");
		assert.equal(readFileSync(sentinel, "utf8"), "UNRELATED SENTINEL", "目标外 sentinel 内容不得被改写");
		assert.equal(existsSync(join(outside, "experiences")), false, "不得穿过 junction 在目标外创建目录");
		const replacement = statSync(join(target, "data"));
		assert.equal(replacement.isSymbolicLink(), false, "junction 在 statSync 下不该被当成普通目录");
		assert.equal(readFileSync(join(target, "data", "registry.json"), "utf8"), "UNRELATED SENTINEL", "顶替物及其内容必须保留");
		// 被我挪走的自有 data 仍然存在：清理不得穿过未知祖先去删它。
		assert.equal(existsSync(ownedData), true);
		assert.deepEqual(walk(root), sourceBefore, "源知识库不得被修改");
	});

	await t.test("目标父目录是 junction 时拒绝，且不创建任何输出", async (ctx) => {
		const root = await makeStore("d2r-parent-link");
		const parentHolder = sandboxPath("d2r-parent-link-holder");
		const realParent = sandboxPath("d2r-parent-real");
		mkdirSync(parentHolder, { recursive: true });
		mkdirSync(realParent, { recursive: true });
		const linked = join(parentHolder, "linked");
		try {
			symlinkSync(realParent, linked, "junction");
		} catch (error) {
			assert.equal(junctionUnavailable(error), true, `junction 创建异常必须是已知权限/平台码：${String(error.code)}`);
			ctx.skip(`本机无法创建 junction（${String(error.code)}），跳过父链链接对照`);
			return;
		}
		const target = join(linked, "backup");
		await assert.rejects(
			() => exportKnowledgeBackup(exportOptions(root, target)),
			(error) => assertSanitized(error, "backup-argument-invalid").detail === "parent-chain-link",
		);
		assert.equal(existsSync(join(realParent, "backup")), false, "不得穿过链接在真实父目录下创建目标");
	});
});

/* ------------------------------------------------------------------ D2-2 容器完整集合 */

test("D2R/D2-2：容器实际集合必须与清单完全一致", async (t) => {
	await t.test("多出未声明文件：拒绝发布，且保留未知归属（不静默删除）", async () => {
		const root = await makeStore("d2r-extra");
		const { target } = targetOf("d2r-extra");
		let injected = false;
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "open" || !path.startsWith(target)) return undefined;
							injected = true;
							writeFileSync(join(target, "data", "extra-secret.txt"), "UNDECLARED", "utf8");
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assert.equal(injected, true);
		assertSanitized(error, "backup-payload-mismatch");
		assert.equal(error.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false, "集合不一致时不得发布完成标记");
		const extra = join(target, "data", "extra-secret.txt");
		assert.equal(existsSync(extra), true, "未知归属的额外文件必须保留（不静默删除）");
		assert.equal(readFileSync(extra, "utf8"), "UNDECLARED");
		assert.equal(error.facts.cleanup, "failed", "有未知归属残留时必须如实报告");
	});

	await t.test("缺掉一个空目录：拒绝发布（不能只逐个打开声明文件）", async () => {
		const root = await makeStore("d2r-missing-dir");
		const { target } = targetOf("d2r-missing-dir");
		let injected = false;
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "open" || !path.startsWith(target)) return undefined;
							injected = true;
							rmSync(join(target, "data", "features"), { recursive: true, force: true });
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assert.equal(injected, true);
		assertSanitized(error, "backup-payload-mismatch");
		assert.equal(existsSync(join(target, "manifest.json")), false);
	});

	await t.test("目录被换成链接：拒绝发布", async (ctx) => {
		const root = await makeStore("d2r-link-dir");
		const { target } = targetOf("d2r-link-dir");
		const outside = sandboxPath("d2r-link-outside");
		mkdirSync(outside, { recursive: true });
		let injected = false;
		let junctionError;
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "open" || !path.startsWith(target)) return undefined;
							injected = true;
							rmSync(join(target, "data", "features"), { recursive: true, force: true });
							try {
								symlinkSync(outside, join(target, "data", "features"), "junction");
							} catch (cause) {
								junctionError = cause;
							}
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		// 只允许"真实 junction 创建发生已知权限失败"时 skip；注入可用却错误成功必须红（R23 纪律）。
		if (junctionError !== undefined) {
			assert.equal(junctionUnavailable(junctionError), true, `junction 创建异常必须是已知权限/平台码：${String(junctionError.code)}`);
			ctx.skip(`本机无法创建 junction（${String(junctionError.code)}），跳过容器内链接对照`);
			return;
		}
		assertSanitized(error, "backup-payload-mismatch");
		assert.equal(existsSync(join(target, "manifest.json")), false);
	});
});

/* ------------------------------------------------------------------ D2-3 生命周期事实 */

test("D2R/D2-3：取得、取消、关闭、发布与清理事实", async (t) => {
	await t.test("取得目标时取消：不留无主空目标，facts 报告阶段与清理结果", async () => {
		const root = await makeStore("d2r-cancel-acquire");
		const { target } = targetOf("d2r-cancel-acquire");
		const controller = new AbortController();
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					signal: controller.signal,
					ioHooks: {
						beforeIo: (operation, path) => {
							if (operation === "mkdir" && path === target) controller.abort();
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "cancelled");
		assert.equal(error.facts.phase, "acquire-target");
		assert.equal(error.facts.published, false);
		assert.equal(existsSync(target), false, "取得目标后的取消必须把空目标清理掉");
	});

	await t.test("发布 link 前取消：不得发布完成标记", async () => {
		const root = await makeStore("d2r-cancel-link");
		const { target } = targetOf("d2r-cancel-link");
		const controller = new AbortController();
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					signal: controller.signal,
					ioHooks: {
						beforeIo: (operation) => {
							if (operation === "link") controller.abort();
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "cancelled");
		assert.equal(error.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false, "未到提交点不得发布完成标记");
		assert.equal(existsSync(target), false, "取消必须清理本次创建的内容");
	});

	await t.test("link 失败：无完成标记、无临时残留、清理事实为 ok", async () => {
		const root = await makeStore("d2r-link-fail");
		const { target } = targetOf("d2r-link-fail");
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation) => {
							if (operation === "link") throw new StorageError("publish-unsupported", "注入：link 不可用", { detail: "injected-link" });
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "publish-unsupported");
		assert.equal(error.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false);
		assert.equal(existsSync(target), false, "发布失败必须清理临时文件与本次创建的目录");
	});

	await t.test("发布临时文件 close 实际关闭后抛 EIO：阻止发布且不留 tmp", async () => {
		const root = await makeStore("d2r-close-fail");
		const { target } = targetOf("d2r-close-fail");
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						closeFile: async (handle) => {
							await handle.close();
							const injected = new Error("injected close failure");
							injected.code = "EIO";
							throw injected;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assert.ok(error !== undefined, "close 失败必须让本次导出失败");
		assert.equal(error.facts?.published, false, "正常准备阶段关不掉句柄就不能进入发布");
		assert.equal(existsSync(join(target, "manifest.json")), false);
	});

	await t.test("提交后删临时文件失败：published=true、cleanup=failed、残留如实报告（子进程注入 unlink）", async () => {
		const root = await makeStore("d2r-post-commit");
		const { target } = targetOf("d2r-post-commit");
		const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const config = JSON.parse(process.env.BACKUP_D2R_CONFIG);
const fsPromises = require("node:fs/promises");
const realUnlink = fsPromises.unlink;
// 只让 manifest 临时文件的删除失败，其余删除照常（否则清理也一起失真）。
fsPromises.unlink = async (path, ...rest) => {
	if (typeof path === "string" && path.endsWith(".tmp")) {
		const error = new Error("injected unlink failure");
		error.code = "EACCES";
		throw error;
	}
	return realUnlink(path, ...rest);
};
require("node:module").syncBuiltinESMExports();
const { exportKnowledgeBackup } = await import(config.entryUrl);
try {
	const result = await exportKnowledgeBackup({ root: config.root, backupRoot: config.backupRoot, offlineConfirmed: true, now: 1700000000000, backupId: "backup-d2r" });
	process.stdout.write(JSON.stringify({ ok: true, published: result.published, cleanup: result.cleanup, residuals: result.residuals }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error && error.code ? error.code : "unknown", facts: error && error.facts ? error.facts : null }));
}
`;
		const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
			cwd: PACKAGE_ROOT,
			env: { ...process.env, BACKUP_D2R_CONFIG: JSON.stringify({ root, backupRoot: target, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/backup/index.ts")).href }) },
			encoding: "utf8",
		});
		const outcome = JSON.parse(stdout);
		assert.equal(outcome.ok, true, `提交必须成功，临时残留只影响 cleanup：${stdout}`);
		assert.equal(outcome.published, true, "link 已成功 ⇒ 完成标记已发布，不得回滚");
		assert.equal(outcome.cleanup, "failed", "删临时文件失败必须报告 cleanup=failed");
		assert.ok(
			outcome.residuals.some((path) => path.endsWith(".tmp")),
			JSON.stringify(outcome.residuals),
		);
		assert.equal(existsSync(join(target, "manifest.json")), true, "已提交的完成标记必须保留");
		assert.ok(
			readdirSync(target).some((name) => name.endsWith(".tmp")),
			"残留必须如实留在磁盘上（不假称已清理）",
		);
	});
});

/* ------------------------------------------------------------------ A3 短写 / sync 真实 IO */

/**
 * 在独立子进程里包装 `fs.promises.open` 返回的**句柄**（不替换整套文件系统）：
 * - `short-write`：每次最多写 3 字节，验证写入循环真的把短写循环处理完（而不是只写一次）；
 * - `sync-fail`：`sync()` 抛受控 `EIO`，验证正常准备阶段同步失败会阻止发布。
 * 句柄用 Proxy 转发，其余方法（read/stat/close）仍是真实实现；不靠 sleep。
 */
function exportInChildWithIoDefect({ mode, root, backupRoot, extraCount = 0, limits }) {
	const script = `
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const config = JSON.parse(process.env.BACKUP_D2R_IO_CONFIG);
const fsPromises = require("node:fs/promises");
const realOpen = fsPromises.open;
const realLstat = fsPromises.lstat;
const realOpendir = fsPromises.opendir;
const live = [];
let yielded = 0;
let names = 0;
fsPromises.open = async (...args) => {
	const handle = await realOpen(...args);
	const isReadMode = typeof args[1] === "string" && args[1].startsWith("r");
	const isTemp = typeof args[0] === "string" && args[0].endsWith(".tmp");
	live.push(handle);
	return new Proxy(handle, {
		get(target, prop) {
			if (config.mode === "short-write" && prop === "write") {
				return async (buffer, offset, length, ...rest) => {
					const capped = Math.min(3, length);
					return target.write(buffer, offset, capped, ...rest);
				};
			}
			if (prop === "close" && ((config.mode === "read-close-fail" && isReadMode) || (config.mode === "manifest-close-fail" && isTemp))) {
				// 真实关闭完成之后再把结果改成受控 EIO：证明"关掉了却报错"也必须阻止发布。
				return async () => {
					await target.close();
					const error = new Error("injected close failure");
					error.code = "EIO";
					throw error;
				};
			}
			if (config.mode === "sync-fail" && prop === "sync") {
				return async () => {
					const error = new Error("injected sync failure");
					error.code = "EIO";
					throw error;
				};
			}
			const value = Reflect.get(target, prop, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
};
if (config.mode === "accept-lstat-fail") {
	// 只让目标 payload 的**身份登记**用 lstat 失败：open 已经成功，句柄必须仍被关掉。
	let injected = false;
	fsPromises.lstat = async (path, ...rest) => {
		if (!injected && typeof path === "string" && path.includes(join("data", "experiences")) && path.endsWith(".json")) {
			injected = true;
			const error = new Error("injected lstat failure");
			error.code = "EACCES";
			throw error;
		}
		return realLstat(path, ...rest);
	};
}
if (config.mode === "bounded-scan") {
	// 计数：真实 opendir 保留，只统计真正被产出的条目数与 name 读取次数。
	fsPromises.opendir = async (target, options) => {
		const dir = await realOpendir(target, options);
		// 只统计**目标容器**侧的观察：源知识库的预检/清单列举不在这条断言的范围内。
		if (typeof target !== "string" || !target.startsWith(config.backupRoot)) return dir;
		const wrapEntry = (entry) => new Proxy(entry, { get(t, p) { if (p === "name") names += 1; const value = Reflect.get(t, p, t); return typeof value === "function" ? value.bind(t) : value; } });
		const iterate = () => {
			const inner = dir[Symbol.asyncIterator]();
			return {
				next: async () => {
					const result = await inner.next();
					if (result.done) return result;
					yielded += 1;
					return { done: false, value: wrapEntry(result.value) };
				},
				return: (value) => (inner.return ? inner.return(value) : Promise.resolve({ done: true, value })),
			};
		};
		return new Proxy(dir, {
			get(t, p) {
				if (p === Symbol.asyncIterator) return iterate;
				if (p === "close") return () => t.close();
				const value = Reflect.get(t, p, t);
				return typeof value === "function" ? value.bind(t) : value;
			},
		});
	};
}
let armed = false;
const listed = [];
if (config.mode === "cleanup-lstat-fail") {
	// 只在**武装之后**让目标路径的 lstat 报 EACCES：清理必须把它当"不可核对"，不能当"已不存在"。
	fsPromises.lstat = async (path, ...rest) => {
		if (armed && typeof path === "string" && path.startsWith(config.backupRoot)) {
			const error = new Error("injected lstat failure");
			error.code = "EACCES";
			throw error;
		}
		return realLstat(path, ...rest);
	};
}
if (config.mode === "unknown-subtree") {
	// 记录目标侧真实 opendir 过的目录：未知子树绝不该出现在这份记录里。
	fsPromises.opendir = async (target, options) => {
		if (typeof target === "string" && target.startsWith(config.backupRoot)) listed.push(target);
		return realOpendir(target, options);
	};
}
require("node:module").syncBuiltinESMExports();
const { exportKnowledgeBackup } = await import(config.entryUrl);
const { StorageError } = await import(config.storageEntryUrl);
let injected = false;
const ioHooks =
	config.extraCount > 0 || config.mode === "cleanup-lstat-fail" || config.mode === "unknown-subtree"
		? {
				beforeIo: (operation, path) => {
					if (injected || operation !== "open" || !path.startsWith(config.backupRoot)) return undefined;
					injected = true;
					if (config.mode === "cleanup-lstat-fail") {
						// 武装 lstat 失败后抛**受控首错**：清理期间所有目标 lstat 都会 EACCES。
						armed = true;
						throw new StorageError("backup-payload-mismatch", "注入失败：触发清理", { detail: "injected" });
					}
					if (config.mode === "unknown-subtree") {
						mkdirSync(join(config.backupRoot, "data", "unknown", "nested"), { recursive: true });
						writeFileSync(join(config.backupRoot, "data", "unknown", "nested", "private.txt"), "UNDECLARED", "utf8");
					}
					if (config.extraCount > 0) {
						for (let index = 0; index < config.extraCount; index += 1) writeFileSync(join(config.backupRoot, "data", "extra-" + index + ".txt"), "UNDECLARED", "utf8");
					}
					return undefined;
				},
			}
		: undefined;
const realExists = async (path) => realLstat(path).then(() => true, () => false);
let output;
try {
	const result = await exportKnowledgeBackup({ root: config.root, backupRoot: config.backupRoot, offlineConfirmed: true, now: 1700000000000, backupId: "backup-d2r", ...(config.limits ? { limits: config.limits } : {}), ...(ioHooks ? { ioHooks } : {}) });
	output = { ok: true, files: result.files, totalBytes: result.totalBytes, yielded, names, listed, liveHandles: live.filter((handle) => handle.fd !== undefined && handle.fd >= 0).length };
} catch (error) {
	output = { ok: false, code: error && error.code ? error.code : "unknown", detail: error && error.detail ? error.detail : null, facts: error && error.facts ? error.facts : null, yielded, names, listed, liveHandles: live.filter((handle) => handle.fd !== undefined && handle.fd >= 0).length };
}
// 磁盘事实在调用**结束后**用真实 lstat 采集：注入只影响实现路径，不影响这里的核对。
output.disk = { targetExists: await realExists(config.backupRoot), registryExists: await realExists(join(config.backupRoot, "data", "registry.json")) };
process.stdout.write(JSON.stringify(output));
for (const handle of live) {
	try {
		await handle.close();
	} catch {
		// 诊断收尾：句柄可能已被实现关掉。
	}
}
`;
	const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
		cwd: PACKAGE_ROOT,
		env: { ...process.env, BACKUP_D2R_IO_CONFIG: JSON.stringify({ mode, root, backupRoot, extraCount, limits, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/backup/index.ts")).href, storageEntryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/index.ts")).href }) },
		encoding: "utf8",
	});
	return JSON.parse(stdout);
}

test("D2R：短写与 sync 失败的真实 IO 回归", async (t) => {
	await t.test("短写：每次最多 3 字节也能写完整份 payload（容器字节与源一致）", async () => {
		const root = await makeStore("d2r-short-write");
		const { target } = targetOf("d2r-short-write");
		const outcome = exportInChildWithIoDefect({ mode: "short-write", root, backupRoot: target });
		assert.equal(outcome.ok, true, `短写必须被循环处理：${JSON.stringify(outcome)}`);
		// 独立对照：容器里的 registry 与源逐字节一致（说明不是"只写了前 3 字节"）。
		assert.deepEqual(readFileSync(join(target, "data", "registry.json")), readFileSync(join(root, "registry.json")));
		assert.equal(statSync(join(target, "data", "registry.json")).size, statSync(join(root, "registry.json")).size);
	});

	await t.test("sync 失败：阻止发布，不留完成标记", async () => {
		const root = await makeStore("d2r-sync-fail");
		const { target } = targetOf("d2r-sync-fail");
		const outcome = exportInChildWithIoDefect({ mode: "sync-fail", root, backupRoot: target });
		assert.equal(outcome.ok, false, `sync 失败必须让导出失败：${JSON.stringify(outcome)}`);
		assert.equal(outcome.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false);
	});
});

/* ------------------------------------------------------------------ R23-1～3（第二十三轮遗漏） */

test("R23-1：受控等待之后必须重验祖先身份，目标外不得留下写入", async (t) => {
	await t.test("写入 hook 期间把 data 换成 junction ⇒ 不得在 outside 创建 registry", async (ctx) => {
		const root = await makeStore("r23-write-swap");
		const { target } = targetOf("r23-write-swap");
		const ownedData = sandboxPath("r23-owned-data");
		const outside = sandboxPath("r23-outside");
		mkdirSync(outside, { recursive: true });
		const sentinel = join(outside, "sentinel.txt");
		writeFileSync(sentinel, "OUTSIDE SENTINEL", "utf8");
		let injected = false;
		let junctionError;
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (injected || operation !== "backup-write" || !path.startsWith(target) || !path.endsWith("registry.json")) return undefined;
							injected = true;
							renameSync(join(target, "data"), ownedData);
							try {
								symlinkSync(outside, join(target, "data"), "junction");
							} catch (cause) {
								junctionError = cause;
							}
							// hook **正常返回**：不抛错，交给实现自己在真实 IO 前发现。
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assert.equal(injected, true, "注入必须真的触发");
		if (junctionError !== undefined) {
			assert.equal(junctionUnavailable(junctionError), true, `junction 创建异常必须是已知权限/平台码：${String(junctionError.code)}`);
			ctx.skip(`本机无法创建 junction（${String(junctionError.code)}），跳过该对照`);
			return;
		}
		// 核心断言：等待之后的重验挡在了 open 之前，目标外一个字节都没写。
		assert.equal(existsSync(join(outside, "registry.json")), false, "不得穿过 junction 在目标外创建文件");
		assert.equal(readdirSync(outside).length, 1, "目标外目录除自有 sentinel 外不得出现新条目");
		assert.equal(readFileSync(sentinel, "utf8"), "OUTSIDE SENTINEL");
		assertSanitized(error, "backup-target-exists");
		assert.equal(error.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false, "不得发布完成标记");
		// 顶替物与被挪走的自有目录都必须保留（不穿链删除）。
		assert.equal(existsSync(join(target, "data")), true, "replacement 必须保留");
		assert.equal(existsSync(ownedData), true);
	});
});

test("R23-2：读关闭失败与登记失败都必须显式收尾", async (t) => {
	await t.test("仅目标 r 模式句柄关闭失败（实际关闭后抛 EIO）⇒ 不得继续发布", async () => {
		const root = await makeStore("r23-read-close");
		const { target } = targetOf("r23-read-close");
		const outcome = exportInChildWithIoDefect({ mode: "read-close-fail", root, backupRoot: target });
		assert.equal(outcome.ok, false, `正常读关闭失败必须传播：${JSON.stringify(outcome)}`);
		assert.equal(outcome.code, "permission-denied");
		assert.equal(outcome.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false);
		assert.equal(outcome.liveHandles, 0, "全部取得的句柄必须已显式关闭");
	});

	await t.test("manifest 临时文件句柄关闭失败 ⇒ 不得发布完成标记", async () => {
		const root = await makeStore("r23-manifest-close");
		const { target } = targetOf("r23-manifest-close");
		const outcome = exportInChildWithIoDefect({ mode: "manifest-close-fail", root, backupRoot: target });
		assert.equal(outcome.ok, false, `发布临时文件关闭失败必须阻止发布：${JSON.stringify(outcome)}`);
		assert.equal(outcome.code, "permission-denied");
		assert.equal(outcome.facts.published, false);
		assert.equal(existsSync(join(target, "manifest.json")), false);
		assert.equal(outcome.liveHandles, 0);
	});

	await t.test("登记用 lstat 失败（open 已成功）⇒ 仍必须关掉句柄且不发布", async () => {
		const root = await makeStore("r23-accept-fail");
		const { target } = targetOf("r23-accept-fail");
		const outcome = exportInChildWithIoDefect({ mode: "accept-lstat-fail", root, backupRoot: target });
		assert.equal(outcome.ok, false, `登记失败必须让导出失败：${JSON.stringify(outcome)}`);
		assert.equal(outcome.code, "permission-denied");
		assert.equal(outcome.facts.published, false);
		assert.equal(outcome.liveHandles, 0, "登记失败在关闭保护之外会漏关句柄（R23-2 原缺陷）");
		assert.equal(existsSync(join(target, "manifest.json")), false);
	});
});

test("R23-3：容器盘点逐项有界，不得先整目录装载再判预算", async () => {
	const root = await makeStore("r23-bounded-scan");
	const { target } = targetOf("r23-bounded-scan");
	// 预算口径：maxFiles 8 + maxDirectories 8 + 固定容器条目 3 = 19 次观察上限。
	const outcome = exportInChildWithIoDefect({ mode: "bounded-scan", root, backupRoot: target, extraCount: 1000, limits: { maxFiles: 8, maxDirectories: 8 } });
	assert.equal(outcome.ok, false, `未知条目必须拒绝：${JSON.stringify(outcome)}`);
	assert.ok(["too-large", "backup-payload-mismatch"].includes(outcome.code), `受控类别：${outcome.code}`);
	// 真实目录里有 1000 个未知文件：只有"逐项计费"才可能把观察次数压在 25 以内。
	assert.ok(outcome.names <= 25, `实际只允许有界观察（name 读取 ${outcome.names} 次）`);
	assert.ok(outcome.yielded <= 25, `实际只允许有界观察（产出 ${outcome.yielded} 条）`);
	assert.equal(existsSync(join(target, "manifest.json")), false);
	// 未知归属的额外文件必须保留（不静默删除换通过）。
	assert.equal(existsSync(join(target, "data", "extra-0.txt")), true);
});

/* ------------------------------------------------------------------ R24-1～2（第二十四轮遗漏） */

test("R24-1：清理时「不可核对」不等于「不存在」", async (t) => {
	await t.test("目标路径 lstat 报 EACCES ⇒ cleanup=failed、保留现场、首错不被掩盖", async () => {
		const root = await makeStore("r24-cleanup-eacces");
		const { target } = targetOf("r24-cleanup-eacces");
		const outcome = exportInChildWithIoDefect({ mode: "cleanup-lstat-fail", root, backupRoot: target });
		assert.equal(outcome.ok, false, `必须失败：${JSON.stringify(outcome)}`);
		assert.equal(outcome.code, "backup-payload-mismatch", "首错类别必须保留");
		assert.equal(outcome.facts.published, false);
		// 旧实现把 EACCES 当"不存在"，虚报 cleanup=ok 并删条目；现在必须如实报告不可核对。
		assert.equal(outcome.facts.cleanup, "failed", "不可核对必须报告 cleanup=failed");
		assert.ok(outcome.facts.residuals.length >= 1, JSON.stringify(outcome.facts));
		assert.equal(outcome.disk.targetExists, true, "实际磁盘上目标与内容仍在（不得虚报已清理）");
		assert.equal(existsSync(join(target, "data", "registry.json")), true, "不得因为无法核对就当作没有内容");
	});

	await t.test("真实缺失（ENOENT）仍按「已无内容」处理，不虚报残留", async () => {
		const root = await makeStore("r24-cleanup-enoent");
		const { target } = targetOf("r24-cleanup-enoent");
		// 外部删掉一个自有空目录后再触发失败：清理必须正常通过（这是"真的没了"的对照）。
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation, path) => {
							if (operation !== "open" || !path.startsWith(target)) return undefined;
							rmSync(join(target, "data", "features"), { recursive: true, force: true });
							throw new StorageError("backup-payload-mismatch", "注入失败：触发清理", { detail: "injected" });
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "backup-payload-mismatch");
		assert.equal(error.facts.cleanup, "ok", "真实缺失应该被清理干净，不应虚报残留");
		assert.equal(existsSync(target), false);
	});
});

test("R24-2：未知 data 子树必须在入队前拒绝，不得被 opendir", async () => {
	const root = await makeStore("r24-unknown-subtree");
	const { target } = targetOf("r24-unknown-subtree");
	const outcome = exportInChildWithIoDefect({ mode: "unknown-subtree", root, backupRoot: target });
	assert.equal(outcome.ok, false, `未知子树必须拒绝：${JSON.stringify(outcome)}`);
	assert.equal(outcome.code, "backup-payload-mismatch");
	assert.equal(outcome.facts.published, false);
	assert.equal(existsSync(join(target, "manifest.json")), false);
	const openedUnknown = outcome.listed.filter((path) => path.includes(`${sep}unknown`));
	assert.deepEqual(openedUnknown, [], `不得进入未知子树：${JSON.stringify(openedUnknown)}`);
	// 未知内容必须保留（不递归删除换通过）。
	assert.equal(readFileSync(join(target, "data", "unknown", "nested", "private.txt"), "utf8"), "UNDECLARED");
});

/* ------------------------------------------------------------------ D2-4 公共错误脱敏 */

test("D2R/D2-4：公共错误统一脱敏", async (t) => {
	await t.test("原始异常不透传：收敛成受控类别，敏感正文不出现", async () => {
		const root = await makeStore("d2r-raw-error");
		const { target } = targetOf("d2r-raw-error");
		let error;
		try {
			await exportKnowledgeBackup(
				exportOptions(root, target, {
					ioHooks: {
						beforeIo: (operation) => {
							if (operation === "backup-write") throw new Error("PRIVATE_CUSTOMER_BODY_123");
							return undefined;
						},
					},
				}),
			);
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "backup-io-failed");
		const serialized = `${error.message} ${JSON.stringify({ detail: error.detail, facts: error.facts, code: error.code })}`;
		assert.equal(serialized.includes("PRIVATE_CUSTOMER_BODY_123"), false, "原始异常正文不得出现在公共错误里");
		assert.equal(serialized.includes(SANDBOX), false, "绝对路径不得出现在公共错误里");
	});

	await t.test("真实预算错误（maxFileBytes=0）不含源知识库绝对路径", async () => {
		const root = await makeStore("d2r-budget-error");
		const { target } = targetOf("d2r-budget-error");
		let error;
		try {
			await exportKnowledgeBackup(exportOptions(root, target, { limits: { maxFileBytes: 0 } }));
		} catch (caught) {
			error = caught;
		}
		assertSanitized(error, "too-large");
		const serialized = `${error.message} ${JSON.stringify({ path: error.path ?? null, detail: error.detail, facts: error.facts })}`;
		assert.equal(serialized.includes(root), false, "源知识库绝对路径不得出现在公共错误里");
		assert.equal(serialized.includes(SANDBOX), false);
	});

	await t.test("非法参数（父目录缺失 / 相对路径）也是受控类别且不回显绝对路径", async () => {
		const root = await makeStore("d2r-arg-error");
		const holder = sandboxPath("d2r-arg-error-holder");
		mkdirSync(holder, { recursive: true });
		for (const [label, options, code] of [
			["父目录缺失", exportOptions(root, join(holder, "deep", "backup")), "backup-argument-invalid"],
			["相对路径", { root, backupRoot: "backup", offlineConfirmed: true }, "backup-argument-invalid"],
			["未确认离线", { root, backupRoot: join(holder, "backup2"), offlineConfirmed: false }, "backup-argument-invalid"],
		]) {
			let error;
			try {
				await exportKnowledgeBackup(options);
			} catch (caught) {
				error = caught;
			}
			assertSanitized(error, code);
			assert.equal(`${error.message}${JSON.stringify({ detail: error.detail })}`.includes(SANDBOX), false, `${label} 不得回显绝对路径`);
		}
		assert.equal(existsSync(join(holder, "deep")), false, "不得顺手创建父链");
	});
});

/* 让 `sep` 参与断言，避免"只在某个平台成立"的路径拼接悄悄失效。 */
test("D2R：测试自身锚点（沙箱为 canonical 绝对路径）", () => {
	assert.ok(SANDBOX.includes(sep), "沙箱路径必须含平台分隔符");
	assert.equal(SANDBOX, realpathSync(SANDBOX), "沙箱必须是 canonical 路径（父链无链接）");
});
