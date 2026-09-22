import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	FAST_STATE_ENTRY,
	FAST_STATUS_KEY,
	addFastServiceTier,
	fastStateFromEntries,
} from "../src/fast.ts";

export default function fastExtension(pi: ExtensionAPI): void {
	let enabled = false;

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(FAST_STATUS_KEY, enabled && ctx.model?.provider === "openai-codex" ? "fast" : undefined);
	};
	const restore = (ctx: ExtensionContext) => {
		enabled = fastStateFromEntries(ctx.sessionManager.getBranch());
		updateStatus(ctx);
	};

	pi.on("before_provider_request", (event, ctx) => addFastServiceTier(event.payload, enabled, ctx.model?.provider));
	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(FAST_STATUS_KEY, undefined));

	pi.registerCommand("sn-fast", {
		description: "Toggle OpenAI Codex Fast requests: /sn-fast [on|off|status]",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action !== "" && action !== "on" && action !== "off" && action !== "status") {
				ctx.ui.notify("Usage: /sn-fast [on|off|status]", "warning");
				return;
			}
			if (action === "status") {
				const scope = ctx.model?.provider === "openai-codex" ? "the current OpenAI Codex model" : "OpenAI Codex requests";
				ctx.ui.notify(`Fast mode is ${enabled ? "on" : "off"} for ${scope}.`, "info");
				return;
			}
			const next = action === "on" || (action === "" && !enabled);
			if (next && ctx.model?.provider !== "openai-codex") {
				ctx.ui.notify("Fast mode can only be enabled while an OpenAI Codex model is selected.", "warning");
				return;
			}
			enabled = next;
			pi.appendEntry(FAST_STATE_ENTRY, { enabled });
			updateStatus(ctx);
			ctx.ui.notify(`OpenAI Codex Fast mode ${enabled ? "enabled" : "disabled"}.`, "info");
		},
	});
}
