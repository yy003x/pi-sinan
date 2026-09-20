import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatSearchResult,
	parseSearchCommand,
	pickSearchModel,
	runSubscriptionSearch,
	type SearchAuth,
	type SearchProviderId,
} from "../src/subscription-search.ts";

const MESSAGE_TYPE = "pi-sinan-search";
const STATUS_KEY = "pi-sinan-search";

function searchAuthFailure(provider: SearchProviderId): Error {
	const name = provider === "xai" ? "xAI" : "OpenAI Codex";
	return new Error(`${name} subscription authentication could not be resolved safely. Run /login and choose ${name}.`);
}

export async function resolveSearchAuth(ctx: ExtensionContext, provider: SearchProviderId): Promise<SearchAuth> {
	try {
		const models = (ctx.scopedModels.length > 0
			? ctx.scopedModels.map(({ model }) => model)
			: ctx.modelRegistry.getAll()) as Model<Api>[];
		const model = pickSearchModel(provider, models);
		if (!model) {
			throw new Error(`${provider} search model is unavailable in the current Pi model catalog`);
		}
		if (!ctx.modelRegistry.isUsingOAuth(model)) throw searchAuthFailure(provider);
		const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!resolved.ok || !resolved.apiKey) throw searchAuthFailure(provider);
		return {
			provider,
			apiKey: resolved.apiKey,
			model: model.id,
			baseUrl: resolved.baseUrl ?? model.baseUrl,
			headers: resolved.headers,
		};
	} catch {
		// Authentication resolvers are provider-owned and may expose credentials.
		throw searchAuthFailure(provider);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("sn-search", {
		description: "Search the web with an xAI or OpenAI subscription: /sn-search <query> [--provider xai|openai] (default xai)",
		handler: async (args, ctx) => {
			let request;
			try {
				request = parseSearchCommand(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "warning");
				return;
			}

			ctx.ui.setStatus(STATUS_KEY, `searching with ${request.provider}…`);
			try {
				const auth = await resolveSearchAuth(ctx, request.provider);
				const result = await runSubscriptionSearch(request.query, auth, { signal: ctx.signal });
				pi.sendMessage({
					customType: MESSAGE_TYPE,
					content: formatSearchResult(result),
					display: true,
					details: result,
				});
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			} finally {
				ctx.ui.setStatus(STATUS_KEY, undefined);
			}
		},
	});
}
