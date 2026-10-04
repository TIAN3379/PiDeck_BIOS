/**
 * BM-02C2BR（R1）的**永久回归**：审核 journal v2 的完整 schema 执行、审核工件的硬字节上限、
 * 以及审核入口对不可信 `evidence` 的结构化拒绝。
 *
 * 这一轮钉死的是第十二轮验收实测出来的四个缺口，它们都属于"看起来校验过了，其实没有"：
 *
 * 1. **v2 校验只跑了手工字段子集**：`eventId="not-a-uuid"`、`target.id="../other"`、
 *    `target.id="con"`、`before.unexpected=…` 当时全部返回 `ok=true`——完整 schema 定义了却没人执行。
 *    因此这里同时断言"运行时校验拒绝"与"同一份 TypeBox schema 也拒绝"（两者必须一致）。
 * 2. **revision 边界判反了**：`before = MAX_SAFE_INTEGER-1 / after = MAX_SAFE_INTEGER` 是一次合法递增，
 *    当时被当成"还需递增"拒绝；真正该拒绝的是 `before = MAX_SAFE_INTEGER`。
 * 3. **审核工件读取复用了可扩大的 `maxJournalBytes`**：配置 64 KiB 后，给合法意图前面加 17000 字节空白
 *    仍能读成功（实际 17 KiB+）。审核意图/事件是**独立类别**，必须有自己的 16 KiB 硬上限。
 * 4. **`evidence:[null]` 抛出裸 TypeError**：入口先把 `unknown` 强转成 `AuditEvidenceRef[]`，
 *    再在策略层解引用，于是"非法输入"变成"未结构化异常"。
 *
 * 所有诊断都**不得回显**外部字段名与值（`SECRET-…` 样例）：校验器本身不能成为泄漏通道。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { Value } from "typebox/value";
import { AUDIT_MAX_EVENT_BYTES } from "../core/contracts/index.ts";
import { createRecord, createStorageBoundary, initializeKnowledgeStore, publishReviewIntentArtifact, readReviewIntentArtifact, reconcileReviewOperation, recordReviewDecision, REVIEW_ARTIFACT_MAX_BYTES, ReviewJournalRecordSchema, StorageError, validateReviewJournalRecord } from "../core/storage/index.ts";

const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), "bios-review-contracts-")));
const NOW = 1_700_000_000_000;
const LATER = NOW + 60_000;
const SOURCE_PROJECT_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
/** 任何诊断里都不允许出现的样例值：校验器回显外部输入就等于泄漏客户资料。 */
const SECRET = "SECRET-CUSTOMER-VALUE";

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

function experienceBody(status = "reviewed") {
	return {
		problem: "PXE 默认开启",
		rootCause: "Setup 默认值未调整",
		solution: "改为 Disabled",
		appliesWhen: [],
		doesNotApplyWhen: [],
		sourceProjectId: SOURCE_PROJECT_ID,
		evidence: [],
		validations: [{ kind: "compile", scope: "Setup.c", result: "passed", performedAt: NOW, performedBy: "alice", evidence: [] }],
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

function journalPath(root, operationId) {
	return join(root, "journal", `${operationId}.json`);
}

function intentPath(root, operationId) {
	return join(root, "audit", "intents", `${operationId}.json`);
}

function eventPath(root, recordId, eventId) {
	return join(root, "audit", recordId, `${eventId}.json`);
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

function approval(root, overrides = {}) {
	return { root, recordId: "exp-a", expectedRevision: 0, action: "approve", operatorLabel: "bob", reason: "已比对现场日志", now: LATER, ...overrides };
}

function isStorageError(code, detailPart) {
	return (error) => {
		assert.ok(error instanceof StorageError, `应当是 StorageError（结构化拒绝），实际：${String(error)}`);
		assert.equal(error.code, code, `错误码应为 ${code}，实际 ${error.code}`);
		if (detailPart !== undefined) assert.ok((error.detail ?? "").includes(detailPart) || error.message.includes(detailPart), `诊断应包含 ${detailPart}：${error.detail ?? ""}`);
		return true;
	};
}

function reviewArtifactDirs(root) {
	const dirs = [join(root, "audit", "intents"), join(root, "audit", "exp-a")];
	return dirs.filter((dir) => existsSync(dir)).flatMap((dir) => readdirSync(dir).map((name) => join(dir, name)));
}

function lockEntries(root) {
	const dir = join(root, "locks");
	return existsSync(dir) ? readdirSync(dir) : [];
}

/* ------------------------------------------------------------------ R1：v2 完整 schema */

test("R1：v2 校验真正执行完整 schema —— 六类变体逐项拒绝，且与 TypeBox 判定一致", async () => {
	const root = await makeStoreRoot("v2-schema");
	await seedCard(root);
	const done = await recordReviewDecision(approval(root));
	assert.equal(done.kind, "applied");
	const fileName = `${done.operationId}.json`;
	const original = readJson(journalPath(root, done.operationId));

	// 先建立基线：真实产物同时通过运行时校验与同一份 schema。
	assert.equal(validateReviewJournalRecord(original, fileName).ok, true);
	assert.equal(Value.Check(ReviewJournalRecordSchema, original), true, "真实产物必须满足 v2 schema");

	const mutate = (change) => {
		const copy = structuredClone(original);
		change(copy);
		return copy;
	};
	const variants = [
		["eventId 不是 UUID", mutate((record) => (record.eventId = "not-a-uuid"))],
		["target.id 试图跳出根（../other）", mutate((record) => (record.target.id = "../other"))],
		["target.id 是 Windows 设备保留名（con）", mutate((record) => (record.target.id = "con"))],
		["before 里的未声明字段", mutate((record) => (record.before.unexpected = SECRET))],
		["target 里的未声明字段", mutate((record) => (record.target.extra = SECRET))],
		["根上的未声明字段", mutate((record) => (record[SECRET] = SECRET))],
	];

	for (const [label, value] of variants) {
		const outcome = validateReviewJournalRecord(value, fileName);
		assert.equal(outcome.ok, false, `${label}：必须被拒绝`);
		assert.ok(outcome.issues.length > 0, `${label}：必须给出结构化问题`);
		// schema 与运行时判定必须一致：同一份结构不能"schema 拒、运行时收"。
		assert.equal(Value.Check(ReviewJournalRecordSchema, value), false, `${label}：schema 也必须拒绝`);
		// 脱敏：诊断里不得出现外部字段名或值。
		const serialized = JSON.stringify(outcome.issues);
		assert.equal(serialized.includes(SECRET), false, `${label}：诊断不得回显外部值：${serialized}`);
		assert.equal(serialized.includes("unexpected") || serialized.includes("extra"), false, `${label}：诊断不得回显未知字段名：${serialized}`);
	}

	// 未知字段必须报成 unknown-field（调用方能据此区分"多了字段"与"类型错了"）。
	const unknownField = validateReviewJournalRecord(variants[5][1], fileName);
	assert.ok(
		unknownField.issues.some((issue) => issue.code === "unknown-field"),
		`根上的未声明字段应报 unknown-field：${JSON.stringify(unknownField.issues)}`,
	);
});

test("R1：revision 边界 —— after 可达 MAX_SAFE_INTEGER，before 到顶不允许再审核", async () => {
	const root = await makeStoreRoot("v2-revision");
	await seedCard(root);
	const done = await recordReviewDecision(approval(root));
	const fileName = `${done.operationId}.json`;
	const original = readJson(journalPath(root, done.operationId));
	const mutate = (change) => {
		const copy = structuredClone(original);
		change(copy);
		return copy;
	};

	const lastStep = mutate((record) => {
		record.before.revision = Number.MAX_SAFE_INTEGER - 1;
		record.after.revision = Number.MAX_SAFE_INTEGER;
	});
	assert.equal(validateReviewJournalRecord(lastStep, fileName).ok, true, "before=MAX-1 → after=MAX 是一次合法递增");

	const atCeiling = validateReviewJournalRecord(
		mutate((record) => {
			record.before.revision = Number.MAX_SAFE_INTEGER;
			record.after.revision = Number.MAX_SAFE_INTEGER;
		}),
		fileName,
	);
	assert.equal(atCeiling.ok, false, "before=MAX_SAFE_INTEGER 无法再递增，必须拒绝");
	assert.ok(
		atCeiling.issues.some((issue) => issue.code === "audit-revision-invalid"),
		`应报 audit-revision-invalid：${JSON.stringify(atCeiling.issues)}`,
	);

	const noStep = validateReviewJournalRecord(
		mutate((record) => {
			record.after.revision = record.before.revision;
		}),
		fileName,
	);
	assert.equal(noStep.ok, false, "after 必须恰好是 before + 1");

	// 运行时对应物：业务记录已到可表示上限时，审核入口必须拒绝而不是写出"加不动"的 after。
	const saturated = makeRawRoot("v2-revision-record");
	await initializeKnowledgeStore({ root: saturated });
	await seedCard(saturated, { status: "reviewed" });
	const record = readJson(recordPath(saturated));
	writeJson(recordPath(saturated), { ...record, revision: Number.MAX_SAFE_INTEGER });
	const recordBytes = hashFile(recordPath(saturated));
	await assert.rejects(recordReviewDecision(approval(saturated, { expectedRevision: Number.MAX_SAFE_INTEGER })), isStorageError("revision-conflict", "revision-overflow"));
	assert.equal(hashFile(recordPath(saturated)), recordBytes, "拒绝时不得改动业务记录");
	assert.deepEqual(reviewArtifactDirs(saturated), [], "拒绝时不得产生意图/事件工件（`audit/` 目录由初始化创建，这里看文件）");
	assert.deepEqual(lockEntries(saturated), []);
});

/* ------------------------------------------------------------------ R1：审核工件硬上限 */

test("R1：审核意图/事件是独立类别 —— 16 KiB 硬上限，配置只能收紧不能放大", async () => {
	const root = await makeStoreRoot("artifact-limit");
	await seedCard(root);
	// 配置一个**更大**的 journal 预算：审核工件不得因此获得更大的读取窗口。
	const generous = { maxJournalBytes: 64 * 1024 };
	const boundary = await createStorageBoundary({ root, limits: generous });

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
		reason: "硬上限",
		before: { revision: 0, hash: "a".repeat(64) },
		after: { revision: 1, hash: "b".repeat(64) },
		evidence: [],
	};
	const published = await publishReviewIntentArtifact(boundary, intent);
	assert.equal(published.status, "created");
	const body = readFileSync(intentPath(root, intent.operationId), "utf8");

	// 硬上限的文档值就是事件的兜底闸门（两者同为 16 KiB），这里把它钉成常量断言。
	assert.equal(REVIEW_ARTIFACT_MAX_BYTES, 16 * 1024);
	assert.equal(REVIEW_ARTIFACT_MAX_BYTES, AUDIT_MAX_EVENT_BYTES);

	/** 只加**空白**：解析出来的 JSON 完全相同，但实际磁盘字节变大（空白/转义计实际字节）。 */
	const padTo = (targetBytes) => " ".repeat(targetBytes - Buffer.byteLength(body, "utf8")) + body;

	// 精确边界：正好 16 KiB 可读，多 1 字节即拒绝。
	const exact = 16 * 1024;
	writeFileSync(intentPath(root, intent.operationId), padTo(exact), "utf8");
	assert.equal(statSync(intentPath(root, intent.operationId)).size, exact);
	const atLimit = await readReviewIntentArtifact(boundary, intent.operationId);
	assert.equal(atLimit.ok, true, "正好 16 KiB 必须可读（上限含端点）");

	writeFileSync(intentPath(root, intent.operationId), padTo(exact + 1), "utf8");
	const overLimit = await readReviewIntentArtifact(boundary, intent.operationId);
	assert.equal(overLimit.ok, false, "超过 16 KiB 必须拒绝（即使配置允许 64 KiB）");
	assert.equal(overLimit.missing, false, "超限是「读不懂」而不是「不存在」");
	assert.equal(overLimit.code, "too-large");

	// 空白放大：17000 字节前缀让文件到 17 KiB+，配置放大后当时仍被判 ok。
	writeFileSync(intentPath(root, intent.operationId), padTo(exact + 1000), "utf8");
	const amplified = await readReviewIntentArtifact(boundary, intent.operationId);
	assert.equal(amplified.ok, false, "空白放大不得绕过硬上限");

	// 同一个现场用默认配置读也一样拒绝（硬上限与配置无关）。
	const defaultBoundary = await createStorageBoundary({ root });
	assert.equal((await readReviewIntentArtifact(defaultBoundary, intent.operationId)).ok, false);

	// 配置可以**收紧**写入口：把预算压到 10 字节后连合法意图都不许发布。
	await assert.rejects(publishReviewIntentArtifact(await createStorageBoundary({ root, limits: { maxJournalBytes: 10 } }), intent), isStorageError("too-large"));
});

/* ------------------------------------------------------------------ R1：evidence 输入 */

test("R1：不可信 evidence 在解引用之前结构化拒绝 —— 不抛 TypeError、不取锁、不写工件", async () => {
	const root = await makeStoreRoot("evidence-input");
	await seedCard(root);
	const recordBefore = hashFile(recordPath(root));
	const badInputs = [
		["null 元素", [null]],
		["非数组", "record-evidence"],
		["空对象元素", [{}]],
		["未来 kind", [{ kind: "future-kind", index: 0 }]],
		["非法下标（负数）", [{ kind: "record-evidence", index: -1 }]],
		["非法下标（越界上限）", [{ kind: "record-evidence", index: 1_000_001 }]],
		["形态互斥（record-evidence 带 recordId）", [{ kind: "record-evidence", index: 0, recordId: "exp-b" }]],
		["external-reference 没有任何指向", [{ kind: "external-reference" }]],
		["混合非法元素", [{ kind: "record-validation", index: 0 }, null]],
	];

	for (const [label, evidence] of badInputs) {
		await assert.rejects(recordReviewDecision(approval(root, { evidence })), isStorageError("invalid-record"), `${label} 必须结构化拒绝`);
	}

	// 稀疏数组同样必须拒绝（洞会被当成 undefined 元素，不能"跳过就算通过"）。
	const sparse = [];
	sparse[1] = { kind: "record-evidence", index: 0 };
	await assert.rejects(recordReviewDecision(approval(root, { evidence: sparse })), isStorageError("invalid-record"));

	assert.equal(hashFile(recordPath(root)), recordBefore, "非法输入不得改动业务记录");
	assert.deepEqual(reviewArtifactDirs(root), [], "非法输入不得产生意图/事件工件");
	assert.deepEqual(lockEntries(root), [], "非法输入不得取锁");

	// 合法输入仍然工作（拒绝不能误伤正常形态）。
	const ok = await recordReviewDecision(approval(root, { evidence: [{ kind: "record-validation", index: 0, note: "编译通过" }] }));
	assert.equal(ok.kind, "applied");
});
