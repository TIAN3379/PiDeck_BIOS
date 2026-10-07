/**
 * BM-07B B-05：**跨项目经验参考**详情（复用 `readExperienceReference`）。
 *
 * 三条硬要求（计划 §B-05 第 4 条）：
 * - 源板的验证**永远不显示成目标板已验证**：这里只呈现"源板声明过的验证"，
 *   并在同一屏内写明本次为**只作参考**、需要移植复核；
 * - `current` / `reference` / `needs-review` / `conflict` / `history` / `excluded` 用徽标与文案区分；
 * - 授权不覆盖时 core 返回 `not-found`/`not-recommended`：界面如实说明，不补造内容。
 */
import { memo } from "react";
import { Button } from "../../ui-shadcn/button";
import { t } from "../../../i18n";
import type { ReferenceView } from "../../../../../shared/types/biosBusiness";
import { BiosClassBadge } from "./BiosClassBadge";

function Field(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2">
			<span className="shrink-0 text-text-muted">{props.label}</span>
			<span className="min-w-0 break-all">{props.children}</span>
		</div>
	);
}

export const BiosReferenceCard = memo(function BiosReferenceCard(props: { reference: ReferenceView; loading: boolean; canAddToTaskReference?: boolean; onAddToTaskReference?: (experienceId: string) => void }) {
	const view = props.reference;
	if (view.reference === null) {
		return (
			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.knowledge.reference.title")}</div>
				<div className="mt-1 break-all text-text-muted">{t("bios.workbench.knowledge.reference.unavailable", { status: view.status })}</div>
				{view.reasons.map((reason) => (
					<div key={reason} className="break-all text-text-muted">
						{reason}
					</div>
				))}
				{view.problems.map((line) => (
					<div key={line} className="break-all text-destructive">
						{line}
					</div>
				))}
			</section>
		);
	}
	const reference = view.reference;
	return (
		<section className="flex flex-col gap-1 rounded-md border border-border p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="font-medium">{t("bios.workbench.knowledge.reference.title")}</span>
				<BiosClassBadge value={view.recommendation ?? "unknown"} reasons={view.reasons} />
				<span className="text-text-muted">{`${view.recordId} @${view.revision ?? "-"}`}</span>
			</div>
			{/* 只作参考：本批不执行移植/构建/刷板，源板验证不等于目标板已验证。 */}
			<div className="rounded border border-border p-2 text-[11px]">
				<div className="text-text-muted">{t("bios.workbench.knowledge.reference.portingNote")}</div>
				{view.porting.needsPortingReview ? <div className="text-destructive">{t("bios.workbench.knowledge.reference.needsPortingReview")}</div> : null}
				{view.porting.reasons.map((reason) => (
					<div key={reason} className="break-all text-text-muted">
						{reason}
					</div>
				))}
			</div>
			{/* B-06：人工选择"加入任务参考"——只更新引用 ID，不复制补丁、不改项目身份，
			    也不把参考批准成目标板事实（能否作依据仍由 core 的 usableAsBasis 判定）。 */}
			<div className="flex flex-wrap items-center gap-2 rounded border border-border p-2 text-[11px]">
				<Button size="sm" variant="outline" disabled={props.loading || props.canAddToTaskReference !== true} onClick={() => props.onAddToTaskReference?.(view.recordId)}>
					{t("bios.workbench.knowledge.reference.addToTask")}
				</Button>
				<span className="text-text-muted">{props.canAddToTaskReference === true ? t("bios.workbench.knowledge.reference.addToTaskHint") : t("bios.workbench.knowledge.reference.addToTaskNeedTask")}</span>
			</div>
			<Field label={t("bios.workbench.knowledge.reference.problem")}>{reference.problem}</Field>
			{reference.symptom !== null ? <Field label={t("bios.workbench.knowledge.reference.symptom")}>{reference.symptom}</Field> : null}
			<Field label={t("bios.workbench.knowledge.reference.rootCause")}>{reference.rootCause}</Field>
			<Field label={t("bios.workbench.knowledge.reference.solution")}>{reference.solution}</Field>
			<Field label={t("bios.workbench.knowledge.reference.appliesWhen")}>{reference.appliesWhen.length === 0 ? t("bios.workbench.task.none") : reference.appliesWhen.join("；")}</Field>
			<Field label={t("bios.workbench.knowledge.reference.doesNotApplyWhen")}>{reference.doesNotApplyWhen.length === 0 ? t("bios.workbench.task.none") : reference.doesNotApplyWhen.join("；")}</Field>
			<Field label={t("bios.workbench.knowledge.reference.sourceProject")}>{`${reference.sourceProjectId}${reference.featureId === null ? "" : `｜feature ${reference.featureId}`}`}</Field>
			<Field label={t("bios.workbench.knowledge.reference.sourceCommit")}>{reference.sourceCommit ?? t("bios.workbench.knowledge.reference.commitMissing")}</Field>
			<Field
				label={t("bios.workbench.knowledge.reference.reuseScope")}
			>{`${reference.reuseScope.level}${reference.reuseScope.customers.length === 0 ? "" : `：${reference.reuseScope.customers.join("、")}`}${reference.reuseScope.authorization === undefined ? `（${t("bios.workbench.knowledge.reference.reuseUnauthorized")}）` : ""}`}</Field>
			{/* 源板声明过的验证：按声明如实展示，不做强度升级。 */}
			<div className="mt-1 font-medium">{t("bios.workbench.knowledge.reference.declaredValidations")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.knowledge.reference.declaredValidationsHint")}</div>
			{reference.declaredValidations.length === 0 ? (
				<div className="text-text-muted">{t("bios.workbench.task.noValidation")}</div>
			) : (
				reference.declaredValidations.map((validation, index) => (
					<div key={`${validation.kind}:${validation.scope}:${index}`} className="break-all">
						{`${validation.kind}｜${validation.result}｜${validation.scope}｜${validation.performedBy}`}
					</div>
				))
			)}
			{reference.evidence.length > 0 ? (
				<>
					<div className="mt-1 font-medium">{t("bios.workbench.task.evidence")}</div>
					{reference.evidence.map((evidence, index) => (
						<div key={`${evidence.type}:${evidence.relativePath ?? index}`} className="break-all text-text-muted">{`${evidence.type}${evidence.relativePath === undefined ? "" : `：${evidence.relativePath}`}${evidence.commit === undefined ? "" : `@${evidence.commit}`}`}</div>
					))}
				</>
			) : null}
			{reference.feature !== null ? (
				<>
					<div className="mt-1 font-medium">{t("bios.workbench.knowledge.reference.feature")}</div>
					<Field label={t("bios.workbench.knowledge.feature.originalRequirement")}>{reference.feature.originalRequirement}</Field>
					<Field label={t("bios.workbench.knowledge.feature.acceptanceCriteria")}>{reference.feature.acceptanceCriteria.length === 0 ? t("bios.workbench.task.none") : reference.feature.acceptanceCriteria.join("；")}</Field>
				</>
			) : null}
			{view.reasons.length > 0 ? (
				<div className="mt-1">
					<div className="text-text-muted">{t("bios.workbench.knowledge.reference.reasons")}</div>
					{view.reasons.map((reason) => (
						<div key={reason} className="break-all text-text-muted">
							{reason}
						</div>
					))}
				</div>
			) : null}
			{view.problems.map((line) => (
				<div key={line} className="break-all text-destructive">
					{line}
				</div>
			))}
		</section>
	);
});
