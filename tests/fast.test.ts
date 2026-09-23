import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fastExtension from "../extensions/fast.ts";
import { catalogSupportsFast } from "../src/fast-catalog.ts";
import { FAST_STATE_ENTRY, addFastServiceTier, fastStateFromEntries } from "../src/fast.ts";

test("exact official catalog slug and service_tiers priority determine Fast support", () => {
	assert.equal(catalogSupportsFast({ models: [{ slug: "m", service_tiers: [{ id: "priority" }] }] }, "m"), true);
	assert.equal(catalogSupportsFast({ models: [{ slug: "m", service_tiers: [{ id: "flex" }] }] }, "m"), false);
	assert.equal(catalogSupportsFast({ models: [{ slug: "m-fast", service_tiers: [{ id: "priority" }] }] }, "m"), undefined);
	assert.equal(catalogSupportsFast({ models: [{ slug: "m", additional_speed_tiers: ["fast"] }] }, "m"), undefined);
	assert.equal(catalogSupportsFast({ models: [{ slug: "m", service_tiers: "priority" }] }, "m"), undefined);
});

test("Fast payload injection requires enabled official Codex model", () => {
	const payload = { model: "m" };
	assert.equal(addFastServiceTier(payload, false, "openai-codex"), payload);
	assert.equal(addFastServiceTier(payload, true, "xai"), payload);
	assert.deepEqual(addFastServiceTier(payload, true, "openai-codex"), { model: "m", service_tier: "priority" });
});

test("Fast state restores latest valid branch entry", () => {
	assert.equal(fastStateFromEntries([]), false);
	assert.equal(fastStateFromEntries([{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: true } }]), true);
});

test("/sn-fast gates on metadata, rechecks request, preserves session toggle and emits structured status", async () => {
	const handlers = new Map<string, (event: { payload?: unknown }, ctx: ExtensionContext) => unknown>();
	let command: ((args: string, ctx: ExtensionContext) => Promise<void>) | undefined;
	const entries: unknown[] = [];
	const notices: string[] = [];
	const events: unknown[] = [];
	let available = true;
	const model = { provider: "openai-codex", id: "m" };
	const ctx = { model, sessionManager: { getBranch: () => entries }, ui: { notify(message: string) { notices.push(message); }, setStatus() {} } } as unknown as ExtensionContext;
	const pi = {
		on(event: string, handler: (event: { payload?: unknown }, context: ExtensionContext) => unknown) { handlers.set(event, handler); },
		registerCommand(_name: string, value: { handler: (args: string, context: ExtensionContext) => Promise<void> }) { command = value.handler; },
		appendEntry(customType: string, data: unknown) { entries.push({ type: "custom", customType, data }); },
		events: { emit(_name: string, data: unknown) { events.push(data); } },
	} as unknown as ExtensionAPI;
	fastExtension(pi, async () => ({ status: available ? "supported" : "unavailable", reason: "test", ...(available ? { fingerprint: "account-fingerprint" } : {}) }));
	handlers.get("session_start")?.({}, ctx);
	await command?.("", ctx);
	assert.match(notices.at(-1) ?? "", /off -> on/);
	assert.deepEqual(await handlers.get("before_provider_request")?.({ payload: { model: "m" } }, ctx), { model: "m", service_tier: "priority" });
	assert.deepEqual(await handlers.get("before_provider_request")?.({ payload: { model: "other" } }, ctx), { model: "other" });
	available = false;
	assert.deepEqual(await handlers.get("before_provider_request")?.({ payload: { model: "m" } }, ctx), { model: "m" });
	await command?.("status", ctx);
	assert.match(notices.join("\n"), /unavailable/);
	assert.ok(events.some((entry) => (entry as { requestingPriority?: boolean }).requestingPriority));
	await command?.("", ctx);
	assert.match(notices.at(-1) ?? "", /on -> off/);
	assert.deepEqual(entries, [{ type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: true } }, { type: "custom", customType: FAST_STATE_ENTRY, data: { enabled: false } }]);
	await command?.("on", ctx);
	assert.match(notices.at(-1) ?? "", /Usage: \/sn-fast \[status\]/);
	assert.equal(entries.length, 2, "obsolete on/off arguments must not change the state");
	await command?.("", ctx);
	assert.match(notices.at(-1) ?? "", /Fast unavailable/);
	assert.equal(entries.length, 2, "unsupported models must not turn Fast on");
});
