import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import codexRecoveryExtension from "../extensions/codex-recovery.ts";
import fastExtension from "../extensions/fast.ts";
import doctorExtension from "../extensions/doctor.ts";
import imageExtension from "../extensions/image.ts";
import searchExtension from "../extensions/search.ts";
import usageExtension from "../extensions/usage.ts";

interface RegisteredCommand {
	description: string;
	handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
}

function registry() {
	const commands = new Map<string, RegisteredCommand>();
	const tools = new Set<string>();
	const handlers: Array<{ event: string; handler: unknown }> = [];
	const api = {
		on(event: string, handler: unknown) { handlers.push({ event, handler }); },
		registerCommand(name: string, command: RegisteredCommand) {
			assert.equal(commands.has(name), false, `duplicate command: ${name}`);
			commands.set(name, command);
		},
		registerTool(tool: { name: string }) {
			assert.equal(tools.has(tool.name), false, `duplicate tool: ${tool.name}`);
			tools.add(tool.name);
		},
		registerEntryRenderer() {},
		registerProvider() {},
		appendEntry() {},
		sendMessage() {},
		getThinkingLevel() { return "off"; },
		events: { emit() {}, on() { return () => {}; } },
	} as unknown as ExtensionAPI;
	return { api, commands, tools, handlers };
}

test("all six extensions load and register unique public commands/tools", () => {
	const loaded = registry();
	for (const extension of [imageExtension, searchExtension, usageExtension, doctorExtension, codexRecoveryExtension, fastExtension]) {
		extension(loaded.api);
	}
	assert.deepEqual([...loaded.commands.keys()].sort(), ["sn-doctor", "sn-fast", "sn-image", "sn-recovery", "sn-search", "sn-usage"]);
	assert.deepEqual([...loaded.tools].sort(), ["generate_image"]);
	assert.ok(loaded.handlers.some(({ event }) => event === "session_start"));
});

function authContext(options: {
	oauth: boolean;
	resolverThrows?: boolean;
	auth?: { apiKey: string; headers?: Record<string, string> };
}): ExtensionContext {
	const model = {
		id: "grok-4.6",
		name: "Grok 4.6",
		provider: "xai",
		baseUrl: "https://api.x.ai/v1",
	};
	return {
		cwd: process.cwd(),
		signal: new AbortController().signal,
		scopedModels: [],
		model,
		modelRegistry: {
			getAll: () => [model],
			isUsingOAuth: () => options.oauth,
			getProviderAuth: async () => {
				if (options.resolverThrows) throw new Error("Bearer image-secret token=private");
				return { auth: options.auth ?? { apiKey: "api-key-must-not-be-used" } };
			},
			getApiKeyAndHeaders: async () => {
				if (options.resolverThrows) throw new Error("Bearer search-secret token=private");
				return { ok: true, apiKey: "api-key-must-not-be-used", baseUrl: model.baseUrl };
			},
		},
	} as unknown as ExtensionContext;
}

function commandHarness(extension: (pi: ExtensionAPI) => void) {
	const loaded = registry();
	extension(loaded.api);
	const notices: string[] = [];
	const statuses: string[] = [];
	return {
		command(name: string) { return loaded.commands.get(name)?.handler; },
		ui: {
			notify(message: string) { notices.push(message); },
			setStatus(_key: string, value: string | undefined) { if (value) statuses.push(value); },
		},
		notices,
		statuses,
	};
}

test("image rejects API-key-only catalogs without resolving provider credentials", async () => {
	const harness = commandHarness(imageExtension);
	const ctx = authContext({ oauth: false });
	(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
	await harness.command("sn-image")?.("draw a cat --provider xai", ctx);
	assert.match(harness.notices.join("\n"), /xAI subscription is not configured/);
	assert.doesNotMatch(harness.notices.join("\n"), /api-key-must-not-be-used/);
});

test("image resolver exceptions are replaced before reaching command UI", async () => {
	const harness = commandHarness(imageExtension);
	const ctx = authContext({ oauth: true, resolverThrows: true });
	(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
	await harness.command("sn-image")?.("draw a cat --provider xai", ctx);
	const message = harness.notices.join("\n");
	assert.match(message, /xAI subscription authentication could not be resolved safely/);
	assert.doesNotMatch(message, /image-secret|Bearer|token=private/);
});

test("image POST rejects redirects and redacts fetch exceptions before command UI", async () => {
	const harness = commandHarness(imageExtension);
	const ctx = authContext({
		oauth: true,
		auth: { apiKey: "oauth-image-secret", headers: { "x-account-id": "account-image-secret" } },
	});
	(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
	const originalFetch = globalThis.fetch;
	let capturedInit: RequestInit | undefined;
	globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		capturedInit = init;
		throw new Error("network exposed oauth-image-secret and account-image-secret");
	}) as typeof fetch;
	try {
		await harness.command("sn-image")?.("draw a cat --provider xai", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(capturedInit?.redirect, "error");
	const message = harness.notices.join("\n");
	assert.match(message, /image request failed/);
	assert.match(message, /\[redacted\]/);
	assert.doesNotMatch(message, /oauth-image-secret|account-image-secret/);
});

test("image redacts response read exceptions before command UI", async () => {
	const harness = commandHarness(imageExtension);
	const ctx = authContext({
		oauth: true,
		auth: { apiKey: "oauth-image-secret", headers: { "x-account-id": "account-image-secret" } },
	});
	(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => ({
		ok: true,
		body: new ReadableStream({ pull() { throw new Error("read exposed oauth-image-secret and account-image-secret"); } }),
	}) as unknown as Response) as typeof fetch;
	try {
		await harness.command("sn-image")?.("draw a cat --provider xai", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}

	const message = harness.notices.join("\n");
	assert.match(message, /image response read failed/);
	assert.match(message, /\[redacted\]/);
	assert.doesNotMatch(message, /oauth-image-secret|account-image-secret/);
});

test("image rejects URL-only payloads without issuing a download request", async () => {
	const harness = commandHarness(imageExtension);
	const ctx = authContext({ oauth: true, auth: { apiKey: "oauth-image-secret" } });
	(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;
	globalThis.fetch = (async () => {
		fetchCalls += 1;
		return new Response(JSON.stringify({ data: [{ url: "https://untrusted.example/image.png" }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;
	try {
		await harness.command("sn-image")?.("draw a cat --provider xai", ctx);
	} finally {
		globalThis.fetch = originalFetch;
	}

	assert.equal(fetchCalls, 1);
	const message = harness.notices.join("\n");
	assert.match(message, /URL-only payload/);
	assert.doesNotMatch(message, /untrusted\.example/);
});

test("search rejects API keys and redacts resolver exceptions at the UI boundary", async () => {
	for (const options of [{ oauth: false }, { oauth: true, resolverThrows: true }]) {
		const harness = commandHarness(searchExtension);
		const ctx = authContext(options);
		(ctx as unknown as { ui: typeof harness.ui }).ui = harness.ui;
		await harness.command("sn-search")?.("security news", ctx);
		const message = harness.notices.join("\n");
		assert.match(message, /xAI subscription authentication could not be resolved safely/);
		assert.doesNotMatch(message, /api-key-must-not-be-used|search-secret|Bearer|token=private/);
	}
});
