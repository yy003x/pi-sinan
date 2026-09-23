import type { Provider } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCodexRecoveryController, type CodexRecoveryController, type CodexRecoveryStatus } from "../src/codex-recovery.ts";

export const RECOVERY_STATUS_EVENT = "pi-sinan/recovery-status/v1";
let currentRecovery: CodexRecoveryController | undefined;
export function codexRecoveryDiagnostic(sessionId: string): CodexRecoveryStatus | undefined { return currentRecovery?.getStatus(sessionId); }
export function safeRecoverySnapshot(status: CodexRecoveryStatus) {
	return {
		mode: status.mode,
		consecutiveSseSuccesses: status.consecutiveSseSuccesses,
		websocketFailures: status.websocketFailures,
		capacityFailures: status.capacityFailures,
		...(status.fallbackUntil ? { fallbackUntil: status.fallbackUntil } : {}),
		...(status.capacityCooldownUntil ? { capacityCooldownUntil: status.capacityCooldownUntil } : {}),
	};
}
export function safeRecoveryStatusText(status: CodexRecoveryStatus): string {
	const safe = safeRecoverySnapshot(status);
	return [`mode=${safe.mode}`, `sseSuccesses=${safe.consecutiveSseSuccesses}`, `websocketFailures=${safe.websocketFailures}`, `capacityFailures=${safe.capacityFailures}`, ...(safe.fallbackUntil ? [`fallbackUntil=${new Date(safe.fallbackUntil).toISOString()}`] : []), ...(safe.capacityCooldownUntil ? [`capacityCooldownUntil=${new Date(safe.capacityCooldownUntil).toISOString()}`] : [])].join(" ");
}
interface RecoveryAdapter {
	getStatus(sessionId: string): { text: string; status: ReturnType<typeof safeRecoverySnapshot> };
	reset(sessionId: string): void;
}
export default function (pi: ExtensionAPI) {
	let recovery: CodexRecoveryController | undefined;
	const adapters = new Map<string, RecoveryAdapter>();
	pi.on("session_start", (_event, ctx) => {
		const effectiveProvider = ctx.modelRegistry.getProvider("openai-codex");
		if (!effectiveProvider) return;
		recovery = createCodexRecoveryController({}, { baseProvider: effectiveProvider as Provider<"openai-codex-responses"> });
		currentRecovery = recovery;
		adapters.set("openai-codex", {
			getStatus(sessionId) {
				const status = recovery!.getStatus(sessionId);
				return { text: safeRecoveryStatusText(status), status: safeRecoverySnapshot(status) };
			},
			reset(sessionId) { recovery!.reset(sessionId); },
		});
		pi.registerProvider(recovery.provider);
	});
	pi.on("session_shutdown", (_event, ctx) => { recovery?.reset(ctx.sessionManager.getSessionId()); recovery = undefined; currentRecovery = undefined; adapters.clear(); });
	pi.registerCommand("sn-recovery", {
		description: "Read or reset provider recovery state: /sn-recovery status [provider] | reset [provider|all]",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const action = parts[0] || "status";
			const provider = parts[1] || "openai-codex";
			if (parts.length > 2 || !["status", "reset"].includes(action) || !["openai-codex", "xai", "all"].includes(provider)) { ctx.ui.notify("Usage: /sn-recovery status [openai-codex|xai|all] | reset [openai-codex|xai|all]", "warning"); return; }
			const sessionId = ctx.sessionManager.getSessionId();
			const rows: string[] = [];
			for (const id of provider === "all" ? ["openai-codex", "xai"] : [provider]) {
				const adapter = adapters.get(id);
				if (!adapter) {
					rows.push(`${id}: no transport recovery adapter${action === "reset" ? "; reset has no effect" : ""}`);
					pi.events.emit(RECOVERY_STATUS_EVENT, { v: 1, providerId: id, available: false, status: null });
					continue;
				}
				if (action === "reset") adapter.reset(sessionId);
				const { text, status } = adapter.getStatus(sessionId);
				rows.push(`${id}: ${text}`);
				pi.events.emit(RECOVERY_STATUS_EVENT, { v: 1, providerId: id, available: true, status });
			}
			ctx.ui.notify(`${action === "reset" ? "Recovery state reset where supported.\n" : ""}${rows.join("\n")}`, "info");
		},
	});
}
