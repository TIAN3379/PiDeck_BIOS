/**
 * BM-07B B-05：**知识区**状态（搜索 / 跨项目参考 / 客户需求 / 经验与审核）。
 *
 * 约定：
 * - 搜索结果的 `status=incomplete`、`matchedButDropped`、`unreadable` **必须原样保留**：
 *   预算耗尽/读取失败绝不能被读成"没有匹配经验"；
 * - 跨项目参考只作参考（`porting.referenceOnly`）：源板验证**永不**显示成目标板已验证；
 * - 审核只走 `reviewExperience` 支持的五个动作，带真实 `expectedRevision`；
 *   本 hook **没有**任何"直接写 status/verified"的入口；
 * - 配置/授权变化（`bios:changed`）立即清空搜索结果、参考与详情：撤回授权后不得再看到正文；
 * - 每次请求带代次：过期响应直接丢弃（切项目/换 ID/撤权之后不得贴回旧内容）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BiosSessionClaim } from "../../../shared/types/bios";
import type { AuditAction, BiosExperienceCreateRequest, ExperienceDetailResult, ExperienceReviewResult, ExperienceStatus, ExperienceWriteResult, FeatureDetailResult, FeatureWriteResult, ReferenceView, SearchResult, TaskWriteResult } from "../../../shared/types/biosBusiness";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

export type BiosKnowledgeFamilyFilter = "all" | "experience-card" | "feature-record";
export type BiosKnowledgeStatusFilter = "all" | ExperienceStatus;
export type BiosKnowledgeTab = "search" | "features" | "experiences" | "history";

export type BiosKnowledgeState = {
	busy: string | null;
	problem: string | null;
	/** 搜索：结果与请求参数一起保留，便于"结果过期"时对比。 */
	query: string;
	familyFilter: BiosKnowledgeFamilyFilter;
	statusFilter: BiosKnowledgeStatusFilter;
	intent: "current" | "history";
	searchResult: SearchResult | null;
	/** 跨项目参考详情（只对 `referenceId` 有效）。 */
	reference: ReferenceView | null;
	referenceId: string | null;
	featureId: string;
	featureDetail: FeatureDetailResult | null;
	featureOutcome: FeatureWriteResult | null;
	experienceId: string;
	experienceDetail: ExperienceDetailResult | null;
	experienceOutcome: ExperienceWriteResult | null;
	reviewOutcome: ExperienceReviewResult | null;
};

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const INITIAL: BiosKnowledgeState = {
	busy: null,
	problem: null,
	query: "",
	familyFilter: "all",
	statusFilter: "all",
	intent: "current",
	searchResult: null,
	reference: null,
	referenceId: null,
	featureId: "",
	featureDetail: null,
	featureOutcome: null,
	experienceId: "",
	experienceDetail: null,
	experienceOutcome: null,
	reviewOutcome: null,
};

/** 只依赖当前项目（搜索目标 + 跨项目参考的目标项目）；来源项目由表单自己预填。 */
export function useBiosKnowledge(input: { projectId: string | null }) {
	const { claim } = useBiosSessionClaim();
	const [state, setState] = useState<BiosKnowledgeState>(INITIAL);
	const epochRef = useRef(0);
	const aliveRef = useRef(true);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);
	const patch = useCallback((next: Partial<BiosKnowledgeState>) => {
		if (!aliveRef.current) return;
		setState((previous) => ({ ...previous, ...next }));
	}, []);

	/** 一次请求的代次令牌：拿到结果后先比对，过期就整份丢弃。 */
	const begin = useCallback(() => {
		epochRef.current += 1;
		return epochRef.current;
	}, []);
	const fresh = useCallback((epoch: number) => epoch === epochRef.current && aliveRef.current, []);

	const requireContext = useCallback((): { claim: BiosSessionClaim } | null => {
		if (claim === null) {
			patch({ problem: t("bios.workbench.noSession") });
			return null;
		}
		return { claim };
	}, [claim, patch, t]);

	// 会话身份变化：清空全部可见正文（旧内容的授权前提已经变了）。
	const claimKey = claim === null ? "none" : `${claim.sessionRef.agentId}|${claim.sessionRef.sessionId ?? "-"}|${claim.runtimeGeneration}`;
	useEffect(() => {
		epochRef.current += 1;
		setState((previous) => ({ ...INITIAL, query: previous.query, familyFilter: previous.familyFilter, statusFilter: previous.statusFilter, intent: previous.intent }));
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [claimKey, input.projectId]);

	// 配置/授权变化：立即清空（撤回授权后连缓存都不能留）。
	useEffect(() => {
		const off = desktopApi.bios.onChanged((event) => {
			if (event?.kind === "selection") return;
			epochRef.current += 1;
			setState((previous) => ({ ...INITIAL, query: previous.query, familyFilter: previous.familyFilter, statusFilter: previous.statusFilter, intent: previous.intent }));
		});
		return off;
	}, []);

	// 搜索参数只是"下次请求的输入"：改参数**不**自动重发请求（避免每敲一个字就打一次库）。
	const setQuery = useCallback((query: string) => patch({ query }), [patch]);
	const setFamilyFilter = useCallback((familyFilter: BiosKnowledgeFamilyFilter) => patch({ familyFilter }), [patch]);
	const setStatusFilter = useCallback((statusFilter: BiosKnowledgeStatusFilter) => patch({ statusFilter }), [patch]);
	const setIntent = useCallback((intent: "current" | "history") => patch({ intent }), [patch]);

	const search = useCallback(async () => {
		const context = requireContext();
		if (context === null) return null;
		const query = state.query.trim();
		if (query === "") {
			patch({ problem: t("bios.workbench.knowledge.needQuery") });
			return null;
		}
		const epoch = begin();
		patch({ busy: "search", problem: null, searchResult: null, reference: null, referenceId: null });
		try {
			const outcome = await desktopApi.bios.searchKnowledge({
				...context.claim,
				query,
				...(input.projectId === null ? {} : { projectId: input.projectId }),
				intent: state.intent,
				...(state.familyFilter === "all" ? {} : { recordFamilies: [state.familyFilter] }),
				...(state.statusFilter === "all" ? {} : { statuses: [state.statusFilter] }),
			});
			if (!fresh(epoch)) return null;
			patch({ searchResult: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
			return outcome;
		} catch (error) {
			if (!fresh(epoch)) return null;
			patch({ busy: null, problem: messageOf(error) });
			return null;
		}
	}, [begin, fresh, input.projectId, patch, requireContext, state.familyFilter, state.intent, state.query, state.statusFilter, t]);

	/** 跨项目参考：源板验证**不会**被当成目标板已验证（界面按 `porting` 如实说明）。 */
	const openReference = useCallback(
		async (experienceId: string) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "reference", problem: null, reference: null, referenceId: experienceId });
			try {
				const outcome = await desktopApi.bios.readExperienceReference({ ...context.claim, experienceId, ...(input.projectId === null ? {} : { targetProjectId: input.projectId }) });
				if (!fresh(epoch)) return null;
				patch({ reference: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, input.projectId, patch, requireContext],
	);

	const loadFeature = useCallback(
		async (featureId: string, ownerEpoch?: number) => {
			const context = requireContext();
			if (context === null) return null;
			const id = featureId.trim();
			if (id === "") {
				patch({ problem: t("bios.workbench.knowledge.needFeatureId") });
				return null;
			}
			// A post-write refresh belongs to its parent's request; it must not invalidate the receipt.
			const epoch = ownerEpoch ?? begin();
			if (!fresh(epoch)) return null;
			patch({ busy: "feature", problem: null, featureId: id, featureDetail: null });
			try {
				const outcome = await desktopApi.bios.readFeatureDetail({ ...context.claim, featureId: id });
				if (!fresh(epoch)) return null;
				patch({ featureDetail: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, patch, requireContext, t],
	);

	const createFeature = useCallback(
		async (feature: import("../../../shared/types/biosBusiness").FeatureDraft) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "feature-write", problem: null, featureOutcome: null });
			try {
				const outcome = await desktopApi.bios.createFeature({ ...context.claim, feature });
				if (!fresh(epoch)) return null;
				patch({ featureOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				if (outcome.guard.stable && outcome.result.status === "created") await loadFeature(feature.featureId, epoch);
				if (!fresh(epoch)) return null;
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, loadFeature, patch, requireContext],
	);

	const updateFeature = useCallback(
		async (featureId: string, expectedRevision: number, changes: Partial<Omit<import("../../../shared/types/biosBusiness").FeatureDraft, "featureId">>) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "feature-write", problem: null, featureOutcome: null });
			try {
				const outcome = await desktopApi.bios.updateFeature({ ...context.claim, featureId, expectedRevision, changes });
				if (!fresh(epoch)) return null;
				// Revalidate before starting child IO; an old save cannot reopen an old record.
				if (outcome.guard.stable && (outcome.result.status === "updated" || outcome.result.status === "unchanged")) await loadFeature(featureId, epoch);
				if (!fresh(epoch)) return null;
				patch({ featureOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, loadFeature, patch, requireContext],
	);

	const loadExperience = useCallback(
		async (experienceId: string, ownerEpoch?: number) => {
			const context = requireContext();
			if (context === null) return null;
			const id = experienceId.trim();
			if (id === "") {
				patch({ problem: t("bios.workbench.knowledge.needExperienceId") });
				return null;
			}
			const epoch = ownerEpoch ?? begin();
			if (!fresh(epoch)) return null;
			patch({ busy: "experience", problem: null, experienceId: id, experienceDetail: null, reviewOutcome: null });
			try {
				const outcome = await desktopApi.bios.readExperienceDetail({ ...context.claim, experienceId: id });
				if (!fresh(epoch)) return null;
				patch({ experienceDetail: outcome.guard.stable ? outcome.result : null, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, patch, requireContext, t],
	);

	const createExperience = useCallback(
		async (experience: import("../../../shared/types/biosBusiness").ExperienceDraft) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "experience-write", problem: null, experienceOutcome: null });
			try {
				const outcome = await desktopApi.bios.createExperience({ ...context.claim, experience } as BiosExperienceCreateRequest);
				if (!fresh(epoch)) return null;
				patch({ experienceOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				if (outcome.guard.stable && outcome.result.status === "created") await loadExperience(experience.experienceId, epoch);
				if (!fresh(epoch)) return null;
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, loadExperience, patch, requireContext],
	);

	const updateExperience = useCallback(
		async (experienceId: string, expectedRevision: number, changes: Partial<Omit<import("../../../shared/types/biosBusiness").ExperienceDraft, "experienceId" | "sourceProjectId">>) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "experience-write", problem: null, experienceOutcome: null });
			try {
				const outcome = await desktopApi.bios.updateExperience({ ...context.claim, experienceId, expectedRevision, changes });
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable && (outcome.result.status === "updated" || outcome.result.status === "unchanged")) await loadExperience(experienceId, epoch);
				if (!fresh(epoch)) return null;
				patch({ experienceOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, loadExperience, patch, requireContext],
	);

	/** 审核：只转发既有五个动作；危险动作的二次确认在组件里做。 */
	const reviewExperience = useCallback(
		async (experienceId: string, expectedRevision: number, action: AuditAction, reason: string, operatorLabel?: string) => {
			const context = requireContext();
			if (context === null) return null;
			const epoch = begin();
			patch({ busy: "review", problem: null, reviewOutcome: null });
			try {
				const outcome = await desktopApi.bios.reviewExperience({ ...context.claim, experienceId, expectedRevision, action, reason, ...(operatorLabel === undefined || operatorLabel.trim() === "" ? {} : { operatorLabel: operatorLabel.trim() }) });
				if (!fresh(epoch)) return null;
				if (outcome.guard.stable) await loadExperience(experienceId, epoch);
				if (!fresh(epoch)) return null;
				patch({ reviewOutcome: outcome.result, busy: null, ...(outcome.guard.stable ? {} : { problem: outcome.guard.staleReason }) });
				return outcome;
			} catch (error) {
				if (!fresh(epoch)) return null;
				patch({ busy: null, problem: messageOf(error) });
				return null;
			}
		},
		[begin, fresh, loadExperience, patch, requireContext],
	);

	/** 结果预算耗尽/读取失败必须显式呈现，不能被读成"没有匹配"。 */
	const searchIncomplete = state.searchResult !== null && (state.searchResult.status === "incomplete" || state.searchResult.matchedButDropped > 0 || state.searchResult.unreadable > 0);

	const clearNotices = useCallback(() => patch({ problem: null, featureOutcome: null, experienceOutcome: null, reviewOutcome: null }), [patch]);

	return useMemo(
		() => ({
			...state,
			claim,
			searchIncomplete,
			setQuery,
			setFamilyFilter,
			setStatusFilter,
			setIntent,
			search,
			openReference,
			loadFeature,
			createFeature,
			updateFeature,
			loadExperience,
			createExperience,
			updateExperience,
			reviewExperience,
			clearNotices,
		}),
		[state, claim, searchIncomplete, setQuery, setFamilyFilter, setStatusFilter, setIntent, search, openReference, loadFeature, createFeature, updateFeature, loadExperience, createExperience, updateExperience, reviewExperience, clearNotices],
	);
}

export type BiosKnowledge = ReturnType<typeof useBiosKnowledge>;
/** 供组件引用任务写入结果的类型（与需求/经验写入结果同形，便于统一展示）。 */
export type BiosKnowledgeWriteOutcome = TaskWriteResult | ExperienceWriteResult | FeatureWriteResult;
