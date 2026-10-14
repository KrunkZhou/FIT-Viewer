import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";
import type {
  DocumentSummary,
  RequestPayload,
  TablePage,
  ExportResult,
  WorkerRequest,
  WorkerResponse,
  MapData,
  MapPlaybackPosition,
} from "../src/model";
import JSZip from "jszip";
import { activity } from "./fixtures";
import { syntheticSettings } from "./ciq-fixtures";
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
test("map timeline queries use source samples and reject stale map indexes after filtering or replacement", async () => {
  const w = worker();
  const request = (
    payload: RequestPayload,
    requestId: number,
    documentId = 1,
  ) => {
    const pending = wait(
      w,
      (message) =>
        message.requestId === requestId && message.kind !== "progress",
    );
    w.postMessage({
      ...payload,
      requestId,
      documentId,
    } satisfies WorkerRequest);
    return pending;
  };
  try {
    await request(
      {
        kind: "open",
        file: new File([activity(100).slice()], "gps.fit"),
        limit: 1e8,
      },
      1,
    );
    const response = await request({ kind: "map" }, 2);
    assert.equal(response.kind, "result");
    if (response.kind !== "result") throw new Error("Map failed");
    const data = response.result as MapData;
    assert.equal(data.tracks[0].length, 2);
    assert.equal(data.playback?.routes[0].count, 100);
    const position = await request(
      {
        kind: "map-position",
        mapId: data.playback!.id,
        time: 1100000037,
        routes: [0],
      },
      3,
    );
    assert.equal(position.kind, "result");
    if (position.kind === "result")
      assert.equal((position.result as MapPlaybackPosition).time, 1100000037);
    if (position.kind === "result") {
      const record = (position.result as MapPlaybackPosition).record;
      const tableResponse = await request(
        {
          kind: "table",
          query: {
            message: 20,
            developer: false,
            page: 0,
            size: 20,
            filters: {},
            target: record,
          },
        },
        42,
      );
      assert.equal(tableResponse.kind, "result");
      if (tableResponse.kind === "result") {
        const table = tableResponse.result as TablePage;
        assert.equal(table.selected, record);
        assert.equal(table.page, 1);
        assert.equal(
          table.rows.find((row) => row.index === record)?.cells["253"].raw,
          1100000037,
        );
      }
    }
    const filtered = await request(
      { kind: "map", dates: { start: 1100000020, end: 1100000040 } },
      4,
    );
    assert.equal(filtered.kind, "result");
    const stale = await request(
      { kind: "map-position", mapId: 2, time: 1100000037, routes: [0] },
      5,
    );
    assert.equal(stale.kind, "error");
    const next = await request(
      { kind: "map-position", mapId: 4, time: 1100000000, routes: [0] },
      6,
    );
    assert.equal(next.kind, "result");
    if (next.kind === "result")
      assert.equal((next.result as MapPlaybackPosition).time, 1100000020);
    await request(
      {
        kind: "open",
        file: new File([activity(10).slice()], "replacement.fit"),
        limit: 1e8,
      },
      7,
      2,
    );
    assert.equal(
      (
        await request(
          { kind: "map-position", mapId: 4, time: 1100000037, routes: [0] },
          8,
          2,
        )
      ).kind,
      "error",
    );
  } finally {
    await w.terminate();
  }
});
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

test("document worker reports typed file and ZIP size failures, but not for invalid FIT data", async () => {
  const w = worker();
  try {
    const archive = await new JSZip()
      .file("large.fit", new Uint8Array(20000))
      .generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const cases = [
      {
        file: new File([new Uint8Array(20000)], "large.fit"),
        code: "import-size-limit",
      },
      {
        file: new File([archive.slice()], "large.zip"),
        code: "import-size-limit",
      },
      { file: new File(["invalid"], "invalid.fit"), code: undefined },
    ];
    for (const [index, { file, code }] of cases.entries()) {
      const requestId = index + 1;
      const pending = wait(
        w,
        (message) =>
          message.requestId === requestId && message.kind !== "progress",
      );
      w.postMessage({
        kind: "open",
        file,
        filename: file.name,
        limit: 10000,
        requestId,
        documentId: requestId,
      } satisfies WorkerRequest);
      const response = await pending;
      assert.equal(response.kind, "error");
      if (response.kind !== "error")
        throw new Error("Expected worker rejection");
      assert.equal(response.code, code);
      assert.equal(response.aborted, false);
    }
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

test("CIQ worker keeps settings isolated across source selection and replacement", async () => {
  const w = worker();
  let id = 0;
  const request = async (payload: RequestPayload) => {
    const requestId = ++id;
    const pending = wait(
      w,
      (message) =>
        message.requestId === requestId && message.kind !== "progress",
    );
    w.postMessage({ ...payload, requestId, documentId: 1 });
    const response = await pending;
    if (response.kind === "error") throw new Error(response.message);
    return (response as Extract<WorkerResponse, { kind: "result" }>).result;
  };
  try {
    const fit = new File([activity(12).slice()], "run.fit");
    // Node clones File as Blob; ZIP entry names preserve the browser filenames.
    const archive = await new JSZip()
      .file("example.SET", syntheticSettings())
      .file("run.fit", activity(12))
      .generateAsync({ type: "uint8array" });
    const summary = (await request({
      kind: "open",
      file: new File([archive.slice()], "Garmin.zip"),
      filename: "Garmin.zip",
      limit: 1e6,
    })) as DocumentSummary;
    assert.equal(summary.ciqSettings?.length, 1);
    assert.equal(summary.ciqSettings?.[0].source, 0);
    assert.equal(summary.hasMap, true);
    const selectedSettings = (await request({
      kind: "summary",
      source: 0,
    })) as DocumentSummary;
    assert.equal(selectedSettings.filename, "example.SET");
    assert.equal(selectedSettings.ciqSettings?.[0].settings.entries.length, 6);
    assert.equal(selectedSettings.records, 0);
    const selectedFit = (await request({
      kind: "summary",
      source: 1,
    })) as DocumentSummary;
    assert.equal(selectedFit.ciqSettings, undefined);
    assert.equal(selectedFit.hasMap, true);
    const combined = (await request({ kind: "summary" })) as DocumentSummary;
    assert.equal(combined.ciqSettings?.length, 1);
    const replaced = (await request({
      kind: "open",
      file: fit,
      filename: "run.fit",
      limit: 1e6,
    })) as DocumentSummary;
    assert.equal(replaced.ciqSettings, undefined);
  } finally {
    await w.terminate();
  }
});

test("ZIP worker opens a combined document, filters entries, and restores the combined view", async () => {
  const w = worker();
  let id = 0;
  async function request(
    payload: Omit<WorkerRequest, "requestId" | "documentId">,
  ) {
    const requestId = ++id;
    const pending = wait(
      w,
      (message) =>
        message.requestId === requestId &&
        (message.kind === "result" || message.kind === "error"),
    );
    w.postMessage({ ...payload, requestId, documentId: 1 });
    const response = await pending;
    if (response.kind === "error") throw new Error(response.message);
    return (response as Extract<WorkerResponse, { kind: "result" }>).result;
  }
  try {
    const bytes = await new JSZip()
      .file("A.fit", activity(3))
      .file("nested/B.fit", activity(2))
      .generateAsync({ type: "uint8array" });
    const summary = (await request({
      kind: "open",
      file: new File([bytes.slice()], "combined.zip"),
      filename: "combined.zip",
      limit: 1e8,
    } as WorkerRequest)) as DocumentSummary;
    assert.equal(summary.filename, "combined.zip");
    assert.equal(summary.sources.length, 2);
    assert.equal(summary.gpsPoints, 5);
    const query = { message: 20, page: 0, size: 20, developer: false };
    assert.equal(
      ((await request({ kind: "table", query } as WorkerRequest)) as TablePage)
        .total,
      5,
    );
    const selected = (await request({
      kind: "summary",
      source: 1,
    })) as DocumentSummary;
    assert.equal(selected.filename, "nested/B.fit");
    assert.equal(selected.sources.length, 1);
    assert.equal(selected.gpsPoints, 2);
    assert.equal(
      (
        (await request({
          kind: "table",
          source: 1,
          query,
        } as WorkerRequest)) as TablePage
      ).total,
      2,
    );
    assert.equal(
      ((await request({ kind: "summary" })) as DocumentSummary).sources.length,
      2,
    );
    assert.equal(
      ((await request({ kind: "table", query } as WorkerRequest)) as TablePage)
        .total,
      5,
    );
    await assert.rejects(
      request({ kind: "summary", source: 99 }),
      /unavailable/,
    );
  } finally {
    await w.terminate();
  }
});
