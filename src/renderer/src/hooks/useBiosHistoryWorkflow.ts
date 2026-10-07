import { useStore } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import type { BiosHistoryProposal } from "../../../shared/types/biosHistory";
import { currentSessionIdAtom, sessionMessagesCacheAtom, sessionRecordsAtom, sessionRuntimeByIdAtom } from "../atoms/session-atoms";
import { sessionDraftByIdAtom, setSessionDraftAtom } from "../atoms/composer-atoms";
import { useBiosHistory } from "./useBiosHistory";
import type { BiosKnowledge } from "./useBiosKnowledge";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { encodeBiosHistoryEvidence, parseBiosHistoryProposal } from "../components/bios/knowledge/biosHistoryProposal";
import type { BiosExperienceForm as FormValues } from "../components/bios/knowledge/biosKnowledgeDrafts";
type Analysis = { token: string; commit: string; sessionId: string; before: string[] };

/** Workbench owns temporary analysis across closing the management window to chat.
 * Project/runtime/authorization changes still invalidate evidence and owned drafts. */
export function useBiosHistoryWorkflow(props: { desktopProjectId?: string; projectId: string | null; knowledge: BiosKnowledge; onDirtyChange: (dirty: boolean) => void; onSaved: () => void }) {
	const history = useBiosHistory(props);
	const store = useStore();
	const [ref, setRef] = useState("HEAD");
	const [limit, setLimit] = useState("20");
	const [keyword, setKeyword] = useState("");
	const [analysis, setAnalysis] = useState<Analysis | null>(null);
	const [initial, setInitial] = useState<Partial<FormValues> | null>(null);
	const [hint, setHint] = useState<string | null>(null);
	const ownedDraft = useRef<{ sessionId: string; value: string } | null>(null);
	const retractDraft = useCallback(() => {
		const draft = ownedDraft.current;
		// 只撤回本入口生成且尚未被用户编辑的草稿，绝不清空普通用户输入。
		if (draft && store.get(sessionDraftByIdAtom)[draft.sessionId] === draft.value) store.set(setSessionDraftAtom, { sessionId: draft.sessionId, value: "" });
		ownedDraft.current = null;
	}, [store]);
	useEffect(() => desktopApi.bios.onChanged(retractDraft), [retractDraft]);
	const { onDirtyChange } = props;
	useEffect(() => {
		retractDraft();
		setAnalysis(null);
		setInitial(null);
		setHint(null);
		onDirtyChange(false);
	}, [history.revision, onDirtyChange, retractDraft]);
	useEffect(
		() => () => {
			retractDraft();
			onDirtyChange(false);
		},
		[onDirtyChange, retractDraft],
	);
	const evidence = history.evidence;
	const busy = history.busy || props.knowledge.busy !== null;
	function currentSession(): string {
		const sessionId = store.get(currentSessionIdAtom);
		if (!sessionId || !props.desktopProjectId || store.get(sessionRecordsAtom)[sessionId]?.projectId !== props.desktopProjectId) throw new Error(t("bios.onboarding.analysisNoSession"));
		if (store.get(sessionRuntimeByIdAtom)[sessionId]?.status !== "idle") throw new Error(t("bios.history.idleSession"));
		return sessionId;
	}
	function prepare() {
		void history.run(async (fresh) => {
			if (!evidence) return;
			const sessionId = currentSession();
			if ((store.get(sessionDraftByIdAtom)[sessionId] ?? "").trim()) throw new Error(t("bios.onboarding.analysisDraftBusy"));
			const checked = await desktopApi.bios.historyEvidence({ token: evidence.token, sha: evidence.commit.sha });
			if (!fresh()) return;
			if (!checked.maySendToModel) throw new Error(t("bios.history.endpointBlocked"));
			// Await 之后重新核对会话与输入，不能覆盖期间用户输入或写入另一会话。
			if (currentSession() !== sessionId || (store.get(sessionDraftByIdAtom)[sessionId] ?? "").trim()) throw new Error(t("bios.onboarding.analysisDraftBusy"));
			const token = crypto.randomUUID();
			const before = (store.get(sessionMessagesCacheAtom)[sessionId]?.messages ?? []).map((message) => message.id);
			const value = t("bios.history.prompt", { evidence: encodeBiosHistoryEvidence({ token, commit: checked.commit.sha, metadata: checked.commit, diff: checked.diff }) });
			ownedDraft.current = { sessionId, value };
			store.set(setSessionDraftAtom, { sessionId, value });
			setAnalysis({ token, commit: checked.commit.sha, sessionId, before });
			setHint(t("bios.onboarding.analysisPrepared"));
		});
	}
	function importCandidate() {
		void history.run(async (fresh) => {
			if (!evidence || !analysis) return;
			if (currentSession() !== analysis.sessionId) throw new Error(t("bios.history.responseMissing"));
			const messages = store.get(sessionMessagesCacheAtom)[analysis.sessionId]?.messages ?? [];
			const response = [...messages].reverse().find((message) => message.role === "assistant" && (message.stopReason === "stop" || message.stopReason === undefined) && !analysis.before.includes(message.id));
			if (!response) throw new Error(t("bios.history.responseMissing"));
			let proposal: BiosHistoryProposal;
			try {
				proposal = parseBiosHistoryProposal(response.text, analysis);
			} catch {
				throw new Error(t("bios.history.responseInvalid"));
			}
			await desktopApi.bios.historyEvidence({ token: evidence.token, sha: evidence.commit.sha });
			if (!fresh() || currentSession() !== analysis.sessionId) return;
			setInitial({
				experienceId: `git-${crypto.randomUUID()}`,
				sourceProjectId: evidence.projectId,
				problem: proposal.problem,
				rootCause: proposal.rootCause,
				solution: proposal.solution,
				appliesWhen: proposal.appliesWhen.join("\n"),
				doesNotApplyWhen: proposal.doesNotApplyWhen.join("\n"),
				evidenceType: "commit",
				evidenceCommit: evidence.commit.sha,
				validations: [],
				reuseLevel: "current-project",
			});
			setHint(t("bios.history.reviewHint"));
		});
	}
	function createDraft(draft: Parameters<BiosKnowledge["createExperience"]>[0]) {
		void history.run(async (fresh) => {
			if (!evidence) return;
			if (draft.sourceProjectId !== evidence.projectId || !draft.evidence?.some((item) => item.type === "commit" && item.commit === evidence.commit.sha)) throw new Error(t("bios.history.sourceMismatch"));
			await desktopApi.bios.historyEvidence({ token: evidence.token, sha: evidence.commit.sha });
			if (!fresh()) return;
			const result = await props.knowledge.createExperience(draft);
			if (fresh() && result?.guard.stable && result.result.status === "created") {
				setInitial(null);
				onDirtyChange(false);
				props.onSaved();
			}
		});
	}
	function cancelDraft() {
		setInitial(null);
		onDirtyChange(false);
	}
	function discard() {
		retractDraft();
		setAnalysis(null);
		setInitial(null);
		onDirtyChange(false);
	}
	return { history, ref, setRef, limit, setLimit, keyword, setKeyword, analysis, initial, hint, busy, prepare, importCandidate, createDraft, cancelDraft, discard };
}
export type BiosHistoryWorkflow = ReturnType<typeof useBiosHistoryWorkflow>;
