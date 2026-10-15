import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { ChartCache } from "../src/document/chart-cache";
import { chartQueryGroups } from "../src/document/chart-query";
import { chart } from "../src/document/series";
import { ChartGroupLoader } from "../src/ui/chart-loader";
import { ChartPlotCache } from "../src/ui/chart-plots";
import { groupMotionAxes, groupSensors } from "../src/ui/chart-groups";
import type { ChartData, ChartQuery, Sensor } from "../src/model";
import { activity, file, type Field } from "./fixtures";

const query = (key: string, start?: number): ChartQuery => ({
  sensors: [key],
  developer: false,
  width: 128,
  start,
});
const result = (key: string): ChartData => ({
  sensors: [],
  series: {
    [key]: [
      { time: 1, value: 10 },
      { time: 2, value: 20 },
    ],
  },
  start: 1,
  end: 2,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function controlled() {
  const calls: {
    query: ChartQuery;
    signal: AbortSignal;
    resolve: (data: ChartData) => void;
    reject: (error: Error) => void;
  }[] = [];
  const loader = new ChartGroupLoader(
    (query, signal) =>
      new Promise((resolve, reject) => {
        calls.push({ query, signal, resolve, reject });
      }),
  );
  return { loader, calls };
}

test("adding and reselecting charts only requests missing groups and preserves displayed series", async () => {
  const { loader, calls } = controlled();
  loader.select([query("a")]);
  const a = result("a");
  calls[0].resolve(a);
  await flush();
  loader.select([query("a"), query("b")]);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].query.sensors, ["b"]);
  assert.equal(loader.getSnapshot().series.a, a.series.a);
  assert.equal(loader.getSnapshot().loading, true);
  const b = result("b");
  calls[1].resolve(b);
  await flush();
  assert.equal(loader.getSnapshot().series.a, a.series.a);
  assert.equal(loader.getSnapshot().series.b, b.series.b);
  assert.equal(loader.getSnapshot().loading, false);
  loader.select([query("a")]);
  loader.select([query("a"), query("b")]);
  assert.equal(calls.length, 2);
  loader.select([query("a", 0), query("b", 0)]);
  assert.equal(calls.length, 4);
  assert.equal(loader.getSnapshot().loading, true);
  loader.dispose();
  assert.equal(calls[2].signal.aborted, true);
  assert.equal(calls[3].signal.aborted, true);
});

test("selection changes preserve pending wanted loads, cancel obsolete ones and ignore late results", async () => {
  const { loader, calls } = controlled();
  loader.select([query("a")]);
  loader.select([query("a"), query("b"), query("c")]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].signal.aborted, false);
  loader.select([query("a"), query("c")]);
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].query.sensors, ["c"]);
  calls[1].resolve(result("b"));
  calls[0].resolve(result("a"));
  calls[2].resolve(result("c"));
  await flush();
  assert.deepEqual(Object.keys(loader.getSnapshot().series), ["a", "c"]);
  assert.equal(loader.getSnapshot().loading, false);
  let notifications = 0;
  loader.subscribe(() => notifications++);
  loader.select([query("d")]);
  loader.dispose();
  const before = notifications;
  calls[3].resolve(result("d"));
  await flush();
  assert.equal(notifications, before);
  assert.deepEqual(loader.getSnapshot().series, {});
});

test("unrelated plots retain all prop references while a new plot or XYZ family is prepared", () => {
  const sensors: Sensor[] = [
    {
      key: "20:3",
      name: "Heart rate",
      units: "bpm",
      message: 20,
      field: "3",
      axis: "time",
    },
    {
      key: "20:6",
      name: "Speed",
      units: "m/s",
      message: 20,
      field: "6",
      axis: "time",
    },
    ...[5, 6, 7].map((field, i) => ({
      key: `165:${field}`,
      name: `Accel ${["X", "Y", "Z"][i]}`,
      units: "g",
      message: 165,
      field: String(field),
      axis: "time" as const,
    })),
  ];
  const groups = groupSensors(sensors);
  const series = Object.fromEntries(
    sensors.map((sensor) => [
      sensor.key,
      result(sensor.key).series[sensor.key],
    ]),
  );
  const cache = new ChartPlotCache();
  const first = cache.prepare(groups.slice(0, 1), series, () => "red")[0];
  const added = cache.prepare(groups.slice(0, 2), { ...series }, () => "red");
  assert.equal(added[0], first);
  const combined = cache.prepare(
    groupMotionAxes(groups, true),
    series,
    () => "red",
  );
  assert.equal(combined[0], first);
  assert.equal(combined[1], added[1]);
  assert.equal(combined[2].lines.length, 3);
  const replaced = { ...series, "20:6": [{ time: 3, value: 50 }] };
  const next = cache.prepare(
    groupMotionAxes(groups, true),
    replaced,
    () => "red",
  );
  assert.equal(next[0], first);
  assert.notEqual(next[1], added[1]);
  assert.equal(next[2], combined[2]);
});

test("worker group caching keeps prior series and matches combined queries including filtered source budgets", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "a.fit", bytes: activity(250) },
      { filename: "b.fit", bytes: activity(500) },
    ],
    "both.fit",
  );
  const cache = new ChartCache();
  const heart = [0, 1].map((source) => `20:3:file:${source}`);
  const speed = [0, 1].map((source) => `20:6:file:${source}`);
  const request: ChartQuery = {
    sensors: heart,
    width: 128,
    developer: false,
    detail: "high",
  };
  const first = await cache.query(document, request, {
    signal: new AbortController().signal,
    progress: () => {},
    yield: async () => {},
  });
  const processed = new Set<string>();
  const staticField = document.metadata.staticField.bind(document.metadata);
  document.metadata.staticField = (record, wire) => {
    processed.add(String(wire.id));
    return staticField(record, wire);
  };
  const cells = document.cells.bind(document);
  document.cells = (id, derived, selected) => {
    for (const key of selected ?? []) processed.add(key);
    return cells(id, derived, selected);
  };
  const added = await cache.query(
    document,
    { ...request, sensors: [...heart, ...speed] },
    {
      signal: new AbortController().signal,
      progress: () => {},
      yield: async () => {},
    },
  );
  assert.deepEqual([...processed], ["6"]);
  for (const key of heart) assert.equal(added.series[key], first.series[key]);
  assert.deepEqual(
    added,
    await chart(document, { ...request, sensors: [...heart, ...speed] }),
  );
  const filtered = {
    ...request,
    sensors: [...heart, ...speed],
    start: 1100000250,
    end: 1100000260,
  };
  assert.deepEqual(
    await cache.query(document, filtered, {
      signal: new AbortController().signal,
      progress: () => {},
      yield: async () => {},
    }),
    await chart(document, filtered),
  );
});

test("motion cache groups keep all selected axes and source files together without coupling other families", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 20 }, (_, i) => ({
        message: 165,
        fields: [
          [253, 6, 100 + i],
          [0, 4, 0],
          [1, 4, [0, 10, 20]],
          ...[2, 3, 4, 5, 6, 7].map(
            (field) =>
              [
                field,
                field < 5 ? 4 : 8,
                [i + field, i + field + 1, i + field + 2],
              ] as Field,
          ),
        ] as Field[],
      })),
      false,
    ),
    "motion.fit",
  );
  const inventory = await chart(document, {
    sensors: [],
    width: 128,
    developer: false,
  });
  const queries = chartQueryGroups(inventory.sensors, {
    sensors: ["165:2", "165:5", "165:6", "165:7"],
    width: 128,
    developer: false,
  });
  assert.deepEqual(
    queries.map((q) => q.sensors),
    [["165:2"], ["165:5", "165:6", "165:7"]],
  );
  const cache = new ChartCache();
  const job = {
    signal: new AbortController().signal,
    progress: () => {},
    yield: async () => {},
  };
  const calibrated = await cache.query(document, { ...queries[1] }, job);
  const both = await cache.query(
    document,
    { ...queries[1], sensors: queries.flatMap((q) => q.sensors) },
    job,
  );
  for (const key of queries[1].sensors)
    assert.equal(both.series[key], calibrated.series[key]);
  assert.deepEqual(
    both,
    await chart(document, {
      ...queries[1],
      sensors: queries.flatMap((q) => q.sensors),
    }),
  );
});
