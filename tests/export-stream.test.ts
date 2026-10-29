import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { EXPORT_CHUNK_BYTES } from "../src/export/output";
import { saveDestination } from "../src/ui/save-destination";
import { DownloadFile } from "../electron/download-file";
import { idleJob } from "../src/protocol/reader";
import { activity, uiActivity } from "./fixtures";
import { syntheticSettings } from "./ciq-fixtures";
import type { ExportQuery } from "../src/model";

test("transferred streaming exports match Blob output for all formats and bound writes", async () => {
  const document = await FitDocument.open(uiActivity(), "stream.fit");
  const settings = await FitDocument.openSources(
    [{ filename: "example.SET", bytes: syntheticSettings() }],
    "settings",
  );
  const queries: ExportQuery[] = [
    { format: "csv" },
    { format: "json", sensors: ["20:3", "20:73"] },
    { format: "gpx" },
    { format: "geojson" },
    { format: "hrv" },
    { format: "fit" },
    { format: "set", settings: { source: 0, edits: [] } },
  ];
  for (const query of queries) {
    const source = query.format === "set" ? settings : document;
    const expected = await exportDocument(source, query);
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let active = false,
      closed = false;
    const destination = new WritableStream<Uint8Array>({
      async write(chunk) {
        assert.ok(!active);
        assert.ok(chunk.byteLength <= EXPORT_CHUNK_BYTES);
        active = true;
        await new Promise((r) => setImmediate(r));
        parts.push(new Uint8Array(chunk));
        active = false;
      },
      close() {
        closed = true;
      },
    });
    const stream = structuredClone(destination, { transfer: [destination] });
    const actual = await exportDocument(source, query, idleJob(), stream);
    assert.equal(actual.streamed, true);
    assert.equal(actual.blob.size, 0);
    // Transfer completion is acknowledged asynchronously by the original realm.
    while (!closed) await new Promise((r) => setImmediate(r));
    assert.equal(actual.filename, expected.filename);
    assert.deepEqual(
      await new Blob(parts).arrayBuffer(),
      await expected.blob.arrayBuffer(),
      query.format,
    );
  }
});

test("repaired archives stream complete entries without retaining ZIP output", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes: activity(10) },
      { filename: "b.fit", bytes: activity(12) },
    ],
    "files.zip",
  );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  const actual = await exportDocument(
    document,
    { format: "fit" },
    idleJob(),
    new WritableStream({
      write(chunk) {
        parts.push(new Uint8Array(chunk));
      },
    }),
  );
  assert.equal(actual.blob.size, 0);
  const zip = await JSZip.loadAsync(await new Blob(parts).arrayBuffer());
  assert.ok(zip.file("repair-report.json"));
  assert.equal(
    Object.keys(zip.files).filter((name) => name.endsWith(".fit")).length,
    2,
  );
});

test("streamed cancellation and disk errors abort output instead of reporting success", async () => {
  const document = await FitDocument.open(activity(2000), "cancel.fit");
  for (const diskError of [false, true]) {
    const controller = new AbortController();
    let writes = 0,
      aborted = false;
    const stream = new WritableStream<Uint8Array>({
      write() {
        writes++;
        if (diskError) throw new Error("disk full");
        controller.abort();
      },
      abort() {
        aborted = true;
      },
      close() {
        assert.fail("Cancelled output was closed");
      },
    });
    await assert.rejects(
      exportDocument(
        document,
        { format: "csv" },
        { ...idleJob(), signal: controller.signal },
        stream,
      ),
      diskError ? /disk full/ : { name: "AbortError" },
    );
    assert.equal(writes, 1);
    if (!diskError) assert.equal(aborted, true);
    assert.equal(stream.locked, false);
  }
});

test("desktop save commits atomically, rejects oversized writes and cleans cancelled files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fit-export-"));
  try {
    const target = join(directory, "result.csv");
    await writeFile(target, "existing");
    const cancelled = await DownloadFile.open(target);
    await cancelled.write(new TextEncoder().encode("partial"));
    await assert.rejects(
      cancelled.write(new Uint8Array(EXPORT_CHUNK_BYTES + 1)),
      /Invalid download chunk/,
    );
    await cancelled.abort();
    assert.equal(await readFile(target, "utf8"), "existing");
    assert.deepEqual(await readdir(directory), ["result.csv"]);
    const finished = await DownloadFile.open(target);
    await finished.write(new TextEncoder().encode("complete"));
    assert.equal(await readFile(target, "utf8"), "existing");
    await finished.finish();
    await finished.abort();
    assert.equal(await readFile(target, "utf8"), "complete");
    assert.deepEqual(await readdir(directory), ["result.csv"]);
    await assert.rejects(finished.write(new Uint8Array(1)), /not writable/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser save destinations commit only after successful worker completion", async () => {
  const controller = new AbortController();
  let committed = false,
    cancelled = false;
  const host = {
    showSaveFilePicker: async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({
          close() {
            committed = true;
          },
          abort() {
            cancelled = true;
          },
        }),
    }),
  };
  const destination = (await saveDestination(
    "test.csv",
    controller.signal,
    host,
  ))!;
  const writer = destination.stream.getWriter();
  await writer.write(Uint8Array.of(1));
  await writer.close();
  assert.equal(committed, false);
  await destination.commit();
  await destination.abort();
  assert.equal(committed, true);
  assert.equal(cancelled, false);
  const second = (await saveDestination("test.csv", controller.signal, host))!;
  controller.abort();
  await second.abort();
  assert.equal(cancelled, true);
  await assert.rejects(second.commit(), { name: "AbortError" });
  assert.equal(
    await saveDestination("test.csv", new AbortController().signal, {}),
    undefined,
  );
});

test("commit waits for the final transferred chunk to reach the destination", async () => {
  let written = false,
    closed = false;
  const destination = (await saveDestination(
    "race.csv",
    new AbortController().signal,
    {
      showSaveFilePicker: async () => ({
        createWritable: async () =>
          new WritableStream<Uint8Array>({
            async write() {
              await new Promise((resolve) => setTimeout(resolve, 20));
              written = true;
            },
            close() {
              assert.equal(written, true);
              closed = true;
            },
          }),
      }),
    },
  ))!;
  const transfer = structuredClone(destination.stream, {
    transfer: [destination.stream],
  });
  const writer = transfer.getWriter();
  await writer.write(Uint8Array.of(1));
  await writer.close();
  // Node unrefs transferred-stream ports; keep this test alive until delivery.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await destination.commit();
  } finally {
    clearTimeout(keepAlive);
  }
  assert.equal(closed, true);
});
