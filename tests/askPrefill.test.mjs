import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const ask = loadTsCommonJs("src/renderer/src/utils/askUi.ts");

test("UX-01: 预填是可编辑草稿，不是已确认答案；placeholder 不能变成事实", () => {
	const draft = ask.initialAskBatchDraft([
		{ id: "identity", type: "input", question: "确认身份", prefill: "项目=Sample；客户=待确认" },
		{ id: "notes", type: "editor", question: "意见", prefill: "第一行\n第二行" },
		{ id: "customer", type: "input", question: "客户", placeholder: "例如：Example Customer" },
	]);
	assert.deepEqual(Object.keys(draft.answers), []);
	assert.deepEqual(JSON.parse(JSON.stringify(draft.inputValues)), { identity: "项目=Sample；客户=待确认", notes: "第一行\n第二行" });
	const confirmed = ask.commitBatchAnswer(draft, "identity", "项目=Edited", "项目=Edited", false);
	assert.equal(confirmed.answers.identity, "项目=Edited");
	assert.equal(confirmed.inputValues.notes, "第一行\n第二行");
	assert.deepEqual(Object.keys(draft.answers), [], "提交不能修改原草稿");
});
