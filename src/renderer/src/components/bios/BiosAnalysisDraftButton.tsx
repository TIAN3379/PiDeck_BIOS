/** 准备分析草稿，不自动发送、不覆盖已有输入；仍由用户点击聊天发送。 */
import { useStore } from "jotai";
import { useState } from "react";
import { currentSessionIdAtom, sessionRecordsAtom } from "../../atoms/session-atoms";
import { sessionDraftByIdAtom, setSessionDraftAtom } from "../../atoms/composer-atoms";
import { Button } from "../ui-shadcn/button";
import { t } from "../../i18n";

export function BiosAnalysisDraftButton(props: { desktopProjectId?: string; biosProjectId: string; disabled?: boolean }) {
	const store = useStore();
	const [hint, setHint] = useState<string | null>(null);
	return (
		<div className="flex flex-col gap-1">
			<Button
				size="sm"
				variant="outline"
				disabled={props.disabled}
				onClick={() => {
					const sessionId = store.get(currentSessionIdAtom);
					const record = sessionId === undefined ? undefined : store.get(sessionRecordsAtom)[sessionId];
					if (sessionId === undefined || props.desktopProjectId === undefined || record?.projectId !== props.desktopProjectId) {
						setHint(t("bios.onboarding.analysisNoSession"));
						return;
					}
					if ((store.get(sessionDraftByIdAtom)[sessionId] ?? "").trim()) {
						setHint(t("bios.onboarding.analysisDraftBusy"));
						return;
					}
					store.set(setSessionDraftAtom, { sessionId, value: t("bios.onboarding.analysisPrompt", { projectId: JSON.stringify(props.biosProjectId) }) });
					setHint(t("bios.onboarding.analysisPrepared"));
				}}
			>
				{t("bios.onboarding.analysis")}
			</Button>
			{hint !== null ? (
				<p role="status" className="text-text-muted">
					{hint}
				</p>
			) : null}
		</div>
	);
}
