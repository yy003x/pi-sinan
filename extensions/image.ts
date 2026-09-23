/**
 * Image generation extension for the pi-sinan package.
 * Uses an existing xAI SuperGrok/X Premium or OpenAI ChatGPT/Codex subscription.
 * This file is one extension in a multi-extension package, not a standalone product.
 */
import { readFileSync, writeFileSync, realpathSync, lstatSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, relative, sep } from "node:path";
import { StringEnum, type Api, type Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	defineTool,
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text, getImageDimensions } from "@earendil-works/pi-tui";
import { createImageCardRenderer, normalizePng, type ImageCardData } from "../src/image-preview.ts";
import { IMAGE_HISTORY_ENTRY, sessionImageHistory, type ImageHistoryItem } from "../src/image-history.ts";
import {
	OPENAI_CODEX_IMAGE_MODEL,
	attemptImageProviders,
	imageRequestHeaders,
	openAICodexImageGenerationRequest,
	openAICodexImageGenerationUrl,
	xaiImageGenerationUrl,
	type CredentialProviderId,
	type ProviderId,
	type ProviderRequestAuth,
} from "../src/image-provider.ts";

const XAI_DEFAULT_MODEL = "grok-imagine-image-2.0";
const XAI_MODELS = new Set([
	"grok-imagine-image-2.0",
	"grok-imagine-image",
	"grok-imagine-image-quality",
]);
const OPENAI_MODELS = new Set([OPENAI_CODEX_IMAGE_MODEL]);
const ASPECTS = new Set([
	"1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2",
	"9:19.5", "19.5:9", "9:20", "20:9", "1:2", "2:1", "21:9", "5:2", "auto",
]);

const SETTINGS_KEY = "piSinan";
const ENTRY_TYPE = "pi-sinan-image";

const DEFAULT_OUTPUT_DIR = ".pi-images";

interface ImageAccessSettings {
	showInConversation?: boolean;
	outputDir?: string;
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
		const outputDir = (image as Record<string, unknown>).outputDir;
		return {
			...(typeof show === "boolean" ? { showInConversation: show } : {}),
			...(typeof outputDir === "string" && outputDir.trim() ? { outputDir: outputDir.trim() } : {}),
		};
	} catch {
		return {};
	}
}

function showInConversation(override?: boolean): boolean {
	if (typeof override === "boolean") return override;
	const value = readImageSettings().showInConversation;
	return value !== false;
}

function writeImageSettings(patch: ImageAccessSettings): void {
	const path = join(getAgentDir(), "settings.json");
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
	const root = raw[SETTINGS_KEY] && typeof raw[SETTINGS_KEY] === "object" && !Array.isArray(raw[SETTINGS_KEY])
		? { ...(raw[SETTINGS_KEY] as Record<string, unknown>) }
		: {};
	const image = root.image && typeof root.image === "object" && !Array.isArray(root.image)
		? { ...(root.image as Record<string, unknown>) }
		: {};
	if (patch.showInConversation !== undefined) image.showInConversation = patch.showInConversation;
	if (patch.outputDir !== undefined) image.outputDir = patch.outputDir;
	root.image = image;
	raw[SETTINGS_KEY] = root;
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);
}

function workspaceDir(cwd: string, dir: string): string {
	const trimmed = dir.trim().replace(/^@/, "");
	if (!trimmed || trimmed.includes("\0")) throw new Error("outputDir must be a non-empty path");
	const resolved = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
	const root = resolve(cwd);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		throw new Error("outputDir must stay inside the current workspace");
	}
	return resolved;
}

function stamp(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${randomUUID()}`;
}

function outputPath(cwd: string, path?: string): string {
	const raw = (path ?? join(readImageSettings().outputDir ?? DEFAULT_OUTPUT_DIR, `${stamp()}.png`)).trim().replace(/^@/, "");
	if (!raw) throw new Error("output path must not be empty");
	const resolved = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);
	const root = resolve(cwd);
	if (resolved !== root && !resolved.startsWith(`${root}/`)) {
		throw new Error("output path must stay inside the current workspace");
	}
	return resolved;
}

function assertWorkspaceOutputParent(cwd: string, target: string): void {
	const root = realpathSync(cwd);
	let parent = dirname(target);
	while (!lstatSync(parent, { throwIfNoEntry: false })) {
		const next = dirname(parent);
		if (next === parent) throw new Error("Cannot find an existing output directory.");
		parent = next;
	}
	const within = relative(root, realpathSync(parent));
	if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
		throw new Error("Output directory escapes the workspace.");
	}
}

function errorMessage(parsed: Record<string, unknown>, fallback: string): string {
	const err = parsed.error;
	if (typeof err === "string") return err;
	if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
	return fallback;
}

function redactProviderError(message: string, auth: ProviderRequestAuth): string {
	let redacted = message;
	const secrets = [auth.apiKey, ...Object.values(auth.headers ?? {})]
		.filter((value): value is string => typeof value === "string" && value.length > 0);
	for (const secret of [...new Set(secrets)].sort((left, right) => right.length - left.length)) {
		redacted = redacted.replaceAll(secret, "[redacted]");
	}
	return redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]").slice(0, 600);
}

function thrownErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	try {
		return String(error);
	} catch {
		return "unknown network error";
	}
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	return (signal?.aborted === true && error === signal.reason)
		|| (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"));
}

function imageAuthFailure(provider: CredentialProviderId): Error {
	const name = provider === "xai" ? "xAI" : "OpenAI Codex";
	return new Error(`${name} subscription authentication could not be resolved safely. Run /login and choose ${name}.`);
}

export async function resolveImageAuth(ctx: ExtensionContext, provider: CredentialProviderId): Promise<ProviderRequestAuth | undefined> {
	try {
		const models = ctx.modelRegistry.getAll() as Model<Api>[];
		const oauthModel = models.find((model) => model.provider === provider && ctx.modelRegistry.isUsingOAuth(model));
		if (!oauthModel) return undefined;
		const result = await ctx.modelRegistry.getProviderAuth(provider);
		if (!result?.auth.apiKey) return undefined;
		return {
			apiKey: result.auth.apiKey,
			baseUrl: result.auth.baseUrl,
			headers: result.auth.headers,
		};
	} catch {
		// Provider resolvers may include credentials or request details in errors.
		// Never allow those details to cross the extension boundary.
		throw imageAuthFailure(provider);
	}
}

async function postJson(
	url: string,
	auth: ProviderRequestAuth,
	body: unknown,
	signal?: AbortSignal,
	extraHeaders?: Record<string, string>,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			headers: imageRequestHeaders(auth, extraHeaders),
			body: JSON.stringify(body),
			signal,
			redirect: "error",
		});
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		throw new Error(`image request failed: ${redactProviderError(thrownErrorMessage(error), auth)}`);
	}
	let text: string;
	try {
		if (!response.body) throw new Error("empty image response");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let size = 0;
		const max = response.ok ? 32 * 1024 * 1024 : 4096;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				if (size > max) { await reader.cancel(); throw new Error("image response exceeded size limit"); }
				chunks.push(value);
			}
		} finally { reader.releaseLock(); }
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
		text = new TextDecoder().decode(bytes);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		throw new Error(`image response read failed: ${redactProviderError(thrownErrorMessage(error), auth)}`);
	}
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(text) as Record<string, unknown>;
	} catch {
		throw new Error(`image API returned non-JSON (HTTP ${response.status})`);
	}
	if (!response.ok) {
		throw new Error(`image generation failed (HTTP ${response.status}): ${redactProviderError(errorMessage(parsed, text.slice(0, 300)), auth)}`);
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
		throw new Error("image API returned a URL-only payload; only inline b64_json is accepted");
	}
	throw new Error("image API did not return the required b64_json payload");
}

interface ImageGenerationInput {
	prompt: string;
	provider?: string;
	model?: string;
	aspect?: string;
	path: string;
	signal?: AbortSignal;
	ctx: ExtensionContext;
	requestId: string;
}

async function requestImage(
	input: ImageGenerationInput,
	provider: ProviderId,
	auth: ProviderRequestAuth,
): Promise<{ bytes: Buffer; model: string }> {
	if (provider === "xai") {
		const model = input.model ?? XAI_DEFAULT_MODEL;
		if (!XAI_MODELS.has(model)) throw new Error(`unsupported xAI image model: ${model}`);
		const parsed = await postJson(xaiImageGenerationUrl(auth.baseUrl), auth, {
			model,
			prompt: input.prompt,
			n: 1,
			response_format: "b64_json",
			...(input.aspect ? { aspect_ratio: input.aspect } : {}),
		}, input.signal);
		return { bytes: await decodeImage(parsed), model };
	}

	const model = input.model ?? OPENAI_CODEX_IMAGE_MODEL;
	if (!OPENAI_MODELS.has(model)) throw new Error(`unsupported OpenAI subscription image model: ${model}`);
	const parsed = await postJson(
		openAICodexImageGenerationUrl(auth.baseUrl),
		auth,
		openAICodexImageGenerationRequest(input.prompt, input.aspect),
		input.signal,
		{
			originator: "pi-sinan",
			"x-codex-image-turn-id": input.requestId,
		},
	);
	return { bytes: await decodeImage(parsed), model };
}

async function generate(input: ImageGenerationInput): Promise<GeneratedImage> {
	if (lstatSync(input.path, { throwIfNoEntry: false })) throw new Error("Output image already exists; choose a new path before spending quota.");
	assertWorkspaceOutputParent(input.ctx.cwd, input.path);
	if (input.aspect && !ASPECTS.has(input.aspect)) {
		throw new Error(`unsupported aspect_ratio: ${input.aspect}`);
	}
	const generated = await attemptImageProviders(
		input.provider,
		(credentialProvider) => resolveImageAuth(input.ctx, credentialProvider),
		({ provider, auth }) => requestImage(input, provider, auth),
		() => input.signal?.aborted === true,
	);
	let { bytes } = generated.value;
	// Provider fallback ends once image bytes exist: normalization/write failures must not spend a second subscription.
	bytes = await normalizePng(bytes);
	await withFileMutationQueue(input.path, async () => {
		assertWorkspaceOutputParent(input.ctx.cwd, input.path);
		await mkdir(dirname(input.path), { recursive: true, mode: 0o700 });
		assertWorkspaceOutputParent(input.ctx.cwd, input.path);
		await writeFile(input.path, bytes, { mode: 0o600, flag: "wx" });
	});
	return {
		path: input.path,
		provider: generated.provider,
		model: generated.value.model,
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

async function cardData(result: GeneratedImage, preview: boolean): Promise<ImageCardData> {
	const size = getImageDimensions(result.dataBase64, "image/png");
	if (!size) throw new Error("Cannot determine saved PNG dimensions");
	return {
		id: randomUUID(), path: result.path, provider: result.provider, model: result.model,
		bytes: result.bytes, width: size.widthPx, height: size.heightPx,
		showInConversation: preview,
	};
}

export default function (pi: ExtensionAPI) {
	const cards = createImageCardRenderer(() => showInConversation());
	const branchAnchor = (ctx: ExtensionContext) => ({ sessionFile: ctx.sessionManager?.getSessionFile?.(), leafId: ctx.sessionManager?.getLeafId?.() });
	const remember = (ctx: ExtensionContext, prompt: string, aspect: string | undefined, result: GeneratedImage, anchor: ReturnType<typeof branchAnchor>) => {
		if (anchor.sessionFile !== ctx.sessionManager?.getSessionFile?.() ||
			(anchor.leafId && !ctx.sessionManager.getBranch().some((entry) => entry.id === anchor.leafId))) return;
		pi.appendEntry(IMAGE_HISTORY_ENTRY, { id: randomUUID(), prompt, provider: result.provider, ...(aspect ? { aspect } : {}), path: result.path, workspace: resolve(ctx.cwd), createdAt: Date.now() } satisfies ImageHistoryItem);
	};
	pi.on("session_start", () => cards.reset());
	pi.on("session_tree", () => cards.reset());
	pi.on("session_shutdown", () => cards.reset());

	const generateImageTool = defineTool({
	name: "generate_image",
	label: "Generate Image",
	description: "Generate one image with a signed-in xAI SuperGrok/X Premium or OpenAI ChatGPT/Codex subscription, then save a PNG in the workspace.",
	promptSnippet: "Generate an image via an xAI or OpenAI subscription and save a PNG locally",
	promptGuidelines: [
		"Use generate_image when the user asks to create, draw, or generate an image file.",
		"generate_image uses existing Pi subscription login: xAI first, then OpenAI Codex when provider is auto. Do not ask for an API key.",
		"When generate_image provider is explicitly xai or openai, do not silently switch providers after a failure.",
		"After generate_image succeeds, report the saved path and which provider produced it.",
		"generate_image shows the original image in the conversation when piSinan.image.showInConversation is true; do not set show_in_conversation unless the user asked to override that setting.",
		"generate_image returns file metadata, not image content to the model. Read the saved image only when visual inspection is needed.",
	],
	parameters: Type.Object({
		prompt: Type.String({ description: "Image prompt" }),
		path: Type.Optional(Type.String({ description: "Workspace-relative PNG path. Default: .pi-images/<timestamp>.png" })),
		aspect_ratio: Type.Optional(Type.String({ description: "Optional aspect ratio such as 1:1, 16:9, 9:16, auto" })),
		provider: Type.Optional(StringEnum(["auto", "xai", "openai"] as const, { description: "Subscription provider: auto (xAI then OpenAI), xai, or openai" })),
		model: Type.Optional(Type.String({ description: "Provider image model override" })),
		show_in_conversation: Type.Optional(Type.Boolean({ description: "Override piSinan.image.showInConversation for this call" })),
	}),
	async execute(toolCallId, params, signal, onUpdate, ctx) {
		const path = outputPath(ctx.cwd, params.path);
		const anchor = branchAnchor(ctx);
		onUpdate?.({ content: [{ type: "text", text: "Generating image…" }], details: undefined });
		const result = await generate({
			prompt: params.prompt,
			provider: params.provider,
			model: params.model,
			aspect: params.aspect_ratio,
			path,
			signal,
			ctx,
			requestId: toolCallId,
		});
		remember(ctx, params.prompt, params.aspect_ratio, result, anchor);
		const preview = showInConversation(params.show_in_conversation);
		const summary = `Generated with ${result.provider}/${result.model}: ${result.path} (${result.bytes} bytes)`;
		const details = await cardData(result, preview);
		cards.markLive(details);
		return { content: [{ type: "text" as const, text: summary }], details };
	},
	renderResult(result, { expanded, isPartial }, theme, context) {
		const data = result.details as ImageCardData | undefined;
		if (isPartial || !data?.path) {
			return new Text(result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), 0, 0);
		}
		return cards.render(data, expanded, theme, context.showImages);
	},
});

	pi.registerTool(generateImageTool);
	pi.registerEntryRenderer<ImageCardData>(ENTRY_TYPE, (entry, { expanded }, theme) => {
		if (!entry.data?.path) return new Text("[image] Missing file path", 0, 0);
		return cards.render(entry.data, expanded, theme);
	});
	pi.registerCommand("sn-image", {
		description: "Generate an image: /sn-image <prompt> [--path file.png] [--aspect 16:9] [--provider auto|xai|openai] [--preview|--no-preview]. /sn-image config [on|off|dir <path>] configures preview and output directory.",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (trimmed === "config" || trimmed.startsWith("config ")) {
				const rest = trimmed.slice("config".length).trim();
				if (rest === "on" || rest === "off") {
					writeImageSettings({ showInConversation: rest === "on" });
					ctx.ui.notify(`piSinan.image.showInConversation = ${rest === "on"}`, "info");
					return;
				}
				if (rest.startsWith("dir ") || rest === "dir") {
					const dir = rest.slice("dir".length).trim();
					if (!dir) {
						ctx.ui.notify(`piSinan.image.outputDir = ${readImageSettings().outputDir ?? DEFAULT_OUTPUT_DIR}`, "info");
						return;
					}
					workspaceDir(ctx.cwd, dir);
					writeImageSettings({ outputDir: dir });
					ctx.ui.notify(`piSinan.image.outputDir = ${dir}`, "info");
					return;
				}
				const currentDir = readImageSettings().outputDir ?? DEFAULT_OUTPUT_DIR;
				ctx.ui.notify(`showInConversation=${showInConversation()} outputDir=${currentDir}. /sn-image config on|off|dir <path>`, "info");
				return;
			}
			if (trimmed === "history") {
				const history = sessionImageHistory(ctx.sessionManager.getBranch(), ctx.cwd);
				ctx.ui.notify(history.length ? history.map((item, index) => `${index + 1}. ${item.id} · ${item.provider} ${item.path} · ${new Date(item.createdAt).toLocaleString()}`).join("\n") : "No images in the current session branch.", "info");
				return;
			}
			const historyCommand = /^(show|repeat)(?:\s+(\S+))?$/.exec(trimmed);
			if (historyCommand) {
				const history = sessionImageHistory(ctx.sessionManager.getBranch(), ctx.cwd);
				const id = historyCommand[2];
				const item = id ? /^\d+$/.test(id) ? history[Number(id) - 1] : history.find((entry) => entry.id === id) : history.at(-1);
				if (!item) { ctx.ui.notify("No such image in the current session branch.", "warning"); return; }
				try {
					if (historyCommand[1] === "show") {
						const actual = realpathSync(item.path);
						const within = relative(realpathSync(ctx.cwd), actual);
						if (!within || within.startsWith("..") || isAbsolute(within) || !lstatSync(item.path).isFile()) throw new Error("Session image path is no longer a regular workspace file.");
						const size = statSync(item.path).size;
						if (size <= 0 || size > 8 * 1024 * 1024) throw new Error("Session image exceeds the preview size limit.");
						const bytes = readFileSync(item.path);
						if (bytes.length > 8 * 1024 * 1024) throw new Error("Session image exceeds the preview size limit.");
						const data = await cardData({ path: item.path, provider: item.provider, model: "saved image", bytes: bytes.length, dataBase64: bytes.toString("base64") }, true);
						pi.appendEntry(ENTRY_TYPE, data);
						ctx.ui.notify(`Showing ${item.path}`, "info");
					} else {
						const anchor = branchAnchor(ctx);
						const result = await generate({ prompt: item.prompt, provider: item.provider, aspect: item.aspect, path: outputPath(ctx.cwd), ctx, requestId: randomUUID() });
						remember(ctx, item.prompt, item.aspect, result, anchor);
						const data = await cardData(result, showInConversation());
						cards.markLive(data);
						pi.appendEntry(ENTRY_TYPE, data);
						ctx.ui.notify(`Repeated with ${item.provider}; subscription quota spent: ${result.path}`, "info");
					}
				} catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Image operation failed.", "error"); }
				return;
			}
			const parsed = parseCommand(trimmed);
			if (!parsed.prompt) {
				ctx.ui.notify("Usage: /sn-image <prompt> [--path file.png] [--aspect 16:9] [--provider auto|xai|openai] [--preview|--no-preview]", "warning");
				return;
			}
			try {
				const anchor = branchAnchor(ctx);
				const result = await generate({
					prompt: parsed.prompt,
					provider: parsed.provider,
					aspect: parsed.aspect,
					path: outputPath(ctx.cwd, parsed.path),
					ctx,
					requestId: randomUUID(),
				});
				remember(ctx, parsed.prompt, parsed.aspect, result, anchor);
				const preview = showInConversation(parsed.preview);
				const data = await cardData(result, preview);
				cards.markLive(data);
				pi.appendEntry(ENTRY_TYPE, data);
				ctx.ui.notify(`Saved ${result.path} (${result.provider}/${result.model})`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
