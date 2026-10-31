import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { NumericReader } from "../src/document/numeric-reader";
import { chart, mapData, sensors } from "../src/document/series";
import { ChartCache } from "../src/document/chart-cache";
import { MapCache } from "../src/document/map-cache";
import { motionChart } from "../src/document/motion";
import { ChartGroupLoader } from "../src/ui/chart-loader";
import { exportDocument } from "../src/export/export";
import { idleJob } from "../src/protocol/reader";
import type { ChartData, ChartQuery } from "../src/model";
import { activity, file, type Field } from "./fixtures";

// Display results additionally retain record IDs; exported values stay unchanged.
function withoutRecordIds(data: ChartData): ChartData {
  return {
    ...data,
    series: Object.fromEntries(
      Object.entries(data.series).map(([key, points]) => [
        key,
        points.map(({ record: _record, ...point }) => point),
      ]),
    ),
  };
}

test("invalid native components never become enhanced speed or elevation", async () => {
  for (const little of [true, false]) {
    const document = await FitDocument.open(
      file(
        [
          {
            message: 20,
            little,
            fields: [
              [253, 6, 100],
              [0, 5, 100],
              [1, 5, 100],
              [2, 4, 65535],
              [6, 4, 65535],
            ],
          },
          {
            message: 20,
            little,
            fields: [
              [253, 6, 101],
              [0, 5, 200],
              [1, 5, 200],
              [2, 4, 65535],
              [6, 4, 65535],
              [78, 6, 3500],
              [73, 6, 3000],
            ],
          },
        ],
        false,
      ),
      "invalid.fit",
    );
    const keys = ["2", "6", "73", "78"];
    for (const developer of [true, false]) {
      const reader = new NumericReader(document, keys, developer);
      for (const id of document.recordIds(20))
        assert.deepEqual(
          reader.read(id),
          keys.map((key) => document.cells(id, !developer)[key]),
        );
    }
    assert.equal(document.cells(0)["2"].value, null);
    assert.equal(document.cells(0)["6"].value, null);
    assert.equal(document.cells(0)["73"], undefined);
    assert.equal(document.cells(0)["78"], undefined);
    assert.equal(document.cells(1)["73"].value, 3);
    assert.equal(document.cells(1)["78"].value, 200);
    const map = await mapData(document, idleJob(), true);
    assert.equal(map.tracks[0][0].elevation, undefined);
    assert.equal(map.tracks[0][1].elevation, 200);
    const gpx = await (
      await exportDocument(document, { format: "gpx" })
    ).blob.text();
    assert.equal((gpx.match(/<ele>/g) ?? []).length, 1);
    assert.ok(!gpx.includes("12607"));
    const geojson = JSON.parse(
      await (await exportDocument(document, { format: "geojson" })).blob.text(),
    );
    assert.equal(geojson.features[0].properties.elevation_m, null);
  }
});

test("cold ordinary chart groups read each record once and preserve full-resolution output", async () => {
  const document = await FitDocument.open(activity(100), "batch.fit");
  const query: ChartQuery = {
    sensors: ["20:3", "20:6", "20:73"],
    width: 1000,
    developer: false,
  };
  const read = NumericReader.prototype.read;
  let reads = 0;
  NumericReader.prototype.read = function (id) {
    reads++;
    return read.call(this, id);
  };
  let result: ChartData;
  try {
    result = await new ChartCache().query(document, query, idleJob());
    assert.equal(reads, 100);
  } finally {
    NumericReader.prototype.read = read;
  }
  const reference = await chart(document, query, idleJob(), true);
  assert.deepEqual(withoutRecordIds(result), reference);
});

test("batched charts preserve arrays, invalid slots, raw values, gaps and filtering", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 30 }, (_, i) => ({
        message: 600,
        little: i % 2 === 0,
        fields: [
          [253, 6, 100 + i + (i >= 10 ? 30 : 0)],
          [1, 4, [i, 65535, i + 1]],
          [2, 8, [i / 3, NaN]],
        ] as Field[],
      })),
      false,
    ),
    "arrays.fit",
  );
  for (const filters of [
    {},
    { start: 105, end: 155 },
    {
      dates: {
        intervals: [
          { start: 100, end: 107 },
          { start: 148, end: 159 },
        ],
      },
    },
    { filter: { min: 0, max: 16 } },
  ]) {
    const query = {
      sensors: ["600:1", "600:2"],
      width: 2000,
      developer: true,
      ...filters,
    };
    const actual = await chart(document, query);
    const expected = await chart(document, query, idleJob(), true);
    assert.deepEqual(withoutRecordIds(actual), expected);
  }
});

test("motion time indexes skip unrelated packets but retain late and out-of-order samples", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 4096 }, (_, i) => ({
        message: 165,
        fields: [
          [253, 6, i === 3000 ? 101 : i],
          [0, 4, 0],
          [1, 4, [0, i === 80 ? 30000 : 10]],
          [5, 8, [i, -i]],
        ] as Field[],
      })),
      false,
    ),
    "indexed.fit",
  );
  const selected = sensors(document, false).filter(
    (sensor) => sensor.key === "165:5",
  );
  const query: ChartQuery = {
    sensors: ["165:5"],
    developer: false,
    width: 2000,
    start: 100,
    end: 115,
  };
  const segment = document.index.bytes.segment.bind(document.index.bytes);
  let reads = 0;
  document.index.bytes.segment = (offset) => {
    reads++;
    return segment(offset);
  };
  const cold = await motionChart(document, selected, query, idleJob());
  const fullReads = reads;
  reads = 0;
  const warm = await motionChart(document, selected, query, idleJob());
  assert.deepEqual(warm, cold);
  assert.ok(reads < fullReads / 3, `${reads} vs ${fullReads}`);
  assert.ok(
    warm.series["165:5"].some((p) => p.time === 110 && p.value === -80),
  );
  assert.ok(
    warm.series["165:5"].some((p) => p.time === 101 && p.value === 3000),
  );
});

test("initial plots seed the UI cache and supersede stale in-flight requests", async () => {
  const document = await FitDocument.open(activity(30), "seed.fit");
  const query: ChartQuery = { sensors: ["20:3"], developer: false, width: 100 };
  const data = await chart(document, query);
  let requests = 0;
  const loader = new ChartGroupLoader(async () => {
    requests++;
    return data;
  });
  loader.seed([query], data);
  loader.select([query]);
  assert.equal(requests, 0);
  assert.equal(loader.getSnapshot().series["20:3"], data.series["20:3"]);
  loader.dispose();
  let resolve!: (data: ChartData) => void;
  let pendingSignal!: AbortSignal;
  const pending = new ChartGroupLoader((_query, signal) => {
    pendingSignal = signal;
    return new Promise((r) => {
      resolve = r;
    });
  });
  pending.select([query]);
  pending.seed([query], data);
  assert.equal(pendingSignal.aborted, true);
  resolve({ ...data, series: { "20:3": [] } });
  await new Promise((r) => setImmediate(r));
  assert.equal(pending.getSnapshot().series["20:3"], data.series["20:3"]);
  assert.equal(pending.getSnapshot().loading, false);
  pending.dispose();
});

test("map LRU bounds filtered geometry and playback retention", async () => {
  const document = await FitDocument.open(activity(100), "cache.fit");
  for (const cache of [new MapCache(1), new MapCache(3, 50)]) {
    const original = await cache.query(document, idleJob());
    const filtered = await cache.query(document, idleJob(), {
      end: 1100000030,
    });
    assert.equal(
      await cache.query(document, idleJob(), { end: 1100000030 }),
      filtered,
    );
    assert.notEqual(await cache.query(document, idleJob()), original);
  }
});
