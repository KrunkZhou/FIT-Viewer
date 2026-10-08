import { writeFile } from "node:fs/promises";
import { FitDocument } from "../src/document/document";
import { createJob } from "../src/document/jobs";
import { exportDocument } from "../src/export/export";
import { activity } from "../tests/fixtures";
const results: unknown[] = [];
for (const count of [100000, 1000000]) {
  const bytes = activity(count);
  const start = performance.now();
  let maxSlice = 0;
  let last = performance.now();
  let peak = 0;
  let peakRss = 0;
  let peakExternal = 0;
  const job = createJob(new AbortController().signal);
  const measured = {
    ...job,
    yield: async () => {
      const now = performance.now();
      maxSlice = Math.max(maxSlice, now - last);
      const memory = process.memoryUsage();
      peak = Math.max(peak, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
      peakExternal = Math.max(peakExternal, memory.external);
      await job.yield();
      last = performance.now();
    },
  };
  const document = await FitDocument.open(
    bytes,
    `benchmark-${count}.fit`,
    measured,
  );
  const decodeMs = performance.now() - start;
  const decodeSliceMs = maxSlice;
  last = performance.now();
  maxSlice = 0;
  const queryStart = performance.now();
  const page = await document.table(
    { message: 20, developer: false, page: 0, size: 20 },
    measured,
  );
  const pageMs = performance.now() - queryStart;
  const exportStart = performance.now();
  last = performance.now();
  const output = await exportDocument(
    document,
    { format: "csv", message: 20, timeFormat: "iso", locale: "en-US" },
    measured,
  );
  const exportMs = performance.now() - exportStart;
  const controller = new AbortController();
  const cancelStart = performance.now();
  const cancelled = exportDocument(
    document,
    { format: "csv", message: 20 },
    createJob(controller.signal, () => controller.abort()),
  ).catch((error) => error.name);
  await cancelled;
  const cancelMs = performance.now() - cancelStart;
  const result = {
    count,
    inputBytes: bytes.length,
    decodeMs,
    pageMs,
    pageRows: page.rows.length,
    exportMs,
    outputBytes: output.blob.size,
    peakHeapMiB: peak / 1048576,
    peakRssMiB: peakRss / 1048576,
    peakExternalMiB: peakExternal / 1048576,
    maximumWorkerSliceMs: Math.max(maxSlice, decodeSliceMs),
    cancellationMs: cancelMs,
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(
  new URL("../.cache/rewrite-benchmark.json", import.meta.url),
  JSON.stringify(results, null, 2) + "\n",
);
