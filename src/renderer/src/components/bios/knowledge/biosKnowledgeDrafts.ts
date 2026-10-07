/**
 * BM-07B B-05：需求/经验表单的**纯函数**部分（便于单测，不依赖 React）。
 *
 * 铁律（计划 §B-05）：
 * - 字段严格对齐 `core/knowledge` 的 v1 契约，**不新增沿革/发布状态**，不扩张格式；
 * - 空事实保持**未知**：不填的字段直接**省略**（不改动、不猜），绝不为"表单完整"补造
 *   rootCause 或"已上板通过"；验证强度只按声明记录；
 * - 复用范围默认最窄（`current-project`）；跨客户必须显式给授权说明；
 * - 前置校验只为了尽早给出可读错误，最终判定仍在 core。
 */
import type { EvidenceSourceType, ExperienceDraft, ExperienceCard, ExperienceValidationInput, FeatureDraft, FeatureFieldInput, FeatureRecord, ReuseScope } from "../../../../../shared/types/biosBusiness";
import { formatList, parseList, sameMinute, toValidationInput, validationDraftFrom, type BiosValidationDraft } from "../validationDrafts";

export type BiosFeatureFieldDraft = {
	value: string;
	status: "candidate" | "confirmed";
	relativePath: string;
	contentHash: string;
	workspaceId: string;
};

export function emptyFeatureFieldDraft(): BiosFeatureFieldDraft {
	return { value: "", status: "candidate", relativePath: "", contentHash: "", workspaceId: "" };
}

export type BiosFeatureForm = {
	featureId: string;
	originalRequirement: string;
	aliases: string;
	customer: BiosFeatureFieldDraft;
	productLine: BiosFeatureFieldDraft;
	acceptanceCriteria: string;
	relatedExperienceIds: string;
};

export function emptyFeatureForm(): BiosFeatureForm {
	return { featureId: "", originalRequirement: "", aliases: "", customer: emptyFeatureFieldDraft(), productLine: emptyFeatureFieldDraft(), acceptanceCriteria: "", relatedExperienceIds: "" };
}

/**
 * 字段草稿 → `FeatureFieldInput`。
 *
 * 返回 `undefined` = **省略该字段**（保持未知/不改动）；有值时按声明的确认程度写入，
 * 并带上可选的依据（相对路径 + 内容 hash + 工作区）。绝不为空值编造依据。
 */
export function toFeatureFieldInput(draft: BiosFeatureFieldDraft): FeatureFieldInput | undefined {
	const value = draft.value.trim();
	const hasEvidence = draft.relativePath.trim() !== "" || draft.contentHash.trim() !== "";
	if (value === "" && !hasEvidence) return undefined;
	return {
		value: value === "" ? null : value,
		status: draft.status,
		...(draft.relativePath.trim() === "" ? {} : { relativePath: draft.relativePath.trim() }),
		...(draft.contentHash.trim() === "" ? {} : { contentHash: draft.contentHash.trim() }),
		...(draft.workspaceId.trim() === "" ? {} : { workspaceId: draft.workspaceId.trim() }),
	};
}

function featureFieldDraftFrom(field: { value: string | null; status: string; evidence: readonly { relativePath?: string; contentHash?: string; workspaceId?: string }[] } | undefined): BiosFeatureFieldDraft {
	if (field === undefined) return emptyFeatureFieldDraft();
	const evidence = field.evidence[0];
	return {
		value: field.value ?? "",
		status: field.status === "confirmed" ? "confirmed" : "candidate",
		relativePath: evidence?.relativePath ?? "",
		contentHash: evidence?.contentHash ?? "",
		workspaceId: evidence?.workspaceId ?? "",
	};
}

export function featureFormFrom(record: FeatureRecord): BiosFeatureForm {
	return {
		featureId: record.id,
		originalRequirement: record.originalRequirement,
		aliases: formatList(record.aliases),
		customer: featureFieldDraftFrom(record.customer),
		productLine: featureFieldDraftFrom(record.productLine),
		acceptanceCriteria: formatList(record.acceptanceCriteria),
		relatedExperienceIds: formatList(record.relatedExperienceIds),
	};
}

export type FeatureDraftOutcome = { readonly ok: true; readonly value: FeatureDraft } | { readonly ok: false; readonly error: string };

export function toFeatureDraft(form: BiosFeatureForm): FeatureDraftOutcome {
	const featureId = form.featureId.trim();
	if (featureId === "") return { ok: false, error: "featureId" };
	const originalRequirement = form.originalRequirement.trim();
	if (originalRequirement === "") return { ok: false, error: "originalRequirement" };
	const customer = toFeatureFieldInput(form.customer);
	const productLine = toFeatureFieldInput(form.productLine);
	return {
		ok: true,
		value: {
			featureId,
			originalRequirement,
			aliases: parseList(form.aliases),
			...(customer === undefined ? {} : { customer }),
			...(productLine === undefined ? {} : { productLine }),
			acceptanceCriteria: parseList(form.acceptanceCriteria),
			relatedExperienceIds: parseList(form.relatedExperienceIds),
		},
	};
}

/** 需求**部分更新**：只提交用户可能改动的可编辑字段；空值的客户/产品线视为"不改动"。 */
export function toFeatureChanges(form: BiosFeatureForm): Partial<Omit<FeatureDraft, "featureId">> {
	const customer = toFeatureFieldInput(form.customer);
	const productLine = toFeatureFieldInput(form.productLine);
	return {
		...(form.originalRequirement.trim() === "" ? {} : { originalRequirement: form.originalRequirement.trim() }),
		aliases: parseList(form.aliases),
		...(customer === undefined ? {} : { customer }),
		...(productLine === undefined ? {} : { productLine }),
		acceptanceCriteria: parseList(form.acceptanceCriteria),
		relatedExperienceIds: parseList(form.relatedExperienceIds),
	};
}

/* ------------------------------------------------------------ 经验 */

export type BiosExperienceForm = {
	experienceId: string;
	problem: string;
	symptom: string;
	rootCause: string;
	solution: string;
	appliesWhen: string;
	doesNotApplyWhen: string;
	/** 仅新建时使用（服务端按来源项目核对授权）。 */
	sourceProjectId: string;
	featureId: string;
	validations: BiosValidationDraft[];
	/** 顶层来源证据（受影响文件/commit 等；空则不写入）。 */
	evidenceType: EvidenceSourceType | "none";
	evidenceRelativePath: string;
	evidenceCommit: string;
	evidenceContentHash: string;
	reuseLevel: ReuseScope["level"];
	/** 跨客户复用时的客户列表（文本，多行/逗号分隔）。 */
	reuseCustomers: string;
	/** 跨客户复用的显式授权说明；缺失即未授权。 */
	reuseAuthorization: string;
};

export function emptyExperienceForm(now: number): BiosExperienceForm {
	return {
		experienceId: "",
		problem: "",
		symptom: "",
		rootCause: "",
		solution: "",
		appliesWhen: "",
		doesNotApplyWhen: "",
		sourceProjectId: "",
		featureId: "",
		validations: [],
		evidenceType: "none",
		evidenceRelativePath: "",
		evidenceCommit: "",
		evidenceContentHash: "",
		reuseLevel: "current-project",
		reuseCustomers: "",
		reuseAuthorization: "",
	};
}

export function experienceFormFrom(card: ExperienceCard): BiosExperienceForm {
	const evidence = card.evidence[0];
	return {
		experienceId: card.id,
		problem: card.problem,
		symptom: card.symptom ?? "",
		rootCause: card.rootCause,
		solution: card.solution,
		appliesWhen: formatList(card.appliesWhen),
		doesNotApplyWhen: formatList(card.doesNotApplyWhen),
		sourceProjectId: card.sourceProjectId,
		featureId: card.featureId ?? "",
		validations: card.validations.map((record) => validationDraftFrom(record)),
		evidenceType: evidence?.type ?? "none",
		evidenceRelativePath: evidence?.relativePath ?? "",
		evidenceCommit: evidence?.commit ?? "",
		evidenceContentHash: evidence?.contentHash ?? "",
		reuseLevel: card.reuseScope.level,
		reuseCustomers: formatList(card.reuseScope.customers),
		reuseAuthorization: card.reuseScope.authorization ?? "",
	};
}

export type ExperienceDraftOutcome = { readonly ok: true; readonly value: ExperienceDraft } | { readonly ok: false; readonly error: string };

function collectValidations(form: BiosExperienceForm): ExperienceValidationInput[] | { readonly error: string } {
	const converted: ExperienceValidationInput[] = [];
	for (const [index, draft] of form.validations.entries()) {
		const outcome = toValidationInput(draft);
		if (!outcome.ok) return { error: `${index + 1}:${outcome.error}` };
		converted.push(outcome.value);
	}
	return converted;
}

/** 表单 → 经验草稿（新建）。来源项目必须显式给出，由服务端核对授权。 */
export function toExperienceDraft(form: BiosExperienceForm): ExperienceDraftOutcome {
	const experienceId = form.experienceId.trim();
	if (experienceId === "") return { ok: false, error: "experienceId" };
	const problem = form.problem.trim();
	if (problem === "") return { ok: false, error: "problem" };
	const rootCause = form.rootCause.trim();
	if (rootCause === "") return { ok: false, error: "rootCause" };
	const solution = form.solution.trim();
	if (solution === "") return { ok: false, error: "solution" };
	const sourceProjectId = form.sourceProjectId.trim();
	if (sourceProjectId === "") return { ok: false, error: "sourceProjectId" };
	const validations = collectValidations(form);
	if (!Array.isArray(validations)) return { ok: false, error: `validation${validations.error}` };
	const evidence = collectEvidence(form);
	return {
		ok: true,
		value: {
			experienceId,
			problem,
			rootCause,
			solution,
			...(form.symptom.trim() === "" ? {} : { symptom: form.symptom.trim() }),
			appliesWhen: parseList(form.appliesWhen),
			doesNotApplyWhen: parseList(form.doesNotApplyWhen),
			sourceProjectId,
			...(form.featureId.trim() === "" ? {} : { featureId: form.featureId.trim() }),
			...(validations.length === 0 ? {} : { validations }),
			...(evidence === undefined ? {} : { evidence }),
			reuse: toReuse(form),
		},
	};
}

/** 表单 → **部分更新**（不含 experienceId/sourceProjectId：归属改动不在编辑路径里做）。 */
export function toExperienceChanges(form: BiosExperienceForm): Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">> | { readonly error: string } {
	const problem = form.problem.trim();
	const rootCause = form.rootCause.trim();
	const solution = form.solution.trim();
	if (problem === "") return { error: "problem" };
	if (rootCause === "") return { error: "rootCause" };
	if (solution === "") return { error: "solution" };
	const validations = collectValidations(form);
	if (!Array.isArray(validations)) return { error: `validation${validations.error}` };
	const evidence = collectEvidence(form);
	return {
		problem,
		rootCause,
		solution,
		symptom: form.symptom.trim() === "" ? undefined : form.symptom.trim(),
		appliesWhen: parseList(form.appliesWhen),
		doesNotApplyWhen: parseList(form.doesNotApplyWhen),
		featureId: form.featureId.trim() === "" ? undefined : form.featureId.trim(),
		validations,
		...(evidence === undefined ? {} : { evidence }),
		reuse: toReuse(form),
	};
}

/** 复用范围：跨客户时把显式授权说明一并带上；缺失即未授权（core 按最窄范围处理）。 */
function toReuse(form: BiosExperienceForm): ExperienceDraft["reuse"] {
	const customers = parseList(form.reuseCustomers);
	return { level: form.reuseLevel, ...(customers.length === 0 ? {} : { customers }), ...(form.reuseAuthorization.trim() === "" ? {} : { authorization: form.reuseAuthorization.trim() }) };
}

function collectEvidence(form: BiosExperienceForm) {
	const relativePath = form.evidenceRelativePath.trim();
	const commit = form.evidenceCommit.trim();
	const contentHash = form.evidenceContentHash.trim();
	if (form.evidenceType === "none") return undefined;
	if (relativePath === "" && commit === "" && contentHash === "") return undefined;
	return [{ type: form.evidenceType as EvidenceSourceType, ...(relativePath === "" ? {} : { relativePath }), ...(commit === "" ? {} : { commit }), ...(contentHash === "" ? {} : { contentHash }) }];
}

/** 未保存检测：表单与已保存卡片是否语义一致（不做自动合并，也不因写法差异误报）。 */
export function experienceFormMatchesCard(form: BiosExperienceForm, card: ExperienceCard): boolean {
	const outcome = toExperienceChanges(form);
	if ("error" in outcome) return false;
	const changes = outcome;
	if (changes.problem !== card.problem || changes.rootCause !== card.rootCause || changes.solution !== card.solution) return false;
	if ((changes.symptom ?? "") !== (card.symptom ?? "")) return false;
	if (formatList(changes.appliesWhen ?? []) !== formatList(card.appliesWhen)) return false;
	if (formatList(changes.doesNotApplyWhen ?? []) !== formatList(card.doesNotApplyWhen)) return false;
	if ((changes.featureId ?? "") !== (card.featureId ?? "")) return false;
	const currentEvidence = changes.evidence?.[0];
	const savedEvidence = card.evidence[0];
	if (currentEvidence === undefined || savedEvidence === undefined) {
		if (!(currentEvidence === undefined && savedEvidence === undefined)) return false;
	} else if (currentEvidence.type !== savedEvidence.type || (currentEvidence.relativePath ?? "") !== (savedEvidence.relativePath ?? "") || (currentEvidence.commit ?? "") !== (savedEvidence.commit ?? "") || (currentEvidence.contentHash ?? "") !== (savedEvidence.contentHash ?? "")) {
		return false;
	}
	if ((changes.reuse?.level ?? "current-project") !== card.reuseScope.level) return false;
	if (formatList(changes.reuse?.customers ?? []) !== formatList(card.reuseScope.customers)) return false;
	if ((changes.reuse?.authorization ?? "") !== (card.reuseScope.authorization ?? "")) return false;
	if ((changes.validations?.length ?? 0) !== card.validations.length) return false;
	return form.validations.every((draft, index) => {
		const produced = toValidationInput(draft);
		if (!produced.ok) return false;
		const saved = card.validations[index];
		// 时间按**分钟**比较：表单只能表达分钟，直接比毫秒会把所有带秒的记录误判成"已修改"。
		return produced.value.kind === saved.kind && produced.value.scope === saved.scope && produced.value.result === saved.result && sameMinute(produced.value.performedAt, saved.performedAt) && produced.value.performedBy === saved.performedBy;
	});
}
