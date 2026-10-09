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
  const json = JSON.parse(
    await (
      await exportDocument(document, { format: "json", sensors: keys })
    ).blob.text(),
  );
  for (const key of keys) assert.equal(json.series[key].length, count * 25);
  assert.deepEqual(Object.keys(json.series), keys);
});

test("charts expose a named, default-on XYZ toggle without changing sensor selection", () => {
  const markup = renderToStaticMarkup(
    createElement(Charts, {
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
