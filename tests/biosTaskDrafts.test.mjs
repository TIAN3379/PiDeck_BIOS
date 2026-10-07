/**
 * BM-07B B-04 永久回归：任务表单的**纯函数**部分。
 *
 * 覆盖"界面草稿 ⇄ core 契约"的转换与前置校验：不扩张字段、不编造证据、
 * 空证据不写成空数组、未保存检测不误报。
 *
 * 注：被测模块经 `loadTsCommonJs` 在独立 realm 里执行，跨 realm 的对象/数组
 * 原型不同 ⇒ 断言前统一用 `plain()` 转成本 realm 的普通数据（只比较内容）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { emptyValidationDraft, formatList, fromLocalDateTime, parseList, toLocalDateTime, toValidationInput, validationDraftFrom, validationDraftMatchesRecord, validationHasExtraEvidence } = loadTsCommonJs("src/renderer/src/components/bios/tasks/biosTaskDrafts.ts");

const NOW = 1_700_000_000_000;
/** 把跨 realm 的纯数据换成本 realm 的普通对象/数组。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

/** `performedAt` 只精确到分钟（datetime-local），断言时用同一个精度做基准。 */
function minuteOf(text) {
	return fromLocalDateTime(text);
}

test("B-04：多行/分隔文本 ⇄ 数组（保序、去空、不做去重）", () => {
	assert.deepEqual(plain(parseList("a\nb, c，d；e")), ["a", "b", "c", "d", "e"]);
	assert.deepEqual(plain(parseList("\n  \n,")), []);
	assert.deepEqual(plain(parseList("x\nx")), ["x", "x"], "重复项保留：写盘内容由用户决定");
	assert.equal(formatList(["x", "y"]), "x\ny");
	assert.deepEqual(plain(parseList(formatList(["x", "y"]))), ["x", "y"]);
});

test("B-04：本地时间文本与 epoch ms 往返一致（不被时区平移）", () => {
	const text = toLocalDateTime(NOW);
	assert.match(text, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
	assert.equal(fromLocalDateTime(text), minuteOf(text));
	assert.equal(fromLocalDateTime(""), null);
	assert.equal(fromLocalDateTime("not-a-date"), null);
});

test("B-04：验证记录只写 schema 允许的字段，空证据不落成空数组", () => {
	const base = emptyValidationDraft(NOW);
	assert.equal(toValidationInput(base).ok, false, "空 scope/performedBy 必须被前置校验挡住");

	const ok = toValidationInput({ ...base, scope: "SamplePlatformA 编译", performedBy: "tester" });
	assert.equal(ok.ok, true);
	assert.deepEqual(plain(ok.value), { kind: "compile", scope: "SamplePlatformA 编译", result: "inconclusive", performedAt: minuteOf(base.performedAtLocal), performedBy: "tester" });
	assert.equal(Object.hasOwn(ok.value, "evidence"), false, "没有证据时不得写入空数组");
	// 不扩张字段：只允许 core 契约里的键。
	assert.deepEqual(Object.keys(plain(ok.value)).sort(), ["kind", "performedAt", "performedBy", "result", "scope"]);

	const withEvidence = toValidationInput({ ...base, scope: "s", performedBy: "t", evidenceType: "commit", evidenceCommit: "abc123", evidenceRelativePath: "Platform/x.dsc" });
	assert.equal(withEvidence.ok, true);
	assert.deepEqual(plain(withEvidence.value.evidence), [{ type: "commit", relativePath: "Platform/x.dsc", commit: "abc123" }], "空证据字段必须省略而不是填空串");

	// 选了类型但一个证据字段都没填 ⇒ 视为不带证据（不编造 hash/行号）。
	const typedOnly = toValidationInput({ ...base, scope: "s", performedBy: "t", evidenceType: "source-file" });
	assert.equal(typedOnly.ok, true);
	assert.equal(Object.hasOwn(typedOnly.value, "evidence"), false);

	for (const [draft, field] of [
		[{ ...base, scope: "", performedBy: "t" }, "scope"],
		[{ ...base, scope: "s", performedBy: "  " }, "performedBy"],
		[{ ...base, scope: "s", performedBy: "t", performedAtLocal: "bogus" }, "performedAt"],
	]) {
		const outcome = toValidationInput(draft);
		assert.equal(outcome.ok, false);
		assert.equal(outcome.error, field);
	}
});

test("B-04：已保存记录 → 草稿保留事实（编辑不会把验证清空）", () => {
	const saved = { kind: "board-boot", scope: "SampleBoard revA", result: "passed", performedAt: NOW, performedBy: "lab", evidence: [{ type: "document", relativePath: "docs/a.md", contentHash: "hash" }] };
	const draft = validationDraftFrom(saved);
	assert.equal(draft.kind, "board-boot");
	assert.equal(draft.result, "passed");
	assert.equal(draft.scope, "SampleBoard revA");
	assert.equal(draft.performedBy, "lab");
	assert.equal(draft.evidenceType, "document");
	assert.equal(draft.evidenceContentHash, "hash");
	// 往返后与原始记录语义一致（时间按分钟精度对齐）⇒ 未保存检测不能误报。
	const rounded = { ...saved, performedAt: minuteOf(draft.performedAtLocal) };
	assert.equal(validationDraftMatchesRecord(draft, rounded), true);
	// 秒/毫秒非零不得被判成"已修改"：表单只能表达分钟，比原始毫秒会反复误报。
	assert.equal(validationDraftMatchesRecord(draft, saved), true, "同一分钟内的秒级差异不算修改");
	// 记录侧完全没有 evidence 键（不是空数组）时同样算一致。
	const noEvidenceDraft = validationDraftFrom({ kind: "compile", scope: "s", result: "passed", performedAt: NOW, performedBy: "t" });
	assert.equal(validationDraftMatchesRecord(noEvidenceDraft, { kind: "compile", scope: "s", result: "passed", performedAt: minuteOf(noEvidenceDraft.performedAtLocal), performedBy: "t" }), true);
	// 前置校验不通过的草稿一律算"已修改"：清空 scope 是真实改动，不是"未变"。
	const blank = emptyValidationDraft(NOW);
	assert.equal(validationDraftMatchesRecord(blank, { kind: "compile", scope: "s", result: "passed", performedAt: minuteOf(blank.performedAtLocal), performedBy: "t" }), false);
});

test("B-04：未保存检测能识别真实改动，并能发现多条证据", () => {
	const draft = validationDraftFrom({ kind: "compile", scope: "s", result: "passed", performedAt: NOW, performedBy: "t" });
	const saved = { kind: "compile", scope: "s", result: "passed", performedAt: minuteOf(draft.performedAtLocal), performedBy: "t" };
	assert.equal(validationDraftMatchesRecord({ ...draft, scope: "s2" }, saved), false);
	assert.equal(validationDraftMatchesRecord({ ...draft, result: "failed" }, saved), false);
	assert.equal(validationDraftMatchesRecord({ ...draft, performedBy: "other" }, saved), false);
	assert.equal(
		validationHasExtraEvidence([
			{
				kind: "compile",
				scope: "s",
				result: "passed",
				performedAt: NOW,
				performedBy: "t",
				evidence: [
					{ type: "commit", commit: "a" },
					{ type: "commit", commit: "b" },
				],
			},
		]),
		true,
	);
	assert.equal(validationHasExtraEvidence([{ kind: "compile", scope: "s", result: "passed", performedAt: NOW, performedBy: "t", evidence: [{ type: "commit", commit: "a" }] }]), false);
});
