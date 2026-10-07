/**
 * BM-07B B-04：**任务区**（列表 + 详情 + 编辑）与未保存守卫。
 *
 * 约定：
 * - 选中任务只改"当前编辑对象"；**不**因此打开上下文（上下文由详情里的显式按钮走 ACK 链路）；
 * - 关闭编辑页/切换任务前必须提示未保存修改（本批不做自动合并，也不静默丢弃）；
 * - 写失败或 CAS 冲突后**表单保持挂载**（用户可修正后重试）；`revision-conflict` 会显著提示
 *   并给出"重读最新"，由用户决定是否重做。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { t } from "../../i18n";
import type { BiosTasks } from "../../hooks/useBiosTasks";
import { useBiosSediment } from "../../hooks/useBiosSediment";
import { useBiosContinuation } from "../../hooks/useBiosContinuation";
import { BiosTaskList } from "./tasks/BiosTaskList";
import { BiosTaskDetail } from "./tasks/BiosTaskDetail";
import { BiosTaskForm } from "./tasks/BiosTaskForm";
import { BiosSedimentPane } from "./tasks/BiosSedimentPane";
import { BiosContinuationPane } from "./tasks/BiosContinuationPane";

export const BiosTaskSection = memo(function BiosTaskSection(props: { tasks: BiosTasks; workspaces: readonly { workspaceId: string; path: string }[]; profileRevision: number | null; onDirtyChange?: (dirty: boolean) => void }) {
	const tasks = props.tasks;
	const [tab, setTab] = useState<"tasks" | "continuation">("tasks");
	const [mode, setMode] = useState<"view" | "create" | "edit" | "sediment">("view");
	const sediment = useBiosSediment({ projectId: tasks.projectId, taskId: mode === "sediment" ? tasks.selectedTaskId : null });
	const continuation = useBiosContinuation({ projectId: tasks.projectId, taskId: tasks.selectedTaskId, profileRevision: props.profileRevision });
	const [dirty, setDirty] = useState(false);
	useEffect(() => {
		props.onDirtyChange?.(dirty);
	}, [dirty, props.onDirtyChange]);
	useEffect(() => () => props.onDirtyChange?.(false), [props.onDirtyChange]);
	/** 被未保存守卫挡下的动作：确认后才执行。 */
	const blockerRef = useRef<(() => void) | null>(null);
	const [blocked, setBlocked] = useState(false);
	const busy = tasks.busy !== null;

	const guarded = useCallback(
		(action: () => void) => {
			if (dirty) {
				blockerRef.current = action;
				setBlocked(true);
				return;
			}
			action();
		},
		[dirty],
	);

	const detail = tasks.detail;
	const writeOutcome = tasks.writeOutcome;
	const conflicted = writeOutcome?.status === "revision-conflict";

	return (
		<div data-testid="bios-task-section" className="flex flex-col gap-3">
			<div className="flex gap-1">
				<Button
					size="sm"
					variant={tab === "tasks" ? "secondary" : "ghost"}
					aria-pressed={tab === "tasks"}
					onClick={() =>
						guarded(() => {
							setTab("tasks");
							setDirty(false);
						})
					}
				>
					{t("bios.workbench.task.tabTasks")}
				</Button>
				<Button
					size="sm"
					variant={tab === "continuation" ? "secondary" : "ghost"}
					aria-pressed={tab === "continuation"}
					onClick={() =>
						guarded(() => {
							setMode("view");
							setTab("continuation");
							setDirty(false);
						})
					}
				>
					{t("bios.workbench.task.tabContinuation")}
				</Button>
			</div>

			{tab === "continuation" ? (
				<BiosContinuationPane
					continuation={continuation}
					tasks={tasks}
					projectId={tasks.projectId}
					onNew={() =>
						guarded(() => {
							tasks.clearSelection();
							setTab("tasks");
							setMode("create");
						})
					}
				/>
			) : null}

			{tab === "tasks" ? (
				<>
					<BiosTaskList
						projectId={tasks.projectId}
						tasks={tasks.visibleItems}
						selectedTaskId={tasks.selectedTaskId}
						statusFilter={tasks.statusFilter}
						loading={tasks.loading}
						busy={busy}
						gap={tasks.listGap}
						truncated={tasks.truncated}
						onStatusFilter={tasks.setStatusFilter}
						onSelect={(taskId) =>
							guarded(() => {
								setMode("view");
								void tasks.selectTask(taskId);
							})
						}
						onRefresh={() => void tasks.refresh({ keepSelection: true })}
						onNew={() =>
							guarded(() => {
								tasks.clearSelection();
								setMode("create");
							})
						}
					/>

					{/* 写失败/冲突必须显著提示，且给出"重读最新"由用户决定；不做自动合并。 */}
					{writeOutcome !== null ? (
						<section className={conflicted ? "rounded-md border border-destructive/60 p-3" : "rounded-md border border-border p-3"}>
							<div className={conflicted ? "text-destructive" : "text-text-muted"}>{t("bios.workbench.task.writeStatus", { status: writeOutcome.status })}</div>
							<div className="break-all text-text-muted">{t("bios.workbench.task.writeChanged", { fields: writeOutcome.changedFields.join("、") || "-" })}</div>
							{conflicted ? <div className="text-destructive">{t("bios.workbench.task.conflictHint", { revision: writeOutcome.actualRevision ?? "-" })}</div> : null}
							{writeOutcome.needsReview.map((line) => (
								<div key={line} className="break-all text-text-muted">
									{line}
								</div>
							))}
							{writeOutcome.referenceGaps.length > 0 ? <div className="break-all text-destructive">{t("bios.workbench.task.referenceGaps", { gaps: writeOutcome.referenceGaps.join("；") })}</div> : null}
							{writeOutcome.problems.map((line) => (
								<div key={line} className="break-all text-destructive">
									{line}
								</div>
							))}
							{conflicted ? (
								<Button
									size="sm"
									variant="outline"
									className="mt-2"
									disabled={busy || detail?.task === null || detail === null}
									onClick={() => {
										if (detail?.task != null) void tasks.selectTask(detail.task.id);
									}}
								>
									{t("bios.workbench.task.reread")}
								</Button>
							) : null}
						</section>
					) : null}

					{/* key 只在切换编辑对象时变化：CAS 冲突后的重读**不**重置用户已填内容。 */}
					{mode === "create" ? (
						<BiosTaskForm
							key="create"
							mode="create"
							workspaces={props.workspaces}
							baseline={null}
							busy={busy}
							onDirtyChange={setDirty}
							onCancel={() =>
								guarded(() => {
									setMode("view");
									setDirty(false);
								})
							}
							onCreate={(draft) =>
								void tasks.createTask(draft).then((outcome) => {
									if (outcome?.result.status === "created") {
										setMode("view");
										setDirty(false);
									}
								})
							}
							onSave={() => undefined}
						/>
					) : null}

					{mode === "edit" && detail?.task != null ? (
						<BiosTaskForm
							key={`edit:${detail.task.id}`}
							mode="edit"
							workspaces={props.workspaces}
							baseline={{
								requirement: detail.task.requirement,
								decisions: detail.task.decisions,
								todos: detail.task.todos,
								blockers: detail.task.blockers,
								relatedFiles: detail.task.relatedFiles,
								sourceExperienceIds: detail.task.sourceExperienceIds,
								validations: detail.task.validations.map((validation) => ({ kind: validation.kind, scope: validation.scope, result: validation.result, performedAt: validation.performedAt, performedBy: validation.performedBy, evidence: validation.evidence })),
							}}
							busy={busy}
							onDirtyChange={setDirty}
							onCancel={() =>
								guarded(() => {
									setMode("view");
									setDirty(false);
								})
							}
							onSave={(changes) =>
								void tasks.updateTask(detail.task!.id, detail.revision ?? 0, changes).then((outcome) => {
									// 只有真正保存成功才退出编辑；冲突/失败保留表单让用户修正后重试。
									if (outcome?.result.status === "updated" || outcome?.result.status === "unchanged") {
										setMode("view");
										setDirty(false);
									}
								})
							}
						/>
					) : null}

					{mode === "view" && detail !== null ? (
						<BiosTaskDetail
							detail={detail}
							busy={busy}
							statusOutcome={tasks.statusOutcome}
							selection={tasks.selection}
							onEdit={() => setMode("edit")}
							onSediment={() => setMode("sediment")}
							onClose={() =>
								guarded(() => {
									setMode("view");
									tasks.clearSelection();
								})
							}
							onChangeStatus={(to, reason) => {
								if (detail.task === null) return;
								void tasks.changeStatus(detail.task.id, detail.revision ?? 0, to as never, reason);
							}}
							onApplyContext={(enabled) => void tasks.applyContext(enabled)}
						/>
					) : null}

					{/* B-06 任务沉淀：预填只来自已保存的任务；保存后分步事实如实展示（回链冲突只补回链）。 */}
					{mode === "sediment" && detail?.task != null ? <BiosSedimentPane sediment={sediment} tasks={tasks} projectId={tasks.projectId} taskId={detail.task.id} taskRevision={detail.revision} onDirtyChange={setDirty} /> : null}
				</>
			) : null}

			{tasks.problem !== null ? (
				<section role="status" className="rounded-md border border-destructive/60 p-3">
					<div className="break-all text-destructive">{tasks.problem}</div>
					<Button size="sm" variant="ghost" className="mt-2" onClick={tasks.clearNotices}>
						{t("bios.workbench.dismiss")}
					</Button>
				</section>
			) : null}

			{blocked ? (
				<ConfirmDialog
					title={t("bios.workbench.task.unsavedTitle")}
					message={t("bios.workbench.task.unsavedMessage")}
					confirmLabel={t("bios.workbench.task.unsavedConfirm")}
					danger
					onCancel={() => {
						blockerRef.current = null;
						setBlocked(false);
					}}
					onConfirm={() => {
						const action = blockerRef.current;
						blockerRef.current = null;
						setBlocked(false);
						setDirty(false);
						action?.();
					}}
				/>
			) : null}
		</div>
	);
});
