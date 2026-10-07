import type { BiosHistoryWorkflow } from "../../../hooks/useBiosHistoryWorkflow";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Input } from "../../ui-shadcn/input";
import { BiosExperienceForm } from "./BiosExperienceForm";

/** Rendering only; temporary analysis belongs to the persistent workbench. */
export function BiosHistoryPane(props: { desktopProjectId?: string; projectId: string | null; workflow: BiosHistoryWorkflow; onDirtyChange: (dirty: boolean) => void }) {
	const { history, ref, setRef, limit, setLimit, keyword, setKeyword, analysis, initial, hint, busy, prepare, importCandidate, createDraft, cancelDraft } = props.workflow;
	const evidence = history.evidence;
	return (
		<section data-testid="bios-history" className="flex flex-col gap-3 rounded-md border border-border p-3">
			<div className="font-medium">{t("bios.history.title")}</div>
			<p className="text-text-muted">{t("bios.history.hint")}</p>
			{!props.projectId || !props.desktopProjectId ? <p role="status">{t("bios.history.needProject")}</p> : null}
			<label className="flex flex-col gap-1">
				{t("bios.history.ref")}
				<Input aria-label={t("bios.history.ref")} value={ref} maxLength={128} onChange={(event) => setRef(event.target.value)} />
			</label>
			<label className="flex flex-col gap-1">
				{t("bios.history.limit")}
				<Input aria-label={t("bios.history.limit")} type="number" min={1} max={100} value={limit} onChange={(event) => setLimit(event.target.value)} />
			</label>
			<label className="flex flex-col gap-1">
				{t("bios.history.keyword")}
				<Input aria-label={t("bios.history.keyword")} value={keyword} maxLength={128} onChange={(event) => setKeyword(event.target.value)} />
			</label>
			<Button size="sm" disabled={busy || initial !== null || !props.projectId || !props.desktopProjectId} onClick={() => void history.scan(ref, Number(limit), keyword)}>
				{t("bios.history.scan")}
			</Button>
			{history.preview ? (
				<>
					<p>
						{t("bios.history.count", { scanned: history.preview.scanned, matched: history.preview.commits.length })}
						{history.preview.hasMore ? ` ${t("bios.history.more")}` : ""}
					</p>
					{history.preview.commits.map((commit) => (
						<Button
							key={commit.sha}
							size="sm"
							variant={evidence?.commit.sha === commit.sha ? "secondary" : "outline"}
							disabled={busy || initial !== null}
							className="h-auto justify-start whitespace-normal break-all text-left"
							onClick={() => void history.select(commit.sha)}
						>{`${commit.sha.slice(0, 10)} · ${commit.subject} · ${commit.date.slice(0, 10)}`}</Button>
					))}
				</>
			) : null}
			{evidence ? (
				<>
					<details>
						<summary>{t("bios.history.evidence")}</summary>
						<pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all bg-surface-muted p-2 text-[11px]">{`${evidence.commit.sha}\n${evidence.commit.message}\n${evidence.diff}`}</pre>
					</details>
					<p className="text-text-muted">{t("bios.history.evidenceHint")}</p>
					<Button size="sm" variant="outline" disabled={busy || initial !== null} onClick={prepare}>
						{t("bios.history.prepare")}
					</Button>
					<Button size="sm" variant="outline" disabled={busy || !analysis || initial !== null} onClick={importCandidate}>
						{t("bios.history.import")}
					</Button>
				</>
			) : null}
			{hint ? (
				<p role="status" className="text-text-muted">
					{hint}
				</p>
			) : null}
			{history.problem ? (
				<p role="alert" className="break-all text-destructive">
					{history.problem}
				</p>
			) : null}
			{initial && evidence ? <BiosExperienceForm mode="create" baseline={null} defaultSourceProjectId={props.projectId} initial={initial} busy={busy} onDirtyChange={props.onDirtyChange} onCancel={cancelDraft} onCreate={createDraft} /> : null}
		</section>
	);
}
