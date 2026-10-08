import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type { ExportResult, WorkerRequest, WorkerResponse } from "../src/model";
import { activity } from "./fixtures";
function worker() {
  return new Worker(new URL("./worker-adapter.mjs", import.meta.url), {
    execArgv: [],
  });
}
function wait(
  worker: Worker,
  predicate: (message: WorkerResponse) => boolean,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Worker response timed out"));
    }, 10000);
    const listen = (message: WorkerResponse) => {
      if (predicate(message)) {
        cleanup();
        resolve(message);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", listen);
    };
    worker.on("message", listen);
    worker.once("error", reject);
  });
}
test("document worker returns a complete GeoJSON download", async () => {
  const w = worker();
  try {
    const opened = wait(w, (m) => m.requestId === 1 && m.kind === "result");
    w.postMessage({
      kind: "open",
      file: new File([activity(1000).slice()], "gps.fit"),
      filename: "gps.fit",
      limit: 1e8,
      requestId: 1,
      documentId: 1,
    } satisfies WorkerRequest);
    await opened;
    const exported = wait(
      w,
      (m) => m.requestId === 2 && (m.kind === "result" || m.kind === "error"),
    );
    w.postMessage({
      kind: "export",
      query: { format: "geojson" },
      requestId: 2,
      documentId: 1,
    } satisfies WorkerRequest);
    const response = await exported;
    if (response.kind === "error") throw new Error(response.message);
    assert.equal(response.kind, "result");
    const result = (response as Extract<WorkerResponse, { kind: "result" }>)
      .result as ExportResult;
    assert.equal(result.filename, "gps-gps.geojson");
    assert.equal(JSON.parse(await result.blob.text()).features.length, 1000);
  } finally {
    await w.terminate();
  }
});
test("worker rejects stale documents and supports queries while exporting", async () => {
  const w = worker();
  try {
    const opened = wait(w, (m) => m.requestId === 1 && m.kind === "result");
    w.postMessage({
      kind: "open",
      file: new File([activity(10000).slice()], "activity.fit"),
      filename: "activity.fit",
      limit: 1e8,
      requestId: 1,
      documentId: 1,
    } satisfies WorkerRequest);
    await opened;
    const stale = wait(w, (m) => m.requestId === 2 && m.kind === "error");
    w.postMessage({
      kind: "map",
      requestId: 2,
      documentId: 0,
    } satisfies WorkerRequest);
    assert.match(
      ((await stale) as Extract<WorkerResponse, { kind: "error" }>).message,
      /no longer active/,
    );
    const output = wait(
      w,
      (m) => m.requestId === 3 && (m.kind === "result" || m.kind === "error"),
    );
    w.postMessage({
      kind: "export",
      query: { format: "csv", message: 20 },
      requestId: 3,
      documentId: 1,
    } satisfies WorkerRequest);
    const page = wait(w, (m) => m.requestId === 4 && m.kind === "result");
    const start = performance.now();
    w.postMessage({
      kind: "table",
      query: { message: 20, page: 0, size: 20, developer: false },
      requestId: 4,
      documentId: 1,
    } satisfies WorkerRequest);
    const result = await page;
    assert.equal(
      (result as Extract<WorkerResponse, { kind: "result" }>).result &&
        "rows" in
          (result as Extract<WorkerResponse, { kind: "result" }>).result!,
      true,
    );
    assert.ok(performance.now() - start < 100);
    const cancelled = wait(w, (m) => m.requestId === 3 && m.kind === "error");
    w.postMessage({
      kind: "cancel",
      target: 3,
      requestId: 5,
      documentId: 1,
    } satisfies WorkerRequest);
    assert.equal(
      ((await cancelled) as Extract<WorkerResponse, { kind: "error" }>).aborted,
      true,
    );
    await output;
  } finally {
    await w.terminate();
  }
});
