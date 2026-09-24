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
import { createCodexRecoveryController } from "../src/codex-recovery.ts";

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
	return provider.stream(MODEL, { messages: [] } as unknown as Parameters<typeof provider.stream>[1], options).result();
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
	});

	assert.equal(recovery.provider.id, "openai-codex");
	assert.equal(recovery.provider.name, "Effective OpenAI Codex");
	assert.equal(recovery.provider.auth, auth);
	assert.equal(recovery.provider.getModels(), models);
	assert.equal((await complete(recovery.provider, { transport: "auto", sessionId: "class-provider" })).stopReason, "stop");
});

test("capacity overload delays the next Pi-owned retry without replaying the failed request", async () => {
	let now = 1_000;
	const waits: number[] = [];
	const transports: Array<StreamOptions["transport"]> = [];
	const responses = [
		assistant("error", "Codex error: Our servers are currently overloaded. Please try again later."),
		assistant("stop"),
	];
	const base = fakeProvider((options, call) => {
		transports.push(options?.transport);
		return terminalStream(responses[call - 1]);
	});
	const recovery = createCodexRecoveryController(
		{ capacityBaseDelayMs: 4_000, capacityMaxDelayMs: 30_000 },
		{
			baseProvider: base,
			now: () => now,
			random: () => 0.5,
			sleep: async (ms) => {
				waits.push(ms);
				now += ms;
			},
		},
	);
	const options = { transport: "auto" as const, sessionId: "capacity-session" };

	const overloaded = await complete(recovery.provider, options);
	assert.equal(overloaded.stopReason, "error");
	assert.deepEqual(transports, ["auto"]);
	assert.equal(recovery.getStatus("capacity-session").capacityFailures, 1);
	assert.equal(recovery.getStatus("capacity-session").capacityCooldownUntil, 5_000);

	const recovered = await complete(recovery.provider, options);
	assert.equal(recovered.stopReason, "stop");
	assert.deepEqual(waits, [4_000]);
	assert.deepEqual(transports, ["auto", "auto"]);
	assert.equal(recovery.getStatus("capacity-session").capacityFailures, 0);
});

test("capacity cooldown honors Retry-After and reset clears it", async () => {
	const base = fakeProvider((options) => {
		void options?.onResponse?.({ status: 503, headers: { "retry-after": "12" } }, MODEL);
		return terminalStream(assistant("error", "503 service unavailable"));
	});
	const recovery = createCodexRecoveryController(
		{ capacityBaseDelayMs: 4_000, capacityMaxDelayMs: 30_000 },
		{
			baseProvider: base,
			now: () => 1_000,
			random: () => 0.5,
		},
	);

	await complete(recovery.provider, { transport: "auto", sessionId: "retry-after" });
	assert.equal(recovery.getStatus("retry-after").capacityCooldownUntil, 13_000);
	recovery.reset("retry-after");
	assert.equal(recovery.getStatus("retry-after").capacityFailures, 0);
});

test("a waiting retry rereads a cooldown extended by another in-flight failure", async () => {
	let now = 1_000;
	const waits: Array<{ ms: number; wake: () => void }> = [];
	const sources: AssistantMessageEventStream[] = [];
	const base = fakeProvider(() => {
		const source = createAssistantMessageEventStream();
		sources.push(source);
		return source;
	});
	const recovery = createCodexRecoveryController(
		{ capacityBaseDelayMs: 4_000, capacityMaxDelayMs: 30_000 },
		{
			baseProvider: base,
			now: () => now,
			random: () => 0.5,
			sleep: (ms) => new Promise((resolve) => {
				const wakeAt = now + ms;
				waits.push({
					ms,
					wake: () => {
						now = Math.max(now, wakeAt);
						resolve();
					},
				});
			}),
		},
	);
	const options = { transport: "auto" as const, sessionId: "capacity-concurrent" };
	const finish = (source: AssistantMessageEventStream, message: AssistantMessage) => {
		if (message.stopReason === "error") source.push({ type: "error", reason: "error", error: message });
		else source.push({ type: "done", reason: "stop", message });
		source.end();
	};

	const first = complete(recovery.provider, options);
	const alreadyInFlight = complete(recovery.provider, options);
	assert.equal(sources.length, 2);
	finish(sources[0], assistant("error", "Codex error: Our servers are currently overloaded."));
	await first;

	const waitingRetry = complete(recovery.provider, options);
	assert.equal(waits[0]?.ms, 4_000);
	now = 2_000;
	finish(sources[1], assistant("error", "Codex error: Our servers are currently overloaded."));
	await alreadyInFlight;
	assert.equal(recovery.getStatus("capacity-concurrent").capacityCooldownUntil, 10_000);

	waits.shift()?.wake();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(waits[0]?.ms, 5_000);
	assert.equal(sources.length, 2);
	waits.shift()?.wake();
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(sources.length, 3);
	finish(sources[2], assistant("stop"));
	assert.equal((await waitingRetry).stopReason, "stop");
});

test("reset aborts a scheduled capacity wait before another provider request starts", async () => {
	let calls = 0;
	const base = fakeProvider((_options, call) => {
		calls = call;
		return terminalStream(assistant("error", "Codex error: Our servers are currently overloaded."));
	});
	const recovery = createCodexRecoveryController(
		{ capacityBaseDelayMs: 4_000 },
		{
			baseProvider: base,
			random: () => 0.5,
		},
	);
	const options = { transport: "auto" as const, sessionId: "capacity-reset" };
	await complete(recovery.provider, options);

	const waitingRetry = complete(recovery.provider, options);
	recovery.reset("capacity-reset");
	const aborted = await waitingRetry;
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(calls, 1);
	assert.equal(recovery.getStatus("capacity-reset").capacityFailures, 0);
});

test("capacity cooldown is abortable before another provider request starts", async () => {
	let calls = 0;
	const base = fakeProvider((_options, call) => {
		calls = call;
		return terminalStream(assistant("error", "Codex error: Our servers are currently overloaded."));
	});
	const recovery = createCodexRecoveryController(
		{ capacityBaseDelayMs: 4_000 },
		{
			baseProvider: base,
			random: () => 0.5,
			sleep: async (_ms, signal) => signal?.throwIfAborted(),
		},
	);
	const options = { transport: "auto" as const, sessionId: "capacity-abort" };
	await complete(recovery.provider, options);
	const controller = new AbortController();
	controller.abort();

	const aborted = await complete(recovery.provider, { ...options, signal: controller.signal });
	assert.equal(aborted.stopReason, "aborted");
	assert.equal(calls, 1);
	assert.equal(recovery.getStatus("capacity-abort").capacityFailures, 1);
});

test("terminal subscription limits do not arm capacity cooldown", async () => {
	const base = fakeProvider(() => terminalStream(assistant("error", "Monthly usage limit reached")));
	const recovery = createCodexRecoveryController({}, {
		baseProvider: base,
	});

	await complete(recovery.provider, { transport: "auto", sessionId: "usage-limit" });
	assert.equal(recovery.getStatus("usage-limit").capacityFailures, 0);
});

test("auto mode cools down on websocket failure, uses SSE, then probes websocket", async () => {
	let now = 1_000;
	const transports: Array<StreamOptions["transport"]> = [];
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

	assert.deepEqual(transports, ["auto", "sse", "sse", "sse", "websocket"]);
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

	assert.deepEqual(transports, ["auto", "websocket", "sse", "sse"]);
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
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-abort" };

	await complete(recovery.provider, options);
	now += 100;
	await complete(recovery.provider, options);
	assert.equal(recovery.getStatus("session-abort").mode, "sse-cooldown");
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket", "websocket"]);
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
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-api-error" };

	await complete(recovery.provider, options);
	now += 100;
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket"]);
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
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-sync-throw" };

	await complete(recovery.provider, options);
	now += 100;
	const failedProbe = await complete(recovery.provider, options);
	assert.equal(failedProbe.errorMessage, "provider stream failed");
	assert.equal(recovery.getStatus("session-sync-throw").mode, "websocket-preferred");
	await complete(recovery.provider, options);

	assert.deepEqual(transports, ["auto", "websocket", "auto"]);
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
		},
	);
	const options = { transport: "auto" as const, sessionId: "session-reset" };

	await complete(recovery.provider, options);
	now += 100;
	const probe = complete(recovery.provider, options);
	recovery.reset("session-reset");
	finishProbe?.();
	await probe;

	assert.equal(recovery.getStatus("session-reset").mode, "websocket-probe");
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
		},
	);
	for (const transport of ["sse", "auto"] as const) {
		const sessionId = `session-3-${transport}`;
		const result = await complete(recovery.provider, {
			transport,
			sessionId,
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
		assert.equal(diagnostic?.details?.configuredTransport, transport);
		assert.equal(diagnostic?.details?.effectiveTransport, "sse");
		assert.equal(recovery.getStatus(sessionId).mode, "websocket-preferred");
		const persisted = JSON.stringify({ errorMessage: result.errorMessage, diagnostics: result.diagnostics });
		assert.doesNotMatch(persisted, /top-secret|private prompt|Authorization|TOP_SECRET_TOKEN/i);
	}
});

test("recovered fetch attempts do not leave diagnostics on successful or unrelated terminal results", async () => {
	let attempts = 0;
	const fetchError = new TypeError("fetch failed", {
		cause: Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" }),
	});
	const base = fakeProvider((options, call) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				try {
					await options?.fetch?.("https://chatgpt.com/backend-api/codex/responses");
				} catch (error) {
					assert.match(error instanceof Error ? error.message : String(error), /fetch failed \(ECONNRESET\)/);
				}
				await options?.fetch?.("https://chatgpt.com/backend-api/codex/responses");
				const message = call === 1 ? assistant("stop") : assistant("error", "invalid request");
				if (message.stopReason === "error") stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: "stop", message });
			} catch (error) {
				const message = assistant("error", error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", reason: "error", error: message });
			} finally {
				stream.end();
			}
		});
		return stream;
	});
	const recovery = createCodexRecoveryController({}, { baseProvider: base });
	const options = {
		transport: "auto" as const,
		sessionId: "session-fetch-retry",
		fetch: async () => {
			if (++attempts % 2 === 1) throw fetchError;
			return new Response(null, { status: 200 });
		},
	};

	const recovered = await complete(recovery.provider, options);
	assert.equal(recovered.stopReason, "stop");
	assert.equal(recovered.diagnostics, undefined);
	const unrelated = await complete(recovery.provider, options);
	assert.equal(unrelated.errorMessage, "invalid request");
	assert.equal(unrelated.diagnostics, undefined);
	assert.equal(attempts, 4);
	assert.equal(recovery.getStatus(options.sessionId).mode, "websocket-preferred");
});

test("an aborted fetch does not add a transport diagnostic or enter cooldown", async () => {
	const base = fakeProvider((options) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(async () => {
			try {
				await options?.fetch?.("https://chatgpt.com/backend-api/codex/responses");
			} catch (error) {
				const message = assistant("aborted", error instanceof Error ? error.message : String(error));
				stream.push({ type: "error", reason: "aborted", error: message });
			} finally {
				stream.end();
			}
		});
		return stream;
	});
	const recovery = createCodexRecoveryController({}, { baseProvider: base });
	const result = await complete(recovery.provider, {
		transport: "auto",
		sessionId: "session-fetch-abort",
		fetch: async () => { throw Object.assign(new Error("Request was aborted"), { name: "AbortError" }); },
	});

	assert.equal(result.stopReason, "aborted");
	assert.equal(result.diagnostics, undefined);
	assert.equal(recovery.getStatus("session-fetch-abort").mode, "websocket-preferred");
});

test("explicit transport bypasses adaptive decisions and reset clears cooldown", async () => {
	const transports: Array<StreamOptions["transport"]> = [];
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
		},
	);

	await complete(recovery.provider, { transport: "auto", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "sse", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "websocket", sessionId: "session-4" });
	await complete(recovery.provider, { transport: "websocket-cached", sessionId: "session-4" });
	recovery.reset("session-4");
	await complete(recovery.provider, { transport: "auto", sessionId: "session-4" });

	assert.deepEqual(transports, ["auto", "sse", "websocket", "websocket-cached", "websocket"]);
	assert.equal(recovery.getStatus("session-4").mode, "websocket-preferred");
});
