import { useCallback, useEffect, useRef, useState } from "react";
import type { BiosHistoryEvidence, BiosHistoryPreview } from "../../../shared/types/biosHistory";
import { desktopApi } from "../desktopApi";
import { useBiosSessionClaim } from "./useBiosSessionClaim";

/** 本地只读历史。项目、会话代次或授权变化后，旧响应与候选立即失效。 */
export function useBiosHistory(input: { desktopProjectId?: string; projectId: string | null }) {
	const { claim } = useBiosSessionClaim();
	const identity = JSON.stringify([input.desktopProjectId, input.projectId, claim]);
	const identityRef = useRef(identity);
	const epoch = useRef(0);
	if (identityRef.current !== identity) {
		identityRef.current = identity;
		epoch.current++;
	}
	const lock = useRef(false);
	const [busy, setBusy] = useState(false);
	const [problem, setProblem] = useState<string | null>(null);
	const [preview, setPreview] = useState<BiosHistoryPreview | null>(null);
	const [evidence, setEvidence] = useState<BiosHistoryEvidence | null>(null);
	const [revision, setRevision] = useState(0);
	const clear = useCallback(() => {
		epoch.current++;
		lock.current = false;
		setBusy(false);
		setProblem(null);
		setPreview(null);
		setEvidence(null);
		setRevision((value) => value + 1);
	}, []);
	useEffect(() => {
		clear();
		return () => {
			epoch.current++;
		};
	}, [identity, clear]);
	useEffect(() => desktopApi.bios.onChanged(clear), [clear]);
	const run = useCallback(async (action: (fresh: () => boolean) => Promise<void>) => {
		if (lock.current) return;
		const started = epoch.current;
		const fresh = () => started === epoch.current;
		lock.current = true;
		setBusy(true);
		setProblem(null);
		try {
			await action(fresh);
		} catch (error) {
			if (fresh()) setProblem(error instanceof Error ? error.message : String(error));
		} finally {
			if (fresh()) {
				lock.current = false;
				setBusy(false);
			}
		}
	}, []);
	const scan = useCallback(
		(ref: string, limit: number, keyword: string) =>
			run(async (fresh) => {
				setPreview(null);
				setEvidence(null);
				setRevision((value) => value + 1);
				if (!input.desktopProjectId || !input.projectId) return;
				const result = await desktopApi.bios.scanHistory({ desktopProjectId: input.desktopProjectId, projectId: input.projectId, ref, limit, keyword });
				if (fresh()) setPreview(result);
			}),
		[input.desktopProjectId, input.projectId, run],
	);
	const select = useCallback(
		(sha: string) =>
			run(async (fresh) => {
				setEvidence(null);
				setRevision((value) => value + 1);
				if (!preview) return;
				const result = await desktopApi.bios.historyEvidence({ token: preview.token, sha });
				if (fresh()) setEvidence(result);
			}),
		[preview, run],
	);
	return { busy, problem, preview, evidence, revision, scan, select, run };
}
