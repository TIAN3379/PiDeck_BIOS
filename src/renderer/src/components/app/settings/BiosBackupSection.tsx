/**
 * BM-07B B-07：**离线备份/恢复薄入口**（BIOS 设置里的独立组件）。
 *
 * 与桌面聊天配置备份**不是**同一格式、也不是同一套判据：知识库备份是
 * `core/storage/backup` 的 `backupVersion=1` 容器（`manifest.json` + `data/`）。
 *
 * 硬要求（计划 §B-07）：
 * - 导出前必须由**操作者**确认「本应用写入口已停止」与「外部 CLI/其它进程写入者已关闭」：
 *   两个勾选缺一不可，本组件没有默认勾选、也不会替用户确认；不宣传热一致快照；
 * - 只展示协议支持的**阶段/状态**：协议没有百分比进度，界面就不给百分比；
 * - 只恢复到**尚不存在的新目录**；覆盖当前知识根、已有目录、路径重叠与不安全链接
 *   一律由 core 拒绝（这些判据不在渲染层重写）；
 * - 恢复完成**不**切换知识根、**不**改授权：用户检查后必须自己去设置里选新根；
 * - 明确写出备份可能包含敏感工程资料；本批不上传、不自动计划、不迁移格式、不覆盖恢复。
 */
import { memo, useState } from "react";
import { Button } from "../../ui-shadcn/button";
import { Checkbox } from "../../ui-shadcn/checkbox";
import { Input } from "../../ui-shadcn/input";
import { t } from "../../../i18n";
import { useBiosBackup } from "../../../hooks/useBiosBackup";

function Line(props: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex gap-2">
			<span className="shrink-0 text-text-muted">{props.label}</span>
			<span className="min-w-0 break-all">{props.children}</span>
		</div>
	);
}

function ConsentCheckbox(props: { testId: string; checked: boolean; label: string; disabled: boolean; onChange: (next: boolean) => void }) {
	return (
		<label className="flex items-start gap-2 text-[11px] leading-relaxed">
			<Checkbox data-testid={props.testId} checked={props.checked} disabled={props.disabled} onCheckedChange={(next) => props.onChange(next === true)} />
			<span className="min-w-0">{props.label}</span>
		</label>
	);
}

export const BiosBackupSection = memo(function BiosBackupSection() {
	const backup = useBiosBackup();
	const busy = backup.busy !== null;
	const [exportName, setExportName] = useState("");
	const [exportAppQuiet, setExportAppQuiet] = useState(false);
	const [exportExternalClosed, setExportExternalClosed] = useState(false);
	const [restoreName, setRestoreName] = useState("");
	const [restoreSourceStable, setRestoreSourceStable] = useState(false);
	const [restoreTargetFree, setRestoreTargetFree] = useState(false);

	const store = backup.store;
	const exportReady = !backup.exportBlocked && backup.exportParentDir !== null && exportName.trim() !== "" && exportAppQuiet && exportExternalClosed && !busy;
	const restoreReady = backup.restoreSourceDir !== null && backup.restoreParentDir !== null && restoreName.trim() !== "" && restoreSourceStable && restoreTargetFree && !busy;

	return (
		<div data-testid="bios-backup-section" className="flex flex-col gap-4 p-1">
			<section className="rounded-md border border-destructive/60 p-3 text-[12px]">
				<div className="font-medium text-destructive">{t("bios.workbench.backup.sensitiveTitle")}</div>
				<div className="mt-1 leading-relaxed text-text-muted">{t("bios.workbench.backup.sensitiveHint")}</div>
				<div className="mt-1 leading-relaxed text-text-muted">{t("bios.workbench.backup.scopeHint")}</div>
			</section>

			{/* 源状态：不是 ready 就先把"能不能导出"说清楚，别让人填完才被拒。 */}
			<section className="rounded-md border border-border p-3">
				<div className="flex flex-wrap items-center justify-between gap-2">
					<span className="font-medium">{t("bios.workbench.backup.sourceTitle")}</span>
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void backup.refreshStore()}>
						{t("bios.workbench.refresh")}
					</Button>
				</div>
				{store === null ? (
					<div className="mt-1 text-text-muted">{backup.problem ?? t("bios.workbench.loading")}</div>
				) : (
					<div className="mt-1 flex flex-col gap-1">
						<Line label={t("settings.bios.statusLabel")}>{store.kind}</Line>
						{"root" in store ? <Line label={t("settings.bios.knowledgeRoot")}>{store.root}</Line> : null}
						{store.kind === "ready" ? <Line label={t("bios.workbench.backup.readyDetailLabel")}>{t("bios.workbench.store.readyDetail", { revision: store.registryRevision, version: store.schemaVersion, projects: store.projectCount })}</Line> : null}
						{backup.exportBlocked ? <div className="text-destructive">{t("bios.workbench.backup.notReady")}</div> : null}
					</div>
				)}
			</section>

			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.backup.exportTitle")}</div>
				<div className="mt-1 text-[11px] leading-relaxed text-text-muted">{t("bios.workbench.backup.exportHint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Input aria-label={t("bios.workbench.backup.exportName")} data-testid="bios-backup-export-name" className="h-7 w-48 text-[12px]" placeholder={t("bios.workbench.backup.exportNamePlaceholder")} value={exportName} onChange={(event) => setExportName(event.target.value)} />
					<Button size="sm" variant="outline" data-testid="bios-backup-pick-export-parent" disabled={busy} onClick={() => void backup.pickDir("export-parent", "bios.workbench.backup.pickExportParent")}>
						{t("bios.workbench.backup.pickExportParent")}
					</Button>
					<span data-testid="bios-backup-export-parent" className="min-w-0 break-all text-text-muted">
						{backup.exportParentDir ?? t("bios.workbench.backup.exportParentNone")}
					</span>
				</div>
				<div className="mt-2 flex flex-col gap-1">
					<ConsentCheckbox testId="bios-backup-consent-app-quiet" checked={exportAppQuiet} disabled={busy} label={t("bios.workbench.backup.consentAppQuiet")} onChange={setExportAppQuiet} />
					<ConsentCheckbox testId="bios-backup-consent-external-closed" checked={exportExternalClosed} disabled={busy} label={t("bios.workbench.backup.consentExternalClosed")} onChange={setExportExternalClosed} />
					<div className="text-[11px] text-text-muted">{t("bios.workbench.backup.consentNotProvable")}</div>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						data-testid="bios-backup-export-run"
						disabled={!exportReady}
						onClick={() => {
							void backup.exportBackup(exportName.trim(), exportAppQuiet && exportExternalClosed).then((outcome) => {
								// 完成/失败后都要重新确认：离线声明是"这一次操作"的声明。
								setExportAppQuiet(false);
								setExportExternalClosed(false);
								if (outcome !== null) void backup.refreshStore();
							});
						}}
					>
						{t("bios.workbench.backup.exportRun")}
					</Button>
					<span className="text-[11px] text-text-muted">{t("bios.workbench.backup.noPercent")}</span>
				</div>

				{backup.exportOutcome !== null ? (
					<div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
						<Line label={t("settings.bios.statusLabel")}>{backup.exportOutcome.status}</Line>
						<Line label={t("bios.workbench.backup.backupId")}>{backup.exportOutcome.backupId}</Line>
						<Line label={t("bios.workbench.backup.consistency")}>{backup.exportOutcome.consistency}</Line>
						<Line label={t("bios.workbench.backup.createdAt")}>{new Date(backup.exportOutcome.createdAt).toLocaleString()}</Line>
						<Line label={t("bios.workbench.backup.counts")}>{t("bios.workbench.backup.countsValue", { files: backup.exportOutcome.files, directories: backup.exportOutcome.directories, bytes: backup.exportOutcome.totalBytes })}</Line>
						<Line label={t("bios.workbench.backup.published")}>{String(backup.exportOutcome.published)}</Line>
						<Line label={t("bios.workbench.backup.cleanup")}>{backup.exportOutcome.cleanup}</Line>
						{backup.exportOutcome.residuals.length > 0 ? <div className="break-all text-destructive">{t("bios.workbench.backup.residuals", { list: backup.exportOutcome.residuals.join("、") })}</div> : null}
						{/* 完成标记已发布之后的问题不是"失败"，也不回滚：逐行如实说。 */}
						<div className="text-[11px] text-text-muted">{t("bios.workbench.backup.cleanupNotRollback")}</div>
					</div>
				) : null}
			</section>

			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.backup.restoreTitle")}</div>
				<div className="mt-1 text-[11px] leading-relaxed text-text-muted">{t("bios.workbench.backup.restoreHint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" data-testid="bios-backup-pick-restore-source" disabled={busy} onClick={() => void backup.pickDir("restore-source", "bios.workbench.backup.pickRestoreSource")}>
						{t("bios.workbench.backup.pickRestoreSource")}
					</Button>
					<span data-testid="bios-backup-restore-source" className="min-w-0 break-all text-text-muted">
						{backup.restoreSourceDir ?? t("bios.workbench.backup.restoreSourceNone")}
					</span>
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button size="sm" variant="outline" data-testid="bios-backup-pick-restore-parent" disabled={busy} onClick={() => void backup.pickDir("restore-target-parent", "bios.workbench.backup.pickRestoreParent")}>
						{t("bios.workbench.backup.pickRestoreParent")}
					</Button>
					<Input aria-label={t("bios.workbench.backup.restoreName")} data-testid="bios-backup-restore-name" className="h-7 w-48 text-[12px]" placeholder={t("bios.workbench.backup.restoreNamePlaceholder")} value={restoreName} onChange={(event) => setRestoreName(event.target.value)} />
					<span data-testid="bios-backup-restore-parent" className="min-w-0 break-all text-text-muted">
						{backup.restoreParentDir ?? t("bios.workbench.backup.restoreParentNone")}
					</span>
				</div>
				<div className="mt-2 flex flex-col gap-1">
					<ConsentCheckbox testId="bios-backup-consent-source-stable" checked={restoreSourceStable} disabled={busy} label={t("bios.workbench.backup.consentSourceStable")} onChange={setRestoreSourceStable} />
					<ConsentCheckbox testId="bios-backup-consent-target-free" checked={restoreTargetFree} disabled={busy} label={t("bios.workbench.backup.consentTargetFree")} onChange={setRestoreTargetFree} />
				</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<Button
						size="sm"
						data-testid="bios-backup-restore-run"
						disabled={!restoreReady}
						onClick={() => {
							void backup.restoreBackup(restoreName.trim(), restoreSourceStable && restoreTargetFree).then(() => {
								setRestoreSourceStable(false);
								setRestoreTargetFree(false);
							});
						}}
					>
						{t("bios.workbench.backup.restoreRun")}
					</Button>
					<span className="text-[11px] text-text-muted">{t("bios.workbench.backup.noPercent")}</span>
				</div>

				{backup.restoreOutcome !== null ? (
					<div className="mt-2 flex flex-col gap-1 border-t border-border pt-2">
						<Line label={t("settings.bios.statusLabel")}>{backup.restoreOutcome.status}</Line>
						<Line label={t("bios.workbench.backup.restoredTo")}>{backup.restoreOutcome.root}</Line>
						<Line label={t("bios.workbench.backup.backupId")}>{backup.restoreOutcome.backupId}</Line>
						<Line label={t("bios.workbench.backup.counts")}>{t("bios.workbench.backup.countsValue", { files: backup.restoreOutcome.files, directories: backup.restoreOutcome.directories, bytes: backup.restoreOutcome.totalBytes })}</Line>
						<Line label={t("bios.workbench.backup.published")}>{String(backup.restoreOutcome.published)}</Line>
						<Line label={t("bios.workbench.backup.cleanup")}>{backup.restoreOutcome.cleanup}</Line>
						{/* 提交点之后的复核问题：只报告"已提交、需复核"，不假称未写入。 */}
						{backup.restoreOutcome.reviewReasons.length > 0 ? <div className="break-all text-destructive">{t("bios.workbench.backup.reviewReasons", { list: backup.restoreOutcome.reviewReasons.join("、") })}</div> : null}
						{backup.restoreOutcome.residuals.length > 0 ? <div className="break-all text-destructive">{t("bios.workbench.backup.residuals", { list: backup.restoreOutcome.residuals.join("、") })}</div> : null}
						{backup.restoreOutcome.status === "committed-needs-review" ? <div className="text-[11px] text-destructive">{t("bios.workbench.backup.committedNeedsReview")}</div> : null}
						<div className="text-[11px] text-text-muted">{t("bios.workbench.backup.noAutoSwitch")}</div>
					</div>
				) : null}
			</section>

			{backup.problem !== null ? (
				<section role="status" className="rounded-md border border-destructive/60 p-3">
					<div className="break-all text-destructive">{backup.problem}</div>
					<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.backup.failureHint")}</div>
					<Button size="sm" variant="ghost" className="mt-2" onClick={backup.clearNotices}>
						{t("bios.workbench.dismiss")}
					</Button>
				</section>
			) : null}
		</div>
	);
});
