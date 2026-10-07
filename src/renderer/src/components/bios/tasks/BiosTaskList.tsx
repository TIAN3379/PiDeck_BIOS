/**
 * BM-07B B-04：任务列表（requirement / status / workspace / 更新时间 / 待办与阻塞数量）。
 *
 * 约定：
 * - 列表来自主进程的**有界读取**（每个项目上限 `BIOS_TASK_LIST_LIMIT`）；状态筛选只是
 *   对已取回的窗口做视图过滤，不会为了筛选去全库扫描；
 * - 达到上限时必须提示"可能被截断"，不能把"看到 200 条"说成"没有更多任务"；
 * - 点击行只是**选择候选**，不代表打开上下文（上下文由详情里的显式按钮走 selection/ACK 链路）。
 */
import { memo } from "react";
import { Button } from "../../ui-shadcn/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { t, formatI18nDateTime } from "../../../i18n";
import type { BiosTaskSummary } from "../../../../../shared/types/bios";
import { TASK_STATUS_ORDER } from "./biosTaskDrafts";
import type { BiosTaskStatusFilter } from "../../../hooks/useBiosTasks";

const INPUT_CLASS = "h-7 w-36 text-[12px]";

export const BiosTaskList = memo(function BiosTaskList(props: {
	projectId: string | null;
	tasks: readonly BiosTaskSummary[];
	selectedTaskId: string | null;
	statusFilter: BiosTaskStatusFilter;
	loading: boolean;
	busy: boolean;
	gap: string | null;
	truncated: boolean;
	onStatusFilter: (next: BiosTaskStatusFilter) => void;
	onSelect: (taskId: string) => void;
	onRefresh: () => void;
	onNew: () => void;
}) {
	const { projectId } = props;
	return (
		<section className="rounded-md border border-border p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">{t("bios.workbench.task.listTitle")}</span>
				<div className="flex flex-wrap items-center gap-2">
					<Select value={props.statusFilter} onValueChange={(value) => props.onStatusFilter(value as BiosTaskStatusFilter)}>
						<SelectTrigger aria-label={t("bios.workbench.task.statusFilter")} className={INPUT_CLASS}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("bios.workbench.task.statusAll")}</SelectItem>
							{TASK_STATUS_ORDER.map((status) => (
								<SelectItem key={status} value={status}>
									{status}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button size="sm" variant="outline" disabled={props.busy} onClick={props.onRefresh}>
						{t("bios.workbench.refresh")}
					</Button>
					<Button size="sm" disabled={props.busy || projectId === null} onClick={props.onNew}>
						{t("bios.workbench.task.new")}
					</Button>
				</div>
			</div>

			{projectId === null ? <div className="mt-1 text-text-muted">{t("bios.workbench.task.needProject")}</div> : null}
			{projectId !== null && props.gap !== null ? <div className="mt-1 break-all text-text-muted">{t("bios.workbench.task.listGap", { reason: props.gap })}</div> : null}
			{projectId !== null && props.gap === null && props.tasks.length === 0 ? <div className="mt-1 text-text-muted">{props.loading ? t("bios.workbench.loading") : t("bios.workbench.task.empty")}</div> : null}
			{props.truncated ? <div className="mt-1 text-destructive">{t("bios.workbench.task.truncated")}</div> : null}

			<div className="mt-2 flex flex-col gap-1">
				{props.tasks.map((task) => {
					const active = task.taskId === props.selectedTaskId;
					return (
						<button key={task.taskId} type="button" className={`rounded border px-2 py-1 text-left ${active ? "border-border bg-surface-muted" : "border-transparent hover:border-border"}`} aria-pressed={active} disabled={props.busy} onClick={() => props.onSelect(task.taskId)}>
							<div className="flex items-center justify-between gap-2">
								<span className="min-w-0 truncate">{task.requirement || task.taskId}</span>
								<span className="shrink-0 text-text-muted">{task.status}</span>
							</div>
							<div className="break-all text-text-muted">
								{t("bios.workbench.task.listMeta", {
									taskId: task.taskId,
									workspace: task.workspaceId,
									updated: formatI18nDateTime(task.updatedAt),
									todos: task.todoCount,
									blockers: task.blockerCount,
								})}
							</div>
						</button>
					);
				})}
			</div>
		</section>
	);
});
