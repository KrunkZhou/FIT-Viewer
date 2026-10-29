import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { DownloadFile } from "../electron/download-file";
import { FitDocument } from "../src/document/document";
import { ChartCache } from "../src/document/chart-cache";
import { MapCache } from "../src/document/map-cache";
import { MapTrack } from "../src/document/map-track";
import { NumericReader } from "../src/document/numeric-reader";
import { chart, mapData, sensors } from "../src/document/series";
import { createJob } from "../src/document/jobs";
import { exportDocument } from "../src/export/export";
import { EXPORT_CHUNK_BYTES } from "../src/export/output";
import { idleJob } from "../src/protocol/reader";
import { wrapBody } from "../src/protocol/writer";
import { activity, data, definition, file, join, type Field } from "./fixtures";

test("invalid GPS timestamps stay untimed in map playback and exports", async () => {
  for (const little of [true, false]) {
    const document = await FitDocument.open(
      file(
        [1100000000, 0xffffffff, 1100000002].map((time, i) => ({
          message: 20,
          little,
          fields: [
            [253, 6, time],
            [0, 5, 600000000 + i * 100],
            [1, 5, -900000000 + i * 100],
          ] as Field[],
        })),
        false,
      ),
      "missing-time.fit",
    );
    const full = await mapData(document, idleJob(), true);
    assert.equal(full.tracks.length, 1);
    assert.deepEqual(
      full.tracks[0].map((point) => point.time),
      [1100000000, undefined, 1100000002],
    );
    const { index } = await new MapCache().query(document, idleJob());
    assert.deepEqual(index.routes, [
      { route: 0, start: 1100000000, end: 1100000002, count: 2 },
    ]);
    const gpx = await (
      await exportDocument(document, { format: "gpx" })
    ).blob.text();
    assert.equal((gpx.match(/<trkpt /g) ?? []).length, 3);
    assert.equal((gpx.match(/<time>/g) ?? []).length, 2);
    assert.ok(!gpx.includes("2126"));
    const json = await (
      await exportDocument(document, { format: "geojson" })
    ).blob.text();
    assert.ok(!json.includes("2126"));
  }
});

test("map simplification bounds pathological work without dropping required vertices", async () => {
  for (const count of [4000, 16000]) {
    const track = new MapTrack();
    for (let i = 0; i < count; i++)
      track.add({
        lat: 43 + (i % 2) * 0.0001,
        lon: -79 + i * 0.0001,
        record: i,
      });
    let checkpoints = 0;
    const points = await track.display(false, {
      ...idleJob(),
      yield: async () => {
        checkpoints++;
      },
    });
    assert.equal(points.length, count);
    assert.ok(checkpoints > 1);
    assert.ok(checkpoints <= Math.ceil((count * 34) / 4096) + 2);
    let cancelled = false;
    await assert.rejects(
      track.display(false, {
        ...idleJob(),
        yield: async () => {
          cancelled = true;
          throw new DOMException("Cancelled", "AbortError");
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(cancelled, true);
  }
  const line = new MapTrack();
  for (let i = 0; i < 10000; i++)
    line.add({ lat: 43, lon: -79 + i / 100000, record: i });
  assert.deepEqual(
    (await line.display(false, idleJob())).map((p) => p.record),
    [0, 9999],
  );
});

test("map date indexes skip irrelevant blocks while preserving disjoint routes", async () => {
  const document = await FitDocument.open(activity(10000), "dates.fit");
  let batches = 0;
  const dates = {
    intervals: [
      { start: 1100000100, end: 1100000109 },
      { start: 1100009100, end: 1100009109 },
    ],
  };
  const result = await new MapCache().query(
    document,
    {
      ...idleJob(),
      progress: (_done, _total, phase) => {
        if (phase === "Preparing map data") batches++;
      },
    },
    dates,
  );
  assert.equal(result.data.tracks.length, 2);
  assert.deepEqual(
    result.index.routes.map((r) => r.count),
    [10, 10],
  );
  assert.ok(batches <= 4, `${batches} map batches decoded`);
  assert.deepEqual(
    result.data.tracks.map((track) => [track[0].time, track.at(-1)!.time]),
    [
      [1100000100, 1100000109],
      [1100009100, 1100009109],
    ],
  );
  assert.deepEqual(
    (await mapData(document, idleJob(), false, { intervals: [] })).tracks,
    [],
  );
});

test("interpreted charts do not join dynamic event values with incompatible units", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 20 }, (_, i) => ({
        message: 21,
        fields: [
          [253, 6, 100 + i],
          [0, 0, i % 2 ? 11 : 15],
          [1, 0, 3],
          [3, 6, 1000 + i * 10],
        ] as Field[],
      })),
      false,
    ),
    "events.fit",
  );
  assert.ok(!sensors(document, false).some((sensor) => sensor.key === "21:3"));
  const raw = await chart(document, {
    sensors: ["21:3"],
    developer: true,
    width: 1000,
  });
  assert.equal(raw.series["21:3"].filter((p) => p.value !== null).length, 20);
  assert.equal(document.cells(0)["3"].value, 1);
  assert.equal(document.cells(1)["3"].value, 1.01);
});

test("compiled timestamps match cell decoding for invalid values, compression, endian changes and local times", async () => {
  for (const little of [true, false]) {
    const fields: Field[] = [
      [253, 6, 100],
      [5, 6, 200],
    ];
    const document = await FitDocument.open(
      wrapBody(
        join([
          definition(34, fields, 0, little),
          data(fields, 0, little),
          data(
            [
              [253, 6, 101],
              [5, 6, 201],
            ],
            0,
            little,
            101,
          ),
          data(
            [
              [253, 6, 0xffffffff],
              [5, 6, 0xffffffff],
            ],
            0,
            little,
          ),
        ]),
      ),
      "time.fit",
    );
    for (const developer of [false, true]) {
      const reader = new NumericReader(document, ["253", "5"], developer);
      for (const id of document.recordIds(34))
        assert.deepEqual(
          reader.read(id),
          ["253", "5"].map((key) => document.cells(id, !developer)[key]),
        );
    }
  }
  const document = await FitDocument.open(activity(50), "fast-time.fit");
  const query = {
    format: "csv" as const,
    timeFormat: "localized" as const,
    locale: "en-CA",
    timezone: "America/Toronto",
  };
  const reference = await (await exportDocument(document, query)).blob.text();
  document.cells = () => {
    throw new Error("Static CSV should not decode full cells");
  };
  assert.equal(
    await (await exportDocument(document, query)).blob.text(),
    reference,
  );
});

test("prepared chart displays reuse identity, invalidate with queries, and obey cancellation", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes: activity(100) },
      { filename: "b.fit", bytes: activity(100) },
    ],
    "sources",
  );
  const cache = new ChartCache();
  const query = {
    sensors: ["20:3:file:0", "20:3:file:1"],
    developer: false,
    width: 500,
  };
  const first = await cache.query(document, query, idleJob(), true);
  assert.ok(first.display?.length);
  assert.equal(await cache.query(document, query, idleJob(), true), first);
  const added = await cache.query(
    document,
    { ...query, sensors: [...query.sensors, "20:6:file:0", "20:6:file:1"] },
    idleJob(),
    true,
  );
  assert.equal(added.display![0], first.display![0]);
  const changed = await cache.query(
    document,
    { ...query, width: 100 },
    idleJob(),
    true,
  );
  assert.notEqual(changed.display![0], first.display![0]);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    cache.query(document, query, createJob(controller.signal), true),
    { name: "AbortError" },
  );
  cache.clear();
  assert.notEqual(await cache.query(document, query, idleJob(), true), first);
});

test("desktop export temporary names do not lengthen the destination basename", async () => {
  const directory = await mkdtemp(pathJoin(tmpdir(), "fit-long-export-"));
  try {
    const name = `${"x".repeat(220)}.csv`;
    const target = pathJoin(directory, name);
    const save = await DownloadFile.open(target);
    await save.write(new TextEncoder().encode("complete"));
    await save.finish();
    assert.equal(await readFile(target, "utf8"), "complete");
    const cancelled = await DownloadFile.open(target);
    await cancelled.abort();
    assert.deepEqual(await readdir(directory), [name]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("streamed CSV coalesces small formatting batches into bounded writes", async () => {
  const document = await FitDocument.open(activity(3000), "chunks.fit");
  const expected = await (
    await exportDocument(document, { format: "csv" })
  ).blob.arrayBuffer();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  await exportDocument(
    document,
    { format: "csv" },
    idleJob(),
    new WritableStream({
      write(chunk) {
        assert.ok(chunk.byteLength <= EXPORT_CHUNK_BYTES);
        chunks.push(new Uint8Array(chunk));
      },
    }),
  );
  assert.deepEqual(await new Blob(chunks).arrayBuffer(), expected);
  assert.ok(chunks.length < 8);
});
