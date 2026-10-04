/**
 * BM-02C2AR 的**永久回归**：审核意图、journal v2 关联投影与幂等认领（纯比较，无 IO）。
 *
 * 这一轮要钉死的是第十轮 A2/A3 暴露的两条语义：
 * 1. **发布事实不是决定**：`publication` / `recordedAt` 属于"谁在何时把事件写下去"，
 *    同一次决定由 writer 还是 recovery 写出、写了多少次，都会让字节不同；
 *    因此幂等必须比**稳定决定字段**，并**认领**已有事件的原始发布事实，
 *    而不是比字节、也不是用恢复时间覆盖。
 * 2. **关联必须可证明**：不能靠"intent 文件存在"或"purpose=review"就认定这是审核操作；
 *    必须拿未来 journal v2 的投影与意图逐项对齐（operationId / eventId / 受控意图名 /
 *    实测意图字节指纹 / target / before / after），任何一项对不上都拒绝发布人工决定。
 *
 * 这些用例测的是**纯比较**，不代表崩溃恢复已经实现（本轮没有任何 IO）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	AUDIT_ASSOCIATION_COMPARED_FIELDS,
	AUDIT_EVIDENCE_MAX_ITEMS,
	AUDIT_INTENT_DECISION_FIELDS,
	AUDIT_JOURNAL_V2_VERSION,
	AUDIT_LABEL_MAX_CHARS,
	AUDIT_MAX_EVENT_BYTES,
	AUDIT_MAX_ISSUES,
	AUDIT_REASON_MAX_CHARS,
	auditIntentFileName,
	compareAuditAssociation,
	describeAuditIssues,
	isLegalAuditTransition,
	isValidAuditIntent,
	measureAuditEventBytes,
	readAuditIntentVersion,
	readJournalVersion,
	sanitizeAuditPath,
	utf8ByteLength,
	validateAuditIntent,
	validateAuditJournalProjection,
} from "../core/contracts/index.ts";

const EVENT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OTHER_EVENT_ID = "5a7c9e11-2b3d-4f60-8a91-0c2e4d6b8f13";
const OPERATION_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const HASH_BEFORE = "a".repeat(64);
const HASH_AFTER = "b".repeat(64);
/** 投影里声明的意图字节指纹（由未来写入方在持久意图时绑定）。 */
const INTENT_HASH = "c".repeat(64);
const NOW = 1_700_000_000_000;

function intentFixture(overrides = {}) {
	return {
		intentVersion: 1,
		purpose: "review",
		eventId: EVENT_ID,
		operationId: OPERATION_ID,
		target: { kind: "experience-card", recordId: "exp-audit-1" },
		action: "approve",
		fromStatus: "reviewed",
		toStatus: "verified",
		operatorLabel: "alice",
		decidedAt: NOW,
		reason: "人工比对现场日志后确认该修复步骤与客户选项一致",
		before: { revision: 0, hash: HASH_BEFORE },
		after: { revision: 1, hash: HASH_AFTER },
		evidence: [{ kind: "record-validation", index: 0 }],
		...overrides,
	};
}

function projectionFixture(intent = intentFixture(), overrides = {}) {
	return {
		journalVersion: AUDIT_JOURNAL_V2_VERSION,
		journalPurpose: "review",
		operationId: intent.operationId,
		eventId: intent.eventId,
		intentName: auditIntentFileName(intent.operationId),
		intentHash: INTENT_HASH,
		target: intent.target,
		before: intent.before,
		after: intent.after,
		...overrides,
	};
}

function eventFixture(intent = intentFixture(), overrides = {}) {
	return {
		auditVersion: 1,
		eventId: intent.eventId,
		operationId: intent.operationId,
		target: intent.target,
		action: intent.action,
		fromStatus: intent.fromStatus,
		toStatus: intent.toStatus,
		operatorLabel: intent.operatorLabel,
		decidedAt: intent.decidedAt,
		reason: intent.reason,
		before: intent.before,
		after: intent.after,
		evidence: intent.evidence,
		publication: "writer",
		recordedAt: intent.decidedAt + 500,
		...overrides,
	};
}

function associate(overrides = {}) {
	const intent = overrides.intent === undefined ? intentFixture() : overrides.intent;
	return compareAuditAssociation({
		intent,
		projection: overrides.projection === undefined ? projectionFixture(intent) : overrides.projection,
		existingEvent: overrides.existingEvent === undefined ? null : overrides.existingEvent,
		// 显式区分"没传"与"传了非法值"：`??` 会把 null/undefined 悄悄换成默认值，
		// 于是"非法指纹必须被拒绝"的用例会假通过。
		intentBytesHash: "intentBytesHash" in overrides ? overrides.intentBytesHash : INTENT_HASH,
	});
}

/**
 * 统一的失败断言。
 *
 * 注意两种结果形状不同：意图/投影校验返回 `{ ok:false, issues, droppedIssues }`（没有 `code`），
 * 关联判定额外给一个总结 `code`。这里读 `result.code ?? issues[0].code`，
 * 避免"用例因为读错字段而假通过/假失败"。
 */
function expectFailure(result, code, pathPart) {
	assert.equal(result.ok, false, `应当被拒绝，实际：${JSON.stringify(result)}`);
	const first = result.code ?? result.issues[0]?.code;
	assert.equal(first, code, `首个 code 应为 ${code}，实际：${JSON.stringify(result.issues)}`);
	const hit = result.issues.find((entry) => entry.code === code && (pathPart === undefined || entry.path === pathPart));
	assert.ok(hit, `缺少 ${code}${pathPart ? `（路径 ${pathPart}）` : ""}：${JSON.stringify(result.issues)}`);
	return hit;
}

/* ------------------------------------------------------------------ 1. 意图本身 */

test("C2AR：合法意图通过，且校验不修改输入", () => {
	const fixture = intentFixture();
	const snapshot = JSON.parse(JSON.stringify(fixture));
	Object.freeze(fixture);
	Object.freeze(fixture.target);
	Object.freeze(fixture.before);
	Object.freeze(fixture.after);
	Object.freeze(fixture.evidence);
	Object.freeze(fixture.evidence[0]);

	const result = validateAuditIntent(fixture);
	assert.equal(result.ok, true, `合法意图必须通过：${JSON.stringify(result)}`);
	assert.deepEqual(result.value, snapshot, "返回的是同一份决定内容");
	assert.equal(isValidAuditIntent(fixture), true);
	assert.deepEqual(fixture, snapshot, "输入不得被修改");
	// 意图**不携带**发布事实：校验通过不等于"已经发布过"。
	assert.equal(Object.hasOwn(result.value, "publication"), false);
	assert.equal(Object.hasOwn(result.value, "recordedAt"), false);
	assert.equal(readAuditIntentVersion(fixture), 1);
	assert.equal(readAuditIntentVersion({ intentVersion: 0 }), undefined);
});

test("C2AR：意图版本闸门先行，未知字段不回显名字", () => {
	expectFailure(validateAuditIntent({ ...intentFixture(), intentVersion: undefined }), "invalid-audit-intent-version", "/intentVersion");
	for (const bad of [0, 1.5, "1", Number.NaN]) {
		expectFailure(validateAuditIntent({ ...intentFixture(), intentVersion: bad }), "invalid-audit-intent-version", "/intentVersion");
	}
	// 未来版本：只报一条版本问题，不按当前版本猜字段。
	const future = validateAuditIntent({ intentVersion: 2 });
	assert.equal(future.ok, false);
	assert.equal(future.issues.length, 1);
	expectFailure(future, "unsupported-audit-intent-version", "/intentVersion");

	const extra = validateAuditIntent({ ...intentFixture(), evilCustomerKey: "SECRET-VALUE", targetPath: "/tmp/x.json" });
	expectFailure(extra, "unknown-field");
	const serialized = JSON.stringify(extra.issues);
	assert.ok(!serialized.includes("evilCustomerKey") && !serialized.includes("targetPath"), "诊断不得回显未知字段名");
	assert.ok(!serialized.includes("SECRET-VALUE"), "诊断不得回显未知字段的值");
});

test("C2AR：意图复用事件的动作/状态/指纹/证据/预算规则（同一套 code）", () => {
	expectFailure(validateAuditIntent(intentFixture({ fromStatus: "draft" })), "audit-action-mismatch", "/action");
	expectFailure(validateAuditIntent(intentFixture({ action: "rubber-stamp" })), "invalid-audit-intent");
	expectFailure(validateAuditIntent(intentFixture({ after: { revision: 3, hash: HASH_AFTER } })), "audit-revision-invalid", "/after/revision");
	expectFailure(validateAuditIntent(intentFixture({ operatorLabel: "汉".repeat(86) })), "audit-text-invalid", "/operatorLabel");
	expectFailure(validateAuditIntent(intentFixture({ reason: "由".repeat(342) })), "audit-text-invalid", "/reason");
	expectFailure(validateAuditIntent(intentFixture({ evidence: Array.from({ length: AUDIT_EVIDENCE_MAX_ITEMS + 1 }, () => ({ kind: "record-evidence", index: 0 })) })), "invalid-audit-intent");
	expectFailure(validateAuditIntent(intentFixture({ evidence: Array.from({ length: AUDIT_EVIDENCE_MAX_ITEMS }, () => ({ kind: "record-evidence", index: 0, note: "证".repeat(200) })) })), "audit-evidence-invalid", "/evidence");
	expectFailure(validateAuditIntent(intentFixture({ evidence: [{ kind: "external-reference", index: 0 }] })), "audit-evidence-invalid", "/evidence/0");
	// 合法边界照旧通过（不因"审核"而收紧）：动作表里每一对都能写进意图。
	for (const [action, from, to] of [
		["submit-review", "draft", "reviewed"],
		["approve", "reviewed", "verified"],
	]) {
		assert.equal(isLegalAuditTransition(action, from, to), true);
		assert.equal(validateAuditIntent(intentFixture({ action, fromStatus: from, toStatus: to })).ok, true);
	}
});

test("C2AR：意图字节上限与事件同量级，且是兜底闸门（分项预算先报错）", () => {
	const bytes = measureAuditEventBytes(intentFixture());
	assert.ok(typeof bytes === "number" && bytes > 0 && bytes <= AUDIT_MAX_EVENT_BYTES);
	// 保守上界（按各字段"最坏序列化膨胀"算）：信封 1 KiB + 标签 128×6 + 理由 512×6 + 证据 8 KiB。
	const conservative = 1024 + AUDIT_LABEL_MAX_CHARS * 6 + AUDIT_REASON_MAX_CHARS * 6 + AUDIT_EVIDENCE_MAX_ITEMS * 0 + 8 * 1024;
	assert.ok(conservative < AUDIT_MAX_EVENT_BYTES, `保守上界 ${conservative} 必须小于总量闸门 ${AUDIT_MAX_EVENT_BYTES}`);
	assert.equal(utf8ByteLength("汉"), 3, "字节口径按 UTF-8 计算，不按码元");
});

/* ------------------------------------------------------------------ 2. 关联投影 */

test("C2AR：投影版本闸门与受控派生名（旧恢复器必须拒绝 v2 与未知版本）", () => {
	const intent = intentFixture();
	assert.equal(validateAuditJournalProjection(projectionFixture(intent)).ok, true);
	assert.equal(readJournalVersion(projectionFixture(intent)), AUDIT_JOURNAL_V2_VERSION);
	assert.equal(readJournalVersion({ journalVersion: 1.5 }), undefined);

	// 普通 journal v1 不是审核投影：必须显式拒绝，不能被"当普通写收口"。
	expectFailure(validateAuditJournalProjection({ ...projectionFixture(intent), journalVersion: 1 }), "unsupported-journal-version", "/journalVersion");
	expectFailure(validateAuditJournalProjection({ ...projectionFixture(intent), journalVersion: 3 }), "unsupported-journal-version", "/journalVersion");
	const missingVersion = validateAuditJournalProjection({ journalPurpose: "review" });
	expectFailure(missingVersion, "invalid-audit-projection", "/journalVersion");
	// 意图文件名必须由 operationId 派生，不接受调用方指定路径。
	// （用长度合法的名字，才能真正走到"派生不一致"这条语义规则，而不是先被结构层拦住。）
	const elsewhere = `${"x".repeat(36)}.json`;
	assert.equal(elsewhere.length, 41);
	expectFailure(validateAuditJournalProjection({ ...projectionFixture(intent), intentName: elsewhere }), "audit-association-mismatch", "/intentName");
	expectFailure(validateAuditJournalProjection({ ...projectionFixture(intent), intentPath: "/tmp/intents/x.json" }), "unknown-field");
	// before/after 关系仍要成立。
	expectFailure(validateAuditJournalProjection({ ...projectionFixture(intent), after: { revision: 5, hash: HASH_AFTER } }), "audit-revision-invalid", "/after/revision");
});

/* ------------------------------------------------------------------ 3. 关联判定 */

test("C2AR：不存在事件时只返回 publish，不预支任何发布事实", () => {
	const result = associate({ existingEvent: null });
	assert.deepEqual(result, { ok: true, kind: "publish" });
	const serialized = JSON.stringify(result);
	for (const forbidden of ["publication", "recordedAt", "writer", "recovery", "eventId"]) {
		assert.ok(!serialized.includes(forbidden), `publish 结果不得暗示"已经发布"（出现 ${forbidden}）：${serialized}`);
	}
});

test("C2AR：已有 writer 事件决定一致时认领其原始 publication/recordedAt", () => {
	const intent = intentFixture();
	const existing = eventFixture(intent, { publication: "writer", recordedAt: NOW + 4321 });
	const result = associate({ intent, existingEvent: existing });
	assert.equal(result.ok, true, `应当认领：${JSON.stringify(result)}`);
	assert.equal(result.kind, "claim");
	assert.equal(result.event.publication, "writer", "不得把 writer 事件改写成 recovery");
	assert.equal(result.event.recordedAt, NOW + 4321, "不得用恢复时间替换原 recordedAt");
});

test("C2AR：recovery 事件可被再次认领，并保留第一次的发布时间（幂等）", () => {
	const intent = intentFixture();
	const firstPublication = eventFixture(intent, { publication: "recovery", recordedAt: NOW + 999 });
	const first = associate({ intent, existingEvent: firstPublication });
	assert.equal(first.ok && first.kind, "claim");
	assert.equal(first.event.publication, "recovery");
	assert.equal(first.event.recordedAt, NOW + 999);

	// 第二次认领：事件没变 ⇒ 结果逐字节一致（不重新打时间、不新增事件）。
	const second = associate({ intent, existingEvent: firstPublication });
	assert.deepEqual(second, first, "重复认领必须幂等且不改变发布事实");

	// 即使"当前时间"已经前进（本模块不接收时间，因此这里用不同 recordedAt 的事件证明比较口径无关时间）。
	const later = associate({ intent, existingEvent: { ...firstPublication, recordedAt: NOW + 8888 } });
	assert.equal(later.ok && later.kind, "claim");
	assert.equal(later.event.recordedAt, NOW + 8888, "认领保留的是磁盘上那条事件的真实发布时间");
});

test("C2AR：对象键顺序不同不制造冲突（决定相等性不取决于写法）", () => {
	const intent = intentFixture();
	const reorderedIntent = {
		evidence: intent.evidence,
		after: intent.after,
		before: intent.before,
		reason: intent.reason,
		decidedAt: intent.decidedAt,
		operatorLabel: intent.operatorLabel,
		toStatus: intent.toStatus,
		fromStatus: intent.fromStatus,
		action: intent.action,
		target: intent.target,
		operationId: intent.operationId,
		eventId: intent.eventId,
		purpose: intent.purpose,
		intentVersion: intent.intentVersion,
	};
	const reorderedEvent = {
		recordedAt: NOW + 1,
		publication: "writer",
		evidence: intent.evidence,
		after: intent.after,
		before: intent.before,
		reason: intent.reason,
		decidedAt: intent.decidedAt,
		operatorLabel: intent.operatorLabel,
		toStatus: intent.toStatus,
		fromStatus: intent.fromStatus,
		action: intent.action,
		target: intent.target,
		operationId: intent.operationId,
		eventId: intent.eventId,
		auditVersion: 1,
	};
	const result = associate({ intent: reorderedIntent, existingEvent: reorderedEvent });
	assert.equal(result.ok && result.kind, "claim", `键顺序不应造成冲突：${JSON.stringify(result)}`);
});

test("C2AR：同 ID 但稳定决定字段不同 ⇒ 冲突（逐项，不只看 eventId）", () => {
	const cases = [
		{ name: "动作", patch: { action: "deprecate", fromStatus: "reviewed", toStatus: "deprecated" }, path: "/action" },
		{ name: "操作者", patch: { operatorLabel: "bob" }, path: "/operatorLabel" },
		{ name: "决定时间", patch: { decidedAt: NOW + 1 }, path: "/decidedAt" },
		{ name: "理由", patch: { reason: "另一条理由" }, path: "/reason" },
		{ name: "before hash", patch: { before: { revision: 0, hash: "d".repeat(64) } }, path: "/before/hash" },
		// 只改 after 会让**事件本身**非法（跳过 revision），那样先失败的是事件校验，
		// 证明不了决定比较；因此同时改 before/after，保证事件合法但与意图不同。
		{ name: "revision 组合", patch: { before: { revision: 5, hash: HASH_BEFORE }, after: { revision: 6, hash: HASH_AFTER } }, path: "/before/revision" },
		{ name: "目标", patch: { target: { kind: "experience-card", recordId: "exp-other" } }, path: "/target/recordId" },
		{ name: "证据内容", patch: { evidence: [] }, path: "/evidence" },
		{
			name: "证据顺序",
			patch: {
				evidence: [
					{ kind: "record-validation", index: 1 },
					{ kind: "record-validation", index: 0 },
				],
			},
			path: "/evidence",
		},
	];
	const intent = intentFixture({
		evidence: [
			{ kind: "record-validation", index: 0 },
			{ kind: "record-validation", index: 1 },
		],
	});
	for (const scenario of cases) {
		const existing = { ...eventFixture(intent), ...scenario.patch };
		expectFailure(associate({ intent, existingEvent: existing }), "audit-decision-conflict", scenario.path);
	}
	// 状态对：`deprecate` 有两个合法对，因此可以构造"事件本身合法、但与意图的状态对不同"的场景。
	const deprecateIntent = intentFixture({ action: "deprecate", fromStatus: "reviewed", toStatus: "deprecated" });
	const deprecateEvent = eventFixture(deprecateIntent, { fromStatus: "verified" });
	expectFailure(associate({ intent: deprecateIntent, existingEvent: deprecateEvent }), "audit-decision-conflict", "/action");
});

test("C2AR：已有事件本身非法（发布事实/结构）一律拒绝，不当成可认领事件", () => {
	const cases = [
		{ name: "未知 publication", patch: { publication: "robot" } },
		{ name: "缺 publication", patch: { publication: undefined } },
		{ name: "发布早于决定", patch: { recordedAt: NOW - 1 } },
		{ name: "未知字段", patch: { evilCustomerKey: "SECRET" } },
		{ name: "auditVersion 缺失", patch: { auditVersion: undefined } },
	];
	const intent = intentFixture();
	for (const scenario of cases) {
		const existing = { ...eventFixture(intent), ...scenario.patch };
		const result = associate({ intent, existingEvent: existing });
		assert.equal(result.ok, false, `${scenario.name} 必须被拒绝`);
		assert.ok(!JSON.stringify(result.issues).includes("SECRET"), "诊断不得回显正文");
	}
});

test("C2AR：投影与意图的身份逐项对齐（operationId/eventId/target/before/after）", () => {
	const intent = intentFixture();
	const cases = [
		{ name: "operationId", overrides: { operationId: OTHER_EVENT_ID, intentName: auditIntentFileName(OTHER_EVENT_ID) }, path: "/operationId" },
		{ name: "eventId", overrides: { eventId: OTHER_EVENT_ID }, path: "/eventId" },
		{ name: "target", overrides: { target: { kind: "experience-card", recordId: "exp-other" } }, path: "/target/recordId" },
		{ name: "before", overrides: { before: { revision: 0, hash: "d".repeat(64) } }, path: "/before/hash" },
		{ name: "after", overrides: { after: { revision: 1, hash: "e".repeat(64) } }, path: "/after/hash" },
	];
	for (const scenario of cases) {
		expectFailure(associate({ intent, projection: projectionFixture(intent, scenario.overrides) }), "audit-association-mismatch", scenario.path);
	}
});

test("C2AR：实测意图字节指纹必须与投影声明一致（声明不等于证明）", () => {
	const intent = intentFixture();
	// 格式非法：不是 64 位小写十六进制 ⇒ 连比较都不做。
	for (const bad of [INTENT_HASH.toUpperCase(), "c".repeat(63), "c".repeat(65), "z".repeat(64), "", 42, null, undefined]) {
		expectFailure(associate({ intent, intentBytesHash: bad }), "invalid-intent-hash", "/intentHash");
	}
	// 格式合法但与投影绑定值不同 ⇒ 意图可能被替换。
	expectFailure(associate({ intent, intentBytesHash: "d".repeat(64) }), "audit-association-mismatch", "/intentHash");
});

test("C2AR：大输入下诊断有界、脱敏，且不冒充成功", () => {
	const secret = "SECRET-CUSTOMER-BODY-MUST-NOT-LEAK";
	const intent = intentFixture({ reason: secret.repeat(120), operatorLabel: "L".repeat(200_000) });
	const result = associate({ intent, intentBytesHash: INTENT_HASH });
	assert.equal(result.ok, false);
	assert.ok(result.issues.length <= AUDIT_MAX_ISSUES, `诊断条数必须有界，实际 ${result.issues.length}`);
	for (const entry of result.issues) assert.ok(entry.message.length <= 200, `单条诊断必须有界：${entry.message.length}`);
	const rendered = describeAuditIssues(result.issues);
	assert.ok(rendered.length <= 4_096, "渲染文本必须有界");
	assert.ok(!rendered.includes(secret) && !JSON.stringify(result.issues).includes(secret), "诊断不得携带输入正文");
});

test("C2AR：路径脱敏覆盖意图/投影字段名，未知片段仍被替换", () => {
	assert.equal(sanitizeAuditPath("/intentVersion"), "/intentVersion");
	assert.equal(sanitizeAuditPath("/intentName"), "/intentName");
	assert.equal(sanitizeAuditPath("/journalPurpose"), "/journalPurpose");
	assert.equal(sanitizeAuditPath("/intentHash"), "/intentHash");
	// `intent` 不是契约字段名（意图本身就是顶层对象），因此它也会被脱敏：
	// 对未知结构只保留"位置"，不保留外部输入里的名字。
	assert.equal(sanitizeAuditPath("/intent/0/evilKey"), "/<unknown>/0/<unknown>");
	assert.equal(sanitizeAuditPath("/evidence/0/note"), "/evidence/0/note", "契约内字段名必须保留，否则诊断就没用了");
});

/* ------------------------------------------------------------------ 4. 契约元数据 */

test("C2AR：参与比较的字段明确排除发布事实", () => {
	assert.ok(AUDIT_INTENT_DECISION_FIELDS.includes("decidedAt"));
	assert.ok(AUDIT_INTENT_DECISION_FIELDS.includes("evidence"));
	assert.ok(AUDIT_INTENT_DECISION_FIELDS.includes("before"));
	assert.ok(!AUDIT_INTENT_DECISION_FIELDS.includes("publication"), "publication 是发布事实，不参与决定比较");
	assert.ok(!AUDIT_INTENT_DECISION_FIELDS.includes("recordedAt"), "recordedAt 是发布事实，不参与决定比较");
	assert.deepEqual([...AUDIT_ASSOCIATION_COMPARED_FIELDS], ["operationId", "eventId", "target", "before", "after"]);
	// 投影版本与意图名长度是**协议常量**：改它们必须同步实施记录与测试。
	assert.equal(AUDIT_JOURNAL_V2_VERSION, 2);
	assert.equal(auditIntentFileName(OPERATION_ID).length, 41);
});
