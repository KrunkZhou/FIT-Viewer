import { Worker } from "node:worker_threads";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import assert from "node:assert/strict";
import type {
  RequestPayload,
  WorkerRequest,
  WorkerResponse,
} from "../src/model";
const path = process.argv[2];
if (!path) throw new Error("Provide a FIT file path.");
const worker = new Worker(
  new URL("../tests/worker-adapter.mjs", import.meta.url),
  { execArgv: [] },
);
function wait(
  id: number,
  kind: WorkerResponse["kind"],
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Worker timed out"));
    }, 30000);
    const listener = (message: WorkerResponse) => {
      if (message.requestId === id && message.kind === kind) {
        cleanup();
        resolve(message);
      }
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      worker.off("message", listener);
      worker.off("error", fail);
    };
    worker.on("message", listener);
    worker.on("error", fail);
  });
}
function send(request: RequestPayload & { requestId: number }) {
  worker.postMessage({ ...request, documentId: 1 } satisfies WorkerRequest);
}
try {
  const bytes = new Uint8Array(await readFile(path));
  const opened = wait(1, "result");
  const started = performance.now();
  send({
    kind: "open",
    file: new File([bytes], basename(path)),
    limit: 512 * 1048576,
    requestId: 1,
  });
  await opened;
  const openMs = performance.now() - started;
  const preparing = wait(2, "progress");
  const cancelled = wait(2, "error");
  send({
    kind: "chart",
    query: {
      sensors: ["165:5", "165:6", "165:7", "164:5", "164:6", "164:7"],
      width: 1366,
      developer: false,
    },
    requestId: 2,
  });
  await preparing;
  const page = wait(3, "result");
  const queryStart = performance.now();
  send({
    kind: "table",
    query: { message: 20, developer: false, page: 1, size: 20 },
    requestId: 3,
  });
  await page;
  const concurrentPageMs = performance.now() - queryStart;
  const acknowledgement = wait(4, "result");
  const cancelStart = performance.now();
  send({ kind: "cancel", target: 2, requestId: 4 });
  await acknowledgement;
  const cancellationMs = performance.now() - cancelStart;
  const error = await cancelled;
  assert.ok(error.kind === "error" && error.aborted);
  assert.ok(concurrentPageMs < 100);
  assert.ok(cancellationMs < 100);
  const report = { openMs, concurrentPageMs, cancellationMs, aborted: true };
  await mkdir(".cache", { recursive: true });
  await writeFile(
    ".cache/motion-worker.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await worker.terminate();
}
