export type SearchProviderId = "xai" | "openai";

export interface SearchModel {
	id: string;
	provider: string;
	baseUrl: string;
}

export interface SearchAuth {
	provider: SearchProviderId;
	apiKey: string;
	model: string;
	baseUrl: string;
	headers?: Record<string, string | null>;
}

export interface SearchSource {
	title: string;
	url: string;
	snippet?: string;
}

export interface SubscriptionSearchResult {
	query: string;
	provider: SearchProviderId;
	model: string;
	answer: string;
	sources: SearchSource[];
}

export interface SearchRequest {
	query: string;
	provider: SearchProviderId;
}

const SEARCH_TIMEOUT_MS = 60_000;
const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const OPENAI_CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const XAI_MODEL_PREFERENCE = ["grok-4.6", "grok-4.5", "grok-4.3", "grok-build-0.1"] as const;
const EXCLUDED_OPENAI_MODEL_SEGMENTS = new Set(["pro", "ultra"]);

export function parseSearchCommand(args: string): SearchRequest {
	if (/(?:^|\s)--provider=?\s*$/u.test(args)) throw new Error("--provider requires xai or openai");
	const matches = [...args.matchAll(/(?:^|\s)--provider(?:=|\s+)(\S+)/gu)];
	if (matches.length > 1) throw new Error("--provider may only be specified once");
	const rawProvider = matches[0]?.[1] ?? "xai";
	if (rawProvider !== "xai" && rawProvider !== "openai") {
		throw new Error(`unsupported search provider: ${rawProvider}`);
	}
	const query = args
		.replace(/(?:^|\s)--provider(?:=|\s+)\S+/gu, " ")
		.trim()
		.replace(/\s+/gu, " ");
	if (!query) throw new Error("search query must not be empty");
	return { query, provider: rawProvider };
}

export function pickSearchModel<T extends SearchModel>(provider: SearchProviderId, models: readonly T[]): T | undefined {
	const candidates = models.filter((model): model is T => model.provider === (provider === "xai" ? "xai" : "openai-codex"));
	if (provider === "xai") {
		for (const id of XAI_MODEL_PREFERENCE) {
			const match = candidates.find((model) => model.id === id);
			if (match) return match;
		}
		return candidates.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
	}

	const sorted = candidates
		.filter((model) => !model.id.split("-").some((segment) => EXCLUDED_OPENAI_MODEL_SEGMENTS.has(segment)))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
	return sorted.find((model) => model.id.includes("terra"))
		?? sorted.find((model) => /^gpt-\d+(?:\.\d+)?$/u.test(model.id))
		?? sorted[0];
}

export function searchEndpoint(provider: SearchProviderId, baseUrl: string): string {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(`${provider} search requires an absolute official provider URL`);
	}
	const path = url.pathname.replace(/\/+$/u, "");
	const official = provider === "xai"
		? url.protocol === "https:" && url.hostname.toLowerCase() === "api.x.ai" && path === "/v1"
		: url.protocol === "https:"
			&& url.hostname.toLowerCase() === "chatgpt.com"
			&& (path === "/backend-api" || path === "/backend-api/codex");
	if (!official || url.port || url.username || url.password) {
		throw new Error(`${provider} search refuses non-official provider endpoints`);
	}
	url.pathname = provider === "xai" ? "/v1/responses" : "/backend-api/codex/responses";
	url.search = "";
	url.hash = "";
	return url.toString();
}

export function buildSearchBody(provider: SearchProviderId, model: string, query: string): Record<string, unknown> {
	if (provider === "xai") {
		return {
			model,
			input: `Search the web and answer using only what the search results say. Cite sources inline.\n\n${query}`,
			tools: [{ type: "web_search" }],
		};
	}
	return {
		model,
		instructions: "Search the web and return a concise answer grounded only in the web results. Include clickable source citations.",
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [{ type: "web_search" }],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required",
		parallel_tool_calls: true,
	};
}

function requestHeaders(auth: SearchAuth): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value !== null) headers.set(name, value);
	}
	headers.set("Authorization", `Bearer ${auth.apiKey}`);
	headers.set("Content-Type", "application/json");
	if (auth.provider === "openai") {
		headers.set("OpenAI-Beta", "responses=experimental");
		headers.set("originator", "pi-sinan");
	}
	return headers;
}

function errorText(text: string, auth: SearchAuth): string {
	let redacted = text;
	const secrets = [auth.apiKey, ...Object.values(auth.headers ?? {})]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
		redacted = redacted.replaceAll(secret, "[redacted]");
	}
	return redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]").slice(0, 300);
}

function thrownErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "unknown network error";
	}
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
	return (signal.aborted && error === signal.reason)
		|| (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function parseJson(text: string, provider: SearchProviderId): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
		throw new Error("top-level response is not an object");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`${provider} search returned invalid JSON: ${message}`);
	}
}

function sseDataPayloads(text: string): string[] {
	const payloads: string[] = [];
	for (const block of text.replace(/\r\n?/gu, "\n").split(/\n\s*\n/gu)) {
		const dataLines = block
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart());
		if (dataLines.length === 0) continue;
		const joined = dataLines.join("\n").trim();
		if (!joined) continue;
		if (joined === "[DONE]") {
			payloads.push(joined);
			continue;
		}
		try {
			JSON.parse(joined);
			payloads.push(joined);
		} catch {
			// Tolerate non-standard streams that omit the blank line between one-line events.
			payloads.push(...dataLines.map((line) => line.trim()).filter(Boolean));
		}
	}
	return payloads;
}

function parseOpenAIResponse(text: string): { payload: Record<string, unknown>; webSearchCallSeen: boolean } {
	const trimmed = text.trim();
	if (trimmed.startsWith("{")) {
		const payload = parseJson(trimmed, "openai");
		const output = Array.isArray(payload.output) ? payload.output : [];
		return { payload, webSearchCallSeen: output.some(isWebSearchCall) };
	}

	const outputItems: unknown[] = [];
	let completed: Record<string, unknown> | undefined;
	let webSearchCallSeen = false;
	for (const data of sseDataPayloads(text)) {
		if (data === "[DONE]") continue;
		try {
			const event = JSON.parse(data) as Record<string, unknown>;
			if (typeof event.type === "string" && event.type.startsWith("response.web_search_call")) {
				webSearchCallSeen = true;
			}
			if (event.type === "response.output_item.done" && event.item) {
				outputItems.push(event.item);
				webSearchCallSeen ||= isWebSearchCall(event.item);
			}
			if ((event.type === "response.completed" || event.type === "response.done") && event.response && typeof event.response === "object") {
				completed = event.response as Record<string, unknown>;
			}
		} catch {
			// Ignore malformed individual SSE events and require usable terminal output below.
		}
	}
	if (completed) {
		const output = Array.isArray(completed.output) && completed.output.length > 0 ? completed.output : outputItems;
		return { payload: { ...completed, output }, webSearchCallSeen: webSearchCallSeen || output.some(isWebSearchCall) };
	}
	if (outputItems.length > 0) return { payload: { output: outputItems }, webSearchCallSeen };
	throw new Error("openai search returned no parseable response output");
}

function isWebSearchCall(item: unknown): boolean {
	return !!item && typeof item === "object" && (item as { type?: unknown }).type === "web_search_call";
}

function extractAnswer(output: unknown[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!item || typeof item !== "object" || (item as { type?: unknown }).type !== "message") continue;
		const content = (item as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string" && text.trim()) parts.push(text.trim());
		}
	}
	return parts.join("\n").trim();
}

function sourceSnippet(text: string, start: unknown, end: unknown): string | undefined {
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	const snippet = text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).trim();
	return snippet ? snippet.slice(0, 300) : undefined;
}

function extractSources(output: unknown[], citations?: unknown): SearchSource[] {
	const sources: SearchSource[] = [];
	const seen = new Set<string>();
	const add = (rawUrl: unknown, title: unknown, snippet?: string) => {
		if (typeof rawUrl !== "string" || !rawUrl.trim()) return;
		let url: string;
		try {
			const parsed = new URL(rawUrl);
			if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return;
			url = parsed.toString();
		} catch {
			return;
		}
		if (seen.has(url)) return;
		seen.add(url);
		sources.push({
			title: typeof title === "string" && title.trim() ? title.trim() : url,
			url,
			...(snippet ? { snippet } : {}),
		});
	};
	const addGroup = (group: unknown) => {
		if (!Array.isArray(group)) return;
		for (const source of group) {
			if (typeof source === "string") {
				add(source, source);
			} else if (source && typeof source === "object") {
				const record = source as Record<string, unknown>;
				add(record.url ?? record.source_website_url, record.title ?? record.caption);
			}
		}
	};

	for (const item of output) {
		if (!item || typeof item !== "object") continue;
		if ((item as { type?: unknown }).type === "message") {
			const content = (item as { content?: unknown }).content;
			if (!Array.isArray(content)) continue;
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const text = typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "";
				const annotations = (part as { annotations?: unknown }).annotations;
				if (!Array.isArray(annotations)) continue;
				for (const annotation of annotations) {
					if (!annotation || typeof annotation !== "object" || (annotation as { type?: unknown }).type !== "url_citation") continue;
					const citation = annotation as Record<string, unknown>;
					add(citation.url, citation.title, sourceSnippet(text, citation.start_index, citation.end_index));
				}
			}
		}
		if (isWebSearchCall(item) || (item as { type?: unknown }).type === "x_search_call") {
			const call = item as Record<string, unknown>;
			const actionSources = call.action && typeof call.action === "object"
				? (call.action as Record<string, unknown>).sources
				: undefined;
			addGroup(actionSources);
			addGroup(call.sources);
			addGroup(call.results);
		}
	}
	addGroup(citations);
	return sources.slice(0, 20);
}

export async function runSubscriptionSearch(
	query: string,
	auth: SearchAuth,
	options: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<SubscriptionSearchResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const signal = options.signal
		? AbortSignal.any([AbortSignal.timeout(SEARCH_TIMEOUT_MS), options.signal])
		: AbortSignal.timeout(SEARCH_TIMEOUT_MS);
	let response: Response;
	try {
		response = await fetchImpl(searchEndpoint(auth.provider, auth.baseUrl), {
			method: "POST",
			headers: requestHeaders(auth),
			body: JSON.stringify(buildSearchBody(auth.provider, auth.model, query)),
			signal,
			redirect: "error",
		});
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		throw new Error(`${auth.provider} search request failed: ${errorText(thrownErrorMessage(error), auth)}`);
	}
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		throw new Error(`${auth.provider} search response read failed: ${errorText(thrownErrorMessage(error), auth)}`);
	}
	if (!response.ok) {
		throw new Error(`${auth.provider} search failed (HTTP ${response.status}): ${errorText(text, auth)}`);
	}

	let payload: Record<string, unknown>;
	if (auth.provider === "openai") {
		const parsed = parseOpenAIResponse(text);
		if (!parsed.webSearchCallSeen) throw new Error("openai search returned no web_search_call");
		payload = parsed.payload;
	} else {
		payload = parseJson(text, "xai");
	}
	const output = Array.isArray(payload.output) ? payload.output : [];
	const answer = extractAnswer(output);
	const sources = extractSources(output, payload.citations);
	if (sources.length === 0) throw new Error(`${auth.provider} search returned no sources`);
	return { query, provider: auth.provider, model: auth.model, answer, sources };
}

export function formatSearchResult(result: SubscriptionSearchResult): string {
	const answer = result.answer.length > 20_000 ? `${result.answer.slice(0, 19_997)}...` : result.answer;
	const lines = [
		`## Search · ${result.provider}/${result.model}`,
		"",
		answer || "No synthesized answer was returned.",
	];
	if (result.sources.length > 0) {
		lines.push("", "### Sources");
		for (const [index, source] of result.sources.slice(0, 10).entries()) {
			const title = source.title.replace(/[\r\n]+/gu, " ").trim();
			lines.push(`${index + 1}. ${title} — <${source.url}>`);
		}
	}
	return lines.join("\n");
}
