/**
 * BM-07B B-05：**经验卡**区（按 ID 打开 / 新建草稿 / 编辑 / 人工审核）。
 *
 * 铁律（计划 §B-05 第 5～6 条）：
 * - 审核只走 `reviewExperience` 支持的五个动作；**没有**"直接把 status 写成 verified"的入口；
 * - 危险动作（approve / deprecate / restore）二次确认，并带**真实 expectedRevision**；
 * - 展示原状态、动作后状态、理由、声明标签、审计事件与 journal 结果；
 * - 任务 done、模型说完成、测试框架绿灯都**不**自动批准经验（界面上写明）。
 */
import { memo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { t } from "../../../i18n";
import type { AuditAction } from "../../../../../shared/types/biosBusiness";
import type { BiosKnowledge } from "../../../hooks/useBiosKnowledge";
import { BiosExperienceForm } from "./BiosExperienceForm";

const INPUT_CLASS = "h-7 w-full text-[12px]";

/** 五个审核动作与"是否危险"（危险动作改的是对外结论，必须二次确认）。 */
const ACTIONS: readonly { action: AuditAction; danger: boolean }[] = [
	{ action: "submit-review", danger: false },
	{ action: "request-changes", danger: false },
	{ action: "approve", danger: true },
	{ action: "deprecate", danger: true },
	{ action: "restore", danger: true },
];

export const BiosExperiencePane = memo(function BiosExperiencePane(props: { knowledge: BiosKnowledge; knownExperienceIds: readonly string[]; defaultSourceProjectId: string | null; onDirtyChange: (dirty: boolean) => void; onOpenReference: (experienceId: string) => void }) {
	const { knowledge } = props;
	const [draftId, setDraftId] = useState("");
	const [mode, setMode] = useState<"view" | "create" | "edit">("view");
	const [action, setAction] = useState<AuditAction>("submit-review");
	const [reason, setReason] = useState("");
	const [operatorLabel, setOperatorLabel] = useState("");
	const [confirming, setConfirming] = useState(false);
	const busy = knowledge.busy !== null;
	const detail = knowledge.experienceDetail;
	const card = detail?.card ?? null;
	const outcome = knowledge.experienceOutcome;
	const review = knowledge.reviewOutcome;
	const conflicted = outcome?.status === "revision-conflict";
	const selectedAction = ACTIONS.find((entry) => entry.action === action) ?? ACTIONS[0];
	const confirmBlocked = busy || card === null || reason.trim() === "";

	function submitReview() {
		if (card === null || detail === null) return;
		void knowledge.reviewExperience(card.id, detail.revision ?? 0, action, reason.trim(), operatorLabel);
	}

	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.knowledge.experience.title")}</div>
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.hint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{props.knownExperienceIds.length > 0 ? (
						<Select value={draftId === "" ? "__manual__" : draftId} onValueChange={(value) => setDraftId(value === "__manual__" ? "" : value)}>
							<SelectTrigger aria-label={t("bios.workbench.knowledge.experience.candidates")} className={`${INPUT_CLASS} w-56`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__manual__">{t("bios.workbench.project.manualInput")}</SelectItem>
								{props.knownExperienceIds.map((experienceId) => (
									<SelectItem key={experienceId} value={experienceId}>
										{experienceId}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null}
					<Input aria-label={t("bios.workbench.knowledge.experience.experienceId")} className={`${INPUT_CLASS} min-w-40 flex-1`} placeholder={t("bios.workbench.knowledge.experience.experienceIdPlaceholder")} value={draftId} onChange={(event) => setDraftId(event.target.value)} />
					<Button size="sm" disabled={busy} onClick={() => void knowledge.loadExperience(draftId)}>
						{t("bios.workbench.knowledge.experience.open")}
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setMode("create");
							props.onDirtyChange(false);
						}}
					>
						{t("bios.workbench.knowledge.experience.new")}
					</Button>
				</div>
			</section>

			{outcome !== null ? (
				<section className={conflicted ? "rounded-md border border-destructive/60 p-3" : "rounded-md border border-border p-3"}>
					<div className={conflicted ? "text-destructive" : "text-text-muted"}>{t("bios.workbench.task.writeStatus", { status: outcome.status })}</div>
					<div className="break-all text-text-muted">{t("bios.workbench.task.writeChanged", { fields: outcome.changedFields.join("、") || "-" })}</div>
					{conflicted ? <div className="text-destructive">{t("bios.workbench.task.conflictHint", { revision: outcome.actualRevision ?? "-" })}</div> : null}
					{outcome.status_after !== null ? <div className="text-text-muted">{t("bios.workbench.knowledge.experience.statusAfter", { status: outcome.status_after })}</div> : null}
					{outcome.needsReview.map((line) => (
						<div key={line} className="break-all text-text-muted">
							{line}
						</div>
					))}
					{outcome.problems.map((line) => (
						<div key={line} className="break-all text-destructive">
							{line}
						</div>
					))}
				</section>
			) : null}

			{mode === "create" ? (
				<BiosExperienceForm
					key="experience-create"
					mode="create"
					baseline={null}
					defaultSourceProjectId={props.defaultSourceProjectId}
					busy={busy}
					onDirtyChange={props.onDirtyChange}
					onCancel={() => {
						setMode("view");
						props.onDirtyChange(false);
					}}
					onCreate={(draft) =>
						void knowledge.createExperience(draft).then((result) => {
							if (result?.result.status === "created") {
								setDraftId(draft.experienceId);
								setMode("view");
								props.onDirtyChange(false);
							}
						})
					}
				/>
			) : null}

			{mode === "edit" && card !== null ? (
				<BiosExperienceForm
					key={`experience-edit:${card.id}`}
					mode="edit"
					baseline={card}
					defaultSourceProjectId={props.defaultSourceProjectId}
					busy={busy}
					onDirtyChange={props.onDirtyChange}
					onCancel={() => {
						setMode("view");
						props.onDirtyChange(false);
					}}
					onSave={(changes) =>
						void knowledge.updateExperience(card.id, detail?.revision ?? 0, changes).then((result) => {
							if (result?.result.status === "updated" || result?.result.status === "unchanged") {
								setMode("view");
								props.onDirtyChange(false);
							}
						})
					}
				/>
			) : null}

			{detail !== null && mode === "view" ? (
				<section className="flex flex-col gap-1 rounded-md border border-border p-3">
					<div className="flex flex-wrap items-center justify-between gap-2">
						<span className="font-medium">{t("bios.workbench.knowledge.experience.detailTitle")}</span>
						{card !== null ? (
							<div className="flex gap-2">
								{/* 只读状态：draft 才能编辑（reviewed/verified 必须先 request-changes 回草稿）。 */}
								{card.status === "draft" ? (
									<Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("edit")}>
										{t("bios.workbench.task.edit")}
									</Button>
								) : (
									<span className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.editOnlyDraft")}</span>
								)}
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => props.onOpenReference(card.id)}>
									{t("bios.workbench.knowledge.experience.openReference")}
								</Button>
							</div>
						) : null}
					</div>
					{card === null ? (
						<div className="break-all text-text-muted">{t("bios.workbench.knowledge.experience.unavailable", { status: detail.status })}</div>
					) : (
						<>
							<div className="break-all">{`${card.id} @${detail.revision ?? "-"}｜${t("bios.workbench.task.status")} ${card.status}`}</div>
							<div className="break-all">{`${t("bios.workbench.knowledge.reference.problem")}：${card.problem}`}</div>
							{card.symptom === undefined ? null : <div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.reference.symptom")}：${card.symptom}`}</div>}
							<div className="break-all">{`${t("bios.workbench.knowledge.reference.rootCause")}：${card.rootCause}`}</div>
							<div className="break-all">{`${t("bios.workbench.knowledge.reference.solution")}：${card.solution}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.reference.appliesWhen")}：${card.appliesWhen.join("；") || "-"}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.reference.doesNotApplyWhen")}：${card.doesNotApplyWhen.join("；") || "-"}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.reference.sourceProject")}：${card.sourceProjectId}${card.featureId === undefined ? "" : `｜feature ${card.featureId}`}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.experience.reuse")}：${card.reuseScope.level}${card.reuseScope.customers.length === 0 ? "" : `：${card.reuseScope.customers.join("、")}`}${card.reuseScope.authorization === undefined ? `（${t("bios.workbench.knowledge.reference.reuseUnauthorized")}）` : ""}`}</div>
							{card.reviewer === undefined ? null : <div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.experience.reviewer")}：${card.reviewer}`}</div>}
							<div className="mt-1 font-medium">{t("bios.workbench.task.validations")}</div>
							<div className="text-[11px] text-text-muted">{t("bios.workbench.task.validationReadHint")}</div>
							{card.validations.length === 0 ? (
								<div className="text-text-muted">{t("bios.workbench.task.noValidation")}</div>
							) : (
								card.validations.map((validation, index) => (
									<div key={`${validation.kind}:${validation.performedAt}:${index}`} className="rounded border border-border p-1">
										<div className="break-all">{`${validation.kind}｜${validation.result}｜${validation.scope}`}</div>
										<div className="break-all text-text-muted">{`${validation.performedBy}｜${new Date(validation.performedAt).toLocaleString()}${validation.evidence.length === 0 ? "" : `｜${validation.evidence.map((evidence) => `${evidence.type}${evidence.relativePath === undefined ? "" : `:${evidence.relativePath}`}`).join("、")}`}`}</div>
									</div>
								))
							)}
							{card.evidence.length === 0 ? null : (
								<>
									<div className="mt-1 font-medium">{t("bios.workbench.knowledge.experience.sourceEvidence")}</div>
									{card.evidence.map((evidence, index) => (
										<div key={`${evidence.type}:${evidence.relativePath ?? index}`} className="break-all text-text-muted">{`${evidence.type}${evidence.relativePath === undefined ? "" : `：${evidence.relativePath}`}${evidence.commit === undefined ? "" : `@${evidence.commit}`}`}</div>
									))}
								</>
							)}
						</>
					)}
					{detail.problems.map((line) => (
						<div key={line} className="break-all text-destructive">
							{line}
						</div>
					))}
				</section>
			) : null}

			{card !== null && mode === "view" ? (
				<section className="flex flex-col gap-2 rounded-md border border-border p-3">
					<div className="font-medium">{t("bios.workbench.knowledge.experience.review")}</div>
					{/* 不添加"标记 verified"的任意写字段入口：只走状态机与证据规则。 */}
					<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.reviewHint")}</div>
					<div className="flex flex-wrap items-center gap-2">
						<Select value={action} onValueChange={(value) => setAction(value as AuditAction)}>
							<SelectTrigger aria-label={t("bios.workbench.knowledge.experience.review")} className={`${INPUT_CLASS} w-40`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{ACTIONS.map((entry) => (
									<SelectItem key={entry.action} value={entry.action}>
										{entry.action}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<Input aria-label={t("bios.workbench.knowledge.experience.reviewReason")} className={INPUT_CLASS} placeholder={t("bios.workbench.knowledge.experience.reviewReason")} value={reason} onChange={(event) => setReason(event.target.value)} />
						<Input aria-label={t("bios.workbench.confirm.operator")} className={INPUT_CLASS} placeholder={t("bios.workbench.confirm.operatorPlaceholder")} value={operatorLabel} onChange={(event) => setOperatorLabel(event.target.value)} />
						<Button size="sm" variant={selectedAction.danger ? "destructive" : "default"} disabled={confirmBlocked} onClick={() => (selectedAction.danger ? setConfirming(true) : submitReview())}>
							{t("bios.workbench.knowledge.experience.reviewRun")}
						</Button>
					</div>
					<div className="break-all text-[11px] text-text-muted">{t("bios.workbench.knowledge.experience.reviewExpected", { status: card.status, revision: detail?.revision ?? "-" })}</div>
					{review !== null ? (
						<div className="flex flex-col gap-1 border-t border-border pt-2">
							<div className={review.status === "applied" ? "text-text-muted" : "text-destructive"}>{t("bios.workbench.knowledge.experience.reviewResult", { status: review.status, from: card.status, to: review.stateAfter })}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.confirm.operator")}：${review.operatorLabel}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.experience.reviewJournal")}：${review.journal.state}｜${review.journal.relativePath}`}</div>
							{review.audit === null ? null : <div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.experience.reviewAudit")}：${review.audit.eventId}｜${review.audit.intentRelativePath}`}</div>}
							{review.needsReview.map((line) => (
								<div key={line} className="break-all text-text-muted">
									{line}
								</div>
							))}
						</div>
					) : null}
				</section>
			) : null}

			{confirming ? (
				<ConfirmDialog
					title={t("bios.workbench.knowledge.experience.confirmTitle", { action })}
					message={t("bios.workbench.knowledge.experience.confirmMessage", { status: card?.status ?? "-", action })}
					confirmLabel={t("bios.workbench.knowledge.experience.confirmRun")}
					danger
					onCancel={() => setConfirming(false)}
					onConfirm={() => {
						setConfirming(false);
						submitReview();
					}}
				/>
			) : null}
		</div>
	);
});
