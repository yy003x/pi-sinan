export type ProviderId = "xai" | "openai";
export type ProviderSelection = ProviderId | "auto";
export type CredentialProviderId = "xai" | "openai-codex";

export interface ProviderRequestAuth {
	apiKey: string;
	baseUrl?: string;
	headers?: Record<string, string | null>;
}

export interface ResolvedImageProvider {
	provider: ProviderId;
	auth: ProviderRequestAuth;
}

export interface ImageProviderAttempt<T> extends ResolvedImageProvider {
	value: T;
}

export const OPENAI_CODEX_IMAGE_MODEL = "gpt-image-2";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
export const XAI_IMAGE_BASE_URL = "https://api.x.ai/v1";

export interface OpenAICodexImageGenerationRequest {
	model: typeof OPENAI_CODEX_IMAGE_MODEL;
	prompt: string;
	background: "auto";
	quality: "auto";
	size: "auto" | "1536x1024" | "1024x1536" | "1024x1024";
}

export function credentialProviderId(provider: ProviderId): CredentialProviderId {
	return provider === "xai" ? "xai" : "openai-codex";
}

export async function resolveImageProvider(
	requested: string | undefined,
	resolveAuth: (provider: CredentialProviderId) => Promise<ProviderRequestAuth | undefined>,
): Promise<ResolvedImageProvider> {
	const selection = requested ?? "auto";
	if (selection !== "auto" && selection !== "xai" && selection !== "openai") {
		throw new Error(`unsupported provider: ${selection}`);
	}

	const candidates: ProviderId[] = selection === "auto" ? ["xai", "openai"] : [selection];
	for (const provider of candidates) {
		const auth = await resolveAuth(credentialProviderId(provider));
		if (auth) return { provider, auth };
	}

	if (selection === "xai") {
		throw new Error("xAI subscription is not configured. Run /login and choose xAI.");
	}
	if (selection === "openai") {
		throw new Error("OpenAI subscription is not configured. Run /login and choose OpenAI Codex.");
	}
	throw new Error("No subscription image provider is configured. Sign in to xAI or OpenAI Codex with /login.");
}

export async function attemptImageProviders<T>(
	requested: string | undefined,
	resolveAuth: (provider: CredentialProviderId) => Promise<ProviderRequestAuth | undefined>,
	attempt: (resolved: ResolvedImageProvider) => Promise<T>,
	shouldStop: (error: unknown) => boolean = () => false,
): Promise<ImageProviderAttempt<T>> {
	const selection = requested ?? "auto";
	if (selection !== "auto") {
		const resolved = await resolveImageProvider(selection, resolveAuth);
		return { ...resolved, value: await attempt(resolved) };
	}

	const failures: string[] = [];
	for (const provider of ["xai", "openai"] as const) {
		try {
			const resolved = await resolveImageProvider(provider, resolveAuth);
			return { ...resolved, value: await attempt(resolved) };
		} catch (error) {
			if (shouldStop(error)) throw error;
			const message = error instanceof Error ? error.message : String(error);
			failures.push(`${provider}: ${message}`);
		}
	}

	throw new Error(`auto image generation failed: ${failures.join("; ")}`);
}

export function xaiImageGenerationUrl(baseUrl?: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl ?? XAI_IMAGE_BASE_URL);
	} catch {
		throw new Error("xAI image generation requires the official xAI API URL");
	}
	const path = url.pathname.replace(/\/+$/u, "");
	if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "api.x.ai" || url.port || url.username || url.password || path !== "/v1") {
		throw new Error("xAI image generation refuses non-official xAI endpoints");
	}
	url.pathname = "/v1/images/generations";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function openAICodexImageGenerationUrl(baseUrl?: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl ?? OPENAI_CODEX_BASE_URL);
	} catch {
		throw new Error("OpenAI Codex image generation requires the official ChatGPT backend URL");
	}

	const path = url.pathname.replace(/\/+$/u, "");
	const officialBase = url.protocol === "https:"
		&& url.hostname.toLowerCase() === "chatgpt.com"
		&& url.port === ""
		&& url.username === ""
		&& url.password === ""
		&& (path === "/backend-api" || path === "/backend-api/codex");
	if (!officialBase) {
		throw new Error("OpenAI Codex image generation refuses non-official ChatGPT endpoints");
	}

	url.pathname = "/backend-api/codex/images/generations";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function openAICodexImageGenerationRequest(
	prompt: string,
	aspect?: string,
): OpenAICodexImageGenerationRequest {
	const size = !aspect || aspect === "auto"
		? "auto"
		: aspect === "16:9"
			? "1536x1024"
			: aspect === "9:16"
				? "1024x1536"
				: "1024x1024";
	return {
		model: OPENAI_CODEX_IMAGE_MODEL,
		prompt,
		background: "auto",
		quality: "auto",
		size,
	};
}

export function imageRequestHeaders(
	auth: ProviderRequestAuth,
	extra: Record<string, string> = {},
): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	headers.set("Authorization", `Bearer ${auth.apiKey}`);
	headers.set("Accept", "application/json");
	headers.set("Content-Type", "application/json");
	for (const [name, value] of Object.entries(extra)) headers.set(name, value);
	return headers;
}
