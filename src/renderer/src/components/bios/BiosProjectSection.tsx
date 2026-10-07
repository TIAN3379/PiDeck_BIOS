/**
 * 项目管理窗口：查看档案与人工核对字段；接入统一交给根级确认弹窗。
 *
 * 约定：
 * - 工作区路径**不由界面提供**：只提交当前桌面项目 ID，主进程按真实项目表解析路径；
 * - BIOS projectId 必须在设置里已授权（初次授权显式办理），否则主进程拒绝并给出指引；
 * - 列表来自 `bios:list-projects`（只含已授权项目）；`gap` 是"为什么没有内容"，不是"空库"。
 */
import { memo } from "react";
import { t } from "../../i18n";
import type { BiosWorkbench } from "../../hooks/useBiosWorkbench";
import { BiosProjectDetail } from "./BiosProjectDetail";
import { biosProjectLabel } from "../../utils/biosProjectLabel";

export const BiosProjectSection = memo(function BiosProjectSection(props: { workbench: BiosWorkbench; desktopProjectName?: string; desktopProjectId?: string }) {
	const { workbench } = props;
	const busy = workbench.busy !== null;
	const storeReady = workbench.storeStatus?.kind === "ready";
	const selected = workbench.projects.find((project) => project.projectId === workbench.selectedProjectId) ?? null;

	return (
		<div data-testid="bios-project-section" className="flex flex-col gap-3">
			<p className="text-text-muted">{t("bios.compact.projectManagementHint")}</p>

			<section className="rounded-md border border-border p-3 text-[12px]">
				<div className="font-medium">{t("bios.workbench.project.listTitle")}</div>
				{!storeReady ? <div className="mt-1 text-text-muted">{t("bios.workbench.project.needStore")}</div> : null}
				{storeReady && workbench.claim === null ? <div className="mt-1 text-text-muted">{t("bios.workbench.noSession")}</div> : null}
				{storeReady && workbench.projectsGap !== null ? <div className="mt-1 break-all text-text-muted">{t("bios.workbench.project.listGap", { reason: workbench.projectsGap })}</div> : null}
				{storeReady && workbench.projectsGap === null && workbench.projects.length === 0 ? <div className="mt-1 text-text-muted">{t("bios.workbench.project.empty")}</div> : null}
				<div className="mt-2 flex flex-col gap-1">
					{workbench.projects.map((project) => {
						const active = project.projectId === workbench.selectedProjectId;
						return (
							<button
								key={project.projectId}
								type="button"
								data-testid={`bios-project-row-${project.projectId}`}
								className={`rounded border px-2 py-1 text-left ${active ? "border-border bg-surface-muted" : "border-transparent hover:border-border"}`}
								aria-pressed={active}
								disabled={busy}
								onClick={() => void workbench.selectProject(project.projectId)}
							>
								<div className="break-all">{biosProjectLabel(project)}</div>
								<div className="text-text-muted">
									{t("bios.workbench.project.listMeta", {
										revision: project.profileRevision === null ? "-" : project.profileRevision,
										workspaces: project.workspaces.length,
										review: project.needsReviewCount,
									})}
								</div>
							</button>
						);
					})}
				</div>
			</section>

			{selected !== null ? <BiosProjectDetail workbench={workbench} summary={selected} /> : <section className="rounded-md border border-border p-3 text-[12px] text-text-muted">{t("bios.workbench.project.selectHint")}</section>}
		</div>
	);
});
