/**
 * BM-07B B-06：**任务沉淀经验**（有限预填 → 工程师补根因/方案/边界 → 显式保存）。
 *
 * 铁律（计划 §B-06 第 1～3 条）：
 * - 预填只来自**已保存的任务**（需求/决策/相关文件/参考经验/验证记录），不后台扫描聊天；
 * - `requiredHumanFields` 逐项呈现：人没写的字段就是缺口，不补默认值；
 * - 保存是 **card / link 两步**：草稿成功但回链冲突时**保留草稿 ID**，只补回链
 *   （走"参考经验 ID"这一条独立 CAS 路径），**不重建第二张卡、不假称全部回滚**。
 */
import { memo, useMemo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { t, type TranslationKey } from "../../../i18n";
import type { BiosSediment } from "../../../hooks/useBiosSediment";
import type { BiosTasks } from "../../../hooks/useBiosTasks";
import { BiosExperienceForm } from "../knowledge/BiosExperienceForm";
import { requiredHumanFieldsOf, sedimentHintsOf, sedimentSeedOf } from "./biosSedimentDrafts";

/** 人工必填字段 → i18n 标签（静态映射：拼错由类型检查挡住）。 */
const HUMAN_FIELD_LABELS: Record<string, TranslationKey> = {
	problem: "bios.workbench.knowledge.reference.problem",
	symptom: "bios.workbench.knowledge.reference.symptom",
	rootCause: "bios.workbench.knowledge.reference.rootCause",
	solution: "bios.workbench.knowledge.reference.solution",
	appliesWhen: "bios.workbench.knowledge.reference.appliesWhen",
	doesNotApplyWhen: "bios.workbench.knowledge.reference.doesNotApplyWhen",
	reuse: "bios.workbench.knowledge.experience.reuse",
};

export const BiosSedimentPane = memo(function BiosSedimentPane(props: { sediment: BiosSediment; tasks: BiosTasks; projectId: string | null; taskId: string; taskRevision: number | null; onDirtyChange: (dirty: boolean) => void }) {
	const { sediment, tasks } = props;
	const busy = sediment.busy !== null || tasks.busy !== null;
	const [linkOnlyNotice, setLinkOnlyNotice] = useState(false);
	const prefill = sediment.prefill;
	const seed = useMemo(() => (prefill === null ? null : sedimentSeedOf(prefill)), [prefill]);
	const hints = useMemo(() => (prefill === null ? null : sedimentHintsOf(prefill)), [prefill]);
	const outcome = sediment.saveOutcome;

	return (
		<section className="flex flex-col gap-2 rounded-md border border-border p-3">
			<div className="font-medium">{t("bios.workbench.sediment.title")}</div>
			<div className="text-[11px] text-text-muted">{t("bios.workbench.sediment.hint")}</div>

			{prefill === null ? (
				<div className="text-text-muted">{sediment.busy === "prefill" ? t("bios.workbench.loading") : t("bios.workbench.sediment.noPrefill")}</div>
			) : (
				<>
					{/* 预填是"候选事实"，不是结论：逐项标出来源字段，让工程师自己判断。 */}
					<div className="rounded border border-border p-2">
						<div className="text-[11px] text-text-muted">{t("bios.workbench.sediment.prefillTitle")}</div>
						<div className="break-all">{`${t("bios.workbench.sediment.fromRequirement")}：${prefill.suggested.requirement}`}</div>
						<div className="break-all text-text-muted">{`${t("bios.workbench.sediment.fromDecisions")}：${prefill.suggested.decisions.join("；") || "-"}`}</div>
						<div className="break-all text-text-muted">{`${t("bios.workbench.sediment.fromRelatedFiles")}：${prefill.suggested.relatedFiles.join("；") || "-"}`}</div>
						<div className="break-all text-text-muted">{`${t("bios.workbench.sediment.fromValidations")}：${prefill.suggested.validations.length}`}</div>
						<div className="break-all text-text-muted">{`${t("bios.workbench.sediment.usableExperiences")}：${(hints?.usableExperienceIds ?? []).join("、") || "-"}`}</div>
						<div className="break-all text-text-muted">{`${t("bios.workbench.sediment.referencedExperiences")}：${(hints?.sourceExperienceIds ?? []).join("、") || "-"}`}</div>
					</div>

					{/* 人工必填字段：逐项列出，提醒"这些必须由人写"。 */}
					<div className="rounded border border-destructive/60 p-2">
						<div className="text-[11px] text-destructive">{t("bios.workbench.sediment.requiredHumanFields")}</div>
						<div className="break-all text-text-muted">
							{requiredHumanFieldsOf(prefill)
								.map((field) => {
									const key = HUMAN_FIELD_LABELS[field];
									return key === undefined ? field : t(key);
								})
								.join("、")}
						</div>
					</div>

					{prefill.problems.map((line) => (
						<div key={line} className="break-all text-destructive">
							{line}
						</div>
					))}

					<BiosExperienceForm
						key={`sediment:${props.taskId}`}
						mode="create"
						baseline={null}
						defaultSourceProjectId={seed?.sourceProjectId ?? props.projectId}
						initial={{ problem: seed?.problem ?? "", validations: [...(seed?.validations ?? [])] }}
						busy={busy}
						onDirtyChange={props.onDirtyChange}
						onCancel={() => props.onDirtyChange(false)}
						onCreate={(draft) => {
							const { sourceProjectId: _ignored, ...body } = draft;
							// 显式保存：先建卡再回链（回链走 core 的独立 CAS 步骤）。
							void sediment.saveDraft(body, props.taskRevision);
						}}
					/>
				</>
			)}

			{outcome !== null ? (
				<div className={outcome.status === "draft-saved" ? "rounded border border-border p-2" : "rounded border border-destructive/60 p-2"}>
					<div className={outcome.status === "draft-saved" ? "text-text-muted" : "text-destructive"}>{t("bios.workbench.sediment.saveStatus", { status: outcome.status })}</div>
					{/* 分步事实必须分别显示：不能只给一个总结果。 */}
					{outcome.steps.map((step, index) => (
						<div key={`${step.step}:${index}`} className="break-all text-text-muted">{`${step.step}：${step.status}${step.revision === null ? "" : ` @${step.revision}`}`}</div>
					))}
					<div className="break-all text-text-muted">{t("bios.workbench.sediment.keptDraft", { experienceId: outcome.experienceId })}</div>
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
					{/* 回链冲突：只修回链。草稿已经落盘，重建会变成"第二张卡"。 */}
					{outcome.status === "link-conflict" || outcome.status === "link-failed" ? (
						<div className="mt-1 flex flex-col gap-1">
							<div className="text-[11px] text-text-muted">{t("bios.workbench.sediment.linkOnlyHint")}</div>
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={() => {
									setLinkOnlyNotice(true);
									// 先重读任务拿当前 revision，再只补"参考经验 ID"这一处。
									void tasks.selectTask(props.taskId).then(() => tasks.changeReferences(outcome.experienceId, true));
								}}
							>
								{t("bios.workbench.sediment.linkOnly")}
							</Button>
							{linkOnlyNotice ? <div className="text-[11px] text-text-muted">{t("bios.workbench.sediment.linkOnlyDone")}</div> : null}
						</div>
					) : null}
				</div>
			) : null}

			{sediment.problem !== null ? (
				<div className="flex flex-col gap-1">
					<div className="break-all text-destructive">{sediment.problem}</div>
					<Button size="sm" variant="ghost" disabled={busy} onClick={sediment.clearNotices}>
						{t("bios.workbench.dismiss")}
					</Button>
				</div>
			) : null}
		</section>
	);
});
