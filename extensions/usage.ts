// Usage runtime selectively adapted from @specode/pi-subscription-usage@1.0.2 (MIT).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	USAGE_CACHE_TTL_MS,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_STATUS_EVENT,
	USAGE_STATUS_KEY,
	UsageCache,
	formatUsageReport,
	formatUsageStatus,
	queryUsage,
	redactUsageError,
	resolveUsageAuth,
	usageProviderForModel,
	buildUsageStatusEvent,
	type UsageDisplayMode,
	type UsageModel,
	type UsageState,
} from "../src/usage.ts";

interface UsageConfig {
	displayMode: UsageDisplayMode;
	refreshMs: number;
}

function configFrom(path: string): Partial<UsageConfig> {
	try {
		const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const sinan = root.piSinan && typeof root.piSinan === "object" && !Array.isArray(root.piSinan) ? root.piSinan as Record<string, unknown> : undefined;
		const usage = sinan?.usage && typeof sinan.usage === "object" && !Array.isArray(sinan.usage) ? sinan.usage as Record<string, unknown> : undefined;
		return {
			...(usage?.displayMode === "used" || usage?.displayMode === "remaining" ? { displayMode: usage.displayMode } : {}),
			...(typeof usage?.refreshMs === "number" && Number.isFinite(usage.refreshMs) && usage.refreshMs >= 30_000 ? { refreshMs: usage.refreshMs } : {}),
		};
	} catch { return {}; }
}

function readConfig(ctx: ExtensionContext): UsageConfig {
	const global = configFrom(join(getAgentDir(), "settings.json"));
	const project = ctx.isProjectTrusted() ? configFrom(join(ctx.cwd, ".pi", "settings.json")) : {};
	return { displayMode: project.displayMode ?? global.displayMode ?? "remaining", refreshMs: project.refreshMs ?? global.refreshMs ?? USAGE_CACHE_TTL_MS };
}

function errorMessage(error: unknown): string {
	return redactUsageError(error instanceof Error ? error.message : String(error));
}

export default function usageExtension(pi: ExtensionAPI): void {
	const cache = new UsageCache();
	const failures = new Map<string, { until: number; message: string }>();
	const controllers = new Set<AbortController>();
	let active = false;
	let generation = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let statusController: AbortController | undefined;
	let config: UsageConfig = { displayMode: "remaining", refreshMs: USAGE_CACHE_TTL_MS };

	const emitUnavailable = () => pi.events.emit(USAGE_STATUS_EVENT, { v: 1, status: "unavailable" });
	const clearTimer = () => { if (timer) clearTimeout(timer); timer = undefined; };
	const clearStatus = (ctx: ExtensionContext) => {
		generation += 1;
		statusController?.abort();
		statusController = undefined;
		clearTimer();
		ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
		emitUnavailable();
	};
	const schedule = (ctx: ExtensionContext, model: UsageModel) => {
		clearTimer();
		const expected = generation;
		timer = setTimeout(() => {
			timer = undefined;
			if (active && expected === generation) void refresh(ctx, model, true);
		}, config.refreshMs);
		timer.unref?.();
	};
	const publish = (ctx: ExtensionContext, state: UsageState, model: UsageModel, repeat: boolean) => {
		if (state.status === "ready") {
			ctx.ui.setStatus(USAGE_STATUS_KEY, formatUsageStatus(state.report, config.displayMode, model));
			pi.events.emit(USAGE_STATUS_EVENT, buildUsageStatusEvent(state.report, config.displayMode, model));
		} else if (state.status === "unsupported") {
			ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
			emitUnavailable();
			return;
		} else {
			ctx.ui.setStatus(USAGE_STATUS_KEY, state.status === "auth-unavailable" ? "usage auth ?" : "usage error");
			emitUnavailable();
		}
		if (repeat && active) schedule(ctx, model);
	};

	async function loadState(ctx: ExtensionContext, model: UsageModel | undefined, force: boolean, signal: AbortSignal): Promise<UsageState> {
		const providerId = usageProviderForModel(model);
		if (!providerId) return { status: "unsupported", providerId: model?.provider ?? "none", message: "Only OpenAI Codex and xAI/Grok are supported." };
		try {
			const auth = await resolveUsageAuth(ctx, providerId, undefined, model);
			if (!auth) return { status: "auth-unavailable", providerId, message: `No Pi OAuth credential is available for ${providerId}.` };
			const cached = force ? undefined : cache.get(providerId, auth.fingerprint);
			if (cached) return { status: "ready", report: cached };
			const key = `${providerId}:${auth.fingerprint}`;
			const failure = failures.get(key);
			if (!force && failure && failure.until > Date.now()) return { status: "query-failed", providerId, message: failure.message };
			failures.delete(key);
			try {
				const report = await queryUsage(auth, signal);
				cache.set(providerId, auth.fingerprint, report);
				return { status: "ready", report };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				const message = redactUsageError(errorMessage(error), auth.secrets);
				failures.set(key, { until: Date.now() + USAGE_FAILURE_BACKOFF_MS, message });
				return { status: "query-failed", providerId, message };
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") throw error;
			// Authentication resolvers are provider-owned and may include request details.
			// Fail closed with a fixed message before anything reaches status/session UI.
			return { status: "auth-unavailable", providerId, message: "Pi OAuth authentication could not be resolved safely." };
		}
	}

	async function refresh(ctx: ExtensionContext, model: UsageModel | undefined, force: boolean): Promise<void> {
		if (!model || !usageProviderForModel(model)) { clearStatus(ctx); return; }
		generation += 1;
		const expected = generation;
		statusController?.abort();
		const controller = new AbortController();
		statusController = controller;
		controllers.add(controller);
		try {
			ctx.ui.setStatus(USAGE_STATUS_KEY, "usage …");
			const state = await loadState(ctx, model, force, controller.signal);
			if (!active || controller.signal.aborted || generation !== expected || ctx.model?.provider !== model.provider || ctx.model?.id !== model.id) return;
			publish(ctx, state, model, true);
		} catch (error) {
			if (!controller.signal.aborted && active) {
				ctx.ui.setStatus(USAGE_STATUS_KEY, "usage error");
				emitUnavailable();
				schedule(ctx, model);
			}
		} finally {
			controllers.delete(controller);
			if (statusController === controller) statusController = undefined;
		}
	}

	pi.registerCommand("usage", {
		description: "Show subscription usage for the current OpenAI Codex or xAI/Grok provider",
		handler: async (args, ctx) => {
			if (args.trim()) { ctx.ui.notify("/usage takes no arguments.", "warning"); return; }
			const controller = new AbortController();
			controllers.add(controller);
			const model = ctx.model;
			const expectedGeneration = generation;
			try {
				const state = await loadState(ctx, model, true, controller.signal);
				const unchanged = generation === expectedGeneration
					&& ctx.model?.provider === model?.provider
					&& ctx.model?.id === model?.id;
				if (!unchanged) {
					ctx.ui.notify("Usage result was discarded because the selected model changed during the query.", "warning");
					return;
				}
				ctx.ui.notify(formatUsageReport(state, config.displayMode), "info");
				if (model) publish(ctx, state, model, active);
			} catch (error) {
				if (!(error instanceof Error && error.name === "AbortError")) ctx.ui.notify(`Usage query failed: ${errorMessage(error)}`, "error");
			} finally {
				controller.abort();
				controllers.delete(controller);
			}
		},
	});

	pi.on("session_start", (_event, ctx) => {
		active = ctx.hasUI;
		config = readConfig(ctx);
		if (active) void refresh(ctx, ctx.model, false);
	});
	pi.on("session_tree", (_event, ctx) => { if (ctx.hasUI) void refresh(ctx, ctx.model, false); });
	pi.on("model_select", (event, ctx) => { if (ctx.hasUI) { emitUnavailable(); void refresh(ctx, event.model, false); } });
	pi.on("agent_settled", (_event, ctx) => { if (ctx.hasUI) void refresh(ctx, ctx.model, false); });
	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		generation += 1;
		clearTimer();
		for (const controller of controllers) controller.abort();
		controllers.clear();
		statusController = undefined;
		cache.clear();
		failures.clear();
		ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
		emitUnavailable();
	});
}
