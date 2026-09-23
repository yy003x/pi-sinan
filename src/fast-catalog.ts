import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fingerprintUsageAuth } from "./usage.ts";

const CATALOG_URL = "https://chatgpt.com/backend-api/codex/models";
// Keep the catalog bounded while allowing the current official Codex response (~522 KB).
const MAX_BYTES = 1024 * 1024;
// This is the Codex catalog client version, not the Pi package version.
const CLIENT_VERSION = "0.156.0";
const CATALOG_CACHE_TTL_MS = 60_000;
const catalogCache = new Map<string, { until: number; result: FastAvailability }>();
export type FastAvailability = { status: "supported" | "unsupported" | "unavailable"; reason: string; fingerprint?: string };

export function catalogSupportsFast(payload: unknown, slug: string): boolean | undefined {
	if (!payload || typeof payload !== "object" || !Array.isArray((payload as { models?: unknown }).models)) return undefined;
	const matches = (payload as { models: unknown[] }).models.filter((entry) => entry && typeof entry === "object" && (entry as { slug?: unknown }).slug === slug);
	if (matches.length !== 1) return undefined;
	const tiers = (matches[0] as { service_tiers?: unknown }).service_tiers;
	if (!Array.isArray(tiers) || !tiers.every((tier) => tier && typeof tier === "object" && typeof tier.id === "string")) return undefined;
	return tiers.some((tier) => tier.id === "priority");
}

export async function checkFastAvailability(ctx: ExtensionContext, fetchImpl: typeof fetch = fetch): Promise<FastAvailability> {
	const model = ctx.model;
	if (!model || model.provider !== "openai-codex" || model.api !== "openai-codex-responses") return { status: "unavailable", reason: "Select an OpenAI Codex Responses model." };
	try {
		const url = new URL(model.baseUrl);
		if (url.protocol !== "https:" || url.host !== "chatgpt.com" || url.username || url.password || !["/backend-api", "/backend-api/codex"].includes(url.pathname.replace(/\/+$/, "")) || !ctx.modelRegistry.isUsingOAuth(model)) {
			return { status: "unavailable", reason: "Official Codex OAuth model required." };
		}
		const result = await ctx.modelRegistry.getProviderAuth("openai-codex");
		if (!result?.auth.apiKey || (result.auth.baseUrl && !["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex"].includes(result.auth.baseUrl.replace(/\/+$/, "")))) return { status: "unavailable", reason: "Official Codex OAuth credential unavailable." };
		const auth = result.auth;
		const headers = new Headers();
		for (const [name, value] of Object.entries(auth.headers ?? {})) {
			if (name.toLowerCase() !== "authorization" && value !== null) headers.set(name, value);
		}
		headers.set("Authorization", `Bearer ${auth.apiKey}`);
		headers.set("Accept", "application/json");
		const fingerprint = fingerprintUsageAuth(Object.fromEntries(headers.entries()));
		const cacheKey = `${model.id}:${fingerprint}`;
		const cached = catalogCache.get(cacheKey);
		if (fetchImpl === fetch && cached && cached.until > Date.now()) return cached.result;
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 12_000);
		try {
			const response = await fetchImpl(`${CATALOG_URL}?client_version=${CLIENT_VERSION}`, { method: "GET", redirect: "error", signal: controller.signal, headers });
			if (!response.ok || !response.body) return { status: "unavailable", reason: `Official catalog HTTP ${response.status}.` };
			const reader = response.body.getReader();
			const chunks: Uint8Array[] = [];
			let size = 0;
			try {
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > MAX_BYTES) { await reader.cancel(); return { status: "unavailable", reason: "Official catalog response too large." }; }
					chunks.push(value);
				}
			} finally { reader.releaseLock(); }
			const bytes = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
			const supported = catalogSupportsFast(JSON.parse(new TextDecoder().decode(bytes)), model.id);
			if (supported === undefined) return { status: "unavailable", reason: "Model or service_tiers metadata missing." };
			const result: FastAvailability = { status: supported ? "supported" : "unsupported", reason: supported ? "Official catalog lists priority for this model." : "Official catalog does not list priority for this model.", fingerprint };
			if (fetchImpl === fetch) {
				if (catalogCache.size >= 16) catalogCache.delete(catalogCache.keys().next().value!);
				catalogCache.set(cacheKey, { until: Date.now() + CATALOG_CACHE_TTL_MS, result });
			}
			return result;
		} finally { clearTimeout(timeout); }
	} catch { return { status: "unavailable", reason: "Official catalog or OAuth validation failed." }; }
}
