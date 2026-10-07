import { useCallback, useEffect, useRef, useState } from "react";
import type { BiosConnectionList } from "../../../shared/types/biosOnboarding";
import { desktopApi } from "../desktopApi";

/** Local connection metadata, independent of model consent. Never auto-pick a different project. */
export function useBiosConnectionStatus(input: { desktopProjectId?: string; ready: boolean }) {
	const [state, setState] = useState<{ owner?: string; list: BiosConnectionList | null; loading: boolean; problem: string | null }>({ list: null, loading: false, problem: null });
	const epoch = useRef(0);
	const refresh = useCallback(async () => {
		const version = ++epoch.current;
		const owner = input.desktopProjectId;
		if (!input.ready) {
			setState({ owner, list: null, loading: false, problem: null });
			return;
		}
		setState({ owner, list: null, loading: true, problem: null });
		try {
			const list = await desktopApi.bios.connections();
			if (version === epoch.current) setState({ owner, list, loading: false, problem: null });
		} catch (error) {
			if (version === epoch.current) setState({ owner, list: null, loading: false, problem: error instanceof Error ? error.message : String(error) });
		}
	}, [input.desktopProjectId, input.ready]);
	useEffect(() => {
		void refresh();
		const off = desktopApi.bios.onChanged((event) => {
			if (event?.kind !== "selection") void refresh();
		});
		return () => {
			epoch.current += 1;
			off();
		};
	}, [refresh]);
	// Do not expose the old project's snapshot for even one render during a project switch.
	const current = state.owner === input.desktopProjectId;
	const matches = current && input.desktopProjectId !== undefined ? (state.list?.projects.filter((project) => project.desktopProjectId === input.desktopProjectId && project.authorized) ?? []) : [];
	return { connection: matches.length === 1 ? matches[0] : null, conflict: matches.length > 1, loading: current ? state.loading : input.ready, problem: current ? state.problem : null, refresh };
}
