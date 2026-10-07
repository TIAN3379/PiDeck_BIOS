/**
 * BM-07B B-05：**知识区**（搜索与跨项目参考 / 客户需求 / 经验与人工审核）。
 *
 * 约定：
 * - 三个子区共享一个 `useBiosKnowledge`：会话身份、代次与"撤权即清空"只有一套口径；
 * - 未保存的表单在切换子区时**必须**确认，不做静默丢弃；
 * - 用户可见文案全部走 i18n；样式只用语义 token，主题/语言切换自然跟随。
 */
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { t } from "../../i18n";
import type { BiosKnowledge, BiosKnowledgeTab } from "../../hooks/useBiosKnowledge";
import type { BiosHistoryWorkflow } from "../../hooks/useBiosHistoryWorkflow";
import { BiosSearchPane } from "./knowledge/BiosSearchPane";
import { BiosReferenceCard } from "./knowledge/BiosReferenceCard";
import { BiosFeaturePane } from "./knowledge/BiosFeaturePane";
import { BiosExperiencePane } from "./knowledge/BiosExperiencePane";
import { BiosHistoryPane } from "./knowledge/BiosHistoryPane";

const TABS: readonly { id: BiosKnowledgeTab; labelKey: "bios.workbench.knowledge.tab.search" | "bios.workbench.knowledge.tab.features" | "bios.workbench.knowledge.tab.experiences" | "bios.history.tab" }[] = [
	{ id: "search", labelKey: "bios.workbench.knowledge.tab.search" },
	{ id: "features", labelKey: "bios.workbench.knowledge.tab.features" },
	{ id: "experiences", labelKey: "bios.workbench.knowledge.tab.experiences" },
	{ id: "history", labelKey: "bios.history.tab" },
];

export const BiosKnowledgeSection = memo(function BiosKnowledgeSection(props: {
	projectId: string | null;
	knownFeatureIds: readonly string[];
	canAddReference: boolean;
	onAddReference: (experienceId: string) => void;
	desktopProjectId?: string;
	dirty: boolean;
	onDirtyChange: (dirty: boolean) => void;
	knowledge: BiosKnowledge;
	history: BiosHistoryWorkflow;
	tab: BiosKnowledgeTab;
	onTabChange: (tab: BiosKnowledgeTab) => void;
}) {
	const knowledge = props.knowledge;
	const tab = props.tab;
	const setTab = props.onTabChange;
	const dirty = props.dirty;
	const setDirty = props.onDirtyChange;
	const blockedRef = useRef<(() => void) | null>(null);
	const [blocked, setBlocked] = useState(false);
	const busy = knowledge.busy !== null;
	const { onDirtyChange } = props;
	useEffect(() => setDirty(false), [props.history.history.revision]);
	useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

	const guarded = useCallback(
		(action: () => void) => {
			if (!dirty) {
				action();
				return;
			}
			blockedRef.current = action;
			setBlocked(true);
		},
		[dirty],
	);

	// 搜索命中的经验/需求就是"已知 ID"的来源：不另造全库列表。
	const knownExperienceIds = (knowledge.searchResult?.hits ?? []).filter((hit) => hit.family === "experience-card").map((hit) => hit.recordId);

	return (
		<div className="flex flex-col gap-3">
			<div className="flex flex-wrap gap-1">
				{TABS.map((entry) => (
					<Button
						key={entry.id}
						size="sm"
						variant={tab === entry.id ? "secondary" : "ghost"}
						aria-pressed={tab === entry.id}
						onClick={() =>
							guarded(() => {
								setTab(entry.id);
								setDirty(false);
							})
						}
					>
						{t(entry.labelKey)}
					</Button>
				))}
			</div>

			{tab === "search" ? (
				<>
					<BiosSearchPane
						knowledge={knowledge}
						onOpenFeature={(featureId) =>
							guarded(() => {
								setTab("features");
								setDirty(false);
								void knowledge.loadFeature(featureId);
							})
						}
					/>
					{/* B-06：加入任务参考是**人工选择**，且只更新引用 ID（不 copy patch、不改项目身份）。 */}
					{knowledge.reference !== null ? <BiosReferenceCard reference={knowledge.reference} loading={busy} canAddToTaskReference={props.canAddReference} onAddToTaskReference={props.onAddReference} /> : null}
				</>
			) : null}
			{tab === "history" ? <BiosHistoryPane desktopProjectId={props.desktopProjectId} projectId={props.projectId} workflow={props.history} onDirtyChange={setDirty} /> : null}
			{tab === "features" ? <BiosFeaturePane knowledge={knowledge} knownFeatureIds={props.knownFeatureIds} onDirtyChange={setDirty} /> : null}
			{tab === "experiences" ? (
				<BiosExperiencePane
					knowledge={knowledge}
					knownExperienceIds={knownExperienceIds}
					defaultSourceProjectId={props.projectId}
					onDirtyChange={setDirty}
					onOpenReference={(experienceId) =>
						guarded(() => {
							setTab("search");
							setDirty(false);
							void knowledge.openReference(experienceId);
						})
					}
				/>
			) : null}

			{knowledge.problem !== null ? (
				<section role="status" className="rounded-md border border-destructive/60 p-3">
					<div className="break-all text-destructive">{knowledge.problem}</div>
					<Button size="sm" variant="ghost" className="mt-2" onClick={knowledge.clearNotices}>
						{t("bios.workbench.dismiss")}
					</Button>
				</section>
			) : null}

			{blocked ? (
				<ConfirmDialog
					title={t("bios.workbench.task.unsavedTitle")}
					message={t("bios.workbench.knowledge.unsavedMessage")}
					confirmLabel={t("bios.workbench.task.unsavedConfirm")}
					danger
					onCancel={() => {
						blockedRef.current = null;
						setBlocked(false);
					}}
					onConfirm={() => {
						const action = blockedRef.current;
						blockedRef.current = null;
						setBlocked(false);
						setDirty(false);
						action?.();
					}}
				/>
			) : null}
		</div>
	);
});
