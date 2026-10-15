import assert from "node:assert/strict";
import test from "node:test";
import { ChartCache } from "../src/document/chart-cache";
import { FitDocument } from "../src/document/document";
import { NumericReader } from "../src/document/numeric-reader";
import { chart, chartSensors, mapData, sensors } from "../src/document/series";
import { sampleStatistics } from "../src/document/sample-statistics";
import { initialCharts } from "../src/ui/chart-inventory";
import type { DocumentClient } from "../src/document/client";
import type { ChartQuery, RequestPayload } from "../src/model";
import { idleJob } from "../src/protocol/reader";
import { activity, file, type Field } from "./fixtures";

const motion = () =>
  file(
    Array.from({ length: 70 }, (_, i) => ({
      message: 165,
      fields: [
        [253, 6, 100 + i],
        [0, 4, 0],
        [1, 4, [0, 10, 20]],
        [5, 8, [i, -i, i + 0.5]],
        [6, 8, [5, 5, 5]],
        [7, 8, [NaN, i * 2, -i * 3]],
      ] as Field[],
    })),
    false,
  );
const motionQuery: ChartQuery = {
  sensors: ["165:5", "165:6", "165:7"],
  width: 100,
  developer: false,
};

test("projected GPS cells match full decoding and omit unrelated large fields", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 100],
            [0, 5, 12345],
            [1, 5, -56789],
            [2, 4, 3000],
            [5, 6, 1234],
            [99, 8, Array(50).fill(12)],
          ],
        },
        {
          message: 20,
          little: false,
          fields: [
            [253, 6, 101],
            [0, 5, 0],
            [1, 5, 0],
            [2, 4, 65535],
            [6, 4, 65535],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 102],
            [0, 5, 1],
            [1, 5, 2],
            [78, 6, 4000],
            [2, 4, 3000],
            [8, 13, [12, 2, 1]],
          ],
        },
      ],
      false,
    ),
    "projection.fit",
  );
  const keys = new Set(["0", "1", "2", "5", "6", "73", "78", "253"]);
  for (let id = 0; id < document.index.records.length; id++) {
    const full = document.cells(id);
    assert.deepEqual(
      document.cells(id, true, keys),
      Object.fromEntries(Object.entries(full).filter(([key]) => keys.has(key))),
    );
    const reader = new NumericReader(document, keys, false);
    assert.deepEqual(
      reader.read(id),
      [...keys].map((key) => full[key]),
    );
  }
  const expected = await mapData(document, idleJob(), true);
  const raw = document.metadata.raw.bind(document.metadata);
  const decoded: (ReadonlySet<string> | undefined)[] = [];
  document.metadata.raw = (record, keys) => {
    decoded.push(keys);
    return raw(record, keys);
  };
  assert.deepEqual(await mapData(document, idleJob(), true), expected);
  assert.ok(decoded.every((keys) => keys && !keys.has("99")));
  let reads = 0;
  document.metadata.raw = (record, keys) => {
    reads++;
    return raw(record, keys);
  };
  const filtered = await mapData(document, idleJob(), false, { start: 1000 });
  assert.equal(reads, 0);
  assert.deepEqual(filtered.tracks, []);
});

test("cold motion charts reuse exact full-resolution statistics without changing aligned samples or eligibility", async () => {
  const document = await FitDocument.open(motion(), "cold.fit");
  const result = await chart(document, motionQuery);
  const cached = sampleStatistics(document, false);
  assert.equal(cached.get("165:5")?.count, 210);
  assert.equal(cached.get("165:6")?.count, 210);
  assert.equal(cached.get("165:7")?.count, 140);
  assert.deepEqual(Object.keys(result.series), ["165:5", "165:7"]);
  const count = cached.get("165:5");
  let scans = 0;
  await chartSensors(document, false, {
    ...idleJob(),
    progress: () => scans++,
  });
  assert.equal(
    scans,
    0,
    "inventory must not rescan completed motion statistics",
  );
  assert.equal(cached.get("165:5"), count);
  const reference = await FitDocument.open(motion(), "warm.fit");
  await chartSensors(reference, false);
  assert.deepEqual(result, await chart(reference, motionQuery));
  assert.equal(sampleStatistics(document, true).size, 0);
});

test("filtered motion charts do not cache partial statistics and cancellation does not publish incomplete summaries", async () => {
  const document = await FitDocument.open(motion(), "filtered.fit");
  await chart(document, {
    ...motionQuery,
    start: 110,
    end: 115,
    filter: { min: 0 },
  });
  assert.equal(sampleStatistics(document, false).get("165:5")?.count, 210);
  const cancelled = await FitDocument.open(motion(), "cancel.fit");
  let checkpoints = 0;
  await assert.rejects(
    chart(cancelled, motionQuery, {
      ...idleJob(),
      yield: async () => {
        if (++checkpoints === 3)
          throw new DOMException("Cancelled", "AbortError");
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(sampleStatistics(cancelled, false).size, 0);
  await chart(cancelled, motionQuery);
  assert.equal(sampleStatistics(cancelled, false).get("165:5")?.count, 210);
});

test("first chart loading requests preferred sensors before unrelated inventory and caches those plots", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "activity.fit", bytes: activity(100) },
      { filename: "motion.fit", bytes: motion() },
    ],
    "priority.zip",
    idleJob(),
  );
  const cache = new ChartCache();
  const requests: RequestPayload[] = [];
  const client = {
    request: async (payload: RequestPayload) => {
      requests.push(payload);
      if (payload.kind === "sensor-candidates")
        return sensors(document, payload.developer);
      if (payload.kind === "chart")
        return cache.query(document, payload.query, idleJob());
      throw new Error("Unexpected request");
    },
  } as Pick<DocumentClient, "request">;
  const options = { width: 128, developer: false };
  const first = await initialCharts(
    client,
    ["20:3"],
    true,
    options,
    new AbortController().signal,
  );
  assert.deepEqual(Object.keys(first.series), ["20:3:file:0"]);
  assert.deepEqual(
    requests.map((request) => request.kind),
    ["sensor-candidates", "chart"],
  );
  assert.equal(sampleStatistics(document, false).has("165:5:file:1"), false);
  const again = await cache.query(
    document,
    { ...options, sensors: ["20:3:file:0"] },
    idleJob(),
  );
  assert.equal(first.series["20:3:file:0"], again.series["20:3:file:0"]);
  await chartSensors(document, false);
  assert.equal(sampleStatistics(document, false).has("165:5:file:1"), true);
  assert.equal(
    (
      await cache.query(
        document,
        { ...options, sensors: ["20:3:file:0"] },
        idleJob(),
      )
    ).series["20:3:file:0"],
    first.series["20:3:file:0"],
  );
});
