import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createCodexRecoveryController,
	type CodexRecoveryController,
	type CodexRecoveryStatus,
} from "../src/openai-codex-recovery.ts";

function statusText(status: CodexRecoveryStatus): string {
	const parts = [
		`mode=${status.mode}`,
		`sseSuccesses=${status.consecutiveSseSuccesses}`,
		`websocketFailures=${status.websocketFailures}`,
	];
	if (status.fallbackUntil) parts.push(`fallbackUntil=${new Date(status.fallbackUntil).toISOString()}`);
	if (status.lastFailure) parts.push(`lastFailure=${status.lastFailure}`);
	return parts.join(" ");
}

export default function (pi: ExtensionAPI) {
	let recovery: CodexRecoveryController | undefined;

	pi.on("session_start", (_event, ctx) => {
		const effectiveProvider = ctx.modelRegistry.getProvider("openai-codex");
		if (!effectiveProvider) {
			ctx.ui.notify("pi-access: openai-codex provider is unavailable; transport recovery was not installed.", "warning");
			return;
		}
		recovery = createCodexRecoveryController({}, {
			baseProvider: effectiveProvider as Provider<"openai-codex-responses">,
		});
		pi.registerProvider(recovery.provider);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		recovery?.reset(ctx.sessionManager.getSessionId());
		recovery = undefined;
	});

	pi.registerCommand("codex-recovery", {
		description: "Show or reset adaptive OpenAI Codex WebSocket/SSE recovery state",
		handler: async (args, ctx) => {
			const sessionId = ctx.sessionManager.getSessionId();
			if (!recovery) {
				ctx.ui.notify("OpenAI Codex transport recovery is not active in this session.", "warning");
				return;
			}
			if (args.trim() === "reset") {
				recovery.reset(sessionId);
				ctx.ui.notify("OpenAI Codex transport recovery state reset; auto mode will prefer WebSocket again.", "info");
				return;
			}
			ctx.ui.notify(statusText(recovery.getStatus(sessionId)), "info");
		},
	});
}
