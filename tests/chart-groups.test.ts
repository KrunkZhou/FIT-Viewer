import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentClient } from "../src/document/client";
import { FitDocument } from "../src/document/document";
import { chart } from "../src/document/series";
import { exportDocument } from "../src/export/export";
import type { Sensor } from "../src/model";
import Charts from "../src/ui/Charts";
import {
  chartMemberKeys,
  chartLines,
  groupMotionAxes,
  groupSensors,
  motionAxis,
} from "../src/ui/chart-groups";
import { file, type Field } from "./fixtures";

function axes(message = 165, first = 5, source?: number): Sensor[] {
  const family = message === 165 ? "Accelerometer Data" : "Gyroscope Data";
  const field = `${first === 5 ? "Calibrated " : first === 8 ? "Compressed Calibrated " : ""}${message === 165 ? "Accel" : "Gyro"}`;
  return ["X", "Y", "Z"].map((axis, offset) => ({
    key: `${message}:${first + offset}${source === undefined ? "" : `:file:${source}`}`,
    message,
    field: String(first + offset),
    source,
    label: `${family}: ${field} ${axis}`,
    name: `${family}: ${field} ${axis}${source === undefined ? "" : ` - file${source}.fit`}`,
    units:
      first === 2
        ? "counts"
        : first === 8
          ? "mG"
          : message === 165
            ? "g"
            : "deg/s",
    axis: "time",
    pointCount: 100 + offset,
  }));
}

test("motion XYZ overlays preserve separate accelerometer and gyroscope plots", () => {
  const sensors = [...axes(), ...axes(164)];
  const groups = groupSensors(sensors);
  assert.equal(groups.length, 6);
  const plots = groupMotionAxes(groups, true);
  assert.equal(plots.length, 2);
  assert.deepEqual(
    plots.map((plot) => plot.sensor.name),
    [
      "Accelerometer Data: Calibrated Accel XYZ",
      "Gyroscope Data: Calibrated Gyro XYZ",
    ],
  );
  assert.deepEqual(
    plots.map((plot) => plot.members.length),
    [3, 3],
  );
  assert.equal(plots[0].sensor.pointCount, 303);
  assert.deepEqual(
    plots.flatMap((plot) => plot.members),
    sensors,
  );
  assert.equal(groupMotionAxes(groups, false), groups);
});

test("raw, calibrated, compressed, incompatible and unrelated sensors never share a motion plot", () => {
  const unrelated: Sensor = {
    key: "20:3",
    name: "Heart Rate",
    units: "bpm",
    axis: "time",
  };
  const variants = [
    ...axes(165, 2),
    ...axes(165, 5),
    ...axes(165, 8),
    ...axes(164, 2),
    ...axes(164, 5),
    { ...axes()[0], key: "165:5:file:20", source: 20, units: "other" },
    { ...axes()[1], key: "165:6:file:21", source: 21, axis: "sample" as const },
    { ...axes()[2], key: "165:d0:7", field: "d0:7" },
    {
      ...axes()[0],
      key: "165:5:file:22",
      source: 22,
      label: "Another X",
      name: "Another X",
    },
    unrelated,
  ];
  const plots = groupMotionAxes(groupSensors(variants), true);
  assert.deepEqual(
    plots.map((plot) => plot.members.length),
    [3, 3, 3, 3, 3, 1, 1, 1, 1, 1],
  );
  assert.equal(
    new Set(plots.map((plot) => plot.sensor.key)).size,
    plots.length,
  );
  assert.equal(motionAxis(unrelated), undefined);
  assert.equal(motionAxis({ ...axes()[0], field: "d0:5" }), undefined);
  assert.equal(
    motionAxis({ key: "164:8", name: "Unknown", units: "" }),
    undefined,
  );
  assert.equal(motionAxis({ key: "165:10", name: "Z", units: "" }), "Z");
});

test("axis selection and per-file identities survive combining and separating charts", () => {
  const groups = groupSensors([...axes(165, 5, 0), ...axes(165, 5, 1)]);
  const selected = ["165:5", "165:7"];
  const chosen = groups.filter((group) => selected.includes(group.sensor.key));
  const before = chartMemberKeys(groups, selected);
  const plots = groupMotionAxes(chosen, true);
  assert.equal(plots.length, 1);
  assert.deepEqual(
    plots[0].members.map((member) => member.key),
    before,
  );
  assert.deepEqual(
    plots[0].members.map((member) => member.source),
    [0, 1, 0, 1],
  );
  assert.deepEqual(groupMotionAxes(chosen, false), chosen);
  assert.deepEqual(groupMotionAxes([groups[0]], true), [groups[0]]);
  assert.deepEqual(chartMemberKeys(groups, selected), before);
});

test("chart lines connect matching readings across file and time gaps in chronological order", () => {
  const [x1, y1] = axes(165, 5, 0);
  const [x2, y2] = axes(165, 5, 1);
  const inputs = [
    {
      sensor: { ...x1, sourceName: "late.fit" },
      color: "red",
      points: [
        { time: 30, value: 3 },
        { time: 20, value: null },
        { time: 10, value: 1 },
      ],
    },
    {
      sensor: { ...x2, sourceName: "early.fit" },
      color: "red",
      points: [
        { time: 5, value: 0 },
        { time: 25, value: 2 },
      ],
    },
    { sensor: y1, color: "green", points: [{ time: 10, value: 100 }] },
    { sensor: y2, color: "green", points: [{ time: 30, value: 200 }] },
  ];
  const original = structuredClone(inputs);
  const lines = chartLines(inputs);
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines[0].points.map((point) => [point.time, point.value, point.sourceName]),
    [
      [5, 0, "early.fit"],
      [10, 1, "late.fit"],
      [25, 2, "early.fit"],
      [30, 3, "late.fit"],
    ],
  );
  assert.deepEqual(
    lines[1].points.map((point) => point.value),
    [100, 200],
  );
  assert.deepEqual(inputs, original);
  assert.equal(
    chartLines([{ ...inputs[0], points: [{ time: 1, value: null }] }])[0].points
      .length,
    0,
  );
});

test("XYZ worker queries retain peaks and gaps under a shared display budget; exports stay full resolution", async () => {
  const count = 100;
  const original = file(
    Array.from({ length: count }, (_, i) => ({
      message: 165,
      fields: [
        [253, 6, 100 + i],
        [0, 4, 0],
        [1, 4, Array.from({ length: 25 }, (_, j) => j * 10)],
        ...[5, 6, 7].map(
          (field) =>
            [
              field,
              8,
              Array.from({ length: 25 }, (_, j) => {
                if (i === 50 && j === 10) return NaN;
                if (i === 75 && j === 20) return field * 1000;
                return Math.sin(i + j) * field;
              }),
            ] as Field,
        ),
      ] as Field[],
    })),
    false,
  );
  const document = await FitDocument.open(original, "xyz.fit");
  const inventory = await chart(document, {
    sensors: [],
    width: 240,
    developer: false,
  });
  const groups = groupSensors(inventory.sensors);
  const keys = chartMemberKeys(
    groups,
    groups.map((group) => group.sensor.key),
  );
  const plot = groupMotionAxes(groups, true)[0];
  assert.equal(plot.members.length, 3);
  const data = await chart(document, {
    sensors: keys,
    width: 240 / plot.members.length,
    developer: false,
  });
  assert.ok(
    Object.values(data.series).reduce(
      (sum, points) => sum + points.length,
      0,
    ) <= 480,
  );
  for (const field of [5, 6, 7]) {
    assert.ok(
      data.series[`165:${field}`].some((point) => point.value === field * 1000),
    );
    assert.ok(
      data.series[`165:${field}`].some((point) => point.value === null),
    );
  }
  assert.deepEqual(
    data.series["165:5"].map((point) => point.time),
    data.series["165:6"].map((point) => point.time),
  );
  assert.deepEqual(
    data.series["165:5"].map((point) => point.time),
    data.series["165:7"].map((point) => point.time),
  );
  const json = JSON.parse(
    await (
      await exportDocument(document, { format: "json", sensors: keys })
    ).blob.text(),
  );
  for (const key of keys) assert.equal(json.series[key].length, count * 25);
  for (const key of keys) {
    const original = new Map<number, number>(
      json.series[key].map((point: { time: number; value: number }) => [
        point.time,
        point.value,
      ]),
    );
    for (const point of data.series[key])
      if (point.value !== null)
        assert.equal(point.value, original.get(point.time));
  }
  assert.deepEqual(Object.keys(json.series), keys);
});

test("XYZ downsampling retains distinct axis peaks with exact companion values and genuine missing slots", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 200 }, (_, packet) => ({
        message: 165,
        fields: [
          [253, 6, 100 + packet],
          [0, 4, 0],
          [1, 4, Array.from({ length: 10 }, (_, sample) => sample * 10)],
          ...[5, 6, 7].map(
            (field) =>
              [
                field,
                8,
                Array.from({ length: 10 }, (_, sample) => {
                  const index = packet * 10 + sample;
                  if (field === 5 && index === 77) return 10000;
                  if (field === 6 && index === 525) return -20000;
                  if (field === 7 && index === 1210) return 30000;
                  if (field === 5 && index === 1065) return -40000;
                  if (field === 6 && index === 1065) return NaN;
                  return index % (field + 10);
                }),
              ] as Field,
          ),
        ] as Field[],
      })),
      false,
    ),
    "distinct-peaks.fit",
  );
  const keys = ["165:5", "165:6", "165:7"];
  const query = { sensors: keys, width: 80, developer: false };
  const data = await chart(document, query);
  const full = await chart(document, query, undefined, true);
  const times = data.series[keys[0]].map((point) => point.time);
  for (const key of keys) {
    assert.deepEqual(
      data.series[key].map((point) => point.time),
      times,
    );
    assert.ok(data.series[key].length <= 160);
    const actual = new Map(
      full.series[key]
        .filter((point) => point.value !== null)
        .map((point) => [point.time, point.value]),
    );
    for (const point of data.series[key])
      if (point.value !== null)
        assert.equal(point.value, actual.get(point.time));
  }
  assert.ok(data.series[keys[0]].some((point) => point.value === 10000));
  assert.ok(data.series[keys[1]].some((point) => point.value === -20000));
  assert.ok(data.series[keys[2]].some((point) => point.value === 30000));
  const missing = data.series[keys[0]].findIndex(
    (point) => point.value === -40000,
  );
  assert.ok(missing >= 0);
  assert.equal(data.series[keys[1]][missing].value, null);
  assert.equal(data.series[keys[2]][missing].value, 1065 % 17);
});

test("charts expose a named, default-on XYZ toggle without changing sensor selection", () => {
  const markup = renderToStaticMarkup(
    createElement(Charts, {
      dates: {},
      onDatesChange() {},
      client: new DocumentClient(),
      developer: false,
      active: true,
      download() {},
    }),
  );
  assert.match(
    markup,
    /role="switch" aria-checked="true"[^>]*aria-label="Combine XYZ"/,
  );
  assert.match(markup, /Find sensors/);
});
