export const FAST_STATE_ENTRY = "pi-sinan-fast-state";
export const FAST_STATUS_KEY = "pi-sinan-fast";
export const FAST_SERVICE_TIER = "priority";
export const XAI_FAST_SERVICE_TIER = "fast";

export interface FastStateEntry {
	type: "custom";
	customType: string;
	data?: unknown;
}

export function fastStateFromEntries(entries: readonly unknown[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as FastStateEntry | undefined;
		if (entry?.type !== "custom" || entry.customType !== FAST_STATE_ENTRY) continue;
		if (entry.data && typeof entry.data === "object" && !Array.isArray(entry.data)) {
			const enabled = (entry.data as { enabled?: unknown }).enabled;
			if (typeof enabled === "boolean") return enabled;
		}
	}
	return false;
}

export function addFastServiceTier(payload: unknown, enabled: boolean, providerId: string | undefined): unknown {
	if (!enabled || !payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	const model = (payload as { model?: unknown }).model;
	if (providerId === "xai" && model === "grok-4.7") {
		return { ...(payload as Record<string, unknown>), service_tier: XAI_FAST_SERVICE_TIER };
	}
	if (providerId === "openai-codex") {
		return { ...(payload as Record<string, unknown>), service_tier: FAST_SERVICE_TIER };
	}
	return payload;
}
