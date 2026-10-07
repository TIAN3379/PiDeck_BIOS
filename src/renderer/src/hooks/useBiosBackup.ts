/**
 * BM-07B B-07：**离线备份/恢复的薄入口状态**（复用 `core/storage/backup`，不新增格式）。
 *
 * 约定：
 * - 这里只搬 core 的结果与受控失败码，**不自己算进度、不自己拼清单**；
 * - `offlineConfirmed` 由调用方（界面上的人工勾选）传入，本 hook 不会给它默认值：
 *   没有勾选就是 `false`，服务层会拒绝——`offline-copy` 是声明而不是本应用能证明的结论；
 * - 恢复完成**不**改知识根、不改授权：本 hook 只读/只调用备份通道，不碰配置；
 * - 目录一律由系统选择器给出（只拿路径字符串），本 hook 不接受手输的绝对路径。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiosStoreStatus } from "../../../shared/types/bios";
import type { BiosBackupPickPurpose, ExportKnowledgeBackupResult, RestoreKnowledgeBackupResult } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export type BiosBackupState = {
	busy: string | null;
	problem: string | null;
	/** 源知识库状态（决定"能不能导出"）：未配置/未初始化/损坏/未来版本都必须先拒绝。 */
	store: BiosStoreStatus | null;
	/** 备份父目录与目标父目录（选择器给出；只存字符串，不存句柄）。 */
	exportParentDir: string | null;
	restoreSourceDir: string | null;
	restoreParentDir: string | null;
	exportOutcome: ExportKnowledgeBackupResult | null;
	restoreOutcome: RestoreKnowledgeBackupResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useBiosBackup() {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosBackupState>({ busy: null, problem: null, store: null, exportParentDir: null, restoreSourceDir: null, restoreParentDir: null, exportOutcome: null, restoreOutcome: null });
	const aliveRef = useRef(true);
	const epochRef = useRef(0);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const fresh = useCallback((epoch: number) => aliveRef.current && epoch === epochRef.current, []);
	const patch = useCallback((next: Partial<BiosBackupState>) => {
		if (!aliveRef.current) return;
		setState((previous) => ({ ...previous, ...next }));
	}, []);

	const refreshStore = useCallback(async () => {
		const epoch = epochRef.current;
		try {
			const store = await desktopApi.bios.storeStatus();
			if (!fresh(epoch)) return null;
			patch({ store });
			return store;
		} catch (error) {
			if (!fresh(epoch)) return null;
			patch({ store: null, problem: messageOf(error) });
			return null;
		}
	}, [fresh, patch]);

	useEffect(() => {
		void refreshStore();
	}, [refreshStore]);
	const invalidate = useCallback(() => {
		++epochRef.current;
		patch({ busy: null, problem: null, store: null, exportParentDir: null, restoreSourceDir: null, restoreParentDir: null, exportOutcome: null, restoreOutcome: null });
		void refreshStore();
	}, [patch, refreshStore]);
	useEffect(
		() =>
			desktopApi.bios.onChanged((event) => {
				if (event?.kind !== "selection") invalidate();
			}),
		[invalidate],
	);
	useEffect(() => {
		invalidate();
	}, [claim?.sessionRef.sessionId, claim?.sessionRef.agentId, claim?.runtimeGeneration, invalidate]);

	/** 目录选择：只回路径字符串；取消返回 null（不是"空路径"）。 */
	const pickDir = useCallback(
		async (purpose: BiosBackupPickPurpose, titleKey: "bios.workbench.backup.pickExportParent" | "bios.workbench.backup.pickRestoreSource" | "bios.workbench.backup.pickRestoreParent") => {
			const epoch = ++epochRef.current;
			patch({ busy: "pick", problem: null });
			try {
				const picked = await desktopApi.bios.pickBackupDir({ purpose, title: t(titleKey) });
				if (!fresh(epoch)) return null;
				if (picked.canceled || picked.path === null) {
					patch({ busy: null });
					return null;
				}
				const key = purpose === "export-parent" ? "exportParentDir" : purpose === "restore-source" ? "restoreSourceDir" : "restoreParentDir";
				patch({ busy: null, [key]: picked.path } as Partial<BiosBackupState>);
				return picked.path;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[fresh, patch, t],
	);

	const exportBackup = useCallback(
		async (name: string, offlineConfirmed: boolean) => {
			const parentDir = state.exportParentDir;
			if (parentDir === null) {
				patch({ problem: t("bios.workbench.backup.needExportParent") });
				return null;
			}
			if (claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "export", problem: null, exportOutcome: null });
			try {
				const outcome = await desktopApi.bios.exportBackup({ ...claim, parentDir, name, offlineConfirmed });
				if (!fresh(epoch)) return null;
				patch({ exportOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, fresh, patch, state.exportParentDir, t],
	);

	const restoreBackup = useCallback(
		async (name: string, offlineConfirmed: boolean) => {
			const backupRoot = state.restoreSourceDir;
			const parentDir = state.restoreParentDir;
			if (backupRoot === null) {
				patch({ problem: t("bios.workbench.backup.needRestoreSource") });
				return null;
			}
			if (parentDir === null) {
				patch({ problem: t("bios.workbench.backup.needRestoreParent") });
				return null;
			}
			if (claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const epoch = ++epochRef.current;
			patch({ busy: "restore", problem: null, restoreOutcome: null });
			try {
				const outcome = await desktopApi.bios.restoreBackup({ ...claim, backupRoot, parentDir, name, offlineConfirmed });
				if (!fresh(epoch)) return null;
				patch({ restoreOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, fresh, patch, state.restoreParentDir, state.restoreSourceDir, t],
	);

	const clearNotices = useCallback(() => patch({ problem: null, exportOutcome: null, restoreOutcome: null }), [patch]);

	/** 导出前必须满足的源条件（界面据此提示，服务层会再拒一次）。 */
	const exportBlocked = state.store === null || state.store.kind !== "ready";

	return useMemo(() => ({ ...state, claim, exportBlocked, refreshStore, pickDir, exportBackup, restoreBackup, clearNotices }), [state, claim, exportBlocked, refreshStore, pickDir, exportBackup, restoreBackup, clearNotices]);
}

export type BiosBackup = ReturnType<typeof useBiosBackup>;
