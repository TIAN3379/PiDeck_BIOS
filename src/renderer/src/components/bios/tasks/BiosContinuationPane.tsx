/**
 * BM-07B B-06：**换对话接续**（新对话选同一 taskId → 重读事实 → 预览/确认应用）。
 *
 * 铁律（计划 §B-06 第 4～6 条）：
 * - 入口列出**项目已有任务**，由工程师选同一个 taskId；不做"自动接着上次"的魔法；
 * - 预览**重读磁盘事实**（任务/档案/来源/工作区），显示 revision、缺口与预算；
 * - **本地交接包与模型可发送预览分开展示**：允许发给模型的判断来自预览本身，
 *   本组件不提供"把本地拒发正文发给当前模型"的按钮；
 * - 上下文开关**默认关闭**：先"只选任务"，要开上下文必须再点一次；
 * - 清单保存（带 CAS）与重验是**独立显式动作**；历史清单不是"已注入"的证明。
 */
import { memo, useEffect, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { t } from "../../../i18n";
import { copyTextWithCopiedNotice } from "../../../utils/clipboardNotice";
import type { BiosContinuation } from "../../../hooks/useBiosContinuation";
import type { BiosTasks } from "../../../hooks/useBiosTasks";

const INPUT_CLASS = "h-7 w-full text-[12px]";

function Line(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2">
			<span className="shrink-0 text-text-muted">{props.label}</span>
			<span className="min-w-0 break-all">{props.children}</span>
		</div>
	);
}

export const BiosContinuationPane = memo(function BiosContinuationPane(props: { continuation: BiosContinuation; tasks: BiosTasks; projectId: string | null; onNew?: () => void }) {
	const { continuation, tasks } = props;
	const busy = continuation.busy !== null || tasks.busy !== null;
	const [taskId, setTaskId] = useState<string>(tasks.selectedTaskId ?? "");
	useEffect(() => {
		setTaskId(tasks.selectedTaskId ?? "");
	}, [props.projectId, tasks.selectedTaskId]);
	const [manifestId, setManifestId] = useState("");
	const [expectedRevision, setExpectedRevision] = useState("");
	const preview = continuation.preview;
	const task = tasks.detail?.task ?? null;

	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.continuation.title")}</div>
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.continuation.hint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Select value={taskId === "" ? "__none__" : taskId} onValueChange={setTaskId}>
						<SelectTrigger aria-label={t("bios.workbench.continuation.task")} className={`${INPUT_CLASS} w-64`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="__none__">{t("settings.bios.statusNone")}</SelectItem>
							{tasks.visibleItems.map((entry) => (
								<SelectItem key={entry.taskId} value={entry.taskId}>
									{`${entry.taskId}（${entry.status}）`}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button size="sm" variant="outline" disabled={busy || taskId === "" || taskId === "__none__"} onClick={() => void tasks.selectTask(taskId)}>
						{t("bios.workbench.continuation.openTask")}
					</Button>
					<Button
						size="sm"
						disabled={busy || task === null}
						onClick={() => {
							if (task === null) return;
							void continuation.buildPreview(task.id, task.workspace.workspaceId);
						}}
					>
						{t("bios.workbench.continuation.preview")}
					</Button>
				</div>
				{props.projectId === null ? <div className="mt-1 text-text-muted">{t("bios.workbench.task.needProject")}</div> : null}
				{props.projectId !== null && tasks.listGap !== null ? (
					<p role="status" className="mt-1 break-all text-destructive">
						{t("bios.workbench.task.listGap", { reason: tasks.listGap })}
					</p>
				) : null}
				{props.projectId !== null && tasks.listGap === null && tasks.visibleItems.length === 0 ? (
					<p role="status" className="mt-1 text-text-muted">
						{tasks.loading ? t("bios.workbench.loading") : t(tasks.items.length === 0 ? "bios.history.noTasks" : "bios.history.filteredTasks")}
					</p>
				) : null}
				{props.projectId !== null && tasks.listGap === null && !tasks.loading && tasks.items.length === 0 && props.onNew ? (
					<Button size="sm" variant="outline" className="mt-2" onClick={props.onNew}>
						{t("bios.history.newTask")}
					</Button>
				) : null}
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.continuation.defaultOffHint")}</div>
				<div className="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="outline" disabled={busy || task === null} onClick={() => void tasks.applyContext(false)}>
						{t("bios.workbench.continuation.selectOnly")}
					</Button>
					{/* 打开上下文是**第二个显式动作**：默认关闭，不能因为点了"接续"就自动继承上一会话。 */}
					<Button size="sm" disabled={busy || task === null} onClick={() => void tasks.applyContext(true)}>
						{t("bios.workbench.continuation.applyWithContext")}
					</Button>
				</div>
				{tasks.selection !== null ? (
					<div className="mt-2 flex flex-col gap-1">
						<Line label={t("bios.workbench.task.contextMode")}>{tasks.selection.mode}</Line>
						<Line label={t("bios.workbench.task.contextReceipt")}>{tasks.selection.receipt}</Line>
						{!tasks.selection.currentSessionSynced ? <div className="text-destructive">{t("bios.workbench.task.contextNotSynced")}</div> : null}
					</div>
				) : null}
			</section>

			{preview !== null ? (
				<section className="rounded-md border border-border p-3">
					<div className="font-medium">{t("bios.workbench.continuation.previewTitle")}</div>
					<div className="mt-1 flex flex-col gap-1">
						<Line label={t("settings.bios.statusLabel")}>{preview.status}</Line>
						{/* 本地交接包与模型可发送分开：这里先说清"能不能发"。 */}
						<Line label={t("bios.workbench.continuation.maySendToModel")}>{String(preview.maySendToModel)}</Line>
						<Line label={t("bios.workbench.continuation.identityUsable")}>{String(preview.identityUsable)}</Line>
						<Line label={t("settings.bios.stable")}>{String(preview.stable)}</Line>
						<Line label={t("settings.bios.budget")}>{`${preview.budget.usedChars}/${preview.budget.maxChars} ${t("settings.bios.budgetChars")}${preview.budget.truncated ? t("settings.bios.truncated") : ""}${preview.budget.clamped ? t("bios.workbench.continuation.clamped") : ""}`}</Line>
						{preview.outboundNote !== null ? <Line label={t("settings.bios.endpoint")}>{preview.outboundNote}</Line> : null}
						<Line label={t("settings.bios.sources")}>{`${preview.retainedSourceCount} / ${preview.inspectedSourceCount}${preview.sourcesTruncated ? t("settings.bios.truncated") : ""}`}</Line>
					</div>
					{preview.retainedSources.map((source) => (
						<div key={`${source.recordKind}:${source.recordId}`} className="break-all text-text-muted">{`${source.recordKind}｜${source.recordId} @${source.revision}`}</div>
					))}
					{preview.expiredSources.length > 0 ? <div className="mt-1 break-all text-destructive">{`${t("bios.workbench.continuation.expiredSources")}：${preview.expiredSources.join("；")}`}</div> : null}
					{preview.problems.map((line) => (
						<div key={line} className="break-all text-destructive">
							{line}
						</div>
					))}
					<div className="mt-2 text-[11px] text-text-muted">{t("bios.workbench.continuation.localCopyWarning")}</div>
					<div className="mt-1 flex flex-wrap gap-2">
						<Button size="sm" variant="outline" disabled={busy} onClick={() => void copyTextWithCopiedNotice(preview.text)}>
							{t("bios.workbench.continuation.copyLocal")}
						</Button>
					</div>
					<pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-muted p-2 text-[11px] leading-relaxed">{preview.text}</pre>
					{/* 刻意没有"发送给模型"按钮：本批不做本地→模型的外发动作。 */}
					<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.continuation.noSendButton")}</div>
				</section>
			) : null}

			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.continuation.manifestTitle")}</div>
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.continuation.manifestHint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Input aria-label={t("bios.workbench.continuation.manifestId")} className={`${INPUT_CLASS} min-w-40 flex-1`} placeholder={t("bios.workbench.continuation.manifestIdPlaceholder")} value={manifestId} onChange={(event) => setManifestId(event.target.value)} />
					<Input aria-label={t("bios.workbench.continuation.expectedRevision")} className={`${INPUT_CLASS} w-32`} placeholder={t("bios.workbench.continuation.expectedRevision")} value={expectedRevision} onChange={(event) => setExpectedRevision(event.target.value)} />
					<Button
						size="sm"
						disabled={busy || preview === null}
						onClick={() => {
							const expected = expectedRevision.trim() === "" ? null : Number(expectedRevision);
							void continuation.saveManifest(manifestId, expected !== null && Number.isSafeInteger(expected) ? expected : null);
						}}
					>
						{t("bios.workbench.continuation.saveManifest")}
					</Button>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void continuation.verifyManifest(manifestId)}>
						{t("bios.workbench.continuation.verifyManifest")}
					</Button>
				</div>
				{continuation.manifest !== null ? (
					<div className="mt-2 flex flex-col gap-1">
						<Line label={t("bios.workbench.task.writeStatus", { status: continuation.manifest.status })}>{`${continuation.manifest.manifestId}${continuation.manifest.revision === null ? "" : ` @${continuation.manifest.revision}`}`}</Line>
						{continuation.manifest.problems.map((line) => (
							<div key={line} className="break-all text-destructive">
								{line}
							</div>
						))}
					</div>
				) : null}
				{continuation.manifestVerify !== null ? (
					<div className="mt-2 flex flex-col gap-1">
						{/* 重验按当前事实给逐来源状态：历史清单不等于"已注入"。 */}
						<Line label={t("bios.workbench.task.writeStatus", { status: continuation.manifestVerify.status })}>{`${continuation.manifestVerify.manifestId}${continuation.manifestVerify.manifestRevision === null ? "" : ` @${continuation.manifestVerify.manifestRevision}`}`}</Line>
						<Line label={t("bios.workbench.continuation.profileState")}>{continuation.manifestVerify.profileState}</Line>
						{continuation.manifestVerify.sources.map((source) => (
							<div key={`${source.recordKind}:${source.recordId}`} className={source.state === "current" ? "break-all text-text-muted" : "break-all text-destructive"}>{`${source.recordKind}｜${source.recordId}：${source.state}（${source.reason}）`}</div>
						))}
						{continuation.manifestVerify.problems.map((line) => (
							<div key={line} className="break-all text-destructive">
								{line}
							</div>
						))}
					</div>
				) : null}
			</section>

			{continuation.problem !== null ? (
				<div className="flex flex-col gap-1">
					<div className="break-all text-destructive">{continuation.problem}</div>
					<Button size="sm" variant="ghost" disabled={busy} onClick={continuation.clearNotices}>
						{t("bios.workbench.dismiss")}
					</Button>
				</div>
			) : null}
		</div>
	);
});
