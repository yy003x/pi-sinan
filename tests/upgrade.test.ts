import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFastAvailability } from "../src/fast-catalog.ts";
import { IMAGE_HISTORY_ENTRY, sessionImageHistory } from "../src/image-history.ts";
import { UsageAlerts, type UsageReport } from "../src/usage.ts";
import doctorExtension from "../extensions/doctor.ts";
import { safeRecoveryStatusText } from "../extensions/codex-recovery.ts";
import usageExtension, { type UsageExtensionDependencies } from "../extensions/usage.ts";
import imageExtension from "../extensions/image.ts";

const codex = { provider: "openai-codex", id: "m", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" };
const report = (remaining: number, reset = 100): UsageReport => ({ providerId: "xai", providerName: "Grok", capturedAt: 1, source: "grok-pi-oauth", buckets: [{ id: "weekly", label: "Weekly", used: 100 - remaining, remaining, limit: 100, unit: "percent", resetsAt: reset }] });

test("catalog GET uses official origin and OAuth, bounds responses, rejects redirects and hides secrets", async () => {
	const ctx = { model: codex, modelRegistry: { isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: "secret" } }) } } as unknown as ExtensionContext;
	const result = await checkFastAvailability(ctx, (async (input, init) => {
		assert.equal(String(input), "https://chatgpt.com/backend-api/codex/models?client_version=0.156.0");
		assert.equal(init?.method, "GET");
		assert.equal(init?.redirect, "error");
		assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer secret");
		return new Response(JSON.stringify({ models: [{ slug: "m", service_tiers: [{ id: "priority" }] }] }));
	}) as typeof fetch);
	assert.equal(result.status, "supported");
	const bad = await checkFastAvailability({ ...ctx, model: { ...codex, baseUrl: "https://proxy.example/backend-api" } } as ExtensionContext, async () => { throw new Error("fetch must not run"); });
	assert.equal(bad.status, "unavailable");
	const withinLimit = await checkFastAvailability(ctx, async () => new Response(JSON.stringify({ models: [
		{ slug: "m", service_tiers: [{ id: "priority" }] },
		{ slug: "other", description: "x".repeat(600 * 1024) },
	] })));
	assert.equal(withinLimit.status, "supported", "a catalog larger than the old 256 KiB cap must remain usable");
	let cancelled = false;
	const oversize = await checkFastAvailability(ctx, async () => new Response(new ReadableStream<Uint8Array>({
		start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); },
		cancel() { cancelled = true; },
	})));
	assert.equal(oversize.status, "unavailable");
	assert.equal(oversize.reason, "Official catalog response too large.");
	assert.equal(cancelled, true, "oversized catalog streams must be cancelled before parsing");
	const empty = await checkFastAvailability(ctx, async () => new Response(JSON.stringify({ models: [] })));
	assert.equal(empty.status, "unavailable", "an empty official catalog must never enable Fast");
	const conflictingHeaders = { ...ctx, modelRegistry: { ...ctx.modelRegistry, getProviderAuth: async () => ({ auth: { apiKey: "secret", headers: { authorization: "Bearer wrong" } } }) } } as unknown as ExtensionContext;
	const singleAuth = await checkFastAvailability(conflictingHeaders, async (_url, init) => {
		const headers = new Headers(init?.headers);
		assert.equal(headers.get("authorization"), "Bearer secret");
		assert.equal([...headers.keys()].filter((key) => key === "authorization").length, 1);
		return new Response(JSON.stringify({ models: [{ slug: "m", service_tiers: [{ id: "priority" }] }] }));
	});
	assert.equal(singleAuth.status, "supported");
});

test("threshold crossing dedupes per account, resets baseline on window change", () => {
	const alerts = new UsageAlerts();
	assert.deepEqual(alerts.check("xai:a", report(40), [20, 10, 5]), []);
	assert.equal(alerts.check("xai:a", report(19), [20, 10, 5]).length, 1);
	assert.deepEqual(alerts.check("xai:a", report(18), [20, 10, 5]), []);
	assert.deepEqual(alerts.check("xai:b", report(18), [20, 10, 5]), []);
	assert.deepEqual(alerts.check("xai:a", report(3, 200), [20, 10, 5]), []);
	assert.equal(alerts.check("xai:a", report(2, 200), [20, 10, 5]).length, 0);
	assert.equal(alerts.check("xai:a", report(30, 200), [20, 10, 5]).length, 0);
	assert.equal(alerts.check("xai:a", report(9, 200), [20, 10, 5]).length, 1);
});

test("image history is branch-local and rejects non-workspace entries", () => {
	const item = { id: "1", prompt: "private original prompt", provider: "xai", aspect: "16:9", path: "/workspace/a.png", workspace: "/workspace", createdAt: 1 };
	const entry = { type: "custom", customType: IMAGE_HISTORY_ENTRY, data: item };
	assert.deepEqual(sessionImageHistory([entry], "/workspace"), [item]);
	assert.deepEqual(sessionImageHistory([], "/workspace"), []);
	assert.deepEqual(sessionImageHistory([entry], "/elsewhere"), []);
	assert.deepEqual(sessionImageHistory([{ ...entry, data: { ...item, path: "/workspace/../escape.png" } }], "/workspace"), []);
});

test("command and tool images persist branch-only original prompt; repeat is strict and never overwrites", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sinan-upgrade-"));
	const bytes = readFileSync(new URL("./fixtures/1x1.png", import.meta.url));
	const entries: Array<{ type: string; customType: string; data: unknown }> = [];
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let tool: { execute: (id: string, input: { prompt: string; provider: "xai"; path: string }, signal: AbortSignal, update: undefined, ctx: ExtensionContext) => Promise<unknown> } | undefined;
	const messages: string[] = [];
	const model = { provider: "xai", id: "grok", baseUrl: "https://api.x.ai/v1" };
	const ctx = { cwd, model, modelRegistry: { getAll: () => [model], isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: "secret" } }) }, sessionManager: { getBranch: () => entries }, ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionContext;
	const pi = { on() {}, registerEntryRenderer() {}, registerTool(value: typeof tool) { tool = value; }, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const previous = globalThis.fetch;
	let calls = 0;
	globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: bytes.toString("base64") }] })); }) as typeof fetch;
	try {
		imageExtension(pi);
		await command?.("private original prompt --provider xai --aspect 16:9 --path first.png", ctx);
		assert.equal(sessionImageHistory(entries, cwd)[0]?.prompt, "private original prompt");
		const outside = mkdtempSync(join(tmpdir(), "pi-sinan-escape-"));
		try {
			symlinkSync(outside, join(cwd, "escape"));
			await command?.("no external write --provider xai --path escape/new/file.png", ctx);
			assert.equal(calls, 1, "symlink output must fail before spending quota");
			assert.equal(existsSync(join(outside, "new")), false);
			symlinkSync(join(outside, "missing"), join(cwd, "dangling"));
			await command?.("no dangling write --provider xai --path dangling/file.png", ctx);
			assert.equal(calls, 1, "dangling symlink output must fail before spending quota");
		} finally { rmSync(outside, { recursive: true, force: true }); }
		await command?.("another --provider xai --path first.png", ctx);
		assert.equal(calls, 1, "existing image must refuse before consuming another request");
		await command?.("repeat 1", ctx);
		assert.equal(calls, 2);
		assert.equal(sessionImageHistory(entries, cwd)[1]?.provider, "xai");
		await tool?.execute("call", { prompt: "tool secret", provider: "xai", path: "tool.png" }, new AbortController().signal, undefined, ctx);
		assert.equal(sessionImageHistory(entries, cwd)[2]?.prompt, "tool secret");
		assert.equal(calls, 3);
		assert.ok(messages.some((message) => /subscription quota spent/.test(message)));
		const first = sessionImageHistory(entries, cwd)[0]!;
		writeFileSync(first.path, Buffer.alloc(8 * 1024 * 1024 + 1));
		await command?.(`show ${first.id}`, ctx);
		assert.match(messages.at(-1)!, /preview size limit/);
	} finally { globalThis.fetch = previous; rmSync(cwd, { recursive: true, force: true }); }
});

test("in-flight image generation does not attach the original prompt to a new branch", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sinan-branch-image-"));
	const imageBytes = readFileSync(new URL("./fixtures/1x1.png", import.meta.url));
	let branch: Array<{ id: string; type: string; customType: string; data: unknown }> = [{ id: "initial", type: "custom", customType: "anchor", data: {} }];
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	let release: ((response: Response) => void) | undefined;
	const messages: string[] = [];
	const model = { provider: "xai", id: "grok", baseUrl: "https://api.x.ai/v1" };
	const ctx = { cwd, model, modelRegistry: { getAll: () => [model], isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: "secret" } }) },
		sessionManager: { getBranch: () => branch, getLeafId: () => branch[0]?.id, getSessionFile: () => "session.jsonl" }, ui: { notify: (message: string) => messages.push(message) } } as unknown as ExtensionContext;
	const pi = { on() {}, registerEntryRenderer() {}, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; },
		appendEntry(customType: string, data: unknown) { branch.push({ id: `${branch.length}`, type: "custom", customType, data }); } } as unknown as ExtensionAPI;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Promise<Response>((resolve) => { release = resolve; })) as typeof fetch;
	try {
		imageExtension(pi);
		const pending = command!("private prompt --provider xai --path image.png", ctx);
		while (!release) await new Promise((resolve) => setImmediate(resolve));
		branch = [{ id: "other", type: "custom", customType: "anchor", data: {} }];
		release(new Response(JSON.stringify({ data: [{ b64_json: imageBytes.toString("base64") }] })));
		await pending;
		assert.deepEqual(sessionImageHistory(branch, cwd), []);
		assert.ok(messages.some((message) => message.includes("Saved")));
	} finally { globalThis.fetch = originalFetch; rmSync(cwd, { recursive: true, force: true }); }
});

test("/sn-usage all resolves each provider independently even when current model is unrelated", async () => {
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const queried: string[] = [];
	const messages: string[] = [];
	const models = [codex, { provider: "xai", id: "grok", baseUrl: "https://api.x.ai/v1" }];
	const pi = { registerCommand(_name: string, value: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { command = value.handler; }, on() {}, events: { emit() {} } } as unknown as ExtensionAPI;
	const dependencies = { queryUsage: async (auth: { providerId: string }) => { queried.push(auth.providerId); return report(19); } } as unknown as UsageExtensionDependencies;
	usageExtension(pi, dependencies);
	const ctx = { model: { provider: "other", id: "other" }, modelRegistry: { getAll: () => models, isUsingOAuth: () => true, getProviderAuth: async (providerId: string) => ({ auth: { apiKey: `${providerId}-secret` } }) }, ui: { notify(message: string) { messages.push(message); } }, hasUI: true } as unknown as ExtensionContext;
	await command?.("all", ctx);
	assert.deepEqual(queried, ["xai", "openai-codex"]);
	assert.equal(messages.length, 1);
	assert.doesNotMatch(messages.join("\n"), /secret/);
});

test("/sn-usage alerts toggles from off and preserves explicit settings", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sinan-alert-toggle-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const notices: string[] = [];
		const pi = { registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, on(name: string, handler: (event: unknown, ctx: ExtensionContext) => void) { handlers.set(name, handler); }, events: { emit() {} } } as unknown as ExtensionAPI;
		const ctx = { cwd, hasUI: false, isProjectTrusted: () => false, ui: { notify: (text: string) => notices.push(text) } } as unknown as ExtensionContext;
		usageExtension(pi);
		handlers.get("session_start")?.({}, ctx);
		await command?.("alerts", ctx);
		assert.match(notices.at(-1) ?? "", /off -> on/);
		await command?.("alerts", ctx);
		assert.match(notices.at(-1) ?? "", /on -> off/);
		await command?.("alerts on", ctx);
		assert.match(notices.at(-1) ?? "", /Usage: \/sn-usage \[all\|alerts\]/);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ piSinan: { usage: { alerts: true } } }));
		handlers.get("session_start")?.({}, ctx);
		await command?.("alerts", ctx);
		assert.match(notices.at(-1) ?? "", /on -> off/, "explicit true settings must remain authoritative");
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("/sn-image config toggles previews from off without a settings file", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-sinan-preview-toggle-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
		const notices: string[] = [];
		const entries: Array<{ type: string; customType: string; data: unknown }> = [];
		const pi = { on() {}, registerEntryRenderer() {}, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); } } as unknown as ExtensionAPI;
		const ctx = { cwd, ui: { notify: (text: string) => notices.push(text) }, sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
		imageExtension(pi);
		await command?.("config status", ctx);
		assert.match(notices.at(-1) ?? "", /Image preview: off/);
		assert.equal(existsSync(join(agentDir, "settings.json")), false, "status must not write settings");
		await command?.("config", ctx);
		assert.match(notices.at(-1) ?? "", /off -> on/);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).piSinan.image.showInConversation, true);
		await command?.("config dir pictures", ctx);
		await command?.("config", ctx);
		assert.match(notices.at(-1) ?? "", /on -> off/);
		assert.deepEqual(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).piSinan.image, { showInConversation: false, outputDir: "pictures" });
		await command?.("config on", ctx);
		assert.match(notices.at(-1) ?? "", /Usage: \/sn-image config/);
		assert.equal(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).piSinan.image.showInConversation, false);
	} finally {
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("doctor recovery display never includes raw failure diagnostics", () => {
	const safe = safeRecoveryStatusText({ mode: "sse-cooldown", consecutiveSseSuccesses: 0, websocketFailures: 1, capacityFailures: 0, lastFailure: "Bearer secret x-account-id=private" });
	assert.doesNotMatch(safe, /secret|private|Bearer|lastFailure/);
});

test("doctor all checks both signed-in models without paid POST", async () => {
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const messages: string[] = [];
	const models = [codex, { provider: "xai", id: "grok", baseUrl: "https://api.x.ai/v1" }];
	const ctx = { model: models[1], sessionManager: { getSessionId: () => "test" }, modelRegistry: { getAll: () => models, isUsingOAuth: () => true, getProviderAuth: async () => ({ auth: { apiKey: "secret" } }) }, ui: { notify: (text: string) => messages.push(text) } } as unknown as ExtensionContext;
	const pi = { registerCommand: (_name: string, entry: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => { command = entry.handler; } } as unknown as ExtensionAPI;
	doctorExtension(pi, async () => ({ status: "supported", reason: "catalog" }));
	await command?.("all", ctx);
	assert.match(messages.join("\n"), /xai\/grok: OAuth available/);
	assert.match(messages.join("\n"), /Fast: supported \(catalog\); recovery: no xAI transport adapter/);
	assert.match(messages.join("\n"), /openai-codex\/m: OAuth available/);
	assert.doesNotMatch(messages.join("\n"), /secret/);
});
