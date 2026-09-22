// Selectively adapted from @specode/pi-subscription-usage@1.0.2,
// @narumitw/pi-usage@0.53.0, and pi-grok-usage@1.0.4 (MIT).
import { createHmac, randomBytes } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type UsageProviderId = "openai-codex" | "xai";
export type UsageDisplayMode = "remaining" | "used";

export interface UsageModel {
	provider: string;
	id: string;
	name?: string;
	baseUrl?: string;
}

export interface UsageBucket {
	id: string;
	label: string;
	used: number;
	remaining: number;
	limit: 100;
	unit: "percent";
	period?: "weekly" | "monthly";
	windowMinutes?: number;
	resetsAt?: number;
	groupId?: string;
	groupLabel?: string;
	modelKeys?: string[];
}

export interface UsageReport {
	providerId: UsageProviderId;
	providerName: string;
	capturedAt: number;
	source: "codex-pi-oauth" | "grok-pi-oauth";
	buckets: UsageBucket[];
	defaultGroupId?: string;
	resetCreditsAvailable?: number;
}

export type UsageState =
	| { status: "ready"; report: UsageReport }
	| { status: "unsupported" | "auth-unavailable" | "query-failed"; providerId: string; message: string };

export interface ResolvedUsageAuth {
	providerId: UsageProviderId;
	headers: Record<string, string> & { Authorization: string };
	fingerprint: string;
	secrets: string[];
}

export interface UsageStatusWindow {
	label: string;
	remainingPercent: number;
	usedPercent: number;
	displayPercent: number;
	windowMinutes?: number;
	resetsAt?: number;
	groupId?: string;
	groupLabel?: string;
}

export type UsageStatusEvent =
	| { v: 1; status: "ready"; providerId: UsageProviderId; capturedAt: number; displayMode: UsageDisplayMode; windows: UsageStatusWindow[] }
	| { v: 1; status: "unavailable" };

export const USAGE_STATUS_KEY = "pi-sinan-usage";
export const USAGE_STATUS_EVENT = "pi-sinan/usage-status/v1";
export const USAGE_CACHE_TTL_MS = 5 * 60_000;
export const USAGE_FAILURE_BACKOFF_MS = 30_000;
export const USAGE_QUERY_TIMEOUT_MS = 15_000;

const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const GROK_USER_URL = "https://cli-chat-proxy.grok.com/v1/user";
const GROK_CREDITS_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const GROK_MONTHLY_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const MAX_SUCCESS_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const AUTH_SALT = randomBytes(32);

const PROVIDER_INFO = {
	"openai-codex": { name: "OpenAI Codex", origins: ["https://chatgpt.com"] },
	xai: { name: "Grok", origins: ["https://api.x.ai", "https://cli-chat-proxy.grok.com"] },
} as const;

export class UsageCache {
	private readonly entries = new Map<string, { createdAt: number; report: UsageReport }>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;
	constructor(ttlMs = USAGE_CACHE_TTL_MS, maxEntries = 16) {
		if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error("Cache TTL must be positive.");
		if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error("Cache entry limit must be positive.");
		this.ttlMs = ttlMs;
		this.maxEntries = maxEntries;
	}
	get(providerId: UsageProviderId, fingerprint: string, now = Date.now()): UsageReport | undefined {
		this.sweep(now);
		return this.entries.get(`${providerId}:${fingerprint}`)?.report;
	}
	set(providerId: UsageProviderId, fingerprint: string, report: UsageReport, now = Date.now()): void {
		this.sweep(now);
		const key = `${providerId}:${fingerprint}`;
		this.entries.delete(key);
		while (this.entries.size >= this.maxEntries) {
			const first = this.entries.keys().next().value;
			if (first === undefined) break;
			this.entries.delete(first);
		}
		this.entries.set(key, { createdAt: now, report });
	}
	clearProvider(providerId: UsageProviderId): void {
		for (const key of this.entries.keys()) if (key.startsWith(`${providerId}:`)) this.entries.delete(key);
	}
	clear(): void { this.entries.clear(); }
	private sweep(now: number): void {
		for (const [key, entry] of this.entries) if (now - entry.createdAt >= this.ttlMs) this.entries.delete(key);
	}
}

export function fingerprintUsageAuth(headers: Record<string, string>, salt: Uint8Array = AUTH_SALT): string {
	return createHmac("sha256", salt).update(JSON.stringify(Object.entries(headers).sort())).digest("hex");
}

export function sanitizeUsageText(value: string, max = 600): string {
	const clean = value.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu, "")
		.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ").replace(/\s+/gu, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, Math.max(0, max - 1))}…`;
}

export function redactUsageError(value: string, secrets: readonly string[] = []): string {
	let result = value;
	for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) {
		result = result.replaceAll(secret, "<redacted>");
	}
	result = result.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <redacted>")
		.replace(/"(?:access_token|refresh_token|api_key)"\s*:\s*"[^"]+"/giu, (match) => `${match.slice(0, match.indexOf(":") + 1)}"<redacted>"`);
	return sanitizeUsageText(result);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function number(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}
function nonnegativeInteger(value: unknown): number | undefined {
	const parsed = number(value);
	return parsed !== undefined && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
function timestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || value.length > 64) return undefined;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : Math.floor(parsed / 1000);
}
function percentBucket(id: string, label: string, usedValue: number, windowMinutes?: number, resetsAt?: number, period?: "weekly" | "monthly"): UsageBucket {
	const used = Math.min(100, Math.max(0, usedValue));
	return { id, label, used, remaining: 100 - used, limit: 100, unit: "percent", ...(windowMinutes ? { windowMinutes } : {}), ...(resetsAt ? { resetsAt } : {}), ...(period ? { period } : {}) };
}

const CODEX_DEFAULT_GROUP_ID = "codex";

function codexGroup(
	buckets: UsageBucket[],
	groupId: string,
	groupLabel: string,
	raw: unknown,
	optional: boolean,
): void {
	if (raw === undefined || raw === null) return;
	const rateLimit = object(raw);
	if (!rateLimit) {
		if (optional) return;
		throw new Error("Codex rate limit was not an object.");
	}
	for (const [position, label, windowRaw] of [
		["primary", "Primary limit", rateLimit.primary_window],
		["secondary", "Secondary limit", rateLimit.secondary_window],
	] as const) {
		if (windowRaw === undefined || windowRaw === null) continue;
		const window = object(windowRaw);
		if (!window) throw new Error("Codex rate-limit window was not an object.");
		const used = number(window.used_percent);
		if (used === undefined) continue;
		const seconds = number(window.limit_window_seconds);
		buckets.push({
			...percentBucket(`${groupId}:${position}`, label, used, seconds && seconds > 0 ? Math.ceil(seconds / 60) : undefined, number(window.reset_at)),
			groupId,
			groupLabel,
			modelKeys: [groupId, groupLabel],
		});
	}
}

export function normalizeCodexUsage(payload: unknown, capturedAt = Date.now()): UsageReport {
	const root = object(payload);
	if (!root) throw new Error("Codex usage response was not an object.");
	const buckets: UsageBucket[] = [];
	codexGroup(buckets, CODEX_DEFAULT_GROUP_ID, "Shared Across Models", root.rate_limit, false);
	const additional = Array.isArray(root.additional_rate_limits) ? root.additional_rate_limits : [];
	for (const item of additional) {
		const entry = object(item);
		const rawId = typeof entry?.metered_feature === "string" ? entry.metered_feature : entry?.limit_name;
		if (!entry || typeof rawId !== "string") continue;
		const id = sanitizeUsageText(rawId, 160);
		if (!id) continue;
		const label = typeof entry.limit_name === "string" ? sanitizeUsageText(entry.limit_name, 160) || id : id;
		try { codexGroup(buckets, id, label, entry.rate_limit, true); } catch { /* Optional groups must not hide shared quota. */ }
	}
	if (buckets.length === 0) throw new Error("Codex usage endpoint returned no quota windows.");
	const resetCreditsAvailable = nonnegativeInteger(object(root.rate_limit_reset_credits)?.available_count);
	return {
		providerId: "openai-codex",
		providerName: "OpenAI Codex",
		capturedAt,
		source: "codex-pi-oauth",
		buckets,
		defaultGroupId: CODEX_DEFAULT_GROUP_ID,
		...(resetCreditsAvailable === undefined ? {} : { resetCreditsAvailable }),
	};
}

function boundedCents(value: unknown): number | undefined {
	const raw = object(value)?.val ?? value;
	return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0 && raw <= 1_000_000_000_000 ? raw : undefined;
}
function grokConfig(payload: unknown): Record<string, unknown> | undefined { return object(object(payload)?.config); }
function weeklyPeriod(period: Record<string, unknown> | undefined): boolean {
	return typeof period?.type === "string" && period.type.toUpperCase().includes("WEEK");
}
function weeklyBucket(config: Record<string, unknown> | undefined): UsageBucket | undefined {
	if (!config) return undefined;
	const period = object(config.currentPeriod);
	let used = typeof config.creditUsagePercent === "number" && config.creditUsagePercent >= 0 && config.creditUsagePercent <= 100 ? config.creditUsagePercent : undefined;
	if (used === undefined && weeklyPeriod(period)) {
		const usedCents = boundedCents(config.used);
		const limitCents = boundedCents(config.monthlyLimit);
		if (usedCents !== undefined && limitCents !== undefined && limitCents > 0) {
			used = Math.min(100, usedCents / limitCents * 100);
		} else if (config.creditUsagePercent === undefined && config.used === undefined && config.monthlyLimit === undefined) {
			// Proto3 omits zero-valued fields; infer zero only for an explicit weekly period.
			used = 0;
		}
	}
	if (used === undefined) return undefined;
	return percentBucket("weekly", "Weekly window", used, 10_080, timestamp(period?.end ?? config.billingPeriodEnd), "weekly");
}
function monthlyBucket(config: Record<string, unknown> | undefined): UsageBucket | undefined {
	const used = boundedCents(config?.used);
	const limit = boundedCents(config?.monthlyLimit);
	if (used === undefined || limit === undefined || limit <= 0) return undefined;
	return percentBucket("monthly", "Monthly window", Math.min(100, used / limit * 100), 43_200, timestamp(config?.billingPeriodEnd ?? object(config?.currentPeriod)?.end), "monthly");
}

export function normalizeGrokIdentity(payload: unknown): string {
	const userId = object(payload)?.userId;
	if (typeof userId !== "string" || !userId || userId.length > 256 || !/^[\x21-\x7e]+$/u.test(userId)) {
		throw new Error("xAI account identity could not be verified; billing was not requested.");
	}
	return userId;
}

export function normalizeGrokUsage(credits: unknown, capturedAt = Date.now(), monthly?: unknown | null): UsageReport {
	if (!object(credits)) throw new Error("Grok billing response was not an object.");
	const primary = grokConfig(credits);
	const monthlyConfig = monthly == null ? (monthly === undefined ? primary : undefined) : grokConfig(monthly);
	const buckets = [weeklyBucket(primary), monthlyBucket(monthlyConfig)].filter((bucket): bucket is UsageBucket => Boolean(bucket));
	if (buckets.length === 0) throw new Error("Grok billing endpoint returned no quota windows.");
	return { providerId: "xai", providerName: "Grok", capturedAt, source: "grok-pi-oauth", buckets };
}

export function usageProviderForModel(model: UsageModel | undefined): UsageProviderId | undefined {
	return model?.provider === "openai-codex" || model?.provider === "xai" ? model.provider : undefined;
}

function officialOrigin(value: string | undefined, providerId: UsageProviderId): boolean {
	if (!value) return false;
	try { return PROVIDER_INFO[providerId].origins.includes(new URL(value).origin as never); } catch { return false; }
}
function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
	return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? undefined;
}

export async function resolveUsageAuth(ctx: ExtensionContext, providerId: UsageProviderId, salt: Uint8Array = AUTH_SALT, model: UsageModel | undefined = ctx.model): Promise<ResolvedUsageAuth | undefined> {
	if (!model || model.provider !== providerId) return undefined;
	if (!officialOrigin(model.baseUrl, providerId)) throw new Error(`${PROVIDER_INFO[providerId].name} usage refuses a non-official model endpoint.`);
	if (!ctx.modelRegistry.isUsingOAuth(model as Parameters<typeof ctx.modelRegistry.isUsingOAuth>[0])) throw new Error(`${PROVIDER_INFO[providerId].name} usage requires Pi OAuth; API-key auth is not accepted.`);
	const result = await ctx.modelRegistry.getProviderAuth(providerId);
	if (!result) return undefined;
	if (result.auth.baseUrl && !officialOrigin(result.auth.baseUrl, providerId)) throw new Error(`${PROVIDER_INFO[providerId].name} usage refuses a proxy-resolved credential.`);
	const supplied = headerValue(result.auth.headers, "Authorization");
	const authorization = supplied ?? (result.auth.apiKey ? `Bearer ${result.auth.apiKey}` : undefined);
	if (!authorization) return undefined;
	const headers = { Authorization: authorization };
	const secrets = [result.auth.apiKey, supplied, authorization].filter((value): value is string => Boolean(value));
	return { providerId, headers, fingerprint: fingerprintUsageAuth(headers, salt), secrets };
}

export function usageEndpoint(providerId: UsageProviderId, kind: "usage" | "identity" | "monthly" = "usage"): string {
	if (providerId === "openai-codex") {
		if (kind !== "usage") throw new Error("Unsupported Codex usage endpoint kind.");
		return CODEX_USAGE_URL;
	}
	return kind === "identity" ? GROK_USER_URL : kind === "monthly" ? GROK_MONTHLY_URL : GROK_CREDITS_URL;
}

async function boundedText(response: Response, max: number, truncate: boolean): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let exceeded = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value?.length) continue;
			const room = max - total;
			if (room > 0) {
				const kept = value.length <= room ? value : value.subarray(0, room);
				chunks.push(kept);
				total += kept.length;
			}
			if (value.length > room) {
				exceeded = true;
				await reader.cancel();
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (exceeded && !truncate) throw new Error(`Usage response exceeded ${max} bytes.`);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	const text = new TextDecoder().decode(bytes);
	return exceeded ? `${text}…` : text;
}

export async function fetchUsageJson(url: string, auth: ResolvedUsageAuth, options: { signal: AbortSignal; timeoutMs?: number; headers?: Record<string, string>; fetchImpl?: typeof fetch }): Promise<Record<string, unknown>> {
	const allowed = [CODEX_USAGE_URL, GROK_USER_URL, GROK_CREDITS_URL, GROK_MONTHLY_URL];
	if (!allowed.includes(url)) throw new Error("Usage request refused a non-official endpoint.");
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort();
	if (options.signal.aborted) controller.abort(); else options.signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? USAGE_QUERY_TIMEOUT_MS);
	try {
		const response = await (options.fetchImpl ?? fetch)(url, { method: "GET", redirect: "error", signal: controller.signal, headers: { Accept: "application/json", "User-Agent": "pi-sinan/0.2.0", ...auth.headers, ...options.headers } });
		const text = await boundedText(response, response.ok ? MAX_SUCCESS_BYTES : MAX_ERROR_BYTES, !response.ok);
		if (!response.ok) throw new Error(`Usage endpoint returned HTTP ${response.status}: ${redactUsageError(text, auth.secrets)}`);
		let parsed: unknown;
		try { parsed = JSON.parse(text); } catch { throw new Error("Usage endpoint returned invalid JSON."); }
		if (!object(parsed)) throw new Error("Usage endpoint response was not an object.");
		return parsed as Record<string, unknown>;
	} catch (error) {
		if (options.signal.aborted) throw Object.assign(new Error("Usage query aborted."), { name: "AbortError" });
		if (timedOut) throw new Error("Usage query timed out.");
		throw new Error(redactUsageError(error instanceof Error ? error.message : String(error), auth.secrets));
	} finally {
		clearTimeout(timeout);
		options.signal.removeEventListener("abort", abort);
	}
}

function grokHeaders(userId?: string): Record<string, string> {
	return { "X-XAI-Token-Auth": "xai-grok-cli", "x-grok-client-version": "0.1.0", "x-grok-client-mode": process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "headless", ...(userId ? { "x-userid": userId } : {}) };
}

export async function queryUsage(auth: ResolvedUsageAuth, signal: AbortSignal, fetchImpl?: typeof fetch): Promise<UsageReport> {
	if (auth.providerId === "openai-codex") {
		return normalizeCodexUsage(await fetchUsageJson(CODEX_USAGE_URL, auth, { signal, fetchImpl }));
	}
	const identity = await fetchUsageJson(GROK_USER_URL, auth, { signal, fetchImpl, headers: grokHeaders() });
	const userId = normalizeGrokIdentity(identity);
	const headers = grokHeaders(userId);
	const credits = await fetchUsageJson(GROK_CREDITS_URL, auth, { signal, fetchImpl, headers });
	let monthly: unknown | null = null;
	const config = grokConfig(credits);
	const weekly = weeklyBucket(config);
	if (config?.isUnifiedBillingUser === true || !weekly) {
		try {
			monthly = await fetchUsageJson(GROK_MONTHLY_URL, auth, { signal, fetchImpl, headers });
		} catch (error) {
			if (!weekly || (error instanceof Error && error.name === "AbortError")) throw error;
			// A reliable weekly window remains useful when optional monthly probing fails.
		}
	}
	return normalizeGrokUsage(credits, Date.now(), monthly);
}

function normalizeModelKey(value: string | undefined): string | undefined {
	return value?.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || undefined;
}

function bucketsForModel(report: UsageReport, model?: UsageModel): UsageBucket[] {
	if (!report.buckets.some((bucket) => bucket.groupId)) return report.buckets;
	const groups = [...new Set(report.buckets.map((bucket) => bucket.groupId ?? bucket.id))];
	const modelKeys = [model?.id, model?.name].map(normalizeModelKey).filter((value): value is string => Boolean(value));
	const specific = groups.filter((group) => group !== report.defaultGroupId).sort((left, right) => right.length - left.length);
	for (const group of specific) {
		const bucket = report.buckets.find((candidate) => (candidate.groupId ?? candidate.id) === group);
		const candidates = [group, bucket?.groupLabel, ...(bucket?.modelKeys ?? [])]
			.map(normalizeModelKey).filter((value): value is string => Boolean(value));
		if (candidates.some((candidate) => modelKeys.some((key) => key.includes(candidate)))) {
			return report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === group);
		}
	}
	const selected = groups.find((group) => group === report.defaultGroupId) ?? groups[0];
	return report.buckets.filter((bucket) => (bucket.groupId ?? bucket.id) === selected);
}

export function buildUsageStatusEvent(report: UsageReport, mode: UsageDisplayMode, model?: UsageModel): UsageStatusEvent {
	return { v: 1, status: "ready", providerId: report.providerId, capturedAt: report.capturedAt, displayMode: mode, windows: bucketsForModel(report, model).map((bucket) => ({ label: bucket.windowMinutes === 10_080 ? "1w" : bucket.windowMinutes === 43_200 ? "1m" : bucket.windowMinutes && bucket.windowMinutes % 60 === 0 ? `${bucket.windowMinutes / 60}h` : "quota", remainingPercent: bucket.remaining, usedPercent: bucket.used, displayPercent: mode === "used" ? bucket.used : bucket.remaining, ...(bucket.windowMinutes ? { windowMinutes: bucket.windowMinutes } : {}), ...(bucket.resetsAt ? { resetsAt: bucket.resetsAt } : {}), ...(bucket.groupId ? { groupId: bucket.groupId } : {}), ...(bucket.groupLabel ? { groupLabel: bucket.groupLabel } : {}) })) };
}

export function formatUsageStatus(report: UsageReport, mode: UsageDisplayMode, model?: UsageModel): string {
	const event = buildUsageStatusEvent(report, mode, model);
	if (event.status !== "ready") return "";
	return event.windows.map((window) => `${window.label} ${Math.round(window.displayPercent)}%`).join(" · ");
}

export function formatUsageReport(state: UsageState, mode: UsageDisplayMode): string {
	if (state.status !== "ready") return `${state.providerId}\n  ${state.status}: ${sanitizeUsageText(state.message)}`;
	const qualifier = mode === "used" ? "used" : "left";
	const grouped = state.report.buckets.some((bucket) => bucket.groupId);
	const lines = [state.report.providerName];
	let previousGroup: string | undefined;
	for (const bucket of state.report.buckets) {
		if (grouped && bucket.groupId !== previousGroup) {
			lines.push(`  ${bucket.groupLabel ?? bucket.groupId ?? "Other quota"}`);
			previousGroup = bucket.groupId;
		}
		const value = mode === "used" ? bucket.used : bucket.remaining;
		const reset = bucket.resetsAt ? ` · resets ${new Date(bucket.resetsAt * 1000).toLocaleString()}` : "";
		lines.push(`${grouped ? "    " : "  "}${bucket.label}: ${Math.round(value)}% ${qualifier}${reset}`);
	}
	if (state.report.resetCreditsAvailable !== undefined) {
		lines.push(`  Resets left: ${state.report.resetCreditsAvailable}`);
	}
	return lines.join("\n");
}
