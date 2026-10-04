/**
 * BM-02D2：导出的失败、取消与清理路径。
 *
 * 时序一律用 `ioHooks.beforeIo` 注入（真实操作发起前），不靠 sleep 或目录偶然顺序；
 * 每个负例都要证明三件事：**受控失败类别**、**没有留下 `manifest.json` 完成标记**、
 * **源库没有被修改**。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRecord, exportKnowledgeBackup, initializeKnowledgeStore } from "../core/storage/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-backup-failure-")));
after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
let counter = 0;

function sandboxPath(name) {
	counter += 1;
	return join(SANDBOX, `${name}-${counter}`);
}

async function makeStore(name) {
	const root = sandboxPath(name);
	await initializeKnowledgeStore({ root });
	return realpathSync(root);
}

function backupTarget(name) {
	const parent = sandboxPath(`${name}-parent`);
	mkdirSync(parent, { recursive: true });
	return { parent, target: join(parent, "backup") };
}

function experienceBody(overrides = {}) {
	return {
		problem: "PXE 默认开启",
		rootCause: "Setup 默认值未随客户选项调整",
		solution: "在 Setup 中关闭 PXE 引导项",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: PROJECT_ID,
		evidence: [],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status: "reviewed",
		...overrides,
	};
}

/** 递归清单（用于"源库不变"断言）。 */
function walk(root) {
	const out = [];
	const visit = (absolute) => {
		for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
			const target = join(absolute, entry.name);
			if (entry.isDirectory()) {
				out.push(`d:${target.slice(root.length)}`);
				visit(target);
				continue;
			}
			out.push(`f:${target.slice(root.length)}:${statSync(target).size}:${readFileSync(target).toString("base64")}`);
		}
	};
	if (existsSync(root)) visit(root);
	return out;
}

/** 断言一次受控失败：类别、无完成标记、无残留容器、源未变。 */
async function expectExportFailure({ root, target, sourceBefore, code, options = {} }) {
	await assert.rejects(
		() => exportKnowledgeBackup({ root, backupRoot: target, offlineConfirmed: true, now: NOW, backupId: "backup-x", ...options }),
		(error) => {
			assert.equal(error?.code, code, `必须是受控类别 ${code}，实际 ${String(error?.code)}：${String(error?.message)}`);
			return true;
		},
	);
	assert.equal(existsSync(join(target, "manifest.json")), false, "失败时不得留下完成标记");
	assert.equal(existsSync(target), false, "本次创建的目标必须被清理干净（不冒充完整备份）");
	assert.deepEqual(walk(root), sourceBefore, "失败不得修改源知识库");
}

/* ------------------------------------------------------------------ 1. 准入拒绝 */

test("D2：不满足准入的源一律拒绝导出", async (t) => {
	await t.test("坏 JSON 记录", async () => {
		const root = await makeStore("d2f-badjson");
		writeFileSync(join(root, "experiences", "broken.json"), '{ "problem": ', "utf8");
		const before = walk(root);
		const { target } = backupTarget("d2f-badjson");
		await expectExportFailure({ root, target, sourceBefore: before, code: "backup-source-not-eligible" });
	});

	await t.test("未来 schemaVersion", async () => {
		const root = await makeStore("d2f-future");
		writeFileSync(join(root, "experiences", "exp-future.json"), JSON.stringify({ schemaVersion: 999, id: "exp-future" }), "utf8");
		const before = walk(root);
		const { target } = backupTarget("d2f-future");
		await expectExportFailure({ root, target, sourceBefore: before, code: "backup-source-not-eligible" });
	});

	await t.test("活动/遗留锁与 `.tmp` 残留", async () => {
		const root = await makeStore("d2f-manual");

		mkdirSync(join(root, "locks", `lock-${"a".repeat(32)}`), { recursive: true });
		const withLock = walk(root);
		const lockTarget = backupTarget("d2f-manual-lock");
		await expectExportFailure({ root, target: lockTarget.target, sourceBefore: withLock, code: "backup-source-not-eligible" });

		writeFileSync(join(root, "experiences", "exp-tmp.json.tmp"), "{}", "utf8");
		const withTmp = walk(root);
		const tmpTarget = backupTarget("d2f-manual-tmp");
		await expectExportFailure({ root, target: tmpTarget.target, sourceBefore: withTmp, code: "backup-source-not-eligible" });
	});

	await t.test("受控区域出现未知条目", async () => {
		const root = await makeStore("d2f-unknown");
		writeFileSync(join(root, "experiences", "not-a-record.txt"), "说明", "utf8");
		const before = walk(root);
		const { target } = backupTarget("d2f-unknown");
		await expectExportFailure({ root, target, sourceBefore: before, code: "backup-source-not-eligible" });
	});
});

/* ------------------------------------------------------------------ 2. 取消 */

test("D2：复制期间取消不留下完成标记与残留", async (t) => {
	await t.test("读取源文件时取消：结构化穿透并清理本次创建的目标", async () => {
		const root = await makeStore("d2f-cancel");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const before = walk(root);
		const { target } = backupTarget("d2f-cancel");

		const controller = new AbortController();
		await expectExportFailure({
			root,
			target,
			sourceBefore: before,
			code: "cancelled",
			options: {
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, path) => {
						if (operation === "read" && path.includes(`${join("experiences", "exp-a.json")}`)) controller.abort();
						return undefined;
					},
				},
			},
		});
	});
});

/* ------------------------------------------------------------------ 3. 源变化与输出复核 */

test("D2：源变化检测与目标回读复核", async (t) => {
	await t.test("复制后源文件内容被改写（同长度、仍是合法记录）⇒ backup-source-changed，不发布", async () => {
		const root = await makeStore("d2f-changed");
		// 改写要**保持 JSON 合法且长度不变**：否则先失败的是准入，而不是变化检测。
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody({ problem: "AAAA-AAAA-AAAA" }) });
		const recordPath = join(root, "experiences", "exp-a.json");
		const original = readFileSync(recordPath);
		const { target } = backupTarget("d2f-changed");

		await assert.rejects(
			() =>
				exportKnowledgeBackup({
					root,
					backupRoot: target,
					offlineConfirmed: true,
					now: NOW,
					backupId: "backup-x",
					ioHooks: {
						beforeIo: (operation, path) => {
							// 目标写入该文件的瞬间改写源文件：复制时读到的字节与复核时不同。
							if (operation === "backup-write" && path.includes(`${join("data", "experiences", "exp-a.json")}`)) {
								const mutated = Buffer.from(original.toString("utf8").replace("AAAA-AAAA-AAAA", "BBBB-BBBB-BBBB"), "utf8");
								assert.equal(mutated.byteLength, original.byteLength, "改写必须等长");
								writeFileSync(recordPath, mutated);
							}
							return undefined;
						},
					},
				}),
			(error) => error?.code === "backup-source-changed",
		);
		assert.equal(existsSync(join(target, "manifest.json")), false, "源变化时不得发布完成标记");
		assert.equal(existsSync(target), false, "源变化时必须清理本次创建的目标");
	});

	await t.test("目标字节在回读前被改坏 ⇒ backup-payload-mismatch，不发布", async () => {
		const root = await makeStore("d2f-readback");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const { target } = backupTarget("d2f-readback");
		let corrupted = false;

		await assert.rejects(
			() =>
				exportKnowledgeBackup({
					root,
					backupRoot: target,
					offlineConfirmed: true,
					now: NOW,
					backupId: "backup-x",
					ioHooks: {
						beforeIo: (operation, path) => {
							// 只在**目标回读**时改坏：此时源已复核过，能证明核对的是目标字节而不是源。
							if (!corrupted && operation === "open" && path.startsWith(target) && path.endsWith("exp-a.json")) {
								corrupted = true;
								const bytes = readFileSync(path);
								bytes[0] = bytes[0] === 0x7b ? 0x20 : 0x7b;
								writeFileSync(path, bytes);
							}
							return undefined;
						},
					},
				}),
			(error) => error?.code === "backup-payload-mismatch",
		);
		assert.equal(corrupted, true, "注入必须真的触发（否则这条用例什么都没证明）");
		assert.equal(existsSync(join(target, "manifest.json")), false);
		assert.equal(existsSync(target), false);
	});
});

/* ------------------------------------------------------------------ 4. 预算 */

test("D2：预算边界不返回成功", async (t) => {
	await t.test("单文件预算差一 ⇒ too-large，且不留下容器", async () => {
		const root = await makeStore("d2f-file-budget");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const recordBytes = statSync(join(root, "experiences", "exp-a.json")).size;
		const before = walk(root);
		const { target } = backupTarget("d2f-file-budget");

		await expectExportFailure({ root, target, sourceBefore: before, code: "too-large", options: { limits: { maxFileBytes: recordBytes - 1 } } });
	});

	await t.test("总 payload 预算差一 ⇒ too-large", async () => {
		const root = await makeStore("d2f-total-budget");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		const registryBytes = statSync(join(root, "registry.json")).size;
		const before = walk(root);
		const { target } = backupTarget("d2f-total-budget");

		await expectExportFailure({ root, target, sourceBefore: before, code: "too-large", options: { limits: { maxTotalPayloadBytes: registryBytes } } });
	});
});

/* ------------------------------------------------------------------ 5. 双进程竞争同一目标 */

test("D2：两个真实进程竞争同一目标目录，只有一方取得所有权", async (t) => {
	await t.test("并发导出：一方成功，另一方目标冲突；容器仍然自洽", async () => {
		const root = await makeStore("d2f-race");
		await createRecord({ root, kind: "experience-card", id: "exp-a", expectedRevision: null, now: NOW, data: experienceBody() });
		await createRecord({
			root,
			kind: "feature-record",
			id: "feat-1",
			expectedRevision: null,
			now: NOW,
			data: { originalRequirement: "并发", aliases: [], customer: { value: "c", status: "candidate", evidence: [], updatedAt: NOW }, productLine: { value: "p", status: "candidate", evidence: [], updatedAt: NOW }, acceptanceCriteria: [], relatedExperienceIds: [] },
		});
		const { target } = backupTarget("d2f-race");

		const script = `
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const config = JSON.parse(process.env.BACKUP_RACE_CONFIG);
const { exportKnowledgeBackup } = await import(config.entryUrl);
try {
	const result = await exportKnowledgeBackup({ root: config.root, backupRoot: config.backupRoot, offlineConfirmed: true, backupId: "race-backup" });
	process.stdout.write(JSON.stringify({ ok: true, files: result.files, totalBytes: result.totalBytes }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error && error.code ? error.code : "unknown" }));
}
`;
		const runChild = () =>
			new Promise((resolve) => {
				const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
					cwd: PACKAGE_ROOT,
					env: { ...process.env, BACKUP_RACE_CONFIG: JSON.stringify({ root, backupRoot: target, entryUrl: pathToFileURL(join(PACKAGE_ROOT, "core/storage/backup/index.ts")).href }) },
				});
				let stdout = "";
				child.stdout.on("data", (chunk) => {
					stdout += chunk;
				});
				child.on("close", () => resolve(JSON.parse(stdout)));
			});

		const [first, second] = await Promise.all([runChild(), runChild()]);
		const winners = [first, second].filter((outcome) => outcome.ok);
		const losers = [first, second].filter((outcome) => !outcome.ok);
		assert.equal(winners.length, 1, `必须恰好一方取得目标：${JSON.stringify([first, second])}`);
		assert.equal(losers.length, 1);
		assert.equal(losers[0].code, "backup-target-exists", "失败方必须是目标冲突，而不是共享写入");

		// 赢家的容器仍然自洽：manifest 存在、且 data/ 与清单逐项一致（没有混入失败方的字节）。
		const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
		assert.equal(manifest.backupId, "race-backup");
		const dataRoot = join(target, "data");
		for (const file of manifest.files) {
			const absolute = join(dataRoot, ...file.path.split("/"));
			assert.equal(readFileSync(absolute).byteLength, file.bytes);
			assert.equal(createHash("sha256").update(readFileSync(absolute)).digest("hex"), file.sha256);
		}
		assert.equal(winners[0].files, manifest.files.length);
	});
});
