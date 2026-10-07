/**
 * BM-07B B-06 永久回归：任务沉淀**预填**的纯函数。
 *
 * 重点：预填只搬运已保存任务里的事实（需求/验证记录），**不补造**根因、方案、
 * 适用边界；`requiredHumanFields` 原样带出，不替用户填默认值。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { requiredHumanFieldsOf, sedimentHintsOf, sedimentSeedOf } = loadTsCommonJs("src/renderer/src/components/bios/tasks/biosSedimentDrafts.ts");

const plain = (value) => JSON.parse(JSON.stringify(value));

const PREFILL = {
	taskId: "task-a",
	projectId: "proj-a",
	taskRevision: 2,
	suggested: {
		sourceProjectId: "proj-a",
		requirement: "PXE 选项菜单超时",
		decisions: ["不改客户定制区"],
		relatedFiles: ["Platform/SamplePkg/Sample.dsc"],
		sourceExperienceIds: ["exp-old"],
		usableExperienceIds: ["exp-old"],
		validations: [{ kind: "compile", scope: "SamplePlatformA", result: "passed", performedAt: 1_700_000_000_000, performedBy: "tester", evidence: [] }],
	},
	requiredHumanFields: ["rootCause", "solution", "appliesWhen", "doesNotApplyWhen"],
	problems: [],
};

test("B-06：预填把任务需求与验证记录搬过来，根因/方案留空（不补造）", () => {
	const seed = sedimentSeedOf(PREFILL);
	assert.equal(seed.problem, "PXE 选项菜单超时");
	assert.equal(seed.sourceProjectId, "proj-a");
	assert.equal(seed.validations.length, 1);
	assert.equal(seed.validations[0].kind, "compile");
	assert.equal(seed.validations[0].result, "passed");
	assert.equal(seed.validations[0].scope, "SamplePlatformA");
	// 刻意**没有** seed.rootCause / seed.solution 这类字段：预填不提供它们。
	assert.deepEqual(Object.keys(plain(seed)).sort(), ["problem", "sourceProjectId", "validations"]);
});

test("B-06：人工必填字段与线索原样带出（不加工、不补默认值）", () => {
	assert.deepEqual([...requiredHumanFieldsOf(PREFILL)], ["rootCause", "solution", "appliesWhen", "doesNotApplyWhen"]);
	const hints = sedimentHintsOf(PREFILL);
	assert.deepEqual(plain(hints), { decisions: ["不改客户定制区"], relatedFiles: ["Platform/SamplePkg/Sample.dsc"], sourceExperienceIds: ["exp-old"], usableExperienceIds: ["exp-old"] });
});

test("B-06：任务侧为空时预填也不编造内容", () => {
	const empty = { ...PREFILL, suggested: { ...PREFILL.suggested, decisions: [], relatedFiles: [], sourceExperienceIds: [], usableExperienceIds: [], validations: [] } };
	const seed = sedimentSeedOf(empty);
	assert.equal(seed.validations.length, 0, "没有验证记录就不给验证记录");
	const hints = sedimentHintsOf(empty);
	assert.deepEqual(plain(hints.decisions), []);
	assert.deepEqual(plain(hints.relatedFiles), []);
});
