import assert from "node:assert/strict";
import test from "node:test";
import { formatTokenCount, mergeFooterStatuses, oneLine } from "../src/footer.ts";
import { USAGE_STATUS_KEY } from "../src/usage.ts";

test("footer merges package usage separately and preserves other extension statuses", () => {
	const statuses = new Map([
		["z-status", "  zeta\nworking "],
		[USAGE_STATUS_KEY, "5h 80% · 1w 55%"],
		["a-status", "alpha\tready"],
	]);
	assert.deepEqual(mergeFooterStatuses(statuses), {
		usage: "5h 80% · 1w 55%",
		others: ["alpha ready", "zeta working"],
	});
});

test("footer helpers preserve compact token and single-line formatting", () => {
	assert.equal(formatTokenCount(999), "999");
	assert.equal(formatTokenCount(1_250), "1.3k");
	assert.equal(formatTokenCount(25_100), "25k");
	assert.equal(formatTokenCount(1_250_000), "1.3M");
	assert.equal(oneLine(" cwd\n(branch)\t session "), "cwd (branch) session");
});

test("footer handles missing usage without suppressing unrelated status", () => {
	assert.deepEqual(mergeFooterStatuses(new Map([["worker", "busy"]])), {
		usage: "",
		others: ["busy"],
	});
});
