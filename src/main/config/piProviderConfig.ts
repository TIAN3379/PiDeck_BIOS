import type { PiAuthItem, PiModelItem, PiProviderConfig } from "./ConfigManager";

export type ProviderCompatFlags = {
	supportsDeveloperRole?: boolean;
	requiresReasoningContentOnAssistantMessages?: boolean;
};

export type PiProviderSnapshot = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	compat?: ProviderCompatFlags;
	models: PiModelItem[];
	catalogOnly?: boolean;
};

export type PiBuiltinCatalogView = {
	byProviderId: Map<string, Map<string, { id: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; input?: string[]; api?: string; baseUrl?: string }>>;
};

export function isSafeProviderName(name: unknown): name is string {
	return typeof name === "string" && name.trim().length > 0 && name.trim().length <= 80 && !/[\\/]/.test(name) && !name.includes("..");
}

export function piBuiltinSnapshotFromCatalog(name: string, apiKey: string | undefined, catalog: PiBuiltinCatalogView): PiProviderSnapshot | undefined {
	const inner = catalog.byProviderId.get(name);
	if (!inner?.size) return undefined;
	const entries = [...inner.values()];
	const first = entries[0];
	if (!first) return undefined;
	const models: PiModelItem[] = entries.map((entry) => ({
		id: entry.id.trim(),
		...(entry.name?.trim() ? { name: entry.name.trim() } : {}),
		...(entry.contextWindow != null ? { contextWindow: entry.contextWindow } : {}),
		...(entry.maxTokens != null ? { maxTokens: entry.maxTokens } : {}),
		...(entry.reasoning === true ? { reasoning: true } : {}),
		...(entry.input?.length ? { input: entry.input } : {}),
	}));
	return {
		name: name.trim(),
		baseUrl: first.baseUrl?.trim() || undefined,
		api: first.api?.trim() || "openai-completions",
		apiKey: apiKey?.trim() || undefined,
		models,
		catalogOnly: true,
	};
}

export function resolvePiApiKey(provider: PiProviderConfig | undefined, auth: PiAuthItem | undefined): string | undefined {
	const inline = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
	if (inline) return inline;
	const fromAuth = typeof auth?.key === "string" ? auth.key.trim() : "";
	if (fromAuth) return fromAuth;
	if (auth && typeof auth === "object" && auth.type === "oauth") {
		const access = typeof auth.access === "string" ? auth.access.trim() : "";
		if (access) return access;
	}
	return undefined;
}

function asCompatRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export function mergePiProvider(models: { providers: Record<string, PiProviderConfig> }, auth: Record<string, PiAuthItem>, snapshot: PiProviderSnapshot): { models: { providers: Record<string, PiProviderConfig> }; auth: Record<string, PiAuthItem> } {
	const existing = models.providers[snapshot.name];
	const mergedCompat = snapshot.compat ? { ...asCompatRecord(existing?.compat), ...snapshot.compat } : undefined;
	const nextModels = {
		providers: {
			...models.providers,
			[snapshot.name]: {
				...(existing ?? { models: [] }),
				baseUrl: snapshot.baseUrl,
				api: snapshot.api,
				models: snapshot.models,
				...(snapshot.headers ? { headers: snapshot.headers } : {}),
				...(mergedCompat ? { compat: mergedCompat } : {}),
				...(snapshot.apiKey ? { apiKey: snapshot.apiKey } : {}),
			},
		},
	};
	return { models: nextModels, auth: { ...auth } };
}
