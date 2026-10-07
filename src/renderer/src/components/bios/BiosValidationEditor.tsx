/**
 * BM-07B：**验证记录编辑器**（任务与经验卡共用）。
 *
 * 为什么共用：core 里任务验证与经验验证是同一套形状；B-04/B-05 各写一份必然出现
 * 两套字段与两套口径。这里只按现有 schema 录入类型/范围/结果/时间/执行者/证据，
 * **不为"表单更完整"扩张格式**，也不做任何"验证强度升级"。
 */
import { memo } from "react";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { t } from "../../i18n";
import { EVIDENCE_TYPES, VALIDATION_KINDS, VALIDATION_RESULTS, emptyValidationDraft, type BiosValidationDraft } from "./validationDrafts";

const INPUT_CLASS = "h-7 w-full text-[12px]";

export const BiosValidationEditor = memo(function BiosValidationEditor(props: {
	validations: readonly BiosValidationDraft[];
	busy: boolean;
	/** 已保存记录里存在多条证据（本表单只编辑第一条，其余原样保留）。 */
	hasExtraEvidence: boolean;
	onChange: (next: BiosValidationDraft[]) => void;
}) {
	function patchAt(index: number, next: Partial<BiosValidationDraft>) {
		props.onChange(props.validations.map((draft, at) => (at === index ? { ...draft, ...next } : draft)));
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center justify-between gap-2">
				<span className="text-text-muted">{t("bios.workbench.task.validations")}</span>
				<Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onChange([...props.validations, emptyValidationDraft(Date.now())])}>
					{t("bios.workbench.task.addValidation")}
				</Button>
			</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.task.validationHint")}</div>
			{props.hasExtraEvidence ? <div className="text-[11px] text-destructive">{t("bios.workbench.task.extraEvidenceHint")}</div> : null}
			{props.validations.map((draft, index) => (
				<div key={`validation-${index}`} className="flex flex-col gap-1 rounded border border-border p-2">
					<div className="flex flex-wrap items-center gap-2">
						<Select value={draft.kind} onValueChange={(value) => patchAt(index, { kind: value as BiosValidationDraft["kind"] })}>
							<SelectTrigger aria-label={t("bios.workbench.task.validationKind")} className={INPUT_CLASS}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{VALIDATION_KINDS.map((kind) => (
									<SelectItem key={kind} value={kind}>
										{kind}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Select value={draft.result} onValueChange={(value) => patchAt(index, { result: value as BiosValidationDraft["result"] })}>
							<SelectTrigger aria-label={t("bios.workbench.task.validationResult")} className={INPUT_CLASS}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{VALIDATION_RESULTS.map((result) => (
									<SelectItem key={result} value={result}>
										{result}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input aria-label={t("bios.workbench.task.validationScope")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.validationScope")} value={draft.scope} onChange={(event) => patchAt(index, { scope: event.target.value })} />
						<Input aria-label={t("bios.workbench.task.validationBy")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.validationBy")} value={draft.performedBy} onChange={(event) => patchAt(index, { performedBy: event.target.value })} />
						<Input aria-label={t("bios.workbench.task.validationAt")} className={INPUT_CLASS} type="datetime-local" value={draft.performedAtLocal} onChange={(event) => patchAt(index, { performedAtLocal: event.target.value })} />
						<Button size="sm" variant="ghost" disabled={props.busy} onClick={() => props.onChange(props.validations.filter((_draft, at) => at !== index))}>
							{t("bios.workbench.task.removeValidation")}
						</Button>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<Select value={draft.evidenceType} onValueChange={(value) => patchAt(index, { evidenceType: value as BiosValidationDraft["evidenceType"] })}>
							<SelectTrigger aria-label={t("bios.workbench.task.evidenceType")} className={INPUT_CLASS}>
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
						{draft.evidenceType === "none" ? null : (
							<>
								<Input aria-label={t("bios.workbench.task.evidencePath")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidencePath")} value={draft.evidenceRelativePath} onChange={(event) => patchAt(index, { evidenceRelativePath: event.target.value })} />
								<Input aria-label={t("bios.workbench.task.evidenceHash")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceHash")} value={draft.evidenceContentHash} onChange={(event) => patchAt(index, { evidenceContentHash: event.target.value })} />
								<Input aria-label={t("bios.workbench.task.evidenceCommit")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceCommit")} value={draft.evidenceCommit} onChange={(event) => patchAt(index, { evidenceCommit: event.target.value })} />
								<Input aria-label={t("bios.workbench.task.evidenceLocation")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.evidenceLocation")} value={draft.evidenceLocation} onChange={(event) => patchAt(index, { evidenceLocation: event.target.value })} />
							</>
						)}
					</div>
				</div>
			))}
		</div>
	);
});
