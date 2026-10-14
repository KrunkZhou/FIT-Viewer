import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import JSZip from "jszip";
import type {
  DocumentSummary,
  RequestPayload,
  WorkerRequest,
  WorkerResponse,
} from "../src/model";
import { activity } from "./fixtures";
import { syntheticSettings } from "./ciq-fixtures";
import { outBinFixture } from "./out-bin-fixtures";

test("OUT.BIN worker source selection and replacement isolate app inventory data", async () => {
  const worker = new Worker(new URL("./worker-adapter.mjs", import.meta.url), {
    execArgv: [],
  });
  let nextId = 0;
  const request = (payload: RequestPayload) =>
    new Promise<DocumentSummary>((resolve, reject) => {
      const requestId = ++nextId;
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Worker response timed out"));
      }, 10000);
      const listen = (response: WorkerResponse) => {
        if (response.requestId !== requestId || response.kind === "progress")
          return;
        cleanup();
        if (response.kind === "error") reject(new Error(response.message));
        else resolve(response.result as DocumentSummary);
      };
      const cleanup = () => {
        clearTimeout(timeout);
        worker.off("message", listen);
        worker.off("error", fail);
      };
      const fail = (error: Error) => {
        cleanup();
        reject(error);
      };
      worker.on("message", listen);
      worker.once("error", fail);
      worker.postMessage({
        ...payload,
        requestId,
        documentId: 1,
      } satisfies WorkerRequest);
    });
  try {
    // Node worker cloning drops File.name; ZIP entries retain source filenames.
    const fitBytes = activity(12);
    const fit = new File(
      [
        await new JSZip()
          .file("run.fit", fitBytes)
          .generateAsync({ type: "arraybuffer" }),
      ],
      "run.zip",
    );
    const archive = await new JSZip()
      .file("OUT.BIN", outBinFixture())
      .file("app.SET", syntheticSettings())
      .file("run.fit", fitBytes)
      .generateAsync({ type: "arraybuffer" });
    const summary = await request({
      kind: "open",
      limit: 1e6,
      file: new File([archive], "Garmin.zip"),
    });
    assert.equal(summary.appInventories?.[0].source, 0);
    const inventory = await request({ kind: "summary", source: 0 });
    assert.equal(inventory.filename, "OUT.BIN");
    assert.equal(inventory.appInventories?.[0].inventory.entries.length, 5);
    assert.equal(inventory.ciqSettings, undefined);
    assert.equal(inventory.hasMap, false);
    const settings = await request({ kind: "summary", source: 1 });
    assert.equal(settings.appInventories, undefined);
    assert.equal(settings.ciqSettings?.length, 1);
    const activityView = await request({ kind: "summary", source: 2 });
    assert.equal(activityView.appInventories, undefined);
    assert.equal(activityView.ciqSettings, undefined);
    assert.equal(activityView.hasMap, true);
    const combined = await request({ kind: "summary" });
    assert.equal(combined.appInventories?.length, 1);
    assert.equal(combined.ciqSettings?.length, 1);
    const replaced = await request({ kind: "open", limit: 1e6, file: fit });
    assert.equal(replaced.appInventories, undefined);
    const alias = await request({
      kind: "open",
      filename: "OUT.BIN",
      limit: 1e6,
      file: fit,
    });
    assert.equal(alias.filename, "OUT.BIN");
    assert.equal(alias.sources[0].filename, "run.fit");
    const actualSource = await request({ kind: "summary", source: 0 });
    assert.equal(actualSource.filename, "run.fit");
    assert.equal(actualSource.hasMap, true);
    assert.equal(actualSource.appInventories, undefined);
  } finally {
    await worker.terminate();
  }
});
