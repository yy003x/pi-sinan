import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageDiagnostic,
	type AssistantMessageEventStream,
	type Provider,
	type StreamOptions,
} from "@earendil-works/pi-ai";
import { createCodexRecoveryController } from "../src/openai-codex-recovery.ts";

const MODEL = {
	id: "gpt-test",
	name: "GPT Test",
	api: "openai-codex-responses" as const,
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text" as const],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 400000,
	maxTokens: 128000,
};

function assistant(
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
	diagnostics?: AssistantMessageDiagnostic[],
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-codex-responses",
		provider: "openai-codex",
		model: MODEL.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage ? { errorMessage } : {}),
		...(diagnostics ? { diagnostics } : {}),
		timestamp: Date.now(),
	};
}

function terminalStream(message: AssistantMessage): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		if (message.stopReason === "error" || message.stopReason === "aborted") {
			stream.push({ type: "error", reason: message.stopReason, error: message });
		} else {
			stream.push({ type: "done", reason: message.stopReason === "pending" ? "stop" : message.stopReason, message });
		}
		stream.end();
	});
	return stream;
}

function websocketFailure(message = "WebSocket error"): AssistantMessageDiagnostic {
	return {
		type: "provider_transport_failure",
		timestamp: Date.now(),
		error: { name: "Error", message },
		details: {
			configuredTransport: "auto",
			phase: "after_message_stream_start",
		},
	};
}

function fakeProvider(
	handler: (options: StreamOptions | undefined, call: number) => AssistantMessageEventStream,
): Provider<"openai-codex-responses"> {
	let calls = 0;
	return {
		id: "openai-codex",
		name: "OpenAI Codex",
		baseUrl: MODEL.baseUrl,
		auth: {} as Provider<"openai-codex-responses">["auth"],
		getModels: () => [MODEL],
		stream: (_model, _context, options) => handler(options, ++calls),
		streamSimple: (_model, _context, options) => handler(options, ++calls),
	};
}

async function complete(
	provider: Provider<"openai-codex-responses">,
	options: StreamOptions,
): Promise<AssistantMessage> {
	return provider.stream(MODEL, { messages: [] }, options).result();
}

test("wraps class-based effective providers without losing auth or dynamic models", async () => {
	const auth = { apiKey: { name: "test", resolve: async () => undefined } };
	const models = [MODEL];
	class ClassProvider {
		get id() { return "openai-codex"; }
		get name() { return "Effective OpenAI Codex"; }
		get baseUrl() { return MODEL.baseUrl; }
		get auth() { return auth; }
		getModels() { return models; }
		stream() { return terminalStream(assistant("stop")); }
		streamSimple() { return terminalStream(assistant("stop")); }
	}
	const base = new ClassProvider() as unknown as Provider<"openai-codex-responses">;
	const recovery = createCodexRecoveryController({}, {
		baseProvider: base,
		getWebSocketStats: () => undefined,
		resetWebSocketState: () => {},
	});

	assert.equal(recovery.provider.id, "openai-codex");
	assert.equal(recovery.provider.name, "Effective OpenAI Codex");
	assert.equal(recovery.provider.auth, auth);
	assert.equal(recovery.provider.getModels(), models);
	assert.equal((await complete(recovery.provider, { transport: "auto", sessionId: "class-provider" })).stopReason, "stop");
});

test("auto mode cools down on websocket failure, uses SSE, then probes websocket", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
	const resets: Array<string | undefined> = [];
	const responses = [
		assistant("error", "WebSocket error", [websocketFailure()]),
		assistant("stop"),
		assistant("stop"),
		assistant("stop"),
		assistant("stop"),
	];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		return terminalStream(responses[call - 1]);
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 60_000, sseSuccessesBeforeProbe: 3 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: (sessionId) => resets.push(sessionId),
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-1" };

	await complete(recovery.provider, options);
	assert.equal(recovery.getStatus("session-1").mode, "sse-cooldown");
	await complete(recovery.provider, options);
	await complete(recovery.provider, options);
	await complete(recovery.provider, options);
	assert.equal(recovery.getStatus("session-1").consecutiveSseSuccesses, 3);
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "sse", "sse", "sse", "websocket-cached"]);
	assert.deepEqual(resets, ["session-1"]);
	assert.equal(recovery.getStatus("session-1").mode, "websocket-preferred");
	now += 1;
});

test("cooldown expiry allows one websocket probe while concurrent calls stay on SSE", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
	let finishProbe: (() => void) | undefined;
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		if (call === 1) return terminalStream(assistant("error", "WebSocket error", [websocketFailure()]));
		if (call === 2) {
			const stream = createAssistantMessageEventStream();
			finishProbe = () => {
				const message = assistant("stop");
				stream.push({ type: "done", reason: "stop", message });
				stream.end();
			};
			return stream;
		}
		return terminalStream(assistant("stop"));
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-2" };
	await complete(recovery.provider, options);
	now += 100;
	const probe = complete(recovery.provider, options);
	const concurrent = complete(recovery.provider, options);
	await concurrent;
	const secondConcurrent = complete(recovery.provider, options);
	await secondConcurrent;
	finishProbe?.();
	await probe;

	assert.deepEqual(transports, ["auto", "websocket-cached", "sse", "sse"]);
	assert.equal(recovery.getStatus("session-2").mode, "websocket-preferred");
});

test("an aborted websocket probe releases the single-probe guard", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
	const responses = [
		assistant("error", "WebSocket error", [websocketFailure()]),
		assistant("aborted"),
		assistant("stop"),
	];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		return terminalStream(responses[call - 1]);
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-abort" };

	await complete(recovery.provider, options);
	now += 100;
	await complete(recovery.provider, options);
	assert.equal(recovery.getStatus("session-abort").mode, "sse-cooldown");
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket-cached", "websocket-cached"]);
	assert.equal(recovery.getStatus("session-abort").mode, "websocket-preferred");
});

test("a non-transport probe error restores websocket preference instead of extending fallback", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
	const responses = [
		assistant("error", "WebSocket error", [websocketFailure()]),
		assistant("error", "401 unauthorized"),
	];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		return terminalStream(responses[call - 1]);
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-api-error" };

	await complete(recovery.provider, options);
	now += 100;
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket-cached"]);
	assert.equal(recovery.getStatus("session-api-error").mode, "websocket-preferred");
});

test("a synchronous provider throw releases a websocket probe", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		if (call === 1) return terminalStream(assistant("error", "WebSocket error", [websocketFailure()]));
		if (call === 2) throw new Error("provider validation failed");
		return terminalStream(assistant("stop"));
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-sync-throw" };

	await complete(recovery.provider, options);
	now += 100;
	const failedProbe = await complete(recovery.provider, options);
	assert.equal(failedProbe.errorMessage, "provider stream failed");
	assert.equal(recovery.getStatus("session-sync-throw").mode, "websocket-preferred");
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket-cached", "auto"]);
});

test("a non-transport stream iteration throw does not force SSE fallback", async () => {
	let now = 1_000;
	const base = fakeProvider((_options, call) => {
		if (call === 1) return terminalStream(assistant("error", "WebSocket error", [websocketFailure()]));
		return {
			async *[Symbol.asyncIterator]() {
				throw new Error("response parser failed");
			},
			result: async () => assistant("error", "response parser failed"),
		} as unknown as AssistantMessageEventStream;
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-stream-throw" };

	await complete(recovery.provider, options);
	now += 100;
	const result = await complete(recovery.provider, options);

	assert.equal(result.errorMessage, "provider stream failed");
	assert.equal(result.diagnostics, undefined);
	assert.equal(recovery.getStatus("session-stream-throw").mode, "websocket-preferred");
});

test("reset invalidates completion from an older in-flight probe", async () => {
	let now = 1_000;
	let finishProbe: (() => void) | undefined;
	const base = fakeProvider((_options, call) => {
		if (call === 1) return terminalStream(assistant("error", "WebSocket error", [websocketFailure()]));
		const stream = createAssistantMessageEventStream();
		finishProbe = () => {
			const message = assistant("error", "late WebSocket error", [websocketFailure("late WebSocket error")]);
			stream.push({ type: "error", reason: "error", error: message });
			stream.end();
		};
		return stream;
	});
	const recovery = createCodexRecoveryController(
		{ cooldownMs: 100, sseSuccessesBeforeProbe: 99 },
		{
			baseProvider: base,
			now: () => now,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-reset" };

	await complete(recovery.provider, options);
	now += 100;
	const probe = complete(recovery.provider, options);
	recovery.reset("session-reset");
	finishProbe?.();
	await probe;

	assert.equal(recovery.getStatus("session-reset").mode, "websocket-preferred");
});

test("SSE fetch failures expose errno codes without persisting nested sensitive messages", async () => {
	const socketError = Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
	const maliciousError = Object.assign(
		new Error("Authorization: Bearer top-secret; body=private prompt"),
		{ name: "AuthorizationBearerSecret", code: "TOP_SECRET_TOKEN" },
	);
	const fetchError = Object.assign(new TypeError("fetch failed", {
		cause: new AggregateError([socketError, maliciousError], "nested failures"),
	}), { name: "AuthorizationBearerRootSecret" });
	const base = fakeProvider((options) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await options?.fetch?.("https://chatgpt.com/backend-api/codex/responses");
				stream.push({ type: "done", reason: "stop", message: assistant("stop") });
			} catch (error) {
				const message = assistant("error", error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", reason: "error", error: message });
			} finally {
				stream.end();
			}
		});
		return stream;
	});
	const recovery = createCodexRecoveryController(
		{},
		{
			baseProvider: base,
			getWebSocketStats: () => undefined,
			resetWebSocketState: () => {},
		},
	);
	const result = await complete(recovery.provider, {
		transport: "sse",
		sessionId: "session-3",
		fetch: async () => {
			throw fetchError;
		},
	});

	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /fetch failed \(ECONNRESET\)/);
	const diagnostic = result.diagnostics?.at(-1);
	assert.equal(diagnostic?.type, "provider_transport_failure");
	assert.equal(diagnostic?.error?.name, "TransportError");
	assert.equal(diagnostic?.error?.code, "ECONNRESET");
	assert.deepEqual(diagnostic?.details?.causeCodes, ["ECONNRESET"]);
	assert.equal(diagnostic?.details?.effectiveTransport, "sse");
	const persisted = JSON.stringify({ errorMessage: result.errorMessage, diagnostics: result.diagnostics });
	assert.doesNotMatch(persisted, /top-secret|private prompt|Authorization|TOP_SECRET_TOKEN/i);
});

test("explicit transport bypasses adaptive decisions and reset clears cooldown", async () => {
	const transports: Array<StreamOptions["transport"]> = [];
	const resets: Array<string | undefined> = [];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		return terminalStream(
			call === 1 ? assistant("error", "WebSocket error", [websocketFailure()]) : assistant("stop"),
		);
	});
	const recovery = createCodexRecoveryController(
		{},
		{
			baseProvider: base,
			getWebSocketStats: () => undefined,
			resetWebSocketState: (sessionId) => resets.push(sessionId),
		},
	);

	await complete(recovery.provider, { transport: "auto", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "sse", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "websocket", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "websocket-cached", sessionId: "session-4" });
	recovery.reset("session-4");
	await complete(recovery.provider, { transport: "auto", sessionId: "session-4" });

	assert.deepEqual(transports, ["auto", "sse", "websocket", "websocket-cached", "auto"]);
	assert.deepEqual(resets, ["session-4", "session-4", "session-4"]);
	assert.equal(recovery.getStatus("session-4").mode, "websocket-preferred");
});
