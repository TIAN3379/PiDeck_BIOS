/** Local library request owner, independent of runtime identity and model endpoints. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { BiosLibraryDetail, BiosLibraryKind, BiosLibraryPage, BiosLibraryReceipt, BiosLibraryReview, BiosLibraryUpdate } from "../../../shared/types/biosLibrary";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";

export function useBiosLibrary() {
	const [state, setState] = useState<{ page: BiosLibraryPage | null; detail: BiosLibraryDetail | null; busy: boolean; problem: string | null; receipt: BiosLibraryReceipt | null }>({ page: null, detail: null, busy: false, problem: null, receipt: null });
	const epoch = useRef(0);
	const alive = useRef(true);
	useEffect(() => {
		alive.current = true;
		const off = desktopApi.bios.onChanged((event) => {
			if (event?.kind === "selection") return;
			epoch.current += 1;
			setState({ page: null, detail: null, busy: false, receipt: null, problem: t("bios.library.configChanged") });
		});
		return () => {
			alive.current = false;
			epoch.current += 1;
			off();
		};
	}, []);
	const fresh = useCallback((version: number) => alive.current && version === epoch.current, []);
	const fail = useCallback(
		(version: number, error: unknown) => {
			if (fresh(version)) setState((old) => ({ ...old, busy: false, problem: error instanceof Error ? error.message : String(error) }));
		},
		[fresh],
	);
	const list = useCallback(
		async (kind: BiosLibraryKind, query = "", after?: string) => {
			const version = ++epoch.current;
			setState({ page: null, detail: null, busy: true, problem: null, receipt: null });
			try {
				const page = await desktopApi.bios.libraryList({ kind, query, ...(after === undefined ? {} : { after, libraryKey: state.page?.libraryKey }) });
				if (!fresh(version)) return null;
				setState({ page, detail: null, busy: false, problem: null, receipt: null });
				return page;
			} catch (error) {
				fail(version, error);
				return null;
			}
		},
		[fail, fresh, state.page?.libraryKey],
	);
	const open = useCallback(
		async (kind: BiosLibraryKind, id: string) => {
			if (state.page === null) return null;
			const version = ++epoch.current;
			setState((old) => ({ ...old, busy: true, problem: null, detail: null, receipt: null }));
			try {
				const detail = await desktopApi.bios.libraryDetail({ kind, id, libraryKey: state.page.libraryKey });
				if (!fresh(version)) return null;
				setState((old) => ({ ...old, detail, busy: false }));
				return detail;
			} catch (error) {
				fail(version, error);
				return null;
			}
		},
		[fail, fresh, state.page],
	);
	const write = useCallback(
		async (request: BiosLibraryUpdate | BiosLibraryReview) => {
			const version = ++epoch.current;
			setState((old) => ({ ...old, busy: true, problem: null, receipt: null }));
			try {
				const receipt = "action" in request ? await desktopApi.bios.libraryReview(request) : await desktopApi.bios.libraryUpdate(request);
				if (!fresh(version)) return null;
				if (!receipt.stable) {
					setState({ page: null, detail: null, busy: false, receipt, problem: t("bios.library.staleWrite") });
					return receipt;
				}
				// A CAS conflict leaves the old baseline and the user's editor intact.
				if (["updated", "unchanged", "applied", "audit-pending", "journal-pending"].includes(receipt.result.status)) {
					const detail = await desktopApi.bios.libraryDetail({ kind: request.kind, id: request.id, libraryKey: request.libraryKey });
					if (!fresh(version)) return null;
					setState((old) => ({
						...old,
						detail,
						receipt,
						busy: false,
						page:
							old.page === null
								? null
								: {
										...old.page,
										entries: old.page.entries.map((entry) =>
											entry.id !== detail.record.id
												? entry
												: {
														...entry,
														title: (detail.kind === "experience-card" ? detail.record.problem : detail.record.originalRequirement).slice(0, 160),
														revision: detail.record.revision,
														updatedAt: detail.record.updatedAt,
														state: detail.kind === "experience-card" ? detail.record.status : detail.record.customer.status,
													},
										),
									},
					}));
				} else setState((old) => ({ ...old, receipt, busy: false }));
				return receipt;
			} catch (error) {
				fail(version, error);
				return null;
			}
		},
		[fail, fresh],
	);
	return { ...state, list, open, write };
}
export type BiosLibrary = ReturnType<typeof useBiosLibrary>;
