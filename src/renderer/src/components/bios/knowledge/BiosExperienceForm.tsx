/**
 * BM-07B B-05：经验卡**新建/编辑草稿**表单。
 *
 * 铁律（计划 §B-05 第 2 条）：
 * - 未提供的事实**保持缺口**：不填就不写，绝不为"表单完整"补造 rootCause 或"已上板通过"；
 * - 只按现有 schema 录入：problem/symptom/rootCause/solution/appliesWhen/doesNotApplyWhen/
 *   sourceProjectId/featureId/validations/evidence/reuse；
 * - 复用范围默认**最窄**（`current-project`）；跨客户必须显式给授权说明（缺失即未授权）；
 * - 来源项目在新建时必填（由服务端核对授权），编辑时**不允许**改归属。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Textarea } from "../../ui-shadcn/textarea";
import { t } from "../../../i18n";
import type { ExperienceCard, ExperienceDraft, ReuseScope } from "../../../../../shared/types/biosBusiness";
import { BiosValidationEditor } from "../BiosValidationEditor";
import { EVIDENCE_TYPES, formatList, parseList } from "../validationDrafts";
import { emptyExperienceForm, experienceFormFrom, experienceFormMatchesCard, toExperienceChanges, toExperienceDraft, type BiosExperienceForm as FormValues } from "./biosKnowledgeDrafts";

const INPUT_CLASS = "h-7 w-full text-[12px]";

function Labeled(props: { label: string; children: React.ReactNode }) {
	return (
		<label className="flex flex-col gap-1 text-[11px] text-text-muted">
			{props.label}
			{props.children}
		</label>
	);
}

export const BiosExperienceForm = memo(function BiosExperienceForm(props: {
	mode: "create" | "edit";
	baseline: ExperienceCard | null;
	/** 当前项目：新建时预填来源项目（仍需服务端核对授权）。 */
	defaultSourceProjectId: string | null;
	/**
	 * 新建模式的**预填初值**（B-06 任务沉淀用：问题/验证记录来自已保存的任务）。
	 * 只影响初值，不影响校验；未给的字段一律留空（不补造根因/方案）。
	 */
	initial?: Partial<FormValues>;
	busy: boolean;
	onDirtyChange: (dirty: boolean) => void;
	onCancel: () => void;
	onCreate?: (draft: ExperienceDraft) => void;
	/** 编辑模式使用；新建模式忽略。前置校验先在这里做，组件只拿到合法变更。 */
	onSave?: (changes: Partial<Omit<ExperienceDraft, "experienceId" | "sourceProjectId">>) => void;
}) {
	const [form, setForm] = useState<FormValues>(() => (props.baseline === null ? { ...emptyExperienceForm(Date.now()), sourceProjectId: props.defaultSourceProjectId ?? "", ...props.initial } : experienceFormFrom(props.baseline)));
	const [error, setError] = useState<string | null>(null);

	const dirty = useMemo(() => {
		if (props.baseline === null) {
			return form.experienceId !== "" || form.problem !== "" || form.rootCause !== "" || form.solution !== "" || form.validations.length > 0;
		}
		return !experienceFormMatchesCard(form, props.baseline);
	}, [form, props.baseline]);
	useEffect(() => {
		props.onDirtyChange(dirty);
	}, [dirty, props]);

	function submit() {
		setError(null);
		if (props.mode === "create") {
			const outcome = toExperienceDraft(form);
			if (!outcome.ok) return setError(t("bios.workbench.knowledge.experience.errorField", { field: outcome.error }));
			props.onCreate?.(outcome.value);
			return;
		}
		const outcome = toExperienceChanges(form);
		if ("error" in outcome) return setError(t("bios.workbench.knowledge.experience.errorField", { field: outcome.error }));
		// 本表单只编辑第一条证据；已保存记录里的其余证据**原样保留**，不静默丢弃。
		const saved = props.baseline?.validations ?? [];
		const patched = {
			...outcome,
			validations: (outcome.validations ?? []).map((record, index) => {
				const extra = (saved[index]?.evidence ?? []).slice(1);
				return extra.length === 0 ? record : { ...record, evidence: [...(record.evidence ?? []), ...extra] };
			}),
		};
		props.onSave?.(patched);
	}

	return (
		<section className="flex flex-col gap-2 rounded-md border border-border p-3">
			<div className="font-medium">{props.mode === "create" ? t("bios.workbench.knowledge.experience.createTitle") : t("bios.workbench.knowledge.experience.editTitle")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.gapHint")}</div>

			{props.mode === "create" ? (
				<div className="flex flex-wrap gap-2">
					<Labeled label={t("bios.workbench.knowledge.experience.experienceId")}>
						<Input aria-label={t("bios.workbench.knowledge.experience.experienceId")} className={INPUT_CLASS} value={form.experienceId} onChange={(event) => setForm({ ...form, experienceId: event.target.value })} />
					</Labeled>
					<Labeled label={t("bios.workbench.knowledge.reference.sourceProject")}>
						<Input aria-label={t("bios.workbench.knowledge.reference.sourceProject")} className={INPUT_CLASS} value={form.sourceProjectId} onChange={(event) => setForm({ ...form, sourceProjectId: event.target.value })} />
					</Labeled>
				</div>
			) : (
				<div className="break-all text-[11px] text-text-muted">{`${t("bios.workbench.knowledge.experience.experienceId")}：${form.experienceId}｜${t("bios.workbench.knowledge.reference.sourceProject")}：${form.sourceProjectId}`}</div>
			)}

			<Labeled label={t("bios.workbench.knowledge.reference.problem")}>
				<Textarea aria-label={t("bios.workbench.knowledge.reference.problem")} className="min-h-14 text-[12px]" value={form.problem} onChange={(event) => setForm({ ...form, problem: event.target.value })} />
			</Labeled>
			<Labeled label={t("bios.workbench.knowledge.reference.symptom")}>
				<Textarea className="min-h-10 text-[12px]" value={form.symptom} onChange={(event) => setForm({ ...form, symptom: event.target.value })} />
			</Labeled>
			<Labeled label={t("bios.workbench.knowledge.reference.rootCause")}>
				<Textarea aria-label={t("bios.workbench.knowledge.reference.rootCause")} className="min-h-14 text-[12px]" value={form.rootCause} onChange={(event) => setForm({ ...form, rootCause: event.target.value })} />
			</Labeled>
			<Labeled label={t("bios.workbench.knowledge.reference.solution")}>
				<Textarea aria-label={t("bios.workbench.knowledge.reference.solution")} className="min-h-14 text-[12px]" value={form.solution} onChange={(event) => setForm({ ...form, solution: event.target.value })} />
			</Labeled>
			<div className="grid grid-cols-1 gap-2 md:grid-cols-2">
				<Labeled label={t("bios.workbench.knowledge.reference.appliesWhen")}>
					<Textarea className="min-h-12 text-[12px]" value={form.appliesWhen} onChange={(event) => setForm({ ...form, appliesWhen: event.target.value })} />
				</Labeled>
				<Labeled label={t("bios.workbench.knowledge.reference.doesNotApplyWhen")}>
					<Textarea className="min-h-12 text-[12px]" value={form.doesNotApplyWhen} onChange={(event) => setForm({ ...form, doesNotApplyWhen: event.target.value })} />
				</Labeled>
			</div>
			<Labeled label={t("bios.workbench.knowledge.experience.featureId")}>
				<Input aria-label={t("bios.workbench.knowledge.experience.featureId")} className={INPUT_CLASS} value={form.featureId} onChange={(event) => setForm({ ...form, featureId: event.target.value })} />
			</Labeled>

			{/* 顶层来源证据：受影响文件 / commit（空则不写入，不编造 hash）。 */}
			<div className="rounded border border-border p-2">
				<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.sourceEvidence")}</div>
				<div className="mt-1 flex flex-wrap items-center gap-2">
					<Select value={form.evidenceType} onValueChange={(value) => setForm({ ...form, evidenceType: value as FormValues["evidenceType"] })}>
						<SelectTrigger aria-label={t("bios.workbench.task.evidenceType")} className={`${INPUT_CLASS} w-36`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="none">{t("bios.workbench.task.evidenceNone")}</SelectItem>
							{EVIDENCE_TYPES.map((type) => (
								<SelectItem key={type} value={type}>
									{type}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					{form.evidenceType === "none" ? null : (
						<>
							<Input aria-label={t("bios.workbench.task.evidencePath")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidencePath")} value={form.evidenceRelativePath} onChange={(event) => setForm({ ...form, evidenceRelativePath: event.target.value })} />
							<Input aria-label={t("bios.workbench.task.evidenceCommit")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceCommit")} value={form.evidenceCommit} onChange={(event) => setForm({ ...form, evidenceCommit: event.target.value })} />
							<Input aria-label={t("bios.workbench.task.evidenceHash")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceHash")} value={form.evidenceContentHash} onChange={(event) => setForm({ ...form, evidenceContentHash: event.target.value })} />
						</>
					)}
				</div>
			</div>

			{/* 复用范围：默认最窄；跨客户必须显式写授权说明。 */}
			<div className="rounded border border-border p-2">
				<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.reuse")}</div>
				<div className="mt-1 flex flex-wrap items-center gap-2">
					<Select value={form.reuseLevel} onValueChange={(value) => setForm({ ...form, reuseLevel: value as ReuseScope["level"] })}>
						<SelectTrigger aria-label={t("bios.workbench.knowledge.experience.reuseLevel")} className={`${INPUT_CLASS} w-40`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="current-project">current-project</SelectItem>
							<SelectItem value="customer">customer</SelectItem>
							<SelectItem value="internal-general">internal-general</SelectItem>
						</SelectContent>
					</Select>
					<Input aria-label={t("bios.workbench.knowledge.experience.reuseCustomers")} className={INPUT_CLASS} placeholder={t("bios.workbench.knowledge.experience.reuseCustomers")} value={form.reuseCustomers} onChange={(event) => setForm({ ...form, reuseCustomers: event.target.value })} />
					<Input aria-label={t("bios.workbench.knowledge.experience.reuseAuthorization")} className={INPUT_CLASS} placeholder={t("bios.workbench.knowledge.experience.reuseAuthorization")} value={form.reuseAuthorization} onChange={(event) => setForm({ ...form, reuseAuthorization: event.target.value })} />
				</div>
				{form.reuseLevel !== "current-project" && form.reuseAuthorization.trim() === "" ? <div className="mt-1 text-[11px] text-destructive">{t("bios.workbench.knowledge.experience.reuseUnauthorizedHint")}</div> : null}
			</div>

			<BiosValidationEditor validations={form.validations} busy={props.busy} hasExtraEvidence={(props.baseline?.validations ?? []).some((record) => record.evidence.length > 1)} onChange={(validations) => setForm({ ...form, validations })} />

			<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.preview", { keywords: formatList(parseList(form.appliesWhen)) || "-", validations: form.validations.length })}</div>
			{error !== null ? <div className="break-all text-destructive">{error}</div> : null}
			<div className="flex flex-wrap gap-2">
				<Button size="sm" disabled={props.busy} onClick={submit}>
					{props.mode === "create" ? t("bios.workbench.knowledge.experience.create") : t("bios.workbench.knowledge.experience.save")}
				</Button>
				<Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
					{t("bios.workbench.task.cancelEdit")}
				</Button>
			</div>
		</section>
	);
});
