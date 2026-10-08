import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { FitDocument } from "../src/document/document";
import { chart } from "../src/document/series";
import { createJob } from "../src/document/jobs";
const path = process.argv[2];
if (!path) throw new Error("Provide a FIT file path.");
const stage = process.argv[3] ?? "after";
const bytes = new Uint8Array(await readFile(path));
let peakHeap = 0;
let peakRss = 0;
let maximumSlice = 0;
function measuredJob() {
  const job = createJob(new AbortController().signal);
  let last = performance.now();
  return {
    ...job,
    yield: async () => {
      const now = performance.now();
      maximumSlice = Math.max(maximumSlice, now - last);
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
      await job.yield();
      last = performance.now();
    },
  };
}
const opened = performance.now();
const document = await FitDocument.open(bytes, basename(path), measuredJob());
const decodeMs = performance.now() - opened;
const decodeSliceMs = maximumSlice;
const measurements = [];
for (const selected of [
  ["165:5"],
  ["165:5", "165:6", "165:7", "164:5", "164:6", "164:7"],
]) {
  maximumSlice = 0;
  const start = performance.now();
  const data = await chart(
    document,
    { sensors: selected, width: 640, developer: false },
    measuredJob(),
  );
  measurements.push({
    sensors: selected,
    chartMs: performance.now() - start,
    maximumChartSliceMs: maximumSlice,
    renderedPoints: Object.fromEntries(
      Object.entries(data.series).map(([key, points]) => [key, points.length]),
    ),
  });
}
const report = {
  stage,
  file: basename(path),
  inputBytes: bytes.length,
  records: document.index.records.length,
  decodeMs,
  measurements,
  peakHeapMiB: peakHeap / 1048576,
  peakRssMiB: peakRss / 1048576,
  maximumDecodeSliceMs: decodeSliceMs,
};
await mkdir(".cache", { recursive: true });
await writeFile(
  `.cache/motion-${stage}.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
