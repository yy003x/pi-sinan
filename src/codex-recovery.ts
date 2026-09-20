import {
	createAssistantMessageEventStream,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type AssistantMessageDiagnostic,
	type AssistantMessageEvent,
	type FetchFunction,
	type OpenAICodexResponsesOptions,
	type Provider,
	type SimpleStreamOptions,
	type StreamOptions,
	type Transport,
} from "@earendil-works/pi-ai";

const DEFAULT_COOLDOWN_MS = 2 * 60 * 1000;
const DEFAULT_SSE_SUCCESSES_BEFORE_PROBE = 3;
const DEFAULT_CAPACITY_BASE_DELAY_MS = 4_000;
const DEFAULT_CAPACITY_MAX_DELAY_MS = 30_000;
const MAX_CAUSE_DEPTH = 6;
const CAPACITY_ERROR_PATTERN = /overloaded|currently experiencing high demand|service unavailable|\b(?:429|502|503|504)\b/i;
const TERMINAL_LIMIT_ERROR_PATTERN = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing/i;
const CAPACITY_FAILURE_MESSAGE = "OpenAI Codex capacity is temporarily overloaded";
const RECOVERY_PROVIDER_MARKER = Symbol.for("pi-sinan.codex-recovery");
const NETWORK_ERROR_CODES = new Set([
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"EAI_AGAIN",
	"ECONNABORTED",
	"ECONNREFUSED",
	"ECONNRESET",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"ENOTFOUND",
	"EPIPE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"ETIMEDOUT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UND_ERR_ABORTED",
	"UND_ERR_BODY_TIMEOUT",
	"UND_ERR_CLOSED",
	"UND_ERR_CONNECT_TIMEOUT",
	"UND_ERR_DESTROYED",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_SOCKET",
]);

type CodexProvider = Provider<"openai-codex-responses">;
type CodexOptions = OpenAICodexResponsesOptions | SimpleStreamOptions;

type NetworkFailure = {
	message: string;
	codes: string[];
};

type RecoveryState = {
	fallbackUntil: number;
	consecutiveSseSuccesses: number;
	probeInFlight: boolean;
	websocketFailures: number;
	lastFailure?: string;
	lastFailureAt?: number;
};

type CapacityState = {
	cooldownUntil: number;
	failures: number;
	lastFailure: string;
	lastFailureAt: number;
};

type RequestDecision = {
	configuredTransport: Transport;
	effectiveTransport: Transport;
	sessionId?: string;
	generation?: number;
	adaptive: boolean;
	probe: boolean;
	forcedProbe?: boolean;
};

export type CodexRecoveryStatus = {
	mode: "websocket-preferred" | "sse-cooldown" | "websocket-probe";
	fallbackUntil?: number;
	consecutiveSseSuccesses: number;
	websocketFailures: number;
	lastFailure?: string;
	lastFailureAt?: number;
	capacityCooldownUntil?: number;
	capacityFailures: number;
	lastCapacityFailure?: string;
	lastCapacityFailureAt?: number;
};

export interface CodexRecoveryPolicy {
	cooldownMs?: number;
	sseSuccessesBeforeProbe?: number;
	capacityBaseDelayMs?: number;
	capacityMaxDelayMs?: number;
}

export interface CodexRecoveryDependencies {
	baseProvider?: CodexProvider;
	now?: () => number;
	random?: () => number;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface CodexRecoveryController {
	provider: CodexProvider;
	getStatus(sessionId: string): CodexRecoveryStatus;
	reset(sessionId?: string): void;
}

type MarkedCodexProvider = CodexProvider & { [RECOVERY_PROVIDER_MARKER]?: CodexProvider };

export function unwrapCodexRecoveryProvider(provider: CodexProvider): CodexProvider {
	return (provider as MarkedCodexProvider)[RECOVERY_PROVIDER_MARKER] ?? provider;
}

function isTerminalEvent(event: AssistantMessageEvent): event is Extract<AssistantMessageEvent, { type: "done" | "error" }> {
	return event.type === "done" || event.type === "error";
}

function terminalMessage(event: Extract<AssistantMessageEvent, { type: "done" | "error" }>): AssistantMessage {
	return event.type === "done" ? event.message : event.error;
}

function transportDiagnostic(message: AssistantMessage): AssistantMessageDiagnostic | undefined {
	return message.diagnostics?.find((diagnostic) => {
		if (diagnostic.type !== "provider_transport_failure") return false;
		const configured = diagnostic.details?.configuredTransport;
		const effective = diagnostic.details?.effectiveTransport;
		return configured !== "sse" && effective !== "sse";
	});
}

function failureText(diagnostic: AssistantMessageDiagnostic | undefined, fallback?: string): string | undefined {
	return diagnostic?.error?.message || fallback;
}

function capacityFailure(message: AssistantMessage): string | undefined {
	const errorMessage = message.stopReason === "error" ? message.errorMessage : undefined;
	if (!errorMessage || TERMINAL_LIMIT_ERROR_PATTERN.test(errorMessage) || !CAPACITY_ERROR_PATTERN.test(errorMessage)) {
		return undefined;
	}
	return CAPACITY_FAILURE_MESSAGE;
}

function retryAfterMs(headers: Record<string, string | undefined>, now: number): number | undefined {
	const milliseconds = Number(headers["retry-after-ms"]);
	if (Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
	const retryAfter = headers["retry-after"];
	if (!retryAfter) return undefined;
	const seconds = Number(retryAfter);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
	const date = Date.parse(retryAfter);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

function abortError(): Error {
	const error = new Error("Request was aborted");
	error.name = "AbortError";
	return error;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(abortError());
			return;
		}
		const onAbort = () => {
			clearTimeout(timeout);
			reject(abortError());
		};
		const timeout = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function errorCode(value: unknown): string | undefined {
	if (!value || typeof value !== "object" || !("code" in value)) return undefined;
	const code = (value as { code?: unknown }).code;
	return typeof code === "string" && NETWORK_ERROR_CODES.has(code) ? code : undefined;
}

function collectNetworkFailure(error: unknown): NetworkFailure {
	const rootMessage = error instanceof Error ? error.message : "";
	const codes = new Set<string>();
	const seen = new Set<unknown>();
	const queue: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current || current.depth > MAX_CAUSE_DEPTH || seen.has(current.value)) continue;
		seen.add(current.value);
		const code = errorCode(current.value);
		if (code) codes.add(code);
		if (current.value instanceof Error) {
			if (current.value.cause !== undefined) queue.push({ value: current.value.cause, depth: current.depth + 1 });
			if (current.value instanceof AggregateError) {
				for (const nested of current.value.errors) queue.push({ value: nested, depth: current.depth + 1 });
			}
		}
	}

	// Fetch implementations can include request headers or bodies in arbitrary error
	// messages. Persist only a generic transport label plus bounded errno-style codes.
	const message = /^(?:fetch failed|network error|connection error)$/i.test(rootMessage.trim())
		? rootMessage.trim()
		: "provider fetch failed";
	return { message, codes: [...codes] };
}

function formatNetworkFailure(failure: NetworkFailure): string {
	return failure.codes.length > 0 ? `${failure.message} (${failure.codes.join(", ")})` : failure.message;
}

function withDiagnosticFetch(baseFetch: FetchFunction, capture: (failure: NetworkFailure) => void): FetchFunction {
	return async (input, init) => {
		try {
			return await baseFetch(input, init);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || init?.signal?.aborted)) throw error;
			const failure = collectNetworkFailure(error);
			capture(failure);
			throw new Error(formatNetworkFailure(failure), { cause: error });
		}
	};
}

function appendFetchDiagnostic(
	message: AssistantMessage,
	failure: NetworkFailure,
	decision: RequestDecision,
): void {
	if (message.stopReason === "aborted") return;
	const diagnostic: AssistantMessageDiagnostic = {
		type: "provider_transport_failure",
		timestamp: Date.now(),
		error: {
			name: "TransportError",
			message: formatNetworkFailure(failure),
			...(failure.codes[0] ? { code: failure.codes[0] } : {}),
		},
		details: {
			configuredTransport: decision.configuredTransport,
			effectiveTransport: decision.effectiveTransport,
			phase: "before_response_headers",
			causeCodes: failure.codes,
		},
	};
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

function unexpectedFailure(
	model: { api: string; provider: string; id: string },
	error: unknown,
	aborted = false,
): AssistantMessage {
	const failure = collectNetworkFailure(error);
	const errorMessage = aborted
		? "Request was aborted"
		: failure.codes.length > 0
			? `provider stream failed (${failure.codes.join(", ")})`
			: "provider stream failed";
	return {
		role: "assistant",
		content: [],
		api: model.api as AssistantMessage["api"],
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

export function createCodexRecoveryController(
	policy: CodexRecoveryPolicy = {},
	dependencies: CodexRecoveryDependencies = {},
): CodexRecoveryController {
	const cooldownMs = policy.cooldownMs ?? DEFAULT_COOLDOWN_MS;
	const sseSuccessesBeforeProbe = policy.sseSuccessesBeforeProbe ?? DEFAULT_SSE_SUCCESSES_BEFORE_PROBE;
	const capacityBaseDelayMs = policy.capacityBaseDelayMs ?? DEFAULT_CAPACITY_BASE_DELAY_MS;
	const capacityMaxDelayMs = policy.capacityMaxDelayMs ?? DEFAULT_CAPACITY_MAX_DELAY_MS;
	if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error("cooldownMs must be a non-negative number");
	if (!Number.isInteger(sseSuccessesBeforeProbe) || sseSuccessesBeforeProbe < 1) {
		throw new Error("sseSuccessesBeforeProbe must be a positive integer");
	}
	if (!Number.isFinite(capacityBaseDelayMs) || capacityBaseDelayMs < 0) {
		throw new Error("capacityBaseDelayMs must be a non-negative number");
	}
	if (!Number.isFinite(capacityMaxDelayMs) || capacityMaxDelayMs < 0) {
		throw new Error("capacityMaxDelayMs must be a non-negative number");
	}

	if (!dependencies.baseProvider) throw new Error("baseProvider is required");
	const base = unwrapCodexRecoveryProvider(dependencies.baseProvider);
	const now = dependencies.now ?? Date.now;
	const random = dependencies.random ?? Math.random;
	const sleep = dependencies.sleep ?? defaultSleep;
	const states = new Map<string, RecoveryState>();
	const capacityStates = new Map<string, CapacityState>();
	const capacityWaiters = new Map<string, Set<AbortController>>();
	const forcedProbeSessions = new Set<string>();
	const generations = new Map<string, number>();
	const activeSessions = new Set<string>();
	const generationOf = (sessionId: string) => generations.get(sessionId) ?? 0;
	const advanceGeneration = (sessionId: string) => generations.set(sessionId, generationOf(sessionId) + 1);

	const enterCooldown = (sessionId: string, reason?: string) => {
		forcedProbeSessions.delete(sessionId);
		const previous = states.get(sessionId);
		states.set(sessionId, {
			fallbackUntil: now() + cooldownMs,
			consecutiveSseSuccesses: 0,
			probeInFlight: false,
			websocketFailures: (previous?.websocketFailures ?? 0) + 1,
			...(reason ? { lastFailure: reason, lastFailureAt: now() } : {}),
		});
	};

	// Pi owns the retry count and replays the assistant call. This layer only
	// delays the next request so concurrent sessions do not retry in lockstep.
	const enterCapacityCooldown = (sessionId: string, reason: string, requestedDelayMs?: number) => {
		const previous = capacityStates.get(sessionId);
		const failures = (previous?.failures ?? 0) + 1;
		const exponentialDelay = capacityBaseDelayMs * 2 ** Math.min(failures - 1, 20);
		const jitter = 0.5 + Math.min(1, Math.max(0, random()));
		const localDelay = Math.round(exponentialDelay * jitter);
		const delayMs = Math.min(capacityMaxDelayMs, Math.max(localDelay, requestedDelayMs ?? 0));
		capacityStates.set(sessionId, {
			cooldownUntil: now() + delayMs,
			failures,
			lastFailure: reason,
			lastFailureAt: now(),
		});
	};

	const waitForCapacity = (sessionId: string | undefined, signal?: AbortSignal): Promise<void> | undefined => {
		if (!sessionId || !capacityStates.has(sessionId)) return undefined;
		return (async () => {
			const controller = new AbortController();
			const onCallerAbort = () => controller.abort();
			if (signal?.aborted) controller.abort();
			else signal?.addEventListener("abort", onCallerAbort, { once: true });
			const waiters = capacityWaiters.get(sessionId) ?? new Set<AbortController>();
			waiters.add(controller);
			capacityWaiters.set(sessionId, waiters);
			try {
				for (;;) {
					const state = capacityStates.get(sessionId);
					if (!state) return;
					const delayMs = Math.max(0, state.cooldownUntil - now());
					if (delayMs <= 0) return;
					await sleep(delayMs, controller.signal);
				}
			} finally {
				signal?.removeEventListener("abort", onCallerAbort);
				waiters.delete(controller);
				if (waiters.size === 0 && capacityWaiters.get(sessionId) === waiters) {
					capacityWaiters.delete(sessionId);
				}
			}
		})();
	};

	const cancelCapacityWaiters = (sessionId: string) => {
		const waiters = capacityWaiters.get(sessionId);
		if (!waiters) return;
		capacityWaiters.delete(sessionId);
		for (const controller of waiters) controller.abort();
	};

	const decide = (options: CodexOptions | undefined): RequestDecision => {
		const configuredTransport = options?.transport ?? "auto";
		const sessionId = options?.sessionId;
		if (sessionId) activeSessions.add(sessionId);
		if (sessionId && (configuredTransport === "websocket" || configuredTransport === "websocket-cached")) {
			states.delete(sessionId);
			forcedProbeSessions.delete(sessionId);
			advanceGeneration(sessionId);
		}
		const generation = sessionId ? generationOf(sessionId) : undefined;
		if (configuredTransport !== "auto" || !sessionId) {
			return {
				configuredTransport,
				effectiveTransport: configuredTransport,
				sessionId,
				generation,
				adaptive: false,
				probe: false,
			};
		}

		if (forcedProbeSessions.has(sessionId)) {
			return {
				configuredTransport,
				effectiveTransport: "websocket",
				sessionId,
				generation,
				adaptive: true,
				probe: true,
				forcedProbe: true,
			};
		}

		const state = states.get(sessionId);
		if (!state) {
			return {
				configuredTransport,
				effectiveTransport: "auto",
				sessionId,
				generation,
				adaptive: true,
				probe: false,
			};
		}

		const probeReady = now() >= state.fallbackUntil || state.consecutiveSseSuccesses >= sseSuccessesBeforeProbe;
		if (probeReady && !state.probeInFlight) {
			state.probeInFlight = true;
			return {
				configuredTransport,
				effectiveTransport: "websocket",
				sessionId,
				generation,
				adaptive: true,
				probe: true,
			};
		}

		return {
			configuredTransport,
			effectiveTransport: "sse",
			sessionId,
			generation,
			adaptive: true,
			probe: false,
		};
	};

	const finalizeCapacity = (
		message: AssistantMessage,
		decision: RequestDecision,
		requestedDelayMs?: number,
	) => {
		if (!decision.sessionId || decision.generation !== generationOf(decision.sessionId)) return;
		if (message.stopReason === "aborted") return;
		const failure = capacityFailure(message);
		if (failure) {
			enterCapacityCooldown(decision.sessionId, failure, requestedDelayMs);
			return;
		}
		capacityStates.delete(decision.sessionId);
	};

	const finalize = (message: AssistantMessage, decision: RequestDecision) => {
		if (!decision.adaptive || !decision.sessionId) return;
		const sessionId = decision.sessionId;
		if (decision.generation !== generationOf(sessionId)) return;
		if (message.stopReason === "aborted") {
			if (decision.probe && !decision.forcedProbe) {
				const state = states.get(sessionId);
				if (state) state.probeInFlight = false;
			}
			return;
		}
		const websocketFailure = transportDiagnostic(message);
		if (websocketFailure) {
			enterCooldown(sessionId, failureText(websocketFailure, message.errorMessage));
			return;
		}

		if (decision.effectiveTransport === "sse") {
			const state = states.get(sessionId);
			if (!state) return;
			state.consecutiveSseSuccesses = message.stopReason === "error" ? 0 : state.consecutiveSseSuccesses + 1;
			return;
		}

		if (decision.probe) {
			// No provider_transport_failure means the WebSocket transport itself worked.
			// API/auth/rate-limit failures must not force SSE because changing transport
			// cannot fix them.
			states.delete(sessionId);
			forcedProbeSessions.delete(sessionId);
		}
	};

	const wrapStream = (
		model: { api: string; provider: string; id: string },
		decision: RequestDecision,
		fetchFailure: () => NetworkFailure | undefined,
		capacityRetryAfter: () => number | undefined,
		openSource: () => AssistantMessageEventStream,
		signal?: AbortSignal,
	): AssistantMessageEventStream => {
		const target = createAssistantMessageEventStream();
		void (async () => {
			try {
				const capacityWait = waitForCapacity(decision.sessionId, signal);
				if (capacityWait) await capacityWait;
				const source = openSource();
				for await (const event of source) {
					if (isTerminalEvent(event)) {
						const message = terminalMessage(event);
						const failure = fetchFailure();
						if (failure) appendFetchDiagnostic(message, failure, decision);
						finalizeCapacity(message, decision, capacityRetryAfter());
						finalize(message, decision);
					}
					target.push(event);
				}
			} catch (error) {
				// Pi providers should encode failures as terminal stream events. If a
				// custom/effective provider violates that contract, surface a generic
				// error but do not assume changing transport can fix it.
				const aborted = signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				const message = unexpectedFailure(model, error, aborted);
				finalizeCapacity(message, decision, capacityRetryAfter());
				finalize(message, decision);
				target.push({ type: "error", reason: aborted ? "aborted" : "error", error: message });
			} finally {
				target.end();
			}
		})();
		return target;
	};

	const request = <TOptions extends StreamOptions>(
		model: { api: string; provider: string; id: string },
		options: TOptions | undefined,
		invoke: (nextOptions: TOptions) => AssistantMessageEventStream,
	): AssistantMessageEventStream => {
		const decision = decide(options);
		let lastFetchFailure: NetworkFailure | undefined;
		let serverRetryAfterMs: number | undefined;
		const baseFetch = options?.fetch ?? globalThis.fetch;
		const onResponse = options?.onResponse;
		const nextOptions = {
			...(options ?? {}),
			transport: decision.effectiveTransport,
			fetch: withDiagnosticFetch(baseFetch, (failure) => {
				lastFetchFailure = failure;
			}),
			onResponse: async (response, responseModel) => {
				serverRetryAfterMs = retryAfterMs(response.headers, now());
				await onResponse?.(response, responseModel);
			},
		} as TOptions;
		return wrapStream(
			model,
			decision,
			() => lastFetchFailure,
			() => serverRetryAfterMs,
			() => invoke(nextOptions),
			options?.signal,
		);
	};

	const provider: CodexProvider = {
		id: base.id,
		name: base.name,
		baseUrl: base.baseUrl,
		headers: base.headers,
		auth: base.auth,
		getModels: () => base.getModels(),
		refreshModels: base.refreshModels ? (context) => base.refreshModels!(context) : undefined,
		filterModels: base.filterModels ? (models, credential) => base.filterModels!(models, credential) : undefined,
		stream(model, context, options) {
			return request(model, options, (nextOptions) => base.stream(model, context, nextOptions));
		},
		streamSimple(model, context, options) {
			return request(model, options, (nextOptions) => base.streamSimple(model, context, nextOptions));
		},
		fetchDeferred: base.fetchDeferred
			? (model, handle, options) => base.fetchDeferred!(model, handle, options)
			: undefined,
		cancelDeferred: base.cancelDeferred
			? (model, handle, options) => base.cancelDeferred!(model, handle, options)
			: undefined,
	};
	Object.defineProperty(provider, RECOVERY_PROVIDER_MARKER, { value: base });

	return {
		provider,
		getStatus(sessionId) {
			const state = states.get(sessionId);
			const capacityState = capacityStates.get(sessionId);
			const capacityStatus = {
				capacityCooldownUntil: capacityState?.cooldownUntil,
				capacityFailures: capacityState?.failures ?? 0,
				lastCapacityFailure: capacityState?.lastFailure,
				lastCapacityFailureAt: capacityState?.lastFailureAt,
			};
			if (!state) {
				return {
					mode: forcedProbeSessions.has(sessionId) ? "websocket-probe" : "websocket-preferred",
					consecutiveSseSuccesses: 0,
					websocketFailures: 0,
					...capacityStatus,
				};
			}
			return {
				mode: state.probeInFlight ? "websocket-probe" : "sse-cooldown",
				fallbackUntil: state.fallbackUntil,
				consecutiveSseSuccesses: state.consecutiveSseSuccesses,
				websocketFailures: state.websocketFailures,
				lastFailure: state.lastFailure,
				lastFailureAt: state.lastFailureAt,
				...capacityStatus,
			};
		},
		reset(sessionId) {
			if (sessionId) {
				advanceGeneration(sessionId);
				states.delete(sessionId);
				capacityStates.delete(sessionId);
				cancelCapacityWaiters(sessionId);
				forcedProbeSessions.add(sessionId);
				return;
			}
			for (const activeSessionId of activeSessions) {
				advanceGeneration(activeSessionId);
				cancelCapacityWaiters(activeSessionId);
				forcedProbeSessions.add(activeSessionId);
			}
			states.clear();
			capacityStates.clear();
		},
	};
}
