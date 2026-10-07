/** BM-07B B-03：当前会话的 BIOS 身份（会话引用 + 代次）与绘制前守卫用的 key。 */
import { useAtomValue } from "jotai";
import { currentSessionIdAtom, sessionRuntimeByIdAtom } from "../atoms";
import { identityKeyOf } from "../components/app/settings/biosPanelState";
import type { BiosSessionClaim } from "../../../shared/types/bios";

export type BiosSessionClaimState = {
	/** 身份键：用于在绘制前判断"这份视图是否属于当前会话"。 */
	key: string;
	/** 运行中才非空；交给主进程解析真实 cwd 与代次。 */
	claim: BiosSessionClaim | null;
};

export function useBiosSessionClaim(): BiosSessionClaimState {
	const sessionId = useAtomValue(currentSessionIdAtom);
	const runtimes = useAtomValue(sessionRuntimeByIdAtom);
	const runtime = sessionId === undefined ? undefined : runtimes[sessionId];
	const key = identityKeyOf({ sessionId: sessionId ?? null, agentId: runtime?.agentId ?? null, generation: runtime?.runtimeGeneration ?? null });
	const claim: BiosSessionClaim | null = runtime?.agentId === undefined ? null : { sessionRef: { agentId: runtime.agentId, sessionId: runtime.piSessionId ?? sessionId ?? null }, runtimeGeneration: runtime.runtimeGeneration };
	return { key, claim };
}
