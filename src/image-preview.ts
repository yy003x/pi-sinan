import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { convertToPng, type Theme } from "@earendil-works/pi-coding-agent";
import { Box, Image, Text, getCapabilities, getImageDimensions, hyperlink } from "@earendil-works/pi-tui";

const MAX_ORIGINAL_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;

export interface OriginalImage {
	data: string;
	mimeType: string;
}

export interface ImageCardData {
	id?: string;
	path: string;
	provider: string;
	model: string;
	bytes?: number;
	width?: number;
	height?: number;
	showInConversation?: boolean;
}

/** Inspect bytes, never the requested filename or a provider's claimed MIME. */
export function imageMimeType(bytes: Uint8Array): string {
	const b = Buffer.from(bytes);
	if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
	if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "image/jpeg";
	if (/^GIF8[79]a$/.test(b.toString("ascii", 0, 6))) return "image/gif";
	if (b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
	throw new Error("Image response is not a supported PNG, JPEG, GIF or WebP file");
}

function dimensions(image: OriginalImage) {
	const size = getImageDimensions(image.data, image.mimeType);
	if (!size || size.widthPx <= 0 || size.heightPx <= 0) throw new Error("Cannot determine image dimensions");
	return size;
}

export async function normalizePng(bytes: Uint8Array): Promise<Buffer> {
	const mimeType = imageMimeType(bytes);
	if (mimeType === "image/png") {
		dimensions({ data: Buffer.from(bytes).toString("base64"), mimeType });
		return Buffer.from(bytes);
	}
	const converted = await convertToPng(Buffer.from(bytes).toString("base64"), mimeType);
	if (!converted || imageMimeType(Buffer.from(converted.data, "base64")) !== "image/png") {
		throw new Error("Cannot convert image to PNG; no output file was written");
	}
	dimensions(converted);
	return Buffer.from(converted.data, "base64");
}

/** Shared by command entries and tool results. No image content is injected into model context. */
export function createImageCardRenderer(defaultPreview: () => boolean) {
	const live = new Set<string>();
	const expansion = new Map<string, boolean>();
	const fileCache = new Map<string, { version: string; image: OriginalImage }>();
	let cacheBytes = 0;

	function originalImage(path: string): OriginalImage {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_ORIGINAL_BYTES) throw new Error("Original image unavailable");
		const version = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const cached = fileCache.get(path);
		if (cached?.version === version) return cached.image;
		if (cached) {
			cacheBytes -= cached.image.data.length;
			fileCache.delete(path);
		}
		const bytes = readFileSync(path);
		const image = { data: bytes.toString("base64"), mimeType: imageMimeType(bytes) };
		dimensions(image);
		while (fileCache.size >= 8 || cacheBytes + image.data.length > MAX_CACHE_BYTES) {
			const oldest = fileCache.keys().next().value;
			if (oldest === undefined) break;
			cacheBytes -= fileCache.get(oldest)!.image.data.length;
			fileCache.delete(oldest);
		}
		fileCache.set(path, { version, image });
		cacheBytes += image.data.length;
		return image;
	}

	return {
		markLive(data: ImageCardData) { live.add(data.id ?? data.path); },
		reset() {
			live.clear();
			expansion.clear();
			fileCache.clear();
			cacheBytes = 0;
		},
		render(data: ImageCardData, expanded: boolean, theme: Theme, showImages = true) {
			const key = data.id ?? data.path;
			if (expansion.get(key) === true && !expanded) live.delete(key);
			expansion.set(key, expanded);
			const box = new Box(0, 0);
			const sizeLabel = data.width && data.height ? ` · ${data.width}×${data.height}` : "";
			box.addChild(new Text(`${theme.fg("accent", "[image]")} ${data.provider}/${data.model}${sizeLabel}`, 0, 0));
			box.addChild(new Text(hyperlink(data.path, pathToFileURL(data.path).href), 0, 0));
			const enabled = data.showInConversation ?? defaultPreview();
			if (!enabled || !showImages) return box;
			if (!expanded && !live.has(key)) {
				box.addChild(new Text(theme.fg("dim", "Ctrl+O to expand image"), 0, 0));
				return box;
			}
			try {
				const image = originalImage(data.path);
				const actualMime = imageMimeType(Buffer.from(image.data, "base64"));
				const size = dimensions({ ...image, mimeType: actualMime });
				if (getCapabilities().images === "kitty" && actualMime !== "image/png") throw new Error("PNG required");
				box.addChild(new Image(image.data, actualMime, { fallbackColor: (s) => theme.fg("dim", s) }, {
					maxWidthCells: 1000,
					maxHeightCells: 1000,
					filename: data.path,
				}, size));
			} catch {
				box.addChild(new Text(theme.fg("dim", "Image unavailable; open the original file above."), 0, 0));
			}
			return box;
		},
	};
}
