import { USAGE_STATUS_KEY } from "./usage.ts";

export function oneLine(text: string): string {
	return text.replace(/[\r\n\t]/gu, " ").replace(/ +/gu, " ").trim();
}

export function mergeFooterStatuses(statuses: ReadonlyMap<string, string>): { usage: string; others: string[] } {
	return {
		usage: oneLine(statuses.get(USAGE_STATUS_KEY) ?? ""),
		others: [...statuses.entries()]
			.filter(([key]) => key !== USAGE_STATUS_KEY)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([, text]) => oneLine(text))
			.filter(Boolean),
	};
}

export function formatTokenCount(count: number): string {
	if (count < 1_000) return String(count);
	if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}
