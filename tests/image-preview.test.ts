import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { getImageDimensions, getPngDimensions, resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { createImageCardRenderer, imageMimeType, normalizePng, type ImageCardData } from "../src/image-preview.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const PNG = readFileSync(join(fixtures, "1x1.png"));
const JPEG = readFileSync(join(fixtures, "tiny.jpg"));

function theme() {
	return { fg: (_: string, s: string) => s, bg: (_: string, s: string) => s, dim: (s: string) => s, italic: (s: string) => s, strikethrough: (s: string) => s };
}

function writeCard(bytes: Buffer, name: string) {
	const dir = mkdtempSync(join(tmpdir(), "pi-access-"));
	const path = join(dir, name);
	writeFileSync(path, bytes);
	return path;
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

test("new cards stay visible until collapsed, restored history stays collapsed", () => {
	const path = writeCard(PNG, "live.png");
	const cards = createImageCardRenderer(() => true);
	const data: ImageCardData = {
		id: "live", path, provider: "xai", model: "grok", showInConversation: true,
	};
	cards.markLive(data);
	assert.doesNotMatch(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
	cards.render(data, true, theme() as never);
	assert.match(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
	cards.reset();
	assert.match(cards.render({ ...data, id: "restored" }, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
});

test("per-entry preview override is independent of the global default", () => {
	const path = writeCard(PNG, "one-off.png");
	const cards = createImageCardRenderer(() => false);
	const data: ImageCardData = {
		id: "one-off", path, provider: "xai", model: "grok", showInConversation: true,
	};
	cards.markLive(data);
	assert.doesNotMatch(cards.render(data, false, theme() as never).render(80).join("\n"), /Ctrl\+O to expand image/);
});

test("expanded original image is not height-capped to a thumbnail", () => {
	const path = writeCard(PNG, "original.png");
	const cards = createImageCardRenderer(() => true);
	const data: ImageCardData = { id: "orig", path, provider: "xai", model: "grok", showInConversation: true };
	cards.markLive(data);
	resetCapabilitiesCache();
	setCapabilityOverrides({ images: "iterm2" });
	try {
		const lines = cards.render(data, false, theme() as never).render(80);
		assert.ok(lines.some((line) => line.includes("1337;File=") || line.includes(path)));
		assert.doesNotMatch(lines.join("\n"), /Ctrl\+O to expand image/);
	} finally {
		resetCapabilitiesCache();
	}
});

test("legacy JPEG files are not rewritten", () => {
	const path = writeCard(JPEG, "legacy.png");
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
