/**
 * BM-07B B-03：知识库状态的**首次使用闸门**。
 *
 * 关键约定（计划 §B-03 第 1 条）：
 * - 四种状态必须分开显示：未配置 / 未初始化 / 就绪 / 未来版本 / 损坏 / 不可达；
 * - **选目录不隐式建库**：选目录只写配置；「创建知识库」是独立动作并二次确认；
 * - 不覆盖已有无效库、不自动迁移：损坏与未来版本只报事实并给出换目录建议。
 */
import { memo, useState } from "react";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { t } from "../../i18n";
import { desktopApi } from "../../desktopApi";
import type { BiosWorkbench } from "../../hooks/useBiosWorkbench";

export const BiosStoreGate = memo(function BiosStoreGate(props: { workbench: BiosWorkbench; onOpenSettings: () => void }) {
	const { workbench, onOpenSettings } = props;
	const status = workbench.storeStatus;
	const [confirming, setConfirming] = useState(false);
	const busy = workbench.busy !== null;

	async function pickAndSave() {
		const picked = await desktopApi.bios.pickKnowledgeRoot();
		if (picked.canceled || picked.path === null) return;
		await workbench.saveKnowledgeRoot(picked.path);
	}

	if (status === null) {
		return <section className="rounded-md border border-border p-3 text-[12px] text-text-muted">{workbench.loading ? t("bios.workbench.loading") : (workbench.problem ?? t("bios.workbench.store.unknown"))}</section>;
	}

	const frame = "rounded-md border border-border p-3 text-[12px]";
	const relink = (
		<div className="mt-2 flex flex-wrap gap-2">
			<Button size="sm" variant="outline" disabled={busy} onClick={() => void pickAndSave()}>
				{t("bios.workbench.store.pickRoot")}
			</Button>
			<Button size="sm" variant="ghost" disabled={busy} onClick={onOpenSettings}>
				{t("bios.workbench.gotoSettings")}
			</Button>
		</div>
	);

	if (status.kind === "unconfigured") {
		return (
			<section className={frame}>
				<div className="font-medium">{t("bios.workbench.store.unconfiguredTitle")}</div>
				<div className="mt-1 text-text-muted">{t("bios.workbench.store.unconfiguredHint")}</div>
				{relink}
			</section>
		);
	}

	if (status.kind === "directory-missing") {
		return (
			<section className={frame}>
				<div className="font-medium">{t("bios.workbench.store.directoryMissingTitle")}</div>
				<div className="mt-1 break-all text-text-muted">{status.root}</div>
				<div className="mt-1 text-text-muted">{t("bios.workbench.store.directoryMissingHint")}</div>
				{relink}
			</section>
		);
	}

	if (status.kind === "not-initialized") {
		return (
			<section className={frame}>
				<div className="font-medium">{t("bios.workbench.store.notInitializedTitle")}</div>
				<div className="mt-1 break-all text-text-muted">{status.root}</div>
				<div className="mt-1 text-text-muted">{t("bios.workbench.store.notInitializedHint")}</div>
				<div className="mt-2 flex flex-wrap gap-2">
					<Button size="sm" disabled={busy} onClick={() => setConfirming(true)}>
						{t("bios.workbench.store.create")}
					</Button>
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => void pickAndSave()}>
						{t("bios.workbench.store.pickRoot")}
					</Button>
				</div>
				{confirming ? (
					<ConfirmDialog
						title={t("bios.workbench.store.createConfirmTitle")}
						message={t("bios.workbench.store.createConfirmMessage", { root: status.root })}
						confirmLabel={t("bios.workbench.store.create")}
						onCancel={() => setConfirming(false)}
						onConfirm={() => {
							setConfirming(false);
							void workbench.createStore();
						}}
					/>
				) : null}
			</section>
		);
	}

	if (status.kind === "ready") {
		return (
			<section data-testid="bios-store-ready" className={frame}>
				<div className="flex items-center justify-between gap-2">
					<span className="font-medium">{t("bios.workbench.store.readyTitle")}</span>
					<span className="text-text-muted">{t("bios.workbench.store.readyBadge")}</span>
				</div>
				<div className="mt-1 break-all text-text-muted">{status.root}</div>
				<div className="mt-1 flex items-center justify-between gap-2">
					<span className="text-text-muted">{t("bios.onboarding.projectCount", { projects: workbench.settings.authorizedProjectIds.length })}</span>
					<Button size="sm" variant="ghost" disabled={busy} onClick={() => void workbench.refresh()}>
						{t("bios.workbench.refresh")}
					</Button>
				</div>
				<details className="mt-1 text-text-muted">
					<summary className="cursor-pointer">{t("bios.onboarding.storeAdvanced")}</summary>
					<div>{t("bios.workbench.store.readyDetail", { revision: status.registryRevision, version: status.schemaVersion, projects: status.projectCount })}</div>
				</details>
			</section>
		);
	}

	if (status.kind === "future-version" || status.kind === "corrupt") {
		const isFuture = status.kind === "future-version";
		return (
			<section className="rounded-md border border-destructive/60 p-3 text-[12px]">
				<div className="font-medium text-destructive">{isFuture ? t("bios.workbench.store.futureVersionTitle") : t("bios.workbench.store.corruptTitle")}</div>
				<div className="mt-1 break-all text-text-muted">{status.root}</div>
				<div className="mt-1 break-all text-text-muted">{status.detail}</div>
				{/* 「不覆盖已有无效库、不自动迁移」必须写在界面上，而不是只写在实现里。 */}
				<div className="mt-1 text-text-muted">{t("bios.workbench.store.noTouchHint")}</div>
				{relink}
			</section>
		);
	}

	if (status.kind === "unreachable") {
		return (
			<section className="rounded-md border border-destructive/60 p-3 text-[12px]">
				<div className="font-medium text-destructive">{t("bios.workbench.store.unreachableTitle")}</div>
				<div className="mt-1 break-all text-text-muted">{status.detail}</div>
				<div className="mt-2 flex flex-wrap gap-2">
					<Button size="sm" variant="outline" disabled={busy} onClick={() => void workbench.refresh()}>
						{t("bios.workbench.retry")}
					</Button>
					<Button size="sm" variant="ghost" disabled={busy} onClick={onOpenSettings}>
						{t("bios.workbench.gotoSettings")}
					</Button>
				</div>
			</section>
		);
	}

	// 所有状态都已显式分支；留一个空返回，避免将来新增状态时静默渲染出"正确样子"。
	return null;
});
