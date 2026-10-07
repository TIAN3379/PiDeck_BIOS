/**
 * BM-07B B-03：**BIOS 工作台**（右侧抽屉入口）。
 *
 * 沿用桌面布局：不另做主页、不把业务塞进设置弹框；设置里只保留配置/状态与入口。
 * 三个业务区：项目（B-03 交付）、任务（B-04）、知识（B-05）。
 */
import { memo, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../i18n";
import { openSettingsAtom } from "../../atoms";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Dialog, DialogContent, DialogTitle } from "../ui-shadcn/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui-shadcn/select";
import { useBiosWorkbench } from "../../hooks/useBiosWorkbench";
import { useBiosTasks } from "../../hooks/useBiosTasks";
import { useBiosKnowledge, type BiosKnowledgeTab } from "../../hooks/useBiosKnowledge";
import { useBiosHistoryWorkflow } from "../../hooks/useBiosHistoryWorkflow";
import { BiosStoreGate } from "./BiosStoreGate";
import { BiosProjectSection } from "./BiosProjectSection";
import { BiosTaskSection } from "./BiosTaskSection";
import { BiosKnowledgeSection } from "./BiosKnowledgeSection";
import { biosProjectLabel } from "../../utils/biosProjectLabel";
import { BiosCompactStatus } from "./BiosCompactStatus";
import { BiosConnectionManager } from "./BiosConnectionManager";
import { BiosLibraryDialog } from "./knowledge/BiosLibraryDialog";

type WorkbenchSection = "projects" | "tasks" | "knowledge";

const SECTIONS: readonly { id: WorkbenchSection; labelKey: "bios.workbench.section.projects" | "bios.workbench.section.tasks" | "bios.workbench.section.knowledge" }[] = [
	{ id: "projects", labelKey: "bios.workbench.section.projects" },
	{ id: "tasks", labelKey: "bios.workbench.section.tasks" },
	{ id: "knowledge", labelKey: "bios.workbench.section.knowledge" },
];

export const BiosWorkbenchPanel = memo(function BiosWorkbenchPanel(props: { desktopProjectId?: string; desktopProjectName?: string; onRestartRuntime?: () => void }) {
	const workbench = useBiosWorkbench(props);
	const [section, setSection] = useState<WorkbenchSection>("projects");
	const [managing, setManaging] = useState(false);
	const [libraryOpen, setLibraryOpen] = useState(false);
	const [pendingExit, setPendingExit] = useState<"close" | "settings" | null>(null);
	const [knowledgeDirty, setKnowledgeDirty] = useState(false);
	const [taskDirty, setTaskDirty] = useState(false);
	const [pendingSection, setPendingSection] = useState<WorkbenchSection | null>(null);
	const openSettings = useSetAtom(openSettingsAtom);
	const storeReady = workbench.storeStatus?.kind === "ready";
	const needsAuthorization = storeReady && workbench.readiness?.ready === false;
	const selectedProject = workbench.projects.find((project) => project.projectId === workbench.selectedProjectId) ?? null;
	// 工作区列表来自项目摘要（不需要加载档案正文）；任务区只用它做新建时的选择。
	const projectWorkspaces = (selectedProject?.workspaces ?? []).map((workspace) => ({ workspaceId: workspace.workspaceId, path: workspace.path }));
	// 任务状态提升到面板层：知识区"加入任务参考"与任务区必须看到**同一个**选中任务，
	// 否则会出现"在知识区点了加入参考、却加到了另一个任务"这种串档。
	const tasks = useBiosTasks({ projectId: workbench.selectedProjectId });
	const knowledge = useBiosKnowledge({ projectId: workbench.selectedProjectId });
	const [knowledgeTab, setKnowledgeTab] = useState<BiosKnowledgeTab>("search");
	const history = useBiosHistoryWorkflow({ desktopProjectId: props.desktopProjectId, projectId: workbench.selectedProjectId, knowledge, onDirtyChange: setKnowledgeDirty, onSaved: () => setKnowledgeTab("experiences") });
	const showSettings = () => {
		if (knowledgeDirty || taskDirty) setPendingExit("settings");
		else {
			setManaging(false);
			openSettings({ tab: "bios" });
		}
	};
	const changeSection = (next: WorkbenchSection) => {
		if (((section === "knowledge" && knowledgeDirty) || (section === "tasks" && taskDirty)) && next !== section) setPendingSection(next);
		else setSection(next);
	};

	return (
		<div data-testid="bios-workbench" className="bios-workbench flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 text-[12px] [scrollbar-gutter:stable]">
			<BiosCompactStatus workbench={workbench} desktopProjectId={props.desktopProjectId} desktopProjectName={props.desktopProjectName} onManage={() => setManaging(true)} onLibrary={() => setLibraryOpen(true)} onRestartRuntime={props.onRestartRuntime} />
			{libraryOpen ? <BiosLibraryDialog onClose={() => setLibraryOpen(false)} /> : null}
			<Dialog
				open={managing}
				onOpenChange={(open) => {
					if (!open && (knowledgeDirty || taskDirty)) setPendingExit("close");
					else setManaging(open);
				}}
			>
				<DialogContent data-testid="bios-management-dialog" aria-describedby={undefined} className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden sm:max-w-3xl">
					<DialogTitle>{t("bios.compact.managementTitle")}</DialogTitle>
					<div className="flex min-h-0 flex-col gap-3 overflow-y-auto text-[12px]">
						<BiosStoreGate workbench={workbench} onOpenSettings={showSettings} />
						{storeReady ? <BiosConnectionManager onChanged={workbench.refresh} /> : null}

						{needsAuthorization && props.desktopProjectId === undefined ? (
							<section className="rounded-md border border-border p-3">
								<div className="break-all text-text-muted">{workbench.readiness?.reason ?? ""}</div>
								<Button size="sm" variant="outline" className="mt-2" onClick={showSettings}>
									{t("bios.workbench.gotoAuthorization")}
								</Button>
							</section>
						) : null}

						{/* B-01：撤权未完成必须显著提示，不能显示成"安全已生效"。 */}
						{workbench.runtime !== null && workbench.runtime.stopFailures.length > 0 ? (
							<section className="rounded-md border border-destructive/60 p-3">
								<div className="font-medium text-destructive">{t("bios.workbench.runtimeStopFailures")}</div>
								{workbench.runtime.stopFailures.map((entry) => (
									<div key={entry.agentId} className="break-all text-text-muted">{`${entry.agentId}：${entry.reason}`}</div>
								))}
							</section>
						) : null}

						{
							<div className="flex gap-1">
								{SECTIONS.map((entry) => (
									<Button
										key={entry.id}
										size="sm"
										variant={section === entry.id ? "secondary" : "ghost"}
										aria-pressed={section === entry.id}
										data-testid={`bios-workbench-section-${entry.id}`}
										onClick={() => {
											if (entry.id === section) return;
											changeSection(entry.id);
										}}
									>
										{t(entry.labelKey)}
									</Button>
								))}
							</div>
						}

						{section === "projects" ? <BiosProjectSection key={props.desktopProjectId ?? "none"} workbench={workbench} desktopProjectName={props.desktopProjectName} desktopProjectId={props.desktopProjectId} /> : null}
						{section === "tasks" ? (
							<>
								{/* 任务区在这里自带项目选择：不必先回项目区选一次；这条路径**不**加载项目档案正文。 */}
								<section className="rounded-md border border-border p-3">
									<div className="flex flex-wrap items-center gap-2">
										<span className="text-text-muted">{t("bios.workbench.section.projects")}</span>
										<Select value={workbench.selectedProjectId ?? "__none__"} onValueChange={(value) => value !== "__none__" && void workbench.selectProject(value)}>
											<SelectTrigger aria-label={t("bios.workbench.section.projects")} className="h-7 w-full text-[12px]">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="__none__">{t("settings.bios.statusNone")}</SelectItem>
												{workbench.projects.map((project) => (
													<SelectItem key={project.projectId} value={project.projectId}>
														{biosProjectLabel(project)}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
									</div>
									{workbench.projectsGap !== null ? (
										<p role="status" className="mt-1 break-all text-destructive">
											{workbench.projectsGap}
										</p>
									) : null}
								</section>
								<BiosTaskSection tasks={tasks} workspaces={projectWorkspaces} profileRevision={selectedProject?.profileRevision ?? null} onDirtyChange={setTaskDirty} />
							</>
						) : null}
						{/* B-06：知识区的"加入任务参考"直接落到**同一个**选中任务上（只改参考 ID）。 */}
						{section === "knowledge" ? (
							<BiosKnowledgeSection
								projectId={workbench.selectedProjectId}
								knownFeatureIds={workbench.settings.allowedFeatureIds}
								canAddReference={tasks.selectedTaskId !== null}
								knowledge={knowledge}
								history={history}
								tab={knowledgeTab}
								onTabChange={setKnowledgeTab}
								desktopProjectId={props.desktopProjectId}
								onDirtyChange={setKnowledgeDirty}
								dirty={knowledgeDirty}
								onAddReference={(experienceId) => void tasks.changeReferences(experienceId, true)}
							/>
						) : null}
						{pendingSection !== null ? (
							<ConfirmDialog
								title={t("bios.workbench.task.unsavedTitle")}
								message={t("bios.workbench.knowledge.unsavedMessage")}
								confirmLabel={t("bios.workbench.task.unsavedConfirm")}
								danger
								onCancel={() => setPendingSection(null)}
								onConfirm={() => {
									setSection(pendingSection);
									history.discard();
									setPendingSection(null);
									setKnowledgeDirty(false);
									setTaskDirty(false);
								}}
							/>
						) : null}

						{workbench.problem !== null ? (
							<section role="status" className="rounded-md border border-destructive/60 p-3">
								<div className="break-all text-destructive">{workbench.problem}</div>
								<Button size="sm" variant="ghost" className="mt-2" onClick={workbench.clearNotices}>
									{t("bios.workbench.dismiss")}
								</Button>
							</section>
						) : null}
					</div>
				</DialogContent>
			</Dialog>
			{pendingExit !== null ? (
				<ConfirmDialog
					title={t("bios.workbench.task.unsavedTitle")}
					message={t("bios.workbench.knowledge.unsavedMessage")}
					confirmLabel={t("bios.workbench.task.unsavedConfirm")}
					danger
					onCancel={() => setPendingExit(null)}
					onConfirm={() => {
						if (pendingExit === "settings") openSettings({ tab: "bios" });
						history.discard();
						setPendingExit(null);
						setManaging(false);
						setKnowledgeDirty(false);
						setTaskDirty(false);
					}}
				/>
			) : null}
		</div>
	);
});
