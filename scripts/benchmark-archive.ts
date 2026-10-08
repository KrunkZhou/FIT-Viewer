import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Worker } from "node:worker_threads";
import JSZip from "jszip";
import type {
  RequestPayload,
  WorkerRequest,
  WorkerResponse,
} from "../src/model";
import { FitDocument } from "../src/document/document";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { exportDocument } from "../src/export/export";
import { activity } from "../tests/fixtures";

async function benchmark(count: number) {
  const archive = await new JSZip()
    .file("A.fit", activity(count / 2))
    .file("B.fit", activity(count / 2))
    .generateAsync({ type: "uint8array", compression: "DEFLATE" });
  const file = new File([archive.slice()], `benchmark-${count}.zip`);
  let peakHeap = 0;
  let peakRss = 0;
  let maxSlice = 0;
  let last = performance.now();
  const scheduled = createJob(new AbortController().signal);
  const job = {
    ...scheduled,
    yield: async () => {
      maxSlice = Math.max(maxSlice, performance.now() - last);
      const memory = process.memoryUsage();
      peakHeap = Math.max(peakHeap, memory.heapUsed);
      peakRss = Math.max(peakRss, memory.rss);
      await scheduled.yield();
      last = performance.now();
    },
  };
  const started = performance.now();
  const loaded = await loadFile(file, 512 * 1048576, job);
  const extractionMs = performance.now() - started;
  last = performance.now();
  const decodeStarted = last;
  const document = await FitDocument.openSources(
    loaded.sources,
    loaded.filename,
    job,
  );
  const decodeMs = performance.now() - decodeStarted;
  const pageStarted = performance.now();
  last = pageStarted;
  const page = await document.table(
    { message: 20, developer: false, page: 0, size: 20 },
    job,
  );
  const pageMs = performance.now() - pageStarted;
  assert.equal(page.total, count);
  const exportStarted = performance.now();
  last = exportStarted;
  const csv = await exportDocument(
    document,
    { format: "csv", timeFormat: "iso" },
    job,
  );
  const exportMs = performance.now() - exportStarted;

  const worker = new Worker(
    new URL("../tests/worker-adapter.mjs", import.meta.url),
    { execArgv: [] },
  );
  const wait = (id: number, kind: WorkerResponse["kind"]) =>
    new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Worker benchmark timed out"));
      }, 120000);
      const listener = (response: WorkerResponse) => {
        if (response.requestId !== id) return;
        if (response.kind === "error" && kind !== "error") {
          cleanup();
          reject(new Error(response.message));
          return;
        }
        if (response.kind !== kind) return;
        cleanup();
        resolve(response);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        worker.off("message", listener);
        worker.off("error", failed);
      };
      worker.on("message", listener);
      worker.on("error", failed);
    });
  const send = (payload: RequestPayload, requestId: number) =>
    worker.postMessage({
      ...payload,
      requestId,
      documentId: 1,
    } satisfies WorkerRequest);
  let concurrentPageMs = 0;
  let cancellationMs = 0;
  let workerOpenMs = 0;
  try {
    const opened = wait(1, "result");
    const openStarted = performance.now();
    send({ kind: "open", file, filename: file.name, limit: 512 * 1048576 }, 1);
    await opened;
    workerOpenMs = performance.now() - openStarted;
    const progress = wait(2, "progress");
    const cancelled = wait(2, "error");
    send({ kind: "export", query: { format: "csv", timeFormat: "iso" } }, 2);
    await progress;
    const queried = wait(3, "result");
    const queryStarted = performance.now();
    send(
      {
        kind: "table",
        query: { message: 20, developer: false, page: 1, size: 20 },
      },
      3,
    );
    await queried;
    concurrentPageMs = performance.now() - queryStarted;
    const acknowledged = wait(4, "result");
    const cancelStarted = performance.now();
    send({ kind: "cancel", target: 2 }, 4);
    await acknowledged;
    cancellationMs = performance.now() - cancelStarted;
    const response = await cancelled;
    assert.ok(response.kind === "error" && response.aborted);
    assert.ok(
      concurrentPageMs < 100,
      `Concurrent page: ${concurrentPageMs} ms`,
    );
    assert.ok(cancellationMs < 100, `Cancellation: ${cancellationMs} ms`);
  } finally {
    await worker.terminate();
  }
  return {
    count,
    zipBytes: archive.length,
    expandedBytes: document.index.bytes.length,
    extractionMs,
    decodeMs,
    exportMs,
    pageMs,
    csvBytes: csv.blob.size,
    peakHeapMiB: peakHeap / 1048576,
    peakProcessRssMiB: peakRss / 1048576,
    maximumProcessingSliceMs: maxSlice,
    workerOpenMs,
    concurrentPageMs,
    cancellationMs,
  };
}

const results = [];
for (const count of [100000, 1000000]) {
  const result = await benchmark(count);
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(
  new URL("../.cache/archive-benchmark.json", import.meta.url),
  JSON.stringify(results, null, 2) + "\n",
);
