/** CW-04：默认展示摘要/活动/关键确认；手工管理保留，不丢既有能力。 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useStore } from "jotai";
import { currentSessionIdAtom, currentSessionMessagesAtom, currentSessionRuntimeAtom, currentSessionRuntimeUiAtom, sessionRecordsAtom } from "../../atoms/session-atoms";
import { sessionDraftByIdAtom, setSessionDraftAtom } from "../../atoms/composer-atoms";
import type { BiosWorkbench } from "../../hooks/useBiosWorkbench";
import type { BiosTasks } from "../../hooks/useBiosTasks";
import { t, type TranslationKey } from "../../i18n";
import { Button } from "../ui-shadcn/button";
import { projectWorkflowActivity } from "./workflowActivity";
import { biosProjectLabel } from "../../utils/biosProjectLabel";

const ACTIONS = ["analyse", "resume", "history", "reflect", "requirement", "memory", "stop"] as const;
type Action = (typeof ACTIONS)[number];
const TOOL_LABELS = new Map<string, TranslationKey>([
	["bios_manage_task", "bios.workflow.tool.tasks"],
	["bios_read_history", "bios.workflow.tool.history"],
	["bios_save_experience_draft", "bios.workflow.tool.draft"],
	["bios_confirm_project_fields", "bios.workflow.tool.confirm"],
	["bios_propose_feature", "bios.workflow.tool.featureWrite"],
	["bios_maintain_memory", "bios.workflow.tool.memory"],
	["bios_detect_project", "bios.workflow.tool.detect"],
	["bios_get_project_info", "bios.workflow.tool.project"],
	["bios_get_task", "bios.workflow.tool.taskRead"],
	["bios_search_knowledge", "bios.workflow.tool.search"],
	["bios_get_feature", "bios.workflow.tool.feature"],
	["bios_get_experience", "bios.workflow.tool.experience"],
	["bios_preview_context", "bios.workflow.tool.context"],
]);

export function BiosWorkflowOverview(props: { workbench: BiosWorkbench; tasks: BiosTasks; desktopProjectId?: string; onRestartRuntime?: () => void; onReview: () => void }) {
	const { workbench, tasks } = props;
	/** C5：宿主投影的自动记忆状态（默认面板只读显示；null = 没读到）。 */
	const automationStatus = workbench.automationStatus;
	const store = useStore();
	const sessionId = useAtomValue(currentSessionIdAtom);
	const runtime = useAtomValue(currentSessionRuntimeAtom);
	const ui = useAtomValue(currentSessionRuntimeUiAtom);
	const messages = useAtomValue(currentSessionMessagesAtom);
	const activity = useMemo(() => projectWorkflowActivity(messages), [messages]);
	const [hint, setHint] = useState<string | null>(null);
	const project = workbench.projects.find((item) => item.projectId === workbench.selectedProjectId);
	const pending = ui === undefined || ui.agentId !== runtime?.agentId || ui.runtimeGeneration !== runtime?.runtimeGeneration ? 0 : Object.values(ui.requests).filter((item) => item.status === "pending" || item.status === "responding").length;
	const refreshRef = useRef(tasks.refresh);
	const selectRef = useRef(tasks.selectTask);
	selectRef.current = tasks.selectTask;
	refreshRef.current = tasks.refresh;
	// 只同步 UI 候选；不发送命令、不打开上下文、不覆盖高级未保存表单。
	const aiTaskId = useMemo(() => {
		for (const message of messages.slice(-200).reverse()) {
			const receipt = message.meta?.biosWorkflowTask;
			if (message.role === "tool" && message.meta?.toolName === "bios_manage_task" && message.meta?.isError !== true && receipt && typeof receipt === "object" && "projectId" in receipt && "taskId" in receipt && receipt.projectId === workbench.selectedProjectId && typeof receipt.taskId === "string")
				return receipt.taskId;
		}
		return null;
	}, [messages, workbench.selectedProjectId]);
	// 仅摘要模式重读，避免 AI 落库后列表仍旧；不打断高级表单中的未保存编辑。
	// 列表刷新与详情选择共用 hook 的请求代次，必须串行；否则刷新会淘汰详情
	// 回执并遗留 busy=detail。卸载/换会话后不得再触发候选选择。
	useEffect(() => {
		let cancelled = false;
		if (runtime?.status === "idle") {
			void (async () => {
				const refreshed = await refreshRef.current({ keepSelection: true });
				// 初挂载时父 hook 也会刷新；本轮被淘汰不能再抢走胜出列表的代次。
				if (!cancelled && refreshed === true && aiTaskId) await selectRef.current(aiTaskId);
			})();
		}
		return () => {
			cancelled = true;
		};
	}, [sessionId, workbench.selectedProjectId, runtime?.agentId, runtime?.runtimeGeneration, runtime?.status, activity[0]?.id, aiTaskId]);
	useEffect(() => setHint(null), [sessionId, workbench.selectedProjectId, runtime?.runtimeGeneration]);
	function prepare(action: Action): void {
		const id = store.get(currentSessionIdAtom);
		const record = id === undefined ? undefined : store.get(sessionRecordsAtom)[id];
		if (!id || !props.desktopProjectId || record?.projectId !== props.desktopProjectId) {
			setHint(t("bios.onboarding.analysisNoSession"));
			return;
		}
		if ((store.get(sessionDraftByIdAtom)[id] ?? "").trim()) {
			setHint(t("bios.onboarding.analysisDraftBusy"));
			return;
		}
		store.set(setSessionDraftAtom, { sessionId: id, value: action === "stop" ? "/bios-workflow off" : t(`bios.workflow.prompt.${action}`, { projectId: JSON.stringify(project?.projectId ?? "") }) });
		setHint(t("bios.workflow.prepared"));
	}
	return (
		<div data-testid="bios-workflow-overview" className="flex flex-col gap-3">
			<section className="rounded-md border border-border p-3">
				<h3 className="font-medium">{t("bios.workflow.current")}</h3>
				{project ? (
					<>
						<p className="mt-2 break-all">{biosProjectLabel(project)}</p>
						<p className="mt-1 text-text-muted">
							{project.identity
								.filter((f) => ["ibv", "chipsetVendor", "boardName"].includes(f.field) && f.value !== null)
								.map((f) => `${f.value}${f.status === "confirmed" ? "" : ` (${t("bios.workflow.candidate")})`}`)
								.join(" · ") || t("bios.workflow.identityUnknown")}
						</p>
						<p className="mt-2 text-text-muted">{t("bios.workflow.taskSummary", { count: tasks.items.length })}</p>
						{aiTaskId && tasks.items.find((task) => task.taskId === aiTaskId) ? (
							<p data-testid="bios-workflow-current-task" className="mt-2 text-primary">
								{t("bios.workflow.currentTask", { requirement: tasks.items.find((task) => task.taskId === aiTaskId)?.requirement.slice(0, 100) ?? "" })}
							</p>
						) : null}
						{tasks.items.slice(0, 3).map((task) => (
							<p key={task.taskId} className="mt-1 break-words text-text-muted">
								{task.requirement.slice(0, 100)} · {task.status}
							</p>
						))}
						{tasks.listGap ? (
							<p role="status" className="mt-1 text-destructive">
								{tasks.listGap}
							</p>
						) : null}
						<p className="mt-2 text-text-muted">{t("bios.workflow.chatHint")}</p>
					</>
				) : (
					<p className="mt-2 text-text-muted">{t("bios.workflow.needOnboarding")}</p>
				)}
				{/* C5/D4：保存状态由**宿主读真实记录**后投影，不用扩展里的私有变量；
				    会话终结后由 hook 自动刷新，不需要用户点刷新。 */}
				<p data-testid="bios-workflow-automation-status" className="mt-2 text-text-muted">
					{automationStatus === null
						? t("bios.workflow.automationUnknown")
						: automationStatus.available
							? t("bios.workflow.automationStatus", { count: automationStatus.checkpoints, saved: automationStatus.durableSaved, pending: automationStatus.durablePending, unrecovered: automationStatus.durableUnrecovered, failed: automationStatus.durableFailed })
							: t("bios.workflow.automationUnavailable")}
				</p>
				{/* D2：容量满/失败/部分成功的**耐久回执**也如实显示，不只给计数。 */}
				{automationStatus !== null && automationStatus.available && automationStatus.receipt !== null ? (
					<p data-testid="bios-workflow-automation-receipt" className="mt-1 text-text-muted">
						{t("bios.workflow.automationReceipt", { detail: automationStatus.receipt.detail })}
					</p>
				) : null}
			</section>
			<section className="rounded-md border border-border p-3">
				<h3 className="font-medium">{t("bios.workflow.actions")}</h3>
				<div className="mt-2 flex flex-wrap gap-2">
					{ACTIONS.map((action) => (
						<Button key={action} size="sm" variant="outline" disabled={action !== "stop" && !project} onClick={() => prepare(action)}>
							{t(`bios.workflow.action.${action}`)}
						</Button>
					))}
				</div>
				{hint ? (
					<p role="status" className="mt-2 text-text-muted">
						{hint}
					</p>
				) : null}
				<p className="mt-2 text-text-muted">{t("bios.workflow.consentHint")}</p>
			</section>
			<section className="rounded-md border border-border p-3">
				<h3 className="font-medium">{t("bios.workflow.activity")}</h3>
				{activity.length === 0 ? (
					<p className="mt-2 text-text-muted">{t("bios.workflow.noActivity")}</p>
				) : (
					<ul className="mt-2 flex flex-col gap-2">
						{activity.map((item) => (
							<li key={item.id} className="shrink-0 break-all text-text-muted">
								<span title={item.toolName}>{t(TOOL_LABELS.get(item.toolName) ?? "bios.workflow.tool.other")}</span> · {t(`bios.workflow.state.${item.state}`)}
							</li>
						))}
					</ul>
				)}
			</section>
			<section className="rounded-md border border-border p-3">
				<h3 className="font-medium">{t("bios.workflow.confirmations")}</h3>
				<p className="mt-2 text-text-muted">{pending > 0 ? t("bios.workflow.pending", { count: pending }) : t("bios.workflow.noPending")}</p>
				<p className="mt-1 text-text-muted">{t("bios.workflow.reviewHint")}</p>
				<Button className="mt-2" size="sm" variant="outline" onClick={props.onReview}>
					{t("bios.workflow.review")}
				</Button>
			</section>
		</div>
	);
}
