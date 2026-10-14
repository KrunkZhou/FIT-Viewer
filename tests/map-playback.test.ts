import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { MapPlaybackIndex } from "../src/document/map-playback";
import { mapData } from "../src/document/series";
import { createJob } from "../src/document/jobs";
import {
  mapCursorTime,
  mapProgressFromTime,
  mapTimeFromProgress,
  mapTimeRange,
  mapTimelineSegments,
} from "../src/ui/map-playback";
import { activity, file, type Field } from "./fixtures";

test("map scrubbing uses original GPS samples, not simplified route endpoints", async () => {
  const document = await FitDocument.open(activity(100), "gps.fit");
  const index = new MapPlaybackIndex();
  const map = await mapData(document, undefined, false, undefined, index);
  assert.equal(map.tracks[0].length, 2);
  assert.deepEqual(index.routes, [
    { route: 0, start: 1100000000, end: 1100000099, count: 100 },
  ]);
  const job = createJob(new AbortController().signal);
  const position = await index.position(document, 1100000037, [0], job);
  assert.equal(position?.time, 1100000037);
  assert.ok(!map.tracks[0].some((point) => point.record === position?.record));
  const cells = document.cells(position!.record);
  assert.equal(position?.lat, cells["0"].value);
  assert.equal(position?.lon, cells["1"].value);
  assert.equal(position?.distance, cells["5"].value);
  assert.equal(position?.elevation, cells["2"].value);
  assert.equal(
    (await index.position(document, 1100000037.5, [0], job))?.time,
    1100000037,
  );
  assert.equal(await index.position(document, NaN, [0], job), null);
  assert.equal(await index.position(document, 0, [], job), null);
});

test("playback handles time zero, untimed GPS, duplicates and backwards timestamp runs without interpolation", async () => {
  const document = await FitDocument.open(
    file(
      [0, 10, 10, undefined, 5, 15].map((time, id) => ({
        message: 20,
        fields: [
          ...(time === undefined ? [] : [[253, 6, time]]),
          [0, 5, id * 10000],
          [1, 5, id * 20000],
        ] as Field[],
      })),
      false,
    ),
    "runs.fit",
  );
  const index = new MapPlaybackIndex();
  const map = await mapData(document, undefined, false, undefined, index);
  const job = createJob(new AbortController().signal);
  assert.equal(map.tracks.length, 1);
  assert.equal(index.routes[0].count, 5);
  assert.equal(index.routes[0].start, 0);
  assert.equal((await index.position(document, 0, [0], job))?.time, 0);
  assert.equal((await index.position(document, 5, [0], job))?.time, 5);
  assert.equal((await index.position(document, 7.5, [0], job))?.time, 5);
  const duplicate = await index.position(document, 10, [0], job);
  assert.equal(duplicate?.record, document.recordIds(20)[1]);
  assert.equal((await index.position(document, 1000, [0], job))?.time, 15);
});

test("date and route visibility filters constrain original-sample lookup and slider bounds", async () => {
  const first = activity(100);
  const second = activity(100);
  const document = await FitDocument.openSources(
    [
      { filename: "first.fit", bytes: first },
      { filename: "second.fit", bytes: second },
    ],
    "2 files",
  );
  const index = new MapPlaybackIndex();
  await mapData(
    document,
    undefined,
    false,
    { start: 1100000020, end: 1100000040 },
    index,
  );
  assert.deepEqual(
    index.routes.map((route) => route.count),
    [21, 21],
  );
  const job = createJob(new AbortController().signal);
  assert.equal(
    (await index.position(document, 1100000000, [1], job))?.time,
    1100000020,
  );
  assert.equal(
    (await index.position(document, 1100000030, [1], job))?.route,
    1,
  );
  assert.equal(
    (await index.position(document, 1100000030, [0, 1], job))?.route,
    0,
  );
  assert.equal(await index.position(document, 1100000030, [], job), null);
  const range = mapTimeRange(index.routes, [0]);
  assert.deepEqual(range, {
    start: 1100000020,
    end: 1100000040,
    routes: [1],
    length: 20,
    intervals: [{ start: 1100000020, end: 1100000040, offset: 0, length: 20 }],
  });
  assert.equal(mapCursorTime(undefined, range), 1100000020);
  assert.equal(mapCursorTime(1100000100, range), 1100000040);
  assert.equal(mapCursorTime(1100000000, range), 1100000020);
  assert.equal(mapTimeRange(index.routes, [0, 1]), undefined);
  assert.equal(mapCursorTime(0, undefined), undefined);
  assert.equal(mapCursorTime(0, { start: 0, end: 100 }), 0);
});

test("building and querying the time index honor cancellation", async () => {
  const controller = new AbortController();
  const job = createJob(controller.signal);
  const index = new MapPlaybackIndex();
  controller.abort();
  await assert.rejects(
    index.addTrack([{ lat: 0, lon: 0, record: 0, time: 0 }], 0, job),
    { name: "AbortError" },
  );
  const document = await FitDocument.open(activity(10), "gps.fit");
  const ready = new MapPlaybackIndex();
  await mapData(document, undefined, false, undefined, ready);
  await assert.rejects(ready.position(document, 0, [0], job), {
    name: "AbortError",
  });
});

test("map timeline skips gaps and honors route visibility", () => {
  const routes = [
    { route: 0, start: 0, end: 128, count: 100 },
    { route: 1, start: 384, end: 512, count: 100 },
  ];
  assert.deepEqual(mapTimelineSegments(routes, [], ["green", "blue"]), [
    { start: 0, end: 50, colors: ["green"] },
    { start: 50, end: 100, colors: ["blue"] },
  ]);
  assert.deepEqual(mapTimelineSegments(routes, [0], ["green", "blue"]), [
    { start: 0, end: 100, colors: ["blue"] },
  ]);
  assert.deepEqual(mapTimelineSegments(routes, [0, 1], ["green", "blue"]), []);
  assert.deepEqual(mapTimelineSegments(routes, [], []), []);
});

test("point-only routes have selectable slots without inventing timestamps", () => {
  const routes = [
    { route: 0, start: 0, end: 0, count: 1 },
    { route: 1, start: 512, end: 512, count: 1 },
  ];
  const original = structuredClone(routes);
  assert.deepEqual(mapTimelineSegments(routes, [], ["green", "blue"]), [
    { start: 0, end: 50, colors: ["green"] },
    { start: 50, end: 100, colors: ["blue"] },
  ]);
  assert.deepEqual(mapTimelineSegments(routes, [], ["green"]), [
    { start: 0, end: 100, colors: ["green"] },
  ]);
  assert.deepEqual(mapTimeRange(routes, []), {
    start: 0,
    end: 512,
    routes: [0, 1],
    length: 2,
    intervals: [
      { start: 0, end: 0, offset: 0, length: 1 },
      { start: 512, end: 512, offset: 1, length: 1 },
    ],
  });
  const range = mapTimeRange(routes, []);
  assert.equal(mapCursorTime(256, range), 0);
  assert.equal(mapTimeFromProgress(0.5, range), 0);
  assert.equal(mapTimeFromProgress(1.5, range), 512);
  assert.equal(mapProgressFromTime(0, range), 0);
  assert.equal(mapProgressFromTime(512, range), 2);
  assert.deepEqual(routes, original);
});

test("slider time mapping skips long filtered-route gaps even when both routes have the same color", () => {
  const routes = [
    { route: 0, start: 100, end: 200, count: 100 },
    { route: 1, start: 500, end: 600, count: 100 },
    { route: 10, start: 1_000_000, end: 1_000_100, count: 100 },
  ];
  const original = structuredClone(routes);
  const range = mapTimeRange(routes, [1])!;
  assert.equal(range.length, 200);
  assert.deepEqual(range.routes, [0, 10]);
  assert.deepEqual(
    mapTimelineSegments(
      routes,
      [1],
      ["green", "blue", "red", "purple", "gold"],
      range,
    ),
    [{ start: 0, end: 100, colors: ["green"] }],
  );
  assert.equal(mapTimeFromProgress(50, range), 150);
  assert.equal(mapTimeFromProgress(100, range), 200);
  assert.equal(mapTimeFromProgress(100.5, range), 1_000_000.5);
  assert.equal(mapTimeFromProgress(150, range), 1_000_050);
  assert.equal(mapProgressFromTime(1_000_050, range), 150);
  assert.equal(mapCursorTime(300, range), 200);
  assert.equal(mapCursorTime(900_000, range), 1_000_000);
  assert.equal(mapProgressFromTime(300, range), 100);
  assert.equal(mapTimeFromProgress(-1, range), 100);
  assert.equal(mapTimeFromProgress(Infinity, range), 100);
  assert.equal(mapTimeFromProgress(1000, range), 1_000_100);
  assert.equal(mapTimeFromProgress(0, undefined), undefined);
  assert.equal(mapProgressFromTime(0, undefined), undefined);
  const remaining = mapTimeRange(routes, [0, 1])!;
  assert.equal(mapCursorTime(150, remaining), 1_000_000);
  assert.equal(mapProgressFromTime(150, remaining), 0);
  assert.deepEqual(routes, original);
});

test("overlapping time ranges are counted once and compressed progress round-trips real timestamps", () => {
  const routes = [
    { route: 0, start: 1_100_000_000, end: 1_100_000_100, count: 100 },
    { route: 1, start: 1_100_000_050, end: 1_100_000_150, count: 100 },
    { route: 2, start: 1_100_000_150, end: 1_100_000_200, count: 100 },
    { route: 3, start: 1_100_100_000, end: 1_100_100_050, count: 100 },
  ];
  const range = mapTimeRange(routes, [])!;
  assert.equal(range.length, 250);
  assert.equal(range.intervals.length, 2);
  for (const time of [
    1_100_000_000, 1_100_000_075.125, 1_100_000_200, 1_100_100_015.5,
    1_100_100_050,
  ])
    assert.equal(
      mapTimeFromProgress(mapProgressFromTime(time, range)!, range),
      time,
    );
  assert.equal(mapCursorTime(1_100_050_000, range), 1_100_000_200);
  assert.equal(
    mapTimeRange([{ route: 0, start: NaN, end: 10, count: 1 }], []),
    undefined,
  );
});

test("compressed two-route scrubbing moves through original GPS samples on both same-colored routes", async () => {
  const entries = [0, 1].map((source) => ({
    filename: `route-${source}.fit`,
    bytes: file(
      Array.from({ length: 100 }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, (source ? 1_000_000 : 100) + i],
          [0, 5, source * 1_000_000 + i * 1000],
          [1, 5, source * 2_000_000 + i * 2000],
        ] as Field[],
      })),
      false,
    ),
  }));
  const document = await FitDocument.openSources(entries, "two routes");
  const map = await mapData(document, undefined, true);
  const index = new MapPlaybackIndex();
  const job = createJob(new AbortController().signal);
  await index.addTrack(map.tracks[0], 0, job);
  await index.addTrack(map.tracks[1], 10, job);
  assert.deepEqual(
    index.routes.map((route) => route.count),
    [100, 100],
  );
  const range = mapTimeRange(index.routes, [])!;
  const positions = [];
  for (const progress of [10, 40, 109, 139])
    positions.push(
      await index.position(
        document,
        mapTimeFromProgress(progress, range)!,
        range.routes,
        job,
      ),
    );
  assert.deepEqual(
    positions.map((point) => point!.route),
    [0, 0, 10, 10],
  );
  assert.deepEqual(
    positions.map((point) => point!.time),
    [110, 140, 1_000_010, 1_000_040],
  );
  assert.equal(new Set(positions.map((point) => point!.record)).size, 4);
  for (const point of positions)
    assert.equal(point!.lat, document.cells(point!.record)["0"].value);
});

test("overlapping routes share color bands and zero-duration routes stay visible", () => {
  assert.deepEqual(
    mapTimelineSegments(
      [
        { route: 0, start: 0, end: 384, count: 100 },
        { route: 1, start: 128, end: 512, count: 100 },
      ],
      [],
      ["green", "blue"],
    ),
    [
      { start: 0, end: 25, colors: ["green"] },
      { start: 25, end: 75, colors: ["green", "blue"] },
      { start: 75, end: 100, colors: ["blue"] },
    ],
  );
  assert.deepEqual(
    mapTimelineSegments(
      [
        { route: 6, start: 0, end: 0, count: 1 },
        { route: 5, start: 0, end: 0, count: 1 },
      ],
      [],
      ["green", "blue"],
    ),
    [{ start: 0, end: 100, colors: ["green", "blue"] }],
  );
  assert.deepEqual(
    mapTimelineSegments(
      [
        { route: 0, start: NaN, end: 1, count: 1 },
        { route: -1, start: 0, end: 1, count: 1 },
        { route: 0, start: 10, end: 0, count: 1 },
      ],
      [],
      ["green"],
    ),
    [],
  );
});

test("large map timelines have bounded display segments without changing source times", () => {
  const routes = Array.from({ length: 10_000 }, (_, route) => ({
    route,
    start: route * 2,
    end: route * 2 + 1,
    count: 10,
  }));
  const original = structuredClone(routes);
  const segments = mapTimelineSegments(
    routes,
    [],
    ["green", "blue", "red", "purple", "gold"],
  );
  assert.ok(segments.length <= 512);
  assert.equal(segments[0].start, 0);
  assert.equal(segments.at(-1)!.end, 100);
  assert.ok(
    segments.every(
      (segment) =>
        segment.start < segment.end &&
        segment.colors.length > 0 &&
        segment.colors.length <= 5,
    ),
  );
  assert.deepEqual(routes, original);
});
