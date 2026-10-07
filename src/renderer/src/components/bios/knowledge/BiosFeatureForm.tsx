/**
 * BM-07B B-05：客户需求**新建/编辑**表单。
 *
 * 约定：
 * - 只录入 v1 契约里的字段：原始要求、别名、客户/产品线（值 + 确认程度 + 依据）、
 *   验收条件、关联经验；**不新增沿革/发布状态**；
 * - 空值保持未知：不填的客户/产品线**不提交**（不改动、不猜）；
 * - 需求**没有项目归属**：跨客户可见性靠 `allowedFeatureIds` / `approvedCustomers`（在设置里显式办理）。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { Textarea } from "../../ui-shadcn/textarea";
import { t } from "../../../i18n";
import type { FeatureDraft, FeatureRecord } from "../../../../../shared/types/biosBusiness";
import { emptyFeatureFieldDraft, emptyFeatureForm, featureFormFrom, toFeatureChanges, toFeatureDraft, toFeatureFieldInput, type BiosFeatureFieldDraft, type BiosFeatureForm as FeatureFormValues } from "./biosKnowledgeDrafts";
import { formatList, parseList } from "../validationDrafts";

const INPUT_CLASS = "h-7 w-full text-[12px]";

function FieldRow(props: { label: string; draft: BiosFeatureFieldDraft; onChange: (next: BiosFeatureFieldDraft) => void; busy: boolean }) {
	const { draft, onChange } = props;
	return (
		<div className="rounded border border-border p-2">
			<div className="text-[11px] text-text-muted">{props.label}</div>
			<div className="mt-1 flex flex-wrap items-center gap-2">
				<Input aria-label={props.label} className={INPUT_CLASS} placeholder={t("bios.workbench.knowledge.feature.fieldValue")} value={draft.value} onChange={(event) => onChange({ ...draft, value: event.target.value })} />
				<Select value={draft.status} onValueChange={(value) => onChange({ ...draft, status: value as BiosFeatureFieldDraft["status"] })}>
					<SelectTrigger aria-label={t("bios.workbench.knowledge.feature.fieldStatus")} className={`${INPUT_CLASS} w-32`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="candidate">candidate</SelectItem>
						<SelectItem value="confirmed">confirmed</SelectItem>
					</SelectContent>
				</Select>
				<Input aria-label={t("bios.workbench.task.evidencePath")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidencePath")} value={draft.relativePath} onChange={(event) => onChange({ ...draft, relativePath: event.target.value })} />
				<Input aria-label={t("bios.workbench.task.evidenceHash")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceHash")} value={draft.contentHash} onChange={(event) => onChange({ ...draft, contentHash: event.target.value })} />
				<Input aria-label={t("bios.workbench.knowledge.feature.fieldWorkspace")} className={INPUT_CLASS} placeholder={t("bios.workbench.knowledge.feature.fieldWorkspace")} value={draft.workspaceId} onChange={(event) => onChange({ ...draft, workspaceId: event.target.value })} />
			</div>
			{/* 不填 = 保持未知；界面上写清楚，避免用户以为"空白等于确认过"。 */}
			<div className="mt-1 text-[10px] text-text-muted">{t("bios.workbench.knowledge.feature.fieldHint")}</div>
		</div>
	);
}

export const BiosFeatureForm = memo(function BiosFeatureForm(props: { mode: "create" | "edit"; baseline: FeatureRecord | null; busy: boolean; onDirtyChange: (dirty: boolean) => void; onCancel: () => void; onCreate?: (draft: FeatureDraft) => void; onSave?: (changes: ReturnType<typeof toFeatureChanges>) => void }) {
	const [form, setForm] = useState<FeatureFormValues>(() => (props.baseline === null ? { ...emptyFeatureForm(), customer: emptyFeatureFieldDraft(), productLine: emptyFeatureFieldDraft() } : featureFormFrom(props.baseline)));
	const [error, setError] = useState<string | null>(null);

	const dirty = useMemo(() => {
		const base = props.baseline;
		if (base === null) return form.featureId !== "" || form.originalRequirement !== "" || form.aliases !== "" || form.acceptanceCriteria !== "" || form.relatedExperienceIds !== "";
		const original = featureFormFrom(base);
		return (
			form.originalRequirement !== original.originalRequirement ||
			form.aliases !== original.aliases ||
			form.acceptanceCriteria !== original.acceptanceCriteria ||
			form.relatedExperienceIds !== original.relatedExperienceIds ||
			JSON.stringify(form.customer) !== JSON.stringify(original.customer) ||
			JSON.stringify(form.productLine) !== JSON.stringify(original.productLine)
		);
	}, [form, props.baseline]);
	useEffect(() => {
		props.onDirtyChange(dirty);
	}, [dirty, props]);

	function submit() {
		setError(null);
		if (props.mode === "create") {
			const outcome = toFeatureDraft(form);
			if (!outcome.ok) return setError(t("bios.workbench.knowledge.feature.errorField", { field: outcome.error }));
			props.onCreate?.(outcome.value);
			return;
		}
		if (form.originalRequirement.trim() === "") return setError(t("bios.workbench.knowledge.feature.errorField", { field: "originalRequirement" }));
		props.onSave?.(toFeatureChanges(form));
	}

	return (
		<section className="flex flex-col gap-2 rounded-md border border-border p-3">
			<div className="font-medium">{props.mode === "create" ? t("bios.workbench.knowledge.feature.createTitle") : t("bios.workbench.knowledge.feature.editTitle")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.feature.scopeHint")}</div>
			{props.mode === "create" ? (
				<label className="flex flex-col gap-1 text-[11px] text-text-muted">
					{t("bios.workbench.knowledge.feature.featureId")}
					<Input aria-label={t("bios.workbench.knowledge.feature.featureId")} className={INPUT_CLASS} value={form.featureId} onChange={(event) => setForm({ ...form, featureId: event.target.value })} />
				</label>
			) : (
				<div className="text-[11px] text-text-muted">{`${t("bios.workbench.knowledge.feature.featureId")}：${form.featureId}`}</div>
			)}
			<label className="flex flex-col gap-1 text-[11px] text-text-muted">
				{t("bios.workbench.knowledge.feature.originalRequirement")}
				<Textarea aria-label={t("bios.workbench.knowledge.feature.originalRequirement")} className="min-h-16 text-[12px]" value={form.originalRequirement} onChange={(event) => setForm({ ...form, originalRequirement: event.target.value })} />
			</label>
			<label className="flex flex-col gap-1 text-[11px] text-text-muted">
				{t("bios.workbench.knowledge.feature.aliases")}
				<Textarea className="min-h-10 text-[12px]" value={form.aliases} onChange={(event) => setForm({ ...form, aliases: event.target.value })} />
			</label>
			<FieldRow label={t("bios.workbench.knowledge.feature.customer")} draft={form.customer} busy={props.busy} onChange={(customer) => setForm({ ...form, customer })} />
			<FieldRow label={t("bios.workbench.knowledge.feature.productLine")} draft={form.productLine} busy={props.busy} onChange={(productLine) => setForm({ ...form, productLine })} />
			<label className="flex flex-col gap-1 text-[11px] text-text-muted">
				{t("bios.workbench.knowledge.feature.acceptanceCriteria")}
				<Textarea className="min-h-10 text-[12px]" value={form.acceptanceCriteria} onChange={(event) => setForm({ ...form, acceptanceCriteria: event.target.value })} />
			</label>
			<label className="flex flex-col gap-1 text-[11px] text-text-muted">
				{t("bios.workbench.knowledge.feature.relatedExperiences")}
				<Textarea className="min-h-10 text-[12px]" value={form.relatedExperienceIds} onChange={(event) => setForm({ ...form, relatedExperienceIds: event.target.value })} />
			</label>
			{/* 提交预览：让人一眼看到"哪些字段会被写入 / 哪些保持未知"。 */}
			<div className="text-[11px] text-text-muted">
				{t("bios.workbench.knowledge.feature.preview", {
					customer: toFeatureFieldInput(form.customer) === undefined ? t("bios.workbench.confirm.unknown") : form.customer.value.trim() || t("bios.workbench.confirm.unknown"),
					productLine: toFeatureFieldInput(form.productLine) === undefined ? t("bios.workbench.confirm.unknown") : form.productLine.value.trim() || t("bios.workbench.confirm.unknown"),
					aliases: formatList(parseList(form.aliases)) || "-",
				})}
			</div>
			{error !== null ? <div className="break-all text-destructive">{error}</div> : null}
			<div className="flex flex-wrap gap-2">
				<Button size="sm" disabled={props.busy} onClick={submit}>
					{props.mode === "create" ? t("bios.workbench.knowledge.feature.create") : t("bios.workbench.knowledge.feature.save")}
				</Button>
				<Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>
					{t("bios.workbench.task.cancelEdit")}
				</Button>
			</div>
		</section>
	);
});
