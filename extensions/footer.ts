/** Package-local footer integrating pi-sinan usage with Pi's native session statistics. */
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatTokenCount, mergeFooterStatuses, oneLine } from "../src/footer.ts";

function namespacedFooterEnabled(path: string): boolean | undefined {
	try {
		const root = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const sinan = root.piSinan && typeof root.piSinan === "object" && !Array.isArray(root.piSinan) ? root.piSinan as Record<string, unknown> : undefined;
		const footer = sinan?.footer && typeof sinan.footer === "object" && !Array.isArray(sinan.footer) ? sinan.footer as Record<string, unknown> : undefined;
		return typeof footer?.enabled === "boolean" ? footer.enabled : undefined;
	} catch { return undefined; }
}

export default function footerExtension(pi: ExtensionAPI): void {
	const settingsCache = new Map<string, { stamp: string; enabled: boolean | undefined }>();
	function readAutoCompact(path: string): boolean | undefined {
		try {
			const stat = statSync(path);
			const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
			const cached = settingsCache.get(path);
			if (cached?.stamp === stamp) return cached.enabled;
			const value = (JSON.parse(readFileSync(path, "utf8")) as { compaction?: { enabled?: unknown } }).compaction?.enabled;
			const enabled = typeof value === "boolean" ? value : undefined;
			settingsCache.set(path, { stamp, enabled });
			return enabled;
		} catch { settingsCache.delete(path); return undefined; }
	}
	function autoCompactEnabled(ctx: ExtensionContext): boolean {
		const global = readAutoCompact(join(getAgentDir(), "settings.json"));
		const project = ctx.isProjectTrusted() ? readAutoCompact(join(ctx.cwd, ".pi", "settings.json")) : undefined;
		return project ?? global ?? true;
	}
	function footerEnabled(ctx: ExtensionContext): boolean {
		const global = namespacedFooterEnabled(join(getAgentDir(), "settings.json"));
		const project = ctx.isProjectTrusted() ? namespacedFooterEnabled(join(ctx.cwd, ".pi", "settings.json")) : undefined;
		return project ?? global ?? true;
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !footerEnabled(ctx)) return;
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose: unsubscribe,
				invalidate() {},
				render(width: number): string[] {
					if (width < 1) return ["", ""];
					const dim = (text: string) => theme.fg("dim", text);
					const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
					let cacheHitRate: number | undefined;
					for (const entry of ctx.sessionManager.getEntries()) {
						const usage = entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")
							? entry.message.usage
							: entry.type === "compaction" || entry.type === "branch_summary" ? entry.usage : undefined;
						if (usage) {
							totals.input += usage.input; totals.output += usage.output;
							totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.cost += usage.cost.total;
						}
						if (entry.type === "message" && entry.message.role === "assistant") {
							const current = entry.message.usage;
							const prompt = current.input + current.cacheRead + current.cacheWrite;
							cacheHitRate = prompt > 0 ? 100 * current.cacheRead / prompt : undefined;
						}
					}
					let cwd = ctx.sessionManager.getCwd();
					const home = process.env.HOME || process.env.USERPROFILE;
					if (home) {
						const local = relative(home, cwd);
						if (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) cwd = local ? `~${sep}${local}` : "~";
					}
					const branch = footerData.getGitBranch();
					const name = ctx.sessionManager.getSessionName();
					const directory = oneLine(`${cwd}${branch ? ` (${branch})` : ""}${name ? ` • ${name}` : ""}`);
					const model = ctx.model;
					const context = ctx.getContextUsage();
					const percent = context?.percent;
					const window = formatTokenCount(context?.contextWindow ?? model?.contextWindow ?? 0);
					const contextText = `${percent == null ? "?" : `${percent.toFixed(1)}%`}/${window}${autoCompactEnabled(ctx) ? " (auto)" : ""}`;
					const contextStat = theme.fg((percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "dim", contextText);
					const tokenStats: string[] = [];
					if (totals.input) tokenStats.push(`↑${formatTokenCount(totals.input)}`);
					if (totals.output) tokenStats.push(`↓${formatTokenCount(totals.output)}`);
					const stats = [...tokenStats];
					if (totals.cacheRead) stats.push(`R${formatTokenCount(totals.cacheRead)}`);
					if (totals.cacheWrite) stats.push(`W${formatTokenCount(totals.cacheWrite)}`);
					if ((totals.cacheRead || totals.cacheWrite) && cacheHitRate !== undefined) stats.push(`CH${cacheHitRate.toFixed(1)}%`);
					const subscription = Boolean(model && ctx.modelRegistry.isUsingOAuth(model));
					if (totals.cost || subscription) stats.push(`$${totals.cost.toFixed(3)}${subscription ? " (sub)" : ""}`);
					const merged = mergeFooterStatuses(footerData.getExtensionStatuses());
					const quotaSuffix = merged.usage ? `  ${merged.usage}` : "";
					const thinking = pi.getThinkingLevel();
					const modelText = `${model?.id ?? "no-model"}${model?.reasoning ? ` • ${thinking === "off" ? "thinking off" : thinking}` : ""}`;
					const rightOptions = footerData.getAvailableProviderCount() > 1 && model ? [`(${model.provider}) ${modelText}`, modelText] : [modelText];
					const leftOptions = [
						`${stats.length ? `${dim(stats.join(" "))} ` : ""}${contextStat}${quotaSuffix}`,
						`${tokenStats.length ? `${dim(tokenStats.join(" "))} ` : ""}${contextStat}${quotaSuffix}`,
						`${contextStat}${quotaSuffix}`,
					];
					let statsLine: string | undefined;
					for (const left of leftOptions) {
						for (const right of rightOptions) {
							const padding = width - visibleWidth(left) - visibleWidth(right);
							if (padding >= 2) { statsLine = left + " ".repeat(padding) + dim(right); break; }
						}
						if (statsLine !== undefined) break;
					}
					if (statsLine === undefined) {
						const left = truncateToWidth(merged.usage || contextStat, width, "…");
						const room = width - visibleWidth(left) - 2;
						statsLine = room > 0 ? `${left}  ${dim(truncateToWidth(modelText, room, "…"))}` : left;
					}
					const lines = [truncateToWidth(dim(directory), width, "…"), truncateToWidth(statsLine, width, "…")];
					if (merged.others.length) lines.push(truncateToWidth(merged.others.join(" "), width, "…"));
					return lines;
				},
			};
		});
	});
}
