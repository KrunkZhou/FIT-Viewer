import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChartCache } from "../src/document/chart-cache";
import { chartPointBudget } from "../src/document/chart-sampling";
import { DocumentClient } from "../src/document/client";
import { FitDocument } from "../src/document/document";
import { chart } from "../src/document/series";
import type { ChartQuery, Job } from "../src/model";
import Charts from "../src/ui/Charts";
import { file, type Field } from "./fixtures";

const job: Job = {
  signal: new AbortController().signal,
  yield: async () => {},
  progress: () => {},
};
const query: ChartQuery = {
  sensors: ["165:5", "165:6", "165:7"],
  width: 128,
  developer: false,
};
function motion(count = 120, start = 100, allFamilies = false) {
  return file(
    Array.from({ length: count }, (_, i) => ({
      message: 165,
      fields: [
        [253, 6, start + i],
        [0, 4, 0],
        [1, 4, Array.from({ length: 25 }, (_, j) => j * 10)],
        ...(allFamilies ? [2, 3, 4, 5, 6, 7, 8, 9, 10] : [5, 6, 7]).map(
          (field) =>
            [
              field,
              field < 5 || field > 7 ? 4 : 8,
              Array.from({ length: 25 }, (_, j) =>
                field < 5 || field > 7
                  ? (i * 25 + j) % 123
                  : Math.sin((i * 25 + j) * field) * 10,
              ),
            ] as Field,
        ),
      ] as Field[],
    })),
    false,
  );
}

test("chart detail is bounded, increases visible samples, and preserves exact aligned XYZ values", async () => {
  assert.equal(chartPointBudget(128), 256);
  assert.equal(chartPointBudget(128, "high"), 512);
  assert.equal(chartPointBudget(128, "maximum"), 1024);
  assert.equal(chartPointBudget(Infinity, "maximum"), 8);
  assert.equal(chartPointBudget(100_000, "maximum"), 8192);
  const document = await FitDocument.open(motion(), "detail.fit");
  const counts: number[] = [];
  for (const detail of ["standard", "high", "maximum"] as const) {
    const data = await chart(document, { ...query, detail });
    const points = data.series["165:5"];
    counts.push(points.length);
    assert.ok(points.length <= chartPointBudget(query.width, detail));
    assert.equal(points[0].time, 100);
    assert.equal(points.at(-1)!.time, 219.24);
    for (const key of query.sensors)
      assert.deepEqual(
        data.series[key].map((p) => p.time),
        points.map((p) => p.time),
      );
    for (let index = 0; index < points.length; index++) {
      const time = points[index].time;
      const frame = Math.round(time - 100) * 25 + Math.round((time % 1) * 100);
      for (const field of [5, 6, 7]) {
        assert.equal(
          data.series[`165:${field}`][index].value,
          Math.fround(Math.sin(frame * field) * 10),
        );
      }
    }
  }
  assert.ok(counts[1] > counts[0]);
  assert.ok(counts[2] > counts[1]);
});

test("motion families keep their detail budget when unrelated raw/compressed families are selected", async () => {
  const document = await FitDocument.open(
    motion(120, 100, true),
    "families.fit",
  );
  const calibrated = await chart(document, query);
  const all = await chart(document, {
    ...query,
    sensors: Array.from({ length: 9 }, (_, i) => `165:${i + 2}`),
  });
  for (const key of query.sensors)
    assert.deepEqual(all.series[key], calibrated.series[key]);
});

test("combined file detail is allocated across files once, not divided again by axes", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes: motion() },
      { filename: "b.fit", bytes: motion(240, 1000) },
    ],
    "both.fit",
    job,
  );
  const sensors = [0, 1].flatMap((source) =>
    query.sensors.map((key) => `${key}:file:${source}`),
  );
  const standard = await chart(document, { ...query, sensors });
  const high = await chart(document, { ...query, sensors, detail: "high" });
  assert.ok(
    high.series[sensors[0]].length > standard.series[sensors[0]].length,
  );
  assert.ok(high.series[sensors[3]].length > high.series[sensors[0]].length);
  assert.ok(
    high.series[sensors[0]].length + high.series[sensors[3]].length <=
      chartPointBudget(query.width, "high"),
  );
  for (const source of [0, 1]) {
    const times = high.series[`165:5:file:${source}`].map((p) => p.time);
    for (const field of [6, 7])
      assert.deepEqual(
        high.series[`165:${field}:file:${source}`].map((p) => p.time),
        times,
      );
  }
});

test("worker chart cache keys cover all query options and document identity", async () => {
  const cache = new ChartCache(20);
  const document = await FitDocument.open(motion(), "cache.fit");
  const original = await cache.query(document, query, job);
  assert.equal(
    await cache.query(
      document,
      { ...query, sensors: [...query.sensors].reverse() },
      job,
    ),
    original,
  );
  for (const changed of [
    { width: 256 },
    { detail: "high" as const },
    { start: 110 },
    { end: 150 },
    { developer: true },
    { sensors: ["165:5"] },
    { filter: { min: 0 } },
    { filter: { max: 0 } },
    { dates: { start: 110 } },
    { dates: { end: 150 } },
    { dates: { intervals: [] } },
    { dates: { intervals: [{ start: 110, end: 150 }] } },
  ])
    assert.notEqual(
      await cache.query(document, { ...query, ...changed }, job),
      original,
    );
  const other = await FitDocument.open(motion(), "other.fit");
  assert.notEqual(await cache.query(other, query, job), original);
  cache.clear();
  assert.notEqual(await cache.query(document, query, job), original);
});

test("ordinary multi-file metrics share their own budget and reallocate detail after time filtering", async () => {
  const entries = [0, 1, 2].map((source) => ({
    filename: `ordinary-${source}.fit`,
    bytes: file(
      Array.from({ length: 1000 }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, source * 2000 + i],
          [3, 2, 50 + (i % 80)],
          [2, 4, 1000 + (i % 500)],
        ] as Field[],
      })),
      false,
    ),
  }));
  const document = await FitDocument.openSources(entries, "ordinary.zip", job);
  const keys = [0, 1, 2].map((source) => `20:3:file:${source}`);
  const request = {
    sensors: keys,
    width: 128,
    detail: "high" as const,
    developer: false,
  };
  const data = await chart(document, request);
  assert.ok(
    Object.values(data.series).reduce(
      (sum, points) => sum + points.length,
      0,
    ) <=
      chartPointBudget(128, "high") + 24,
  );
  const withAltitude = await chart(document, {
    ...request,
    sensors: [...keys, ...[0, 1, 2].map((source) => `20:2:file:${source}`)],
  });
  for (const key of keys)
    assert.deepEqual(withAltitude.series[key], data.series[key]);
  const focused = await chart(document, { ...request, start: 4010, end: 4029 });
  assert.equal(focused.series[keys[0]].length, 0);
  assert.equal(focused.series[keys[1]].length, 0);
  assert.equal(focused.series[keys[2]].length, 20);
});

test("chart cache evicts least recently used results and oversized results, and acknowledges cancellation on hits", async () => {
  const document = await FitDocument.open(motion(), "eviction.fit");
  const cache = new ChartCache(2);
  const first = await cache.query(document, query, job);
  const second = await cache.query(document, { ...query, detail: "high" }, job);
  assert.equal(await cache.query(document, query, job), first);
  await cache.query(document, { ...query, detail: "maximum" }, job);
  assert.notEqual(
    await cache.query(document, { ...query, detail: "high" }, job),
    second,
  );
  const tiny = new ChartCache(6, 1);
  assert.notEqual(
    await tiny.query(document, query, job),
    await tiny.query(document, query, job),
  );
  const cancelled: Job = {
    ...job,
    yield: async () => {
      throw new DOMException("Cancelled", "AbortError");
    },
  };
  await assert.rejects(cache.query(document, query, cancelled), {
    name: "AbortError",
  });
  const abortMiss = new ChartCache();
  await assert.rejects(abortMiss.query(document, query, cancelled), {
    name: "AbortError",
  });
  const next = await abortMiss.query(document, query, job);
  assert.equal(await abortMiss.query(document, query, job), next);
});

test("chart detail is a compact named icon dropdown with high as the default", () => {
  const markup = renderToStaticMarkup(
    createElement(Charts, {
      client: {} as DocumentClient,
      developer: false,
      active: true,
      dates: {},
      onDatesChange: () => {},
      download: () => {},
    }),
  );
  assert.match(markup, /aria-label="Chart detail"/);
  assert.match(markup, /data-detail="high"/);
  assert.ok(!markup.includes('<select aria-label="Chart detail"'));
  assert.match(markup, /downloads always retain full resolution/);
  const syncTime = markup.match(
    /<button[^>]*aria-label="Sync time"[^>]*>/,
  )?.[0];
  assert.ok(syncTime);
  assert.match(syncTime, /aria-checked="true"/);
});
