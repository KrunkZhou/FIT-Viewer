import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitDocument } from "../src/document/document";
import { chart, mapData } from "../src/document/series";
import {
  hasTimeRange,
  inTimeRange,
  intersectTimeRanges,
} from "../src/document/time-range";
import { exportDocument } from "../src/export/export";
import {
  dateFilterRange,
  dateInputValue,
  selectedDateRange,
  selectedDates,
  usesDateList,
} from "../src/ui/date-filter";
import { DateRangeFilter } from "../src/ui/DateRangeFilter";
import { FIT_EPOCH } from "../src/protocol/time";
import { file, type Field } from "./fixtures";

test("date filters include the full local calendar day, including daylight saving changes", () => {
  const previous = process.env.TZ;
  process.env.TZ = "America/Toronto";
  try {
    for (const [date, hours] of [
      ["2026-03-08", 23],
      ["2026-11-01", 25],
      ["2026-10-06", 24],
    ] as const) {
      const range = dateFilterRange(date, date);
      assert.equal(dateInputValue(range.start), date);
      assert.equal(dateInputValue(range.end), date);
      assert.ok(
        Math.abs(range.end! - range.start! + 0.001 - hours * 3600) < 0.0001,
      );
      assert.equal(inTimeRange(range.start, range), true);
      assert.equal(inTimeRange(range.end, range), true);
      assert.equal(inTimeRange(range.start! - 0.001, range), false);
      assert.equal(inTimeRange(range.end! + 0.001, range), false);
    }
    assert.equal(
      new Date(
        FIT_EPOCH + dateFilterRange("2026-10-06", "").start! * 1000,
      ).getHours(),
      0,
    );
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test("date filters validate dates and order, support open ends, and preserve zero timestamps", () => {
  for (const date of ["2026-02-30", "not a date", "2026-13-01", "0000-01-01"])
    assert.throws(() => dateFilterRange(date, ""), /valid date/);
  assert.throws(() => dateFilterRange("2026-10-07", "2026-10-06"), /end date/);
  assert.equal(hasTimeRange(dateFilterRange("", "")), false);
  assert.equal(dateFilterRange("", "2026-10-06").start, undefined);
  assert.equal(dateFilterRange("2026-10-06", "").end, undefined);
  assert.equal(inTimeRange(0, { start: 0, end: 0 }), true);
  assert.equal(inTimeRange(undefined, { start: 0 }), false);
  assert.equal(inTimeRange(undefined, {}), true);
  assert.equal(inTimeRange(NaN, { start: 0 }), false);
  assert.deepEqual(
    intersectTimeRanges({ start: 1, end: 9 }, { start: 3, end: 5 }),
    { start: 3, end: 5 },
  );
  assert.deepEqual(intersectTimeRanges({}, { start: 0 }), {
    start: 0,
    end: undefined,
  });
});

async function sampleDocument() {
  return FitDocument.open(
    file(
      Array.from({ length: 30 }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, i],
          [0, 5, 500000000 + i * 1000],
          [1, 5, -800000000 + i * 2000],
          [3, 2, 120 + i],
        ] as Field[],
      })),
      false,
    ),
    "dates.fit",
  );
}

test("map and chart date filters operate before simplification and downsampling; clearing restores data", async () => {
  const document = await sampleDocument();
  const dates = { start: 5, end: 20 };
  const view = await chart(document, {
    sensors: ["20:3"],
    developer: false,
    width: 100,
    dates,
  });
  assert.equal(view.series["20:3"].length, 16);
  assert.equal(view.start, 5);
  assert.equal(view.end, 20);
  const zoom = await chart(document, {
    sensors: ["20:3"],
    developer: false,
    width: 100,
    dates,
    start: 10,
    end: 30,
  });
  assert.equal(zoom.start, 10);
  assert.equal(zoom.end, 20);
  const map = await mapData(document, undefined, false, dates);
  assert.equal(map.tracks[0][0].time, 5);
  assert.equal(map.tracks[0].at(-1)?.time, 20);
  assert.ok(map.points.every((point) => inTimeRange(point.time, dates)));
  const empty = await mapData(document, undefined, false, { start: 100 });
  assert.deepEqual(empty.tracks, []);
  const cleared = await chart(document, {
    sensors: ["20:3"],
    developer: false,
    width: 100,
  });
  assert.equal(cleared.series["20:3"].length, 30);
});

test("filtered exports retain every matching GPS/chart point without exporting excluded dates", async () => {
  const document = await sampleDocument();
  const dates = { start: 5, end: 20 };
  const json = JSON.parse(
    await (
      await exportDocument(document, {
        format: "json",
        sensors: ["20:3"],
        dates,
      })
    ).blob.text(),
  );
  assert.equal(json.series["20:3"].length, 16);
  const geojson = JSON.parse(
    await (
      await exportDocument(document, { format: "geojson", dates })
    ).blob.text(),
  );
  assert.equal(geojson.features.length, 16);
  assert.ok(
    geojson.features.every((feature: { properties: { timestamp: string } }) =>
      inTimeRange(
        (Date.parse(feature.properties.timestamp) - FIT_EPOCH) / 1000,
        dates,
      ),
    ),
  );
  const gpx = await (
    await exportDocument(document, { format: "gpx", dates })
  ).blob.text();
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 16);
});

test("date filtering preserves fractional motion samples and intersects chart zoom", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 165,
          fields: [
            [253, 6, 100],
            [0, 4, 0],
            [1, 4, Array.from({ length: 25 }, (_, i) => i * 10)],
            [5, 8, Array.from({ length: 25 }, (_, i) => i)],
          ],
        },
      ],
      false,
    ),
    "motion.fit",
  );
  const result = await chart(document, {
    sensors: ["165:5"],
    developer: false,
    width: 100,
    dates: { start: 100.05, end: 100.2 },
    start: 100.1,
    end: 100.3,
  });
  assert.ok(result.series["165:5"].length > 0);
  assert.ok(
    result.series["165:5"].every(
      (point) => point.time >= 100.1 && point.time <= 100.2,
    ),
  );
});

test("undated sensors and GPS records are excluded only while a date filter is active", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 20 }, (_, i) => ({
        message: 64000,
        fields: [[0, 4, i]] as Field[],
      })),
      false,
    ),
    "untimed.fit",
  );
  const query = { sensors: ["64000:0"], developer: true, width: 100 };
  assert.equal((await chart(document, query)).series["64000:0"].length, 20);
  assert.deepEqual(
    (await chart(document, { ...query, dates: { start: 0 } })).series[
      "64000:0"
    ],
    [],
  );
  const gps = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [0, 5, 1234],
            [1, 5, 5678],
          ],
        },
      ],
      false,
    ),
    "untimed-gps.fit",
  );
  assert.equal((await mapData(gps)).tracks.length, 1);
  assert.equal(
    (await mapData(gps, undefined, false, { start: 0 })).tracks.length,
    0,
  );
});

test("date control exposes its active state and map popups never auto-pan", async () => {
  const markup = renderToStaticMarkup(
    createElement(DateRangeFilter, { value: { start: 0 }, onChange() {} }),
  );
  assert.match(markup, /aria-label="Filter by date" data-active="true"/);
  const source = await readFile(
    new URL("../src/ui/Map.tsx", import.meta.url),
    "utf8",
  );
  assert.equal((source.match(/autoPan=\{false\}/g) ?? []).length, 2);
  assert.equal((source.match(/keepInView=\{false\}/g) ?? []).length, 2);
  assert.ok(source.includes("routeName(selected.route)"));
  assert.ok(source.includes("routeName(point.route)"));
});

test("date checklist supports non-adjacent dates, empty selection and the 15-day boundary", () => {
  const available = ["2026-10-05", "2026-10-06", "2026-10-07"];
  const chosen = [available[0], available[2]];
  const range = selectedDateRange(chosen);
  assert.deepEqual(selectedDates(available, range), chosen);
  assert.deepEqual(selectedDates(available, {}), available);
  assert.deepEqual(selectedDates(available, selectedDateRange([])), []);
  assert.equal(hasTimeRange(selectedDateRange([])), true);
  assert.equal(inTimeRange(0, selectedDateRange([])), false);
  assert.equal(
    inTimeRange(dateFilterRange(available[1], "").start, range),
    false,
  );
  assert.deepEqual(
    selectedDates(available, dateFilterRange(available[1], available[2])),
    available.slice(1),
  );
  assert.equal(usesDateList([]), false);
  assert.equal(usesDateList(available), true);
  assert.equal(usesDateList(Array(14).fill("2026-10-05")), true);
  assert.equal(usesDateList(Array(15).fill("2026-10-05")), false);
});

test("available dates reflect real records, sparse files and midnight motion samples", async () => {
  const start = dateFilterRange("2026-10-05", "").start!;
  const midnight = dateFilterRange("2026-10-08", "").start!;
  const document = await FitDocument.open(
    file(
      [
        { message: 20, fields: [[253, 6, start]] },
        { message: 20, fields: [[253, 6, start + 60]] },
        { message: 20, fields: [[253, 6, 0xffffffff]] },
        {
          message: 165,
          fields: [
            [253, 6, midnight - 1],
            [0, 4, 990],
            [1, 4, [0, 20]],
            [5, 8, [1, 2]],
          ],
        },
      ],
      false,
    ),
    "days.fit",
  );
  assert.deepEqual(document.summary().availableDates, [
    "2026-10-05",
    "2026-10-07",
    "2026-10-08",
  ]);
});

test("non-adjacent date filters reach motion, ordinary charts, maps and full-resolution exports", async () => {
  const days = ["2026-10-05", "2026-10-06", "2026-10-07"];
  const document = await FitDocument.open(
    file(
      days.flatMap((day) => {
        const start = dateFilterRange(day, "").start! + 3600;
        return Array.from({ length: 20 }, (_, i) => [
          {
            message: 20,
            fields: [
              [253, 6, start + i],
              [0, 5, 500000000 + i * 1000],
              [1, 5, -800000000 + i * 1000],
              [3, 2, 100 + i],
            ] as Field[],
          },
          {
            message: 165,
            fields: [
              [253, 6, start + i],
              [0, 4, 0],
              [1, 4, [0, 10]],
              [5, 8, [i, i + 1]],
            ] as Field[],
          },
        ]).flat();
      }),
      false,
    ),
    "three-days.fit",
  );
  const dates = selectedDateRange([days[0], days[2]]);
  for (const full of [false, true]) {
    const data = await chart(
      document,
      { sensors: ["20:3", "165:5"], width: 100, developer: false, dates },
      undefined,
      full,
    );
    for (const series of Object.values(data.series)) {
      assert.ok(series.some((point) => dateInputValue(point.time) === days[0]));
      assert.ok(series.some((point) => dateInputValue(point.time) === days[2]));
      assert.ok(series.every((point) => inTimeRange(point.time, dates)));
      assert.ok(series.some((point) => point.value === null));
    }
  }
  const map = await mapData(document, undefined, true, dates);
  assert.equal(map.tracks.length, 2);
  assert.ok(map.tracks.flat().every((point) => inTimeRange(point.time, dates)));
  const gpx = await (
    await exportDocument(document, { format: "gpx", dates })
  ).blob.text();
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 40);
  const json = JSON.parse(
    await (
      await exportDocument(document, {
        format: "json",
        sensors: ["165:5"],
        dates,
      })
    ).blob.text(),
  );
  assert.equal(
    json.series["165:5"].filter(
      (point: { value: number | null }) => point.value !== null,
    ).length,
    80,
  );
  const geojson = JSON.parse(
    await (
      await exportDocument(document, { format: "geojson", dates })
    ).blob.text(),
  );
  assert.equal(geojson.features.length, 40);
  const none = selectedDateRange([]);
  const empty = await chart(document, {
    sensors: ["20:3", "165:5"],
    width: 100,
    developer: false,
    dates: none,
  });
  assert.deepEqual(empty.series, { "20:3": [], "165:5": [] });
  assert.deepEqual(
    (await mapData(document, undefined, false, none)).tracks,
    [],
  );
});
