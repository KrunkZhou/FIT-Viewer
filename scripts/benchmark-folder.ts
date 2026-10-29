import assert from "node:assert/strict";
import { FitDocument } from "../src/document/document";
import { createJob } from "../src/document/jobs";
import { data, definition, join, type Field } from "../tests/fixtures";
import { wrapBody } from "../src/protocol/writer";
import { addSummaryDiagnostics } from "../src/repair/repair";

if (!global.gc) throw new Error("Run with node --expose-gc --import tsx.");
const files = Number(process.argv[2] ?? 32);
const rows = Math.floor(Number(process.argv[3] ?? 524288) / files);
assert.ok(Number.isInteger(files) && files > 0 && files <= 10000);
assert.ok(Number.isInteger(rows) && rows >= 2);
const fields: Field[] = [
  [253, 6, 1100000000],
  [3, 2, 120],
  [200, 13, new Array<number>(240).fill(1)],
];
const identity: Field[] = [[0, 0, 4]];
const sport: Field[] = [[0, 0, 1]];
const layout = join([
  definition(0, identity),
  data(identity),
  definition(12, sport),
  data(sport),
  definition(20, fields),
]);
const size = 246;
const sources = Array.from({ length: files }, (_, source) => {
  const body = new Uint8Array(layout.length + rows * size);
  body.set(layout);
  const view = new DataView(body.buffer);
  for (let row = 0, offset = layout.length; row < rows; row++, offset += size) {
    view.setUint32(offset + 1, 1100000000 + source * rows + row, true);
    body[offset + 5] = 100 + (row % 50);
    body.fill(row % 254, offset + 6, offset + size);
  }
  return { filename: `source-${source}.fit`, bytes: wrapBody(body) };
});
global.gc();
const before = process.memoryUsage();
let peakBuffers = before.arrayBuffers;
let peakHeap = before.heapUsed;
const job = createJob(new AbortController().signal);
const start = performance.now();
const measuredJob = {
  ...job,
  yield: async () => {
    const memory = process.memoryUsage();
    peakBuffers = Math.max(peakBuffers, memory.arrayBuffers);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
    await job.yield();
  },
};
const document = await FitDocument.openSources(sources, "folder", measuredJob);
const openMs = performance.now() - start;
const summaryStart = performance.now();
await addSummaryDiagnostics(document, measuredJob);
const summaryMs = performance.now() - summaryStart;
const totalMs = performance.now() - start;
global.gc();
const after = process.memoryUsage();
let sharedSources = 0;
for (const [i, source] of document.sources.entries()) {
  const bytes = document.index.bytes.subarray(source.start, source.end);
  if (bytes.buffer === sources[i].bytes.buffer) sharedSources++;
  assert.deepEqual(bytes, sources[i].bytes);
}
assert.equal(document.recordIds(20).length, files * rows);
assert.equal(
  document.index.diagnostics.filter((d) => d.code === "missing-summary").length,
  files * 3,
);
console.log(
  JSON.stringify({
    files,
    records: document.index.records.length,
    inputMiB: document.index.bytes.length / 2 ** 20,
    openMs,
    summaryMs,
    totalMs,
    sharedSources,
    inputBufferMiB: before.arrayBuffers / 2 ** 20,
    retainedBufferMiB: after.arrayBuffers / 2 ** 20,
    peakBufferMiB: peakBuffers / 2 ** 20,
    retainedHeapMiB: after.heapUsed / 2 ** 20,
    peakHeapMiB: peakHeap / 2 ** 20,
  }),
);
