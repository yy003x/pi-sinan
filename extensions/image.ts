/**
 * Image generation extension for the pi-access package.
 * Uses an existing xAI SuperGrok/X Premium subscription or OpenAI API key.
 * OpenAI Codex ChatGPT OAuth cannot call the Images API.
 * This file is one extension in a multi-extension package, not a standalone product.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Type } from "typebox";
import {
	defineTool,
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Image, Text } from "@earendil-works/pi-tui";

const XAI_DEFAULT_MODEL = "grok-imagine-image-2.0";
const XAI_MODELS = new Set([
	"grok-imagine-image-2.0",
	"grok-imagine-image",
	"grok-imagine-image-quality",
]);
const OPENAI_DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const OPENAI_MODELS = new Set([
	"gpt-image-2.5-sunburst",
	"gpt-image-2.5-flare",
]);
const ASPECTS = new Set([
	"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2",
	"9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "21:9", "5:2", "auto",
]);

type ProviderId = "xai" | "openai";

const SETTINGS_KEY = "piAccess";
const ENTRY_TYPE = "pi-access-image";

interface ImageAccessSettings {
	showInConversation?: boolean;
}

interface GeneratedImage {
	path: string;
	provider: ProviderId;
	model: string;
	bytes: number;
	dataBase64: string;
}

function readImageSettings(): ImageAccessSettings {
	try {
		const raw = JSON.parse(readFileSync(join(getAgentDir(), "settings.json"), "utf8")) as Record<string, unknown>;
		const root = raw[SETTINGS_KEY];
		if (!root || typeof root !== "object" || Array.isArray(root)) return {};
		const image = (root as Record<string, unknown>).image;
		if (!image || typeof image !== "object" || Array.isArray(image)) return {};
		const show = (image as Record<string, unknown>).showInConversation;
		return typeof show === "boolean" ? { showInConversation: show } : {};
	} catch {
		return {};
	}
}

function showInConversation(override?: boolean): boolean {
	if (typeof override === "boolean") return override;
	const value = readImageSettings().showInConversation;
	return value !== false;
}

function writeShowInConversation(enabled: boolean): void {
	const path = join(getAgentDir(), "settings.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const root = raw[SETTINGS_KEY] && typeof raw[SETTINGS_KEY] === "object" && !Array.isArray(raw[SETTINGS_KEY])
		? { ...(raw[SETTINGS_KEY] as Record<string, unknown>) }
		: {};
	const image = root.image && typeof root.image === "object" && !Array.isArray(root.image)
		? { ...(root.image as Record<string, unknown>) }
		: {};
	image.showInConversation = enabled;
	root.image = image;
	raw[SETTINGS_KEY] = root;
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function outputPath(cwd: string, path?: string): string {
	const raw = (path ?? `generated-images/${stamp()}.png`).trim().replace(/^@/, "");
	if (!raw) throw new Error("output path must not be empty");
	const resolved = isAbsolute(raw) ? raw : resolve(cwd, raw);
	const root = resolve(cwd);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		throw new Error("output path must stay inside the current workspace");
	}
	return resolved;
}

function errorMessage(parsed: Record<string, unknown>, fallback: string): string {
	const err = parsed.error;
	if (typeof err === "string") return err;
	if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
	return fallback;
}

async function providerAuth(ctx: ExtensionContext, provider: string): Promise<{ apiKey: string; baseUrl?: string } | undefined> {
	const status = ctx.modelRegistry.getProviderAuthStatus(provider);
	if (status && status.configured === false) return undefined;
	const auth = await ctx.modelRegistry.getProviderAuth(provider);
	const apiKey = auth?.auth.apiKey ?? await ctx.modelRegistry.getApiKeyForProvider(provider);
	if (!apiKey) return undefined;
	return { apiKey, baseUrl: auth?.auth.baseUrl };
}

async function resolveProvider(ctx: ExtensionContext, requested?: string): Promise<ProviderId> {
	if (requested === "openai") {
		if (await providerAuth(ctx, "openai")) return "openai";
		throw new Error("OpenAI image generation needs an API key (/login openai or OPENAI_API_KEY). ChatGPT/Codex OAuth cannot call the Images API.");
	}
	if (requested === "xai" || requested === undefined || requested === "auto") {
		if (await providerAuth(ctx, "xai")) return "xai";
		if (requested === "xai") {
			throw new Error("xAI is not configured. Run /login xai (SuperGrok / X Premium) or set XAI_API_KEY.");
		}
		if (await providerAuth(ctx, "openai")) return "openai";
		throw new Error("No image provider. Configure xAI (/login xai) or an OpenAI API key. Codex ChatGPT OAuth is not enough.");
	}
	throw new Error(`unsupported provider: ${requested}`);
}

async function postJson(url: string, apiKey: string, body: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal,
	});
	const text = await response.text();
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`image API returned non-JSON (HTTP ${response.status})`);
	}
	if (!response.ok) {
		throw new Error(`image generation failed (HTTP ${response.status}): ${errorMessage(parsed, text.slice(0, 300))}`);
	}
	return parsed;
}

async function decodeImage(parsed: Record<string, unknown>): Promise<Buffer> {
	const data = Array.isArray(parsed.data) ? parsed.data[0] as Record<string, unknown> | undefined : undefined;
	if (typeof data?.b64_json === "string") {
		const bytes = Buffer.from(data.b64_json, "base64");
		if (bytes.length < 32) throw new Error("image payload too small");
		return bytes;
	}
	if (typeof data?.url === "string") {
		const response = await fetch(data.url);
		if (!response.ok) throw new Error(`failed to download image URL (HTTP ${response.status})`);
		const bytes = Buffer.from(await response.arrayBuffer());
		if (bytes.length < 32) throw new Error("downloaded image too small");
		return bytes;
	}
	throw new Error("image API did not return b64_json or url");
}

async function generate(input: {
	prompt: string;
	provider?: string;
	model?: string;
	aspect?: string;
	path: string;
	signal?: AbortSignal;
	ctx: ExtensionContext;
}): Promise<GeneratedImage> {
	const provider = await resolveProvider(input.ctx, input.provider);
	if (input.aspect && !ASPECTS.has(input.aspect)) {
		throw new Error(`unsupported aspect_ratio: ${input.aspect}`);
	}
	let bytes: Buffer;
	let model: string;
	if (provider === "xai") {
		model = input.model ?? XAI_DEFAULT_MODEL;
		if (!XAI_MODELS.has(model)) throw new Error(`unsupported xAI image model: ${model}`);
		const auth = await providerAuth(input.ctx, "xai");
		if (!auth) throw new Error("xAI auth disappeared");
		const baseUrl = (auth.baseUrl ?? "https://api.x.ai/v1").replace(/\/$/, "");
		const parsed = await postJson(`${baseUrl}/images/generations`, auth.apiKey, {
			model,
			prompt: input.prompt,
			n: 1,
			response_format: "b64_json",
			...(input.aspect ? { aspect_ratio: input.aspect } : {}),
		}, input.signal);
		bytes = await decodeImage(parsed);
	} else {
		model = input.model ?? OPENAI_DEFAULT_MODEL;
		if (!OPENAI_MODELS.has(model)) throw new Error(`unsupported OpenAI image model: ${model}`);
		const auth = await providerAuth(input.ctx, "openai");
		if (!auth) throw new Error("OpenAI API key auth disappeared");
		const baseUrl = (auth.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
		const parsed = await postJson(`${baseUrl}/images/generations`, auth.apiKey, {
			model,
			prompt: input.prompt,
			n: 1,
			...(input.aspect && input.aspect !== "auto" ? { size: input.aspect === "16:9" ? "1536x1024" : input.aspect === "9:16" ? "1024x1536" : "1024x1024" } : {}),
		}, input.signal);
		bytes = await decodeImage(parsed);
	}
	await withFileMutationQueue(input.path, async () => {
		await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
		await writeFile(input.path, bytes, { mode: 0o600 });
	});
	return {
		path: input.path,
		provider,
		model,
		bytes: bytes.length,
		dataBase64: bytes.toString("base64"),
	};
}

function parseCommand(args: string): {
	prompt: string;
	path?: string;
	aspect?: string;
	provider?: string;
	preview?: boolean;
} {
	let preview: boolean | undefined;
	if (/(?:^|\s)--no-preview(?:\s|$)/.test(args)) preview = false;
	else if (/(?:^|\s)--preview(?:\s|$)/.test(args)) preview = true;
	const pathMatch = args.match(/\s--path\s+(\S+)/);
	const aspectMatch = args.match(/\s--aspect\s+(\S+)/);
	const providerMatch = args.match(/\s--provider\s+(\S+)/);
	const prompt = args
		.replace(/\s--path\s+\S+/g, "")
		.replace(/\s--aspect\s+\S+/g, "")
		.replace(/\s--provider\s+\S+/g, "")
		.replace(/\s--no-preview\b/g, "")
		.replace(/\s--preview\b/g, "")
		.trim();
	return {
		prompt,
		path: pathMatch?.[1],
		aspect: aspectMatch?.[1],
		provider: providerMatch?.[1],
		...(preview !== undefined ? { preview } : {}),
	};
}

const generateImageTool = defineTool({
	name: "generate_image",
	label: "Generate Image",
	description: "Generate one image with the signed-in xAI SuperGrok/X Premium subscription or an OpenAI API key, then save a PNG in the workspace. ChatGPT/Codex OAuth cannot generate images.",
	promptSnippet: "Generate an image via xAI Imagine or OpenAI Images and save a PNG locally",
	promptGuidelines: [
		"Use generate_image when the user asks to create, draw, or generate an image file.",
		"generate_image uses existing Pi login: xAI subscription/API key, or OpenAI API key. Do not ask for a new key if those are configured.",
		"OpenAI Codex/ChatGPT OAuth cannot generate images. Do not switch to gpt-6-astra hoping it will emit a PNG.",
		"After generate_image succeeds, report the saved path and which provider produced it.",
		"generate_image may attach the PNG in the conversation when piAccess.image.showInConversation is true; do not set show_in_conversation unless the user asked to override that setting.",
	],
	parameters: Type.Object({
		prompt: Type.String({ description: "Image prompt" }),
		path: Type.Optional(Type.String({ description: "Workspace-relative PNG path. Default: generated-images/<timestamp>.png" })),
		aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio such as 1:1, 16:9, 9:16, auto" })),
		provider: Type.Optional(Type.String({ description: "xai, openai, or auto (default auto)" })),
		model: Type.Optional(Type.String({ description: "Provider image model override" })),
		show_in_conversation: Type.Optional(Type.Boolean({ description: "Override piAccess.image.showInConversation for this call" })),
	}),
	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		const path = outputPath(ctx.cwd, params.path);
		onUpdate?.({ content: [{ type: "text", text: "Generating image…" }] });
		const result = await generate({
			prompt: params.prompt,
			provider: params.provider,
			model: params.model,
			aspect: params.aspect_ratio,
			path,
			signal,
			ctx,
		});
		const preview = showInConversation(params.show_in_conversation);
		const summary = `Generated with ${result.provider}/${result.model}: ${result.path} (${result.bytes} bytes)`;
		return {
			content: preview
				? [
					{ type: "text" as const, text: summary },
					{ type: "image" as const, data: result.dataBase64, mimeType: "image/png" },
				]
				: [{ type: "text" as const, text: summary }],
			details: { path: result.path, provider: result.provider, model: result.model, bytes: result.bytes, showInConversation: preview },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(generateImageTool);
	pi.registerEntryRenderer<{ path: string; provider: string; model: string }>(ENTRY_TYPE, (entry, _opts, theme) => {
		const data = entry.data ?? { path: "", provider: "xai", model: "" };
		const box = new Box(0, 0);
		box.addChild(new Text(`${theme.fg("accent", "[image]")} ${data.provider}/${data.model} ${data.path}`, 0, 0));
		if (showInConversation() && data.path && existsSync(data.path)) {
			const dataBase64 = readFileSync(data.path).toString("base64");
			box.addChild(new Image(dataBase64, "image/png", { fallbackColor: (s) => theme.fg("dim", s) }));
		}
		return box;
	});
	pi.registerCommand("image", {
		description: "Generate an image: /image <prompt> [--path file.png] [--aspect 16:9] [--provider xai|openai] [--preview|--no-preview]. /image config [on|off] toggles conversation preview.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "config" || trimmed.startsWith("config ")) {
				const rest = trimmed.slice("config".length).trim();
				if (rest === "on" || rest === "off") {
					writeShowInConversation(rest === "on");
					ctx.ui.notify(`piAccess.image.showInConversation = ${rest === "on"}`, "success");
					return;
				}
				ctx.ui.notify(`piAccess.image.showInConversation = ${showInConversation()} (default true). /image config on|off`, "info");
				return;
			}
			const parsed = parseCommand(trimmed);
			if (!parsed.prompt) {
				ctx.ui.notify("Usage: /image <prompt> [--path file.png] [--aspect 16:9] [--provider xai|openai] [--preview|--no-preview]", "warning");
				return;
			}
			try {
				const result = await generate({
					prompt: parsed.prompt,
					provider: parsed.provider,
					aspect: parsed.aspect,
					path: outputPath(ctx.cwd, parsed.path),
					ctx,
				});
				const preview = showInConversation(parsed.preview);
				if (preview) {
					pi.appendEntry(ENTRY_TYPE, { path: result.path, provider: result.provider, model: result.model });
				}
				ctx.ui.notify(`Saved ${result.path} (${result.provider}/${result.model})${preview ? " · shown in chat" : ""}`, "success");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
