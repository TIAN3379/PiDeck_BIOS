/**
 * BM-02C2B（C2B-1/C2B-2）的**永久回归**：一次经验卡审核的真实持久化。
 *
 * 这一轮要钉死的不是"能不能写出三条文件"，而是四件最容易写错、也最难事后发现的事：
 *
 * 1. **顺序**：意图 → v2 prepared → 记录提交 → 事件发布/认领 → 完成终态。
 *    完成终态必须在事件之后；提交点之后的一切失败只能报 pending，不能改口成"未提交"。
 * 2. **三方绑定是真实字节**：v2 绑的 `intentHash` 必须等于**磁盘上意图文件的 SHA-256**，
 *    `after.hash` 必须等于**磁盘上记录文件的 SHA-256**——不是"再序列化一遍算出来的值"。
 * 3. **失败不留半成品**：提交前失败不得改业务、不得留事件；能记 `aborted` 就记，
 *    记不进去就留下 `prepared`（交给 reconcile），原错误永远优先。
 * 4. **普通写不受影响**：`createRecord` / `updateRecord` 仍然只产生 v1 journal。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test, { after } from "node:test";
import { auditIntentFileName, isValidAuditEvent, validateAuditIntent } from "../core/contracts/index.ts";
import { acquireStorageLock, createRecord, createStorageBoundary, initializeKnowledgeStore, inspectPendingReviewOperations, publishReviewEventArtifact, publishReviewIntentArtifact, readRecord, reconcileReviewOperation, recordReviewDecision, StorageError, updateRecord } from "../core/storage/index.ts";
import { validateReviewJournalRecord } from "../core/storage/review/contract.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-review-writer-")));
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const SOURCE_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const OTHER_PROJECT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";

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

/* ------------------------------------------------------------------ fixture */

function experienceBody(solution, overrides = {}) {
	return {
		problem: "PXE 默认开启导致安装后仍尝试网络引导",
		rootCause: "Setup 默认值未随客户选项调整",
		solution,
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: SOURCE_PROJECT_ID,
		evidence: [{ type: "source-file", relativePath: "Setup.c", location: "120-160", capturedAt: NOW, validity: "active" }],
		validations: [{ kind: "compile", scope: "Setup.c", result: "passed", performedAt: NOW, performedBy: "alice", evidence: [] }],
		reuseScope: { level: "current-project", customers: [] },
		status: "draft",
		...overrides,
	};
}

/** 建一条已存在的经验卡（默认 `reviewed`，便于直接 approve）。 */
async function seedCard(root, { id = "exp-a", status = "reviewed", overrides = {}, now = NOW } = {}) {
	const created = await createRecord({ root, kind: "experience-card", id, data: experienceBody("v0", { ...overrides, status }), expectedRevision: null, now });
	return { id, revision: created.revision };
}

function recordPath(root, id) {
	return join(root, "experiences", `${id}.json`);
}

function intentPath(root, operationId) {
	return join(root, "audit", "intents", auditIntentFileName(operationId));
}

function eventPath(root, recordId, eventId) {
	return join(root, "audit", recordId, `${eventId}.json`);
}

function journalPath(root, operationId) {
	return join(root, "journal", `${operationId}.json`);
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function hashFile(path) {
	return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

function lockEntries(root) {
	const dir = join(root, "locks");
	return existsSync(dir) ? readdirSync(dir) : [];
}

function tempLeftovers(root, ...segments) {
	const dir = join(root, ...segments);
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

/** 一次标准的 approve 调用（覆盖字段按需给出）。 */
function approval(root, overrides = {}) {
	return { root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "已比对现场日志与客户选项", now: LATER, ...overrides };
}

function expectStorageError(code, detailPart) {
	return (error) => {
		assert.ok(error instanceof StorageError, `应当是 StorageError，实际：${String(error)}`);
		assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}（${error.message}）`);
		if (detailPart !== undefined) assert.ok(error.detail?.includes(detailPart) || error.message.includes(detailPart), `诊断应包含 ${detailPart}：${error.detail ?? ""} ${error.message}`);
		return true;
	};
}

function isPathIn(root, marker) {
	return (target) => typeof target === "string" && target.startsWith(root) && target.includes(marker);
}

/* ------------------------------------------------------------------ 正常路径 */

test("C2B：审核只改状态与 reviewer；意图/事件/v2 的三方绑定是磁盘真实字节", async () => {
	const root = await makeStoreRoot("review-happy");
	await seedCard(root, { status: "reviewed" });
	const before = hashFile(recordPath(root, "exp-a"));

	const result = await recordReviewDecision(approval(root));
	assert.equal(result.kind, "applied", `应当完全成功：${JSON.stringify(result.warnings ?? [])}`);
	assert.equal(result.revision, 1, "revision 只增 1");
	assert.equal(result.record.status, "verified");
	assert.equal(result.record.reviewer, "bob", "approve 把本次操作者记为审核人");
	assert.equal(result.journal.state, "committed");
	assert.equal(result.audit?.publication, "writer", "写入方直接发布");
	assert.equal(result.lockRelease, "released");

	// 业务正文与公共头：除 status/reviewer/revision/updatedAt 外逐字节保留。
	const current = readJson(recordPath(root, "exp-a"));
	assert.equal(current.problem, "PXE 默认开启导致安装后仍尝试网络引导");
	assert.equal(current.solution, "v0");
	assert.equal(current.schemaVersion, 1);
	assert.equal(current.createdAt, NOW);
	assert.equal(current.updatedAt, LATER);
	assert.notEqual(hashFile(recordPath(root, "exp-a")), before, "记录字节必须变化（否则等于没审核）");

	// 意图：真实字节指纹 = v2 绑定的 intentHash。
	const intent = readJson(intentPath(root, result.operationId));
	assert.equal(validateAuditIntent(intent).ok, true);
	assert.equal(intent.purpose, "review");
	assert.equal(intent.eventId, result.eventId);
	assert.equal(hashFile(intentPath(root, result.operationId)), result.intentHash);
	assert.equal(Object.hasOwn(intent, "publication"), false, "意图**不含**发布事实");

	// 事件：完整合法，发布事实与结果一致。
	const event = readJson(eventPath(root, "exp-a", result.eventId));
	assert.equal(isValidAuditEvent(event), true);
	assert.equal(event.publication, "writer");
	assert.equal(event.recordedAt, LATER);
	assert.equal(event.before.revision, 0);
	assert.equal(event.after.revision, 1);
	assert.equal(event.target.recordId, "exp-a");

	// v2：完整契约 + 绑定真实字节（意图原字节 & 提交后的记录字节）。
	const journal = readJson(journalPath(root, result.operationId));
	const validation = validateReviewJournalRecord(journal, `${result.operationId}.json`);
	assert.equal(validation.ok, true, `v2 必须通过契约：${JSON.stringify(validation.issues ?? [])}`);
	assert.equal(journal.journalVersion, 2);
	assert.equal(journal.journalPurpose, "review");
	assert.equal(journal.operation, "update");
	assert.equal(journal.intentName, auditIntentFileName(result.operationId));
	assert.equal(journal.intentHash, hashFile(intentPath(root, result.operationId)));
	assert.equal(journal.after.hash, hashFile(recordPath(root, "exp-a")), "after.hash 必须等于提交后记录的真实字节");
	assert.equal(journal.before.hash, before, "before.hash 必须等于提交前记录的真实字节");
	assert.equal(journal.state, "committed");
	assert.equal(journal.source, "writer-confirmed");

	// 临时文件与锁都要清干净。
	assert.deepEqual(lockEntries(root), []);
	assert.deepEqual(tempLeftovers(root, "experiences"), []);
	assert.deepEqual(tempLeftovers(root, "journal"), []);
	assert.deepEqual(tempLeftovers(root, "audit", "exp-a"), []);
	assert.deepEqual(tempLeftovers(root, "audit", "intents"), []);
});

test("C2B：动作 → 状态/reviewer 规则逐条对照（含被清除与保留的两种语义）", async () => {
	const cases = [
		{ action: "submit-review", from: "draft", to: "reviewed", reviewerBefore: undefined, reviewerAfter: undefined },
		{ action: "request-changes", from: "reviewed", to: "draft", reviewerBefore: "alice", reviewerAfter: undefined },
		{ action: "approve", from: "reviewed", to: "verified", reviewerBefore: undefined, reviewerAfter: "bob" },
		{ action: "deprecate", from: "reviewed", to: "deprecated", reviewerBefore: "alice", reviewerAfter: "alice" },
		{ action: "deprecate", from: "verified", to: "deprecated", reviewerBefore: "alice", reviewerAfter: "alice" },
		{ action: "restore", from: "deprecated", to: "draft", reviewerBefore: "alice", reviewerAfter: undefined },
	];
	for (const scenario of cases) {
		const root = await makeStoreRoot(`review-action-${scenario.action}-${scenario.from}`);
		await seedCard(root, { status: scenario.from, overrides: scenario.reviewerBefore === undefined ? {} : { reviewer: scenario.reviewerBefore } });
		const result = await recordReviewDecision(approval(root, { action: scenario.action, expectedRevision: 0 }));
		assert.equal(result.kind, "applied", `${scenario.action} 应当成功`);
		assert.equal(result.record.status, scenario.to, `${scenario.action}: ${scenario.from}→${scenario.to}`);
		assert.equal(result.record.reviewer, scenario.reviewerAfter, `${scenario.action} 的 reviewer 规则`);
		assert.equal(readJson(recordPath(root, "exp-a")).reviewer, scenario.reviewerAfter, "磁盘上的 reviewer 与返回值一致（undefined 必须真的不落盘）");
	}
});

test("C2B：同一目标可以连续审核，每次都留下一条独立事件（历史不被覆盖）", async () => {
	const root = await makeStoreRoot("review-chain");
	await seedCard(root, { status: "draft" });
	const submit = await recordReviewDecision(approval(root, { action: "submit-review", expectedRevision: 0, now: NOW + 10 }));
	const approve = await recordReviewDecision(approval(root, { expectedRevision: 1, now: NOW + 20 }));
	const deprecate = await recordReviewDecision(approval(root, { action: "deprecate", expectedRevision: 2, now: NOW + 30, operatorLabel: "carol" }));
	assert.deepEqual([submit.revision, approve.revision, deprecate.revision], [1, 2, 3]);
	const events = readdirSync(join(root, "audit", "exp-a")).sort();
	assert.equal(events.length, 3, "三条事件互不覆盖");
	assert.equal(readJson(recordPath(root, "exp-a")).status, "deprecated");
	assert.equal(readJson(recordPath(root, "exp-a")).reviewer, "bob", "deprecate 保留原审核人，不把废弃者冒充成审核人");
	// 每条 v2 都能被巡检识别为已收口。
	const inspect = await inspectPendingReviewOperations({ root });
	assert.equal(inspect.pending.length, 0);
	assert.equal(inspect.finalized.committed, 3);
});

/* ------------------------------------------------------------------ 提交前拒绝 */

test("C2B：无效动作/陈旧 revision/缺记录/越界证据下标 → 原字节不变、无新工件", async (t) => {
	const root = await makeStoreRoot("review-guards");
	await seedCard(root, { status: "reviewed" });
	const recordBefore = hashFile(recordPath(root, "exp-a"));
	const journalBefore = readdirSync(join(root, "journal")).length;

	await t.test("陈旧 revision → revision-conflict", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { expectedRevision: 7 })), expectStorageError("revision-conflict"));
	});
	await t.test("null revision 不接受", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { expectedRevision: null })), expectStorageError("revision-conflict"));
	});
	await t.test("动作与当前状态不匹配 → invalid-record", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { action: "submit-review" })), expectStorageError("invalid-record", "review-action-mismatch"));
	});
	await t.test("未知动作 → invalid-record", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { action: "rubber-stamp" })), expectStorageError("invalid-record", "unknown-review-action"));
	});
	await t.test("非法证据下标 → invalid-record", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { evidence: [{ kind: "record-evidence", index: 3 }] })), expectStorageError("invalid-record", "review-evidence-index"));
		await assert.rejects(recordReviewDecision(approval(root, { evidence: [{ kind: "record-validation", index: 1 }] })), expectStorageError("invalid-record", "review-evidence-index"));
	});
	await t.test("空标签/超长理由 → 入口拒绝", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { operatorLabel: "" })), expectStorageError("invalid-record", "invalid-operatorLabel"));
		await assert.rejects(recordReviewDecision(approval(root, { reason: "由".repeat(513) })), expectStorageError("invalid-record", "invalid-reason"));
	});
	await t.test("记录不存在 → not-found", async () => {
		await assert.rejects(recordReviewDecision(approval(root, { recordId: "exp-missing" })), expectStorageError("not-found"));
	});
	await t.test("知识库未初始化 → not-found（与普通写同一准入）", async () => {
		const raw = makeRawRoot("review-not-init");
		await assert.rejects(recordReviewDecision(approval(raw)), expectStorageError("not-found", "store-not-initialized"));
	});

	assert.equal(hashFile(recordPath(root, "exp-a")), recordBefore, "业务记录必须逐字节不变");
	assert.equal(readdirSync(join(root, "journal")).length, journalBefore, "不得新增 journal");
	assert.deepEqual(existsSync(join(root, "audit", "exp-a")) ? readdirSync(join(root, "audit", "exp-a")) : [], [], "不得产生审计事件");
	assert.deepEqual(existsSync(join(root, "audit", "intents")) ? readdirSync(join(root, "audit", "intents")) : [], [], "不得产生意图");
	assert.deepEqual(lockEntries(root), [], "失败的调用不得留下锁");
});

/* ------------------------------------------------------------------ 提交前失败/取消 */

test("C2B：意图发布失败 → 数据不提交、无 v2、无事件", async () => {
	const root = await makeStoreRoot("review-intent-fail");
	await seedCard(root, { status: "reviewed" });
	const before = hashFile(recordPath(root, "exp-a"));
	const journalBefore = readdirSync(join(root, "journal")).length;

	await assert.rejects(
		recordReviewDecision(
			approval(root, {
				ioHooks: {
					// journal 的 prepared 也必须走真实 link，本用例只让**意图**发布失败。
					link: async (existingPath, newPath) => {
						if (newPath.includes(`${sep}audit${sep}intents${sep}`)) throw Object.assign(new Error("注入：意图发布失败"), { code: "ENOSPC" });
						const { link } = await import("node:fs/promises");
						return await link(existingPath, newPath);
					},
				},
			}),
		),
		expectStorageError("permission-denied"),
	);

	assert.equal(hashFile(recordPath(root, "exp-a")), before);
	assert.equal(readdirSync(join(root, "journal")).length, journalBefore, "不得新增 v2");
	assert.equal(existsSync(join(root, "audit", "exp-a")), false, "不得产生事件目录");
	assert.deepEqual(lockEntries(root), []);
});

test("C2B：v2 prepared 发布失败 → 孤立意图保留、记录不变、无事件、无待核对候选", async () => {
	const root = await makeStoreRoot("review-prepared-fail");
	await seedCard(root, { status: "reviewed" });
	const before = hashFile(recordPath(root, "exp-a"));
	const journalBefore = readdirSync(join(root, "journal")).length;

	await assert.rejects(
		recordReviewDecision(
			approval(root, {
				ioHooks: {
					link: async (existingPath, newPath) => {
						if (newPath.includes(`${sep}journal${sep}`)) throw Object.assign(new Error("注入：v2 发布失败"), { code: "ENOSPC" });
						const { link } = await import("node:fs/promises");
						return await link(existingPath, newPath);
					},
				},
			}),
		),
		expectStorageError("permission-denied"),
	);

	assert.equal(hashFile(recordPath(root, "exp-a")), before, "业务记录不变");
	assert.equal(readdirSync(join(root, "journal")).length, journalBefore, "没有 v2 文件");
	assert.equal(readdirSync(join(root, "audit", "intents")).length, 1, "孤立意图必须保留（不得自动删除未知工件）");
	assert.equal(existsSync(join(root, "audit", "exp-a")), false, "不得产生事件");
	// 巡检只扫 journal：孤立意图不会成为候选（已知限制，见实施记录）。
	const inspect = await inspectPendingReviewOperations({ root });
	assert.equal(inspect.pending.length, 0);
	assert.deepEqual(lockEntries(root), []);
});

test("C2B：记录提交失败 → 原错误保留、v2 记 aborted、无事件、业务不变", async () => {
	const root = await makeStoreRoot("review-rename-fail");
	await seedCard(root, { status: "reviewed" });
	const before = hashFile(recordPath(root, "exp-a"));

	await assert.rejects(
		recordReviewDecision(approval(root, { ioHooks: { beforeIo: (operation, target) => (operation === "rename" && isPathIn(root, `${sep}experiences${sep}`)(target) ? Promise.reject(Object.assign(new Error("注入：记录替换失败"), { code: "EACCES" })) : undefined) } })),
		expectStorageError("permission-denied"),
	);

	assert.equal(hashFile(recordPath(root, "exp-a")), before);
	const names = readdirSync(join(root, "journal"));
	const reviewJournals = names.map((name) => readJson(join(root, "journal", name))).filter((record) => record.journalVersion === 2);
	assert.equal(reviewJournals.length, 1);
	assert.equal(reviewJournals[0].state, "aborted", "提交前失败必须尽力记 aborted");
	assert.equal(reviewJournals[0].source, "writer-confirmed");
	assert.equal(existsSync(join(root, "audit", "exp-a")), false, "未提交不得有事件");
	assert.deepEqual(lockEntries(root), []);
});

test("C2B：提交前取消 → cancelled 穿透；记账也写不进去时留下 prepared（可核对收口）", async () => {
	const root = await makeStoreRoot("review-cancel-before");
	await seedCard(root, { status: "reviewed" });
	const before = hashFile(recordPath(root, "exp-a"));
	const controller = new AbortController();

	await assert.rejects(
		recordReviewDecision(
			approval(root, {
				signal: controller.signal,
				ioHooks: {
					beforeIo: (operation, target) => {
						// 在记录替换发起之前取消：这是"提交前取消"的确定性复现点。
						if (operation === "rename" && isPathIn(root, `${sep}experiences${sep}`)(target)) controller.abort();
						return undefined;
					},
				},
			}),
		),
		expectStorageError("cancelled"),
	);

	assert.equal(hashFile(recordPath(root, "exp-a")), before, "取消不得改动业务记录");
	assert.equal(existsSync(join(root, "audit", "exp-a")), false, "提交前取消不得有事件");
	const reviewJournals = readdirSync(join(root, "journal"))
		.map((name) => readJson(join(root, "journal", name)))
		.filter((record) => record.journalVersion === 2);
	assert.equal(reviewJournals.length, 1);
	assert.equal(reviewJournals[0].state, "prepared", "取消时记账写不进去，留下 prepared 而不是假称 aborted");
	// 留下 prepared 不是缺陷：新进程核对后能确定结论（目标仍是 before ⇒ 未提交）。
	const recon = await reconcileReviewOperation({ root, operationId: reviewJournals[0].operationId, now: LATER + 10 });
	assert.equal(recon.outcome, "aborted");
	assert.equal(recon.changed, true);
	assert.equal(recon.audit, null, "未提交的操作不产生审计事件");
	assert.equal(
		readdirSync(join(root, "journal")).some((name) => readJson(join(root, "journal", name)).state === "aborted"),
		true,
	);
});

/* ------------------------------------------------------------------ 提交后失败 */

test("C2B：事件发布失败 → applied-audit-pending（audit 为 null，不预支发布事实）", async () => {
	const root = await makeStoreRoot("review-event-fail");
	await seedCard(root, { status: "reviewed" });

	const result = await recordReviewDecision(
		approval(root, {
			ioHooks: {
				link: async (existingPath, newPath) => {
					if (newPath.includes(`${sep}audit${sep}exp-a${sep}`)) throw Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" });
					const { link } = await import("node:fs/promises");
					return await link(existingPath, newPath);
				},
			},
		}),
	);

	assert.equal(result.kind, "applied-audit-pending", "已提交但审计待补，绝不能报「未提交」");
	assert.equal(result.audit, null, "审计未发布时不得提供 publication/recordedAt");
	assert.equal(result.journal.state, "prepared");
	assert.equal(result.revision, 1);
	assert.ok((result.warnings ?? []).length > 0, "必须给出可行动的有界警告");
	assert.equal(readJson(recordPath(root, "exp-a")).status, "verified", "业务确实已提交");
	// 事件目录可能已被创建（发布前会 ensureDirectory），但**不允许有任何事件文件**。
	assert.deepEqual(existsSync(join(root, "audit", "exp-a")) ? readdirSync(join(root, "audit", "exp-a")) : [], []);
	assert.deepEqual(lockEntries(root), []);

	// 新进程核对：先补事件（recovery），再写完成终态；**不重放记录、不递增 revision**。
	const recon = await reconcileReviewOperation({ root, operationId: result.operationId, now: LATER + 100 });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.changed, true);
	assert.equal(recon.audit?.publication, "recovery");
	assert.equal(recon.audit?.recordedAt, LATER + 100);
	assert.equal(readJson(recordPath(root, "exp-a")).revision, 1, "恢复不得再递增 revision");
	assert.equal(readJson(journalPath(root, result.operationId)).state, "committed");
	assert.equal(isValidAuditEvent(readJson(eventPath(root, "exp-a", result.eventId))), true);
});

test("C2B：终态写入失败 → applied-journal-pending，且事件事实照实上报", async () => {
	const root = await makeStoreRoot("review-terminal-fail");
	await seedCard(root, { status: "reviewed" });

	const result = await recordReviewDecision(
		approval(root, {
			ioHooks: {
				beforeIo: (operation, target) => {
					// journal 的终态写入走 rename：注入失败点必须只命中 journal 路径。
					if (operation === "rename" && isPathIn(root, `${sep}journal${sep}`)(target)) return Promise.reject(Object.assign(new Error("注入：终态写入失败"), { code: "EACCES" }));
					return undefined;
				},
			},
		}),
	);

	assert.equal(result.kind, "applied-journal-pending");
	assert.equal(result.audit?.publication, "writer");
	assert.equal(result.audit?.recordedAt, LATER);
	assert.equal(result.journal.state, "prepared");
	assert.equal(readJson(journalPath(root, result.operationId)).state, "prepared");
	// 核对时事件已存在且决定一致 ⇒ 认领（保留 writer 与原时间），不重复发布。
	const recon = await reconcileReviewOperation({ root, operationId: result.operationId, now: LATER + 100 });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.audit?.publication, "writer", "认领已有 writer 事件不得改写成 recovery");
	assert.equal(recon.audit?.recordedAt, LATER, "发布事实必须保留原值，不重打时间");
	assert.equal(readdirSync(join(root, "audit", "exp-a")).length, 1, "不得重复发布事件");
});

test("C2B：提交后迟到取消 → 仍报 applied-audit-pending，不否认已提交的事实", async () => {
	const root = await makeStoreRoot("review-cancel-after");
	await seedCard(root, { status: "reviewed" });
	const controller = new AbortController();

	const result = await recordReviewDecision(
		approval(root, {
			signal: controller.signal,
			ioHooks: {
				beforeIo: (operation, target) => {
					// 事件发布（link）是**提交点之后**的第一次 IO：在这里取消正好复现"迟到取消"。
					if (operation === "link" && isPathIn(root, `${sep}audit${sep}exp-a${sep}`)(target)) controller.abort();
					return undefined;
				},
			},
		}),
	);

	assert.equal(result.kind, "applied-audit-pending", "迟到取消不能把已提交说成失败");
	assert.equal(result.audit, null);
	assert.equal(readJson(recordPath(root, "exp-a")).revision, 1);
	assert.ok(
		(result.warnings ?? []).some((warning) => warning.includes("取消")),
		`警告应说明取消发生在提交之后：${JSON.stringify(result.warnings ?? [])}`,
	);
});

/* ------------------------------------------------------------------ 幂等与冲突（工件层） */

test("C2B：意图撞名 —— 同字节幂等认领，不同字节 audit-conflict（绝不覆盖）", async () => {
	const root = await makeStoreRoot("review-intent-collision");
	await seedCard(root, { status: "reviewed" });
	const boundary = await createStorageBoundary({ root });
	const intent = {
		intentVersion: 1,
		purpose: "review",
		eventId: "5a7c9e11-2b3d-4f60-8a91-0c2e4d6b8f13",
		operationId: "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90",
		target: { kind: "experience-card", recordId: "exp-a" },
		action: "approve",
		fromStatus: "reviewed",
		toStatus: "verified",
		operatorLabel: "bob",
		decidedAt: LATER,
		reason: "第一次决定",
		before: { revision: 0, hash: "a".repeat(64) },
		after: { revision: 1, hash: "b".repeat(64) },
		evidence: [],
	};

	const first = await publishReviewIntentArtifact(boundary, intent);
	assert.equal(first.status, "created");
	const again = await publishReviewIntentArtifact(boundary, intent);
	assert.equal(again.status, "exists-identical", "同 operationId 同真实字节 = 幂等");
	assert.equal(again.hash, first.hash);
	assert.equal(hashFile(intentPath(root, intent.operationId)), first.hash);

	// 同 operationId 但决定不同：字节不同 ⇒ 冲突，且**不覆盖**原文件。
	await assert.rejects(publishReviewIntentArtifact(boundary, { ...intent, reason: "另一次决定" }), expectStorageError("audit-conflict", "review-intent-conflict"));
	assert.equal(hashFile(intentPath(root, intent.operationId)), first.hash, "冲突时原字节必须保持不变");
});

/**
 * I1（第十四轮 §3）：意图**撞名之后的复读被取消**时，本次已经发生的清理失败不能消失。
 *
 * 与事件路径（F2）同一要求：取消仍然穿透（没有发布任何新事实，不能改写成别的结论），
 * 但"这次调用确实留下了一个 `.tmp`"必须随错误一起出来。判据是**本次调用**的
 * `published.cleanup === "failed"`，不是"目录里有没有历史残留"。
 * 三个对照分别保证：清理成功时不误报、不取消时结论不变、读不懂的已有意图仍按硬规则拒绝覆盖。
 */
test("I1：意图撞名后复读被取消 —— cancelled 穿透但保留本次 intent 清理诊断", async (t) => {
	const intent = {
		intentVersion: 1,
		purpose: "review",
		eventId: "5a7c9e11-2b3d-4f60-8a91-0c2e4d6b8f13",
		operationId: "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90",
		target: { kind: "experience-card", recordId: "exp-a" },
		action: "approve",
		fromStatus: "reviewed",
		toStatus: "verified",
		operatorLabel: "bob",
		decidedAt: LATER,
		reason: "第一次决定",
		before: { revision: 0, hash: "a".repeat(64) },
		after: { revision: 1, hash: "b".repeat(64) },
		evidence: [],
	};

	/** 发布一份合法意图，并返回现场基线（每个对照各自独立断言"原文件没有被改动"）。 */
	async function seedIntent(name) {
		const root = await makeStoreRoot(name);
		await seedCard(root, { status: "reviewed" });
		await publishReviewIntentArtifact(await createStorageBoundary({ root }), intent);
		return {
			root,
			intentBytes: hashFile(intentPath(root, intent.operationId)),
			recordBytes: hashFile(recordPath(root, "exp-a")),
			journalCount: existsSync(join(root, "journal")) ? readdirSync(join(root, "journal")).length : 0,
			temps: tempLeftovers(root, "audit", "intents").length,
		};
	}

	/** 只让 `audit/intents/` 下的 `unlink-temp` 失败：本次发布的临时文件真的留在磁盘上。 */
	const failIntentUnlink = (root) => ({
		beforeIo: (operation, target) => (operation === "unlink-temp" && typeof target === "string" && target.includes(`${sep}audit${sep}intents${sep}`) ? Promise.reject(Object.assign(new Error("注入：意图清理失败"), { code: "EACCES" })) : undefined),
	});

	await t.test("清理失败 + 复读取消 → cancelled 且带 intent 诊断、新增 1 个 .tmp", async () => {
		const site = await seedIntent("i1-intent-exists-cancel");
		const controller = new AbortController();
		const hooked = await createStorageBoundary({
			root: site.root,
			ioHooks: {
				beforeIo: (operation, target) => {
					const cleanupInjection = failIntentUnlink(site.root).beforeIo(operation, target);
					if (cleanupInjection !== undefined) return cleanupInjection;
					// 复读**已有**意图的 IO 等待点取消：此时本次临时文件的清理失败已经发生。
					if (operation === "read" && typeof target === "string" && target.includes(`${sep}audit${sep}intents${sep}`)) controller.abort();
					return undefined;
				},
			},
		});

		let failure;
		try {
			await publishReviewIntentArtifact(hooked, intent, controller.signal);
		} catch (error) {
			failure = error;
		}

		assert.ok(failure instanceof StorageError, `必须是结构化错误：${String(failure)}`);
		assert.equal(failure.code, "cancelled", "取消仍然穿透（不得被改写成别的结论）");
		assert.ok(failure.message.includes("审核工件的临时文件清理失败"), `取消错误必须保留清理诊断：${failure.message}`);
		assert.ok(failure.message.includes("audit/intents/"), `诊断必须指向受控路径：${failure.message}`);
		assert.equal(tempLeftovers(site.root, "audit", "intents").length, site.temps + 1, "本次必须正好新增一个 .tmp");
		assert.equal(hashFile(intentPath(site.root, intent.operationId)), site.intentBytes, "原意图字节不变（不覆盖）");
		assert.equal(hashFile(recordPath(site.root, "exp-a")), site.recordBytes, "业务字节不变");
		assert.equal(existsSync(join(site.root, "journal")) ? readdirSync(join(site.root, "journal")).length : 0, site.journalCount, "不得新增 journal");
		assert.deepEqual(existsSync(join(site.root, "audit", "exp-a")) ? readdirSync(join(site.root, "audit", "exp-a")) : [], [], "不得发布事件");
	});

	await t.test("对照：清理成功 + 复读取消 → 不误报、不新增 .tmp", async () => {
		const site = await seedIntent("i1-intent-exists-cancel-clean");
		const controller = new AbortController();
		const hooked = await createStorageBoundary({
			root: site.root,
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "read" && typeof target === "string" && target.includes(`${sep}audit${sep}intents${sep}`)) controller.abort();
					return undefined;
				},
			},
		});

		let failure;
		try {
			await publishReviewIntentArtifact(hooked, intent, controller.signal);
		} catch (error) {
			failure = error;
		}

		assert.ok(failure instanceof StorageError);
		assert.equal(failure.code, "cancelled");
		assert.equal(failure.message.includes("审核工件的临时文件清理失败"), false, `清理成功时不得误报残留：${failure.message}`);
		assert.equal(tempLeftovers(site.root, "audit", "intents").length, site.temps, "不得凭空多出 .tmp");
	});

	await t.test("对照：清理失败 + 不取消 → 仍 exists-identical 且如实报 cleanup", async () => {
		const site = await seedIntent("i1-intent-exists-identical");
		const hooked = await createStorageBoundary({ root: site.root, ioHooks: failIntentUnlink(site.root) });

		const again = await publishReviewIntentArtifact(hooked, intent);
		assert.equal(again.status, "exists-identical", "同 operationId 同真实字节 = 幂等认领");
		assert.equal(again.cleanup, "failed", "本次临时文件清理失败必须如实报出");
		assert.equal(tempLeftovers(site.root, "audit", "intents").length, site.temps + 1);
		assert.equal(hashFile(intentPath(site.root, intent.operationId)), site.intentBytes);
	});

	await t.test("对照：已有意图是坏文件 → audit-conflict 保留原字节并带清理诊断", async () => {
		const site = await seedIntent("i1-intent-corrupt");
		writeFileSync(intentPath(site.root, intent.operationId), "{ 坏掉的意图\n", "utf8");
		const corruptBytes = hashFile(intentPath(site.root, intent.operationId));
		const hooked = await createStorageBoundary({ root: site.root, ioHooks: failIntentUnlink(site.root) });

		let failure;
		try {
			await publishReviewIntentArtifact(hooked, intent);
		} catch (error) {
			failure = error;
		}

		assert.ok(failure instanceof StorageError);
		assert.equal(failure.code, "audit-conflict", "读不懂的已有意图仍按既有硬规则拒绝覆盖");
		assert.ok(failure.message.includes("审核工件的临时文件清理失败"), `冲突错误也要带清理诊断：${failure.message}`);
		assert.equal(hashFile(intentPath(site.root, intent.operationId)), corruptBytes, "坏文件原字节必须保留");
	});
});

test("C2B：事件工件的非覆盖语义 —— 同 eventId 不同决定一律拒绝覆盖", async () => {
	const root = await makeStoreRoot("review-event-nonoverwrite");
	await seedCard(root, { status: "reviewed" });
	const first = await recordReviewDecision(approval(root));
	const originalBytes = readFileSync(eventPath(root, "exp-a", first.eventId), "utf8");

	// 同 eventId、同目标，但**理由不同**：这是"同一个事件身份、两次决定"的典型形态。
	const clashing = { ...readJson(eventPath(root, "exp-a", first.eventId)), reason: "另一次决定" };
	// 结构先过一遍：非法结构直接拒绝（不能把"写坏一个文件"当成冲突处理）。
	await assert.rejects(publishReviewEventArtifact(await createStorageBoundary({ root }), { ...clashing, target: { kind: "unknown", recordId: "exp-a" } }), expectStorageError("invalid-record", "invalid-audit-event"));
	// 结构合法但字节不同：工件层只报"已存在"，是否认领由纯比较裁决（见 reconcile 用例）。
	const outcome = await publishReviewEventArtifact(await createStorageBoundary({ root }), clashing);
	assert.equal(outcome.status, "exists", "已有事件不得被覆盖");
	assert.equal(readFileSync(eventPath(root, "exp-a", first.eventId), "utf8"), originalBytes, "原事件字节必须逐字节不变");
});

/* ------------------------------------------------------------------ 锁与普通写 */

test("C2B：目标锁被他人持有时 → lock-timeout；不抢锁、不改文件", async () => {
	const root = await makeStoreRoot("review-lock-busy");
	await seedCard(root, { status: "reviewed" });
	const boundary = await createStorageBoundary({ root });
	const foreign = await acquireStorageLock(boundary, { target: recordPath(root, "exp-a"), timeoutMs: 0, now: NOW });
	const before = hashFile(recordPath(root, "exp-a"));
	try {
		await assert.rejects(recordReviewDecision(approval(root, { lockTimeoutMs: 0, lockPollMs: 10 })), expectStorageError("lock-timeout"));
	} finally {
		await foreign.release();
	}
	assert.equal(hashFile(recordPath(root, "exp-a")), before);
	assert.equal(existsSync(join(root, "audit", "intents")), false, "拿不到锁就不该产生任何审核工件");
});

test("C2B：锁释放失败 → 结论仍然有效，但必须带上有界警告", async () => {
	const root = await makeStoreRoot("review-lock-release-fail");
	await seedCard(root, { status: "reviewed" });
	const result = await recordReviewDecision(
		approval(root, {
			ioHooks: {
				beforeIo: (operation) => (operation === "lock-remove" ? Promise.reject(Object.assign(new Error("注入：锁清理失败"), { code: "EACCES" })) : undefined),
			},
		}),
	);
	assert.equal(result.kind, "applied");
	assert.equal(result.lockRelease, "failed");
	assert.ok(
		(result.warnings ?? []).some((warning) => warning.includes("锁未正常释放")),
		`应给出锁残留警告：${JSON.stringify(result.warnings ?? [])}`,
	);
	assert.equal(lockEntries(root).length, 1, "残留锁保留现场，等人工确认");
	// 残留锁的真实后果：此后同一目标的写入会超时（不抢锁、不自动回收）。
	await assert.rejects(recordReviewDecision(approval(root, { expectedRevision: 0, lockTimeoutMs: 0, lockPollMs: 10 })), expectStorageError("lock-timeout"));
	// 已收口的操作核对是幂等的，不会被残留锁挡住（它不需要再改任何东西）。
	const recon = await reconcileReviewOperation({ root, operationId: result.operationId });
	assert.equal(recon.outcome, "committed");
	assert.equal(recon.changed, false);
});

test("C2B：普通写仍只产生 v1 journal；旧 v1 校验器拒绝 v2；审核入口不改普通写行为", async () => {
	const root = await makeStoreRoot("review-v1-untouched");
	await seedCard(root, { status: "draft" });
	const reviewed = await recordReviewDecision(approval(root, { action: "submit-review", expectedRevision: 0 }));
	const updated = await updateRecord({ root, kind: "experience-card", id: "exp-a", data: experienceBody("v1", { status: "reviewed" }), expectedRevision: 1, now: LATER + 1 });

	const v1 = readJson(journalPath(root, updated.journal.operationId));
	assert.equal(v1.journalVersion, 1, "普通写继续用 v1");
	assert.equal(v1.source, "writer-confirmed");
	assert.equal(updated.journal.state, "committed");
	// v1 校验器（含旧 C1 恢复器读到的第一道闸门）必须拒绝 v2。
	const { validateJournalRecord } = await import("../core/storage/journal/contract.ts");
	const v2 = readJson(journalPath(root, reviewed.operationId));
	const rejected = validateJournalRecord(v2, `${reviewed.operationId}.json`);
	assert.equal(rejected.ok, false);
	// v2 会同时触发"未知字段"与"版本不是 1"两条问题；**必须包含**版本拒绝这一条，
	// 不能因为先报了未知字段就被当成"只是多了几个键"。
	assert.ok(
		rejected.issues.some((issue) => issue.code === "unsupported-journal-version"),
		`旧 v1 解释不得接收审核 v2：${JSON.stringify(rejected.issues)}`,
	);
	// 反之，审核入口拿到普通 v1 journal 时明确报"不是审核 journal"，不按 v1 收口。
	const recon = await reconcileReviewOperation({ root, operationId: updated.journal.operationId });
	assert.equal(recon.outcome, "not-review");
	assert.equal(recon.changed, false);
	// 巡检把两类写入分清楚。
	const inspect = await inspectPendingReviewOperations({ root });
	assert.equal(inspect.ordinaryJournalEntries, 2, "createRecord 与 updateRecord 各一条 v1");
	assert.equal(inspect.finalized.committed, 1, "只有审核那条是 v2 已收口");
	assert.equal(inspect.problems.length, 0);
});

/* ------------------------------------------------------------------ R4：工件清理诊断 */

/** 让某个目录下的 `unlink-temp` 全部失败：清理失败必须**逐件**可见，而不是被 cleanup:ok 吞掉。 */
function failUnlinkTempIn(root, marker) {
	return {
		beforeIo: (operation, target) => (operation === "unlink-temp" && typeof target === "string" && target.startsWith(root) && target.includes(marker) ? Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EACCES" })) : undefined),
	};
}

test("R4：意图/事件/journal 的临时文件清理失败必须逐件可见（业务 cleanup 不能代表工件）", async (t) => {
	const cases = [
		["审核意图", { marker: `${sep}audit${sep}intents${sep}`, artifact: "intent", dir: ["audit", "intents"] }],
		["审计事件", { marker: `${sep}audit${sep}exp-a${sep}`, artifact: "event", dir: ["audit", "exp-a"] }],
		["审核 journal", { marker: `${sep}journal${sep}`, artifact: "review-journal", dir: ["journal"] }],
	];
	for (const [label, scenario] of cases) {
		await t.test(label, async () => {
			const root = await makeStoreRoot(`r4-cleanup-${scenario.artifact}`);
			await seedCard(root, { status: "reviewed" });

			const result = await recordReviewDecision(approval(root, { ioHooks: failUnlinkTempIn(root, scenario.marker) }));

			assert.equal(result.kind, "applied", "清理失败不影响提交结论");
			assert.equal(result.cleanup, "ok", "业务提交的 cleanup 仍然只表示业务文件");
			assert.ok(
				result.artifactCleanup.some((entry) => entry.artifact === scenario.artifact),
				`artifactCleanup 必须含 ${scenario.artifact}：${JSON.stringify(result.artifactCleanup)}`,
			);
			assert.ok(
				(result.warnings ?? []).some((warning) => warning.includes("清理失败")),
				`warnings 必须说明工件残留：${JSON.stringify(result.warnings ?? [])}`,
			);
			assert.ok(tempLeftovers(root, ...scenario.dir).length >= 1, `磁盘上必须真的留下 .tmp：${JSON.stringify(tempLeftovers(root, ...scenario.dir))}`);
		});
	}
});

test("R4：提交前抛错也传播已经发生的工件残留（原错误码不变）", async () => {
	const root = await makeStoreRoot("r4-cleanup-precommit");
	await seedCard(root, { status: "reviewed" });
	const recordBytes = hashFile(recordPath(root, "exp-a"));

	let failure;
	try {
		await recordReviewDecision(
			approval(root, {
				ioHooks: {
					beforeIo: (operation, target) => {
						if (operation === "rename" && isPathIn(root, `${sep}experiences${sep}`)(target)) return Promise.reject(Object.assign(new Error("注入：记录替换失败"), { code: "EACCES" }));
						if (operation === "unlink-temp" && typeof target === "string" && target.includes(`${sep}journal${sep}`)) return Promise.reject(Object.assign(new Error("注入：清理失败"), { code: "EACCES" }));
						return undefined;
					},
				},
			}),
		);
	} catch (error) {
		failure = error;
	}

	assert.ok(failure instanceof StorageError, `必须抛出结构化错误：${String(failure)}`);
	assert.equal(failure.code, "permission-denied", "原错误码不得被清理诊断替换");
	assert.ok(failure.message.includes("审核工件的临时文件清理失败"), `错误消息应带上工件残留诊断：${failure.message}`);
	assert.ok(tempLeftovers(root, "journal").length >= 1, "残留必须真的在磁盘上");
	assert.equal(hashFile(recordPath(root, "exp-a")), recordBytes, "业务记录必须逐字节不变");
});

test("R4：事件发布失败 + 业务清理失败 → 业务诊断如实上报、工件残留不误报，且现场仍可收口", async () => {
	const root = await makeStoreRoot("r4-double-cleanup");
	await seedCard(root, { status: "reviewed" });

	const result = await recordReviewDecision(
		approval(root, {
			ioHooks: {
				beforeIo: (operation, target) => {
					if (operation === "link" && isPathIn(root, `${sep}audit${sep}exp-a${sep}`)(target)) return Promise.reject(Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" }));
					if (operation === "unlink-temp" && isPathIn(root, `${sep}experiences${sep}`)(target)) return Promise.reject(Object.assign(new Error("注入：业务清理失败"), { code: "EACCES" }));
					return undefined;
				},
			},
		}),
	);

	assert.equal(result.kind, "applied-audit-pending");
	assert.equal(result.cleanup, "failed", "业务临时文件清理失败必须如实上报");
	assert.ok(
		(result.warnings ?? []).some((warning) => warning.includes("清理失败")),
		`warnings 应包含业务清理失败：${JSON.stringify(result.warnings ?? [])}`,
	);
	// 工件的诊断必须与磁盘对应：事件发布失败路径把自己那份临时文件清干净了，
	// 因此**不得**凭空报告一条"事件残留"（否则运维会去找一个不存在的文件）。
	assert.deepEqual(result.artifactCleanup, [], "没有工件残留就不能报告工件残留");
	assert.deepEqual(tempLeftovers(root, "audit", "exp-a"), [], "事件目录里确实没有 .tmp");
	// 业务记录的临时文件由 `rename` **改名成目标本身**，所以"清理失败"只表示"没能删掉那个名字"：
	// 磁盘上不会留下第二份文件（这与 `publishJsonMeasured` 的硬链接语义不同，不能一概而论）。
	assert.deepEqual(tempLeftovers(root, "experiences"), [], "replaceJson 成功后不存在额外的 .tmp");

	// 留下残留（或清理诊断）不影响真实结论：核对仍能收口（清理是运维动作，不是提交前置条件）。
	const recon = await reconcileReviewOperation({ root, operationId: result.operationId, now: LATER + 500 });
	assert.equal(recon.outcome, "committed");
	assert.equal(readJson(journalPath(root, result.operationId)).state, "committed");
});

/* ------------------------------------------------------------------ F2（C2BR2）：底层失败路径也要带上工件清理事实 */

/**
 * F2：`boundary.publishJsonMeasured` / `replaceJson` 在失败时附加的是**业务**清理文案
 * （`CLEANUP_FAILED_NOTE`），审核工件的提取器原先只认审核专用文案，于是"事件/意图目录里真的
 * 留了一个 `.tmp`"被整条丢掉。这里先把红：同一现场必须能报出 `artifactCleanup` 与有界诊断。
 */
test("F2：事件发布失败 + 事件临时文件删不掉 → artifactCleanup 必须带 event", async () => {
	const root = await makeStoreRoot("f2-writer-event-cleanup");
	await seedCard(root, { status: "reviewed" });

	const result = await recordReviewDecision(
		approval(root, {
			ioHooks: {
				// 发布失败走 `link`（与 `boundary` 的真实失败路径一致，会被映射成 StorageError）；
				// 清理失败走 `beforeIo("unlink-temp")`（`removeTempFile` 把它吞成 false）。
				link: async (existingPath, newPath) => {
					if (newPath.includes(`${sep}audit${sep}exp-a${sep}`)) throw Object.assign(new Error("注入：事件发布失败"), { code: "ENOSPC" });
					const { link } = await import("node:fs/promises");
					return await link(existingPath, newPath);
				},
				beforeIo: (operation, target) => (operation === "unlink-temp" && isPathIn(root, `${sep}audit${sep}exp-a${sep}`)(target) ? Promise.reject(Object.assign(new Error("注入：事件清理失败"), { code: "EACCES" })) : undefined),
			},
		}),
	);

	assert.equal(result.kind, "applied-audit-pending", "业务已提交、事件待补");
	assert.equal(result.cleanup, "ok", "业务临时文件本身没问题：不能拿它冒充工件状态");
	assert.ok(
		result.artifactCleanup.some((entry) => entry.artifact === "event"),
		`artifactCleanup 必须带 event：${JSON.stringify(result.artifactCleanup)}`,
	);
	assert.ok(
		(result.warnings ?? []).some((warning) => warning.includes("清理失败")),
		`warnings 必须带有界清理诊断：${JSON.stringify(result.warnings ?? [])}`,
	);
	assert.ok(tempLeftovers(root, "audit", "exp-a").length >= 1, "磁盘上必须真的有 .tmp");
});

test("F2：意图发布失败 + 意图临时文件删不掉 → 原错误码不变且带工件残留诊断", async () => {
	const root = await makeStoreRoot("f2-writer-intent-cleanup");
	await seedCard(root, { status: "reviewed" });

	let failure;
	try {
		await recordReviewDecision(
			approval(root, {
				ioHooks: {
					// 发布失败用 `link` 注入（与 `boundary` 的真实失败路径一致：会被映射成 StorageError）；
					// 清理失败用 `beforeIo("unlink-temp")`（`removeTempFile` 会把它吞成 false）。
					link: async (existingPath, newPath) => {
						if (newPath.includes(`${sep}audit${sep}intents${sep}`)) throw Object.assign(new Error("注入：意图发布失败"), { code: "ENOSPC" });
						const { link } = await import("node:fs/promises");
						return await link(existingPath, newPath);
					},
					beforeIo: (operation, target) => (operation === "unlink-temp" && isPathIn(root, `${sep}audit${sep}intents${sep}`)(target) ? Promise.reject(Object.assign(new Error("注入：意图清理失败"), { code: "EACCES" })) : undefined),
				},
			}),
		);
	} catch (error) {
		failure = error;
	}

	assert.ok(failure instanceof StorageError, `必须抛出结构化错误：${String(failure)}`);
	assert.equal(failure.code, "permission-denied", "原错误码优先，不被附加说明替换");
	assert.ok(failure.message.includes("审核工件的临时文件清理失败"), `错误消息必须带上工件残留诊断：${failure.message}`);
	assert.ok(tempLeftovers(root, "audit", "intents").length >= 1, "磁盘上必须真的有 .tmp");
	assert.equal(readJson(recordPath(root, "exp-a")).revision, 0, "提交点之前失败：业务必须未提交");
});

test("F2 对照：本次没有清理失败时 artifactCleanup 为空，且不删除历史残留", async () => {
	const root = await makeStoreRoot("f2-writer-no-cleanup-failure");
	await seedCard(root, { status: "reviewed" });
	// 先人为放一个历史残留（不是本次调用产生的），验证"不凭目录内容捏造本次失败"。
	mkdirSync(join(root, "audit", "exp-a"), { recursive: true });
	const leftover = join(root, "audit", "exp-a", ".old-artifact.json.1.deadbeef.tmp");
	writeFileSync(leftover, "old", "utf8");

	const result = await recordReviewDecision(approval(root));

	assert.equal(result.kind, "applied");
	assert.deepEqual(result.artifactCleanup, [], "本次没有清理失败：不得报任何工件残留");
	assert.ok(
		(result.warnings ?? []).every((warning) => !warning.includes("清理失败")),
		`没有清理失败就不该出现清理警告：${JSON.stringify(result.warnings ?? [])}`,
	);
	assert.equal(existsSync(leftover), true, "不得自动删除未知/历史文件");
});

test("C2B：记录与审核工件都在磁盘上可读回（不依赖内存状态）", async () => {
	const root = await makeStoreRoot("review-readback");
	await seedCard(root, { status: "reviewed" });
	const result = await recordReviewDecision(approval(root, { evidence: [{ kind: "record-validation", index: 0, note: "编译通过" }] }));
	const current = await readRecord({ root, kind: "experience-card", id: "exp-a" });
	assert.equal(current.record.revision, result.revision);
	assert.equal(current.record.status, "verified");
	const event = readJson(eventPath(root, "exp-a", result.eventId));
	assert.deepEqual(event.evidence, [{ kind: "record-validation", index: 0, note: "编译通过" }]);
	assert.equal(readJson(recordPath(root, "exp-a")).problem, "PXE 默认开启导致安装后仍尝试网络引导", "审核不得改动业务正文");
	assert.equal(OTHER_PROJECT_ID.length, 36, "fixture 常量参与断言，避免被误删");
});
