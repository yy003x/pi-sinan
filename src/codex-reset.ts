// Selectively adapted from @specode/pi-subscription-usage@1.0.2 (MIT).
import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	USAGE_QUERY_TIMEOUT_MS,
	fingerprintUsageAuth,
	redactUsageError,
	resolveUsageAuth,
	sanitizeUsageText,
	type ResolvedUsageAuth,
	type UsageReport,
} from "./usage.ts";

export type CodexResetOutcomeCode = "reset" | "nothing_to_reset" | "no_credit" | "already_redeemed";

export interface CodexResetOption {
	creditId?: string;
	title: string;
	description: string;
	expiresAt?: number;
}

export interface CodexResetAvailability {
	availableCount: number;
	options: CodexResetOption[];
}

export interface CodexResetOutcome {
	code: CodexResetOutcomeCode;
	windowsReset: number;
}

export interface ResolvedCodexResetAuth extends ResolvedUsageAuth {
	headers: Record<string, string> & { Authorization: string; "chatgpt-account-id": string };
}

export const CODEX_RESET_CONFIRMATION_OPTIONS = [
	"Cancel (Default)",
	"Redeem 1 Reset (Irreversible)",
] as const;

const RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;
const MAX_SUCCESS_BYTES = 64 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;

type StoredCredentialReader = (providerId: string) => unknown;

export function codexResetCount(report: UsageReport): number {
	const count = report.resetCreditsAvailable;
	return report.providerId === "openai-codex" && typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

export function isCodexResetConfirmed(value: string | undefined): boolean {
	return value === CODEX_RESET_CONFIRMATION_OPTIONS[1];
}

export function resetOptionExpiration(option: CodexResetOption): string {
	if (option.expiresAt === undefined) return "No expiry";
	const expiration = new Date(option.expiresAt * 1_000);
	return Number.isNaN(expiration.getTime()) ? "Expiry unavailable" : `Expires ${expiration.toLocaleString()}`;
}

export function formatCodexResetOutcome(outcome: CodexResetOutcome, remainingCount?: number): string {
	const remaining = remainingCount === undefined ? "" : `, ${remainingCount} left`;
	if (outcome.code === "reset") return `Reset redeemed${remaining}.`;
	if (outcome.code === "already_redeemed") return `Reset already redeemed${remaining}.`;
	if (outcome.code === "nothing_to_reset") return "Nothing to reset right now.";
	return "No reset credits available.";
}

export function verifyCodexStoredOAuthCredential(resolvedAccess: string, storedCredential: unknown): string {
	const resolvedAccountId = codexAccountIdFromAccessToken(resolvedAccess);
	if (!resolvedAccountId) throw new Error("The active OpenAI Codex access token did not contain a valid account ID.");
	const credential = object(storedCredential);
	if (credential?.type !== "oauth") throw new Error("Codex resets require the OAuth account configured through Pi /login.");
	const storedAccess = nonemptyString(credential.access);
	const accountId = validHeaderValue(credential.accountId);
	const refresh = nonemptyString(credential.refresh);
	if (storedAccess !== resolvedAccess || !accountId || accountId !== resolvedAccountId || !refresh) {
		throw new Error("The active Codex runtime account does not match Pi's stored OAuth account.");
	}
	return accountId;
}

export function normalizeCodexResetCredits(payload: Record<string, unknown>): CodexResetAvailability {
	const availableCount = nonnegativeInteger(payload.available_count);
	if (availableCount === undefined) throw new Error("Codex reset credits response returned an invalid available_count.");
	if (payload.credits !== undefined && !Array.isArray(payload.credits)) {
		throw new Error("Codex reset credits response returned invalid credits.");
	}
	const options: CodexResetOption[] = [];
	for (const rawCredit of payload.credits ?? []) {
		const credit = object(rawCredit);
		if (!credit || credit.status !== "available" || credit.reset_type !== "codex_rate_limits") continue;
		options.push(normalizeResetOption(credit));
	}
	options.sort((left, right) => (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER));
	options.splice(Math.min(availableCount, 32));
	return { availableCount, options };
}

export function parseCodexResetOutcome(payload: Record<string, unknown>): CodexResetOutcome {
	const code = payload.code;
	if (code !== "reset" && code !== "nothing_to_reset" && code !== "no_credit" && code !== "already_redeemed") {
		throw new Error("Codex reset consume endpoint returned an unknown outcome code.");
	}
	const windowsReset = payload.windows_reset === undefined ? 0 : nonnegativeInteger(payload.windows_reset);
	if (windowsReset === undefined) throw new Error("Codex reset consume endpoint returned an invalid windows_reset value.");
	return { code, windowsReset };
}

export async function resolveCodexResetAuth(
	ctx: ExtensionContext,
	credentialReader: StoredCredentialReader = readStoredCredential,
	salt?: Uint8Array,
): Promise<ResolvedCodexResetAuth> {
	const model = ctx.model;
	if (model?.provider !== "openai-codex") throw new Error("Codex resets require the current model to use OpenAI Codex.");
	const expectedModel = `${model.provider}/${model.id}`;
	let auth: ResolvedUsageAuth | undefined;
	try {
		auth = await resolveUsageAuth(ctx, "openai-codex", salt, model);
	} catch {
		throw new Error("Codex reset authentication could not be resolved safely.");
	}
	if (`${ctx.model?.provider}/${ctx.model?.id}` !== expectedModel) {
		throw new Error("The current model changed while resolving Codex reset authentication.");
	}
	if (!auth) throw new Error("No runtime credential is configured for OpenAI Codex.");
	const access = /^Bearer\s+(.+)$/iu.exec(auth.headers.Authorization)?.[1];
	if (!access) throw new Error("OpenAI Codex OAuth credentials were incomplete.");
	let storedCredential: unknown;
	try { storedCredential = credentialReader("openai-codex"); }
	catch { throw new Error("Pi's stored Codex OAuth credential could not be read safely."); }
	const accountId = verifyCodexStoredOAuthCredential(access, storedCredential);
	const headers = { Authorization: `Bearer ${access}`, "chatgpt-account-id": accountId };
	return {
		...auth,
		headers,
		fingerprint: fingerprintUsageAuth(headers, salt),
		secrets: [...new Set([...auth.secrets, access, headers.Authorization, accountId])],
	};
}

export async function listCodexResetCredits(
	auth: ResolvedCodexResetAuth,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<CodexResetAvailability> {
	return normalizeCodexResetCredits(await fetchCodexResetJson(RESET_CREDITS_URL, auth, signal, fetchImpl));
}

export async function consumeCodexResetCredit(
	auth: ResolvedCodexResetAuth,
	option: CodexResetOption,
	requestId: string,
	signal: AbortSignal,
	fetchImpl: typeof fetch = fetch,
): Promise<CodexResetOutcome> {
	if (!requestId) throw new Error("Codex reset request ID must not be empty.");
	return parseCodexResetOutcome(await fetchCodexResetJson(RESET_CONSUME_URL, auth, signal, fetchImpl, {
		method: "POST",
		body: { redeem_request_id: requestId, ...(option.creditId ? { credit_id: option.creditId } : {}) },
	}));
}

async function fetchCodexResetJson(
	url: string,
	auth: ResolvedCodexResetAuth,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
	request: { method?: "GET" | "POST"; body?: Record<string, unknown> } = {},
): Promise<Record<string, unknown>> {
	const expectedMethod = url === RESET_CREDITS_URL ? "GET" : url === RESET_CONSUME_URL ? "POST" : undefined;
	const method = request.method ?? "GET";
	if (!expectedMethod || method !== expectedMethod) throw new Error("Codex reset request refused an unsupported endpoint or method.");
	const controller = new AbortController();
	let timedOut = false;
	const abort = () => controller.abort();
	if (signal.aborted) controller.abort(); else signal.addEventListener("abort", abort, { once: true });
	const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, USAGE_QUERY_TIMEOUT_MS);
	try {
		const response = await fetchImpl(url, {
			method,
			redirect: "error",
			signal: controller.signal,
			headers: {
				Accept: "application/json",
				"User-Agent": "pi-sinan/0.2.0",
				...auth.headers,
				...(request.body ? { "Content-Type": "application/json" } : {}),
			},
			...(request.body ? { body: JSON.stringify(request.body) } : {}),
		});
		const text = await boundedText(response, response.ok ? MAX_SUCCESS_BYTES : MAX_ERROR_BYTES, !response.ok);
		if (!response.ok) throw new Error(`Codex reset endpoint returned HTTP ${response.status}: ${redactUsageError(text, auth.secrets)}`);
		let parsed: unknown;
		try { parsed = JSON.parse(text); } catch { throw new Error("Codex reset endpoint returned invalid JSON."); }
		const value = object(parsed);
		if (!value) throw new Error("Codex reset endpoint response was not an object.");
		return value;
	} catch (error) {
		if (signal.aborted) throw Object.assign(new Error("Codex reset request aborted."), { name: "AbortError" });
		if (timedOut) throw new Error("Codex reset request timed out.");
		throw new Error(redactUsageError(error instanceof Error ? error.message : String(error), auth.secrets));
	} finally {
		clearTimeout(timeout);
		signal.removeEventListener("abort", abort);
	}
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
	if (exceeded && !truncate) throw new Error(`Codex reset response exceeded ${max} bytes.`);
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
	const text = new TextDecoder().decode(bytes);
	return exceeded ? `${text}…` : text;
}

function normalizeResetOption(credit: Record<string, unknown>): CodexResetOption {
	const creditId = opaqueId(credit.id);
	if (!creditId) throw new Error("Codex reset credits response returned an invalid credit ID.");
	let expiresAt: number | undefined;
	if (credit.expires_at !== undefined && credit.expires_at !== null) {
		if (typeof credit.expires_at !== "string") throw new Error("Codex reset credits response returned an invalid expiration time.");
		const parsed = Date.parse(credit.expires_at);
		if (!Number.isFinite(parsed)) throw new Error("Codex reset credits response returned an invalid expiration time.");
		expiresAt = Math.floor(parsed / 1_000);
	}
	return {
		creditId,
		title: displayString(credit.title) ?? "Full Reset",
		description: displayString(credit.description) ?? "Resets the current usage windows.",
		...(expiresAt === undefined ? {} : { expiresAt }),
	};
}

function codexAccountIdFromAccessToken(access: string): string | undefined {
	try {
		const parts = access.split(".");
		if (parts.length !== 3 || !parts[1]) return undefined;
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as unknown;
		return validHeaderValue(object(object(payload)?.["https://api.openai.com/auth"])?.chatgpt_account_id);
	} catch {
		return undefined;
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonemptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function validHeaderValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[^\x20-\x7e]/u.test(value) ? value : undefined;
}

function opaqueId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= 1_024 ? value : undefined;
}

function displayString(value: unknown): string | undefined {
	return typeof value === "string" ? sanitizeUsageText(value, 160) || undefined : undefined;
}

function nonnegativeInteger(value: unknown): number | undefined {
	const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
