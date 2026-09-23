import { isAbsolute, relative, resolve } from "node:path";
import type { ProviderId } from "./image-provider.ts";

export const IMAGE_HISTORY_ENTRY = "pi-sinan-image-history";
export interface ImageHistoryItem {
	id: string;
	prompt: string;
	provider: ProviderId;
	aspect?: string;
	path: string;
	workspace: string;
	createdAt: number;
}
export function sessionImageHistory(branch: readonly unknown[], cwd: string): ImageHistoryItem[] {
	const workspace = resolve(cwd);
	return branch.flatMap((entry): ImageHistoryItem[] => {
		if (!entry || typeof entry !== "object") return [];
		const record = entry as { type?: unknown; customType?: unknown; data?: unknown };
		if (record.type !== "custom" || record.customType !== IMAGE_HISTORY_ENTRY || !record.data || typeof record.data !== "object") return [];
		const item = record.data as ImageHistoryItem;
		if (typeof item.id !== "string" || typeof item.prompt !== "string" || !["xai", "openai"].includes(item.provider) || typeof item.path !== "string" || !isAbsolute(item.path) || item.workspace !== workspace || (item.aspect !== undefined && typeof item.aspect !== "string")) return [];
		const inside = relative(workspace, resolve(item.path));
		if (!inside || inside.startsWith("..") || isAbsolute(inside)) return [];
		return [item];
	});
}
