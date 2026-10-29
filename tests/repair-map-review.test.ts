import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { Decoder, Stream } from "@garmin/fitsdk";
import { FitDocument } from "../src/document/document";
import { mapData } from "../src/document/series";
import { exportDocument } from "../src/export/export";
import { idleJob } from "../src/protocol/reader";
import { encodeMessage } from "../src/protocol/writer";
import { FIT_EPOCH } from "../src/protocol/time";
import {
  addSummaryDiagnostics,
  repair,
  summaryCandidates,
} from "../src/repair/repair";
import { activity, file, join, type Field } from "./fixtures";

const start = 1100000000;
const gps = (time: number, latitude = 100): Field[] => [
  [253, 6, time],
  [0, 5, latitude],
  [1, 5, 100],
];
const lap = (time: number, end: number): Field[] => [
  [253, 6, end],
  [2, 6, time],
  [3, 5, 100],
  [4, 5, 100],
  [5, 5, 200],
  [6, 5, 100],
  [25, 0, 1],
];

test("summary encoder rejects overflow, invalid sentinels and fractional integers", () => {
  for (const value of [-1, 0xffffffff, 5184000000, Infinity, NaN, 1.5])
    assert.throws(
      () => encodeMessage(18, { totalElapsedTime: value }),
      RangeError,
    );
  assert.doesNotThrow(() => encodeMessage(18, { totalElapsedTime: 0 }));
  assert.doesNotThrow(() =>
    encodeMessage(18, { totalElapsedTime: 0xfffffffe }),
  );
  assert.throws(() => encodeMessage(34, { numSessions: 65535 }), RangeError);
  assert.throws(() => encodeMessage(34, { numSessions: 65536 }), RangeError);
});

test("unrepresentable repair durations remain explicit omissions without wrapped data", async () => {
  const bytes = file(
    [
      { message: 0, fields: [[0, 0, 4]] },
      { message: 12, fields: [[0, 0, 1]] },
      { message: 20, fields: [[253, 6, start]] },
      { message: 20, fields: [[253, 6, start + 60 * 86400]] },
    ],
    false,
  );
  const damaged = bytes.slice();
  damaged[damaged.length - 1] ^= 1;
  const document = await FitDocument.open(damaged, "long.fit");
  assert.deepEqual(await summaryCandidates(document, 0), []);
  const result = await repair(document);
  assert.deepEqual(result.bytes, bytes);
  assert.deepEqual(result.generated, []);
  assert.equal(result.unresolved.length, 3);
  assert.ok(result.unresolved.every((text) => text.includes("field range")));
  const decoded = await FitDocument.open(result.bytes, "fixed.fit");
  assert.equal(decoded.recordIds(18).length, 0);
  assert.equal(decoded.index.diagnostics.length, 0);
});

test("representable generated values survive repair and agree with the SDK", async () => {
  const document = await FitDocument.open(activity(200), "normal.fit");
  const candidates = await summaryCandidates(document, 0);
  assert.deepEqual(
    candidates.map((candidate) => candidate.message),
    [19, 18, 34],
  );
  const result = await repair(document);
  const oracle = new Decoder(Stream.fromByteArray(result.bytes)).read();
  assert.equal(oracle.errors.length, 0);
  assert.ok(oracle.messages.sessionMesgs);
  assert.ok(oracle.messages.lapMesgs);
  assert.equal(oracle.messages.sessionMesgs[0].totalElapsedTime, 199);
  assert.equal(oracle.messages.lapMesgs[0].totalElapsedTime, 199);
});

test("folder summary evidence is linear and cached across diagnostic and repair queries", async () => {
  const files = 64;
  const document = await FitDocument.openSources(
    Array.from({ length: files }, (_, i) => ({
      filename: `${i}.fit`,
      bytes: activity(100),
    })),
    "folder",
  );
  let reads = 0;
  document.index.records = new Proxy(document.index.records, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  await addSummaryDiagnostics(document);
  assert.ok(
    reads < document.index.records.length * 3,
    `${reads} record lookups`,
  );
  assert.equal(document.index.diagnostics.length, files * 3);
  reads = 0;
  await addSummaryDiagnostics(document);
  for (let subfile = 0; subfile < files; subfile++)
    assert.equal((await summaryCandidates(document, subfile)).length, 3);
  assert.equal(reads, 0);
  assert.equal(document.index.diagnostics.length, files * 3);
});

test("complete summaries skip activity evidence and cancelled evidence can retry", async () => {
  const original = await FitDocument.open(activity(100), "source.fit");
  const complete = await FitDocument.open(
    (await repair(original)).bytes,
    "complete.fit",
  );
  complete.raw = () => {
    throw new Error("Complete summaries need no raw decoding");
  };
  for (const id of complete.recordIds(20))
    Object.defineProperty(complete.index.records[id], "timestamp", {
      get() {
        throw new Error("Complete summaries need no timestamp scan");
      },
    });
  await addSummaryDiagnostics(complete);
  assert.equal(complete.index.diagnostics.length, 0);
  const retry = await FitDocument.open(activity(5000), "retry.fit");
  await assert.rejects(
    addSummaryDiagnostics(retry, {
      ...idleJob(),
      yield: async () => {
        throw new DOMException("Cancelled", "AbortError");
      },
    }),
    { name: "AbortError" },
  );
  await addSummaryDiagnostics(retry);
  assert.equal(retry.index.diagnostics.length, 3);
});

test("overlapping summary checks do not duplicate diagnostics", async () => {
  const document = await FitDocument.openSources(
    Array.from({ length: 8 }, (_, i) => ({
      filename: `${i}.fit`,
      bytes: activity(10),
    })),
    "concurrent",
  );
  const first = addSummaryDiagnostics(document);
  const second = addSummaryDiagnostics(document);
  await first;
  await second;
  assert.equal(document.index.diagnostics.length, 24);
  assert.equal(
    new Set(document.index.diagnostics.map((issue) => issue.id)).size,
    24,
  );
});

test("lap start coordinates use start time in maps, filters and GPX", async () => {
  for (const little of [true, false]) {
    const document = await FitDocument.open(
      file(
        [
          { message: 20, little, fields: gps(start) },
          { message: 20, little, fields: gps(start + 60, 200) },
          { message: 19, little, fields: lap(start, start + 60) },
        ],
        false,
      ),
      "lap.fit",
    );
    const data = await mapData(document);
    const point = data.points.find((point) => point.kind === "lap")!;
    assert.equal(point.time, start);
    assert.equal(point.lat, data.tracks[0][0].lat);
    assert.equal(point.route, 0);
    const filtered = await mapData(document, idleJob(), false, {
      start,
      end: start + 5,
    });
    assert.equal(
      filtered.points.find((point) => point.kind === "lap")?.route,
      0,
    );
    const gpx = await (
      await exportDocument(document, { format: "gpx", withLaps: true })
    ).blob.text();
    const waypoint = gpx.match(/<wpt[^>]*>(.*?)<\/wpt>/)?.[1];
    assert.ok(
      waypoint?.includes(new Date(start * 1000 + FIT_EPOCH).toISOString()),
    );
  }
});

test("lap routes follow time boundaries and never attach to another subfile", async () => {
  const bytes = file(
    [
      { message: 20, fields: gps(start) },
      { message: 20, fields: gps(start + 5) },
      { message: 20, fields: gps(start + 10, 0x7fffffff) },
      { message: 20, fields: gps(start + 100) },
      { message: 20, fields: gps(start + 105) },
      { message: 19, fields: lap(start + 100, start + 105) },
      { message: 19, fields: lap(start, start + 5) },
    ],
    false,
  );
  const document = await FitDocument.open(join([bytes, bytes]), "laps.fit");
  const data = await mapData(document);
  assert.equal(data.tracks.length, 4);
  assert.deepEqual(
    data.points
      .filter((point) => point.kind === "lap")
      .map((point) => point.route),
    [1, 0, 3, 2],
  );
  const visible = data.points.filter(
    (point) => point.route === undefined || ![1, 3].includes(point.route),
  );
  assert.deepEqual(
    visible.filter((point) => point.kind === "lap").map((point) => point.route),
    [0, 2],
  );
});

test("missing lap start time does not borrow an unrelated end timestamp", async () => {
  const document = await FitDocument.open(
    file(
      [
        { message: 20, fields: gps(start) },
        { message: 19, fields: lap(0xffffffff, start) },
      ],
      false,
    ),
    "untimed.fit",
  );
  const data = await mapData(document);
  const point = data.points.find((point) => point.kind === "lap")!;
  assert.equal(point.time, undefined);
  assert.equal(point.route, undefined);
});

test("ZIP repair writes each entry before processing the next and retains report and bytes", async () => {
  const bytes = activity(20);
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes },
      { filename: "b.fit", bytes },
    ],
    "folder",
  );
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let checked = false;
  await exportDocument(
    document,
    { format: "fit" },
    {
      ...idleJob(),
      progress(done, _total, phase) {
        if (phase === "Repairing ZIP entries" && done === 1) {
          assert.ok(parts.length > 0, "first entry was not flushed");
          checked = true;
        }
      },
    },
    new WritableStream({
      async write(chunk) {
        await new Promise((resolve) => setImmediate(resolve));
        parts.push(new Uint8Array(chunk));
      },
    }),
  );
  assert.ok(checked);
  const zip = await JSZip.loadAsync(await new Blob(parts).arrayBuffer(), {
    checkCRC32: true,
  });
  const expected = (await repair(await FitDocument.open(bytes, "expected.fit")))
    .bytes;
  for (const name of ["001-a-fixed.fit", "002-b-fixed.fit"])
    assert.deepEqual(await zip.file(name)!.async("uint8array"), expected);
  const report = JSON.parse(
    await zip.file("repair-report.json")!.async("string"),
  );
  assert.equal(report.length, 2);
  assert.ok(
    report.every((entry: { status: string }) => entry.status === "repaired"),
  );
});

test("ZIP repair cancellation and write failures stop before processing the next entry", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes: activity(30) },
      { filename: "b.fit", bytes: activity(30) },
    ],
    "folder",
  );
  for (const fail of [false, true]) {
    const controller = new AbortController();
    let writes = 0;
    const stream = new WritableStream<Uint8Array>({
      write() {
        writes++;
        if (fail) throw new Error("disk full");
        controller.abort();
      },
      close() {
        assert.fail("Incomplete ZIP must not commit");
      },
    });
    await assert.rejects(
      exportDocument(
        document,
        { format: "fit" },
        {
          ...idleJob(),
          signal: controller.signal,
          progress(_done, _total, phase) {
            assert.notEqual(phase, "Repairing ZIP entries");
          },
        },
        stream,
      ),
      fail ? /disk full/ : { name: "AbortError" },
    );
    assert.equal(writes, 1);
    assert.equal(stream.locked, false);
  }
});
