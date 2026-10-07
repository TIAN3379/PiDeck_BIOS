/**
 * BM-07B B-05 永久回归：需求/经验表单的**纯函数**部分。
 *
 * 重点证明两件"不能靠界面顺手做对"的事：
 * 1. 空事实**保持未知**（省略字段），不补造 rootCause / 不编造"已上板通过"；
 * 2. 复用范围默认最窄，跨客户必须有显式授权说明。
 *
 * 注：被测模块在独立 realm 执行 ⇒ 断言前用 `plain()` 只比内容。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const drafts = loadTsCommonJs("src/renderer/src/components/bios/knowledge/biosKnowledgeDrafts.ts");
const { emptyExperienceForm, emptyFeatureForm, experienceFormFrom, experienceFormMatchesCard, featureFormFrom, toExperienceChanges, toExperienceDraft, toFeatureChanges, toFeatureDraft, toFeatureFieldInput } = drafts;

const NOW = 1_700_000_000_000;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("B-05：需求字段空值必须省略（保持未知），有值才按声明确认程度写入", () => {
	assert.equal(toFeatureFieldInput({ value: "", status: "candidate", relativePath: "", contentHash: "", workspaceId: "" }), undefined, "空值 + 无依据 ⇒ 不写入");
	// 只有依据没有值：仍然写入（显式未知 + 依据），而不是丢掉依据。
	assert.deepEqual(plain(toFeatureFieldInput({ value: "", status: "candidate", relativePath: "docs/spec.md", contentHash: "h", workspaceId: "" })), { value: null, status: "candidate", relativePath: "docs/spec.md", contentHash: "h" });
	// 有值 + confirmed：带上确认程度，不伪造依据。
	assert.deepEqual(plain(toFeatureFieldInput({ value: "customer-x", status: "confirmed", relativePath: "", contentHash: "", workspaceId: "" })), { value: "customer-x", status: "confirmed" });
});

test("B-05：需求新建/更新只提交现有字段，空客户不改动", () => {
	const form = { ...emptyFeatureForm(), featureId: "feat-b05", originalRequirement: "PXE 定制", aliases: "pxe, 网络启动", acceptanceCriteria: "3 次冷启动通过" };
	const created = toFeatureDraft(form);
	assert.equal(created.ok, true);
	assert.deepEqual(Object.keys(plain(created.value)).sort(), ["acceptanceCriteria", "aliases", "featureId", "originalRequirement", "relatedExperienceIds"], "不新增沿革/发布状态字段");
	assert.deepEqual(plain(created.value.aliases), ["pxe", "网络启动"]);

	// 更新：客户/产品线留空 ⇒ 不提交这两个字段（不改动）。
	const changes = toFeatureChanges({ ...form, featureId: "ignored" });
	assert.equal(Object.hasOwn(changes, "customer"), false);
	assert.equal(Object.hasOwn(changes, "productLine"), false);

	// 缺必填项要能前置报错（而不是打一趟主进程）。
	assert.equal(toFeatureDraft({ ...emptyFeatureForm() }).ok, false);
	assert.equal(toFeatureDraft({ ...emptyFeatureForm(), featureId: "f" }).error, "originalRequirement");

	// 已保存记录 → 表单：保留事实。
	const back = featureFormFrom({ id: "f1", originalRequirement: "R", aliases: ["a"], customer: { value: "c", status: "confirmed", evidence: [] }, productLine: { value: null, status: "unknown", evidence: [] }, acceptanceCriteria: ["ac"], relatedExperienceIds: ["e1"] });
	assert.equal(back.featureId, "f1");
	assert.equal(back.customer.value, "c");
	assert.equal(back.customer.status, "confirmed");
	assert.equal(back.productLine.value, "");
});

test("B-05：经验草稿保持缺口——不填的字段不写，必填缺失要报错", () => {
	const form = { ...emptyExperienceForm(NOW), experienceId: "exp-b05", sourceProjectId: "proj-a", problem: "PXE 菜单超时", rootCause: "PXE_DELAY 过小", solution: "调大 PXE_DELAY" };
	const created = toExperienceDraft(form);
	assert.equal(created.ok, true);
	// 未填的 symptom 必须**缺席**（不是空串、不是"未知"占位）。
	assert.equal(Object.hasOwn(created.value, "symptom"), false);
	assert.equal(Object.hasOwn(created.value, "validations"), false, "没有验证记录时不得写入空数组");
	assert.equal(Object.hasOwn(created.value, "evidence"), false, "没有证据时不得写入空数组");
	assert.deepEqual(plain(created.value.reuse), { level: "current-project" }, "默认最窄范围，且不给授权说明");
	assert.deepEqual(plain(created.value.appliesWhen), []);

	// 必填缺失逐项报错（前置校验；final 判定仍由 core 做）。
	for (const [patch, field] of [
		[{ experienceId: "" }, "experienceId"],
		[{ problem: "" }, "problem"],
		[{ rootCause: "" }, "rootCause"],
		[{ solution: "" }, "solution"],
		[{ sourceProjectId: "" }, "sourceProjectId"],
	]) {
		const outcome = toExperienceDraft({ ...form, ...patch });
		assert.equal(outcome.ok, false);
		assert.equal(outcome.error, field);
	}
});

test("B-05：跨客户复用必须显式给授权说明；验证记录校验失败会指出第几条", () => {
	const base = { ...emptyExperienceForm(NOW), experienceId: "exp-c", sourceProjectId: "p", problem: "p", rootCause: "r", solution: "s" };
	const scoped = toExperienceDraft({ ...base, reuseLevel: "customer", reuseCustomers: "customer-a\ncustomer-b", reuseAuthorization: "客户 A 书面同意" });
	assert.equal(scoped.ok, true);
	assert.deepEqual(plain(scoped.value.reuse), { level: "customer", customers: ["customer-a", "customer-b"], authorization: "客户 A 书面同意" });

	const unauthorized = toExperienceDraft({ ...base, reuseLevel: "internal-general" });
	assert.equal(unauthorized.ok, true, "core 允许留档但按最窄处理；界面必须另行提示(见 reuseUnauthorizedHint)");
	assert.equal(Object.hasOwn(unauthorized.value.reuse, "authorization"), false);

	const badValidation = toExperienceDraft({ ...base, validations: [{ kind: "compile", scope: "", result: "passed", performedAtLocal: "2023-11-14T22:13", performedBy: "t", evidenceType: "none", evidenceRelativePath: "", evidenceContentHash: "", evidenceCommit: "", evidenceLocation: "" }] });
	assert.equal(badValidation.ok, false);
	assert.equal(badValidation.error, "validation1:scope");
});

test("B-05：编辑表单与已保存卡片的语义一致性（未保存检测不误报）", () => {
	const card = {
		id: "exp-1",
		problem: "p",
		rootCause: "r",
		solution: "s",
		appliesWhen: ["a"],
		doesNotApplyWhen: [],
		sourceProjectId: "proj-a",
		evidence: [{ type: "commit", commit: "abc", capturedAt: NOW, validity: "active" }],
		validations: [{ kind: "compile", scope: "s", result: "passed", performedAt: NOW, performedBy: "t", evidence: [] }],
		reuseScope: { level: "current-project", customers: [] },
		status: "draft",
	};
	const form = experienceFormFrom(card);
	assert.equal(experienceFormMatchesCard(form, card), true, "原样回读不得被判成已修改");
	assert.equal(experienceFormMatchesCard({ ...form, problem: "p2" }, card), false);
	assert.equal(experienceFormMatchesCard({ ...form, reuseLevel: "customer" }, card), false);
	assert.equal(experienceFormMatchesCard({ ...form, validations: [] }, card), false);

	// 编辑路径不接受归属改动。
	const changes = toExperienceChanges({ ...form, sourceProjectId: "proj-evil", experienceId: "other" });
	assert.equal("error" in changes, false);
	assert.equal(Object.hasOwn(changes, "sourceProjectId"), false);
	assert.equal(Object.hasOwn(changes, "experienceId"), false);
});
