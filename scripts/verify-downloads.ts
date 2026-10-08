import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CrcCalculator, Decoder, Stream } from "@garmin/fitsdk";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import type { ExportQuery } from "../src/model";

const directory = process.argv[2];
assert.ok(directory, "Pass the directory containing the browser downloads.");
const document = await FitDocument.open(
  new Uint8Array(await readFile(".cache/browser-clean.fit")),
  "browser-clean.fit",
);
const results: unknown[] = [];
for (const query of [
  { format: "csv", message: 20, timeFormat: "iso" },
  { format: "gpx", withLaps: true },
  { format: "geojson" },
  { format: "hrv" },
  { format: "json", sensors: ["20:3"] },
] satisfies ExportQuery[]) {
  const expected = await exportDocument(document, query);
  const actual = await readFile(resolve(directory, expected.filename));
  assert.deepEqual(
    actual,
    Buffer.from(await expected.blob.arrayBuffer()),
    expected.filename,
  );
  results.push({
    filename: expected.filename,
    bytes: actual.length,
    sha256: createHash("sha256").update(actual).digest("hex"),
  });
}
const original = new Uint8Array(await readFile(".cache/browser-damaged.fit"));
const fixed = new Uint8Array(
  await readFile(resolve(directory, "browser-damaged-fixed.fit")),
);
assert.equal(CrcCalculator.calculateCRC(fixed, 0, fixed.length), 0);
assert.deepEqual(fixed.slice(14, original.length), original.slice(14));
const reopened = await FitDocument.open(fixed, "fixed.fit");
assert.equal(reopened.index.diagnostics.length, 0);
assert.equal(reopened.index.messages.get(20)?.length, 180);
assert.equal(reopened.index.messages.get(18)?.length, 1);
assert.equal(reopened.index.messages.get(34)?.length, 1);
assert.equal(new Decoder(Stream.fromByteArray(fixed)).read().errors.length, 0);
results.push({
  filename: "browser-damaged-fixed.fit",
  retainedBodyBytes: original.length - 14,
  generatedMessages: [18, 34],
  bytes: fixed.length,
});
let lines = 0;
let bytes = 0;
const hash = createHash("sha256");
for await (const chunk of createReadStream(
  resolve(directory, "benchmark-1000000-20.csv"),
)) {
  bytes += chunk.length;
  hash.update(chunk);
  for (const byte of chunk) if (byte === 10) lines++;
}
assert.equal(lines, 1000000);
assert.equal(bytes, 97588270);
results.push({
  filename: "benchmark-1000000-20.csv",
  rows: lines,
  bytes,
  sha256: hash.digest("hex"),
});
await writeFile(
  ".cache/browser/downloads.json",
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results, null, 2));
