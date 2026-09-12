import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getImageDimensions, getPngDimensions, resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { createImageCardRenderer, createPreview, imageMimeType, normalizePng, type ImageCardData } from "../src/image-preview.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const PNG = readFileSync(join(fixtures, "1x1.png"));
const JPEG = readFileSync(join(fixtures, "tiny.jpg"));

function theme() {
	return { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, dim: (s: string) => s, italic: (s: string) => s, strikethrough: (s: string) => s };
}

test("imageMimeType reads bytes, not filenames", () => {
	assert.equal(imageMimeType(JPEG), "image/jpeg");
	assert.equal(imageMimeType(PNG), "image/png");
	assert.throws(() => imageMimeType(Buffer.from("not-an-image")));
});

test("JPEG labelled PNG cannot be measured as PNG", () => {
	assert.equal(getPngDimensions(JPEG.toString("base64")), null);
	assert.deepEqual(getImageDimensions(JPEG.toString("base64"), "image/jpeg"), { widthPx: 16, heightPx: 16 });
});

test("normalizePng converts JPEG and leaves PNG bytes unchanged", async () => {
	const converted = await normalizePng(JPEG);
	assert.equal(imageMimeType(converted), "image/png");
	assert.deepEqual(getImageDimensions(converted.toString("base64"), "image/png"), { widthPx: 16, heightPx: 16 });
	assert.deepEqual(await normalizePng(PNG), PNG);
});

test("createPreview stays within the thumbnail budget", async () => {
	const preview = await createPreview(JPEG);
	assert.ok(preview);
	assert.equal(imageMimeType(Buffer.from(preview.data, "base64")), "image/png");
	assert.ok(preview.data.length <= 192 * 1024);
	const size = getImageDimensions(preview.data, "image/png");
	assert.ok(size && size.widthPx <= 480 && size.heightPx <= 240);
});

test("new cards stay visible until collapsed, restored history stays collapsed", () => {
	const cards = createImageCardRenderer(() => true);
	const data: ImageCardData = {
		id: "live", path: "/tmp/live.png", provider: "xai", model: "grok",
		showInConversation: true, preview: { data: PNG.toString("base64"), mimeType: "image/png" },
	};
	cards.markLive(data);
	assert.doesNotMatch(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
	cards.render(data, true, theme() as never);
	assert.match(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
	cards.reset();
	assert.match(cards.render({ ...data, id: "restored" }, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
});

test("per-entry preview override is independent of the global default", () => {
	const cards = createImageCardRenderer(() => false);
	const data: ImageCardData = {
		id: "one-off", path: "/tmp/one-off.png", provider: "xai", model: "grok",
		showInConversation: true, preview: { data: PNG.toString("base64"), mimeType: "image/png" },
	};
	cards.markLive(data);
	assert.doesNotMatch(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
});

test("oversized stored preview falls back to a file link", () => {
	const cards = createImageCardRenderer(() => true);
	const data: ImageCardData = {
		id: "huge", path: "/tmp/huge.png", provider: "xai", model: "grok",
		showInConversation: true, preview: { data: "A".repeat(200 * 1024), mimeType: "image/png" },
	};
	cards.markLive(data);
	assert.match(cards.render(data, false, theme() as never).render(80).join("\n"), /Preview unavailable/);
});

test("legacy JPEG files are not rewritten", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-access-"));
	const path = join(dir, "legacy.png");
	writeFileSync(path, JPEG);
	const cards = createImageCardRenderer(() => true);
	const data: ImageCardData = { path, provider: "xai", model: "grok" };
	cards.markLive(data);
	resetCapabilitiesCache();
	setCapabilityOverrides({ images: "iterm2" });
	try {
		const lines = cards.render(data, false, theme() as never).render(80).join("\n");
		assert.match(lines, /\[image\]/);
		assert.equal(imageMimeType(readFileSync(path)), "image/jpeg");
	} finally {
		resetCapabilitiesCache();
	}
});
