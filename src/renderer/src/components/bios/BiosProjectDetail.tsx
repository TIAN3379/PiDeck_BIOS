/**
 * BM-07B B-03：项目详情——检测候选 / 资料缺口 / 证据与 Git 快照 / 人工确认字段。
 *
 * 约定（计划 §B-03 第 3～4 条）：
 * - 检测是**只读**动作（`wroteToProfile: false` 如实展示），检测/查看/刷新都不写档案；
 * - 只显示既有的有限线索（EDK/DSC/DEC），不声称已识别 IBV/芯片代际/板卡；
 * - 人工确认只改**点名字段**，带 `expectedRevision`；空值保持未知；
 * - CAS 冲突时**保留**用户已填内容，只提示重读，不做自动合并。
 */
import { memo, useMemo, useState } from "react";
import { Button } from "../ui-shadcn/button";
import { Input } from "../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { t, type TranslationKey } from "../../i18n";
import type { BiosProjectSummary } from "../../../../shared/types/bios";
import type { BiosWorkbench, BiosConfirmDraft } from "../../hooks/useBiosWorkbench";
import { BiosAnalysisDraftButton } from "./BiosAnalysisDraftButton";

const INPUT_CLASS = "h-7 w-full text-[12px]";

/** schema 支持人工确认的字段（与 `core/projects/fields.ts` 的 PROJECT_FIELD_NAMES 对齐）。 */
const CONFIRMABLE_FIELDS: readonly { field: string; labelKey: TranslationKey }[] = [
	{ field: "ibv", labelKey: "bios.workbench.field.ibv" },
	{ field: "ibvVersion", labelKey: "bios.workbench.field.ibvVersion" },
	{ field: "chipsetVendor", labelKey: "bios.workbench.field.chipsetVendor" },
	{ field: "chipsetFamily", labelKey: "bios.workbench.field.chipsetFamily" },
	{ field: "chipsetGeneration", labelKey: "bios.workbench.field.chipsetGeneration" },
	{ field: "architecture", labelKey: "bios.workbench.field.architecture" },
	{ field: "boardName", labelKey: "bios.workbench.field.boardName" },
	{ field: "boardRevision", labelKey: "bios.workbench.field.boardRevision" },
	{ field: "customer", labelKey: "bios.workbench.field.customer" },
	{ field: "productLine", labelKey: "bios.workbench.field.productLine" },
	{ field: "crbBaseline", labelKey: "bios.workbench.field.crbBaseline" },
	{ field: "buildTargets", labelKey: "bios.workbench.field.buildTargets" },
	{ field: "keyEntryPoints", labelKey: "bios.workbench.field.keyEntryPoints" },
];

function labelOf(field: string): string {
	const known = CONFIRMABLE_FIELDS.find((entry) => entry.field === field);
	return known === undefined ? field : t(known.labelKey);
}

export const BiosProjectDetail = memo(function BiosProjectDetail(props: { workbench: BiosWorkbench; summary: BiosProjectSummary }) {
	const { workbench, summary } = props;
	const [pending, setPending] = useState<BiosConfirmDraft[]>([]);
	const [field, setField] = useState<string>(CONFIRMABLE_FIELDS[0]?.field ?? "boardName");
	const [value, setValue] = useState("");
	const [operatorLabel, setOperatorLabel] = useState("");
	const detail = workbench.detail;
	const detection = workbench.detection;
	const confirmOutcome = workbench.confirmOutcome;
	const busy = workbench.busy !== null;
	const workspaceId = useMemo(() => detail?.open.workspace?.workspaceId ?? summary.workspaces[0]?.workspaceId, [detail, summary.workspaces]);
	const conflicted = confirmOutcome?.status === "revision-conflict";

	if (detail === null) {
		return <section className="rounded-md border border-border p-3 text-[12px] text-text-muted">{t("bios.workbench.detail.loading")}</section>;
	}

	const open = detail.open;
	const identity = detail.open.profile?.identity;
	const rows: { key: string; label: string; value: string }[] = [
		{ key: "open", label: t("bios.workbench.detail.openStatus"), value: `${open.status}${open.usable ? "" : `/${t("bios.workbench.detail.notUsable")}`}` },
		{ key: "revisions", label: t("bios.workbench.detail.revisions"), value: `registry ${detail.revisions.registry ?? "-"} / profile ${detail.revisions.profile ?? "-"}` },
		{ key: "vcs", label: t("bios.workbench.detail.vcs"), value: detail.workspaceVcs === null ? t("bios.workbench.detail.vcsNone") : `branch ${detail.workspaceVcs.branch ?? "-"} / head ${(detail.workspaceVcs.head ?? "-").slice(0, 12)}` },
	];

	return (
		<div className="flex flex-col gap-3">
			<BiosAnalysisDraftButton biosProjectId={summary.projectId} desktopProjectId={workbench.desktopProjectId} disabled={busy} />
			<section className="rounded-md border border-border p-3 text-[12px]">
				<div className="font-medium">{t("bios.workbench.detail.title")}</div>
				<div className="mt-1 flex flex-col gap-1">
					{rows.map((row) => (
						<div key={row.key} className="flex gap-2">
							<span className="shrink-0 text-text-muted">{row.label}</span>
							<span className="min-w-0 break-all">{row.value}</span>
						</div>
					))}
				</div>
				{/* 依赖该检出的结论需要复核：HEAD/分支与档案记录不同时必须显式提示。 */}
				{detail.headChanged || detail.branchChanged ? <div className="mt-1 text-destructive">{t("bios.workbench.detail.vcsChanged")}</div> : null}
				{detail.gaps.length > 0 ? (
					<div className="mt-2">
						<div className="text-text-muted">{t("bios.workbench.detail.gaps")}</div>
						{detail.gaps.slice(0, 12).map((gap) => (
							<div key={gap.field} className="break-all text-text-muted">
								{`${labelOf(gap.field)}：${gap.reason}${gap.hint === undefined ? "" : `（${gap.hint}）`}`}
							</div>
						))}
					</div>
				) : null}
				{detail.evidenceUnverifiedFacts.length > 0 ? <div className="mt-1 break-all text-text-muted">{t("bios.workbench.detail.evidenceUnverified", { count: detail.evidenceUnchecked, facts: detail.evidenceUnverifiedFacts.slice(0, 6).join("、") })}</div> : null}
				{detail.problems.slice(0, 6).map((line) => (
					<div key={line} className="mt-1 break-all text-destructive">
						{line}
					</div>
				))}
			</section>

			<section className="rounded-md border border-border p-3 text-[12px]">
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium">{t("bios.workbench.detect.title")}</span>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void workbench.runDetection(summary.projectId, workspaceId)}>
						{t("bios.workbench.detect.run")}
					</Button>
				</div>
				<div className="mt-1 text-text-muted">{t("bios.workbench.detect.readonlyHint")}</div>
				{detection === null ? null : (
					<div className="mt-2 flex flex-col gap-1">
						<div className="text-text-muted">{t("bios.workbench.detect.scan", { files: detection.scannedFiles, bytes: detection.totalBytes })}</div>
						{/* 检测只给有限 EDK/DSC/DEC 线索，不声称已识别 IBV/芯片代际/板卡。 */}
						{detection.candidates.length === 0 ? <div className="text-text-muted">{t("bios.workbench.detect.noCandidate")}</div> : null}
						{detection.candidates.slice(0, 20).map((candidate) => (
							<div key={`${candidate.field}:${candidate.value}:${candidate.evidence.relativePath}:${candidate.evidence.line}`} className="break-all">
								{`${labelOf(candidate.field)} = ${candidate.value}`}
								<span className="text-text-muted">{`（${candidate.rule}｜${candidate.evidence.relativePath}:${candidate.evidence.line}）`}</span>
							</div>
						))}
						{detection.gaps.map((gap) => (
							<div key={gap.field} className="break-all text-text-muted">
								{`${labelOf(gap.field)}：${gap.reason}`}
							</div>
						))}
						{detection.truncated ? <div className="text-destructive">{t("bios.workbench.detect.truncated", { by: detection.truncatedBy.join("、") })}</div> : null}
						<div className="mt-1">
							<Button
								size="sm"
								variant="ghost"
								disabled={busy}
								onClick={() => {
									const candidate = detection.candidates[0];
									if (candidate === undefined) return;
									setField(candidate.field);
									setValue(candidate.value);
								}}
							>
								{t("bios.workbench.detect.fillFirst")}
							</Button>
						</div>
					</div>
				)}
			</section>

			<section className="rounded-md border border-border p-3 text-[12px]">
				<div className="font-medium">{t("bios.workbench.confirm.title")}</div>
				<div className="mt-1 text-text-muted">{t("bios.workbench.confirm.expected", { revision: detail.revisions.profile ?? "-" })}</div>
				{identity !== undefined ? (
					<div className="mt-2 flex flex-col gap-1">
						{/* 已有人工确认值单独列出（检测不会自动改写 confirmed）。 */}
						{CONFIRMABLE_FIELDS.map((entry) => {
							const fieldValue = (identity as unknown as Record<string, { value: string | null; status: string } | undefined>)[entry.field];
							if (fieldValue === undefined) return null;
							return (
								<div key={entry.field} className="flex gap-2">
									<span className="shrink-0 text-text-muted">{t(entry.labelKey)}</span>
									<span className="min-w-0 break-all">{`${fieldValue.value ?? t("bios.workbench.confirm.unknown")}（${fieldValue.status}）`}</span>
								</div>
							);
						})}
					</div>
				) : null}
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Select value={field} onValueChange={setField}>
						<SelectTrigger aria-label={t("bios.workbench.confirm.field")} className={INPUT_CLASS}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{CONFIRMABLE_FIELDS.map((entry) => (
								<SelectItem key={entry.field} value={entry.field}>
									{t(entry.labelKey)}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Input aria-label={t("bios.workbench.confirm.value")} className={INPUT_CLASS} placeholder={t("bios.workbench.confirm.valuePlaceholder")} value={value} onChange={(event) => setValue(event.target.value)} />
					<Button
						size="sm"
						variant="outline"
						disabled={busy}
						onClick={() => {
							setPending((previous) => [...previous.filter((entry) => entry.field !== field), { field, value: value.trim() === "" ? null : value.trim() }]);
							setValue("");
						}}
					>
						{t("bios.workbench.confirm.add")}
					</Button>
				</div>
				{pending.length > 0 ? (
					<div className="mt-2 flex flex-col gap-1">
						{pending.map((entry) => (
							<div key={entry.field} className="flex items-center gap-2">
								<span className="min-w-0 flex-1 break-all">{`${labelOf(entry.field)} = ${entry.value ?? t("bios.workbench.confirm.unknown")}`}</span>
								<Button size="sm" variant="ghost" disabled={busy} onClick={() => setPending((previous) => previous.filter((candidate) => candidate.field !== entry.field))}>
									{t("bios.workbench.confirm.remove")}
								</Button>
							</div>
						))}
						<div className="mt-1 flex flex-wrap items-center gap-2">
							<Input aria-label={t("bios.workbench.confirm.operator")} className={INPUT_CLASS} placeholder={t("bios.workbench.confirm.operatorPlaceholder")} value={operatorLabel} onChange={(event) => setOperatorLabel(event.target.value)} />
							<Button
								size="sm"
								disabled={busy}
								onClick={() => {
									// CAS 冲突时不清空 pending：用户填的内容必须留着，只重读最新 revision。
									void workbench.confirmFields(summary.projectId, detail.revisions.profile ?? 0, pending, operatorLabel);
								}}
							>
								{t("bios.workbench.confirm.submit")}
							</Button>
							{conflicted ? (
								<Button size="sm" variant="outline" disabled={busy} onClick={() => void workbench.selectProject(summary.projectId)}>
									{t("bios.workbench.confirm.reread")}
								</Button>
							) : null}
						</div>
					</div>
				) : null}
				{confirmOutcome !== null ? (
					<div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
						<div className={conflicted ? "text-destructive" : "text-text-muted"}>{t("bios.workbench.confirm.status", { status: confirmOutcome.status })}</div>
						<div className="break-all text-text-muted">{t("bios.workbench.confirm.changed", { fields: confirmOutcome.changedFields.map((name) => labelOf(name)).join("、") || "-" })}</div>
						{confirmOutcome.needsReview.map((line) => (
							<div key={line} className="break-all text-text-muted">
								{line}
							</div>
						))}
						{confirmOutcome.warnings.map((line) => (
							<div key={line} className="break-all text-text-muted">
								{line}
							</div>
						))}
					</div>
				) : null}
			</section>
		</div>
	);
});
