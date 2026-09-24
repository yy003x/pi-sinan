import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { checkFastAvailability } from "../src/fast-catalog.ts";
import { openAICodexImageGenerationUrl, xaiImageGenerationUrl } from "../src/image-provider.ts";
import { searchEndpoint } from "../src/subscription-search.ts";
import { resolveUsageAuth, usageEndpoint, type UsageProviderId } from "../src/usage.ts";
import { codexRecoveryDiagnostic, safeRecoveryStatusText } from "./codex-recovery.ts";

export default function doctorExtension(pi: ExtensionAPI, fastCheck: typeof checkFastAvailability = checkFastAvailability): void {
	pi.registerCommand("sn-doctor", {
		description: "Read-only official OAuth/model/endpoint diagnostics: /sn-doctor [all]",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode && mode !== "all") { ctx.ui.notify("Usage: /sn-doctor [all]", "warning"); return; }
			const providerIds: UsageProviderId[] = mode === "all" ? ["xai", "openai-codex"] : ctx.model?.provider === "xai" || ctx.model?.provider === "openai-codex" ? [ctx.model.provider] : [];
			if (!providerIds.length) { ctx.ui.notify("Select xAI or OpenAI Codex, or use /sn-doctor all.", "warning"); return; }
			const lines: string[] = [];
			for (const providerId of providerIds) {
				const candidates = mode === "all" ? ctx.modelRegistry.getAll().filter((candidate) => candidate.provider === providerId) : [ctx.model];
				let model = candidates[0];
				let oauth = false;
				for (const candidate of candidates) {
					if (!candidate || candidate.provider !== providerId) continue;
					try {
						if (await resolveUsageAuth(ctx, providerId, undefined, candidate)) { model = candidate; oauth = true; break; }
					} catch { /* Credential details must never be displayed. */ }
				}
				if (!model || model.provider !== providerId) { lines.push(`${providerId}: no OAuth model in catalog`); continue; }
				let image = false;
				let search = false;
				let credentialBase: string | undefined;
				if (oauth) { try { credentialBase = (await ctx.modelRegistry.getProviderAuth(providerId))?.auth.baseUrl; } catch { /* No secret reaches UI. */ } }
				try {
					if (providerId === "xai") { xaiImageGenerationUrl(model.baseUrl); xaiImageGenerationUrl(credentialBase); }
					else { openAICodexImageGenerationUrl(model.baseUrl); openAICodexImageGenerationUrl(credentialBase); }
					image = oauth;
				} catch { /* Invalid origin. */ }
				try {
					searchEndpoint(providerId === "xai" ? "xai" : "openai", model.baseUrl);
					if (credentialBase) searchEndpoint(providerId === "xai" ? "xai" : "openai", credentialBase);
					search = oauth;
				} catch { /* Invalid origin. */ }
				lines.push(`${providerId}/${model.id}: OAuth ${oauth ? "available" : "unavailable"}; image ${image ? "eligible" : "unavailable"}; search ${search ? "eligible" : "unavailable"}; usage ${oauth ? `eligible (${usageEndpoint(providerId)})` : "unavailable"}. Eligibility is not entitlement; no paid POST was sent.`);
				if (providerId === "openai-codex") {
					const status = oauth ? await fastCheck({ ...ctx, model } as ExtensionContext) : { status: "unavailable", reason: "Official OAuth unavailable." };
					const recovery = codexRecoveryDiagnostic(ctx.sessionManager.getSessionId());
					lines.push(`Fast: ${status.status} (${status.reason}); recovery: ${recovery ? safeRecoveryStatusText(recovery) : "adapter unavailable"}`);
				} else {
					const status = oauth ? await fastCheck({ ...ctx, model } as ExtensionContext) : { status: "unavailable", reason: "Official OAuth unavailable." };
					lines.push(`Fast: ${status.status} (${status.reason}); recovery: no xAI transport adapter`);
				}
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
