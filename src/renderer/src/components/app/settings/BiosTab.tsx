/**
 * BM-07A/BM-07B BIOS 设置视图。
 *
 * 职责边界（bm07b §B-03）：这里**只保留可信配置、运行状态与工作台入口**；
 * 项目登记/字段确认/任务/知识等业务在右侧「BIOS 工作台」抽屉里做，不再往设置弹框里堆业务界面。
 * 异步状态和身份守卫统一由 useBiosPanel/controller 管理。
 */
import { memo, useEffect, useMemo, useState } from "react";
import { useSetAtom } from "jotai";
import { t } from "../../../i18n";
import { settingsOpenAtom, workspaceDrawerRequestAtom } from "../../../atoms";
import { useBiosPanel } from "../../../hooks/useBiosPanel";
import { BiosBackupSection } from "./BiosBackupSection";
import type { BiosHostSettings } from "../../../../../shared/types/bios";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { Textarea } from "../../ui-shadcn/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { selectionView } from "./biosPanelState";
import { biosProjectLabel } from "../../../utils/biosProjectLabel";

function splitList(value: string): string[] {
	return value
		.split(/[\n,，;；]+/)
		.map((entry) => entry.trim())
		.filter(Boolean);
}
function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex gap-2 text-[12px]">
			<span className="shrink-0 text-text-muted">{label}</span>
			<span className="min-w-0 break-all whitespace-pre-wrap">{value}</span>
		</div>
	);
}

export const BiosTab = memo(function BiosTab() {
	const { panel, settings, readiness, runtime: runtimeState, claim, controller } = useBiosPanel();
	const [rootDraft, setRootDraft] = useState("");
	const [projectsDraft, setProjectsDraft] = useState("");
	const [featuresDraft, setFeaturesDraft] = useState("");
	const [customersDraft, setCustomersDraft] = useState("");
	const [rootsDraft, setRootsDraft] = useState("");
	const [endpointDraft, setEndpointDraft] = useState<BiosHostSettings["endpoint"]>("unknown");
	const [automationDraft, setAutomationDraft] = useState(false);
	useEffect(() => {
		setRootDraft(settings.knowledgeRoot ?? "");
		setProjectsDraft(settings.authorizedProjectIds.join("\n"));
		setFeaturesDraft(settings.allowedFeatureIds.join("\n"));
		setCustomersDraft(settings.approvedCustomers.join("\n"));
		setRootsDraft(settings.authorizedRoots.join("\n"));
		setEndpointDraft(settings.endpoint);
		setAutomationDraft(settings.automation.enabled);
	}, [settings]);
	const view = selectionView(panel);
	const inputClass = "w-full text-[12px]";
	const statusLabel = view.status === "synced" ? t("settings.bios.statusSynced") : view.status === "candidate" ? t("settings.bios.statusCandidate") : t("settings.bios.statusNone");
	// AW：开关状态改变才递增许可版本（让已运行会话的旧指纹失效）；未改则原样回写，避免无意义失效。
	const nextAutomation: BiosHostSettings["automation"] = automationDraft === settings.automation.enabled ? settings.automation : { enabled: automationDraft, localBookkeeping: automationDraft, injectProjectData: automationDraft, version: settings.automation.version + 1 };
	// 未保存的草稿：打开工作台前必须挡住，否则关闭设置会静默丢改动。
	const dirty = useMemo(
		() =>
			rootDraft !== (settings.knowledgeRoot ?? "") ||
			projectsDraft !== settings.authorizedProjectIds.join("\n") ||
			featuresDraft !== settings.allowedFeatureIds.join("\n") ||
			customersDraft !== settings.approvedCustomers.join("\n") ||
			rootsDraft !== settings.authorizedRoots.join("\n") ||
			endpointDraft !== settings.endpoint ||
			automationDraft !== settings.automation.enabled,
		[rootDraft, projectsDraft, featuresDraft, customersDraft, rootsDraft, endpointDraft, automationDraft, settings],
	);
	const [entryHint, setEntryHint] = useState<string | null>(null);
	const requestDrawer = useSetAtom(workspaceDrawerRequestAtom);
	const closeSettings = useSetAtom(settingsOpenAtom);
	return (
		<div className="flex flex-col gap-4 p-1">
			<div className="text-[12px] leading-relaxed text-text-muted">{t("settings.bios.intro")}</div>
			<section className="rounded-md border border-border p-3">
				<div className="mb-2 text-[13px] font-medium">{t("settings.bios.workbenchSectionTitle")}</div>
				<div className="text-[12px] leading-relaxed text-text-muted">{t("settings.bios.workbenchSectionHint")}</div>
				<div className="mt-2 flex items-center gap-2">
					<Button
						size="sm"
						onClick={() => {
							// 有未保存草稿时不关设置（交给既有未保存守卫），只提示先保存/放弃。
							if (dirty) {
								setEntryHint(t("settings.bios.workbenchDirtyHint"));
								return;
							}
							setEntryHint(null);
							closeSettings(false);
							requestDrawer("bios");
						}}
					>
						{t("settings.bios.workbenchOpen")}
					</Button>
					{entryHint !== null ? <span className="text-[12px] text-destructive">{entryHint}</span> : null}
				</div>
			</section>
			<section className="rounded-md border border-border p-3">
				<div className="mb-2 text-[13px] font-medium">{t("settings.bios.readiness")}</div>
				<Row label={t("settings.bios.stateLabel")} value={readiness.ready ? t("settings.bios.readinessReady") : (readiness.reason ?? "-")} />
				<details className="mt-2">
					<summary className="cursor-pointer text-[12px] text-text-muted">{t("bios.onboarding.runtimeAdvanced")}</summary>
					<div className="mt-2 text-[13px] font-medium">{t("settings.bios.runtime")}</div>
					<Row label={t("settings.bios.configVersionLabel")} value={String(runtimeState.configVersion)} />
					{runtimeState.pendingRestart && runtimeState.note !== null ? <div className="mt-1 text-[12px] text-text-muted">{runtimeState.note}</div> : null}
					{runtimeState.stoppedRuntimes.length > 0 ? <div className="mt-1 text-[12px] text-text-muted">{`${t("settings.bios.runtimeStopped")}：${runtimeState.stoppedRuntimes.join("、")}`}</div> : null}
					{/* B-01：撤权未完成必须显著提示（旧进程可能仍有旧许可），不得显示成"安全已生效"。 */}
					{runtimeState.stopFailures.length > 0 ? <div className="mt-1 break-all text-[12px] text-destructive">{`${t("settings.bios.runtimeStopFailures")}：${runtimeState.stopFailures.map((entry) => `${entry.agentId}（${entry.reason}）`).join("；")}`}</div> : null}
					{!runtimeState.pendingRestart ? <div className="mt-1 text-[12px] text-text-muted">{t("settings.bios.runtimeClear")}</div> : null}
				</details>
				{runtimeState.pendingRestart ? <p className="mt-2 text-[12px] text-text-muted">{t("bios.onboarding.restartHint")}</p> : null}
				{runtimeState.stopFailures.length > 0 ? <p className="mt-1 text-[12px] text-destructive">{t("bios.workbench.runtimeStopFailures")}</p> : null}
			</section>
			<section className="rounded-md border border-border p-3">
				<div className="mb-2 text-[13px] font-medium">{t("settings.bios.configSection")}</div>
				<div className="mb-2 flex items-center gap-2">
					<Input aria-label={t("settings.bios.knowledgeRoot")} className={inputClass} value={rootDraft} onChange={(event) => setRootDraft(event.target.value)} />
					<Button
						size="sm"
						variant="outline"
						disabled={panel.busy !== null}
						onClick={() =>
							void controller.pickKnowledgeRoot().then((path) => {
								if (path !== null) setRootDraft(path);
							})
						}
					>
						{t("settings.bios.pickRoot")}
					</Button>
				</div>
				<div className="mb-2 flex items-center gap-2 text-[12px]">
					<span className="shrink-0 text-text-muted">{t("settings.bios.endpoint")}</span>
					<Select
						value={endpointDraft}
						onValueChange={(value) => {
							if (value === "allowed" || value === "denied" || value === "unknown") setEndpointDraft(value);
						}}
					>
						<SelectTrigger aria-label={t("settings.bios.endpoint")} className={inputClass}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="allowed">{t("bios.onboarding.endpointAllowed")}</SelectItem>
							<SelectItem value="denied">{t("bios.onboarding.endpointDenied")}</SelectItem>
							<SelectItem value="unknown">{t("bios.onboarding.endpointUnknown")}</SelectItem>
						</SelectContent>
					</Select>
				</div>
				<p className="mb-2 text-[12px] text-text-muted">{t("bios.onboarding.endpointHint")}</p>
				<details className="mb-2">
					<summary className="cursor-pointer text-[12px] text-text-muted">{t("bios.onboarding.authorizationAdvanced")}</summary>
					<label className="mb-2 block text-[12px] text-text-muted">
						{t("settings.bios.projects")}
						<Textarea className={`${inputClass} min-h-16`} value={projectsDraft} onChange={(event) => setProjectsDraft(event.target.value)} />
					</label>
					<label className="mb-2 block text-[12px] text-text-muted">
						{t("settings.bios.features")}
						<Textarea className={`${inputClass} min-h-12`} value={featuresDraft} onChange={(event) => setFeaturesDraft(event.target.value)} />
					</label>
					<label className="mb-2 block text-[12px] text-text-muted">
						{t("settings.bios.customers")}
						<Textarea className={`${inputClass} min-h-12`} value={customersDraft} onChange={(event) => setCustomersDraft(event.target.value)} />
					</label>
					<label className="mb-2 block text-[12px] text-text-muted">
						{t("settings.bios.roots")}
						<Textarea className={`${inputClass} min-h-16`} value={rootsDraft} onChange={(event) => setRootsDraft(event.target.value)} />
					</label>
				</details>
				{/* AW：默认自主工作流的**持久开关**。关闭只影响自动准备/检索/记账；不影响手工工具与确认链。 */}
				<label className="mb-2 flex items-start gap-2 rounded-md border border-border p-2 text-[12px]">
					<Checkbox data-testid="bios-settings-automation" aria-label={t("settings.bios.automationEnabled")} checked={automationDraft} disabled={panel.busy !== null} onCheckedChange={(checked) => setAutomationDraft(checked === true)} />
					<span>
						{t("settings.bios.automationEnabled")}
						<div className="text-text-muted">{t("settings.bios.automationHint")}</div>
					</span>
				</label>
				<Button
					size="sm"
					disabled={panel.busy !== null}
					onClick={() =>
						void controller.saveSettings({
							knowledgeRoot: rootDraft.trim() || null,
							authorizedProjectIds: splitList(projectsDraft),
							allowedFeatureIds: splitList(featuresDraft),
							approvedCustomers: splitList(customersDraft),
							authorizedRoots: splitList(rootsDraft),
							endpoint: endpointDraft,
							automation: nextAutomation,
						})
					}
				>
					{t("settings.bios.save")}
				</Button>
				<div className="mt-1 text-[11px] text-text-muted">{settings.knowledgeRoot === null ? t("settings.bios.noRootHint") : `${t("settings.bios.knowledgeRoot")}：${settings.knowledgeRoot}`}</div>
			</section>
			<details className="rounded-md border border-border p-3">
				<summary className="cursor-pointer text-[13px] font-medium">{t("bios.onboarding.contextAdvanced")}</summary>
				<section className="mt-2">
					<div className="mb-2 text-[13px] font-medium">{t("settings.bios.sessionSection")}</div>
					{claim === null ? (
						<div className="text-[12px] text-text-muted">{t("settings.bios.noSession")}</div>
					) : (
						<>
							<Row label={t("settings.bios.agentLabel")} value={`${claim.sessionRef.agentId}｜generation ${claim.runtimeGeneration}`} />
							<div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
								<span className="text-text-muted">{t("settings.bios.project")}</span>
								<Select value={view.projectId ?? "__none__"} onValueChange={(value) => void controller.selectProject(value === "__none__" ? "" : value)}>
									<SelectTrigger aria-label={t("settings.bios.project")} className={inputClass}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none__">{t("settings.bios.statusNone")}</SelectItem>
										{panel.projects.map((project) => (
											<SelectItem key={project.projectId} value={project.projectId}>
												{biosProjectLabel(project)}（{t("settings.bios.reviewCount")} {project.needsReviewCount}）
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<span className="text-text-muted">{t("settings.bios.task")}</span>
								<Select value={view.taskId ?? "__none__"} onValueChange={(value) => controller.selectTask(value === "__none__" ? "" : value)}>
									<SelectTrigger aria-label={t("settings.bios.task")} className={inputClass}>
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="__none__">{t("settings.bios.taskUnselected")}</SelectItem>
										{panel.tasks.map((task) => (
											<SelectItem key={task.taskId} value={task.taskId}>
												{task.taskId}（{task.status}）
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<Button size="sm" variant="outline" disabled={panel.busy !== null} onClick={() => void controller.refreshProjects()}>
									{t("settings.bios.refresh")}
								</Button>
							</div>
							<Row label={t("settings.bios.selectionLabel")} value={statusLabel} />
							<div className="mt-2 flex flex-wrap gap-2">
								<Button size="sm" disabled={panel.busy !== null} onClick={() => void controller.applySelection(true)}>
									{t("settings.bios.selectOn")}
								</Button>
								<Button size="sm" variant="outline" disabled={panel.busy !== null} onClick={() => void controller.applySelection(false)}>
									{t("settings.bios.selectOff")}
								</Button>
							</div>
						</>
					)}
				</section>
				<section className="rounded-md border border-border p-3">
					<div className="mb-2 text-[13px] font-medium">{t("settings.bios.previewSection")}</div>
					<Button size="sm" variant="outline" disabled={panel.busy !== null || claim === null} onClick={() => void controller.buildPreview()}>
						{t("settings.bios.preview")}
					</Button>
					{panel.preview !== null ? (
						<div className="mt-2 flex flex-col gap-1">
							<Row label={t("settings.bios.statusLabel")} value={panel.preview.status} />
							<Row label={t("settings.bios.maySend")} value={String(panel.preview.maySendToModel)} />
							<Row label={t("settings.bios.identity")} value={String(panel.preview.identityUsable)} />
							<Row label={t("settings.bios.stable")} value={String(panel.preview.stable)} />
							<Row
								label={t("settings.bios.budget")}
								value={`${panel.preview.budget.usedChars}/${panel.preview.budget.maxChars} ${t("settings.bios.budgetChars")}，${panel.preview.budget.usedBytes}/${panel.preview.budget.maxBytes} ${t("settings.bios.budgetBytes")}${panel.preview.budget.truncated ? t("settings.bios.truncated") : ""}`}
							/>
							<Row label={t("settings.bios.sources")} value={`${panel.preview.retainedSourceCount} / ${panel.preview.inspectedSourceCount}`} />
							{panel.preview.outboundNote !== null ? <Row label={t("settings.bios.endpoint")} value={panel.preview.outboundNote} /> : null}
							{panel.preview.retainedSources.map((source) => (
								<Row key={`${source.recordKind}:${source.recordId}:${source.revision}`} label={source.recordKind} value={`${source.recordId} @${source.revision}`} />
							))}
							{panel.preview.expiredSources.length ? <Row label={t("settings.bios.gap")} value={panel.preview.expiredSources.join("\n")} /> : null}
							<pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 text-[11px] leading-relaxed">{panel.preview.text}</pre>
						</div>
					) : null}
				</section>
			</details>
			{/* BM-07B B-07：离线备份/恢复是独立组件——它与桌面聊天配置备份不是同一格式，也不共用判据。 */}
			<BiosBackupSection />
			{panel.problem !== null || panel.receipt !== null ? (
				<div role="status" className="rounded-md border border-border p-2 text-[12px]">
					{panel.problem !== null ? <Row label={t("settings.bios.gap")} value={panel.problem} /> : null}
					{panel.receipt !== null ? <Row label={t("settings.bios.receipt")} value={panel.receipt.text} /> : null}
				</div>
			) : null}
		</div>
	);
});
