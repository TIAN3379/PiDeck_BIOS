/**
 * BM-02C2A 的**永久回归**：审核审计的纯契约与纯校验。
 *
 * 这一轮没有 IO，测试也不能把"纯数据校验通过"说成"审计恢复已实现"或"操作者身份已认证"。
 * 用例分四类：
 * 1. 正常：合法样例通过，且校验**不修改**输入（冻结实例 + 前后深比较）；
 * 2. 异常：版本闸门、未知字段、UUID/recordId、动作与状态对、安全 revision、时间、证据形态；
 * 3. 预算：标签/理由的字符与字节、证据总字节、单条事件总量不变式；
 * 4. 脱敏与有界：未知字段名不回显、诊断条数与长度有界、恶意大输入不放大输出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	AUDIT_ACTION_TRANSITIONS,
	AUDIT_EVIDENCE_MAX_BYTES,
	AUDIT_EVIDENCE_MAX_ITEMS,
	AUDIT_LABEL_MAX_BYTES,
	AUDIT_LABEL_MAX_CHARS,
	AUDIT_MAX_DATE_MS,
	AUDIT_MAX_EVENT_BYTES,
	AUDIT_MAX_ISSUES,
	AUDIT_REASON_MAX_BYTES,
	AUDIT_REASON_MAX_CHARS,
	AUDIT_SCHEMA_VERSION,
	BIOS_CONTRACTS_SCHEMA_VERSION,
	RECORD_SCHEMAS,
	describeAuditIssues,
	describeAuditTransitions,
	isLegalAuditTransition,
	isValidAuditEvent,
	measureAuditEventBytes,
	readAuditVersion,
	sanitizeAuditPath,
	utf8ByteLength,
	validateAuditEvent,
} from "../core/contracts/index.ts";
import { JOURNAL_SCHEMA_VERSION } from "../core/storage/journal/contract.ts";

// 两个 UUID 都**必须含字母**：全数字的 UUID 上 `.toUpperCase()` 是空操作，
// "大写 UUID 被拒绝"那条用例会因此永远通过（假绿）。
const EVENT_ID = "3f2504e0-4f89-4a1c-9a3d-1f0d3c9a4b7e";
const OPERATION_ID = "8c1b2f44-6a5d-4b3e-9f7a-2d4c8e1b5a90";
const HASH_BEFORE = "a".repeat(64);
const HASH_AFTER = "b".repeat(64);
const NOW = 1_700_000_000_000;

function auditFixture(overrides = {}) {
	return {
		auditVersion: AUDIT_SCHEMA_VERSION,
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
		publication: "writer",
		recordedAt: NOW + 1_000,
		...overrides,
	};
}

function expectIssue(result, code, messagePart, pathPart) {
	assert.equal(result.ok, false, `应当被拒绝，实际通过了：${JSON.stringify(result)}`);
	const hit = result.issues.find((entry) => entry.code === code && (messagePart === undefined || entry.message.includes(messagePart)) && (pathPart === undefined || entry.path === pathPart));
	assert.ok(hit, `缺少 ${code}${messagePart ? `（含 "${messagePart}"）` : ""}${pathPart ? `（路径 ${pathPart}）` : ""}：${JSON.stringify(result.issues)}`);
	return hit;
}

/* ------------------------------------------------------------------ 1. 正常路径 */

test("C2A：合法样例通过，且校验不修改输入", () => {
	const fixture = auditFixture();
	const snapshot = JSON.parse(JSON.stringify(fixture));
	// 冻结实例：校验若"顺手修一下"，在严格模式下会直接抛错，而不是悄悄改掉调用方的数据。
	Object.freeze(fixture);
	Object.freeze(fixture.target);
	Object.freeze(fixture.before);
	Object.freeze(fixture.after);
	Object.freeze(fixture.evidence);
	Object.freeze(fixture.evidence[0]);

	const result = validateAuditEvent(fixture);
	assert.equal(result.ok, true, `合法样例必须通过：${JSON.stringify(result)}`);
	assert.deepEqual(result.value, snapshot, "返回的是同一份内容");
	assert.equal(isValidAuditEvent(fixture), true);
	assert.deepEqual(JSON.parse(JSON.stringify(fixture)), snapshot, "输入不得被修改");
	assert.deepEqual(fixture, snapshot);
});

test("C2A：auditVersion 闸门先行，未知版本只报版本问题", () => {
	assert.equal(readAuditVersion(auditFixture()), AUDIT_SCHEMA_VERSION);
	assert.equal(readAuditVersion({ auditVersion: 0 }), undefined, "0 视为缺失");
	assert.equal(readAuditVersion({ auditVersion: 1.5 }), undefined, "非整数视为缺失");
	assert.equal(readAuditVersion([]), undefined);
	assert.equal(readAuditVersion(null), undefined);

	const missing = validateAuditEvent({ ...auditFixture(), auditVersion: undefined });
	expectIssue(missing, "invalid-audit-version", "auditVersion");

	for (const bad of [0, 1.5, "1", Number.NaN]) {
		expectIssue(validateAuditEvent({ ...auditFixture(), auditVersion: bad }), "invalid-audit-version", "auditVersion");
	}

	// 未来版本：不猜格式 ⇒ 只报版本问题，**不**产生"缺字段/字段不合法"的噪音。
	const future = validateAuditEvent({ auditVersion: 2 });
	assert.equal(future.ok, false);
	assert.equal(future.issues.length, 1, `未知版本必须只报一条问题：${JSON.stringify(future.issues)}`);
	expectIssue(future, "unsupported-audit-version", "不按当前版本猜测字段");
});

/* ------------------------------------------------------------------ 2. 结构与路径 */

test("C2A：未知字段被拒绝，且诊断不回显字段名", () => {
	const topLevel = validateAuditEvent({ ...auditFixture(), evilCustomerKey: "SECRET-VALUE" });
	expectIssue(topLevel, "unknown-field");
	// 只检查字段名：值本来就不会出现在诊断里（诊断不 echo 输入）。
	assert.ok(!JSON.stringify(topLevel.issues).includes("evilCustomerKey"), `诊断不得回显未知字段名：${JSON.stringify(topLevel.issues)}`);
	assert.ok(!JSON.stringify(topLevel.issues).includes("SECRET-VALUE"), "诊断不得回显未知字段的值");

	// 任何路径字段都必须被拒绝：路径只能由受控 ID 派生，不能由数据给出。
	for (const key of ["targetPath", "tempPath", "lockPath", "absolutePath", "relativePath"]) {
		const result = validateAuditEvent({ ...auditFixture(), [key]: "/tmp/whatever.json" });
		expectIssue(result, "unknown-field");
		assert.ok(!JSON.stringify(result.issues).includes(key), `诊断不得回显 ${key}`);
	}

	// 嵌套未知字段：路径里的未知片段被替换成 <unknown>。
	const nested = validateAuditEvent({ ...auditFixture(), target: { kind: "experience-card", recordId: "exp-audit-1", extra: 1 } });
	const nestedIssue = expectIssue(nested, "unknown-field");
	assert.ok(nestedIssue.path.includes("<unknown>") || nestedIssue.path === "/target", `嵌套路径必须脱敏，实际：${nestedIssue.path}`);
	assert.ok(!nestedIssue.path.includes("extra"), "路径不得回显未知字段名");
});

test("C2A：eventId/operationId 必须是规范小写 UUID，目标只接受 experience-card + 合法 recordId", () => {
	for (const bad of [EVENT_ID.toUpperCase(), "11111111-1111-4111-8111-11111111111", "not-a-uuid", "", 42]) {
		expectIssue(validateAuditEvent({ ...auditFixture(), eventId: bad }), "invalid-audit");
	}
	for (const bad of ["not-a-uuid", OPERATION_ID.toUpperCase(), null]) {
		expectIssue(validateAuditEvent({ ...auditFixture(), operationId: bad }), "invalid-audit");
	}
	// 首版只覆盖经验卡：其它 kind 一律拒绝（不是"暂时忽略"）。
	expectIssue(validateAuditEvent({ ...auditFixture(), target: { kind: "task-record", recordId: "exp-audit-1" } }), "invalid-audit");
	for (const bad of ["../escape", "Exp", "con.json", "exp.", "a/b", "x".repeat(129), ""]) {
		expectIssue(validateAuditEvent({ ...auditFixture(), target: { kind: "experience-card", recordId: bad } }), "invalid-audit");
	}
});

/* ------------------------------------------------------------------ 3. 动作与状态 */

test("C2A：动作与状态对逐条对照（含合法组合必须通过）", () => {
	let checked = 0;
	for (const [action, transitions] of Object.entries(AUDIT_ACTION_TRANSITIONS)) {
		for (const transition of transitions) {
			checked += 1;
			const result = validateAuditEvent(auditFixture({ action, fromStatus: transition.from, toStatus: transition.to }));
			assert.equal(result.ok, true, `${action} ${transition.from}→${transition.to} 应当合法：${JSON.stringify(result)}`);
			assert.equal(isLegalAuditTransition(action, transition.from, transition.to), true);
		}
	}
	assert.ok(checked >= 5, `动作表至少 5 组合法关系，实际 ${checked}`);
	assert.ok(describeAuditTransitions().includes("submit-review") && describeAuditTransitions().includes("deprecate"));

	// 矛盾组合：一步直达、反向、自环、跨状态跳跃都必须被拒绝。
	const illegal = [
		{ action: "approve", fromStatus: "draft", toStatus: "verified" },
		{ action: "approve", fromStatus: "reviewed", toStatus: "deprecated" },
		{ action: "submit-review", fromStatus: "reviewed", toStatus: "reviewed" },
		{ action: "request-changes", fromStatus: "verified", toStatus: "draft" },
		{ action: "deprecate", fromStatus: "draft", toStatus: "deprecated" },
		{ action: "restore", fromStatus: "draft", toStatus: "draft" },
	];
	for (const bad of illegal) {
		expectIssue(validateAuditEvent(auditFixture(bad)), "audit-action-mismatch");
	}
	// 未知动作：结构层直接拒绝（枚举越界），不进入语义层。
	expectIssue(validateAuditEvent(auditFixture({ action: "rubber-stamp" })), "invalid-audit");
	// 未知状态：同样由枚举拒绝。
	expectIssue(validateAuditEvent(auditFixture({ toStatus: "approved" })), "invalid-audit");
});

/* ------------------------------------------------------------------ 4. revision 与时间 */

test("C2A：revision 越界由 schema 拒绝，关系与溢出由语义层拒绝", () => {
	const safe = validateAuditEvent(auditFixture({ before: { revision: Number.MAX_SAFE_INTEGER - 1, hash: HASH_BEFORE }, after: { revision: Number.MAX_SAFE_INTEGER, hash: HASH_AFTER } }));
	assert.equal(safe.ok, true, "安全整数上限内的最后一次递增必须允许");

	// 分层说明：负数/小数/2^53/1e100 在 schema 的 Integer 边界就被拒绝（`invalid-audit`），
	// 语义层的安全整数确认是"防止 schema 被放松后算术出错"的防御，不靠伪造输入来覆盖。
	for (const revision of [2 ** 53, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e100]) {
		expectIssue(validateAuditEvent(auditFixture({ before: { revision, hash: HASH_BEFORE } })), "invalid-audit", undefined, "/before/revision");
	}
	// 溢出：before 已在安全上限，无法再安全递增（审核必须改变版本）。
	expectIssue(validateAuditEvent(auditFixture({ before: { revision: Number.MAX_SAFE_INTEGER, hash: HASH_BEFORE }, after: { revision: Number.MAX_SAFE_INTEGER, hash: HASH_AFTER } })), "audit-revision-invalid", "安全整数上限");

	// 关系错误：跳跃、不动、倒退。
	expectIssue(validateAuditEvent(auditFixture({ after: { revision: 2, hash: HASH_AFTER } })), "audit-revision-invalid", "after.revision 必须等于 before.revision + 1");
	expectIssue(validateAuditEvent(auditFixture({ after: { revision: 0, hash: HASH_AFTER } })), "audit-revision-invalid");
	// 负数在 schema 的 minimum 处就被拒（同"越界由 schema 拒绝"的分层）。
	expectIssue(validateAuditEvent(auditFixture({ after: { revision: -1, hash: HASH_AFTER } })), "invalid-audit", undefined, "/after/revision");
	// null 不接受：审核只针对已存在的记录（与 C1 的 update 关系一致）。
	expectIssue(validateAuditEvent(auditFixture({ before: { revision: null, hash: null } })), "invalid-audit");
});

test("C2AR：前后 hash 的 7 种非法格式 × 2 个字段（共 14 例）全部被结构层拒绝", () => {
	const badHashes = [
		{ name: "大写十六进制", value: "A".repeat(64) },
		{ name: "非十六进制字符", value: `g${"a".repeat(63)}` },
		{ name: "63 位", value: "a".repeat(63) },
		{ name: "65 位", value: "a".repeat(65) },
		{ name: "路径字符串", value: "/tmp/records/exp.json" },
		{ name: "null", value: null },
		{ name: "数字", value: 12345 },
	];
	let checked = 0;
	for (const field of ["before", "after"]) {
		for (const scenario of badHashes) {
			const fingerprint = field === "before" ? { revision: 0, hash: scenario.value } : { revision: 1, hash: scenario.value };
			expectIssue(validateAuditEvent(auditFixture({ [field]: fingerprint })), "invalid-audit", undefined, `/${field}/hash`);
			checked += 1;
		}
	}
	assert.equal(checked, 14, "14 例必须逐条被检查，不能因为循环写错而少测");
	// 对照：合法 hash 仍然通过（否则上面的拒绝可能只是因为别的原因）。
	assert.equal(validateAuditEvent(auditFixture()).ok, true);
});

test("C2A：时间范围由 schema 拒绝，先后关系由语义层拒绝", () => {
	const boundary = validateAuditEvent(auditFixture({ decidedAt: 0, recordedAt: 0 }));
	assert.equal(boundary.ok, true, "epoch 0 是合法时间戳");

	for (const bad of [-1, 1.5, Number.NaN, 1e100, Number.MAX_SAFE_INTEGER]) {
		expectIssue(validateAuditEvent(auditFixture({ decidedAt: bad })), "invalid-audit", undefined, "/decidedAt");
		expectIssue(validateAuditEvent(auditFixture({ recordedAt: bad })), "invalid-audit", undefined, "/recordedAt");
	}
	// 语义层真正负责的是先后关系：发布不能先于决定。
	expectIssue(validateAuditEvent(auditFixture({ decidedAt: NOW, recordedAt: NOW - 1 })), "audit-time-invalid", "不能早于 decidedAt");
});

/* ------------------------------------------------------------------ 5. 预算 */

test("C2A：标签与理由的字符、UTF-8 字节双预算", () => {
	// 全 ASCII：字符上限先到。
	assert.equal(validateAuditEvent(auditFixture({ operatorLabel: "a".repeat(AUDIT_LABEL_MAX_CHARS) })).ok, true);
	expectIssue(validateAuditEvent(auditFixture({ operatorLabel: "a".repeat(AUDIT_LABEL_MAX_CHARS + 1) })), "invalid-audit", "字段长度超出上限");

	// 标签字节边界：85 个汉字 = 255 字节（合法）；86 个 = 258 字节（超 256）。
	const labelOk = `${"汉".repeat(85)}`;
	assert.equal(utf8ByteLength(labelOk), 255);
	assert.equal(validateAuditEvent(auditFixture({ operatorLabel: labelOk })).ok, true);
	const labelOver = "汉".repeat(86);
	assert.equal(utf8ByteLength(labelOver), 258);
	expectIssue(validateAuditEvent(auditFixture({ operatorLabel: labelOver })), "audit-text-invalid", "operatorLabel 的 UTF-8 字节数");

	// 理由字节边界：341 个汉字 = 1023 字节（合法）；342 个 = 1026 字节（超 1024）。
	const reasonOk = "由".repeat(341);
	assert.equal(utf8ByteLength(reasonOk), 1023);
	assert.equal(validateAuditEvent(auditFixture({ reason: reasonOk })).ok, true);
	expectIssue(validateAuditEvent(auditFixture({ reason: "由".repeat(342) })), "audit-text-invalid", "reason 的 UTF-8 字节数");
	// 字符上限仍在：513 个 ASCII 字符直接由 schema 拒。
	expectIssue(validateAuditEvent(auditFixture({ reason: "r".repeat(AUDIT_REASON_MAX_CHARS + 1) })), "invalid-audit");
	// 空标签/空理由没有信息量，必须拒绝。
	expectIssue(validateAuditEvent(auditFixture({ operatorLabel: "" })), "invalid-audit");
	expectIssue(validateAuditEvent(auditFixture({ reason: "" })), "invalid-audit");

	// 字节上限必须**可达**：3 × 字符上限是 UTF-16 计数下 3 字节字符的理论最大值，
	// 字节上限若不低于它，这条规则永远不会触发（成了装饰）。
	assert.ok(AUDIT_LABEL_MAX_BYTES < AUDIT_LABEL_MAX_CHARS * 3, "标签字节上限必须可达");
	assert.ok(AUDIT_REASON_MAX_BYTES < AUDIT_REASON_MAX_CHARS * 3, "理由字节上限必须可达");
});

test("C2A：证据关联的形态互斥与总字节预算", () => {
	// 条数上限由 schema 负责。
	const tooMany = Array.from({ length: AUDIT_EVIDENCE_MAX_ITEMS + 1 }, () => ({ kind: "record-evidence", index: 0 }));
	expectIssue(validateAuditEvent(auditFixture({ evidence: tooMany })), "invalid-audit", "数组条数超出上限");

	// `record-*` 需要 index，且不能同时声明 recordId（两个位置的声明互相矛盾）。
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "record-evidence" }] })), "audit-evidence-invalid", "必须给出 index");
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "record-validation", index: 0, recordId: "exp-other" }] })), "audit-evidence-invalid", "不接受 recordId");
	// `external-reference` 不能有 index，且至少要给出 recordId 或 note。
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference", index: 0 }] })), "audit-evidence-invalid", "不接受 index");
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference" }] })), "audit-evidence-invalid", "必须至少给出 recordId 或 note");
	assert.equal(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference", note: "客户现场照片编号 17" }] })).ok, true);
	assert.equal(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference", recordId: "exp-other" }] })).ok, true);

	// 单条说明长度与空串。
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference", note: "n".repeat(257) }] })), "invalid-audit");
	expectIssue(validateAuditEvent(auditFixture({ evidence: [{ kind: "external-reference", note: "" }] })), "invalid-audit");

	// 总字节：32 条各 200 汉字（每条 600 字节，远低于单条上限）⇒ 合计远超 8 KiB。
	const wide = Array.from({ length: AUDIT_EVIDENCE_MAX_ITEMS }, () => ({ kind: "record-evidence", index: 0, note: "证".repeat(200) }));
	const wideBytes = measureAuditEventBytes(wide);
	assert.ok(wideBytes > AUDIT_EVIDENCE_MAX_BYTES, `用例前提：证据字节 ${wideBytes} 必须超过 ${AUDIT_EVIDENCE_MAX_BYTES}`);
	expectIssue(validateAuditEvent(auditFixture({ evidence: wide })), "audit-evidence-invalid", "序列化字节超过");
});

test("C2A：顶到各字段上限的样例仍被接受（已测样例，不是全域最大值证明）", () => {
	// 构造"每条都顶到上限、但都不超"的样例：标签 128 ASCII、理由 341 汉字、
	// 证据按真实字节逐条加到刚好不超过 8 KiB。
	// 措辞纪律：这是**一个已测样例**，不是"全域最大合法事件"的证明——全域结论见下一条保守上界用例。
	const envelope = measureAuditEventBytes(auditFixture({ evidence: [] }));
	assert.ok(typeof envelope === "number" && envelope > 0);

	const item = { kind: "record-evidence", index: 0, note: "证".repeat(200) };
	const evidence = [];
	while (evidence.length < AUDIT_EVIDENCE_MAX_ITEMS) {
		const candidate = [...evidence, item];
		if (measureAuditEventBytes(candidate) > AUDIT_EVIDENCE_MAX_BYTES) break;
		evidence.push(item);
	}
	assert.ok(evidence.length > 0, "应当能装下至少一条证据");
	assert.ok(measureAuditEventBytes([...evidence, item]) > AUDIT_EVIDENCE_MAX_BYTES, "循环必须是因为证据预算耗尽而停止（而不是条数上限）");

	const filled = auditFixture({ operatorLabel: "a".repeat(AUDIT_LABEL_MAX_CHARS), reason: "由".repeat(341), evidence });
	const result = validateAuditEvent(filled);
	assert.equal(result.ok, true, `顶到上限的样例不得被拒绝（总量不得误报）：${JSON.stringify(result)}`);
	const bytes = measureAuditEventBytes(filled);
	assert.ok(bytes <= AUDIT_MAX_EVENT_BYTES, `样例 ${bytes} 字节必须落在总量上限 ${AUDIT_MAX_EVENT_BYTES} 之内`);
	assert.ok(bytes > envelope, "填满后的样例必须比信封更大，否则这条用例没有意义");

	// 再加一条证据就越过证据预算：边界必须精确。
	expectIssue(validateAuditEvent(auditFixture({ operatorLabel: "a".repeat(AUDIT_LABEL_MAX_CHARS), reason: "由".repeat(341), evidence: [...evidence, item] })), "audit-evidence-invalid", "序列化字节超过");
});

test("C2AR：控制字符/长 ID/数值边界的实测字节与保守上界（转义膨胀不能漏算）", () => {
	// 为什么需要这一条：JSON 会把控制字符转义成 `\uXXXX`（每码元最多 6 字节），
	// 于是"UTF-8 字节预算"并不等于"序列化字节预算"。只拿一个普通样例宣称上界，
	// 会把转义膨胀整段漏掉（第十轮 §3.3 的收口项）。
	const item = { kind: "record-evidence", index: 0, note: "证".repeat(200) };
	const evidence = [];
	while (evidence.length < AUDIT_EVIDENCE_MAX_ITEMS) {
		const candidate = [...evidence, item];
		if (measureAuditEventBytes(candidate) > AUDIT_EVIDENCE_MAX_BYTES) break;
		evidence.push(item);
	}

	const escaped = auditFixture({
		target: { kind: "experience-card", recordId: "a".repeat(128) },
		operatorLabel: "\u0001".repeat(AUDIT_LABEL_MAX_CHARS),
		reason: "\u0000".repeat(AUDIT_REASON_MAX_CHARS),
		before: { revision: Number.MAX_SAFE_INTEGER - 1, hash: HASH_BEFORE },
		after: { revision: Number.MAX_SAFE_INTEGER, hash: HASH_AFTER },
		decidedAt: AUDIT_MAX_DATE_MS,
		recordedAt: AUDIT_MAX_DATE_MS,
		evidence,
	});
	const result = validateAuditEvent(escaped);
	assert.equal(result.ok, true, `控制字符与边界数值都合法时必须通过：${JSON.stringify(result)}`);

	const bytes = measureAuditEventBytes(escaped);
	assert.ok(typeof bytes === "number");
	assert.ok(bytes <= AUDIT_MAX_EVENT_BYTES, `实测 ${bytes} 字节必须落在总量闸门 ${AUDIT_MAX_EVENT_BYTES} 之内`);
	assert.ok(bytes > 8_000, `转义膨胀必须真实存在（实测 ${bytes} 字节），否则这条用例没覆盖到风险点`);

	// 保守上界（从**常量**推出，不依赖任何样例）：
	//   信封 1 KiB + 标签 128 码元 × 6 + 理由 512 码元 × 6 + 证据 8 KiB。
	// 6 倍的依据：BMP 字符最多转义成 `\uXXXX`；4 字节字符要占 2 个码元，按码元算只会更小。
	const conservativeBound = 1024 + AUDIT_LABEL_MAX_CHARS * 6 + AUDIT_REASON_MAX_CHARS * 6 + AUDIT_EVIDENCE_MAX_BYTES;
	assert.ok(conservativeBound < AUDIT_MAX_EVENT_BYTES, `保守上界 ${conservativeBound} 必须小于总量闸门 ${AUDIT_MAX_EVENT_BYTES}`);
	assert.ok(bytes <= conservativeBound, `实测 ${bytes} 不得超过保守上界 ${conservativeBound}`);
	// 闸门与上界之间留观察余量：避免把闸门写成"刚好等于上界"，那样任何算法小错都会误报合法输入。
	assert.ok(AUDIT_MAX_EVENT_BYTES - conservativeBound >= 1024, "闸门与保守上界之间必须留有余量");
});

test("C2A：序列化字节与实际落盘形式一致（不估算）", () => {
	const fixture = auditFixture();
	const measured = measureAuditEventBytes(fixture);
	const expected = utf8ByteLength(`${JSON.stringify(fixture, null, "\t")}\n`);
	assert.equal(measured, expected, "测量必须与存储层的序列化形式逐字节一致");
	assert.equal(measureAuditEventBytes(undefined), utf8ByteLength(`${JSON.stringify(undefined)}\n`), "不可序列化的输入按同一口径测量");
	const cyclic = {};
	cyclic.self = cyclic;
	assert.equal(measureAuditEventBytes(cyclic), undefined, "无法序列化时返回 undefined，而不是抛错");
});

/* ------------------------------------------------------------------ 6. 脱敏与有界 */

test("C2A：路径脱敏只保留契约内字段名与数组下标", () => {
	assert.equal(sanitizeAuditPath("/target/recordId"), "/target/recordId");
	assert.equal(sanitizeAuditPath("/evidence/0/kind"), "/evidence/0/kind");
	assert.equal(sanitizeAuditPath("/evidence/0/evilKey"), "/evidence/0/<unknown>");
	assert.equal(sanitizeAuditPath("/evilCustomerName/inner"), "/<unknown>/<unknown>");
	assert.equal(sanitizeAuditPath(""), "");
	assert.ok(sanitizeAuditPath(`/${"x".repeat(500)}`).length <= 161, "路径长度必须有界");
});

test("C2A：恶意大输入的诊断有界、不回显内容", () => {
	const secret = "SECRET-CUSTOMER-BODY-MUST-NOT-LEAK";
	// ① 未知字段：每条证据各带一个不同名字的未知字段，且值是客户正文。
	const evidence = Array.from({ length: 40 }, (_, index) => ({ kind: "external-reference", note: "n", [`evilSecret${index}`]: secret }));
	const unknownFields = validateAuditEvent(auditFixture({ evidence, operatorLabel: "L".repeat(200_000), reason: secret.repeat(100) }));
	assert.equal(unknownFields.ok, false);
	assert.ok(unknownFields.issues.length <= AUDIT_MAX_ISSUES, `诊断条数必须有界，实际 ${unknownFields.issues.length}`);
	const unknownSerialized = JSON.stringify(unknownFields.issues);
	assert.ok(!unknownSerialized.includes(secret), "诊断不得携带输入正文");
	assert.ok(!unknownSerialized.includes("evilSecret"), "诊断不得回显未知字段名");
	for (const entry of unknownFields.issues) assert.ok(entry.message.length <= 200, `单条诊断必须有界：${entry.message.length}`);

	// ② 语义层：32 条证据各有两个矛盾 ⇒ 64 条诊断必须先被截到 AUDIT_MAX_ISSUES 并如实计数。
	//    （结构层的错误枚举由 TypeBox 自己限量，覆盖不到"丢弃计数"，所以这一路必须单独测。）
	const contradictory = Array.from({ length: AUDIT_EVIDENCE_MAX_ITEMS }, () => ({ kind: "external-reference", index: 0 }));
	const semantic = validateAuditEvent(auditFixture({ evidence: contradictory }));
	assert.equal(semantic.ok, false);
	assert.equal(semantic.issues.length, AUDIT_MAX_ISSUES);
	assert.equal(semantic.droppedIssues, AUDIT_EVIDENCE_MAX_ITEMS * 2 - AUDIT_MAX_ISSUES, "被丢弃的诊断必须如实计数");
	for (const entry of semantic.issues) assert.equal(entry.code, "audit-evidence-invalid");

	const rendered = describeAuditIssues(semantic.issues);
	assert.ok(rendered.length <= 4_096, "渲染文本必须有界");
	assert.ok(describeAuditIssues(semantic.issues, 1).includes("另有"), "截断必须显式说明还有多少条");
});

test("C2A：结构错误扫描本身也有界（畸形大对象不放大处理）", () => {
	const huge = {};
	for (let index = 0; index < 1_000; index += 1) huge[`unknownField${index}`] = index;
	const result = validateAuditEvent({ ...auditFixture(), ...huge });
	assert.equal(result.ok, false);
	assert.ok(result.issues.length <= AUDIT_MAX_ISSUES);
	// 顶层未知字段路径相同 ⇒ 去重后只有一条，但被丢弃的计数必须体现"还有很多"。
	assert.equal(result.issues[0].code, "unknown-field");
	assert.ok(result.issues[0].message.includes("名称已省略"));
});

/* ------------------------------------------------------------------ 7. 不改变既有契约 */

test("C2A：审计契约不改变既有版本与记录集合", () => {
	assert.equal(AUDIT_SCHEMA_VERSION, 1);
	assert.equal(BIOS_CONTRACTS_SCHEMA_VERSION, 1, "记录 schemaVersion 必须保持 1");
	assert.equal(JOURNAL_SCHEMA_VERSION, 1, "journal v1 不得被本轮改动");
	assert.deepEqual(Object.keys(RECORD_SCHEMAS).sort(), ["context-manifest", "experience-card", "feature-record", "project-profile", "task-record"], "五类记录集合不变：审计是独立类别，不是第六类记录");
});
