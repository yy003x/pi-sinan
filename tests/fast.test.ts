import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastExtension from "../extensions/fast.ts";
import { FAST_STATE_ENTRY, addFastServiceTier, fastStateFromEntries } from "../src/fast.ts";

test("Fast payload injection is limited to enabled OpenAI Codex requests", () => {
	const payload = { model: "gpt-5.6-sol", stream: true };
	assert.equal(addFastServiceTier(payload, false, "openai-codex"), payload);
	assert.equal(addFastServiceTier(payload, true, "xai"), payload);
	assert.deepEqual(addFastServiceTier(payload, true, "openai-codex"), {
		model: "gpt-5.6-sol",
		stream: true,
		service_tier: "priority",
	});
	assert.deepEqual(addFastServiceTier({ ...payload, service_tier: "default" }, true, "openai-codex"), {
		...payload,
		service_tier: "priority",
	});
});

test("Fast state restores the latest valid session entry", () => {
	assert.equal(fastStateFromEntries([]), false);
	assert.equal(fastStateFromEntries([
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: true } },
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: "invalid" } },
	]), true);
	assert.equal(fastStateFromEntries([
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: true } },
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: false } },
	]), false);
});

test("/sn-fast toggles, persists, reports status, and rewrites the final provider payload", async () => {
	const handlers = new Map<string, (event: { payload?: unknown }, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const entries: unknown[] = [];
	const notices: string[] = [];
	const statuses: Array<string | undefined> = [];
	const model = { provider: "openai-codex", id: "gpt-5.6-sol" };
	const ctx = {
		model,
		sessionManager: { getBranch: () => entries },
		ui: {
			notify(message: string) { notices.push(message); },
			setStatus(_key: string, value: string | undefined) { statuses.push(value); },
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: (event: { payload?: unknown }, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
		registerCommand(_name: string, value: { handler: (args: string, context: ExtensionContext) => Promise<void> }) { command = value.handler; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	fastExtension(pi);

	handlers.get("session_start")?.({}, ctx);
	assert.deepEqual(handlers.get("before_provider_request")?.({ payload: { model: model.id } }, ctx), { model: model.id });
	await command?.("on", ctx);
	assert.deepEqual(handlers.get("before_provider_request")?.({ payload: { model: model.id } }, ctx), {
		model: model.id,
		service_tier: "priority",
	});
	await command?.("status", ctx);
	await command?.("off", ctx);
	assert.deepEqual(handlers.get("before_provider_request")?.({ payload: { model: model.id } }, ctx), { model: model.id });
	assert.deepEqual(entries, [
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: true } },
		{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: false } },
	]);
	assert.match(notices.join("\n"), /enabled/);
	assert.match(notices.join("\n"), /Fast mode is on/);
	assert.match(notices.join("\n"), /disabled/);
	assert.ok(statuses.includes("fast"));
});

test("/sn-fast refuses activation outside OpenAI Codex", async () => {
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const entries: unknown[] = [];
	const notices: string[] = [];
	const pi = {
		on() {},
		registerCommand(_name: string, value: { handler: (args: string, context: ExtensionContext) => Promise<void> }) { command = value.handler; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
	} as unknown as ExtensionAPI;
	fastExtension(pi);
	await command?.("on", {
		model: { provider: "xai", id: "grok" },
		ui: { notify(message: string) { notices.push(message); }, setStatus() {} },
	} as unknown as ExtensionContext);
	assert.deepEqual(entries, []);
	assert.match(notices.join("\n"), /only be enabled/);
});
