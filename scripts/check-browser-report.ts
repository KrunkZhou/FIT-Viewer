import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const path = process.argv[2] ?? "docs/browser-layout-results.json";
const results = JSON.parse(await readFile(path, "utf8")) as {
  size: { width: number; height: number };
  theme: string;
  tab: string;
  scrollWidth: number;
  scrollHeight: number;
  rows: number;
  footers: number;
  chartPaths: number;
  mapHeight: number;
  mapBounds: { left: number; right: number; bottom: number } | null;
  mapRoute: {
    width: number;
    height: number;
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null;
}[];
assert.equal(results.length, 24);
const keys = new Set<string>();
for (const result of results) {
  keys.add(`${result.size.width}:${result.theme}:${result.tab}`);
  assert.equal(result.scrollWidth, result.size.width);
  assert.equal(result.scrollHeight, result.size.height);
  assert.equal(result.footers, 0);
  if (result.tab === "Messages") assert.equal(result.rows, 20);
  if (result.tab === "Map") {
    assert.ok(result.mapHeight > result.size.height * 0.65);
    assert.ok(result.mapBounds && result.mapRoute);
    assert.ok(result.mapRoute.width > 0 && result.mapRoute.height > 0);
    assert.ok(
      result.mapRoute.right > result.mapBounds.left &&
        result.mapRoute.left < result.mapBounds.right &&
        result.mapRoute.bottom > result.size.height - result.mapHeight &&
        result.mapRoute.top < result.mapBounds.bottom,
    );
  }
  if (result.tab === "Chart") assert.ok(result.chartPaths > 0);
}
assert.equal(keys.size, 24);
console.log(
  "24 recorded browser layout cases passed. This command verifies the report; it does not launch a browser.",
);
