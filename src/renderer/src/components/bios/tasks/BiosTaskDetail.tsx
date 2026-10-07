/**
 * BM-07B B-04：任务详情（正文 + 验证记录 + 参考经验核对 + 状态推进 + 上下文选择）。
 *
 * 约定：
 * - 正文保存与**状态变更分开**：这里只能改状态，正文改走编辑表单；
 * - 状态机**不在渲染层复制**：可选目标只排除当前状态，合法性由 core 判定并如实回报
 *   （`illegal-transition` 会原样显示，不做前端猜测）；
 * - `done → in_progress` 是显式重开：必须给理由；验证记录**不会被清空**（界面明确写出）；
 * - "用于当前会话"是**显式动作**：走既有 selection/ACK 链路并展示回执；回执只属于当前任务。
 */
import { memo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { t, formatI18nDateTime } from "../../../i18n";
import type { BiosSelectionResult } from "../../../../../shared/types/bios";
import type { TaskDetailResult, TaskRecord, TaskStatusResult } from "../../../../../shared/types/biosBusiness";
import { TASK_STATUS_ORDER } from "./biosTaskDrafts";
import type { BiosTaskStatusFilter } from "../../../hooks/useBiosTasks";

const INPUT_CLASS = "h-7 w-full text-[12px]";

/** 正文列表字段与标签（显式列出，避免在 JSX 里用三元拼 key）。 */
const LIST_FIELDS: readonly { labelKey: "bios.workbench.task.todos" | "bios.workbench.task.blockers" | "bios.workbench.task.decisions" | "bios.workbench.task.relatedFiles" | "bios.workbench.task.sourceExperiences"; values: (task: TaskRecord) => readonly string[] }[] = [
	{ labelKey: "bios.workbench.task.todos", values: (task) => task.todos },
	{ labelKey: "bios.workbench.task.blockers", values: (task) => task.blockers },
	{ labelKey: "bios.workbench.task.decisions", values: (task) => task.decisions },
	{ labelKey: "bios.workbench.task.relatedFiles", values: (task) => task.relatedFiles },
	{ labelKey: "bios.workbench.task.sourceExperiences", values: (task) => task.sourceExperienceIds },
];

function Line(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2">
			<span className="shrink-0 text-text-muted">{props.label}</span>
			<span className="min-w-0 break-all">{props.children}</span>
		</div>
	);
}

export const BiosTaskDetail = memo(function BiosTaskDetail(props: {
	detail: TaskDetailResult;
	busy: boolean;
	statusOutcome: TaskStatusResult | null;
	selection: BiosSelectionResult | null;
	onEdit: () => void;
	/** B-06：进入"沉淀经验"（有限预填，人补根因/方案/边界后显式保存）。 */
	onSediment: () => void;
	onClose: () => void;
	onChangeStatus: (to: BiosTaskStatusFilter, reason: string) => void;
	onApplyContext: (enabled: boolean) => void;
}) {
	const [target, setTarget] = useState<BiosTaskStatusFilter>("in_progress");
	const [reason, setReason] = useState("");
	const task = props.detail.task;
	if (task === null) {
		return <section className="rounded-md border border-border p-3 text-text-muted">{t("bios.workbench.task.detailUnavailable", { status: props.detail.status })}</section>;
	}
	// 重开：从终态回到进行中，必须给理由。
	const reopening = task.status === "done" && target === "in_progress";

	return (
		<section className="flex flex-col gap-2 rounded-md border border-border p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">{t("bios.workbench.task.detailTitle")}</span>
				<div className="flex gap-2">
					<Button size="sm" variant="outline" disabled={props.busy} onClick={props.onEdit}>
						{t("bios.workbench.task.edit")}
					</Button>
					{/* 沉淀入口：从这里进入后由预填 + 人工补全构成草稿，不是"一键生成经验"。 */}
					<Button size="sm" variant="outline" disabled={props.busy} onClick={props.onSediment}>
						{t("bios.workbench.sediment.enter")}
					</Button>
					<Button size="sm" variant="ghost" disabled={props.busy} onClick={props.onClose}>
						{t("bios.workbench.task.closeDetail")}
					</Button>
				</div>
			</div>

			<Line label={t("bios.workbench.task.taskId")}>{task.id}</Line>
			<Line label={t("bios.workbench.task.revision")}>{`${props.detail.revision ?? "-"}`}</Line>
			<Line label={t("bios.workbench.task.status")}>{task.status}</Line>
			<Line label={t("bios.workbench.task.workspace")}>{`${task.workspace.workspaceId}（${task.workspace.path}）`}</Line>
			{/* 工作区不可达 ≠ 未授权：两者必须分开说明。 */}
			{!props.detail.workspaceAuthorized ? <div className="text-destructive">{t("bios.workbench.task.workspaceNotAuthorized")}</div> : null}
			<Line label={t("bios.workbench.task.updatedAt")}>{formatI18nDateTime(task.updatedAt)}</Line>
			<Line label={t("bios.workbench.task.requirement")}>{task.requirement}</Line>

			{LIST_FIELDS.map((entry) => (
				<div key={entry.labelKey} className="flex gap-2">
					<span className="shrink-0 text-text-muted">{t(entry.labelKey)}</span>
					<span className="min-w-0 whitespace-pre-wrap">
						{entry.values(task).length === 0
							? t("bios.workbench.task.none")
							: entry
									.values(task)
									.map((value) => `· ${value}`)
									.join("\n")}
					</span>
				</div>
			))}

			<div className="mt-1 font-medium">{t("bios.workbench.task.validations")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.task.validationReadHint")}</div>
			{task.validations.length === 0 ? (
				<div className="text-text-muted">{t("bios.workbench.task.noValidation")}</div>
			) : (
				task.validations.map((validation, index) => (
					<div key={`${validation.kind}:${validation.performedAt}:${index}`} className="rounded border border-border p-2">
						<Line label={validation.kind}>{`${validation.result}｜${validation.scope}`}</Line>
						<Line label={t("bios.workbench.task.validationBy")}>{`${validation.performedBy}｜${formatI18nDateTime(validation.performedAt)}`}</Line>
						{validation.evidence.length > 0 ? <Line label={t("bios.workbench.task.evidence")}>{validation.evidence.map((evidence) => `${evidence.type}${evidence.relativePath === undefined ? "" : `：${evidence.relativePath}`}${evidence.commit === undefined ? "" : `@${evidence.commit}`}`).join("\n")}</Line> : null}
					</div>
				))
			)}

			<div className="mt-1 font-medium">{t("bios.workbench.task.references")}</div>
			{props.detail.references.length === 0 ? (
				<div className="text-text-muted">{t("bios.workbench.task.noReference")}</div>
			) : (
				props.detail.references.map((reference) => (
					<div key={reference.experienceId} className={reference.usableAsBasis ? "text-text-muted" : "text-destructive"}>
						{`${reference.experienceId}｜${reference.found ? (reference.status ?? "-") : t("bios.workbench.task.referenceMissing")}｜${reference.usableAsBasis ? t("bios.workbench.task.referenceUsable") : t("bios.workbench.task.referenceNotUsable")}${reference.reason === null ? "" : `（${reference.reason}）`}`}
					</div>
				))
			)}
			{props.detail.problems.map((line) => (
				<div key={line} className="break-all text-destructive">
					{line}
				</div>
			))}

			<div className="mt-1 font-medium">{t("bios.workbench.task.statusChange")}</div>
			<div className="flex flex-wrap items-center gap-2">
				<Select value={target} onValueChange={(value) => setTarget(value as BiosTaskStatusFilter)}>
					<SelectTrigger aria-label={t("bios.workbench.task.statusChange")} className={INPUT_CLASS}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{TASK_STATUS_ORDER.filter((status) => status !== task.status).map((status) => (
							<SelectItem key={status} value={status}>
								{status}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
				<Input aria-label={t("bios.workbench.task.statusReason")} className={INPUT_CLASS} placeholder={t("bios.workbench.task.statusReason")} value={reason} onChange={(event) => setReason(event.target.value)} />
				<Button size="sm" disabled={props.busy || reason.trim() === ""} onClick={() => props.onChangeStatus(target, reason.trim())}>
					{reopening ? t("bios.workbench.task.reopen") : t("bios.workbench.task.applyStatus")}
				</Button>
			</div>
			{reopening ? <div className="text-[11px] text-text-muted">{t("bios.workbench.task.reopenHint")}</div> : null}
			{props.statusOutcome !== null ? (
				<div className="flex flex-col gap-1 border-t border-border pt-2">
					<Line label={t("bios.workbench.task.statusResult")}>{`${props.statusOutcome.status}${props.statusOutcome.from === null ? "" : `：${props.statusOutcome.from} → ${props.statusOutcome.to}`}`}</Line>
					{props.statusOutcome.actualRevision !== null && props.statusOutcome.status === "revision-conflict" ? <div className="text-destructive">{t("bios.workbench.task.conflictHint", { revision: props.statusOutcome.actualRevision })}</div> : null}
					{props.statusOutcome.needsReview.map((line) => (
						<div key={line} className="break-all text-text-muted">
							{line}
						</div>
					))}
					{props.statusOutcome.problems.map((line) => (
						<div key={line} className="break-all text-destructive">
							{line}
						</div>
					))}
				</div>
			) : null}

			<div className="mt-1 font-medium">{t("bios.workbench.task.context")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.task.contextHint")}</div>
			<div className="flex flex-wrap gap-2">
				<Button size="sm" disabled={props.busy} onClick={() => props.onApplyContext(true)}>
					{t("bios.workbench.task.contextOn")}
				</Button>
				<Button size="sm" variant="outline" disabled={props.busy} onClick={() => props.onApplyContext(false)}>
					{t("bios.workbench.task.contextOff")}
				</Button>
			</div>
			{props.selection !== null ? (
				<div className="flex flex-col gap-1">
					<Line label={t("bios.workbench.task.contextMode")}>{props.selection.mode}</Line>
					<Line label={t("bios.workbench.task.contextApplied")}>{String(props.selection.applied)}</Line>
					<Line label={t("bios.workbench.task.contextSynced")}>{String(props.selection.currentSessionSynced)}</Line>
					<Line label={t("bios.workbench.task.contextReceipt")}>{props.selection.receipt}</Line>
					{props.selection.reason !== null ? <div className="break-all text-destructive">{props.selection.reason}</div> : null}
					{!props.selection.currentSessionSynced ? <div className="text-destructive">{t("bios.workbench.task.contextNotSynced")}</div> : null}
				</div>
			) : null}
		</section>
	);
});
