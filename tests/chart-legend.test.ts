import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChartPeriodLegend,
  ChartTraceLegend,
  chartLegend,
  type LegendTrace,
} from "../src/ui/ChartLegend";
import { dayPeriodRange, dividerDate } from "../src/ui/chart-time";
import { FIT_EPOCH } from "../src/protocol/time";

function motionTraces(count = 9): LegendTrace[] {
  return ["X", "Y", "Z"].flatMap((axis, index) =>
    Array.from({ length: count }, (_, source) => ({
      sensor: {
        key: `165:${index + 5}:file:${source}`,
        message: 165,
        field: String(index + 5),
        source,
        sourceName: `activity-${source}.fit`,
        label: `Accelerometer Data: Calibrated Accel ${axis}`,
        name: `Accelerometer Data: Calibrated Accel ${axis} - activity-${source}.fit`,
        units: "g",
        axis: "time" as const,
      },
      color: ["red", "green", "blue"][index],
    })),
  );
}

test("27 motion traces show three axis keys and one file-list control, without repeated filenames", () => {
  const traces = motionTraces();
  const legend = chartLegend(traces);
  assert.deepEqual(legend.entries, [
    { name: "X", color: "red" },
    { name: "Y", color: "green" },
    { name: "Z", color: "blue" },
  ]);
  assert.equal(legend.files.length, 9);
  for (const [id, file] of legend.files.entries()) {
    assert.equal(file.id, id);
    assert.equal(file.name, `activity-${id}.fit`);
    assert.deepEqual(file.traces, legend.entries);
  }
  const markup = renderToStaticMarkup(
    createElement(ChartTraceLegend, { traces }),
  );
  assert.match(markup, /Show 9 source files/);
  assert.match(markup, /aria-expanded="false"/);
  assert.doesNotMatch(markup, /activity-\d|Accelerometer Data/);
});

test("single-file XYZ legends remain compact and do not need a file popover", () => {
  const traces = motionTraces(1).map((trace) => ({
    ...trace,
    sensor: { ...trace.sensor, source: undefined, sourceName: undefined },
  }));
  const markup = renderToStaticMarkup(
    createElement(ChartTraceLegend, { traces }),
  );
  assert.doesNotMatch(markup, /source files|files-button|Accelerometer Data/);
  for (const axis of ["X", "Y", "Z"])
    assert.match(markup, new RegExp(`>${axis}</span>`));
  assert.equal(
    renderToStaticMarkup(
      createElement(ChartTraceLegend, { traces: traces.slice(0, 1) }),
    ),
    "",
  );
});

test("file identity and individual colors survive duplicate filenames and non-motion traces", () => {
  const traces = motionTraces(2)
    .slice(0, 2)
    .map((trace, index) => ({
      ...trace,
      color: ["orange", "purple"][index],
      sensor: {
        ...trace.sensor,
        message: 20,
        field: "3",
        label: "Heart Rate",
        sourceName: "same.fit",
      },
    }));
  const legend = chartLegend(traces);
  assert.equal(legend.entries.length, 0);
  assert.deepEqual(
    legend.files.map((file) => [file.id, file.name, file.traces[0].color]),
    [
      [0, "same.fit", "orange"],
      [1, "same.fit", "purple"],
    ],
  );
  assert.equal(
    chartLegend([
      { ...traces[0], sensor: { ...traces[0].sensor, sourceName: undefined } },
    ]).files[0].name,
    "File 1",
  );
});

test("day-period legends provide linked keyboard-accessible tooltips with unambiguous local hours", () => {
  const markup = renderToStaticMarkup(createElement(ChartPeriodLegend));
  assert.equal((markup.match(/role="tooltip"/g) ?? []).length, 4);
  assert.equal((markup.match(/aria-describedby=/g) ?? []).length, 4);
  for (const [name, range] of [
    ["Morning", "06:00 - 12:00"],
    ["Afternoon", "12:00 - 18:00"],
    ["Evening", "18:00 - 22:00"],
    ["Night", "22:00 - 06:00 (next day)"],
  ]) {
    assert.equal(dayPeriodRange(name), range);
    assert.ok(markup.includes(range));
  }
  assert.equal(dayPeriodRange("unknown"), "");
  assert.equal((markup.match(/Local time<\/span>/g) ?? []).length, 4);
});

test("divider date text identifies the new local day and includes the year when needed", () => {
  const time = (new Date(2026, 9, 6).getTime() - FIT_EPOCH) / 1000;
  assert.equal(dividerDate(time, false, "en-US"), "Oct 6");
  assert.equal(dividerDate(time, true, "en-US"), "Oct 6, 2026");
});
