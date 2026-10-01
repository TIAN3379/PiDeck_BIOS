/**
 * 扫描行为测试（round1_acceptance.md R1）。
 *
 * 重点不是"能扫出多少文件"，而是四件容易做假的事：
 * 预算真的会停、取消真的能中途生效、不可读目录如实报告、忽略目录不被计入。
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { opendir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MAX_PROBE_WARNINGS, ProbeCancelledError, probeProjectDirectory } from "../core/projects/probe.ts";

const PROBE_MODULE_PATH = fileURLToPath(new URL("../core/projects/probe.ts", import.meta.url));

function makeTempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function touch(path) {
	writeFileSync(path, "");
}

test("正常扫描：统计线索、忽略 VCS 与依赖目录", async () => {
	const root = makeTempDir("bios-probe-ok-");
	try {
		touch(join(root, "Platform.dsc"));
		touch(join(root, "Platform.inf"));
		mkdirSync(join(root, "nested"));
		touch(join(root, "nested", "Board.asl"));
		// 干扰：必须被忽略
		mkdirSync(join(root, ".git"));
		touch(join(root, ".git", "Ignored.inf"));
		mkdirSync(join(root, "node_modules"));
		touch(join(root, "node_modules", "Ignored.inf"));
		mkdirSync(join(root, "build"));
		touch(join(root, "build", "Ignored.dsc"));

		const result = await probeProjectDirectory(root);
		assert.equal(result.hintCounts[".dsc"], 1);
		assert.equal(result.hintCounts[".inf"], 1);
		assert.equal(result.hintCounts[".asl"], 1);
		assert.equal(result.hintCounts[".fdf"], 0);
		assert.equal(result.truncated, false);
		assert.deepEqual(result.truncatedBy, []);
		assert.deepEqual(result.warnings, []);
		assert.ok(result.hintSamples[".asl"].includes(join("nested", "Board.asl")));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("空目录：全零且不报截断", async () => {
	const root = makeTempDir("bios-probe-empty-");
	try {
		const result = await probeProjectDirectory(root);
		assert.equal(result.scannedPaths, 0);
		assert.equal(result.truncated, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("路径预算：达到上限即停止并标记不完整", async () => {
	const root = makeTempDir("bios-probe-budget-");
	try {
		// 单层大目录 + 很低预算：应当在预算处停住，而不是先物化整个目录。
		for (let index = 0; index < 300; index += 1) touch(join(root, `file-${index}.inf`));

		const result = await probeProjectDirectory(root, { limits: { maxPaths: 10, maxDepth: 4 } });
		assert.equal(result.truncated, true);
		assert.ok(result.truncatedBy.includes("paths"), `truncatedBy=${result.truncatedBy.join(",")}`);
		assert.ok(result.scannedPaths <= 10, `scannedPaths=${result.scannedPaths}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("深度预算：超深目录被标为 depth 截断", async () => {
	const root = makeTempDir("bios-probe-depth-");
	try {
		mkdirSync(join(root, "a", "b"), { recursive: true });
		touch(join(root, "a", "b", "Deep.dsc"));

		const shallow = await probeProjectDirectory(root, { limits: { maxPaths: 1_000, maxDepth: 0 } });
		assert.ok(shallow.truncatedBy.includes("depth"));
		assert.equal(shallow.hintCounts[".dsc"], 0, "超出深度的线索不应被计入");

		const deep = await probeProjectDirectory(root, { limits: { maxPaths: 1_000, maxDepth: 4 } });
		assert.equal(deep.hintCounts[".dsc"], 1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("开始后取消能中途生效（不是只测预先取消）", async () => {
	const root = makeTempDir("bios-probe-cancel-");
	try {
		// 条目数要明显多于 yieldEvery，取消事件才有机会在扫描过程中被观察到。
		for (let index = 0; index < 400; index += 1) touch(join(root, `file-${index}.inf`));

		const controller = new AbortController();
		const pending = probeProjectDirectory(root, { signal: controller.signal, yieldEvery: 20 });
		// 让扫描先真正开始（至少跑过一个让出点），再触发取消。
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();

		await assert.rejects(
			() => pending,
			(error) => error instanceof ProbeCancelledError && error.code === "cancelled",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("预先取消：立即拒绝", async () => {
	const root = makeTempDir("bios-probe-preabort-");
	try {
		touch(join(root, "Platform.dsc"));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(() => probeProjectDirectory(root, { signal: controller.signal }), ProbeCancelledError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("不可读 / 不存在的目标如实进入 warnings，而不是抛错或静默", async () => {
	const root = makeTempDir("bios-probe-unreadable-");
	try {
		const missing = join(root, "does-not-exist");
		const missingResult = await probeProjectDirectory(missing);
		assert.equal(missingResult.warnings.length, 1);
		assert.equal(missingResult.warnings[0].path, missing);
		// 不变量：无论遇到多少不可读目录，warnings 都不会无限增长。
		assert.ok(missingResult.warnings.length <= MAX_PROBE_WARNINGS);

		// 目标是普通文件：opendir 失败，同样应进入 warnings 而不是让整次探测崩掉。
		const file = join(root, "not-a-dir.txt");
		touch(file);
		const fileResult = await probeProjectDirectory(file);
		assert.equal(fileResult.warnings.length, 1);
		assert.equal(fileResult.hintCounts[".inf"], 0);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("调用后立即取消：小目录也必须失败（round2 F3）", async () => {
	const root = makeTempDir("bios-probe-small-cancel-");
	try {
		// 条目数远少于 yieldEvery（默认 200），修复前函数不会再次检查 signal 就直接返回成功。
		touch(join(root, "Platform.dsc"));
		touch(join(root, "Platform.inf"));
		const controller = new AbortController();
		const pending = probeProjectDirectory(root, { signal: controller.signal });
		// probe 已同步执行到第一个 await（opendir）；此刻取消必须被观察到。
		controller.abort();
		await assert.rejects(
			() => pending,
			(error) => error instanceof ProbeCancelledError && error.code === "cancelled",
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("调用后立即取消：空目录也不能返回成功", async () => {
	const root = makeTempDir("bios-probe-empty-cancel-");
	try {
		const controller = new AbortController();
		const pending = probeProjectDirectory(root, { signal: controller.signal });
		controller.abort();
		await assert.rejects(() => pending, ProbeCancelledError);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("截断维度与告警上限自洽（区分预算截断与告警丢弃）", async () => {
	const root = makeTempDir("bios-probe-semantics-");
	try {
		touch(join(root, "Platform.dsc"));
		const ok = await probeProjectDirectory(root);
		assert.equal(ok.truncated, false);
		assert.deepEqual(ok.truncatedBy, []);
		assert.equal(ok.droppedWarnings, 0);
		assert.equal(ok.skippedDirectories, 0);

		// 触顶路径需要真实权限失败才能出现（Windows 上难以稳定制造），
		// 因此这里只断言不变量：告警条数不会越过上限，且 truncated 与维度列表一致。
		for (let index = 0; index < 3; index += 1) {
			const result = await probeProjectDirectory(join(root, `missing-${index}`));
			assert.ok(result.warnings.length <= MAX_PROBE_WARNINGS);
			assert.equal(result.truncated, result.truncatedBy.length > 0);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

/** 包一层 openDirectory，记录每个句柄的开启与关闭（确定性断言，不依赖 GC 时机）。 */
function makeHandleTracker() {
	const opened = [];
	const closed = [];
	return {
		opened,
		closed,
		async openDirectory(path) {
			const dir = await opendir(path);
			opened.push(path);
			const originalClose = dir.close.bind(dir);
			dir.close = async () => {
				closed.push(path);
				return originalClose();
			};
			return dir;
		},
	};
}

test("取消时目录句柄必须已关闭，而不是等 GC 兜底（round3 G1）", async () => {
	const root = makeTempDir("bios-probe-handle-cancel-");
	try {
		touch(join(root, "Platform.dsc"));
		const tracker = makeHandleTracker();

		const controller = new AbortController();
		// 取消恰好落在 `await opendir` 之后的那个检查点：修复前它会绕过 finally，
		// 只有 GC 才会关闭句柄。
		const pending = probeProjectDirectory(root, { signal: controller.signal, openDirectory: tracker.openDirectory });
		controller.abort();

		await assert.rejects(() => pending, ProbeCancelledError);
		assert.equal(tracker.opened.length, 1, "应当打开过一次目录");
		assert.equal(tracker.closed.length, tracker.opened.length, "拒绝前每个已打开的句柄都必须关闭");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("正常完成与预算截断路径同样关闭句柄", async () => {
	const root = makeTempDir("bios-probe-handle-normal-");
	try {
		mkdirSync(join(root, "nested"));
		touch(join(root, "Platform.dsc"));
		touch(join(root, "nested", "Board.asl"));

		const normal = makeHandleTracker();
		await probeProjectDirectory(root, { openDirectory: normal.openDirectory });
		assert.ok(normal.opened.length >= 2, "应当打开根目录与子目录");
		assert.equal(normal.closed.length, normal.opened.length);

		const truncated = makeHandleTracker();
		const result = await probeProjectDirectory(root, { limits: { maxPaths: 1, maxDepth: 4 }, openDirectory: truncated.openDirectory });
		assert.equal(result.truncated, true);
		assert.equal(truncated.closed.length, truncated.opened.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("迭代中取消（大目录）同样关闭句柄", async () => {
	const root = makeTempDir("bios-probe-handle-iteration-");
	try {
		for (let index = 0; index < 300; index += 1) touch(join(root, `file-${index}.inf`));
		const tracker = makeHandleTracker();

		const controller = new AbortController();
		const pending = probeProjectDirectory(root, { signal: controller.signal, yieldEvery: 20, openDirectory: tracker.openDirectory });
		await new Promise((resolve) => setImmediate(resolve));
		controller.abort();

		await assert.rejects(() => pending, ProbeCancelledError);
		assert.equal(tracker.closed.length, tracker.opened.length);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("取消后触发 GC 不应出现目录句柄的 GC 清理警告（复现 round3 诊断场景）", () => {
	// 补充诊断：在独立进程里显式 GC，检查是否残留未关闭的目录句柄。
	// 主断言是同文件里的句柄计数用例；这里复现验收方的观察方式，不作为唯一证据。
	const script = `
		import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
		import { tmpdir } from "node:os";
		import { join } from "node:path";
		const { probeProjectDirectory } = await import(${JSON.stringify(pathToFileURL(PROBE_MODULE_PATH).href)});
		const root = mkdtempSync(join(tmpdir(), "bios-probe-gc-"));
		writeFileSync(join(root, "Platform.dsc"), "");
		const warnings = [];
		process.on("warning", (warning) => warnings.push(String(warning.message)));
		let cancelled = 0;
		for (let index = 0; index < 3; index += 1) {
			const controller = new AbortController();
			const pending = probeProjectDirectory(root, { signal: controller.signal });
			controller.abort();
			try {
				await pending;
			} catch {
				cancelled += 1;
			}
		}
		globalThis.gc?.();
		await new Promise((resolve) => setTimeout(resolve, 30));
		globalThis.gc?.();
		rmSync(root, { recursive: true, force: true });
		process.stdout.write(JSON.stringify({ cancelled, warnings }));
	`;

	const result = spawnSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 });
	assert.equal(result.status, 0, `诊断进程失败：${result.stderr}`);
	const payload = JSON.parse(result.stdout);
	assert.equal(payload.cancelled, 3, "三次取消都应被拒绝");
	assert.deepEqual(
		payload.warnings.filter((warning) => /directory handle on garbage collection/i.test(warning)),
		[],
		"不应残留靠 GC 关闭的目录句柄",
	);
});
