/**
 * BM-07B B-06：**换对话接续**（交接预览 + 上下文清单保存/重验）。
 *
 * 约定：
 * - 交接预览（`bios:preview`）是**唯一**的运行期证据来源：本地交接包与"是否允许发给模型"
 *   分开呈现，`maySendToModel=false` 的正文绝不会被本模块二次发送；
 * - 保存清单**只允许基于刚刚生成的预览**：`sources`/`budget`/`generatedAt` 都从那次预览的结果派生，
 *   界面不能手输来源（core 还会再按真实磁盘事实复核一遍）；
 * - 清单保存（CAS）与重验是**独立显式动作**；重验按当前事实逐来源给状态，
 *   历史清单**不是**"已注入"的证明；
 * - 预览/清单结果都带请求代次：切任务后的过期响应直接丢弃。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiosPreviewResult } from "../../../shared/types/bios";
import type { SaveManifestResult, VerifyManifestResult } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export type BiosContinuationState = {
	busy: string | null;
	problem: string | null;
	preview: BiosPreviewResult | null;
	/** 生成该预览的时间（清单里的 `generatedAt` 只能来自这里）。 */
	previewGeneratedAt: number | null;
	manifest: SaveManifestResult | null;
	manifestVerify: VerifyManifestResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function useBiosContinuation(input: { projectId: string | null; taskId: string | null; profileRevision: number | null }) {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosContinuationState>({ busy: null, problem: null, preview: null, previewGeneratedAt: null, manifest: null, manifestVerify: null });
	const epochRef = useRef(0);
	const previewScopeRef = useRef<{ taskId: string; workspaceId: string | null } | null>(null);
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const patch = useCallback((next: Partial<BiosContinuationState>) => {
		if (!aliveRef.current) return;
		setState((previous) => ({ ...previous, ...next }));
	}, []);
	const begin = useCallback(() => {
		epochRef.current += 1;
		return epochRef.current;
	}, []);
	const fresh = useCallback((epoch: number) => epoch === epochRef.current && aliveRef.current, []);

	const invalidate = useCallback(() => {
		epochRef.current += 1;
		previewScopeRef.current = null;
		patch({ busy: null, preview: null, previewGeneratedAt: null, manifest: null, manifestVerify: null, problem: null });
	}, [patch]);
	// 同项目切任务、同 runtime 换 session 也必须作废，不能只比较 agentId。
	useEffect(() => {
		invalidate();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [input.projectId, input.taskId, input.profileRevision, claim?.sessionRef.sessionId, claim?.sessionRef.agentId, claim?.runtimeGeneration, invalidate]);
	useEffect(
		() =>
			desktopApi.bios.onChanged((event) => {
				if (event?.kind !== "selection") invalidate();
			}),
		[invalidate],
	);

	const buildPreview = useCallback(
		async (taskId: string, workspaceId: string | null) => {
			if (input.projectId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const epoch = begin();
			previewScopeRef.current = null;
			patch({ busy: "preview", problem: null, preview: null, previewGeneratedAt: null });
			try {
				const generatedAt = Date.now();
				const preview = await desktopApi.bios.preview({ ...claim, projectId: input.projectId, taskId, workspaceId });
				if (!fresh(epoch)) return null;
				if (!preview.stable) {
					patch({ busy: null, preview: null, previewGeneratedAt: null });
					return null;
				}
				previewScopeRef.current = { taskId, workspaceId };
				patch({ preview, previewGeneratedAt: generatedAt, busy: null });
				return preview;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, claim, fresh, input.projectId, patch, t],
	);

	/** 保存清单：来源/预算/时间全部取自**刚刚那次预览**；界面只能给 ID 与期望 revision。 */
	const saveManifest = useCallback(
		async (manifestId: string, expectedRevision: number | null) => {
			const preview = state.preview;
			const generatedAt = state.previewGeneratedAt;
			const scope = previewScopeRef.current;
			if (input.projectId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			if (preview === null || !preview.stable || generatedAt === null || scope === null || scope.taskId !== input.taskId) {
				patch({ problem: t("bios.workbench.continuation.needPreview") });
				return null;
			}
			if (input.profileRevision === null) {
				patch({ problem: t("bios.workbench.continuation.needProfileRevision") });
				return null;
			}
			const epoch = begin();
			patch({ busy: "manifest", problem: null, manifest: null });
			try {
				const outcome = await desktopApi.bios.saveManifest({
					...claim,
					manifestId: manifestId.trim(),
					targetProjectId: input.projectId,
					taskId: scope.taskId,
					...(scope.workspaceId === null ? {} : { workspaceId: scope.workspaceId }),
					profileRevision: input.profileRevision,
					generatedAt,
					sources: preview.retainedSources.map((source) => ({ recordKind: source.recordKind, recordId: source.recordId, revision: source.revision, reason: t("bios.workbench.continuation.sourceReason") })),
					expiredSources: [...preview.expiredSources],
					budget: { maxChars: preview.budget.maxChars, maxBytes: preview.budget.maxBytes, usedChars: preview.budget.usedChars, truncated: preview.budget.truncated },
					expectedRevision,
				});
				if (!fresh(epoch)) return null;
				patch({ manifest: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, claim, fresh, input.profileRevision, input.projectId, input.taskId, patch, state.preview, state.previewGeneratedAt, t],
	);

	/** 重验清单：按当前磁盘事实逐来源判定；历史清单不等于"已注入"。 */
	const verifyManifest = useCallback(
		async (manifestId: string) => {
			if (input.projectId === null || claim === null) {
				patch({ problem: t("bios.workbench.noSession") });
				return null;
			}
			const id = manifestId.trim();
			if (id === "") {
				patch({ problem: t("bios.workbench.continuation.needManifestId") });
				return null;
			}
			const epoch = begin();
			patch({ busy: "verify", problem: null, manifestVerify: null });
			try {
				const outcome = await desktopApi.bios.verifyManifest({ ...claim, manifestId: id, projectId: input.projectId });
				if (!fresh(epoch)) return null;
				patch({ manifestVerify: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, claim, fresh, input.projectId, patch, t],
	);

	const clearNotices = useCallback(() => patch({ problem: null, manifest: null, manifestVerify: null }), [patch]);

	return useMemo(() => ({ ...state, claim, buildPreview, saveManifest, verifyManifest, clearNotices }), [state, claim, buildPreview, saveManifest, verifyManifest, clearNotices]);
}

export type BiosContinuation = ReturnType<typeof useBiosContinuation>;
