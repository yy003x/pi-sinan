import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CODEX_RESET_CONFIRMATION_OPTIONS,
	consumeCodexResetCredit,
	formatCodexResetOutcome,
	isCodexResetConfirmed,
	listCodexResetCredits,
	normalizeCodexResetCredits,
	parseCodexResetOutcome,
	resolveCodexResetAuth,
	verifyCodexStoredOAuthCredential,
	type ResolvedCodexResetAuth,
} from "../src/codex-reset.ts";

function accessToken(accountId: string): string {
	const payload = Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: accountId },
	})).toString("base64url");
	return `header.${payload}.signature`;
}

function resetContext(token: string, options: { modelId?: string; resolverError?: boolean } = {}): ExtensionContext {
	const model = { provider: "openai-codex", id: options.modelId ?? "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api" };
	return {
		model,
		modelRegistry: {
			isUsingOAuth: () => true,
			getProviderAuth: async () => {
				if (options.resolverError) throw new Error(`resolver leaked ${token}`);
				return { auth: { apiKey: token, headers: {} } };
			},
		},
	} as unknown as ExtensionContext;
}

function resolvedAuth(token: string, accountId: string): ResolvedCodexResetAuth {
	return {
		providerId: "openai-codex",
		headers: { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId },
		fingerprint: "fingerprint",
		secrets: [token, accountId, `Bearer ${token}`],
	};
}

test("Codex reset credits filter, sanitize, sort, and cap redeemable options", () => {
	const credits: Array<Record<string, unknown>> = Array.from({ length: 35 }, (_, index) => ({
		id: `credit-${index}`,
		status: "available",
		reset_type: "codex_rate_limits",
		title: `Reset ${index}\nunsafe`,
		description: "Reset current windows",
		expires_at: new Date(Date.UTC(2027, 0, 35 - index)).toISOString(),
	}));
	credits.push({ id: "ignored", status: "used", reset_type: "codex_rate_limits" });
	const result = normalizeCodexResetCredits({ available_count: 35, credits });
	assert.equal(result.availableCount, 35);
	assert.equal(result.options.length, 32);
	assert.equal(result.options[0]?.creditId, "credit-34");
	assert.equal(result.options[0]?.title, "Reset 34 unsafe");
	assert.equal(result.options.at(-1)?.creditId, "credit-3");
	assert.deepEqual(normalizeCodexResetCredits({ available_count: 1, credits: [] }).options, []);
	assert.throws(() => normalizeCodexResetCredits({ available_count: -1 }), /invalid available_count/);
});

test("Codex reset outcome and irreversible confirmation accept only explicit known values", () => {
	assert.equal(isCodexResetConfirmed(CODEX_RESET_CONFIRMATION_OPTIONS[0]), false);
	assert.equal(isCodexResetConfirmed(CODEX_RESET_CONFIRMATION_OPTIONS[1]), true);
	assert.deepEqual(parseCodexResetOutcome({ code: "reset", windows_reset: 2 }), { code: "reset", windowsReset: 2 });
	assert.equal(formatCodexResetOutcome({ code: "reset", windowsReset: 2 }, 1), "Reset redeemed, 1 left.");
	assert.throws(() => parseCodexResetOutcome({ code: "unknown" }), /unknown outcome/);
	assert.throws(() => parseCodexResetOutcome({ code: "reset", windows_reset: -1 }), /invalid windows_reset/);
});

test("Codex reset authentication requires an exact stored OAuth account match", async () => {
	const accountId = "account-123";
	const token = accessToken(accountId);
	const credential = { type: "oauth", access: token, refresh: "refresh-token", expires: Date.now() + 60_000, accountId };
	assert.equal(verifyCodexStoredOAuthCredential(token, credential), accountId);
	assert.throws(() => verifyCodexStoredOAuthCredential(token, { ...credential, type: "api_key" }), /Pi \/login/);
	assert.throws(() => verifyCodexStoredOAuthCredential(token, { ...credential, access: "different" }), /does not match/);
	assert.throws(() => verifyCodexStoredOAuthCredential(token, { ...credential, accountId: "different" }), /does not match/);
	assert.throws(() => verifyCodexStoredOAuthCredential(token, { ...credential, refresh: "" }), /does not match/);

	const auth = await resolveCodexResetAuth(resetContext(token), () => credential, new Uint8Array(32));
	assert.deepEqual(auth.headers, { Authorization: `Bearer ${token}`, "chatgpt-account-id": accountId });
	assert.ok(auth.fingerprint && !auth.fingerprint.includes(accountId));
	assert.ok(auth.secrets.includes(accountId));

	await assert.rejects(
		resolveCodexResetAuth(resetContext(token, { resolverError: true }), () => credential),
		(error: unknown) => error instanceof Error && error.message === "Codex reset authentication could not be resolved safely." && !error.message.includes(token),
	);
});

test("Codex reset list and consume bind exact endpoints, methods, headers, and request id", async () => {
	const accountId = "account-123";
	const token = accessToken(accountId);
	const auth = resolvedAuth(token, accountId);
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		if (init?.method === "POST") return new Response(JSON.stringify({ code: "reset", windows_reset: 2 }));
		return new Response(JSON.stringify({
			available_count: 1,
			credits: [{ id: "credit-1", status: "available", reset_type: "codex_rate_limits" }],
		}));
	}) as typeof fetch;
	const controller = new AbortController();
	const listed = await listCodexResetCredits(auth, controller.signal, fetchImpl);
	const outcome = await consumeCodexResetCredit(auth, listed.options[0]!, "request-123", controller.signal, fetchImpl);
	assert.equal(outcome.code, "reset");
	assert.equal(calls[0]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
	assert.equal(calls[0]?.init?.method, "GET");
	assert.equal(calls[0]?.init?.redirect, "error");
	assert.equal((calls[0]?.init?.headers as Record<string, string>)["chatgpt-account-id"], accountId);
	assert.equal(calls[1]?.url, "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
	assert.equal(calls[1]?.init?.method, "POST");
	assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { redeem_request_id: "request-123", credit_id: "credit-1" });
});

test("Codex reset HTTP failures redact token and account identity", async () => {
	const accountId = "account-secret";
	const token = accessToken(accountId);
	const auth = resolvedAuth(token, accountId);
	const fetchImpl = (async () => new Response(`denied ${token} ${accountId} Bearer echoed-token`, { status: 403 })) as typeof fetch;
	await assert.rejects(
		listCodexResetCredits(auth, new AbortController().signal, fetchImpl),
		(error: unknown) => error instanceof Error
			&& error.message.includes("<redacted>")
			&& !error.message.includes(token)
			&& !error.message.includes(accountId)
			&& !error.message.includes("echoed-token"),
	);
});
