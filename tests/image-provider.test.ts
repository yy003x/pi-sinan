import assert from "node:assert/strict";
import test from "node:test";

import {
	attemptImageProviders,
	credentialProviderId,
	imageRequestHeaders,
	openAICodexImageGenerationRequest,
	openAICodexImageGenerationUrl,
	resolveImageProvider,
	xaiImageGenerationUrl,
	type CredentialProviderId,
	type ProviderRequestAuth,
} from "../src/image-provider.ts";

const XAI_AUTH: ProviderRequestAuth = { apiKey: "xai-test" };
const OPENAI_AUTH: ProviderRequestAuth = {
	apiKey: "openai-test",
	baseUrl: "https://chatgpt.com/backend-api",
	headers: { "chatgpt-account-id": "account-test" },
};

function authResolver(
	available: Partial<Record<CredentialProviderId, ProviderRequestAuth>>,
	calls: CredentialProviderId[],
) {
	return async (provider: CredentialProviderId) => {
		calls.push(provider);
		return available[provider];
	};
}

test("public OpenAI provider resolves through the internal openai-codex credential", () => {
	assert.equal(credentialProviderId("xai"), "xai");
	assert.equal(credentialProviderId("openai"), "openai-codex");
});

test("auto prefers xAI and does not resolve OpenAI when xAI is available", async () => {
	const calls: CredentialProviderId[] = [];
	const resolved = await resolveImageProvider(undefined, authResolver({
		xai: XAI_AUTH,
		"openai-codex": OPENAI_AUTH,
	}, calls));

	assert.equal(resolved.provider, "xai");
	assert.equal(resolved.auth, XAI_AUTH);
	assert.deepEqual(calls, ["xai"]);
});

test("auto falls back from xAI to OpenAI Codex", async () => {
	const calls: CredentialProviderId[] = [];
	const resolved = await resolveImageProvider("auto", authResolver({
		"openai-codex": OPENAI_AUTH,
	}, calls));

	assert.equal(resolved.provider, "openai");
	assert.equal(resolved.auth, OPENAI_AUTH);
	assert.deepEqual(calls, ["xai", "openai-codex"]);
});

test("explicit providers never cross-provider fallback", async () => {
	const xaiCalls: CredentialProviderId[] = [];
	await assert.rejects(
		resolveImageProvider("xai", authResolver({ "openai-codex": OPENAI_AUTH }, xaiCalls)),
		/xAI subscription is not configured/,
	);
	assert.deepEqual(xaiCalls, ["xai"]);

	const openaiCalls: CredentialProviderId[] = [];
	await assert.rejects(
		resolveImageProvider("openai", authResolver({ xai: XAI_AUTH }, openaiCalls)),
		/OpenAI subscription is not configured/,
	);
	assert.deepEqual(openaiCalls, ["openai-codex"]);
});

test("auto retries OpenAI after an xAI generation failure", async () => {
	const attempts: string[] = [];
	const result = await attemptImageProviders(
		"auto",
		authResolver({ xai: XAI_AUTH, "openai-codex": OPENAI_AUTH }, []),
		async ({ provider }) => {
			attempts.push(provider);
			if (provider === "xai") throw new Error("xAI quota exhausted");
			return "image-bytes";
		},
	);

	assert.equal(result.provider, "openai");
	assert.equal(result.value, "image-bytes");
	assert.deepEqual(attempts, ["xai", "openai"]);
});

test("explicit provider failures do not retry another provider", async () => {
	const attempts: string[] = [];
	await assert.rejects(
		attemptImageProviders(
			"xai",
			authResolver({ xai: XAI_AUTH, "openai-codex": OPENAI_AUTH }, []),
			async ({ provider }) => {
				attempts.push(provider);
				throw new Error("xAI request failed");
			},
		),
		/xAI request failed/,
	);
	assert.deepEqual(attempts, ["xai"]);
});

test("auto cancellation stops before another subscription is used", async () => {
	const attempts: string[] = [];
	const abort = new Error("cancelled");
	await assert.rejects(
		attemptImageProviders(
			"auto",
			authResolver({ xai: XAI_AUTH, "openai-codex": OPENAI_AUTH }, []),
			async ({ provider }) => {
				attempts.push(provider);
				throw abort;
			},
			(error) => error === abort,
		),
		(error) => error === abort,
	);
	assert.deepEqual(attempts, ["xai"]);
});

test("xAI image URL accepts only the official xAI API", () => {
	assert.equal(xaiImageGenerationUrl(), "https://api.x.ai/v1/images/generations");
	assert.equal(xaiImageGenerationUrl("https://api.x.ai/v1/"), "https://api.x.ai/v1/images/generations");
	assert.throws(() => xaiImageGenerationUrl("https://proxy.example/v1"), /non-official/);
	assert.throws(() => xaiImageGenerationUrl("http://api.x.ai/v1"), /non-official/);
});

test("Codex image URL accepts only the official ChatGPT backend", () => {
	assert.equal(
		openAICodexImageGenerationUrl(),
		"https://chatgpt.com/backend-api/codex/images/generations",
	);
	assert.equal(
		openAICodexImageGenerationUrl("https://chatgpt.com/backend-api/codex/"),
		"https://chatgpt.com/backend-api/codex/images/generations",
	);
	assert.throws(
		() => openAICodexImageGenerationUrl("https://gateway.example.com/backend-api"),
		/non-official ChatGPT endpoints/,
	);
	assert.throws(
		() => openAICodexImageGenerationUrl("http://chatgpt.com/backend-api"),
		/non-official ChatGPT endpoints/,
	);
});

test("Codex image request mirrors the subscription generation contract", () => {
	assert.deepEqual(openAICodexImageGenerationRequest("paint a blue whale"), {
		model: "gpt-image-2",
		prompt: "paint a blue whale",
		background: "auto",
		quality: "auto",
		size: "auto",
	});
	assert.equal(openAICodexImageGenerationRequest("wide", "16:9").size, "1536x1024");
	assert.equal(openAICodexImageGenerationRequest("tall", "9:16").size, "1024x1536");
	assert.equal(openAICodexImageGenerationRequest("square", "1:1").size, "1024x1024");
});

test("image request headers preserve provider routing and add Codex correlation", () => {
	const headers = imageRequestHeaders(OPENAI_AUTH, {
		originator: "pi-sinan",
		"x-codex-image-turn-id": "turn-test",
	});

	assert.equal(headers.get("authorization"), "Bearer openai-test");
	assert.equal(headers.get("chatgpt-account-id"), "account-test");
	assert.equal(headers.get("content-type"), "application/json");
	assert.equal(headers.get("originator"), "pi-sinan");
	assert.equal(headers.get("x-codex-image-turn-id"), "turn-test");
});
