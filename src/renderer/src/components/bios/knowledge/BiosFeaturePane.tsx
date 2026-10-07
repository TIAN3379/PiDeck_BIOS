/**
 * BM-07B B-05：**客户需求**区（按 ID 打开 / 新建 / 编辑 / 查看关联核对结论）。
 *
 * 没有"全库需求列表"接口是有意的：`allowedFeatureIds` 是**显式授权**清单，界面只把它当作
 * 可选候选；其余需求需要用户明确给出 ID —— 不替用户猜"应该看哪一条"。
 */
import { memo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { t } from "../../../i18n";
import type { BiosKnowledge } from "../../../hooks/useBiosKnowledge";
import { BiosFeatureForm } from "./BiosFeatureForm";

const INPUT_CLASS = "h-7 w-full text-[12px]";

export const BiosFeaturePane = memo(function BiosFeaturePane(props: { knowledge: BiosKnowledge; knownFeatureIds: readonly string[]; onDirtyChange: (dirty: boolean) => void }) {
	const { knowledge } = props;
	const [draftId, setDraftId] = useState("");
	const [mode, setMode] = useState<"view" | "create" | "edit">("view");
	const busy = knowledge.busy !== null;
	const detail = knowledge.featureDetail;
	const outcome = knowledge.featureOutcome;
	const conflicted = outcome?.status === "revision-conflict";
	const feature = detail?.feature ?? null;

	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.knowledge.feature.title")}</div>
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.knowledge.feature.authorizationHint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{props.knownFeatureIds.length > 0 ? (
						<Select value={draftId === "" ? "__manual__" : draftId} onValueChange={(value) => setDraftId(value === "__manual__" ? "" : value)}>
							<SelectTrigger aria-label={t("bios.workbench.knowledge.feature.candidates")} className={`${INPUT_CLASS} w-56`}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="__manual__">{t("bios.workbench.project.manualInput")}</SelectItem>
								{props.knownFeatureIds.map((featureId) => (
									<SelectItem key={featureId} value={featureId}>
										{featureId}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					) : null}
					<Input aria-label={t("bios.workbench.knowledge.feature.featureId")} className={`${INPUT_CLASS} min-w-40 flex-1`} placeholder={t("bios.workbench.knowledge.feature.featureIdPlaceholder")} value={draftId} onChange={(event) => setDraftId(event.target.value)} />
					<Button size="sm" disabled={busy} onClick={() => void knowledge.loadFeature(draftId)}>
						{t("bios.workbench.knowledge.feature.open")}
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
						{t("bios.workbench.knowledge.feature.new")}
					</Button>
				</div>
			</section>

			{outcome !== null ? (
				<section className={conflicted ? "rounded-md border border-destructive/60 p-3" : "rounded-md border border-border p-3"}>
					<div className={conflicted ? "text-destructive" : "text-text-muted"}>{t("bios.workbench.task.writeStatus", { status: outcome.status })}</div>
					<div className="break-all text-text-muted">{t("bios.workbench.task.writeChanged", { fields: outcome.changedFields.join("、") || "-" })}</div>
					{conflicted ? <div className="text-destructive">{t("bios.workbench.task.conflictHint", { revision: outcome.actualRevision ?? "-" })}</div> : null}
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
				<BiosFeatureForm
					key="feature-create"
					mode="create"
					baseline={null}
					busy={busy}
					onDirtyChange={props.onDirtyChange}
					onCancel={() => {
						setMode("view");
						props.onDirtyChange(false);
					}}
					onCreate={(draft) =>
						void knowledge.createFeature(draft).then((result) => {
							if (result?.result.status === "created") {
								setDraftId(draft.featureId);
								setMode("view");
								props.onDirtyChange(false);
							}
						})
					}
				/>
			) : null}

			{mode === "edit" && feature !== null ? (
				<BiosFeatureForm
					key={`feature-edit:${feature.id}`}
					mode="edit"
					baseline={feature}
					busy={busy}
					onDirtyChange={props.onDirtyChange}
					onCancel={() => {
						setMode("view");
						props.onDirtyChange(false);
					}}
					onSave={(changes) =>
						void knowledge.updateFeature(feature.id, detail?.revision ?? 0, changes).then((result) => {
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
						<span className="font-medium">{t("bios.workbench.knowledge.feature.detailTitle")}</span>
						{feature !== null ? (
							<Button size="sm" variant="outline" disabled={busy} onClick={() => setMode("edit")}>
								{t("bios.workbench.task.edit")}
							</Button>
						) : null}
					</div>
					{feature === null ? (
						<div className="break-all text-text-muted">{t("bios.workbench.knowledge.feature.unavailable", { status: detail.status })}</div>
					) : (
						<>
							<div className="break-all">{`${feature.id} @${detail.revision ?? "-"}`}</div>
							<div className="break-all">{`${t("bios.workbench.knowledge.feature.originalRequirement")}：${feature.originalRequirement}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.feature.aliases")}：${feature.aliases.join("、") || "-"}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.feature.customer")}：${feature.customer.value ?? t("bios.workbench.confirm.unknown")}（${feature.customer.status}）`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.feature.productLine")}：${feature.productLine.value ?? t("bios.workbench.confirm.unknown")}（${feature.productLine.status}）`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.feature.acceptanceCriteria")}：${feature.acceptanceCriteria.join("；") || "-"}`}</div>
							<div className="break-all text-text-muted">{`${t("bios.workbench.knowledge.feature.relatedExperiences")}：${feature.relatedExperienceIds.join("、") || "-"}`}</div>
							{/* 能否作"可直接复用"的结论必须显式说明，未确认身份/范围不匹配时不能当依据。 */}
							<div className={detail.usableAsReference ? "text-text-muted" : "text-destructive"}>{detail.usableAsReference ? t("bios.workbench.knowledge.feature.usable") : t("bios.workbench.knowledge.feature.notUsable")}</div>
							{detail.referenceReasons.map((reason) => (
								<div key={reason} className="break-all text-text-muted">
									{reason}
								</div>
							))}
							<div className="mt-1 font-medium">{t("bios.workbench.knowledge.feature.links")}</div>
							{detail.links.length === 0 ? (
								<div className="text-text-muted">{t("bios.workbench.task.noReference")}</div>
							) : (
								detail.links.map((link) => (
									<div key={link.experienceId} className={link.found ? "break-all text-text-muted" : "break-all text-destructive"}>
										{`${link.experienceId}｜${link.found ? (link.status ?? "-") : t("bios.workbench.task.referenceMissing")}${link.reason === null ? "" : `（${link.reason}）`}`}
									</div>
								))
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
		</div>
	);
});
