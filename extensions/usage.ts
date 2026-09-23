// Usage runtime selectively adapted from @specode/pi-subscription-usage@1.0.2 (MIT).
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	CODEX_RESET_CONFIRMATION_OPTIONS,
	codexResetCount,
	consumeCodexResetCredit as defaultConsumeCodexResetCredit,
	formatCodexResetOutcome,
	isCodexResetConfirmed,
	listCodexResetCredits as defaultListCodexResetCredits,
	resetOptionExpiration,
	resolveCodexResetAuth as defaultResolveCodexResetAuth,
	type CodexResetOption,
	type ResolvedCodexResetAuth,
} from "../src/codex-reset.ts";
import {
	USAGE_CACHE_TTL_MS,
	USAGE_FAILURE_BACKOFF_MS,
	USAGE_STATUS_EVENT,
	USAGE_STATUS_KEY,
	UsageCache,
	UsageAlerts,
	formatUsageReport,
	formatUsageStatus,
	queryUsage,
	redactUsageError,
	resolveUsageAuth,
	usageProviderForModel,
	buildUsageStatusEvent,
	type ResolvedUsageAuth,
	type UsageDisplayMode,
	type UsageModel,
	type UsageReport,
	type UsageState,
} from "../src/usage.ts";

interface UsageConfig {
	displayMode: UsageDisplayMode;
	refreshMs: number;
	alerts: boolean;
	thresholds: number[];
}

function configFrom(path: string): Partial<UsageConfig> {
	try {
		const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const sinan = root.piSinan && typeof root.piSinan === "object" && !Array.isArray(root.piSinan) ? root.piSinan as Record<string, unknown> : undefined;
		const usage = sinan?.usage && typeof sinan.usage === "object" && !Array.isArray(sinan.usage) ? sinan.usage as Record<string, unknown> : undefined;
		const thresholds = usage?.alertThresholds;
		return {
			...(typeof usage?.alerts === "boolean" ? { alerts: usage.alerts } : {}),
			...(Array.isArray(thresholds) && thresholds.length > 0 && thresholds.every((value) => typeof value === "number" && value > 0 && value < 100) ? { thresholds: [...new Set(thresholds as number[])].sort((a, b) => b - a) } : {}),
			...(usage?.displayMode === "used" || usage?.displayMode === "remaining" ? { displayMode: usage.displayMode } : {}),
			...(typeof usage?.refreshMs === "number" && Number.isFinite(usage.refreshMs) && usage.refreshMs >= 30_000 ? { refreshMs: usage.refreshMs } : {}),
		};
	} catch { return {}; }
}

function readConfig(ctx: ExtensionContext): UsageConfig {
	const global = configFrom(join(getAgentDir(), "settings.json"));
	const project = ctx.isProjectTrusted() ? configFrom(join(ctx.cwd, ".pi", "settings.json")) : {};
	return { displayMode: project.displayMode ?? global.displayMode ?? "remaining", refreshMs: project.refreshMs ?? global.refreshMs ?? USAGE_CACHE_TTL_MS, alerts: project.alerts ?? global.alerts ?? false, thresholds: project.thresholds ?? global.thresholds ?? [20, 10, 5] };
}

function errorMessage(error: unknown): string {
	return redactUsageError(error instanceof Error ? error.message : String(error));
}

export interface UsageExtensionDependencies {
	queryUsage(auth: ResolvedUsageAuth, signal: AbortSignal): Promise<UsageReport>;
	resolveCodexResetAuth(ctx: ExtensionContext): Promise<ResolvedCodexResetAuth>;
	listCodexResetCredits(auth: ResolvedCodexResetAuth, signal: AbortSignal): Promise<{ availableCount: number; options: CodexResetOption[] }>;
	consumeCodexResetCredit(
		auth: ResolvedCodexResetAuth,
		option: CodexResetOption,
		requestId: string,
		signal: AbortSignal,
	): Promise<{ code: "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed"; windowsReset: number }>;
	createResetRequestId(): string;
}

const DEFAULT_DEPENDENCIES: UsageExtensionDependencies = {
	queryUsage,
	resolveCodexResetAuth: defaultResolveCodexResetAuth,
	listCodexResetCredits: defaultListCodexResetCredits,
	consumeCodexResetCredit: defaultConsumeCodexResetCredit,
	createResetRequestId: randomUUID,
};

export default function usageExtension(
	pi: ExtensionAPI,
	dependencies: UsageExtensionDependencies = DEFAULT_DEPENDENCIES,
): void {
	const cache = new UsageCache();
	const alerts = new UsageAlerts();
	const failures = new Map<string, { until: number; message: string }>();
	const controllers = new Set<AbortController>();
	let active = false;
	let generation = 0;
	let dataGeneration = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let statusController: AbortController | undefined;
	let resetInProgress = false;
	let config: UsageConfig = { displayMode: "remaining", refreshMs: USAGE_CACHE_TTL_MS, alerts: false, thresholds: [20, 10, 5] };

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
		const expectedDataGeneration = dataGeneration;
		const expectedGeneration = generation;
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
				const report = await dependencies.queryUsage(auth, signal);
				if (dataGeneration === expectedDataGeneration && !signal.aborted) {
					cache.set(providerId, auth.fingerprint, report);
					if (generation === expectedGeneration) {
						const warnings = alerts.check(`${providerId}:${auth.fingerprint}`, report, config.thresholds);
						if (config.alerts && ctx.hasUI) for (const warning of warnings) ctx.ui.notify(warning, "warning");
					}
				}
				return { status: "ready", report };
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				const message = redactUsageError(errorMessage(error), auth.secrets);
				if (dataGeneration === expectedDataGeneration) {
					failures.set(key, { until: Date.now() + USAGE_FAILURE_BACKOFF_MS, message });
				}
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

	async function redeemCodexReset(
		ctx: ExtensionCommandContext,
		model: UsageModel,
		state: Extract<UsageState, { status: "ready" }>,
		controller: AbortController,
	): Promise<void> {
		const summaryCount = codexResetCount(state.report);
		if (model.provider !== "openai-codex" || summaryCount <= 0) return;
		const expectedModel = `${model.provider}/${model.id}`;
		if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) {
			throw new Error("Codex model changed; reset not redeemed.");
		}

		let auth = await dependencies.resolveCodexResetAuth(ctx);
		const availability = await dependencies.listCodexResetCredits(auth, controller.signal);
		if (availability.availableCount <= 0 || availability.options.length === 0) {
			ctx.ui.notify("No verified Codex reset credits are available.", "info");
			return;
		}

		const labels = availability.options.map((option: CodexResetOption, index: number) =>
			`${index + 1}. ${option.title} · ${resetOptionExpiration(option)}`,
		);
		const selected = await ctx.ui.select("Choose a Codex reset", labels);
		if (!selected) return;
		const option = availability.options[labels.indexOf(selected)];
		if (!option) return;
		const confirmation = await ctx.ui.select(
			`Redeem one Codex reset?\n${option.title}\n${option.description}\n${resetOptionExpiration(option)}`,
			[...CODEX_RESET_CONFIRMATION_OPTIONS],
		);
		if (!isCodexResetConfirmed(confirmation)) return;

		const expectedFingerprint = auth.fingerprint;
		const requestId = dependencies.createResetRequestId();
		while (!controller.signal.aborted) {
			auth = await dependencies.resolveCodexResetAuth(ctx);
			if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel || auth.fingerprint !== expectedFingerprint) {
				throw new Error("Codex model or account changed; reset not redeemed.");
			}
			let outcome;
			try {
				outcome = await dependencies.consumeCodexResetCredit(auth, option, requestId, controller.signal);
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") throw error;
				const retryAction = "Retry with same request ID";
				const retry = await ctx.ui.select("Reset result uncertain", [retryAction, "Cancel"]);
				if (retry !== retryAction) {
					ctx.ui.notify(`Reset not confirmed: ${errorMessage(error)}`, "warning");
					return;
				}
				continue;
			}

			dataGeneration += 1;
			generation += 1;
			const refreshGeneration = generation;
			statusController?.abort();
			clearTimer();
			cache.clearProvider("openai-codex");
			failures.clear();
			let refreshed: UsageState | undefined;
			try {
				refreshed = await loadState(ctx, model, true, controller.signal);
			} catch (error) {
				ctx.ui.notify(formatCodexResetOutcome(outcome), "info");
				if (!(error instanceof Error && error.name === "AbortError")) {
					ctx.ui.notify(`Usage refresh failed after reset: ${errorMessage(error)}`, "warning");
				}
				return;
			}
			const unchanged = generation === refreshGeneration
				&& `${ctx.model?.provider}/${ctx.model?.id}` === expectedModel
				&& !controller.signal.aborted;
			if (unchanged) publish(ctx, refreshed, model, active);
			const remaining = unchanged && refreshed.status === "ready" ? codexResetCount(refreshed.report) : undefined;
			ctx.ui.notify(formatCodexResetOutcome(outcome, remaining), "info");
			if (unchanged && refreshed.status === "ready") {
				ctx.ui.notify(formatUsageReport(refreshed, config.displayMode), "info");
			} else if (!controller.signal.aborted && ctx.hasUI) {
				ctx.ui.notify("Usage refresh was discarded because the selected model changed after reset.", "warning");
				void refresh(ctx, ctx.model, false);
			}
			return;
		}
	}

	pi.registerCommand("sn-usage", {
		description: "Show current/all OAuth subscription usage or toggle threshold alerts",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action === "alerts") {
				const previous = config.alerts ? "on" : "off";
				config.alerts = !config.alerts;
				ctx.ui.notify(`Usage threshold alerts: ${previous} -> ${config.alerts ? "on" : "off"} for this session.`, "info");
				return;
			}
			if (action === "all") {
				const controller = new AbortController();
				controllers.add(controller);
				try {
					const results: string[] = [];
					for (const providerId of ["xai", "openai-codex"] as const) {
						const models = ctx.modelRegistry.getAll().filter((candidate) => candidate.provider === providerId);
						let model: UsageModel | undefined;
						for (const candidate of models) {
							try {
								if (await resolveUsageAuth(ctx, providerId, undefined, candidate)) { model = candidate; break; }
							} catch { /* Skip ineligible or failed OAuth credentials. */ }
						}
						if (!model) continue;
						results.push(formatUsageReport(await loadState(ctx, model, true, controller.signal), config.displayMode));
					}
					ctx.ui.notify(results.join("\n\n") || "No eligible signed-in xAI or OpenAI Codex OAuth model is available.", "info");
				} catch { ctx.ui.notify("Usage catalog could not be inspected safely.", "warning"); }
				finally { controller.abort(); controllers.delete(controller); }
				return;
			}
			if (action) { ctx.ui.notify("Usage: /sn-usage [all|alerts]", "warning"); return; }
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
				const resetCount = state.status === "ready" ? codexResetCount(state.report) : 0;
				if (ctx.hasUI && model?.provider === "openai-codex" && state.status === "ready" && resetCount > 0) {
					const action = await ctx.ui.select(`Reset credits: ${resetCount} available`, ["Redeem 1 Reset"]);
					if (action) {
						if (resetInProgress) {
							ctx.ui.notify("A Codex reset redemption is already in progress.", "warning");
						} else {
							resetInProgress = true;
							try { await redeemCodexReset(ctx, model, state, controller); }
							finally { resetInProgress = false; }
						}
					}
				}
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
		dataGeneration += 1;
		clearTimer();
		for (const controller of controllers) controller.abort();
		controllers.clear();
		statusController = undefined;
		resetInProgress = false;
		cache.clear();
		alerts.clear();
		failures.clear();
		ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
		emitUnavailable();
	});
}
