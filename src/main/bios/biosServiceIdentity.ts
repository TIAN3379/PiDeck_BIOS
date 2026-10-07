/** Resolve a trusted Pi service only while its original session/runtime binding remains live. */
import type { AgentRuntimeState, AgentTab } from "../../shared/types/agent";
import type { BiosServiceRef } from "../../shared/types/biosOnboarding";
import type { BiosResolvedService } from "./BiosOnboardingService";

export async function resolveBiosService(deps: { list: () => readonly AgentTab[]; getRuntimeState: (agentId: string) => Promise<AgentRuntimeState> }, ref: BiosServiceRef): Promise<BiosResolvedService | null> {
	const matches = (tab: AgentTab | undefined): boolean => tab !== undefined && tab.status !== "closed" && tab.status !== "error" && (tab.runtimeGeneration ?? 0) === ref.generation && (ref.sessionId === null || (tab.deckSessionId ?? tab.sessionId ?? null) === ref.sessionId);
	const original = deps.list().find((entry) => entry.id === ref.agentId);
	if (!matches(original)) return null;
	const binding = JSON.stringify([original?.deckSessionId, original?.sessionId, original?.cwd, original?.runtimeGeneration]);
	try {
		const state = await deps.getRuntimeState(ref.agentId);
		const current = deps.list().find((entry) => entry.id === ref.agentId);
		// RPC is async: a replaced/ended process must not grant permission to its successor.
		if (!matches(current) || original !== current || binding !== JSON.stringify([current?.deckSessionId, current?.sessionId, current?.cwd, current?.runtimeGeneration])) return null;
		const provider = state.provider ?? "";
		const modelId = state.modelId ?? "";
		const origin = state.modelEndpointOrigin ?? "";
		if (provider === "" || modelId === "" || origin === "") return null;
		const url = new URL(origin);
		if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username !== "" || url.password !== "") return null;
		return { provider, modelId, origin };
	} catch {
		return null;
	}
}
