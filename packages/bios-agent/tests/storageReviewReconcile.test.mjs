/**
 * BM-02C2B（C2B-3/C2B-4）的**永久回归**：只读巡检、显式收口、真实进程崩溃与竞争。
 *
 * 要钉死的语义：
 *
 * 1. **巡检只读**：不删 `.tmp`、不改终态，合法 v1 与审核 v2 明确分开，未知版本不猜；
 * 2. **事件先于完成终态**：恢复者在"记录已提交、事件未发布"的窗口里先补事件（`recovery`），
 *    再写完成终态；在"事件已发布、终态未写"的窗口里**认领**已有事件（保留其原始发布事实）；
 * 3. **不重放、不递增**：核对永远不改业务记录、不改 revision；
 * 4. **不无条件成功**：完成终态缺事件、意图被替换、绑定对不上都如实报不一致；
 * 5. **真实进程**：崩溃用子进程终止复现，竞争用两个真实进程复现（不是 mock 同一进程内的两次调用）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after } from "node:test";
import { auditIntentFileName } from "../core/contracts/index.ts";
import {
	buildPreparedReviewJournalRecord,
	buildReviewEvent,
	createRecord,
	createStorageBoundary,
	initializeKnowledgeStore,
	inspectPendingReviewOperations,
	prepareReviewJournalEntry,
	publishReviewEventArtifact,
	publishReviewIntentArtifact,
	reconcileReviewOperation,
	recordReviewDecision,
	StorageError,
	updateRecord,
} from "../core/storage/index.ts";
import { acquireStorageLock } from "../core/storage/lock.ts";

const STORAGE_MODULE_URL = new URL("../core/storage/index.ts", import.meta.url).href;
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-review-reconcile-")));
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const SOURCE_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";

after(() => {
	rmSync(SANDBOX, { recursive: true, force: true });
});

let rootCounter = 0;

function makeRawRoot(name) {
	rootCounter += 1;
	const root = join(SANDBOX, `${name}-${rootCounter}`);
	mkdirSync(root, { recursive: true });
	return realpathSync(root);
}

async function makeStoreRoot(name) {
	const root = makeRawRoot(name);
	await initializeKnowledgeStore({ root });
	return root;
}

/* ------------------------------------------------------------------ fixture 与工具 */

function experienceBody(status = "reviewed") {
	return {
		problem: "PXE 默认开启",
		rootCause: "Setup 默认值未调整",
		solution: "改为 Disabled",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: SOURCE_PROJECT_ID,
		evidence: [{ type: "human-note", capturedAt: NOW, validity: "active" }],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status,
	};
}

async function seedCard(root, { id = "exp-a", status = "reviewed" } = {}) {
	await createRecord({ root, kind: "experience-card", id, data: experienceBody(status), expectedRevision: null, now: NOW });
}

function recordPath(root, id = "exp-a") {
	return join(root, "experiences", `${id}.json`);
}

function journalDir(root) {
	return join(root, "journal");
}

function journalPath(root, operationId) {
	return join(journalDir(root), `${operationId}.json`);
}

function intentPath(root, operationId) {
	return join(root, "audit", "intents", auditIntentFileName(operationId));
}

function eventDir(root, recordId = "exp-a") {
	return join(root, "audit", recordId);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
}

function hashFile(path) {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function journalNames(root) {
	return existsSync(journalDir(root)) ? readdirSync(journalDir(root)).filter((name) => name.endsWith(".json")) : [];
}

function reviewJournals(root) {
	return journalNames(root)
		.map((name) => readJson(join(journalDir(root), name)))
		.filter((record) => record.journalVersion === 2);
}

function eventNames(root, recordId = "exp-a") {
	return existsSync(eventDir(root, recordId)) ? readdirSync(eventDir(root, recordId)).filter((name) => name.endsWith(".json")) : [];
}

function approval(root, overrides = {}) {
	return { root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "已比对现场日志", now: LATER, ...overrides };
}

/** 制造"记录已提交、事件未发布"的窗口：事件 link 注入失败。 */
async function makeAuditPending(root, expectedRevision = 0) {
	return await recordReviewDecision(
		approval(root, {
			expectedRevision,
			ioHooks: {
				link: async (existingPath, newPath) => {
					if (newPath.includes(`${sep}audit${sep}exp-a${sep}`)) throw Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" });
					const { link } = await import("node:fs/promises");
					return await link(existingPath, newPath);
				},
			},
		}),
	);
}

/** 制造"记录已提交、事件已发布、终态未写"的窗口：终态 rename 注入失败。 */
async function makeJournalPending(root) {
	return await recordReviewDecision(
		approval(root, {
			ioHooks: {
				beforeIo: (operation, target) => (operation === "rename" && typeof target === "string" && target.includes(`${sep}journal${sep}`) ? Promise.reject(Object.assign(new Error("注入：终态写入失败"), { code: "EACCES" })) : undefined),
			},
		}),
	);
}

function runNode(script, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			if (stdout.length > 1 << 20) child.kill("SIGKILL");
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
			if (stderr.length > 1 << 20) child.kill("SIGKILL");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			resolve({ code: null, stdout, stderr, timedOut, error });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr, timedOut, error: undefined });
		});
	});
}

function parseChild(result) {
	assert.equal(result.timedOut, false, "子进程不得超时");
	assert.equal(result.error, undefined, `子进程启动失败：${result.error?.message ?? ""}`);
	assert.equal(result.code, 0, `子进程退出码非 0：${result.stderr}`);
	return JSON.parse(result.stdout);
}

function isReviewError(code, detailPart) {
	return (error) => {
		assert.ok(error instanceof StorageError, `应当是 StorageError，实际：${String(error)}`);
		assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}`);
		if (detailPart !== undefined) assert.ok((error.detail ?? "").includes(detailPart) || error.message.includes(detailPart), `诊断应包含 ${detailPart}`);
		return true;
	};
}

function waitForPath(path, timeoutMs = 30_000) {
	const started = Date.now();
	return new Promise((resolve, reject) => {
		const tick = () => {
			if (existsSync(path)) return resolve(undefined);
			if (Date.now() - started > timeoutMs) return reject(new Error(`等待标记超时：${path}`));
			setTimeout(tick, 20);
		};
		tick();
	});
}

/* ------------------------------------------------------------------ 巡检 */

test("C2B：巡检只读 —— 只把 v2 prepared 当候选；v1 与未知版本明确区分", async () => {
	const root = await makeStoreRoot("inspect-mixed");
	await seedCard(root, { status: "draft" });
	// 一条普通写（v1，已收口）。
	await createRecord({ root, kind: "experience-card", id: "exp-b", data: experienceBody("draft"), expectedRevision: null, now: NOW });
	// 一条审核（v2 已收口）。
	const done = await recordReviewDecision(approval(root, { action: "submit-review", expectedRevision: 0 }));
	// 一条待核对（v2 prepared）。注意 submit-review 已经把记录推到 revision 1。
	const pending = await makeAuditPending(root, 1);
	// 一条未来版本（伪造）：不得被解释。
	writeJson(journalPath(root, "11111111-1111-4111-8111-111111111111"), { journalVersion: 9, journalPurpose: "review" });
	// 一条坏 JSON：保留原文件。
	writeFileSync(journalPath(root, "22222222-2222-4222-8222-222222222222"), "{ 不是 json\n", "utf8");
	// 一条**坏掉的 v1**（版本对但结构不合法）：不能被当成"普通写"计数。
	writeJson(journalPath(root, "88888888-8888-4888-8888-888888888888"), { journalVersion: 1, operationId: "88888888-8888-4888-8888-888888888888" });
	// 一条非候选（`.tmp` 残留）：跳过、不删、不报错。
	writeFileSync(join(journalDir(root), ".exp-a.json.1234.tmp"), "x", "utf8");

	const before = journalNames(root).map((name) => `${name}:${hashFile(join(journalDir(root), name))}`);
	const recordBytes = hashFile(recordPath(root));
	const revisionBeforeInspect = readJson(recordPath(root)).revision;
	const inspect = await inspectPendingReviewOperations({ root });
	assert.equal(inspect.pending.length, 1);
	assert.equal(inspect.pending[0].operationId, pending.operationId);
	assert.equal(inspect.pending[0].eventId, pending.eventId);
	assert.equal(inspect.pending[0].target.kind, "experience-card");
	assert.equal(inspect.pending[0].intentName, auditIntentFileName(pending.operationId));
	assert.equal(inspect.pending[0].intentHash.length, 64);
	assert.equal(inspect.ordinaryJournalEntries, 2, "两条 v1（初始 create + exp-b create）是普通写，不是候选也不是问题");
	assert.equal(inspect.finalized.committed, 1, "只有 submit-review 那条是已收口的审核");
	assert.equal(inspect.skippedEntries, 1, "`.tmp` 残留只计数");
	assert.ok(
		inspect.problems.some((problem) => problem.code === "unsupported-journal-version"),
		`未来版本必须作为问题保留：${JSON.stringify(inspect.problems)}`,
	);
	assert.ok(
		inspect.problems.some((problem) => problem.code === "invalid-json"),
		`坏 JSON 必须作为问题保留：${JSON.stringify(inspect.problems)}`,
	);
	// 结构不合法但 `journalVersion=1` 的文件**不是**"普通写"：否则一个坏文件会被洗成正常计数。
	assert.ok(
		inspect.problems.some((problem) => problem.relativePath.includes("88888888-8888-4888-8888-888888888888")),
		`坏掉的 v1 必须报为问题：${JSON.stringify(inspect.problems)}`,
	);
	assert.equal(
		inspect.problems.every((problem) => !problem.message.includes("不是 json")),
		true,
		"诊断不得回显文件内容",
	);

	// 只读：文件与字节都不变。
	assert.deepEqual(
		journalNames(root).map((name) => `${name}:${hashFile(join(journalDir(root), name))}`),
		before,
	);
	assert.equal(existsSync(join(journalDir(root), ".exp-a.json.1234.tmp")), true, "巡检不得删除 `.tmp` 残留");
	assert.equal(hashFile(recordPath(root)), recordBytes, "巡检不得改业务记录");
	assert.equal(readJson(recordPath(root)).revision, revisionBeforeInspect);
	assert.equal(done.kind, "applied");
	assert.equal(pending.kind, "applied-audit-pending");
});

test("C2B：巡检的预算语义（0 = 一条候选都放不下）与中途取消", async () => {
	const root = await makeStoreRoot("inspect-budget");
	await seedCard(root);
	await makeAuditPending(root);

	const zero = await inspectPendingReviewOperations({ root, limits: { maxJournalInspectEntries: 0 } });
	assert.equal(zero.pending.length, 0);
	assert.equal(zero.truncated, true);
	assert.ok(zero.truncatedBy.includes("entries"));

	const zeroBytes = await inspectPendingReviewOperations({ root, limits: { maxJournalInspectBytes: 1 } });
	assert.equal(zeroBytes.pending.length, 0, "预算小于空数组信封时连一条都不返回");
	assert.ok(zeroBytes.truncatedBy.includes("bytes"));

	const zeroScan = await inspectPendingReviewOperations({ root, limits: { maxJournalScanEntries: 0 } });
	assert.equal(zeroScan.scanned, 0);
	assert.ok(zeroScan.truncatedBy.includes("scan"));

	// 取消在扫描途中生效：不能返回"看起来完整"的结果。
	const controller = new AbortController();
	await assert.rejects(inspectPendingReviewOperations({ root, signal: controller.signal, ioHooks: { beforeIo: (operation) => (operation === "read" ? (controller.abort(), Promise.reject(Object.assign(new Error("取消"), { code: "ECANCELED" }))) : undefined) } }), isReviewError("cancelled"));
});

/* ------------------------------------------------------------------ 收口的确定结论 */

test("C2B：核对不存在的操作 → not-found；v1 → not-review；未知版本/坏文件 → unreadable（不改文件）", async () => {
	const root = await makeStoreRoot("reconcile-shapes");
	await seedCard(root, { status: "draft" });
	const submit = await recordReviewDecision(approval(root, { action: "submit-review", expectedRevision: 0 }));

	await assert.rejects(reconcileReviewOperation({ root, operationId: "33333333-3333-4333-8333-333333333333" }), isReviewError("not-found"));
	await assert.rejects(reconcileReviewOperation({ root, operationId: "not-a-uuid" }), isReviewError("invalid-record", "invalid-operation-id"));

	const ordinary = await createRecord({ root, kind: "experience-card", id: "exp-b", data: experienceBody("draft"), expectedRevision: null, now: NOW });
	const notReview = await reconcileReviewOperation({ root, operationId: ordinary.journal.operationId });
	assert.equal(notReview.outcome, "not-review");
	assert.equal(notReview.changed, false);
	assert.equal(hashFile(journalPath(root, ordinary.journal.operationId)), hashFile(journalPath(root, ordinary.journal.operationId)));

	const unknownId = "44444444-4444-4444-8444-444444444444";
	writeJson(journalPath(root, unknownId), { journalVersion: 7, journalPurpose: "review" });
	const unknown = await reconcileReviewOperation({ root, operationId: unknownId });
	assert.equal(unknown.outcome, "unreadable");
	assert.equal(unknown.changed, false);
	assert.equal(readJson(journalPath(root, unknownId)).journalVersion, 7, "未知版本原文件必须保留");

	const brokenId = "55555555-5555-4555-8555-555555555555";
	writeFileSync(journalPath(root, brokenId), "{ broken\n", "utf8");
	const broken = await reconcileReviewOperation({ root, operationId: brokenId });
	assert.equal(broken.outcome, "unreadable");
	assert.equal(readFileSync(journalPath(root, brokenId), "utf8"), "{ broken\n");

	// 已收口的提交类操作仍然可被核对（幂等 + 三方绑定）。
	const recon = await reconcileReviewOperation({ root, operationId: submit.operationId });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.audit?.publication, "writer");
});

test("C2B：目标为 before → aborted（不发事件）；目标为 after → 发布 recovery 事件后收口", async () => {
	const root = await makeStoreRoot("reconcile-before-after");
	await seedCard(root);

	// 用"提交前取消"制造 prepared + 目标仍是 before 的现场。
	const controller = new AbortController();
	await assert.rejects(
		recordReviewDecision(
			approval(root, {
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "rename" && typeof target === "string" && target.includes(`${sep}experiences${sep}`)) controller.abort();
						return undefined;
					},
				},
			}),
		),
		isReviewError("cancelled"),
	);
	const abortedCandidate = reviewJournals(root).find((record) => record.state === "prepared");
	assert.ok(abortedCandidate !== undefined, "取消后应留下 prepared 记录");
	const recordBefore = hashFile(recordPath(root));

	const recon = await reconcileReviewOperation({ root, operationId: abortedCandidate.operationId, now: LATER + 10 });
	assert.equal(recon.outcome, "aborted");
	assert.equal(recon.changed, true);
	assert.equal(recon.audit, null);
	assert.equal(readJson(journalPath(root, abortedCandidate.operationId)).source, "recovery-observed");
	assert.equal(hashFile(recordPath(root)), recordBefore, "核对不得改动业务记录");
	assert.deepEqual(eventNames(root), [], "未提交的操作不得产生事件");
});

test("C2B：目标为 after → 先补事件（recovery）再写完成终态；重复核对幂等且不递增 revision", async () => {
	const root = await makeStoreRoot("reconcile-after");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	const recordBytes = hashFile(recordPath(root));
	const intentBytes = hashFile(intentPath(root, pending.operationId));

	const first = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 11 });
	assert.equal(first.outcome, "committed");
	assert.equal(first.changed, true);
	assert.equal(first.audit?.publication, "recovery");
	assert.equal(first.audit?.recordedAt, LATER + 11);
	assert.equal(first.observed?.revision, 1);
	const event = readJson(join(eventDir(root), `${pending.eventId}.json`));
	assert.equal(event.publication, "recovery");
	assert.equal(event.recordedAt, LATER + 11);
	assert.equal(event.decidedAt, LATER, "决定时间是意图里的值，恢复不得改写");
	assert.equal(event.operatorLabel, "bob");
	assert.equal(readJson(journalPath(root, pending.operationId)).state, "committed");
	assert.equal(hashFile(recordPath(root)), recordBytes, "核对不得重放记录");
	assert.equal(hashFile(intentPath(root, pending.operationId)), intentBytes, "意图字节不得被改写");

	const second = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 99 });
	assert.equal(second.outcome, "committed");
	assert.equal(second.changed, false, "已收口后再核对是幂等的");
	assert.equal(second.audit?.publication, "recovery");
	assert.equal(second.audit?.recordedAt, LATER + 11, "发布时间不得被重打");
	assert.equal(eventNames(root).length, 1, "不得重复发布事件");
	assert.equal(readJson(recordPath(root)).revision, 1);
});

test("C2B：事件已存在（writer）时恢复必须**认领**，保留其原始发布事实", async () => {
	const root = await makeStoreRoot("reconcile-claim");
	await seedCard(root);
	const pending = await makeJournalPending(root);
	assert.equal(pending.kind, "applied-journal-pending");
	const eventBytes = hashFile(join(eventDir(root), `${pending.eventId}.json`));

	const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 50 });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.audit?.publication, "writer", "认领不得把 writer 改写成 recovery");
	assert.equal(recon.audit?.recordedAt, LATER, "认领不得用恢复时间替换原始发布时间");
	assert.equal(hashFile(join(eventDir(root), `${pending.eventId}.json`)), eventBytes, "事件字节必须逐字节不变");
});

test("C2B：目标 revision 更高 → conflict（写终态但不动业务、不发事件）", async () => {
	const root = await makeStoreRoot("reconcile-conflict");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	// 让记录继续前进（模拟"恢复前又有人合法地改过"）。
	const { updateRecord } = await import("../core/storage/index.ts");
	await updateRecord({ root, kind: "experience-card", id: "exp-a", data: experienceBody("verified"), expectedRevision: 1, now: LATER + 1 });
	const recordBytes = hashFile(recordPath(root));

	const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 60 });
	assert.equal(recon.outcome, "conflict");
	assert.equal(recon.changed, true);
	assert.equal(readJson(journalPath(root, pending.operationId)).state, "conflict");
	assert.equal(readJson(journalPath(root, pending.operationId)).source, "recovery-observed");
	assert.equal(hashFile(recordPath(root)), recordBytes, "冲突时不得改业务");
	assert.deepEqual(eventNames(root), [], "冲突时不得发事件");
});

test("C2B：意图缺失/被替换/事件缺失 → 如实报不一致，不发布、不写终态", async (t) => {
	await t.test("意图缺失", async () => {
		const root = await makeStoreRoot("reconcile-no-intent");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		rmSync(intentPath(root, pending.operationId));
		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 70 });
		assert.equal(recon.outcome, "inconsistent");
		assert.equal(recon.changed, false);
		assert.equal(recon.audit, null);
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", "不解释的现场必须原样保留");
		assert.deepEqual(eventNames(root), [], "意图缺失时不得凭空发布事件");
	});

	await t.test("意图被替换（原字节指纹对不上）", async () => {
		const root = await makeStoreRoot("reconcile-swapped-intent");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const intent = readJson(intentPath(root, pending.operationId));
		writeJson(intentPath(root, pending.operationId), { ...intent, reason: "被替换过的理由" });
		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 70 });
		assert.equal(recon.outcome, "inconsistent");
		assert.ok(recon.detail?.includes("指纹"), `诊断应指出指纹不符：${recon.detail ?? ""}`);
		assert.deepEqual(eventNames(root), []);
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared");
	});

	await t.test("完成终态缺事件 → inconsistent（不无条件成功）", async () => {
		const root = await makeStoreRoot("reconcile-committed-no-event");
		await seedCard(root);
		const done = await recordReviewDecision(approval(root));
		rmSync(join(eventDir(root), `${done.eventId}.json`));
		const recon = await reconcileReviewOperation({ root, operationId: done.operationId });
		assert.equal(recon.outcome, "inconsistent");
		assert.equal(recon.changed, false);
		assert.equal(recon.journalState, "committed", "如实报告 journal 的终态，但不冒充成功");
		assert.equal(readJson(journalPath(root, done.operationId)).state, "committed", "不得改写已有终态");
	});

	/**
	 * 目标停在 before、但绑定的 event 路径上已经有事件：这是**矛盾现场**。
	 *
	 * 这里替换掉了旧断言（"第一次 aborted、第二次才 inconsistent"）——它把错误行为写成了预期：
	 * 事件路径由 `recordId`/`eventId` **精确派生**，第一次核对就能读到，不需要额外扫描整个目录。
	 * 先写 `aborted` 再在下一次核对里发现矛盾，等于用一次假的收口改掉现场（人看到的是
	 * "第二次核对突然不一致"，而不是"这条操作从一开始就有矛盾"）。
	 * 正确行为：**第一次就拒绝收口**，不写终态、不动事件、不改业务。
	 */
	await t.test("目标为 before 却已存在事件 → 第一次就 inconsistent（不写 aborted，不改现场）", async () => {
		const root = await makeStoreRoot("reconcile-aborted-with-event");
		await seedCard(root);
		// 用低层工件函数构造一个**自洽**的矛盾现场：目标确实停在 before，但事件已经存在。
		const boundary = await createStorageBoundary({ root });
		const operationId = "66666666-6666-4666-8666-666666666666";
		const eventId = "77777777-7777-4777-8777-777777777777";
		const before = { revision: 0, hash: hashFile(recordPath(root)) };
		const intent = {
			intentVersion: 1,
			purpose: "review",
			eventId,
			operationId,
			target: { kind: "experience-card", recordId: "exp-a" },
			action: "approve",
			fromStatus: "reviewed",
			toStatus: "verified",
			operatorLabel: "bob",
			decidedAt: LATER,
			reason: "矛盾现场",
			before,
			after: { revision: 1, hash: "b".repeat(64) },
			evidence: [],
		};
		const intentPublished = await publishReviewIntentArtifact(boundary, intent);
		await prepareReviewJournalEntry(
			boundary,
			buildPreparedReviewJournalRecord({
				operationId,
				eventId,
				intentName: auditIntentFileName(operationId),
				intentHash: intentPublished.hash,
				target: { kind: "experience-card", id: "exp-a" },
				before,
				after: intent.after,
				preparedAt: LATER,
			}),
		);
		await publishReviewEventArtifact(boundary, buildReviewEvent(intent, "writer", LATER));
		assert.equal(eventNames(root).length, 1);

		const journalBytes = hashFile(journalPath(root, operationId));
		const eventBytes = hashFile(join(eventDir(root), `${eventId}.json`));
		const recordBytes = hashFile(recordPath(root));

		const first = await reconcileReviewOperation({ root, operationId, now: LATER + 70 });
		assert.equal(first.outcome, "inconsistent", "第一次核对就必须报出「未提交却有事件」");
		assert.equal(first.changed, false, "矛盾现场不得被收口");
		assert.equal(first.journalState, "prepared");
		assert.equal(hashFile(journalPath(root, operationId)), journalBytes, "不得写 aborted");
		assert.equal(hashFile(join(eventDir(root), `${eventId}.json`)), eventBytes, "不得删除/覆盖事件");
		assert.equal(hashFile(recordPath(root)), recordBytes, "不得改业务");
		assert.ok(first.detail?.includes("before"), `诊断应指出目标仍停在 before：${first.detail ?? ""}`);

		// 幂等：重复核对得到同一个结论（矛盾不会"自己好起来"）。
		const again = await reconcileReviewOperation({ root, operationId, now: LATER + 71 });
		assert.equal(again.outcome, "inconsistent");
		assert.equal(again.changed, false);
	});
});

test("C2B：目标锁被他人持有 → busy；不抢锁、不改任何文件", async () => {
	const root = await makeStoreRoot("reconcile-busy");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	const boundary = await createStorageBoundary({ root });
	const foreign = await acquireStorageLock(boundary, { target: recordPath(root), timeoutMs: 0, now: NOW });
	const journalBytes = hashFile(journalPath(root, pending.operationId));
	try {
		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, lockTimeoutMs: 0, lockPollMs: 10 });
		assert.equal(recon.outcome, "busy");
		assert.equal(recon.changed, false);
	} finally {
		await foreign.release();
	}
	assert.equal(hashFile(journalPath(root, pending.operationId)), journalBytes);
	assert.deepEqual(eventNames(root), []);
	assert.equal(readJson(recordPath(root)).revision, 1);
});

/* ------------------------------------------------------------------ R2：完整绑定与首次矛盾 */

/**
 * 把意图上的某处改掉，并把 journal 绑定的指纹更新为**改后文件的真实 hash**。
 *
 * 这是最狡猾的伪造形态：只比对"声明指纹 == 实测指纹"的实现会完全放行它，
 * 所以必须靠"投影 ↔ 意图逐项比较"（target/before/after/eventId/operationId）拦下来。
 */
function forgeIntent(root, operationId, mutate) {
	const mutated = structuredClone(readJson(intentPath(root, operationId)));
	mutate(mutated);
	writeJson(intentPath(root, operationId), mutated);
	const journal = readJson(journalPath(root, operationId));
	writeJson(journalPath(root, operationId), { ...journal, intentHash: hashFile(intentPath(root, operationId)) });
}

test("R2：改意图的 target/before/after 并把 journal 绑到新真实指纹 → 逐项拒绝", async (t) => {
	const scenarios = [
		["意图 target 换成另一条记录", (intent) => (intent.target.recordId = "exp-b")],
		["意图 before.hash 换成另一个合法 hash", (intent) => (intent.before.hash = "c".repeat(64))],
		["意图 after.hash 换成另一个合法 hash", (intent) => (intent.after.hash = "d".repeat(64))],
	];
	let counter = 0;
	for (const [label, mutate] of scenarios) {
		counter += 1;
		await t.test(label, async () => {
			const root = await makeStoreRoot(`r2-forged-${counter}`);
			await seedCard(root);
			const pending = await makeAuditPending(root);
			const recordBytes = hashFile(recordPath(root));
			forgeIntent(root, pending.operationId, mutate);
			const forgedIntentBytes = hashFile(intentPath(root, pending.operationId));
			const forgedJournalBytes = hashFile(journalPath(root, pending.operationId));

			const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 80 });
			assert.equal(recon.outcome, "inconsistent", `${label}：必须拒绝收口`);
			assert.equal(recon.changed, false, `${label}：不得写终态`);
			assert.equal(recon.audit, null, `${label}：不得报告任何审计事实`);
			assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", `${label}：journal 必须原样停在 prepared`);
			assert.deepEqual(eventNames(root), [], `${label}：不得发布事件`);
			assert.equal(existsSync(join(root, "audit", "exp-b")), false, `${label}：不得按伪造的 target 建目录`);
			assert.equal(hashFile(recordPath(root)), recordBytes, `${label}：不得改业务`);
			assert.equal(hashFile(intentPath(root, pending.operationId)), forgedIntentBytes, `${label}：不得改写意图`);
			assert.equal(hashFile(journalPath(root, pending.operationId)), forgedJournalBytes, `${label}：不得改写 journal`);
			assert.ok(recon.detail?.includes("绑定"), `${label}：诊断应指出绑定对不上：${recon.detail ?? ""}`);
		});
	}
});

test("R2：持锁等待期间 journal 被换成别的目标 → unreadable（不拿旧锁给新目标记账）", async () => {
	const root = await makeStoreRoot("r2-target-swap");
	await seedCard(root);
	await seedCard(root, { id: "exp-b" });
	const pending = await makeAuditPending(root);
	const recordBytes = hashFile(recordPath(root));
	const otherBytes = hashFile(recordPath(root, "exp-b"));

	// 锁是在"读 journal"之后才创建的：这里在**锁等待窗口**里把 journal 的目标换掉。
	const recon = await reconcileReviewOperation({
		root,
		operationId: pending.operationId,
		now: LATER + 90,
		ioHooks: {
			beforeIo: (operation) => {
				if (operation !== "lock-mkdir") return undefined;
				const record = readJson(journalPath(root, pending.operationId));
				if (record.target.id !== "exp-b") writeJson(journalPath(root, pending.operationId), { ...record, target: { ...record.target, id: "exp-b" } });
				return undefined;
			},
		},
	});

	assert.equal(recon.outcome, "unreadable", "锁定期间目标变化必须拒绝，而不是按新目标收口");
	assert.equal(recon.changed, false);
	assert.equal(readJson(journalPath(root, pending.operationId)).target.id, "exp-b", "核对不得把 journal 改回旧目标");
	assert.equal(hashFile(recordPath(root, "exp-b")), otherBytes, "不得动被换上的目标");
	assert.equal(hashFile(recordPath(root)), recordBytes, "不得动原目标");
	assert.deepEqual(eventNames(root), []);
	assert.deepEqual(eventNames(root, "exp-b"), [], "不得给被换上的目标写事件");
});

test("R2：意图是未来版本 / 绑定路径上是坏事件 → 保留现场（inconsistent / unreadable）", async (t) => {
	await t.test("意图 intentVersion 不是本实现支持的版本", async () => {
		const root = await makeStoreRoot("r2-future-intent");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const intent = readJson(intentPath(root, pending.operationId));
		writeJson(intentPath(root, pending.operationId), { ...intent, intentVersion: 9 });
		const bytes = hashFile(intentPath(root, pending.operationId));

		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 95 });
		assert.equal(recon.outcome, "inconsistent");
		assert.equal(recon.changed, false);
		assert.deepEqual(eventNames(root), [], "不可解释的意图不得被用来发布事件");
		assert.equal(hashFile(intentPath(root, pending.operationId)), bytes, "原文件必须保留");
	});

	await t.test("绑定路径上的事件是坏 JSON", async () => {
		const root = await makeStoreRoot("r2-broken-event");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		mkdirSync(eventDir(root), { recursive: true });
		writeFileSync(join(eventDir(root), `${pending.eventId}.json`), "{ 坏掉的事件\n", "utf8");
		const bytes = hashFile(join(eventDir(root), `${pending.eventId}.json`));

		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 96 });
		assert.equal(recon.outcome, "unreadable", "读不懂的事件必须保留原文件，不能当成缺失");
		assert.equal(recon.changed, false);
		assert.equal(hashFile(join(eventDir(root), `${pending.eventId}.json`)), bytes, "坏事件字节不变");
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared");
	});
});

/* ------------------------------------------------------------------ F1（C2BR2）：conflict 也要先过完整绑定 */

/** 把现场推进到"目标既不是 before 也不是 after"：业务被**合法**更新到下一个 revision。 */
async function advanceBeyondAfter(root, id = "exp-a") {
	await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: { ...experienceBody("reviewed"), problem: "PXE 默认开启（后续合法更新）" },
		expectedRevision: 1,
		now: LATER + 10,
	});
}

/**
 * F1：目标合法地被更新到更高 revision 时，`conflict` 也是**收口**——
 * 它必须在写完之前先过**完整绑定**（意图真实字节指纹 + 逐项关联），
 * 否则"意图缺失/坏/未来版本/错绑定"会被一次 conflict 终态掩盖：
 * 之后再次核对只会走 `verifyTerminalState` 的 conflict 分支，`changed=true` 还让人以为已经收口。
 */
test("F1：目标既非 before 也非 after 时，也必须先过完整绑定（缺失/坏/未来/错绑定都不写终态）", async (t) => {
	const scenarios = [
		["意图被删除", "意图缺失", (root, operationId) => rmSync(intentPath(root, operationId), { force: true })],
		[
			"意图 intentVersion=99",
			"不可解释",
			(root, operationId) => {
				const intent = readJson(intentPath(root, operationId));
				writeJson(intentPath(root, operationId), { ...intent, intentVersion: 99 });
			},
		],
		["意图是坏 JSON", "不可解释", (root, operationId) => writeFileSync(intentPath(root, operationId), "{ 坏掉的意图\n", "utf8")],
		[
			"意图字节被改（journal.intentHash 保持旧值）",
			"绑定不一致",
			(root, operationId) => {
				const intent = readJson(intentPath(root, operationId));
				writeJson(intentPath(root, operationId), { ...intent, reason: "被替换过的理由" });
			},
		],
		["意图 target 改成 exp-b 并同步 journal.intentHash", "绑定不一致", (root, operationId) => forgeIntent(root, operationId, (intent) => (intent.target.recordId = "exp-b"))],
		["意图 eventId 改动并同步 journal.intentHash", "绑定不一致", (root, operationId) => forgeIntent(root, operationId, (intent) => (intent.eventId = "77777777-7777-4777-8777-777777777777"))],
		["意图 before.hash 改动并同步 journal.intentHash", "绑定不一致", (root, operationId) => forgeIntent(root, operationId, (intent) => (intent.before.hash = "c".repeat(64)))],
		["意图 after.hash 改动并同步 journal.intentHash", "绑定不一致", (root, operationId) => forgeIntent(root, operationId, (intent) => (intent.after.hash = "d".repeat(64)))],
	];
	let counter = 0;
	for (const [label, expectedDetail, mutate] of scenarios) {
		counter += 1;
		await t.test(label, async () => {
			const root = await makeStoreRoot(`f1-conflict-binding-${counter}`);
			await seedCard(root);
			const pending = await makeAuditPending(root);
			await advanceBeyondAfter(root);
			mutate(root, pending.operationId);

			const before = {
				journal: hashFile(journalPath(root, pending.operationId)),
				record: hashFile(recordPath(root)),
				intent: hashFile(intentPath(root, pending.operationId)),
			};

			const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 200 });

			// 结论与"目标=after"时**同一口径**：绑定失败一律 `inconsistent`，不随目标指纹分支漂移。
			assert.equal(recon.outcome, "inconsistent", `${label}：${recon.detail ?? ""}`);
			assert.ok(recon.detail?.includes(expectedDetail), `${label}：诊断应说明原因（${expectedDetail}）：${recon.detail ?? ""}`);
			assert.equal(recon.changed, false, `${label}：不得写任何终态`);
			assert.equal(recon.journalState, "prepared", `${label}：journal 必须仍停在 prepared`);
			assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", `${label}：journal 状态不得被改写`);
			assert.equal(hashFile(journalPath(root, pending.operationId)), before.journal, `${label}：journal 字节必须不变`);
			assert.equal(hashFile(recordPath(root)), before.record, `${label}：业务字节不得变`);
			assert.equal(hashFile(intentPath(root, pending.operationId)), before.intent, `${label}：意图字节不得变`);
			assert.equal(readJson(recordPath(root)).revision, 2, `${label}：业务 revision 不得被核对改动`);
			assert.deepEqual(eventNames(root), [], `${label}：不得发布事件`);
		});
	}
});

/** F1 正例：绑定完整时，`conflict` 仍是协议要求的收口——不能为了拒绝负例而取消所有 conflict。 */
test("F1 正例：合法完整绑定 + 目标后续合法更新 → 仍记 conflict，再次核对幂等", async () => {
	const root = await makeStoreRoot("f1-conflict-positive");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	await advanceBeyondAfter(root);
	const recordBytes = hashFile(recordPath(root));

	const first = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 210 });
	assert.equal(first.outcome, "conflict", `合法绑定 + 目标已更新：按协议记 conflict（${first.detail ?? ""}）`);
	assert.equal(first.changed, true);
	assert.equal(first.journalState, "conflict");
	assert.equal(readJson(journalPath(root, pending.operationId)).state, "conflict");
	assert.equal(first.audit, null, "conflict 不得报告审计事实");
	assert.equal(hashFile(recordPath(root)), recordBytes, "不得改业务");
	assert.equal(readJson(recordPath(root)).revision, 2);
	assert.deepEqual(eventNames(root), [], "conflict 不发布事件");

	const again = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 220 });
	assert.equal(again.outcome, "conflict", "已记 conflict 的现场必须幂等返回");
	assert.equal(again.changed, false);
	assert.equal(hashFile(recordPath(root)), recordBytes);
	assert.deepEqual(eventNames(root), []);
});

/* ------------------------------------------------------------------ R3：认领与阶段真相 */

test("R3：已有 writer 事件 + 恢复时钟早于决定时间 → 直接认领，不抛 invalid-record", async () => {
	const root = await makeStoreRoot("r3-claim-clock-back");
	await seedCard(root);
	const pending = await makeJournalPending(root);
	assert.equal(pending.kind, "applied-journal-pending");
	const eventBytes = hashFile(join(eventDir(root), `${pending.eventId}.json`));

	// 时钟回拨到**决定之前**：旧实现先用这个时间构造新候选并校验，于是抛 invalid-record，
	// 连一条已经存在的合法事实都认领不了。
	const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER - 5_000 });
	assert.equal(recon.outcome, "committed", "已有事实必须直接认领，不受本次时钟影响");
	assert.equal(recon.changed, true);
	assert.equal(recon.audit?.publication, "writer");
	assert.equal(recon.audit?.recordedAt, LATER, "认领保留原 recordedAt，不用回拨的时钟重打");
	assert.equal(hashFile(join(eventDir(root), `${pending.eventId}.json`)), eventBytes, "事件字节必须逐字节不变");
	assert.equal(eventNames(root).length, 1, "不得重复发布");
});

test("R3：事件缺失 + 时钟早于决定时间 → pending（不伪造发布事实，可校准后重试）", async () => {
	const root = await makeStoreRoot("r3-publish-clock-back");
	await seedCard(root);
	const pending = await makeAuditPending(root);

	const blocked = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER - 1 });
	assert.equal(blocked.outcome, "pending", "时钟不合法时只能报「待补」，不能报失败或成功");
	assert.equal(blocked.audit, null);
	assert.equal(blocked.changed, false);
	assert.equal(blocked.observed?.revision, 1, "业务已确认提交到 after 这一事实必须报出来");
	assert.equal(blocked.journalState, "prepared");
	assert.deepEqual(eventNames(root), [], "不得发布一条记录时间早于决定的事件");
	assert.ok(blocked.detail?.includes("时钟"), `诊断应说明时钟问题：${blocked.detail ?? ""}`);

	// 校准时钟后同一现场可以正常收口（这是"可重试"而不是"卡死"）。
	const retried = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 120 });
	assert.equal(retried.outcome, "committed");
	assert.equal(retried.audit?.publication, "recovery");
	assert.equal(retried.audit?.recordedAt, LATER + 120);
});

test("R3：绑定路径上已有合法但决定不同的事件 → 拒绝认领，不覆盖", async () => {
	const root = await makeStoreRoot("r3-conflicting-event");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	const boundary = await createStorageBoundary({ root });

	// 手工放一条**结构合法**、但理由不同的事件到绑定路径上（同 eventId、同目标）。
	const intent = readJson(intentPath(root, pending.operationId));
	await publishReviewEventArtifact(boundary, buildReviewEvent({ ...intent, reason: "另一个人的决定" }, "writer", LATER));
	const eventBytes = hashFile(join(eventDir(root), `${pending.eventId}.json`));

	const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 130 });
	assert.equal(recon.outcome, "inconsistent");
	assert.equal(recon.changed, false);
	assert.equal(recon.audit, null);
	assert.equal(hashFile(join(eventDir(root), `${pending.eventId}.json`)), eventBytes, "冲突事件不得被覆盖");
	assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", "不得写终态");
});

test("R3：事件发布失败 → 结构化 pending（不把异常抛给调用方，也不暗示业务未提交）", async () => {
	const root = await makeStoreRoot("r3-publish-fail");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	const recordBytes = hashFile(recordPath(root));

	const recon = await reconcileReviewOperation({
		root,
		operationId: pending.operationId,
		now: LATER + 140,
		ioHooks: {
			link: async (existingPath, newPath) => (newPath.includes(`${sep}audit${sep}exp-a${sep}`) ? Promise.reject(Object.assign(new Error("注入：发布失败"), { code: "ENOSPC" })) : (await import("node:fs/promises")).link(existingPath, newPath)),
		},
	});

	assert.equal(recon.outcome, "pending", "已观察为 after 的 IO 失败必须是「待补」，而不是抛异常");
	assert.equal(recon.audit, null);
	assert.equal(recon.observed?.revision, 1, "必须给出业务已到 after 的观察结果");
	assert.equal(recon.journalState, "prepared");
	assert.equal(recon.changed, false);
	assert.ok(recon.detail?.includes("可重试"), `诊断应说明可重试：${recon.detail ?? ""}`);
	assert.deepEqual(eventNames(root), [], "发布失败不得留下事件文件");
	assert.equal(hashFile(recordPath(root)), recordBytes, "不得改动业务");
	assert.equal(readJson(recordPath(root)).revision, 1, "不得重放/递增 revision");
});

test("R3：终态写入失败 → pending，且已发布的事件事实照实返回", async () => {
	const root = await makeStoreRoot("r3-terminal-fail");
	await seedCard(root);
	const pending = await makeAuditPending(root);

	const recon = await reconcileReviewOperation({
		root,
		operationId: pending.operationId,
		now: LATER + 150,
		ioHooks: {
			beforeIo: (operation, target) => (operation === "rename" && typeof target === "string" && target.includes(`${sep}journal${sep}`) ? Promise.reject(Object.assign(new Error("注入：终态失败"), { code: "EACCES" })) : undefined),
		},
	});

	assert.equal(recon.outcome, "pending", "终态没写成就不能报 committed");
	assert.equal(recon.changed, false);
	assert.equal(recon.audit?.publication, "recovery", "已经发布的事实不能因为终态失败而丢失");
	assert.equal(recon.audit?.recordedAt, LATER + 150);
	assert.equal(recon.journalState, "prepared");
	assert.equal(eventNames(root).length, 1, "事件已经发布");
	assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", "journal 必须仍是 prepared");
	assert.ok(
		(recon.warnings ?? []).some((warning) => warning.includes("终态未写入")),
		`应给出可行动警告：${JSON.stringify(recon.warnings ?? [])}`,
	);
});

test("R3：取消语义 —— 发布前可穿透，发布后不丢已知事实", async (t) => {
	await t.test("事件发布之前取消 → cancelled 穿透", async () => {
		const root = await makeStoreRoot("r3-cancel-before-publish");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const controller = new AbortController();
		await assert.rejects(
			reconcileReviewOperation({
				root,
				operationId: pending.operationId,
				now: LATER + 160,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "link" && typeof target === "string" && target.includes(`${sep}audit${sep}exp-a${sep}`)) controller.abort();
						return undefined;
					},
				},
			}),
			isReviewError("cancelled"),
		);
		assert.deepEqual(eventNames(root), [], "取消发生在发布之前：不得留下事件");
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared");
	});

	await t.test("事件发布之后取消 → pending 且带已发布事实", async () => {
		const root = await makeStoreRoot("r3-cancel-after-publish");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const controller = new AbortController();
		const recon = await reconcileReviewOperation({
			root,
			operationId: pending.operationId,
			now: LATER + 170,
			signal: controller.signal,
			ioHooks: {
				beforeIo: (operation, target) => {
					// 终态写入（journal rename）是事件之后的第一个写：在这里取消正好复现"发布后取消"。
					if (operation === "rename" && typeof target === "string" && target.includes(`${sep}journal${sep}`)) controller.abort();
					return undefined;
				},
			},
		});
		assert.equal(recon.outcome, "pending", "迟到取消不能把已经发布的审计事实丢掉");
		assert.equal(recon.audit?.publication, "recovery");
		assert.equal(eventNames(root).length, 1, "事实已经存在");
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared");
	});
});

/* ------------------------------------------------------------------ R4：恢复阶段的工件清理 */

/** 让某个目录下的 `unlink-temp` 全部失败（只针对本用例的知识根）。 */
function failUnlinkTempIn(root, marker) {
	return {
		beforeIo: (operation, target) => (operation === "unlink-temp" && typeof target === "string" && target.startsWith(root) && target.includes(marker) ? Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EACCES" })) : undefined),
	};
}

function tempLeftoversIn(root, ...segments) {
	const dir = join(root, ...segments);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".tmp")) : [];
}

test("R4：恢复阶段的工件清理失败必须逐件可见（事件 exists 分支也不丢）", async (t) => {
	await t.test("发布 recovery 事件时的事件目录清理失败", async () => {
		const root = await makeStoreRoot("r4-recovery-event-cleanup");
		await seedCard(root);
		const pending = await makeAuditPending(root);

		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 600, ioHooks: failUnlinkTempIn(root, `${sep}audit${sep}exp-a${sep}`) });

		assert.equal(recon.outcome, "committed", "清理失败不影响结论");
		assert.ok(
			recon.artifactCleanup.some((entry) => entry.artifact === "event"),
			`artifactCleanup 必须含 event：${JSON.stringify(recon.artifactCleanup)}`,
		);
		assert.ok(
			(recon.warnings ?? []).some((warning) => warning.includes("清理失败")),
			`warnings 必须说明残留：${JSON.stringify(recon.warnings ?? [])}`,
		);
		assert.ok(tempLeftoversIn(root, "audit", "exp-a").length >= 1, "磁盘上必须真的留下 .tmp");
	});

	await t.test("写终态的 journal 临时文件清理失败", async () => {
		const root = await makeStoreRoot("r4-recovery-journal-cleanup");
		await seedCard(root);
		const pending = await makeAuditPending(root);

		const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 610, ioHooks: failUnlinkTempIn(root, `${sep}journal${sep}`) });

		assert.equal(recon.outcome, "committed");
		assert.ok(
			recon.artifactCleanup.some((entry) => entry.artifact === "review-journal"),
			`artifactCleanup 必须含 review-journal：${JSON.stringify(recon.artifactCleanup)}`,
		);
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "committed", "结论不受清理诊断影响");
		// 终态走 `replaceJson`：临时文件被 `rename` **改名成目标本身**，成功后不存在第二份文件
		// （这与 `publishJsonMeasured` 的硬链接语义不同，因此不能一概要求"磁盘上一定有 .tmp"）。
		assert.deepEqual(tempLeftoversIn(root, "journal"), [], "rename 已把临时文件变成目标：没有额外 .tmp");
	});

	await t.test("事件撞名（exists）分支的清理结果也必须上报", async () => {
		const root = await makeStoreRoot("r4-recovery-event-exists-cleanup");
		await seedCard(root);
		const pending = await makeAuditPending(root);

		// 模拟"另一个恢复者抢先发布"：目标先出现，再返回 EEXIST；同时让事件临时文件删不掉。
		const recon = await reconcileReviewOperation({
			root,
			operationId: pending.operationId,
			now: LATER + 620,
			ioHooks: {
				link: async (existingPath, newPath) => {
					if (!newPath.includes(`${sep}audit${sep}exp-a${sep}`)) return (await import("node:fs/promises")).link(existingPath, newPath);
					writeFileSync(newPath, readFileSync(existingPath));
					throw Object.assign(new Error("注入：目标已存在"), { code: "EEXIST" });
				},
				...failUnlinkTempIn(root, `${sep}audit${sep}exp-a${sep}`),
			},
		});

		assert.equal(recon.outcome, "committed", "撞名后按认领规则收口");
		assert.equal(recon.audit?.publication, "recovery");
		assert.ok(
			recon.artifactCleanup.some((entry) => entry.artifact === "event"),
			`exists 分支不得丢掉事件清理结果：${JSON.stringify(recon.artifactCleanup)}`,
		);
		assert.equal(eventNames(root).length, 1, "不得重复发布");
	});
});

/* ------------------------------------------------------------------ F2（C2BR2）：恢复失败路径的清理事实 */

/**
 * F2：恢复阶段的发布/终态失败由 `boundary` 抛出，附加的是**业务**清理文案。
 * 提取器原先只认审核专用文案，于是"磁盘上真的留了 `.tmp`"在结果里完全不可见。
 */
test("F2：恢复失败路径必须带上实际发生的工件清理诊断", async (t) => {
	await t.test("事件发布失败 + 事件临时文件删不掉 → pending + event 诊断", async () => {
		const root = await makeStoreRoot("f2-recovery-event-cleanup");
		await seedCard(root);
		const pending = await makeAuditPending(root);

		const recon = await reconcileReviewOperation({
			root,
			operationId: pending.operationId,
			now: LATER + 300,
			ioHooks: {
				link: async (existingPath, newPath) => {
					if (newPath.includes(`${sep}audit${sep}exp-a${sep}`)) throw Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" });
					const { link } = await import("node:fs/promises");
					return await link(existingPath, newPath);
				},
				...failUnlinkTempIn(root, `${sep}audit${sep}exp-a${sep}`),
			},
		});

		assert.equal(recon.outcome, "pending", "已观察为 after 的 IO 失败是「待补」");
		assert.equal(recon.audit, null);
		assert.equal(recon.observed?.revision, 1);
		assert.ok(
			recon.artifactCleanup.some((entry) => entry.artifact === "event"),
			`artifactCleanup 必须带 event：${JSON.stringify(recon.artifactCleanup)}`,
		);
		assert.ok(
			(recon.warnings ?? []).some((warning) => warning.includes("清理失败")),
			`warnings 必须带有界清理诊断：${JSON.stringify(recon.warnings ?? [])}`,
		);
		assert.ok(tempLeftoversIn(root, "audit", "exp-a").length >= 1, "磁盘上必须真的有 .tmp");
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared");
	});

	await t.test("终态 rename 失败 + journal 临时文件删不掉 → pending + review-journal 诊断且保留已发布事实", async () => {
		const root = await makeStoreRoot("f2-recovery-terminal-cleanup");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const recordBytes = hashFile(recordPath(root));

		const recon = await reconcileReviewOperation({
			root,
			operationId: pending.operationId,
			now: LATER + 310,
			ioHooks: {
				beforeIo: (operation, target) => {
					if (typeof target !== "string" || !target.includes(`${sep}journal${sep}`)) return undefined;
					if (operation === "rename" || operation === "unlink-temp") return Promise.reject(Object.assign(new Error(`注入：${operation} 失败`), { code: "EIO" }));
					return undefined;
				},
			},
		});

		assert.equal(recon.outcome, "pending");
		assert.equal(recon.audit?.publication, "recovery", "已经发布的审计事实不能丢");
		assert.equal(recon.audit?.recordedAt, LATER + 310);
		assert.equal(recon.journalState, "prepared");
		assert.ok(
			recon.artifactCleanup.some((entry) => entry.artifact === "review-journal"),
			`artifactCleanup 必须带 review-journal：${JSON.stringify(recon.artifactCleanup)}`,
		);
		assert.ok(
			(recon.warnings ?? []).some((warning) => warning.includes("清理失败")),
			`warnings 必须带有界清理诊断：${JSON.stringify(recon.warnings ?? [])}`,
		);
		assert.ok(tempLeftoversIn(root, "journal").length >= 1, "磁盘上必须真的有 .tmp");
		assert.equal(eventNames(root).length, 1, "事件已经发布");
		assert.equal(hashFile(recordPath(root)), recordBytes, "业务不得被改动");
	});

	await t.test("exists 撞名后的读取被取消 → cancelled 穿透但保留已取得的清理诊断", async () => {
		const root = await makeStoreRoot("f2-recovery-exists-cancel");
		await seedCard(root);
		const pending = await makeAuditPending(root);
		const controller = new AbortController();
		/** 事件路径上的读取次数：第 1 次是"发布前探测事件是否存在"，第 2 次才是"撞名后的重新读取"。 */
		let eventReads = 0;

		const failure = await reconcileReviewOperation({
			root,
			operationId: pending.operationId,
			now: LATER + 320,
			signal: controller.signal,
			ioHooks: {
				// 模拟"另一个恢复者抢先发布"：目标先出现，再返回 EEXIST。
				link: async (existingPath, newPath) => {
					if (!newPath.includes(`${sep}audit${sep}exp-a${sep}`)) {
						const { link } = await import("node:fs/promises");
						return await link(existingPath, newPath);
					}
					writeFileSync(newPath, readFileSync(existingPath));
					throw Object.assign(new Error("注入：目标已存在"), { code: "EEXIST" });
				},
				beforeIo: (operation, target) => {
					if (typeof target !== "string" || !target.includes(`${sep}audit${sep}exp-a${sep}`)) return undefined;
					if (operation === "unlink-temp") return Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EACCES" }));
					// 撞名之后的重新读取阶段取消：此时临时文件的清理失败已经发生，不能因此丢掉。
					if (operation === "open") {
						eventReads += 1;
						if (eventReads >= 2) controller.abort();
					}
					return undefined;
				},
			},
		}).then(
			() => undefined,
			(error) => error,
		);

		assert.ok(failure instanceof StorageError, `必须结构化失败：${String(failure)}`);
		assert.equal(failure.code, "cancelled", "未发布前取消仍然穿透（不被改写成 pending）");
		assert.ok(failure.message.includes("审核工件的临时文件清理失败"), `取消错误也要保留清理诊断：${failure.message}`);
		assert.ok(tempLeftoversIn(root, "audit", "exp-a").length >= 1, "磁盘上必须真的有 .tmp");
		assert.equal(readJson(journalPath(root, pending.operationId)).state, "prepared", "不得写终态");
	});
});

/* ------------------------------------------------------------------ 真实进程：崩溃与竞争 */

/**
 * 崩溃脚本：在审核提交序列的某个检查点命中后写标记并**永远挂住**，由父进程强杀。
 *
 * 检查点选在"提交点已过"的两个位置，因为它们是协议里唯一会留下待补审计的窗口：
 * - `record-committed`：记录已替换、事件未发布；
 * - `event-published`：事件已发布、完成终态未写。
 */
function crashScript({ root, checkpoint, checkpointPath }) {
	return `
import { writeFileSync } from "node:fs";
import { recordReviewDecision } from ${JSON.stringify(STORAGE_MODULE_URL)};
const CHECKPOINT = ${JSON.stringify(checkpoint)};
const PARK = ${JSON.stringify(checkpointPath)};
const inEvent = (p) => typeof p === "string" && p.includes(${JSON.stringify(`${sep}audit${sep}exp-a${sep}`)});
const inJournal = (p) => typeof p === "string" && p.includes(${JSON.stringify(`${sep}journal${sep}`)});
const park = async () => { writeFileSync(PARK, "1"); await new Promise(() => {}); };
const ioHooks = { beforeIo: async (operation, target) => {
	if (CHECKPOINT === "record-committed" && operation === "link" && inEvent(target)) await park();
	if (CHECKPOINT === "event-published" && operation === "rename" && inJournal(target)) await park();
} };
await recordReviewDecision({ root: ${JSON.stringify(root)}, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "崩溃点测试", now: ${LATER}, ioHooks });
process.stdout.write("done");
`;
}

for (const checkpoint of ["record-committed", "event-published"]) {
	test(`C2B：真实进程在「${checkpoint}」被终止 → 新进程核对先补事件再收口，不重放记录`, async () => {
		const root = await makeStoreRoot(`review-crash-${checkpoint}`);
		await seedCard(root);
		const recordBytesBefore = hashFile(recordPath(root));
		const checkpointPath = join(root, `checkpoint-${checkpoint}`);
		const child = spawn(process.execPath, ["--input-type=module", "-e", crashScript({ root, checkpoint, checkpointPath })], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		let stderr = "";
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
		try {
			await waitForPath(checkpointPath, 30_000);
		} finally {
			child.kill("SIGKILL");
		}
		const outcome = await exited;
		assert.ok(outcome.code !== null || outcome.signal !== null, `子进程必须已退出：${stderr.slice(0, 300)}`);

		// 崩溃现场的确定事实：业务已提交、事件视检查点而定、v2 仍是 prepared。
		assert.equal(readJson(recordPath(root)).revision, 1, "提交点已过：记录必须是新版");
		assert.notEqual(hashFile(recordPath(root)), recordBytesBefore);
		const prepared = reviewJournals(root).filter((record) => record.state === "prepared");
		assert.equal(prepared.length, 1, "崩溃后必须留下可核对的 prepared");
		const journalRecord = prepared[0];
		if (checkpoint === "record-committed") {
			assert.deepEqual(eventNames(root), [], "该检查点还没有事件");
		} else {
			assert.equal(eventNames(root).length, 1);
			assert.equal(readJson(join(eventDir(root), `${journalRecord.eventId}.json`)).publication, "writer");
		}

		// 崩溃进程留下的锁：只能人工确认后清理（本用例在确认子进程已退出后才清理合成现场）。
		for (const name of existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")) : []) {
			rmSync(join(root, "locks", name), { recursive: true, force: true });
		}
		const recon = await reconcileReviewOperation({ root, operationId: journalRecord.operationId, now: LATER + 200 });
		assert.equal(recon.outcome, "committed");
		assert.equal(readJson(recordPath(root)).revision, 1, "核对不得再递增 revision");
		assert.equal(reviewJournals(root).filter((record) => record.state === "committed").length, 1);
		assert.equal(eventNames(root).length, 1, "恰好一条事件（发布或认领）");
		const event = readJson(join(eventDir(root), `${journalRecord.eventId}.json`));
		assert.equal(event.publication, checkpoint === "record-committed" ? "recovery" : "writer");
		assert.equal(event.decidedAt, LATER, "决定时间来自意图，恢复不得改写");
	});
}

test("C2B：两个真实审核进程同 expectedRevision 竞争 → 恰好一方提交，另一方冲突", async () => {
	const root = await makeStoreRoot("review-race-writers");
	await seedCard(root);
	const label = "race-a";
	const barrier = join(SANDBOX, `barrier-${label}`);
	mkdirSync(barrier, { recursive: true });
	const go = join(barrier, "go");
	const script = (tag) => `
import { existsSync } from "node:fs";
import { recordReviewDecision } from ${JSON.stringify(STORAGE_MODULE_URL)};
const go = ${JSON.stringify(go)};
while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 10));
try {
	const result = await recordReviewDecision({ root: ${JSON.stringify(root)}, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: ${JSON.stringify(tag)}, reason: "并发", now: ${LATER}, lockTimeoutMs: 20_000, lockPollMs: 10 });
	process.stdout.write(JSON.stringify({ ok: true, kind: result.kind, revision: result.revision, eventId: result.eventId, operator: ${JSON.stringify(tag)} }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? "unknown", operator: ${JSON.stringify(tag)} }));
}
`;
	const first = runNode(script("alice"));
	const second = runNode(script("bob"));
	setTimeout(() => writeFileSync(go, "go"), 120);
	const results = [parseChild(await first), parseChild(await second)];
	const winners = results.filter((entry) => entry.ok);
	const losers = results.filter((entry) => !entry.ok);
	assert.equal(winners.length, 1, `恰好一方提交：${JSON.stringify(results)}`);
	assert.equal(losers.length, 1);
	assert.equal(losers[0].code, "revision-conflict", `另一方必须是并发冲突：${JSON.stringify(losers)}`);
	assert.equal(winners[0].kind, "applied");
	assert.equal(readJson(recordPath(root)).revision, 1, "只提交一次");
	assert.equal(readJson(recordPath(root)).reviewer, winners[0].operator, "审核人是真正提交的那一方");
	assert.equal(eventNames(root).length, 1, "一个有效事件");
	assert.equal(reviewJournals(root).filter((record) => record.state === "committed").length, 1);
	assert.deepEqual(existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")) : [], [], "两个进程都必须释放自己的锁");
});

test("C2B：两个真实恢复进程竞争同一操作 → 一次发布或认领，终态一致、revision 不变", async () => {
	const root = await makeStoreRoot("review-race-reconcilers");
	await seedCard(root);
	const pending = await makeAuditPending(root);
	const label = "race-b";
	const barrier = join(SANDBOX, `barrier-${label}`);
	mkdirSync(barrier, { recursive: true });
	const go = join(barrier, "go");
	const script = `
import { existsSync } from "node:fs";
import { reconcileReviewOperation } from ${JSON.stringify(STORAGE_MODULE_URL)};
const go = ${JSON.stringify(go)};
while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 10));
try {
	const result = await reconcileReviewOperation({ root: ${JSON.stringify(root)}, operationId: ${JSON.stringify(pending.operationId)}, now: ${LATER + 300}, lockTimeoutMs: 20_000, lockPollMs: 10 });
	process.stdout.write(JSON.stringify({ ok: true, outcome: result.outcome, changed: result.changed, publication: result.audit?.publication ?? null, recordedAt: result.audit?.recordedAt ?? null }));
} catch (error) {
	process.stdout.write(JSON.stringify({ ok: false, code: error.code ?? "unknown" }));
}
`;
	const first = runNode(script);
	const second = runNode(script);
	setTimeout(() => writeFileSync(go, "go"), 120);
	const results = [parseChild(await first), parseChild(await second)];
	assert.equal(
		results.every((entry) => entry.ok),
		true,
		`两个恢复者都应给出结论：${JSON.stringify(results)}`,
	);
	assert.equal(
		results.every((entry) => entry.outcome === "committed"),
		true,
		JSON.stringify(results),
	);
	assert.equal(results.filter((entry) => entry.changed).length, 1, "只有一个真正写了终态");
	assert.equal(
		results.every((entry) => entry.publication === "recovery"),
		true,
		"两者都必须看到同一条 recovery 事件",
	);
	assert.equal(
		results.every((entry) => entry.recordedAt === LATER + 300),
		true,
		"发布事实必须一致，不得重打时间",
	);
	assert.equal(eventNames(root).length, 1, "恰好一条事件");
	assert.equal(readJson(recordPath(root)).revision, 1, "恢复不得重复递增 revision");
	assert.equal(reviewJournals(root).filter((record) => record.state === "committed").length, 1);
	assert.deepEqual(existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")) : [], []);
});

/**
 * **真实 recovery 的二次中断**（R3 明确要求，不能用"纯函数二次认领"或两个恢复进程竞争代替）：
 * 恢复者把 `recovery` 事件发布出去、还没写完成终态时被强杀；新进程必须**认领第一次的事件**并收口。
 *
 * 这与 writer 的崩溃检查点不同：那一组验的是"写入方在提交序列里被杀"，
 * 这一组验的是"恢复者在补发审计的过程中被杀"——两条路径的发布事实来源不同（writer vs recovery），
 * 但"认领必须保留原 publication/recordedAt"这条规则对两者是同一份。
 */
test("R3：真实 recovery 在「事件已发布、终态未写」时被终止 → 新进程认领第一次 recovery 事件并收口", async () => {
	const root = await makeStoreRoot("review-crash-recovery-terminal");
	await seedCard(root);
	// 先造出"业务已提交、事件未发布"的窗口（写入方的事件发布失败）。
	const pending = await makeAuditPending(root);
	const recordRevision = readJson(recordPath(root)).revision;
	const recordBytes = hashFile(recordPath(root));
	const intentBytes = hashFile(intentPath(root, pending.operationId));

	const checkpointPath = join(root, "checkpoint-recovery-terminal");
	const script = `
import { writeFileSync } from "node:fs";
import { reconcileReviewOperation } from ${JSON.stringify(STORAGE_MODULE_URL)};
const PARK = ${JSON.stringify(checkpointPath)};
const inJournal = (p) => typeof p === "string" && p.includes(${JSON.stringify(`${sep}journal${sep}`)});
const ioHooks = { beforeIo: async (operation, target) => {
	if (operation === "rename" && inJournal(target)) { writeFileSync(PARK, "1"); await new Promise(() => {}); }
} };
await reconcileReviewOperation({ root: ${JSON.stringify(root)}, operationId: ${JSON.stringify(pending.operationId)}, now: ${LATER + 200}, ioHooks });
process.stdout.write("done");
`;
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	try {
		await waitForPath(checkpointPath, 30_000);
	} finally {
		child.kill("SIGKILL");
	}
	const outcome = await exited;
	assert.ok(outcome.code !== null || outcome.signal !== null, `子进程必须已退出：${stderr.slice(0, 300)}`);

	// 崩溃现场的确定事实：第一次 recovery 事件**已经发布**、终态仍是 prepared、业务没有被重放。
	assert.equal(eventNames(root).length, 1, "崩溃点必须在事件发布之后");
	const firstEventBytes = hashFile(join(eventDir(root), `${pending.eventId}.json`));
	const firstEvent = readJson(join(eventDir(root), `${pending.eventId}.json`));
	assert.equal(firstEvent.publication, "recovery");
	assert.equal(firstEvent.recordedAt, LATER + 200);
	assert.equal(reviewJournals(root).filter((record) => record.state === "prepared").length, 1, "终态未写：仍是 prepared");
	assert.equal(readJson(recordPath(root)).revision, recordRevision, "恢复不得递增 revision");
	assert.equal(hashFile(recordPath(root)), recordBytes, "恢复不得重放记录");

	// 被终止的恢复进程留下的协作锁：产品不会自动回收，本用例在确认子进程退出后清理这份合成现场。
	const crashedLocks = existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")) : [];
	assert.ok(crashedLocks.length >= 1, "被终止的恢复进程应留下它的锁（不按 PID/年龄自动回收）");
	for (const name of crashedLocks) rmSync(join(root, "locks", name), { recursive: true, force: true });

	const recon = await reconcileReviewOperation({ root, operationId: pending.operationId, now: LATER + 400 });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.changed, true);
	assert.equal(recon.audit?.publication, "recovery", "必须认领**第一次**的 recovery 事件");
	assert.equal(recon.audit?.recordedAt, LATER + 200, "认领保留原 recordedAt，不用第二次的时间重打");
	assert.equal(eventNames(root).length, 1, "不得重复发布事件");
	assert.equal(hashFile(join(eventDir(root), `${pending.eventId}.json`)), firstEventBytes, "原事件字节必须逐字节不变");
	assert.equal(hashFile(intentPath(root, pending.operationId)), intentBytes, "意图字节不变");
	assert.equal(readJson(recordPath(root)).revision, recordRevision, "业务 revision 不变");
	assert.equal(hashFile(recordPath(root)), recordBytes, "业务字节不变");
	assert.equal(reviewJournals(root).filter((record) => record.state === "committed").length, 1);
	assert.deepEqual(existsSync(join(root, "locks")) ? readdirSync(join(root, "locks")) : [], [], "新进程必须释放自己的锁");
});
