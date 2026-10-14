import assert from "node:assert/strict";
import test from "node:test";
import { FIT_EPOCH, formatTimestamp } from "../src/protocol/time";
import { pointDetails, routeDetails } from "../src/ui/map-details";
import {
  chartDate,
  chartTick,
  chartTimeDomain,
  chartTimeTicks,
  chartTimeline,
  chartTimeLabel,
} from "../src/ui/chart-time";

const fit = (iso: string) => (new Date(iso).getTime() - FIT_EPOCH) / 1000;
const points = (start: string, end: string) => [
  { time: fit(start), value: 1 },
  { time: fit(end), value: 2 },
];
function inZone(zone: string, run: () => void) {
  const old = process.env.TZ;
  process.env.TZ = zone;
  try {
    run();
  } finally {
    if (old === undefined) delete process.env.TZ;
    else process.env.TZ = old;
  }
}

test("times use 00-23 hours without AM/PM even in 12-hour locales", () =>
  inZone("UTC", () => {
    for (const [time, expected] of [
      ["00:00:00", "00:00:00"],
      ["12:15:00", "12:15:00"],
      ["21:53:06", "21:53:06"],
    ]) {
      const timestamp = fit(`2026-10-05T${time}Z`);
      const timeline = chartTimeline([{ time: timestamp, value: 1 }], "time");
      assert.equal(chartTick(timestamp, timeline, "en-US").time, expected);
      assert.ok(formatTimestamp(timestamp, "en-US").includes(expected));
      assert.ok(chartTimeLabel(timestamp, "en-US").includes(expected));
      const point = { lat: 0, lon: 0, time: timestamp, record: 0 };
      assert.ok(
        pointDetails({ ...point, kind: "start" }, "Start").includes(expected),
      );
      assert.ok(routeDetails([point], "Route 1").includes(expected));
      assert.doesNotMatch(formatTimestamp(timestamp, "en-US"), /\b(?:AM|PM)\b/);
    }
  }));

test("multi-day charts split at local midnight and show dates on axis labels", () =>
  inZone("America/Toronto", () => {
    const data = points(
      "2026-10-05T09:00:00-04:00",
      "2026-10-07T13:00:00-04:00",
    );
    const timeline = chartTimeline(data, "time");
    assert.equal(timeline.multipleDates, true);
    assert.deepEqual(timeline.midnights, [
      fit("2026-10-06T00:00:00-04:00"),
      fit("2026-10-07T00:00:00-04:00"),
    ]);
    assert.equal(
      chartTick(timeline.midnights[0], timeline, "en-US").date,
      "Oct 6",
    );
    assert.match(
      chartTimeLabel(fit("2026-10-06T14:00:00-04:00")),
      /Afternoon$/,
    );
    assert.equal(timeline.periods[0].start, data[0].time);
    assert.equal(timeline.periods.at(-1)?.end, data[1].time);
    for (let i = 1; i < timeline.periods.length; i++)
      assert.equal(timeline.periods[i - 1].end, timeline.periods[i].start);
  }));

test("single-day and sample axes do not gain date labels or midnight lines", () =>
  inZone("UTC", () => {
    const data = points("2026-10-06T08:00:00Z", "2026-10-06T23:00:00Z");
    const timeline = chartTimeline(data, "time");
    assert.equal(timeline.multipleDates, false);
    assert.equal(chartTick(data[0].time, timeline).date, undefined);
    assert.deepEqual(timeline.midnights, []);
    assert.deepEqual(
      timeline.periods.map((p) => p.name),
      ["Morning", "Afternoon", "Evening", "Night"],
    );
    assert.deepEqual(chartTimeline(data, "sample"), {
      multipleDates: false,
      multipleYears: false,
      midnights: [],
      periods: [],
    });
  }));

test("date changes use the viewer's local calendar, including large UTC offsets", () =>
  inZone("Pacific/Kiritimati", () => {
    const timeline = chartTimeline(
      points("2026-10-05T09:00:00Z", "2026-10-05T11:00:00Z"),
      "time",
    );
    assert.equal(timeline.multipleDates, true);
    assert.deepEqual(timeline.midnights, [fit("2026-10-05T10:00:00Z")]);
    assert.equal(chartDate(timeline.midnights[0]).getDate(), 6);
  }));

test("DST days preserve 23- and 25-hour midnight spacing and continuous period boundaries", () =>
  inZone("America/Toronto", () => {
    for (const [start, end, hours] of [
      ["2026-03-07T23:00:00-05:00", "2026-03-09T01:00:00-04:00", 23],
      ["2026-10-31T23:00:00-04:00", "2026-11-02T01:00:00-05:00", 25],
    ] as const) {
      const data = points(start, end);
      const timeline = chartTimeline(data, "time");
      assert.equal(timeline.midnights.length, 2);
      assert.equal(timeline.midnights[1] - timeline.midnights[0], hours * 3600);
      assert.equal(
        timeline.periods.reduce((sum, p) => sum + p.end - p.start, 0),
        data[1].time - data[0].time,
      );
      for (const midnight of timeline.midnights)
        assert.equal(chartDate(midnight).getHours(), 0);
    }
  }));

test("year changes are labeled explicitly and boundary lines do not duplicate plot edges", () =>
  inZone("UTC", () => {
    const data = points("2026-12-31T00:00:00Z", "2027-01-02T00:00:00Z");
    const timeline = chartTimeline(data, "time");
    assert.deepEqual(timeline.midnights, [fit("2027-01-01T00:00:00Z")]);
    assert.match(chartTick(data[0].time, timeline, "en-US").date!, /2026/);
    assert.match(chartTick(data[1].time, timeline, "en-US").date!, /2027/);
  }));

test("timeline annotations are bounded, handle empty and invalid input, and preserve zero timestamps", () =>
  inZone("UTC", () => {
    for (const data of [
      [],
      [{ time: NaN, value: 1 }],
      [{ time: Number.MAX_VALUE, value: 1 }],
    ]) {
      const timeline = chartTimeline(data, "time");
      assert.deepEqual(timeline.periods, []);
      assert.deepEqual(timeline.midnights, []);
    }
    const zero = chartTimeline(
      [
        { time: 0, value: 1 },
        { time: 86401, value: 2 },
      ],
      "time",
    );
    assert.deepEqual(zero.midnights, [86400]);
    const long = chartTimeline(
      points("2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z"),
      "time",
    );
    assert.ok(long.midnights.length <= 64);
    assert.deepEqual(long.periods, []);
  }));

test("shared time domains span all timed plots without including sample indexes", () => {
  const plots = [
    {
      sensor: { axis: "time" as const },
      points: [
        { time: 0, value: 2 },
        { time: 20, value: 3 },
      ],
    },
    {
      sensor: {},
      points: [
        { time: 10, value: 2 },
        { time: 40, value: 3 },
        { time: NaN, value: 4 },
      ],
    },
    {
      sensor: { axis: "sample" as const },
      points: [
        { time: -100, value: 2 },
        { time: 1000000, value: 3 },
      ],
    },
  ];
  assert.deepEqual(chartTimeDomain(plots), [0, 40]);
  assert.deepEqual(chartTimeDomain(plots, { start: 0, end: 30 }), [0, 30]);
  assert.equal(chartTimeDomain(plots.slice(2)), undefined);
  assert.equal(chartTimeDomain([]), undefined);
  assert.equal(
    chartTimeDomain([{ sensor: {}, points: [{ time: Infinity, value: 1 }] }]),
    undefined,
  );
  assert.deepEqual(
    chartTimeDomain([{ sensor: {}, points: [{ time: 0, value: 1 }] }]),
    [-0.5, 0.5],
  );
  assert.equal(chartTimeDomain(plots, { start: 30, end: 20 }), undefined);
});

test("shared axes have identical bounded ticks and calendar annotations despite different sensor coverage", () =>
  inZone("America/Toronto", () => {
    const first = points(
      "2026-10-05T20:00:00-04:00",
      "2026-10-05T22:00:00-04:00",
    );
    const second = points(
      "2026-10-06T02:00:00-04:00",
      "2026-10-06T09:00:00-04:00",
    );
    const domain = chartTimeDomain([
      { sensor: { axis: "time" }, points: first },
      { sensor: { axis: "time" }, points: second },
    ])!;
    const timeline = chartTimeline(first, "time", domain);
    assert.deepEqual(timeline, chartTimeline(second, "time", domain));
    assert.deepEqual(timeline.midnights, [fit("2026-10-06T00:00:00-04:00")]);
    assert.equal(timeline.multipleDates, true);
    assert.equal(timeline.periods[0].start, domain[0]);
    assert.equal(timeline.periods.at(-1)?.end, domain[1]);
    for (const width of [240, 640, 1366, 1920]) {
      const ticks = chartTimeTicks(domain, width);
      assert.ok(ticks.length >= 2 && ticks.length <= 6);
      assert.equal(ticks[0], domain[0]);
      assert.equal(ticks.at(-1), domain[1]);
      for (let index = 1; index < ticks.length; index++)
        assert.ok(ticks[index] > ticks[index - 1]);
    }
    assert.deepEqual(
      chartTimeline(first, "sample", domain),
      chartTimeline(first, "sample"),
    );
  }));
