/** Minimal opt-in knowledge browser. No AI conversation is needed to inspect or edit. */
import { useEffect, useRef, useState } from "react";
import type { BiosLibraryKind, BiosLibraryReview } from "../../../../../shared/types/biosLibrary";
import { useBiosLibrary } from "../../../hooks/useBiosLibrary";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { Dialog, DialogContent, DialogTitle } from "../../ui-shadcn/dialog";
import { Input } from "../../ui-shadcn/input";
import { ConfirmDialog } from "../../ui-shadcn/ConfirmDialog";
import { BiosExperienceForm } from "./BiosExperienceForm";
import { BiosFeatureForm } from "./BiosFeatureForm";
import { BiosLibraryDetail } from "./BiosLibraryDetail";

export function BiosLibraryDialog(props: { onClose: () => void }) {
	const library = useBiosLibrary();
	const [kind, setKind] = useState<BiosLibraryKind>("experience-card");
	const [query, setQuery] = useState("");
	const [appliedQuery, setAppliedQuery] = useState("");
	const [editing, setEditing] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [pending, setPending] = useState<(() => void) | null>(null);
	const [reviewAction, setReviewAction] = useState<BiosLibraryReview["action"] | null>(null);
	const [reason, setReason] = useState("");
	const started = useRef(false);
	useEffect(() => {
		if (!started.current) {
			started.current = true;
			void library.list("experience-card");
		}
	}, [library.list]);
	const guarded = (action: () => void) => {
		if (library.busy) return;
		if (dirty) setPending(() => action);
		else {
			setEditing(false);
			setDirty(false);
			action();
		}
	};
	const detail = library.detail;
	const page = library.page;
	const afterSave = (receipt: Awaited<ReturnType<typeof library.write>>) => {
		if (receipt?.stable && ["updated", "unchanged", "applied", "audit-pending", "journal-pending"].includes(receipt.result.status)) {
			setEditing(false);
			setDirty(false);
		}
	};
	const review = async () => {
		if (detail?.kind !== "experience-card" || page === null || reviewAction === null) return;
		const action = reviewAction;
		setReviewAction(null);
		afterSave(await library.write({ kind: "experience-card", id: detail.record.id, expectedRevision: detail.record.revision, libraryKey: page.libraryKey, action, reason, confirmed: true }));
	};
	const changeKind = (next: BiosLibraryKind) =>
		guarded(() => {
			setKind(next);
			setAppliedQuery(query);
			void library.list(next, query);
		});
	return (
		<>
			<Dialog
				open
				onOpenChange={(open) => {
					if (!open) guarded(props.onClose);
				}}
			>
				<DialogContent data-testid="bios-library-dialog" aria-describedby={undefined} className="flex max-h-[calc(100vh-3rem)] flex-col overflow-hidden sm:max-w-5xl">
					<DialogTitle>{t("bios.library.title")}</DialogTitle>
					<p className="text-[12px] text-text-muted">{t("bios.library.localHint")}</p>
					{page !== null ? <p className="break-all text-[11px] text-text-muted">{page.root}</p> : null}
					<div className="flex shrink-0 flex-wrap gap-2">
						{(["experience-card", "feature-record"] as const).map((value) => (
							<Button key={value} size="sm" variant={kind === value ? "secondary" : "ghost"} aria-pressed={kind === value} disabled={library.busy} onClick={() => changeKind(value)}>
								{t(value === "experience-card" ? "bios.library.experiences" : "bios.library.features")}
							</Button>
						))}
						<Input
							aria-label={t("bios.library.filter")}
							placeholder={t("bios.library.filter")}
							className="h-8 min-w-36 flex-1 text-[12px]"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter")
									guarded(() => {
										setAppliedQuery(query);
										void library.list(kind, query);
									});
							}}
						/>
						<Button
							size="sm"
							variant="outline"
							disabled={library.busy}
							onClick={() =>
								guarded(() => {
									setAppliedQuery(query);
									void library.list(kind, query);
								})
							}
						>
							{t("bios.library.refresh")}
						</Button>
					</div>
					{library.problem !== null ? (
						<p role="alert" className="break-all text-[12px] text-destructive">
							{library.problem}
						</p>
					) : null}
					{library.receipt !== null ? (
						<div role="status" className="text-[12px]">
							{t(["updated", "unchanged", "applied"].includes(library.receipt.result.status) && library.receipt.stable ? "bios.library.saved" : "bios.library.writeResult", { status: library.receipt.result.status })}
							{"problems" in library.receipt.result
								? library.receipt.result.problems.map((line) => (
										<p key={line} className="text-destructive">
											{line}
										</p>
									))
								: null}
							{[...library.receipt.result.warnings, ...library.receipt.result.needsReview].map((line) => (
								<p key={line} className="text-destructive">
									{line}
								</p>
							))}
						</div>
					) : null}
					{library.busy ? (
						<p role="status" className="text-[12px] text-text-muted">
							{t("bios.workbench.loading")}
						</p>
					) : null}
					<div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto text-[12px] sm:grid-cols-[minmax(14rem,1fr)_2fr]">
						<div className="flex min-h-0 flex-col gap-2 sm:max-h-[60vh] sm:overflow-y-auto">
							{page?.entries.length === 0 ? <p role="status">{t(page.problems.length > 0 ? "bios.library.unreadable" : appliedQuery === "" ? "bios.library.empty" : "bios.library.noMatch")}</p> : null}
							{page?.entries.map((entry) => (
								<button
									type="button"
									key={entry.id}
									data-testid="bios-library-entry"
									disabled={library.busy}
									className="shrink-0 rounded-md border border-border p-3 text-left hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
									onClick={() =>
										guarded(() => {
											void library.open(kind, entry.id);
										})
									}
								>
									<span className="block break-words font-medium">{entry.title || entry.id}</span>
									<span className="mt-1 block break-words text-text-muted">
										{entry.state}
										{entry.source === "" ? "" : ` · ${entry.source}`}
									</span>
								</button>
							))}
							{page?.next ? (
								<Button
									size="sm"
									variant="outline"
									disabled={library.busy}
									onClick={() =>
										guarded(() => {
											void library.list(kind, appliedQuery, page.next ?? undefined);
										})
									}
								>
									{t("bios.library.next")}
								</Button>
							) : null}
							{page?.scanIncomplete ? (
								<p role="status" className="text-destructive">
									{t("bios.library.incomplete")}
								</p>
							) : null}
							{page?.problems.map((problem) => (
								<p key={problem} role="status" className="break-all text-destructive">
									{problem}
								</p>
							))}
						</div>
						<div className="min-h-0 rounded-md border border-border p-3 sm:max-h-[60vh] sm:overflow-y-auto">
							{detail === null ? (
								<p className="text-text-muted">{t("bios.library.select")}</p>
							) : (
								<>
									<div className="mb-3 flex flex-wrap gap-2">
										{!editing && (detail.kind === "feature-record" || detail.record.status === "draft") ? (
											<Button size="sm" data-testid="bios-library-edit" disabled={library.busy} onClick={() => setEditing(true)}>
												{t("bios.workbench.task.edit")}
											</Button>
										) : null}
										{!editing && detail.kind === "experience-card" && detail.record.status !== "draft" ? (
											<Button
												size="sm"
												variant="outline"
												disabled={library.busy}
												onClick={() => {
													setReason("");
													setReviewAction(detail.record.status === "deprecated" ? "restore" : "request-changes");
												}}
											>
												{t("bios.library.returnDraft")}
											</Button>
										) : null}
										{!editing && detail.kind === "experience-card" && (detail.record.status === "reviewed" || detail.record.status === "verified") ? (
											<Button
												size="sm"
												variant="outline"
												disabled={library.busy}
												onClick={() => {
													setReason("");
													setReviewAction("deprecate");
												}}
											>
												{t("bios.library.deprecate")}
											</Button>
										) : null}
									</div>
									{editing && page !== null && detail.kind === "experience-card" ? (
										<BiosExperienceForm
											key={`${detail.record.id}:${detail.record.revision}`}
											mode="edit"
											baseline={detail.record}
											defaultSourceProjectId={null}
											busy={library.busy}
											onDirtyChange={setDirty}
											onCancel={() => guarded(() => setEditing(false))}
											onSave={(changes) => {
												void library.write({ kind: "experience-card", id: detail.record.id, libraryKey: page.libraryKey, expectedRevision: detail.record.revision, changes }).then(afterSave);
											}}
										/>
									) : editing && page !== null && detail.kind === "feature-record" ? (
										<BiosFeatureForm
											key={`${detail.record.id}:${detail.record.revision}`}
											mode="edit"
											baseline={detail.record}
											busy={library.busy}
											onDirtyChange={setDirty}
											onCancel={() => guarded(() => setEditing(false))}
											onSave={(changes) => {
												void library.write({ kind: "feature-record", id: detail.record.id, libraryKey: page.libraryKey, expectedRevision: detail.record.revision, changes }).then(afterSave);
											}}
										/>
									) : (
										<BiosLibraryDetail detail={detail} />
									)}
								</>
							)}
						</div>
					</div>
				</DialogContent>
			</Dialog>
			{pending !== null ? (
				<ConfirmDialog
					title={t("bios.workbench.task.unsavedTitle")}
					message={t("bios.workbench.knowledge.unsavedMessage")}
					confirmLabel={t("bios.workbench.task.unsavedConfirm")}
					danger
					onCancel={() => setPending(null)}
					onConfirm={() => {
						const action = pending;
						setPending(null);
						setEditing(false);
						setDirty(false);
						action();
					}}
				/>
			) : null}
			{reviewAction !== null ? (
				<Dialog
					open
					onOpenChange={(open) => {
						if (!open) setReviewAction(null);
					}}
				>
					<DialogContent data-testid="bios-library-review-dialog" aria-describedby={undefined} className="sm:max-w-md">
						<DialogTitle>{t("bios.library.reviewTitle")}</DialogTitle>
						<p className="text-[12px]">{t("bios.library.reviewHint", { action: t(reviewAction === "deprecate" ? "bios.library.deprecate" : "bios.library.returnDraft") })}</p>
						<Input aria-label={t("bios.library.reason")} placeholder={t("bios.library.reason")} value={reason} onChange={(event) => setReason(event.target.value)} />
						<Button disabled={reason.trim() === "" || library.busy} onClick={() => void review()}>
							{t("bios.library.confirm")}
						</Button>
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}
