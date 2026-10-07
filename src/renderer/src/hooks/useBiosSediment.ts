/**
 * BM-07B B-06：**任务沉淀经验**（有限预填 + 显式保存，分步结果如实呈现）。
 *
 * 约定：
 * - 预填来自 `prepareExperienceDraftFromTask`（只读**已保存的任务**，不后台扫描聊天）；
 * - 保存走 `saveExperienceDraftFromTask`：card/link 是**两步**，草稿成功而回链冲突时
 *   **保留草稿 ID**，只补回链，不重建第二张卡、不假称全部回滚（core 已按此返回分步结果）；
 * - 预填与保存结果都带请求代次：切换任务后的过期响应直接丢弃。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskDraftSaveResult, TaskExperiencePrefill } from "../../../shared/types/biosBusiness";
import type { ExperienceDraft } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export type BiosSedimentState = {
	busy: string | null;
	problem: string | null;
	prefill: TaskExperiencePrefill | null;
	saveOutcome: TaskDraftSaveResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useBiosSediment(input: { projectId: string | null; taskId: string | null }) {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosSedimentState>({ busy: null, problem: null, prefill: null, saveOutcome: null });
	const epochRef = useRef(0);
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const patch = useCallback((next: Partial<BiosSedimentState>) => {
		if (!aliveRef.current) return;
		setState((previous) => ({ ...previous, ...next }));
	}, []);

	const loadPrefill = useCallback(async () => {
		const epoch = ++epochRef.current;
		if (input.projectId === null || input.taskId === null) {
			patch({ prefill: null, saveOutcome: null, busy: null, problem: null });
			return null;
		}
		if (claim === null) {
			patch({ prefill: null, saveOutcome: null, busy: null, problem: t("bios.workbench.noSession") });
			return null;
		}
		patch({ busy: "prefill", problem: null, prefill: null, saveOutcome: null });
		try {
			const outcome = await desktopApi.bios.prepareDraft({ ...claim, projectId: input.projectId, taskId: input.taskId });
			if (epoch !== epochRef.current || !aliveRef.current) return null;
			patch({ prefill: outcome.guard.stable ? outcome.result.prefill : null, busy: null, problem: outcome.guard.stable ? (outcome.result.problems.length > 0 ? outcome.result.problems.join("；") : null) : outcome.guard.staleReason });
			return outcome;
		} catch (error) {
			if (epoch !== epochRef.current || !aliveRef.current) return null;
			patch({ busy: null, problem: messageOf(error) });
			return null;
		}
	}, [claim, input.projectId, input.taskId, patch, t]);

	useEffect(() => {
		void loadPrefill();
	}, [loadPrefill]);
	useEffect(
		() =>
			desktopApi.bios.onChanged((event) => {
				if (event?.kind === "selection") return;
				++epochRef.current;
				patch({ prefill: null, saveOutcome: null, busy: null, problem: null });
			}),
		[patch],
	);

	/** 保存草稿：`expectedTaskRevision` 为 null 表示只建卡不回链（用户显式选择）。 */
	const saveDraft = useCallback(
		async (experience: Omit<ExperienceDraft, "sourceProjectId">, expectedTaskRevision: number | null) => {
			if (input.projectId === null || input.taskId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			epochRef.current += 1;
			const epoch = epochRef.current;
			patch({ busy: "save", problem: null, saveOutcome: null });
			try {
				const outcome = await desktopApi.bios.saveDraft({ ...claim, projectId: input.projectId, taskId: input.taskId, ...(expectedTaskRevision === null ? {} : { expectedTaskRevision }), experience });
				if (epoch !== epochRef.current || !aliveRef.current) return null;
				patch({ saveOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (epoch !== epochRef.current || !aliveRef.current) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[claim, input.projectId, input.taskId, patch, t],
	);

	const clearNotices = useCallback(() => patch({ problem: null, saveOutcome: null }), [patch]);

	return useMemo(() => ({ ...state, claim, loadPrefill, saveDraft, clearNotices }), [state, claim, loadPrefill, saveDraft, clearNotices]);
}

export type BiosSediment = ReturnType<typeof useBiosSediment>;
