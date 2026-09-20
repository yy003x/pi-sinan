import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import usageExtension from "../extensions/usage.ts";
import {
	USAGE_CACHE_TTL_MS,
	USAGE_FAILURE_BACKOFF_MS,
	UsageCache,
	buildUsageStatusEvent,
	fetchUsageJson,
	formatUsageReport,
	formatUsageStatus,
	normalizeCodexUsage,
	normalizeGrokIdentity,
	normalizeGrokUsage,
	queryUsage,
	redactUsageError,
	resolveUsageAuth,
	usageEndpoint,
	usageProviderForModel,
	type ResolvedUsageAuth,
} from "../src/usage.ts";

const NOW = 1_700_000_000_000;

function context(options: { provider?: string; baseUrl?: string; oauth?: boolean; authBaseUrl?: string; token?: string }): ExtensionContext {
	const provider = options.provider ?? "openai-codex";
	const model = { provider, id: "model", baseUrl: options.baseUrl ?? (provider === "xai" ? "https://api.x.ai/v1" : "https://chatgpt.com/backend-api") };
	return {
		model,
		modelRegistry: {
			isUsingOAuth: () => options.oauth ?? true,
			getProviderAuth: async () => ({ auth: { apiKey: options.token ?? "oauth-secret", baseUrl: options.authBaseUrl, headers: {} } }),
		},
	} as unknown as ExtensionContext;
}

test("Codex quota parsing normalizes official primary and secondary windows", () => {
	const report = normalizeCodexUsage({
		rate_limit: {
			primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_at: 1_700_000_100 },
			secondary_window: { used_percent: "60", limit_window_seconds: 604_800 },
		},
		credits: { balance: 99 },
		rate_limit_reset_credits: { available_count: 4 },
	}, NOW);
	assert.equal(report.providerId, "openai-codex");
	assert.deepEqual(report.buckets.map(({ id, groupId, used, remaining, windowMinutes }) => ({ id, groupId, used, remaining, windowMinutes })), [
		{ id: "codex:primary", groupId: "codex", used: 25, remaining: 75, windowMinutes: 300 },
		{ id: "codex:secondary", groupId: "codex", used: 60, remaining: 40, windowMinutes: 10_080 },
	]);
	assert.equal(report.defaultGroupId, "codex");
	assert.equal("metrics" in report, false, "credit/reset metadata is intentionally not modeled");
});

test("Codex additional model groups stay distinct and status selects the current model group", () => {
	const report = normalizeCodexUsage({
		rate_limit: {
			primary_window: { used_percent: 10, limit_window_seconds: 18_000 },
			secondary_window: { used_percent: 20, limit_window_seconds: 604_800 },
		},
		additional_rate_limits: [{
			metered_feature: "gpt-5.3-codex-spark",
			limit_name: "GPT-5.3-Codex-Spark",
			rate_limit: {
				primary_window: { used_percent: 70, limit_window_seconds: 18_000 },
				secondary_window: { used_percent: 80, limit_window_seconds: 604_800 },
			},
		}],
	}, NOW);
	assert.equal(report.buckets.length, 4);
	const sparkEvent = buildUsageStatusEvent(report, "remaining", { provider: "openai-codex", id: "gpt-5.3-codex-spark" });
	assert.equal(sparkEvent.status, "ready");
	if (sparkEvent.status !== "ready") throw new Error("expected ready usage event");
	assert.deepEqual(sparkEvent.windows.map((window) => ({ groupId: window.groupId, displayPercent: window.displayPercent })), [
		{ groupId: "gpt-5.3-codex-spark", displayPercent: 30 },
		{ groupId: "gpt-5.3-codex-spark", displayPercent: 20 },
	]);
	assert.equal(formatUsageStatus(report, "remaining", { provider: "openai-codex", id: "gpt-6" }), "5h 90% · 1w 80%");
	const full = formatUsageReport({ status: "ready", report }, "remaining");
	assert.match(full, /Shared Across Models/);
	assert.match(full, /GPT-5\.3-Codex-Spark/);
});

test("Grok quota parsing validates identity and combines weekly/monthly windows", () => {
	assert.equal(normalizeGrokIdentity({ userId: "user-123" }), "user-123");
	assert.throws(() => normalizeGrokIdentity({ userId: "bad user" }), /could not be verified/);
	const report = normalizeGrokUsage({
		config: { creditUsagePercent: 20, currentPeriod: { type: "WEEKLY", end: "2026-09-20T00:00:00Z" } },
	}, NOW, {
		config: { used: { val: 2500 }, monthlyLimit: { val: 10_000 }, billingPeriodEnd: "2026-10-01T00:00:00Z" },
	});
	assert.equal(report.providerId, "xai");
	assert.deepEqual(report.buckets.map(({ id, used, remaining }) => ({ id, used, remaining })), [
		{ id: "weekly", used: 20, remaining: 80 },
		{ id: "monthly", used: 25, remaining: 75 },
	]);
});

test("Grok infers proto3 zero only for an explicit weekly currentPeriod", () => {
	assert.throws(() => normalizeGrokUsage({ config: {} }, NOW, null), /no quota windows/);
	assert.throws(() => normalizeGrokUsage({ config: { currentPeriod: { type: "MONTHLY" } } }, NOW, null), /no quota windows/);
	const weekly = normalizeGrokUsage({ config: { currentPeriod: { type: "WEEKLY" } } }, NOW, null);
	assert.equal(weekly.buckets[0]?.used, 0);
});

test("usage endpoints and Pi OAuth resolution fail closed", async () => {
	assert.equal(usageEndpoint("openai-codex"), "https://chatgpt.com/backend-api/wham/usage");
	assert.equal(usageEndpoint("xai", "identity"), "https://cli-chat-proxy.grok.com/v1/user");
	await assert.rejects(resolveUsageAuth(context({ oauth: false }), "openai-codex"), /requires Pi OAuth/);
	await assert.rejects(resolveUsageAuth(context({ baseUrl: "https://proxy.example/v1" }), "openai-codex"), /non-official/);
	await assert.rejects(resolveUsageAuth(context({ authBaseUrl: "https://proxy.example/v1" }), "openai-codex"), /proxy-resolved/);
	const resolved = await resolveUsageAuth(context({ token: "oauth-test" }), "openai-codex", new Uint8Array(32));
	assert.equal(resolved?.headers.Authorization, "Bearer oauth-test");
	assert.ok(resolved?.fingerprint && !resolved.fingerprint.includes("oauth-test"));
});

test("usage HTTP refuses arbitrary URLs and redacts credentials from failures", async () => {
	const auth: ResolvedUsageAuth = { providerId: "openai-codex", headers: { Authorization: "Bearer top-secret" }, fingerprint: "fp", secrets: ["top-secret", "Bearer top-secret"] };
	await assert.rejects(fetchUsageJson("https://evil.example/usage", auth, { signal: new AbortController().signal }), /non-official/);
	const fetchImpl = (async () => new Response("denied top-secret Bearer other-token", { status: 403 })) as typeof fetch;
	await assert.rejects(
		fetchUsageJson(usageEndpoint("openai-codex"), auth, { signal: new AbortController().signal, fetchImpl }),
		(error: unknown) => error instanceof Error && !error.message.includes("top-secret") && !error.message.includes("other-token") && error.message.includes("<redacted>"),
	);
	assert.equal(redactUsageError('{"access_token":"abc"} Bearer xyz'), '{"access_token":"<redacted>"} Bearer <redacted>');
});

test("usage HTTP streams enforce 64KB success and 4KB error limits", async () => {
	const auth: ResolvedUsageAuth = { providerId: "openai-codex", headers: { Authorization: "Bearer secret" }, fingerprint: "fp", secrets: ["secret"] };
	let successCancelled = false;
	const oversizedSuccess = (async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new TextEncoder().encode(`{"data":"${"x".repeat(70 * 1024)}"}`)); },
		cancel() { successCancelled = true; },
	}))) as typeof fetch;
	await assert.rejects(fetchUsageJson(usageEndpoint("openai-codex"), auth, { signal: new AbortController().signal, fetchImpl: oversizedSuccess }), /exceeded 65536 bytes/);
	assert.equal(successCancelled, true);

	let errorCancelled = false;
	const oversizedError = (async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new TextEncoder().encode(`denied ${"y".repeat(8 * 1024)}`)); },
		cancel() { errorCancelled = true; },
	}), { status: 403 })) as typeof fetch;
	await assert.rejects(fetchUsageJson(usageEndpoint("openai-codex"), auth, { signal: new AbortController().signal, fetchImpl: oversizedError }), /HTTP 403/);
	assert.equal(errorCancelled, true);
});

test("usage HTTP distinguishes timeout from caller abort", async () => {
	const auth: ResolvedUsageAuth = { providerId: "openai-codex", headers: { Authorization: "Bearer secret" }, fingerprint: "fp", secrets: ["secret"] };
	const waitsForAbort = (async (_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
		init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("Bearer secret"), { name: "AbortError" })), { once: true });
	})) as typeof fetch;
	await assert.rejects(
		fetchUsageJson(usageEndpoint("openai-codex"), auth, { signal: new AbortController().signal, timeoutMs: 5, fetchImpl: waitsForAbort }),
		(error: unknown) => error instanceof Error && error.name === "Error" && error.message === "Usage query timed out.",
	);
	const caller = new AbortController();
	const pending = fetchUsageJson(usageEndpoint("openai-codex"), auth, { signal: caller.signal, timeoutMs: 1_000, fetchImpl: waitsForAbort });
	caller.abort();
	await assert.rejects(pending, (error: unknown) => error instanceof Error && error.name === "AbortError" && !error.message.includes("secret"));
});

test("provider queries use only official endpoints and never make a real request", async () => {
	const urls: string[] = [];
	const fetchImpl = (async (input: string | URL | Request) => {
		const url = String(input); urls.push(url);
		if (url.endsWith("/v1/user")) return new Response(JSON.stringify({ userId: "user-1" }));
		if (url.includes("format=credits")) return new Response(JSON.stringify({ config: { isUnifiedBillingUser: true, creditUsagePercent: 10 } }));
		if (url.endsWith("/v1/billing")) return new Response(JSON.stringify({ config: { used: { val: 100 }, monthlyLimit: { val: 1000 } } }));
		return new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 30 } } }));
	}) as typeof fetch;
	const codex: ResolvedUsageAuth = { providerId: "openai-codex", headers: { Authorization: "Bearer c" }, fingerprint: "c", secrets: ["c"] };
	const grok: ResolvedUsageAuth = { providerId: "xai", headers: { Authorization: "Bearer x" }, fingerprint: "x", secrets: ["x"] };
	assert.equal((await queryUsage(codex, new AbortController().signal, fetchImpl)).providerId, "openai-codex");
	assert.equal((await queryUsage(grok, new AbortController().signal, fetchImpl)).providerId, "xai");
	assert.deepEqual(urls, [
		"https://chatgpt.com/backend-api/wham/usage",
		"https://cli-chat-proxy.grok.com/v1/user",
		"https://cli-chat-proxy.grok.com/v1/billing?format=credits",
		"https://cli-chat-proxy.grok.com/v1/billing",
	]);
});

test("Grok monthly probe failures are optional only when weekly quota is reliable", async () => {
	const auth: ResolvedUsageAuth = { providerId: "xai", headers: { Authorization: "Bearer x" }, fingerprint: "x", secrets: ["x"] };
	const reliableWeekly = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/v1/user")) return new Response(JSON.stringify({ userId: "user-1" }));
		if (url.includes("format=credits")) return new Response(JSON.stringify({ config: { isUnifiedBillingUser: true, creditUsagePercent: 15, currentPeriod: { type: "WEEKLY" } } }));
		return new Response("monthly unavailable", { status: 503 });
	}) as typeof fetch;
	const report = await queryUsage(auth, new AbortController().signal, reliableWeekly);
	assert.deepEqual(report.buckets.map(({ id, used }) => ({ id, used })), [{ id: "weekly", used: 15 }]);

	const noWeekly = (async (input: string | URL | Request) => {
		const url = String(input);
		if (url.endsWith("/v1/user")) return new Response(JSON.stringify({ userId: "user-1" }));
		if (url.includes("format=credits")) return new Response(JSON.stringify({ config: {} }));
		return new Response("monthly unavailable", { status: 503 });
	}) as typeof fetch;
	await assert.rejects(queryUsage(auth, new AbortController().signal, noWeekly), /HTTP 503/);
});

test("cache TTL, refresh/backoff constants, and structured status stay credential-free", () => {
	const report = normalizeCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18_000 } } }, NOW);
	const cache = new UsageCache(100);
	cache.set("openai-codex", "secret-fingerprint", report, 1_000);
	assert.equal(cache.get("openai-codex", "secret-fingerprint", 1_099), report);
	assert.equal(cache.get("openai-codex", "secret-fingerprint", 1_100), undefined);
	assert.equal(USAGE_CACHE_TTL_MS, 300_000);
	assert.equal(USAGE_FAILURE_BACKOFF_MS, 30_000);
	const event = buildUsageStatusEvent(report, "remaining");
	assert.equal(event.status, "ready");
	assert.equal(formatUsageStatus(report, "remaining"), "5h 88%");
	assert.doesNotMatch(JSON.stringify(event), /secret|authorization|token/iu);
});

test("unsupported providers expose no Kimi, OpenCode, or reset-credit functionality", () => {
	assert.equal(usageProviderForModel({ provider: "kimi-coding", id: "x" }), undefined);
	assert.equal(usageProviderForModel({ provider: "opencode-go", id: "x" }), undefined);
	assert.equal(usageProviderForModel({ provider: "openai-codex", id: "x" }), "openai-codex");
	assert.throws(() => usageEndpoint("openai-codex", "monthly"), /Unsupported/);
});

test("/usage discards an in-flight result after model identity changes", async () => {
	let usageHandler: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const emitted: unknown[] = [];
	const pi = {
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) {
			if (name === "usage") usageHandler = command.handler;
		},
		on() {},
		events: { emit(_name: string, value: unknown) { emitted.push(value); } },
	} as unknown as ExtensionAPI;
	usageExtension(pi);
	assert.ok(usageHandler);

	const originalModel = { provider: "openai-codex", id: "gpt-before", baseUrl: "https://chatgpt.com/backend-api" };
	const notifications: string[] = [];
	const statuses: string[] = [];
	const ctx = {
		model: originalModel,
		modelRegistry: {
			isUsingOAuth: () => true,
			getProviderAuth: async () => ({ auth: { apiKey: "oauth-secret", headers: {} } }),
		},
		ui: {
			notify(message: string) { notifications.push(message); },
			setStatus(_key: string, value: string | undefined) { if (value) statuses.push(value); },
		},
	};

	const realFetch = globalThis.fetch;
	let release: ((response: Response) => void) | undefined;
	globalThis.fetch = (async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
	try {
		const pending = usageHandler!("", ctx as unknown as ExtensionContext);
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		ctx.model = { ...originalModel, id: "gpt-after" };
		release(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25 } } })));
		await pending;
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.deepEqual(notifications, ["Usage result was discarded because the selected model changed during the query."]);
	assert.deepEqual(statuses, []);
	assert.equal(emitted.some((value) => (value as { status?: unknown }).status === "ready"), false);
});
