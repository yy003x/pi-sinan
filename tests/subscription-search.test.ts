import assert from "node:assert/strict";
import test from "node:test";

import {
	buildSearchBody,
	formatSearchResult,
	parseSearchCommand,
	pickSearchModel,
	runSubscriptionSearch,
	searchEndpoint,
	type SearchAuth,
	type SearchModel,
} from "../src/subscription-search.ts";

const MODELS: SearchModel[] = [
	{ id: "grok-4.3", provider: "xai", baseUrl: "https://api.x.ai/v1" },
	{ id: "grok-4.5", provider: "xai", baseUrl: "https://api.x.ai/v1" },
	{ id: "grok-4.6", provider: "xai", baseUrl: "https://api.x.ai/v1" },
	{ id: "gpt-5.6-sol", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
	{ id: "gpt-5.6-terra", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
	{ id: "gpt-6-astra", provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
];

const XAI_AUTH: SearchAuth = {
	provider: "xai",
	apiKey: "xai-test",
	model: "grok-4.6",
	baseUrl: "https://api.x.ai/v1",
};
const OPENAI_AUTH: SearchAuth = {
	provider: "openai",
	apiKey: "openai-test",
	model: "gpt-5.6-terra",
	baseUrl: "https://chatgpt.com/backend-api",
	headers: {
		"chatgpt-account-id": "account-test",
		"x-routing-token": "routing-test",
	},
};

test("/sn-search defaults to xAI and accepts explicit OpenAI", () => {
	assert.deepEqual(parseSearchCommand("latest TypeScript news"), {
		query: "latest TypeScript news",
		provider: "xai",
	});
	assert.deepEqual(parseSearchCommand("latest TypeScript news --provider openai"), {
		query: "latest TypeScript news",
		provider: "openai",
	});
	assert.deepEqual(parseSearchCommand("--provider=xai  latest   news"), {
		query: "latest news",
		provider: "xai",
	});
	assert.throws(() => parseSearchCommand("--provider brave query"), /unsupported search provider/);
	assert.throws(() => parseSearchCommand("latest news --provider"), /requires xai or openai/);
	assert.throws(() => parseSearchCommand("--provider="), /requires xai or openai/);
	assert.throws(() => parseSearchCommand("--provider xai"), /query must not be empty/);
});

test("subscription search selects stable provider-specific models", () => {
	assert.equal(pickSearchModel("xai", MODELS)?.id, "grok-4.6");
	assert.equal(pickSearchModel("xai", MODELS.filter((model) => model.id === "grok-4.6"))?.id, "grok-4.6");
	assert.equal(pickSearchModel("openai", MODELS)?.id, "gpt-5.6-terra");
});

test("search endpoints fail closed to official provider hosts", () => {
	assert.equal(searchEndpoint("xai", "https://api.x.ai/v1"), "https://api.x.ai/v1/responses");
	assert.equal(
		searchEndpoint("openai", "https://chatgpt.com/backend-api"),
		"https://chatgpt.com/backend-api/codex/responses",
	);
	assert.equal(
		searchEndpoint("openai", "https://chatgpt.com/backend-api/codex/"),
		"https://chatgpt.com/backend-api/codex/responses",
	);
	assert.throws(() => searchEndpoint("xai", "https://gateway.example.com/v1"), /non-official/);
	assert.throws(() => searchEndpoint("openai", "http://chatgpt.com/backend-api"), /non-official/);
});

test("provider request bodies use hosted web_search", () => {
	assert.deepEqual(buildSearchBody("xai", "grok-4.6", "query"), {
		model: "grok-4.6",
		input: "Search the web and answer using only what the search results say. Cite sources inline.\n\nquery",
		tools: [{ type: "web_search" }],
	});
	const openai = buildSearchBody("openai", "gpt-5.6-terra", "query");
	assert.equal(openai.model, "gpt-5.6-terra");
	assert.deepEqual(openai.tools, [{ type: "web_search" }]);
	assert.equal(openai.stream, true);
	assert.equal(openai.tool_choice, "required");
});

test("xAI subscription search returns answer and deduplicated sources", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(JSON.stringify({
			output: [
				{ type: "web_search_call", action: { sources: [{ url: "https://example.com/a", title: "A" }] } },
				{ type: "message", content: [{ type: "output_text", text: "Grounded answer" }] },
			],
			citations: ["https://example.com/a", "https://example.com/b"],
		}), { status: 200, headers: { "content-type": "application/json" } });
	}) as typeof fetch;

	const result = await runSubscriptionSearch("query", XAI_AUTH, { fetchImpl });
	assert.equal(capturedUrl, "https://api.x.ai/v1/responses");
	const headers = new Headers(capturedInit?.headers);
	assert.equal(headers.get("authorization"), "Bearer xai-test");
	assert.equal(capturedInit?.redirect, "error");
	assert.equal(result.answer, "Grounded answer");
	assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/a", "https://example.com/b"]);
});

test("OpenAI subscription search parses SSE and preserves account routing", async () => {
	let capturedUrl = "";
	let capturedInit: RequestInit | undefined;
	const events = [
		{ type: "response.output_item.done", item: { type: "web_search_call", action: { sources: [{ url: "https://example.com/source", title: "Source" }] } } },
		{ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "OpenAI answer", annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Source", start_index: 0, end_index: 6 }] }] } },
		{ type: "response.completed", response: { output: [] } },
	];
	const sse = `${events.map((event) => `data: ${JSON.stringify(event)}`).join("\n")}\ndata: [DONE]\n`;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		capturedUrl = String(input);
		capturedInit = init;
		return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
	}) as typeof fetch;

	const result = await runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl });
	assert.equal(capturedUrl, "https://chatgpt.com/backend-api/codex/responses");
	const headers = new Headers(capturedInit?.headers);
	assert.equal(headers.get("authorization"), "Bearer openai-test");
	assert.equal(headers.get("chatgpt-account-id"), "account-test");
	assert.equal(headers.get("x-routing-token"), "routing-test");
	assert.equal(headers.get("originator"), "pi-sinan");
	assert.equal(capturedInit?.redirect, "error");
	assert.equal(result.answer, "OpenAI answer");
	assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/source"]);
});

test("OpenAI subscription search accepts standard multi-line SSE data", async () => {
	const webEvent = [
		'data: {"type":"response.output_item.done",',
		'data: "item":{"type":"web_search_call","action":{"sources":[{"url":"https://example.com/multi","title":"Multi"}]}}}',
	].join("\n");
	const messageEvent = `data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "Multi-line answer" }] } })}`;
	const completedEvent = `data: ${JSON.stringify({ type: "response.completed", response: { output: [] } })}`;
	const sse = `${webEvent}\n\n${messageEvent}\n\n${completedEvent}\n\ndata: [DONE]\n`;
	const fetchImpl = (async () => new Response(sse, { status: 200 })) as typeof fetch;

	const result = await runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl });
	assert.equal(result.answer, "Multi-line answer");
	assert.deepEqual(result.sources.map((source) => source.url), ["https://example.com/multi"]);
});

test("search rejects synthesized answers without sources", async () => {
	const fetchImpl = (async () => new Response(JSON.stringify({
		output: [{ type: "message", content: [{ type: "output_text", text: "Uncited answer" }] }],
	}), { status: 200 })) as typeof fetch;
	await assert.rejects(runSubscriptionSearch("query", XAI_AUTH, { fetchImpl }), /returned no sources/);
});

test("search HTTP errors redact subscription credentials and all routing headers", async () => {
	const fetchImpl = (async () => new Response(
		"denied openai-test account-test routing-test Bearer echoed-token",
		{ status: 403 },
	)) as typeof fetch;
	await assert.rejects(
		runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl }),
		(error: unknown) => error instanceof Error
			&& !error.message.includes("openai-test")
			&& !error.message.includes("account-test")
			&& !error.message.includes("routing-test")
			&& !error.message.includes("echoed-token")
			&& error.message.includes("[redacted]"),
	);
});

test("search fetch exceptions are bounded and redact OAuth and account headers", async () => {
	const fetchImpl = (async () => {
		throw new Error(`network openai-test account-test routing-test Bearer echoed-token ${"x".repeat(1_000)}`);
	}) as typeof fetch;
	await assert.rejects(
		runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl }),
		(error: unknown) => error instanceof Error
			&& error.message.startsWith("openai search request failed:")
			&& error.message.length <= 340
			&& !error.message.includes("openai-test")
			&& !error.message.includes("account-test")
			&& !error.message.includes("routing-test")
			&& !error.message.includes("echoed-token")
			&& error.message.includes("[redacted]"),
	);
});

test("search response read exceptions are bounded and redact subscription secrets", async () => {
	const fetchImpl = (async () => ({
		ok: true,
		status: 200,
		text: async () => {
			throw new Error(`read openai-test account-test routing-test ${"y".repeat(1_000)}`);
		},
	}) as unknown as Response) as typeof fetch;
	await assert.rejects(
		runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl }),
		(error: unknown) => error instanceof Error
			&& error.message.startsWith("openai search response read failed:")
			&& error.message.length <= 350
			&& !error.message.includes("openai-test")
			&& !error.message.includes("account-test")
			&& !error.message.includes("routing-test")
			&& error.message.includes("[redacted]"),
	);
});

test("search preserves abort errors for cancellation", async () => {
	const controller = new AbortController();
	const abort = new DOMException("cancelled", "AbortError");
	const fetchImpl = (async () => {
		controller.abort();
		throw abort;
	}) as typeof fetch;
	await assert.rejects(
		runSubscriptionSearch("query", OPENAI_AUTH, { fetchImpl, signal: controller.signal }),
		(error: unknown) => error === abort,
	);
});

test("formatted results are bounded and include clickable sources", () => {
	const markdown = formatSearchResult({
		query: "query",
		provider: "xai",
		model: "grok-4.6",
		answer: "Answer",
		sources: [{ title: "Example", url: "https://example.com" }],
	});
	assert.match(markdown, /Search · xai\/grok-4\.6/);
	assert.match(markdown, /<https:\/\/example\.com>/);
});
