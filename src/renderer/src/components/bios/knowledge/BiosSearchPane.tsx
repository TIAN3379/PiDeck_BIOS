/**
 * BM-07B B-05：**知识检索**（关键词/别名 + 类型/状态过滤 + M1 分类与原因）。
 *
 * 铁律：`status=incomplete`、`matchedButDropped`、`unreadable` 必须原样显示——
 * 「预算耗尽/有记录读不出来」**绝不能**被读成「没有匹配经验」。命中片段与扫描记账都如实展示。
 */
import { memo } from "react";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui-shadcn/select";
import { t } from "../../../i18n";
import type { BiosKnowledge } from "../../../hooks/useBiosKnowledge";
import { BiosClassBadge } from "./BiosClassBadge";

const INPUT_CLASS = "h-7 w-full text-[12px]";

export const BiosSearchPane = memo(function BiosSearchPane(props: { knowledge: BiosKnowledge; onOpenFeature: (featureId: string) => void }) {
	const { knowledge } = props;
	const busy = knowledge.busy !== null;
	const result = knowledge.searchResult;

	return (
		<div className="flex flex-col gap-3">
			<section className="rounded-md border border-border p-3">
				<div className="font-medium">{t("bios.workbench.knowledge.search.title")}</div>
				<div className="mt-1 text-[11px] text-text-muted">{t("bios.workbench.knowledge.search.hint")}</div>
				<div className="mt-2 flex flex-wrap items-center gap-2">
					{/* 非受控输入 + 回车/失焦提交：避免每敲一个字就更新一次搜索参数（也少一层重渲染）。 */}
					<Input
						key={knowledge.query}
						aria-label={t("bios.workbench.knowledge.search.query")}
						className={`${INPUT_CLASS} min-w-40 flex-1`}
						placeholder={t("bios.workbench.knowledge.search.queryPlaceholder")}
						defaultValue={knowledge.query}
						onKeyDown={(event) => {
							if (event.key !== "Enter") return;
							const value = event.currentTarget.value;
							if (value !== knowledge.query) knowledge.setQuery(value);
							void knowledge.search();
						}}
						onBlur={(event) => {
							const value = event.target.value;
							if (value !== knowledge.query) knowledge.setQuery(value);
						}}
					/>
					<Select value={knowledge.familyFilter} onValueChange={(value) => knowledge.setFamilyFilter(value as BiosKnowledge["familyFilter"])}>
						<SelectTrigger aria-label={t("bios.workbench.knowledge.search.family")} className={`${INPUT_CLASS} w-36`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("bios.workbench.knowledge.search.familyAll")}</SelectItem>
							<SelectItem value="experience-card">experience-card</SelectItem>
							<SelectItem value="feature-record">feature-record</SelectItem>
						</SelectContent>
					</Select>
					<Select value={knowledge.statusFilter} onValueChange={(value) => knowledge.setStatusFilter(value as BiosKnowledge["statusFilter"])}>
						<SelectTrigger aria-label={t("bios.workbench.knowledge.search.status")} className={`${INPUT_CLASS} w-32`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">{t("bios.workbench.task.statusAll")}</SelectItem>
							{(["draft", "reviewed", "verified", "deprecated"] as const).map((status) => (
								<SelectItem key={status} value={status}>
									{status}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Select value={knowledge.intent} onValueChange={(value) => knowledge.setIntent(value as "current" | "history")}>
						<SelectTrigger aria-label={t("bios.workbench.knowledge.search.intent")} className={`${INPUT_CLASS} w-28`}>
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="current">{t("bios.workbench.knowledge.search.intentCurrent")}</SelectItem>
							<SelectItem value="history">{t("bios.workbench.knowledge.search.intentHistory")}</SelectItem>
						</SelectContent>
					</Select>
					<Button size="sm" disabled={busy} onClick={() => void knowledge.search()}>
						{t("bios.workbench.knowledge.search.run")}
					</Button>
				</div>
			</section>

			{result !== null ? (
				<section className="rounded-md border border-border p-3">
					<div className="flex flex-wrap items-center gap-3 text-[11px] text-text-muted">
						<span>{t("bios.workbench.knowledge.search.statusLabel", { status: result.status })}</span>
						<span>{t("bios.workbench.knowledge.search.scanned", { experiences: result.scanned.experiences, features: result.scanned.features, read: result.scanned.recordsRead, skipped: result.scanned.recordsSkipped })}</span>
					</div>
					{/* 不完整必须显著提示：不能把预算耗尽/读取失败读成"没有匹配"。 */}
					{knowledge.searchIncomplete ? <div className="mt-1 text-destructive">{t("bios.workbench.knowledge.search.incomplete", { dropped: result.matchedButDropped, unreadable: result.unreadable })}</div> : null}
					{result.decision !== null && result.decision.status === "incomplete" ? <div className="mt-1 text-destructive">{t("bios.workbench.knowledge.search.decisionIncomplete", { dropped: result.decision.dropped })}</div> : null}
					{result.problems.map((line) => (
						<div key={line} className="mt-1 break-all text-destructive">
							{line}
						</div>
					))}
					{result.hits.length === 0 ? <div className="mt-2 text-text-muted">{t("bios.workbench.knowledge.search.empty")}</div> : null}

					<div className="mt-2 flex flex-col gap-2">
						{result.hits.map((hit) => (
							<button key={`${hit.family}:${hit.recordId}`} type="button" className="rounded border border-border px-2 py-1 text-left hover:border-foreground/40" disabled={busy} onClick={() => (hit.family === "experience-card" ? void knowledge.openReference(hit.recordId) : props.onOpenFeature(hit.recordId))}>
								<div className="flex flex-wrap items-center gap-2">
									<BiosClassBadge value={hit.recommendation} reasons={hit.reasons} />
									<span className="text-text-muted">{hit.family}</span>
									<span className="break-all">{`${hit.recordId} @${hit.revision}`}</span>
									<span className="text-text-muted">{`${hit.recordedStatus}｜score ${hit.score}`}</span>
								</div>
								{hit.title !== null ? <div className="break-all">{hit.title}</div> : null}
								{hit.snippet !== null ? <div className="break-all text-text-muted">{hit.snippet}</div> : null}
								<div className="break-all text-[11px] text-text-muted">{`${t("bios.workbench.knowledge.search.matchedFields")}：${hit.matchedFields.join("、")}｜${t("bios.workbench.knowledge.reference.sourceProject")} ${hit.sourceProjectId ?? "-"}`}</div>
								{hit.declaredValidations.length > 0 ? <div className="break-all text-[11px] text-text-muted">{`${t("bios.workbench.knowledge.search.declared")}：${hit.declaredValidations.map((validation) => `${validation.kind}/${validation.result}`).join("、")}`}</div> : null}
								{hit.reasons.length > 0 ? <div className="break-all text-[11px] text-text-muted">{hit.reasons.join("；")}</div> : null}
							</button>
						))}
					</div>
				</section>
			) : null}
		</div>
	);
});
