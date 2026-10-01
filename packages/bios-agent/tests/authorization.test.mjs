/**
 * 授权根测试（round1_acceptance.md R6）。
 *
 * 目标：证明"读取范围"由适配层决定，模型给的 `targetDir` 只能在已授权范围内生效；
 * 并且拒绝时不会返回目标目录内的任何线索（先授权、后扫描）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { AuthorizedTargetError, BIOS_AUTHORIZED_ROOTS_ENV, isWithinAuthorizedRoot, readAuthorizedRootsFromEnv, resolveAuthorizedTargetDir } from "../core/projects/authorization.ts";

function makeTempDir(prefix) {
	// realpath：macOS 的 /var 与 Windows 的短名都会让字面路径与真实路径不同。
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

test("省略 targetDir：使用会话工作目录", () => {
	const cwd = makeTempDir("bios-auth-cwd-");
	try {
		const result = resolveAuthorizedTargetDir({ cwd });
		assert.equal(result.targetDir, cwd);
		assert.equal(result.matchedRoot, cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("工作区子目录可用", () => {
	const cwd = makeTempDir("bios-auth-sub-");
	try {
		const sub = join(cwd, "PlatformPkg");
		mkdirSync(sub);
		const result = resolveAuthorizedTargetDir({ requested: "PlatformPkg", cwd });
		assert.equal(result.targetDir, join(cwd, "PlatformPkg"));
		assert.equal(result.matchedRoot, cwd);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("根外路径被拒绝（绝对路径与 ../ 都不行）", () => {
	const workspace = makeTempDir("bios-auth-ws-");
	const outside = makeTempDir("bios-auth-out-");
	try {
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: outside, cwd: workspace }),
			(error) => error instanceof AuthorizedTargetError && error.code === "outside-authorized-roots",
		);
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: join("..", outside.split(/[\\/]/).pop() ?? ""), cwd: workspace }),
			(error) => error instanceof AuthorizedTargetError && error.code === "outside-authorized-roots",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("显式登记的额外根可用，且只在该根内生效", () => {
	const workspace = makeTempDir("bios-auth-ws2-");
	const extra = makeTempDir("bios-auth-extra-");
	const other = makeTempDir("bios-auth-other-");
	try {
		mkdirSync(join(extra, "BoardPkg"));
		const inside = resolveAuthorizedTargetDir({ requested: join(extra, "BoardPkg"), cwd: workspace, authorizedRoots: [extra] });
		assert.equal(inside.targetDir, join(extra, "BoardPkg"));
		assert.equal(inside.matchedRoot, extra);
		assert.deepEqual(inside.effectiveRoots, [workspace, extra]);

		// 未登记的其它目录仍然被拒绝：授权根不是"随便加一个就全通"。
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: other, cwd: workspace, authorizedRoots: [extra] }),
			(error) => error instanceof AuthorizedTargetError && error.code === "outside-authorized-roots",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(extra, { recursive: true, force: true });
		rmSync(other, { recursive: true, force: true });
	}
});

test("不存在的目标与非目录目标分别报错", () => {
	const workspace = makeTempDir("bios-auth-kinds-");
	try {
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: "missing-dir", cwd: workspace }),
			(error) => error instanceof AuthorizedTargetError && error.code === "not-found",
		);
		writeFileSync(join(workspace, "file.txt"), "");
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: "file.txt", cwd: workspace }),
			(error) => error instanceof AuthorizedTargetError && error.code === "not-directory",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("根内指向根外的符号链接被拒绝", (t) => {
	const workspace = makeTempDir("bios-auth-link-");
	const outside = makeTempDir("bios-auth-linkout-");
	try {
		const link = join(workspace, "escape");
		try {
			// Windows 上创建目录符号链接需要开发者模式或管理员权限：
			// 权限不足时**明确 skip 并说明原因**，不能静默当作通过。
			symlinkSync(outside, link, "junction");
		} catch (error) {
			t.skip(`无法创建符号链接（需要开发者模式/管理员权限）：${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		assert.throws(
			() => resolveAuthorizedTargetDir({ requested: "escape", cwd: workspace }),
			(error) => error instanceof AuthorizedTargetError && error.code === "outside-authorized-roots",
		);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(outside, { recursive: true, force: true });
	}
});

test("有效授权根集合包含会话工作目录与额外根", () => {
	const workspace = makeTempDir("bios-auth-all-");
	const extra = makeTempDir("bios-auth-all2-");
	try {
		const result = resolveAuthorizedTargetDir({ cwd: workspace, authorizedRoots: [extra] });
		assert.deepEqual(result.effectiveRoots, [workspace, extra]);
		assert.equal(isWithinAuthorizedRoot(workspace, join(workspace, "sub")), true);
		assert.equal(isWithinAuthorizedRoot(workspace, extra), false);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
		rmSync(extra, { recursive: true, force: true });
	}
});

test("额外授权根只从适配层注入的环境变量读取", () => {
	const env = { [BIOS_AUTHORIZED_ROOTS_ENV]: ["D:\\work\\a", "D:\\work\\b"].join(delimiter) };
	const roots = readAuthorizedRootsFromEnv(/** @type {NodeJS.ProcessEnv} */ (env));
	assert.equal(roots.length, 2);
	assert.equal(roots[0], "D:\\work\\a");
	assert.deepEqual(readAuthorizedRootsFromEnv(/** @type {NodeJS.ProcessEnv} */ ({})), []);
	// 空白项被丢弃，不产生"空授权根"这种能匹配一切的边界情况。
	assert.deepEqual(readAuthorizedRootsFromEnv(/** @type {NodeJS.ProcessEnv} */ ({ [BIOS_AUTHORIZED_ROOTS_ENV]: `${delimiter}  ${delimiter}` })), []);
});

test("相对授权根被拒绝：不按进程 cwd 补全（round2 F4）", () => {
	const workspace = makeTempDir("bios-auth-relative-");
	try {
		for (const bad of [".", "..", "../..", "./sub", "relative-root", ""]) {
			assert.throws(
				() => resolveAuthorizedTargetDir({ cwd: workspace, authorizedRoots: [bad] }),
				(error) => error instanceof AuthorizedTargetError && error.code === "invalid-authorized-root",
				`应拒绝授权根：${JSON.stringify(bad)}`,
			);
		}
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("进程 cwd 与会话 cwd 不同时，'.' 不会把进程目录加进授权范围", () => {
	const workspace = makeTempDir("bios-auth-cwd-ws-");
	try {
		// 修复前：'.' 经 statSync 按**进程** cwd 解析，等于把开发机当前目录授权给工具。
		assert.throws(
			() => resolveAuthorizedTargetDir({ cwd: workspace, authorizedRoots: ["."] }),
			(error) => error instanceof AuthorizedTargetError && error.code === "invalid-authorized-root",
		);
		const resolved = resolveAuthorizedTargetDir({ cwd: workspace });
		assert.deepEqual(resolved.effectiveRoots, [workspace]);
		assert.ok(!resolved.effectiveRoots.includes(process.cwd()));
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("完全限定但当前不可达的额外根被标记离线，而不是当成非法配置", () => {
	const workspace = makeTempDir("bios-auth-offline-");
	try {
		const notCreatedYet = join(workspace, "not-created-yet");
		const resolved = resolveAuthorizedTargetDir({ cwd: workspace, authorizedRoots: [notCreatedYet] });
		assert.deepEqual(resolved.unreachableRoots, [notCreatedYet]);
		assert.deepEqual(resolved.effectiveRoots, [workspace]);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("有效授权根按 realpath 去重", () => {
	const workspace = makeTempDir("bios-auth-dedup-");
	try {
		const resolved = resolveAuthorizedTargetDir({ cwd: workspace, authorizedRoots: [workspace, join(workspace, "."), join(workspace, "sub", "..")] });
		assert.equal(resolved.effectiveRoots.length, 1);
		assert.equal(resolved.effectiveRoots[0], workspace);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});

test("根内 ..cache 目录不算越界（精确识别 .. 段）", () => {
	const workspace = makeTempDir("bios-auth-dotdot-");
	try {
		assert.equal(isWithinAuthorizedRoot(workspace, join(workspace, "..cache")), true);
		assert.equal(isWithinAuthorizedRoot(workspace, join(workspace, "..cache", "deep")), true);
		assert.equal(isWithinAuthorizedRoot(workspace, join(workspace, "..", "sibling")), false);
		assert.equal(isWithinAuthorizedRoot(workspace, workspace), true);
	} finally {
		rmSync(workspace, { recursive: true, force: true });
	}
});
