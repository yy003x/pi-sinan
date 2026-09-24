import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkFastAvailability, type FastAvailability } from "../src/fast-catalog.ts";
import { FAST_STATE_ENTRY, FAST_STATUS_KEY, addFastServiceTier, fastStateFromEntries } from "../src/fast.ts";

export const FAST_STATUS_EVENT = "pi-sinan/fast-status/v1";
export default function fastExtension(pi: ExtensionAPI, check: typeof checkFastAvailability = checkFastAvailability): void {
	let enabled = false;
	let availability: FastAvailability = { status: "unavailable", reason: "Not checked." };
	let modelKey = "";
	let generation = 0;
	const key = (ctx: ExtensionContext) => `${ctx.model?.provider ?? ""}/${ctx.model?.id ?? ""}`;
	const publish = (ctx: ExtensionContext) => {
		const active = enabled && availability.status === "supported" && modelKey === key(ctx);
		ctx.ui.setStatus(FAST_STATUS_KEY, active ? "fast requested" : undefined);
		pi.events.emit(FAST_STATUS_EVENT, { v: 1, enabled, availability: modelKey === key(ctx) ? availability.status : "unavailable", model: key(ctx), requestingPriority: active && ctx.model?.provider === "openai-codex", requestingFast: active && ctx.model?.provider === "xai" });
	};
	const validate = async (ctx: ExtensionContext) => {
		const current = ++generation;
		const selected = key(ctx);
		availability = { status: "unavailable", reason: "Checking Fast request eligibility." };
		modelKey = selected;
		publish(ctx);
		const result = await check(ctx);
		if (generation !== current || key(ctx) !== selected) return undefined;
		availability = result;
		publish(ctx);
		return result;
	};
	const restore = (ctx: ExtensionContext) => {
		enabled = fastStateFromEntries(ctx.sessionManager.getBranch());
		void validate(ctx);
	};
	pi.on("before_provider_request", async (event, ctx) => {
		if (!enabled || (ctx.model?.provider !== "openai-codex" && ctx.model?.provider !== "xai")) return event.payload;
		// 全局请求钩子可能收到与当前选中模型不同的请求，禁止向其他模型注入字段。
		if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload) ||
			(event.payload as { model?: unknown }).model !== ctx.model.id) return event.payload;
		// 每次请求重新校验账号和模型；Codex 额外要求官方目录中的 priority 元数据。
		const selected = key(ctx);
		const checked = await validate(ctx);
		if (selected !== key(ctx) || checked?.status !== "supported" || (ctx.model?.provider === "openai-codex" && !checked.fingerprint) || modelKey !== selected) return event.payload;
		return addFastServiceTier(event.payload, true, ctx.model.provider);
	});
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => { void validate(ctx); });
	pi.on("session_shutdown", (_event, ctx) => { generation++; ctx.ui.setStatus(FAST_STATUS_KEY, undefined); });
	pi.registerCommand("sn-fast", {
		description: "Toggle Codex priority or xAI Grok 4.7 fast requests: /sn-fast [status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "status") { ctx.ui.notify("Usage: /sn-fast [status]", "warning"); return; }
			if (action === "status") { await validate(ctx); ctx.ui.notify(`Fast ${enabled ? "on" : "off"}; ${availability.status}: ${availability.reason} A request does not confirm server routing.`, "info"); return; }
			const next = !enabled;
			if (next) {
				await validate(ctx);
				if (availability.status !== "supported") { ctx.ui.notify(`Fast unavailable: ${availability.reason}`, "warning"); return; }
			}
			const previous = enabled ? "on" : "off";
			enabled = next;
			pi.appendEntry(FAST_STATE_ENTRY, { enabled });
			publish(ctx);
			ctx.ui.notify(`${ctx.model?.provider === "xai" ? "Grok 4.7" : "OpenAI Codex"} Fast: ${previous} -> ${enabled ? "on" : "off"}; ${enabled ? "Fast may consume subscription credits faster; " : ""}server routing is not confirmed.`, "info");
		},
	});
}
