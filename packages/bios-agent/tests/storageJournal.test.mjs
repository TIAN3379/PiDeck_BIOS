/**
 * BM-02C1 的**永久回归**：单文件 journal 与进程崩溃后的结果核对。
 *
 * 这一轮的重点不是"能不能写 journal"，而是三条容易写错、也最难事后发现的语义：
 *
 * 1. **意图先于数据**：prepared 必须在数据提交点之前落盘，否则崩溃后没有可核对的依据；
 * 2. **提交点是数据 IO 成功，不是记账成功**：终态写失败/迟到取消只能报 `needs-recovery`，
 *    绝不能变成"未提交"，更不能让调用方重复提交同一 revision；
 * 3. **恢复只核对、不重放**：只有对同一受控目标拿到原有协作锁并复读之后才允许下结论，
 *    且判定只看 before/after 的真实字节指纹——不是"猜"也不是"按年龄/pid 抢锁"。
 *
 * 真实进程退出用 `spawn` + 检查点标记 + 终止，不用 `throw` 冒充 crash；
 * 父进程只在**确认自己启动的子进程已退出**后，才会清理该 fixture 的遗留锁再测 reconcile
 * （这不等于产品自动抢锁：文档明确要求人工确认）。
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import test, { after } from "node:test";
import { createRecord, createStorageBoundary, initializeKnowledgeStore, inspectPendingJournal, readRecord, reconcileJournalOperation, StorageError, updateRecord, updateRegistry } from "../core/storage/index.ts";
import { acquireStorageLock } from "../core/storage/lock.ts";

const STORAGE_MODULE_URL = new URL("../core/storage/index.ts", import.meta.url).href;
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-store-journal-")));
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";

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

function experienceBody(solution, overrides = {}) {
	return {
		problem: "PXE 默认开启导致安装后仍尝试网络引导",
		rootCause: "Setup 默认值未随客户选项调整",
		solution,
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: OTHER_PROJECT_ID,
		evidence: [],
		validations: [],
		reuseScope: { level: "current-project", customers: [] },
		status: "reviewed",
		...overrides,
	};
}

function projectFixture() {
	return { biosProjectId: PROJECT_ID, workspaces: [], createdAt: NOW, updatedAt: NOW };
}

function recordPath(root, id) {
	return join(root, "experiences", `${id}.json`);
}

/** 与存储层完全相同的序列化形式（journal 的 after 哈希必须对应这份字节）。 */
function serializePayload(value) {
	return `${JSON.stringify(value, null, "\t")}\n`;
}

function sha256(text) {
	return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function hashFile(path) {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function journalPath(root, operationId) {
	return join(root, "journal", `${operationId}.json`);
}

function journalEntries(root) {
	const dir = join(root, "journal");
	return existsSync(dir) ? readdirSync(dir) : [];
}

function lockEntries(root) {
	const dir = join(root, "locks");
	return existsSync(dir) ? readdirSync(dir) : [];
}

function tempLeftovers(dir) {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

function isJournalPath(target) {
	return typeof target === "string" && target.includes(`${sep}journal${sep}`);
}

function readJournal(root, operationId) {
	return JSON.parse(readFileSync(journalPath(root, operationId), "utf8"));
}

/** 崩溃用例：本次子进程写入的那一条 journal 的 operationId。 */
function crashedJournalId(beforeNames, root) {
	return addedJournalId(beforeNames, root);
}

/** 直接写一条 journal fixture（journal 是**不可信输入**，用例必须能伪造它）。 */
function writeJournalFixture(root, value, fileName = value.operationId) {
	mkdirSync(join(root, "journal"), { recursive: true });
	const path = journalPath(root, fileName);
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	return path;
}

/** 当前 journal 目录里的 `.json` 文件名集合（用于断言“本次操作新增了哪一条”）。 */
function journalJsonNames(root) {
	return journalEntries(root).filter((name) => name.endsWith(".json"));
}

/** 两次快照之差：本次调用新增的 operationId（恰好一条，否则说明用例假设不成立）。 */
function addedJournalId(beforeNames, root) {
	const added = journalJsonNames(root).filter((name) => !beforeNames.includes(name));
	assert.equal(added.length, 1, `应恰好新增一条 journal，实际：${added.join(", ")}`);
	return added[0].slice(0, -".json".length);
}

function fingerprintFor(value) {
	return { revision: value.revision, hash: sha256(serializePayload(value)) };
}

function isStorageError(code, detailPart) {
	return (error) => {
		if (!(error instanceof StorageError)) return false;
		if (error.code !== code) return false;
		if (detailPart === undefined) return true;
		return String(error.detail ?? "").includes(detailPart);
	};
}

function runNode(script, timeout = 60_000) {
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout, maxBuffer: 1 << 20 });
	return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error };
}

async function waitForPath(path, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs;
	while (!existsSync(path)) {
		if (Date.now() > deadline) throw new Error(`等待检查点超时：${path}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/* ------------------------------------------------------------------ 1. 记账内容 */

test("C1：三类入口都留下 committed 记录，且 before/after 是磁盘真实字节的指纹", async () => {
	const root = await makeStoreRoot("c1-record-fingerprint");
	const id = "exp-c1-fp";

	// create：before 必须是“不存在”，after 对应实际写下去的字节。
	const created = await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	assert.equal(created.journal.state, "committed");
	const createJournal = readJournal(root, created.journal.operationId);
	assert.deepEqual(createJournal.before, { revision: null, hash: null }, "create 的 before 必须表示不存在");
	assert.equal(createJournal.operation, "create");
	assert.equal(createJournal.after.revision, 0);
	assert.equal(createJournal.after.hash, hashFile(recordPath(root, id)), "after.hash 必须等于目标文件真实字节的 SHA-256");
	assert.equal(createJournal.source, "writer-confirmed");
	assert.equal(createJournal.state, "committed");
	assert.equal(typeof createJournal.finishedAt, "number");

	// 把记录改成**不同空白**的合法 JSON：before 必须取自磁盘字节，而不是“重新序列化”。
	const parsed = JSON.parse(readFileSync(recordPath(root, id), "utf8"));
	writeFileSync(recordPath(root, id), `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
	const reformattedHash = hashFile(recordPath(root, id));
	assert.notEqual(reformattedHash, sha256(serializePayload(parsed)), "fixture 必须真的与规范序列化不同，否则测不出差异");

	const updated = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
	const updateJournal = readJournal(root, updated.journal.operationId);
	assert.equal(updateJournal.operation, "update");
	assert.equal(updateJournal.before.hash, reformattedHash, "before.hash 必须是当时磁盘上的真实字节");
	assert.notEqual(updateJournal.before.hash, sha256(serializePayload(parsed)), "不得把重新序列化当作同一字节");
	assert.equal(updateJournal.before.revision, 0);
	assert.equal(updateJournal.after.revision, 1);
	assert.equal(updateJournal.after.hash, hashFile(recordPath(root, id)));

	// registry 走同一套记账。
	const registryUpdate = await updateRegistry({ root, expectedRevision: 0, projects: [projectFixture()], now: LATER });
	const registryJournal = readJournal(root, registryUpdate.journal.operationId);
	assert.deepEqual(registryJournal.target, { kind: "registry" });
	assert.equal(registryJournal.after.revision, 1);
	assert.equal(registryJournal.after.hash, hashFile(join(root, "registry.json")));
	assert.equal(registryJournal.state, "committed");

	// 三个 operationId 必须互不相同（同名会互相覆盖）。
	assert.equal(new Set([created.journal.operationId, updated.journal.operationId, registryUpdate.journal.operationId]).size, 3);
});

test("C1：初始化不建 journal 目录（旧库兼容），首次写入才惰性创建", async () => {
	const root = await makeStoreRoot("c1-lazy-journal-dir");
	assert.equal(existsSync(join(root, "journal")), false, "初始化协议不变：不预建 journal 目录");

	const result = await createRecord({ root, kind: "experience-card", id: "exp-c1-lazy", data: experienceBody("v0"), expectedRevision: null, now: NOW });
	assert.equal(existsSync(join(root, "journal")), true);
	assert.equal(result.journal.state, "committed");
	// 旧库（没有 journal 目录）读取巡检必须是空结果，而不是错误。
	const empty = await inspectPendingJournal({ root: makeRawRoot("c1-no-journal-at-all") });
	assert.deepEqual(empty.pending, []);
	assert.equal(empty.scanned, 0);
	assert.equal(empty.truncated, false);
});

/* ------------------------------------------------------------------ 2. 顺序与提交点 */

test("C1：prepared 在数据提交点之前已落盘（窗外目标是旧字节）", async () => {
	const root = await makeStoreRoot("c1-prepared-first");
	const id = "exp-c1-order";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const beforeHash = hashFile(recordPath(root, id));
	const observations = [];

	await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 业务目标的 rename = 数据提交点；此时 journal 必须**已经**是 prepared。
				if (operation !== "rename" || isJournalPath(target)) return undefined;
				const records = journalJsonNames(root).map((name) => JSON.parse(readFileSync(join(root, "journal", name), "utf8")));
				const prepared = records.filter((journal) => journal.state === "prepared");
				observations.push({ preparedCount: prepared.length, after: prepared[0]?.after, targetHash: hashFile(recordPath(root, id)) });
			},
		},
	});

	assert.equal(observations.length, 1, "提交窗口只应出现一次");
	assert.equal(observations[0].preparedCount, 1, "数据提交前必须恰好有一条 prepared 意图");
	assert.equal(observations[0].after.revision, 1);
	assert.equal(observations[0].targetHash, beforeHash, "此刻目标仍是旧字节");
});

test("C1：prepared 发布失败 → 数据不提交、原错误保留、无 journal 残留", async () => {
	const root = await makeStoreRoot("c1-prepared-publish-fails");
	const id = "exp-c1-prepare-fail";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const before = hashFile(recordPath(root, id));
	const journalBefore = journalJsonNames(root);

	await assert.rejects(
		() =>
			updateRecord({
				root,
				kind: "experience-card",
				id,
				data: experienceBody("v1"),
				expectedRevision: 0,
				now: LATER,
				ioHooks: {
					beforeIo: (operation, target) => {
						// 只让 journal 自己的临时文件写入失败：prepared 就发不出去。
						if (operation === "write-temp" && isJournalPath(target)) return Promise.reject(Object.assign(new Error("注入：journal 落盘失败"), { code: "EIO" }));
						return undefined;
					},
				},
			}),
		isStorageError("permission-denied", "EIO"),
	);

	assert.equal(hashFile(recordPath(root, id)), before, "prepared 失败不得提交数据");
	assert.deepEqual(journalJsonNames(root), journalBefore, "prepared 没发出去就不该留下新的 journal 记录");
	assert.deepEqual(lockEntries(root), [], "失败后必须释放锁");
});

test("C1：提交前失败记 aborted；提交前取消保留 prepared 并给出有界诊断", async () => {
	// ① 数据 IO 失败（非取消）：尽力记 aborted，原错误保留。
	const rootA = await makeStoreRoot("c1-aborted");
	const idA = "exp-c1-aborted";
	await createRecord({ root: rootA, kind: "experience-card", id: idA, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const hashA = hashFile(recordPath(rootA, idA));
	const journalBeforeA = journalJsonNames(rootA);

	const thrownA = await updateRecord({
		root: rootA,
		kind: "experience-card",
		id: idA,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation === "rename" && !isJournalPath(target)) return Promise.reject(Object.assign(new Error("注入：替换失败"), { code: "EIO" }));
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrownA instanceof StorageError && thrownA.code === "permission-denied", `原错误必须保留，实际：${thrownA}`);
	assert.equal(hashFile(recordPath(rootA, idA)), hashA, "未提交不得改动目标");
	const aborted = readJournal(rootA, addedJournalId(journalBeforeA, rootA));
	assert.equal(aborted.state, "aborted", "未提交的操作必须记 aborted");
	assert.equal(aborted.source, "writer-confirmed");

	// ② 提交前取消：aborted 写入也会被取消，于是保留 prepared + 有界诊断（这是刻意的“尽力”语义）。
	const rootB = await makeStoreRoot("c1-cancel-pending");
	const idB = "exp-c1-cancel-pending";
	await createRecord({ root: rootB, kind: "experience-card", id: idB, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const hashB = hashFile(recordPath(rootB, idB));
	const journalBeforeB = journalJsonNames(rootB);
	const controller = new AbortController();

	const thrownB = await updateRecord({
		root: rootB,
		kind: "experience-card",
		id: idB,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		signal: controller.signal,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation === "rename" && !isJournalPath(target)) controller.abort();
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrownB instanceof StorageError && thrownB.code === "cancelled", `取消必须如实，实际：${thrownB}`);
	assert.equal(hashFile(recordPath(rootB, idB)), hashB, "取消不得改动目标");
	assert.ok(String(thrownB.message).includes("prepared"), `必须提示留下了 prepared，实际：${String(thrownB.message)}`);
	const pending = readJournal(rootB, addedJournalId(journalBeforeB, rootB));
	assert.equal(pending.state, "prepared");
	assert.deepEqual(lockEntries(rootB), [], "取消后锁必须释放");
	// 这份 prepared 正是 inspect/reconcile 的输入。
	const inspection = await inspectPendingJournal({ root: rootB });
	assert.equal(inspection.pending.length, 1);
	assert.equal(inspection.pending[0].operationId, pending.operationId);
});

test("C1：数据已提交但 journal 终态失败/迟到取消 → 真实成功 + needs-recovery，revision 只加一次", async () => {
	const root = await makeStoreRoot("c1-needs-recovery");
	const id = "exp-c1-recovery";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const beforeHash = hashFile(recordPath(root, id));

	const result = await updateRecord({
		root,
		kind: "experience-card",
		id,
		data: experienceBody("v1"),
		expectedRevision: 0,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				// 数据已提交，只有 journal 的终态替换失败。
				if (operation === "rename" && isJournalPath(target)) return Promise.reject(Object.assign(new Error("注入：记账失败"), { code: "EBUSY" }));
				return undefined;
			},
		},
	});

	assert.equal(result.status, "updated", "提交点已过，不得因为记账失败改口");
	assert.equal(result.revision, 1, "revision 只能 +1，绝不重复递增");
	assert.equal(result.journal.state, "needs-recovery");
	assert.ok(Array.isArray(result.warnings) && result.warnings.some((note) => note.includes(result.journal.operationId)), "警告必须能定位到 operationId");
	assert.notEqual(hashFile(recordPath(root, id)), beforeHash, "数据确实已经落盘");
	assert.equal(readJournal(root, result.journal.operationId).state, "prepared", "磁盘上仍是 prepared");
	assert.deepEqual(lockEntries(root), [], "记账失败不影响锁释放");

	// 恢复核对：确认已提交，但**不**再写目标、不递增 revision。
	const reconciled = await reconcileJournalOperation({ root, operationId: result.journal.operationId, now: LATER + 1 });
	assert.equal(reconciled.outcome, "committed");
	assert.equal(reconciled.changed, true);
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.revision, 1, "恢复不得重复加 revision");
	const settled = readJournal(root, result.journal.operationId);
	assert.equal(settled.state, "committed");
	assert.equal(settled.source, "recovery-observed", "恢复观察不得冒充 writer-confirmed");
});

/* ------------------------------------------------------------------ 3. inspect */

test("C1：inspect 只读、有界：只把 prepared 当候选，坏文件保留原样", async () => {
	const root = await makeStoreRoot("c1-inspect");
	const id = "exp-c1-inspect";
	// ① 真实 committed 一条（不进候选）。
	const created = await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	// ② 伪造：prepared / aborted / 坏 JSON / 未来版本 / operationId 与文件名不符 / 非 .json / .tmp 残留。
	const preparedId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId: preparedId,
		operation: "update",
		state: "prepared",
		target: { kind: "experience-card", id },
		before: { revision: 0, hash: hashFile(recordPath(root, id)) },
		after: { revision: 1, hash: sha256("x") },
		preparedAt: NOW,
	});
	const abortedId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId: abortedId,
		operation: "create",
		state: "aborted",
		target: { kind: "experience-card", id: "exp-c1-aborted-fixture" },
		before: { revision: null, hash: null },
		after: { revision: 0, hash: sha256("y") },
		preparedAt: NOW,
		finishedAt: NOW + 1,
		source: "writer-confirmed",
	});
	const brokenId = randomUUID();
	writeFileSync(journalPath(root, brokenId), '{ "secret": "SECRET-BODY-MUST-NOT-LEAK"', "utf8");
	const futureId = randomUUID();
	writeJournalFixture(root, { journalVersion: 99, operationId: futureId, operation: "create", state: "prepared", target: { kind: "registry" }, before: { revision: null, hash: null }, after: { revision: 0, hash: sha256("z") }, preparedAt: NOW });
	// 结构上说不通的一条：target.kind 既不是 registry 也不是已知记录类型 ⇒ invalid-journal。
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId: randomUUID(),
		operation: "create",
		state: "prepared",
		target: { kind: "not-a-kind" },
		before: { revision: null, hash: null },
		after: { revision: 0, hash: sha256("q") },
		preparedAt: NOW,
	});
	// 文件名与正文里的 operationId 不一致（两处都不能被"猜"哪一个才对）。
	const mismatchId = randomUUID();
	writeJournalFixture(
		root,
		{
			journalVersion: 1,
			operationId: randomUUID(),
			operation: "create",
			state: "prepared",
			target: { kind: "experience-card", id: "exp-c1-mismatch" },
			before: { revision: null, hash: null },
			after: { revision: 0, hash: sha256("w") },
			preparedAt: NOW,
		},
		mismatchId,
	);
	assert.equal(existsSync(journalPath(root, mismatchId)), true);
	writeFileSync(join(root, "journal", "notes.txt"), "不是 journal", "utf8");
	writeFileSync(join(root, "journal", "leftover.json.tmp"), "残留", "utf8");

	const beforeHashes = new Map(journalEntries(root).map((name) => [name, hashFile(join(root, "journal", name))]));
	const inspection = await inspectPendingJournal({ root });

	assert.deepEqual(
		inspection.pending.map((entry) => entry.operationId),
		[preparedId],
		"只有 prepared 是候选",
	);
	assert.equal(inspection.finalized.committed, 1, "creator 的 committed 计入统计");
	assert.equal(inspection.finalized.aborted, 1);
	assert.equal(inspection.skippedEntries, 2, "非 .json 与 .tmp 残留只跳过、不报错、不删除");
	const codes = inspection.problems.map((problem) => problem.code).sort();
	assert.deepEqual(codes, ["invalid-journal", "invalid-json", "journal-name-mismatch", "unsupported-journal-version"], `问题必须分类清楚，实际：${JSON.stringify(codes)}`);
	assert.ok(
		inspection.problems.every((problem) => !problem.message.includes("SECRET-BODY-MUST-NOT-LEAK")),
		"诊断不得泄漏文件内容",
	);
	// 只读：一个字节都不许改。
	for (const [name, hash] of beforeHashes) assert.equal(hashFile(join(root, "journal", name)), hash, `${name} 不得被 inspect 改写`);
	assert.equal(existsSync(join(root, "journal", "leftover.json.tmp")), true, "inspect 不得清理任何 .tmp");
	assert.equal(existsSync(journalPath(root, created.journal.operationId)), true);
});

test("C1：inspect 的预算（0 语义）与扫描中途取消", async () => {
	const root = await makeStoreRoot("c1-inspect-budget");
	const id = "exp-c1-budget";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	for (let index = 0; index < 3; index += 1) {
		writeJournalFixture(root, {
			journalVersion: 1,
			operationId: randomUUID(),
			operation: "update",
			state: "prepared",
			target: { kind: "experience-card", id },
			before: { revision: 0, hash: hashFile(recordPath(root, id)) },
			after: { revision: 1, hash: sha256(`budget-${index}`) },
			preparedAt: NOW,
		});
	}
	writeFileSync(join(root, "journal", `${randomUUID()}.json`), "{ 坏", "utf8");

	const noEntries = await inspectPendingJournal({ root, limits: { maxJournalInspectEntries: 0 } });
	assert.deepEqual(noEntries.pending, [], "0 = 不返回候选");
	assert.ok(noEntries.truncatedBy.includes("entries"), `必须如实标注被哪一维截断，实际：${JSON.stringify(noEntries.truncatedBy)}`);
	assert.ok(noEntries.scanned >= 3, "仍要如实报告扫描量");

	const noProblems = await inspectPendingJournal({ root, limits: { maxJournalProblems: 0 } });
	assert.deepEqual(noProblems.problems, [], "0 = 不返回问题对象");
	assert.ok(noProblems.droppedProblems >= 1, "但必须如实计数被丢弃的问题");

	const noScan = await inspectPendingJournal({ root, limits: { maxJournalScanEntries: 0 } });
	assert.equal(noScan.scanned, 0, "0 = 不扫描目录");
	assert.equal(noScan.truncated, true);

	// 扫描途中取消必须穿透，不能返回“看起来完整”的结果。
	const controller = new AbortController();
	await assert.rejects(
		() =>
			inspectPendingJournal({
				root,
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "read" && isJournalPath(target)) controller.abort();
						return undefined;
					},
				},
			}),
		isStorageError("cancelled"),
	);
});

/* ------------------------------------------------------------------ 4. reconcile */

test("C1：reconcile 对 before/after/更高 revision/坏目标的判定，且重复核对幂等", async () => {
	const root = await makeStoreRoot("c1-reconcile-decide");
	const id = "exp-c1-decide";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const before = { revision: 0, hash: hashFile(recordPath(root, id)) };
	const afterRecord = { schemaVersion: 1, revision: 1, createdAt: NOW, updatedAt: LATER, id, ...experienceBody("v1") };
	const after = fingerprintFor(afterRecord);

	// ① 目标与 after 一致 ⇒ committed（recovery-observed），不写目标。
	writeFileSync(recordPath(root, id), serializePayload(afterRecord), "utf8");
	const targetHash = hashFile(recordPath(root, id));
	const committedId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId: committedId, operation: "update", state: "prepared", target: { kind: "experience-card", id }, before, after, preparedAt: NOW });
	const committed = await reconcileJournalOperation({ root, operationId: committedId, now: LATER + 1 });
	assert.equal(committed.outcome, "committed");
	assert.equal(committed.changed, true);
	assert.equal(committed.observed.hash, targetHash);
	assert.equal(hashFile(recordPath(root, id)), targetHash, "核对不得改写已提交内容");
	assert.equal(readJournal(root, committedId).source, "recovery-observed");

	// 幂等：再来一次不改任何东西。
	const again = await reconcileJournalOperation({ root, operationId: committedId, now: LATER + 2 });
	assert.equal(again.outcome, "committed");
	assert.equal(again.changed, false, "已有终态必须幂等");
	assert.equal(hashFile(recordPath(root, id)), targetHash);

	// ② 目标与 before 一致 ⇒ aborted（不自动完成旧操作）。
	const backRecord = { schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, id, ...experienceBody("v0") };
	writeFileSync(recordPath(root, id), serializePayload(backRecord), "utf8");
	const backHash = hashFile(recordPath(root, id));
	const abortedId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId: abortedId, operation: "update", state: "prepared", target: { kind: "experience-card", id }, before: fingerprintFor(backRecord), after, preparedAt: NOW });
	const aborted = await reconcileJournalOperation({ root, operationId: abortedId, now: LATER + 3 });
	assert.equal(aborted.outcome, "aborted");
	assert.equal(hashFile(recordPath(root, id)), backHash, "不得替调用方完成旧操作");
	assert.equal(readJournal(root, abortedId).state, "aborted");

	// ③ 目标 revision 更高 ⇒ conflict（不覆盖新数据）。
	const higher = { schemaVersion: 1, revision: 5, createdAt: NOW, updatedAt: LATER, id, ...experienceBody("v5") };
	writeFileSync(recordPath(root, id), serializePayload(higher), "utf8");
	const higherHash = hashFile(recordPath(root, id));
	const conflictId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId: conflictId, operation: "update", state: "prepared", target: { kind: "experience-card", id }, before: fingerprintFor(backRecord), after, preparedAt: NOW });
	const conflict = await reconcileJournalOperation({ root, operationId: conflictId, now: LATER + 4 });
	assert.equal(conflict.outcome, "conflict");
	assert.equal(conflict.changed, true);
	assert.equal(hashFile(recordPath(root, id)), higherHash, "冲突不得覆盖已经被别人改过的数据");
	assert.equal(readJournal(root, conflictId).state, "conflict");

	// ④ 目标坏 JSON / 缺失但 before 非空 ⇒ unreadable / conflict，且 journal 保持原状。
	writeFileSync(recordPath(root, id), "{ 坏掉的 JSON", "utf8");
	const brokenHash = hashFile(recordPath(root, id));
	const unreadableId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId: unreadableId, operation: "update", state: "prepared", target: { kind: "experience-card", id }, before: fingerprintFor(backRecord), after, preparedAt: NOW });
	const unreadable = await reconcileJournalOperation({ root, operationId: unreadableId, now: LATER + 5 });
	assert.equal(unreadable.outcome, "unreadable");
	assert.equal(unreadable.changed, false, "无法判定时不得改 journal");
	assert.equal(readJournal(root, unreadableId).state, "prepared", "证据必须保留");
	assert.equal(hashFile(recordPath(root, id)), brokenHash, "不得清空或改写坏目标");

	rmSync(recordPath(root, id), { force: true });
	const missingId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId: missingId, operation: "update", state: "prepared", target: { kind: "experience-card", id }, before: fingerprintFor(backRecord), after, preparedAt: NOW });
	const missing = await reconcileJournalOperation({ root, operationId: missingId, now: LATER + 6 });
	assert.equal(missing.outcome, "conflict", "目标消失不能谎称未提交");
	assert.deepEqual(missing.observed, { revision: null, hash: null });
});

test("C1：reconcile 输入与不可读 journal 的确定结论", async () => {
	const root = await makeStoreRoot("c1-reconcile-input");
	await assert.rejects(() => reconcileJournalOperation({ root, operationId: "../../escape" }), isStorageError("invalid-record", "invalid-operation-id"));
	await assert.rejects(() => reconcileJournalOperation({ root, operationId: randomUUID() }), isStorageError("not-found"));

	const brokenId = randomUUID();
	mkdirSync(join(root, "journal"), { recursive: true });
	writeFileSync(journalPath(root, brokenId), "{ 坏", "utf8");
	const broken = await reconcileJournalOperation({ root, operationId: brokenId });
	assert.equal(broken.outcome, "unreadable");
	assert.equal(broken.changed, false);
});

test("C1：目标锁被占用时 reconcile 返回 busy —— 不抢锁、不改文件", async () => {
	const root = await makeStoreRoot("c1-reconcile-busy");
	const id = "exp-c1-busy";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const targetHash = hashFile(recordPath(root, id));
	const operationId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId,
		operation: "update",
		state: "prepared",
		target: { kind: "experience-card", id },
		before: { revision: 0, hash: targetHash },
		after: { revision: 1, hash: sha256("busy") },
		preparedAt: NOW,
	});

	const boundary = await createStorageBoundary({ root });
	const holder = await acquireStorageLock(boundary, { target: recordPath(root, id), now: NOW, timeoutMs: 1_000 });
	try {
		const result = await reconcileJournalOperation({ root, operationId, now: LATER, lockTimeoutMs: 50, lockPollMs: 10 });
		assert.equal(result.outcome, "busy");
		assert.equal(result.changed, false);
		assert.equal(existsSync(holder.path), true, "绝不删别人的锁");
		assert.equal(hashFile(recordPath(root, id)), targetHash, "busy 时不得改动目标");
		assert.equal(readJournal(root, operationId).state, "prepared", "busy 时不得改 journal");
	} finally {
		rmSync(holder.path, { recursive: true, force: true });
	}
});

test("C1：旧 prepared 不会覆盖后续的合法更新（判定冲突而不是重放）", async () => {
	const root = await makeStoreRoot("c1-reconcile-late");
	const id = "exp-c1-late";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const before = { revision: 0, hash: hashFile(recordPath(root, id)) };

	// 伪造一条“准备更新到 revision=1”的意图，但先让真正的更新跑到 revision=2。
	const staleId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId: staleId,
		operation: "update",
		state: "prepared",
		target: { kind: "experience-card", id },
		before,
		after: { revision: 1, hash: sha256("planned-but-never-happened") },
		preparedAt: NOW,
	});
	await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v1"), expectedRevision: 0, now: LATER });
	const live = await updateRecord({ root, kind: "experience-card", id, data: experienceBody("v2"), expectedRevision: 1, now: LATER + 1 });
	assert.equal(live.revision, 2);
	const liveHash = hashFile(recordPath(root, id));

	const stale = await reconcileJournalOperation({ root, operationId: staleId, now: LATER + 2 });
	assert.equal(stale.outcome, "conflict", "与 before/after 都不一致必须报冲突");
	assert.equal(hashFile(recordPath(root, id)), liveHash, "不得覆盖后续合法更新");
	assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, "v2");
});

test("C1：两个真实进程并发核对同一条 journal —— 只有一个改终态，且互不覆盖", async () => {
	const root = await makeStoreRoot("c1-reconcile-race");
	const id = "exp-c1-race";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const targetHash = hashFile(recordPath(root, id));
	const operationId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId,
		operation: "update",
		state: "prepared",
		target: { kind: "experience-card", id },
		before: { revision: 0, hash: targetHash },
		after: { revision: 1, hash: sha256("never-committed") },
		preparedAt: NOW,
	});

	const barrier = makeBarrier("c1-reconcile");
	const script = (label) => `
const { existsSync, writeFileSync } = await import("node:fs");
const { reconcileJournalOperation } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
const waitFor = async (path, timeoutMs) => { const deadline = Date.now() + timeoutMs; while (!existsSync(path)) { if (Date.now() > deadline) throw new Error("barrier timeout"); await new Promise((r) => setTimeout(r, 5)); } };
writeFileSync(${JSON.stringify(barrier.ready(label))}, "1");
await waitFor(${JSON.stringify(barrier.go)}, 30000);
const result = await reconcileJournalOperation({ root: ${JSON.stringify(root)}, operationId: ${JSON.stringify(operationId)}, now: ${LATER}, lockTimeoutMs: 20000, lockPollMs: 5 });
process.stdout.write(JSON.stringify({ outcome: result.outcome, state: result.journalState, changed: result.changed }));
`;

	const left = spawnNode(script("left"));
	const right = spawnNode(script("right"));
	// 会合点：两个进程都就位后才放行，避免"谁先跑到"决定结果。
	await Promise.all([waitForPath(barrier.ready("left")), waitForPath(barrier.ready("right"))]);
	writeFileSync(barrier.go, "1");
	const [leftOutcome, rightOutcome] = (await Promise.all([left, right])).map(parseChildOutcome);

	assert.equal(leftOutcome.outcome, "aborted", "目标仍是 before ⇒ 两个进程都必须得出 aborted");
	assert.equal(rightOutcome.outcome, "aborted");
	assert.equal(leftOutcome.changed !== rightOutcome.changed, true, "恰好一方写入终态，另一方幂等返回");
	assert.equal(readJournal(root, operationId).state, "aborted");
	assert.equal(hashFile(recordPath(root, id)), targetHash, "核对过程不得触碰业务目标");
	assert.deepEqual(lockEntries(root), [], "核对结束后不得留下锁");
});

/* ------------------------------------------------------------------ 5. 真实进程退出 */

const CHECKPOINTS = ["prepared", "temp-ready", "committed", "final"];

function checkpointWriterScript({ root, mode, id, checkpoint, checkpointPath }) {
	const call =
		mode === "create"
			? `await createRecord({ root: ${JSON.stringify(root)}, kind: "experience-card", id: ${JSON.stringify(id)}, data: EXPERIENCE("v0"), expectedRevision: null, now: ${LATER}, ioHooks: hooks })`
			: mode === "update"
				? `await updateRecord({ root: ${JSON.stringify(root)}, kind: "experience-card", id: ${JSON.stringify(id)}, data: EXPERIENCE("v1"), expectedRevision: 0, now: ${LATER}, ioHooks: hooks })`
				: `await updateRegistry({ root: ${JSON.stringify(root)}, expectedRevision: 0, projects: [{ biosProjectId: ${JSON.stringify(PROJECT_ID)}, workspaces: [], createdAt: ${NOW}, updatedAt: ${NOW} }], now: ${LATER}, ioHooks: hooks })`;

	return `
const { writeFileSync } = await import("node:fs");
const { createRecord, updateRecord, updateRegistry } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
const EXPERIENCE = (solution) => ({ problem: "p", rootCause: "r", solution, appliesWhen: [], doesNotApplyWhen: [], sourceProjectId: ${JSON.stringify(OTHER_PROJECT_ID)}, evidence: [], validations: [], reuseScope: { level: "current-project", customers: [] }, status: "reviewed" });
const inJournal = (p) => typeof p === "string" && p.includes(${JSON.stringify(`${sep}journal${sep}`)});
const CHECKPOINT = ${JSON.stringify(checkpoint)};
const CHECKPOINT_PATH = ${JSON.stringify(checkpointPath)};
// 命中检查点后写标记文件并**永远挂住**：由父进程确认标记后终止本进程。
const park = async () => { writeFileSync(CHECKPOINT_PATH, "1"); await new Promise(() => {}); };
const hooks = { beforeIo: async (operation, target) => {
	const journal = inJournal(target);
	if (CHECKPOINT === "prepared" && operation === "write-temp" && !journal) await park();
	if (CHECKPOINT === "temp-ready" && (operation === "link" || operation === "rename") && !journal) await park();
	if (CHECKPOINT === "committed" && operation === "rename" && journal) await park();
	if (CHECKPOINT === "final" && operation === "lock-remove") await park();
} };
${call};
process.stdout.write("done");
`;
}

function reconcileChildScript({ root, operationId, lockTimeoutMs }) {
	return `
const { reconcileJournalOperation } = await import(${JSON.stringify(STORAGE_MODULE_URL)});
const result = await reconcileJournalOperation({ root: ${JSON.stringify(root)}, operationId: ${JSON.stringify(operationId)}, now: ${LATER + 10}, lockTimeoutMs: ${lockTimeoutMs}, lockPollMs: 10 });
process.stdout.write(JSON.stringify({ outcome: result.outcome, state: result.journalState, changed: result.changed, observed: result.observed, warnings: result.warnings ?? [], detail: result.detail ?? "" }));
`;
}

/**
 * 启动子进程 → 等它到达检查点 → **终止并确认已退出**。
 *
 * 被 SIGKILL 终止时 `close` 事件给的是 `code=null, signal="SIGKILL"`——这里只关心
 * "进程确实没了"（后续清理遗留锁的前提），因此断言两者至少有一个存在。
 */
async function runToCheckpoint(script, checkpointPath) {
	const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
		if (stderr.length > 1 << 20) child.kill("SIGKILL");
	});
	const exited = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
	try {
		await waitForPath(checkpointPath, 30_000);
	} finally {
		child.kill("SIGKILL");
	}
	const outcome = await exited;
	assert.ok(outcome.code !== null || outcome.signal !== null, `子进程必须已退出，stderr=${stderr.slice(0, 400)}`);
	return outcome;
}

function spawnNode(script, { timeoutMs = 60_000 } = {}) {
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

function parseChildOutcome(result) {
	assert.equal(result.timedOut, false, "子进程不得超时");
	assert.equal(result.error, undefined, `子进程启动失败：${result.error?.message ?? ""}`);
	assert.equal(result.code, 0, `子进程退出码非 0：${result.stderr}`);
	return JSON.parse(result.stdout);
}

/** `spawnSync`（同步子进程）的结果形状与 `spawnNode` 不同，解析要分开，否则断言会看错字段。 */
function parseSyncOutcome(result) {
	assert.equal(result.error, undefined, `子进程启动失败：${result.error?.message ?? ""}`);
	assert.equal(result.status, 0, `子进程退出码非 0：${result.stderr}`);
	return JSON.parse(result.stdout);
}

function makeBarrier(name) {
	rootCounter += 1;
	const dir = join(SANDBOX, `barrier-${name}-${rootCounter}`);
	mkdirSync(dir, { recursive: true });
	return { ready: (label) => join(dir, `ready-${label}`), go: join(dir, "go") };
}

for (const checkpoint of CHECKPOINTS) {
	// create 与 update 都要覆盖；registry 至少覆盖“已提交但终态未写”。
	const modes = checkpoint === "committed" ? ["create", "update", "registry"] : ["create", "update"];
	for (const mode of modes) {
		test(`C1：真实进程在「${checkpoint}」检查点被终止（${mode}）→ 新进程核对得到确定结论`, async () => {
			const root = await makeStoreRoot(`c1-crash-${checkpoint}-${mode}`);
			const id = "exp-c1-crash";
			let expectedBefore = null;
			if (mode !== "create") {
				await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
				expectedBefore = hashFile(recordPath(root, id));
			}
			const registryBefore = hashFile(join(root, "registry.json"));

			const checkpointPath = join(root, `checkpoint-${checkpoint}-${mode}`);
			const journalBefore = journalJsonNames(root);
			await runToCheckpoint(checkpointWriterScript({ root, mode, id, checkpoint, checkpointPath }), checkpointPath);

			// 子进程只应新增一条 journal——那就是"这次被中断的写入"。
			const operationId = crashedJournalId(journalBefore, root);
			const journalAtCrash = readJournal(root, operationId);
			assert.equal(journalAtCrash.operation, mode === "registry" ? "update" : mode);
			assert.equal(journalAtCrash.target.kind, mode === "registry" ? "registry" : "experience-card");

			if (checkpoint === "prepared" || checkpoint === "temp-ready") {
				// 数据一定还没提交：journal 是 prepared，目标保持旧字节。
				assert.equal(journalAtCrash.state, "prepared");
				if (mode === "create") assert.equal(existsSync(recordPath(root, id)), false, "前置检查点不得创建目标");
				else assert.equal(hashFile(recordPath(root, id)), expectedBefore, "前置检查点不得改动目标");
				assert.equal(hashFile(join(root, "registry.json")), registryBefore);
			}
			if (checkpoint === "committed") {
				// 数据已提交但终态没写：这正是 needs-recovery 的真实形态。
				assert.equal(journalAtCrash.state, "prepared");
				if (mode === "registry") assert.notEqual(hashFile(join(root, "registry.json")), registryBefore, "registry 必须已经提交");
				else assert.equal((await readRecord({ root, kind: "experience-card", id })).record.solution, mode === "create" ? "v0" : "v1");
			}
			if (checkpoint === "final") {
				assert.equal(journalAtCrash.state, "committed", "终态已写、只差释放锁");
				assert.equal(readJournal(root, operationId).source, "writer-confirmed");
			}

			const crashedHash = hashFile(recordPath(root, id));
			const snapshot = () => ({
				target: hashFile(recordPath(root, id)),
				registry: hashFile(join(root, "registry.json")),
				journal: hashFile(journalPath(root, operationId)),
				locks: lockEntries(root).length,
				temps: tempLeftovers(dirname(recordPath(root, id))).length,
			});
			const afterCrash = snapshot();
			const journalIsPrepared = journalAtCrash.state === "prepared";
			// 被终止的写者同时留下两样东西：prepared 意图与**它自己的**锁。
			assert.equal(afterCrash.locks, 1, "被终止的写者会留下自己的锁——这正是需要人工确认的原因");

			// ① 未处理遗留锁之前：新进程核对**不得抢锁、不得改任何文件**。
			const first = parseSyncOutcome(runNode(reconcileChildScript({ root, operationId, lockTimeoutMs: 300 })));
			if (journalIsPrepared) {
				assert.equal(first.outcome, "busy", "无法证明归属的锁一律 busy，不按 pid/年龄抢占");
				assert.equal(first.changed, false);
			} else {
				// journal 已经有终态：核对是幂等的，既不需要也不应该碰锁。
				assert.equal(first.outcome, "committed");
				assert.equal(first.changed, false);
			}
			assert.deepEqual(snapshot(), afterCrash, "busy/幂等核对不得修改目标、journal、锁或残留文件");

			// ② harness 在**确认子进程已退出**后，只清理本 fixture 的那把遗留锁。
			//    这不是产品行为：C1 没有任何自动抢锁/按年龄回收的路径。
			for (const name of lockEntries(root)) rmSync(join(root, "locks", name), { recursive: true, force: true });

			// ③ 人工确认后重新核对：结论必须确定，且不再改动目标。
			const reconciled = parseSyncOutcome(runNode(reconcileChildScript({ root, operationId, lockTimeoutMs: 5_000 })));
			const expectedOutcome = checkpoint === "committed" || checkpoint === "final" ? "committed" : "aborted";
			assert.equal(reconciled.outcome, expectedOutcome, `检查点 ${checkpoint}（${mode}）的结论必须确定`);
			assert.equal(readJournal(root, operationId).state, expectedOutcome);
			assert.equal(reconciled.changed, checkpoint !== "final", "已有终态的核对必须幂等（不重写）");

			// 目标要么还是旧值、要么就是“新值”，绝不允许半成品或重复递增。
			if (mode === "registry") {
				assert.equal(hashFile(join(root, "registry.json")), checkpoint === "prepared" || checkpoint === "temp-ready" ? registryBefore : snapshot().registry, "registry 内容必须完整且自洽");
			} else if (mode === "create") {
				assert.equal(existsSync(recordPath(root, id)), checkpoint === "committed" || checkpoint === "final");
				if (existsSync(recordPath(root, id))) {
					assert.equal((await readRecord({ root, kind: "experience-card", id })).record.revision, 0, "create 的 revision 只能是 0");
					assert.equal(hashFile(recordPath(root, id)), crashedHash, "核对不得改写已提交内容");
				}
			} else {
				assert.equal(hashFile(recordPath(root, id)), crashedHash, "核对不得改写目标");
				assert.equal((await readRecord({ root, kind: "experience-card", id })).record.revision, checkpoint === "prepared" || checkpoint === "temp-ready" ? 0 : 1, "revision 只允许 +1 一次");
			}

			if (checkpoint === "temp-ready") {
				// 崩溃留下的 .tmp 属预期：C1 既不扫描也不删除别人的临时文件。
				assert.equal(afterCrash.temps, 1);
				assert.equal(snapshot().temps, 1, "reconcile 不得清理 .tmp");
				for (const name of tempLeftovers(dirname(recordPath(root, id)))) rmSync(join(dirname(recordPath(root, id)), name), { force: true });
			}
			assert.deepEqual(lockEntries(root), [], "核对结束后不应再留下锁（遗留锁由 harness 清理过）");
		});
	}
}

test("C1：prepared 指向的目标是链接/目录时 reconcile 报 unreadable，且不动根外内容", async (t) => {
	const root = await makeStoreRoot("c1-reconcile-link");
	const outside = makeRawRoot("c1-reconcile-link-outside");
	const sentinel = join(outside, "sentinel.txt");
	writeFileSync(sentinel, "keep-me", "utf8");
	const sentinelHash = hashFile(sentinel);

	const id = "exp-c1-link";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	rmSync(recordPath(root, id), { force: true });
	try {
		symlinkSync(outside, recordPath(root, id), "junction");
	} catch (error) {
		t.skip(`本机无法创建 junction：${error.code ?? error.message}`);
		return;
	}

	const operationId = randomUUID();
	writeJournalFixture(root, {
		journalVersion: 1,
		operationId,
		operation: "update",
		state: "prepared",
		target: { kind: "experience-card", id },
		before: { revision: 0, hash: sha256("before") },
		after: { revision: 1, hash: sha256("after") },
		preparedAt: NOW,
	});

	const result = await reconcileJournalOperation({ root, operationId, now: LATER });
	assert.equal(result.outcome, "unreadable", "链接目标必须报无法判定");
	assert.equal(result.changed, false);
	assert.equal(readJournal(root, operationId).state, "prepared", "证据保留，不改 journal");
	assert.equal(hashFile(sentinel), sentinelHash, "不得触碰根外内容");
});

/* ====================================================================================================
 * §C1R：第八轮独立验收（J1～J4）的永久回归
 *
 * 复现方式与验收报告一致：J1 持锁期间换目标、J2 目标版本/结构/身份非法、J3 释放失败的诊断被丢、
 * J4 巡检把"估算字符数"当字节预算。全部使用临时合成记录，不读任何真实资料。
 * ================================================================================================== */

const WORKSPACE_ID = "b7d1e9f2-3c4a-4d5e-8f9a-0b1c2d3e4f50";

function taskBody(overrides = {}) {
	return {
		workspace: { workspaceId: WORKSPACE_ID, path: join(SANDBOX, "ws-main"), branch: "feature/x", baseCommit: "abc1234" },
		requirement: "r",
		status: "in_progress",
		decisions: [],
		todos: [],
		blockers: [],
		relatedFiles: [],
		sourceExperienceIds: [],
		validations: [],
		...overrides,
	};
}

function taskRecordPath(root, projectId, id) {
	return join(root, "projects", projectId, "tasks", `${id}.json`);
}

/** 造一条合法 prepared：目标与 before/after 都由调用方给出（`after` 通常取自磁盘真实字节）。 */
function seedPrepared(root, { target, before, after, operation = "update" }) {
	const operationId = randomUUID();
	writeJournalFixture(root, { journalVersion: 1, operationId, operation, state: "prepared", target, before, after, preparedAt: NOW });
	return operationId;
}

/** 经验卡的合法 prepared（before = 当前真实字节）。 */
function seedPreparedForRecord(root, id) {
	const hash = hashFile(recordPath(root, id));
	return seedPrepared(root, { target: { kind: "experience-card", id }, before: { revision: 0, hash }, after: { revision: 1, hash } });
}

function writeRegistryFixture(root, overrides = {}) {
	const path = join(root, "registry.json");
	writeFileSync(path, serializePayload({ schemaVersion: 1, revision: 0, createdAt: NOW, updatedAt: NOW, projects: [], ...overrides }), "utf8");
	return path;
}

/** 放一把"别人的锁"：任何恢复路径都不得删除它。 */
function seedForeignLock(root) {
	const dir = join(root, "locks", "lock-foreign-fixture");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "owner.json"), serializePayload({ ownerId: "someone-else", pid: 1, createdAt: NOW, target: "x" }), "utf8");
	return dir;
}

function clearOwnLocks(root, keepForeign = false) {
	for (const name of lockEntries(root)) {
		if (keepForeign && name === "lock-foreign-fixture") continue;
		rmSync(join(root, "locks", name), { recursive: true, force: true });
	}
}

test("C1R-1：持锁复读到目标被改到别处时，不得继续持旧锁收口", async () => {
	const root = await makeStoreRoot("c1r1-lock-binding");
	const idA = "exp-c1r1-a";
	const idB = "exp-c1r1-b";
	await createRecord({ root, kind: "experience-card", id: idA, data: experienceBody("A"), expectedRevision: null, now: NOW });
	await createRecord({ root, kind: "experience-card", id: idB, data: experienceBody("B"), expectedRevision: null, now: NOW });
	const hashA = hashFile(recordPath(root, idA));
	const hashB = hashFile(recordPath(root, idB));
	assert.notEqual(hashA, hashB, "两个目标的字节必须不同，否则本用例失去意义");
	const foreignLock = seedForeignLock(root);
	const operationId = seedPreparedForRecord(root, idA);

	// 复现 J1：读 journal 之后、真正创建锁目录之前，把 journal 的 target 改成 B（其余字段仍合法）。
	let flipped = false;
	let flippedJournalHash = null;
	const result = await reconcileJournalOperation({
		root,
		operationId,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation !== "lock-mkdir" || flipped) return undefined;
				flipped = true;
				const record = readJournal(root, operationId);
				record.target = { kind: "experience-card", id: idB };
				writeFileSync(journalPath(root, operationId), serializePayload(record), "utf8");
				flippedJournalHash = hashFile(journalPath(root, operationId));
				return undefined;
			},
		},
	});

	assert.equal(flipped, true, "必须真的进入过该窗口");
	assert.equal(result.outcome, "unreadable", "锁目标与 journal 目标不一致时不得下结论");
	assert.equal(result.changed, false, "不得写终态");
	assert.equal(result.observed, null, "没有对 B 做过观测，不能冒充");
	assert.equal(readJournal(root, operationId).state, "prepared", "证据必须保留");
	assert.equal(hashFile(journalPath(root, operationId)), flippedJournalHash, "不得再改写已变化的 journal");
	assert.equal(hashFile(recordPath(root, idA)), hashA, "A 不得被改写");
	assert.equal(hashFile(recordPath(root, idB)), hashB, "B 不得被改写");
	assert.equal(existsSync(foreignLock), true, "不得删除他人的锁");
	assert.deepEqual(lockEntries(root), ["lock-foreign-fixture"], "自有锁仍必须释放，他人锁保留");
	assert.ok(String(result.detail ?? "").length > 0 && String(result.detail).length < 500, "诊断必须有界");
	clearOwnLocks(root, true);
});

test("C1R-1：目标比较必须覆盖项目归属，不能只比 id", async () => {
	const root = await makeStoreRoot("c1r1-project-binding");
	const id = "task-c1r1";
	await createRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody(), expectedRevision: null, now: NOW });
	const path = taskRecordPath(root, PROJECT_ID, id);
	const beforeHash = hashFile(path);
	const operationId = seedPrepared(root, { target: { kind: "task-record", id, projectId: PROJECT_ID }, before: { revision: 0, hash: beforeHash }, after: { revision: 1, hash: beforeHash } });

	// 持锁前把 target 的 projectId 换成另一个项目（id 不变）。
	let flipped = false;
	const result = await reconcileJournalOperation({
		root,
		operationId,
		now: LATER,
		ioHooks: {
			beforeIo: (operation) => {
				if (operation !== "lock-mkdir" || flipped) return undefined;
				flipped = true;
				const record = readJournal(root, operationId);
				record.target = { kind: "task-record", id, projectId: OTHER_PROJECT_ID };
				writeFileSync(journalPath(root, operationId), serializePayload(record), "utf8");
				return undefined;
			},
		},
	});

	assert.equal(flipped, true);
	assert.equal(result.outcome, "unreadable", "只比 id 会漏掉归属变化");
	assert.equal(result.changed, false);
	assert.equal(hashFile(path), beforeHash, "目标不得被改写");
	assert.equal(readJournal(root, operationId).state, "prepared");
	assert.deepEqual(lockEntries(root), [], "自有锁必须释放");
});

test("C1R-2：目标版本/结构/身份非法时一律 unreadable，且原字节不变", async (t) => {
	const recordCases = [
		{ name: "记录未知 schemaVersion", corrupt: (value) => ({ ...value, schemaVersion: 999 }) },
		{ name: "记录只有 revision 的非法结构", corrupt: () => ({ schemaVersion: 1, revision: 0 }) },
		{ name: "记录路径 ID 与内容 ID 不符", corrupt: (value) => ({ ...value, id: "exp-c1r2-other" }) },
	];

	for (const scenario of recordCases) {
		await t.test(scenario.name, async () => {
			const root = await makeStoreRoot(`c1r2-${scenario.name}`);
			const id = "exp-c1r2";
			await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
			const originalHash = hashFile(recordPath(root, id));
			const value = JSON.parse(readFileSync(recordPath(root, id), "utf8"));
			writeFileSync(recordPath(root, id), serializePayload(scenario.corrupt(value)), "utf8");
			const corruptedHash = hashFile(recordPath(root, id));
			const operationId = seedPrepared(root, { target: { kind: "experience-card", id }, before: { revision: 0, hash: originalHash }, after: { revision: 1, hash: corruptedHash } });
			// 关键：非法目标的真实 hash **恰好等于** after，也必须 unreadable（校验先于比对）。
			assert.equal(readJournal(root, operationId).after.hash, corruptedHash);

			const result = await reconcileJournalOperation({ root, operationId, now: LATER });
			assert.equal(result.outcome, "unreadable", `${scenario.name} 必须报无法判定，而不是拿它和 before/after 比`);
			assert.equal(result.changed, false);
			assert.equal(hashFile(recordPath(root, id)), corruptedHash, "非法目标不得被改写或清除");
			assert.equal(readJournal(root, operationId).state, "prepared", "证据必须保留");
			assert.deepEqual(lockEntries(root), [], "自有锁必须释放");
		});
	}

	await t.test("任务记录的项目归属不符", async () => {
		const root = await makeStoreRoot("c1r2-task-ownership");
		const id = "task-c1r2";
		await createRecord({ root, kind: "task-record", id, projectId: PROJECT_ID, data: taskBody(), expectedRevision: null, now: NOW });
		const path = taskRecordPath(root, PROJECT_ID, id);
		const originalHash = hashFile(path);
		const value = JSON.parse(readFileSync(path, "utf8"));
		writeFileSync(path, serializePayload({ ...value, projectId: OTHER_PROJECT_ID }), "utf8");
		const corruptedHash = hashFile(path);
		const operationId = seedPrepared(root, { target: { kind: "task-record", id, projectId: PROJECT_ID }, before: { revision: 0, hash: originalHash }, after: { revision: 1, hash: corruptedHash } });

		const result = await reconcileJournalOperation({ root, operationId, now: LATER });
		assert.equal(result.outcome, "unreadable", "归属不符必须报无法判定");
		assert.equal(result.changed, false);
		assert.equal(hashFile(path), corruptedHash, "非法目标不得被改写");
		assert.equal(readJournal(root, operationId).state, "prepared");
	});

	await t.test("registry 未知版本", async () => {
		const root = await makeStoreRoot("c1r2-registry-version");
		const originalHash = hashFile(join(root, "registry.json"));
		const registryPath = writeRegistryFixture(root, { schemaVersion: 999 });
		const corruptedHash = hashFile(registryPath);
		const operationId = seedPrepared(root, { target: { kind: "registry" }, before: { revision: 0, hash: originalHash }, after: { revision: 1, hash: corruptedHash } });

		const result = await reconcileJournalOperation({ root, operationId, now: LATER });
		assert.equal(result.outcome, "unreadable", "未来版本 registry 必须报无法判定");
		assert.equal(result.changed, false);
		assert.equal(hashFile(registryPath), corruptedHash, "registry 字节不得被改写");
		assert.equal(readJournal(root, operationId).state, "prepared");
	});

	await t.test("registry 绑定冲突", async () => {
		const root = await makeStoreRoot("c1r2-registry-binding");
		const originalHash = hashFile(join(root, "registry.json"));
		const registryPath = writeRegistryFixture(root, { projects: [projectFixture(), projectFixture()] });
		const corruptedHash = hashFile(registryPath);
		const operationId = seedPrepared(root, { target: { kind: "registry" }, before: { revision: 0, hash: originalHash }, after: { revision: 1, hash: corruptedHash } });

		const result = await reconcileJournalOperation({ root, operationId, now: LATER });
		assert.equal(result.outcome, "unreadable", "绑定冲突的 registry 必须报无法判定");
		assert.equal(result.changed, false);
		assert.equal(hashFile(registryPath), corruptedHash);
		assert.equal(readJournal(root, operationId).state, "prepared");
	});
});

test("C1R-3：核对抛错时保留首错，并附加有界的锁清理诊断", async () => {
	const root = await makeStoreRoot("c1r3-throw");
	const id = "exp-c1r3";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const targetPath = recordPath(root, id);
	const targetHash = hashFile(targetPath);
	const operationId = seedPreparedForRecord(root, id);

	// J3 复现：持锁读取目标时取消；随后自有锁删除失败。
	const controller = new AbortController();
	const thrown = await reconcileJournalOperation({
		root,
		operationId,
		now: LATER,
		signal: controller.signal,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation === "read" && target === targetPath) controller.abort();
				if (operation === "lock-remove") return Promise.reject(Object.assign(new Error("注入：锁删除失败"), { code: "EIO" }));
				return undefined;
			},
		},
	}).then(
		() => null,
		(error) => error,
	);

	assert.ok(thrown instanceof StorageError, `必须抛 StorageError，实际：${thrown}`);
	assert.equal(thrown.code, "cancelled", "首错必须保留（不能被清理错误覆盖）");
	assert.ok(String(thrown.message).includes("锁未正常释放"), `必须附加锁清理诊断，实际：${String(thrown.message)}`);
	assert.ok(!String(thrown.message).includes("PXE"), "诊断不得携带记录正文");
	assert.ok(String(thrown.message).length < 500, "诊断必须有界");
	assert.equal(lockEntries(root).length, 1, "释放失败会留下自有锁：如实报告，不假装已删除");
	assert.equal(readJournal(root, operationId).state, "prepared");
	assert.equal(hashFile(targetPath), targetHash, "目标不得被改写");
	clearOwnLocks(root);
});

test("C1R-3：结论走返回值时同样保留释放失败警告，且不改文件", async () => {
	const root = await makeStoreRoot("c1r3-result");
	const id = "exp-c1r3-result";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const targetPath = recordPath(root, id);
	const targetHash = hashFile(targetPath);
	const operationId = seedPreparedForRecord(root, id);

	// 非取消的普通 IO 异常在读目标时按设计收敛为 unreadable（返回值），此时释放失败必须进 warnings。
	const result = await reconcileJournalOperation({
		root,
		operationId,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (operation === "read" && target === targetPath) return Promise.reject(Object.assign(new Error("注入：目标读取失败"), { code: "EIO" }));
				if (operation === "lock-remove") return Promise.reject(Object.assign(new Error("注入：锁删除失败"), { code: "EBUSY" }));
				return undefined;
			},
		},
	});

	assert.equal(result.outcome, "unreadable", "目标读不动 ⇒ 无法判定");
	assert.equal(result.changed, false);
	assert.ok(
		(result.warnings ?? []).some((note) => note.includes("锁未正常释放")),
		`返回值路径也必须给出锁残留警告，实际：${JSON.stringify(result.warnings)}`,
	);
	assert.equal(lockEntries(root).length, 1, "残留锁必须如实存在（不假装删掉）");
	assert.equal(readJournal(root, operationId).state, "prepared");
	assert.equal(hashFile(targetPath), targetHash);
	clearOwnLocks(root);
});

test("C1R-3：journal 终态写入失败的清理诊断不被丢弃；成功收口的 cleanup 也要如实传递", async () => {
	// ① 终态 rename 失败 + 临时文件删不掉：既有清理诊断必须一起上报。
	const rootFail = await makeStoreRoot("c1r3-finalize-fail");
	const idFail = "exp-c1r3-ff";
	await createRecord({ root: rootFail, kind: "experience-card", id: idFail, data: experienceBody("v1"), expectedRevision: null, now: NOW });
	const targetHashFail = hashFile(recordPath(rootFail, idFail));
	const opFail = seedPrepared(rootFail, { target: { kind: "experience-card", id: idFail }, before: { revision: null, hash: null }, after: { revision: 0, hash: targetHashFail }, operation: "create" });
	const journalDirFail = join(rootFail, "journal");

	const failed = await reconcileJournalOperation({
		root: rootFail,
		operationId: opFail,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => {
				if (!isJournalPath(target)) return undefined;
				if (operation === "rename") return Promise.reject(Object.assign(new Error("注入：终态替换失败"), { code: "EBUSY" }));
				if (operation === "unlink-temp") return Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EIO" }));
				return undefined;
			},
		},
	});

	assert.equal(failed.changed, false, "收口失败不得谎称已收口");
	assert.ok(
		(failed.warnings ?? []).some((note) => note.includes("终态写入失败")),
		`必须报告终态写入失败，实际：${JSON.stringify(failed.warnings)}`,
	);
	assert.ok(
		(failed.warnings ?? []).some((note) => note.includes("清理失败")),
		`既有清理诊断不得被丢弃，实际：${JSON.stringify(failed.warnings)}`,
	);
	assert.equal(readJournal(rootFail, opFail).state, "prepared");
	assert.ok(tempLeftovers(journalDirFail).length >= 1, "清理失败会留下 .tmp——这正是被如实报告的那件事");
	assert.equal(hashFile(recordPath(rootFail, idFail)), targetHashFail, "目标不得被改写");
	for (const name of tempLeftovers(journalDirFail)) rmSync(join(journalDirFail, name), { force: true });
	clearOwnLocks(rootFail);

	// ② 终态成功但临时文件删不掉：cleanup 必须如实出现在 warnings 里。
	const rootOk = await makeStoreRoot("c1r3-finalize-cleanup");
	const idOk = "exp-c1r3-ok";
	await createRecord({ root: rootOk, kind: "experience-card", id: idOk, data: experienceBody("v1"), expectedRevision: null, now: NOW });
	const targetHashOk = hashFile(recordPath(rootOk, idOk));
	const opOk = seedPrepared(rootOk, { target: { kind: "experience-card", id: idOk }, before: { revision: null, hash: null }, after: { revision: 0, hash: targetHashOk }, operation: "create" });
	const journalDirOk = join(rootOk, "journal");

	const ok = await reconcileJournalOperation({
		root: rootOk,
		operationId: opOk,
		now: LATER,
		ioHooks: {
			beforeIo: (operation, target) => (operation === "unlink-temp" && isJournalPath(target) ? Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EIO" })) : undefined),
		},
	});

	assert.equal(ok.outcome, "committed");
	assert.equal(ok.changed, true);
	assert.ok(
		(ok.warnings ?? []).some((note) => note.includes("清理失败")),
		`成功收口也要传递 cleanup 事实，实际：${JSON.stringify(ok.warnings)}`,
	);
	assert.equal(readJournal(rootOk, opOk).state, "committed");
	for (const name of tempLeftovers(journalDirOk)) rmSync(join(journalDirOk, name), { force: true });
});

test("C1R-4：巡检的候选字节预算按真实 UTF-8 序列化计量", async () => {
	const root = await makeStoreRoot("c1r4-bytes");
	const id = "exp-c1r4";
	await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0"), expectedRevision: null, now: NOW });
	const operationId = seedPreparedForRecord(root, id);
	const targetHash = hashFile(recordPath(root, id));
	const journalHash = hashFile(journalPath(root, operationId));

	// 先量出这条候选的真实字节：预算充足时恰好返回 1 条。
	const wide = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: 1_000_000 } });
	assert.equal(wide.pending.length, 1, "应当有一条 prepared 候选");
	const arrayBytes = Buffer.byteLength(JSON.stringify(wide.pending), "utf8");
	const entryBytes = Buffer.byteLength(JSON.stringify(wide.pending[0]), "utf8");
	assert.equal(arrayBytes, entryBytes + 2, "单条候选的数组开销只有方括号");

	// J4 复现：300 字节预算下不得返回 363 字节的候选数组。
	const tight = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: 300 } });
	assert.ok(Buffer.byteLength(JSON.stringify(tight.pending), "utf8") <= 300, `候选数组不得超过预算，实际 ${Buffer.byteLength(JSON.stringify(tight.pending), "utf8")}`);
	assert.equal(tight.pending.length, 0, "单条候选就超过 300 字节，必须截断");
	assert.equal(tight.truncated, true);
	assert.ok(tight.truncatedBy.includes("bytes"));

	// 恰好够 / 少一字节：边界必须精确，而不是"差不多"。
	const exact = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: arrayBytes } });
	assert.equal(exact.pending.length, 1, "预算恰好等于真实字节时应能返回");
	const oneByteLess = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: arrayBytes - 1 } });
	assert.equal(oneByteLess.pending.length, 0, "少一字节就必须截断");
	assert.ok(oneByteLess.truncatedBy.includes("bytes"));

	// 0 预算仍然是"不返回候选"（空数组 `[]` 是固定信封开销，不能因此放行一条）。
	const zero = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: 0 } });
	assert.equal(zero.pending.length, 0);
	assert.ok(zero.truncatedBy.includes("bytes"));

	// 巡检只读：journal 与目标都不许被改动。
	assert.equal(hashFile(journalPath(root, operationId)), journalHash);
	assert.equal(readJournal(root, operationId).state, "prepared");
	assert.equal(hashFile(recordPath(root, id)), targetHash);
	assert.deepEqual(tempLeftovers(join(root, "journal")), []);
});

test("C1R-4：多条候选合计触顶与较长合法目标都按真实字节判定", async () => {
	const root = await makeStoreRoot("c1r4-multi");
	const ids = ["exp-c1r4-aa", "exp-c1r4-bb", "exp-c1r4-cc"];
	for (const id of ids) await createRecord({ root, kind: "experience-card", id, data: experienceBody(id), expectedRevision: null, now: NOW });
	for (const id of ids) seedPreparedForRecord(root, id);

	const wide = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: 1_000_000 } });
	assert.equal(wide.pending.length, 3);
	const entryBytes = Buffer.byteLength(JSON.stringify(wide.pending[0]), "utf8");
	assert.ok(
		wide.pending.every((entry) => Buffer.byteLength(JSON.stringify(entry), "utf8") === entryBytes),
		"三条目标等长（同长度 id / UUID / 哈希），字节数应一致",
	);

	// 恰好容纳 2 条：`[e,e]` = 2 + entry + 1 + entry。
	const twoEntries = 3 + 2 * entryBytes;
	const two = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: twoEntries } });
	assert.equal(two.pending.length, 2, "应当恰好返回 2 条");
	assert.ok(Buffer.byteLength(JSON.stringify(two.pending), "utf8") <= twoEntries);
	assert.ok(two.truncatedBy.includes("bytes"), "第三条必须记为字节截断");
	const twoMinusOne = await inspectPendingJournal({ root, limits: { maxJournalInspectBytes: twoEntries - 1 } });
	assert.equal(twoMinusOne.pending.length, 1, "少一字节只容得下 1 条");

	// 更长但合法的 ID：单独一个根，只放这一条候选，边界必须精确（不被低估也不被误伤）。
	const longRoot = await makeStoreRoot("c1r4-long");
	const longId = `exp-${"a".repeat(120)}`;
	await createRecord({ root: longRoot, kind: "experience-card", id: longId, data: experienceBody("long"), expectedRevision: null, now: NOW });
	const longOperationId = seedPreparedForRecord(longRoot, longId);
	const longWide = await inspectPendingJournal({ root: longRoot, limits: { maxJournalInspectBytes: 1_000_000 } });
	assert.equal(longWide.pending.length, 1, "较长目标必须作为候选返回");
	const longEntryBytes = Buffer.byteLength(JSON.stringify(longWide.pending[0]), "utf8");
	assert.ok(longEntryBytes > entryBytes, "较长 id 的候选应当更大（估算式实现看不出这个差别）");
	const longArrayBytes = longEntryBytes + 2;

	const longExact = await inspectPendingJournal({ root: longRoot, limits: { maxJournalInspectBytes: longArrayBytes } });
	assert.equal(longExact.pending.length, 1, "预算恰好等于真实字节时应当返回");
	const longShort = await inspectPendingJournal({ root: longRoot, limits: { maxJournalInspectBytes: longArrayBytes - 1 } });
	assert.equal(longShort.pending.length, 0, "少一字节不得放行");
	assert.ok(longShort.truncatedBy.includes("bytes"));
	assert.equal(readJournal(longRoot, longOperationId).state, "prepared", "巡检不得改动 journal");
});
