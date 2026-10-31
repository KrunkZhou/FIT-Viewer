import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitDocument } from "../src/document/document";
import { DocumentClient } from "../src/document/client";
import { chart, mapData, sensors } from "../src/document/series";
import { prepareChartDisplay } from "../src/document/chart-display";
import { idleJob } from "../src/protocol/reader";
import {
  chartPointAt,
  chartPointTarget,
  ChartReadout,
} from "../src/ui/ChartPointDetails";
import { chartTooltipPosition } from "../src/ui/chart-tooltip-layout";
import { GoToDataButton } from "../src/ui/controls";
import { Messages } from "../src/ui/Messages";
import type { RecordTarget, Sensor } from "../src/model";
import { activity, file, type Field } from "./fixtures";

test("sampled chart points retain exact rows across files with overlapping times", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "one.fit", bytes: activity(1000) },
      { filename: "two.fit", bytes: activity(1000) },
    ],
    "overlap",
  );
  const keys = sensors(document, false)
    .filter((s) => s.message === 20 && s.field === "3")
    .map((s) => s.key);
  const display = await prepareChartDisplay(
    await chart(document, { sensors: keys, developer: false, width: 32 }),
    idleJob(),
  );
  for (const line of display.display![0].lines) {
    for (const point of line.points) {
      const target = chartPointTarget(line.sensor, point)!;
      assert.ok(target);
      const record = document.index.records[target.record];
      assert.equal(record.definition.message, target.message);
      assert.equal(record.timestamp, point.time);
      assert.equal(document.cells(target.record)["3"].value, point.value);
      assert.equal(document.sourceName(record.subfile), point.sourceName);
      const page = await document.table({
        ...target,
        target: target.record,
        developer: false,
        size: 20,
        page: 0,
      });
      assert.equal(page.selected, target.record);
      assert.ok(page.rows.some((row) => row.index === target.record));
    }
  }
});

test("sample-index arrays and XYZ extrema link to their containing source record", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 40 }, (_, i) => ({
        message: 165,
        fields: [
          [253, 6, 1100000000 + i],
          [0, 4, 0],
          [1, 4, [0, 10, 20]],
          [5, 8, [i, -i, i + 0.5]],
          [6, 8, [i * 2, -i, i + 1]],
          [7, 8, [i * 3, -i, i + 2]],
        ] as Field[],
      })),
      false,
    ),
    "motion.fit",
  );
  const result = await chart(document, {
    sensors: ["165:5", "165:6", "165:7"],
    width: 20,
    developer: false,
  });
  for (const [key, points] of Object.entries(result.series))
    for (const point of points) {
      if (point.value === null) continue;
      const target = chartPointTarget(
        result.sensors.find((s) => s.key === key)!,
        point,
      )!;
      assert.equal(target.message, 165);
      assert.equal(target.record, Math.floor(point.time - 1100000000));
      assert.ok(
        (
          document.cells(target.record)[key.split(":")[1]].value as number[]
        ).includes(point.value),
      );
    }
  const arrays = await FitDocument.open(
    file(
      Array.from({ length: 40 }, (_, i) => ({
        message: 600,
        fields: [[1, 4, [i, i + 1, i + 2]]] as Field[],
      })),
      false,
    ),
    "arrays.fit",
  );
  const data = await chart(arrays, {
    sensors: ["600:1"],
    width: 16,
    developer: true,
  });
  assert.ok(data.series["600:1"].length);
  for (const point of data.series["600:1"])
    if (point.value !== null)
      assert.equal(point.record, Math.floor(point.time / 3));
});

test("map markers identify their own message instead of always opening Record", async () => {
  const start = 1100000000;
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, start],
            [0, 5, 500000000],
            [1, 5, -900000000],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, start + 10],
            [0, 5, 500000100],
            [1, 5, -900000100],
          ],
        },
        {
          message: 19,
          fields: [
            [253, 6, start + 10],
            [2, 6, start],
            [3, 5, 500000000],
            [4, 5, -900000000],
          ],
        },
        {
          message: 32,
          fields: [
            [1, 6, start + 5],
            [2, 5, 500000050],
            [3, 5, -900000050],
            [6, 7, "Turn"],
          ],
        },
      ],
      false,
    ),
    "markers.fit",
  );
  const map = await mapData(document);
  assert.ok(map.points.some((p) => p.message === 19));
  assert.ok(map.points.some((p) => p.message === 32));
  for (const point of map.points)
    assert.equal(
      point.message ?? 20,
      document.index.records[point.record].definition.message,
    );
});

test("point actions preserve record zero and reject gaps or unavailable source links", () => {
  const sensor: Sensor = { key: "20:3", name: "Heart rate", units: "bpm" };
  const target = { message: 20, record: 0 };
  assert.deepEqual(
    chartPointTarget(sensor, { time: 0, value: 0, record: 0 }),
    target,
  );
  for (const record of [undefined, -1, NaN, 1.5])
    assert.equal(
      chartPointTarget(sensor, { time: 0, value: 120, record }),
      undefined,
    );
  assert.equal(
    chartPointTarget(sensor, { time: 0, value: null, record: 0 }),
    undefined,
  );
  let selected: RecordTarget | undefined;
  const button = GoToDataButton({
    target,
    onGoToData: (next) => {
      selected = next;
    },
    role: "menuitem",
  });
  button.props.onClick();
  assert.deepEqual(selected, target);
  assert.match(renderToStaticMarkup(button), /role="menuitem"/);
});

test("right-click picks the closest XYZ point and ignores empty chart space", () => {
  const container = {
    querySelectorAll: () =>
      [50, 100, 150].map((y, i) => ({
        dataset: { message: "165", record: String(i) },
        getBoundingClientRect: () => ({
          left: 96,
          top: y - 4,
          width: 8,
          height: 8,
        }),
      })),
  } as unknown as HTMLElement;
  assert.deepEqual(chartPointAt(container, 100, 101)?.target, {
    message: 165,
    record: 1,
  });
  assert.equal(chartPointAt(container, 200, 101), undefined);
  assert.equal(chartPointAt(container)?.target.record, 0);
});

test("floating chart readout retains source labels, sample zero, and skips missing values", () => {
  const markup = renderToStaticMarkup(
    createElement(ChartReadout, {
      active: true,
      axis: "sample",
      label: 0,
      payload: [
        {
          name: "X",
          value: 0,
          color: "#176856",
          payload: { sourceName: "first.fit" },
        },
        { name: "Y", value: 12, payload: { sourceName: "second.fit" } },
        { name: "Missing", value: undefined },
      ],
    }),
  );
  assert.match(markup, /Sample 0/);
  assert.match(markup, /first.fit/);
  assert.match(markup, /second.fit/);
  assert.ok(!markup.includes("Missing"));
  assert.match(markup, /role="tooltip"/);
});

test("chart tooltip floats within bounds without covering the hovered point", () => {
  for (const width of [366, 1000]) {
    for (const x of [60, width / 2, width - 20]) {
      for (const y of [20, 130, 240]) {
        const size = { width: 250, height: 64 };
        const position = chartTooltipPosition(
          { width, height: 260 },
          size,
          { x, y },
          [{ x, y }],
        );
        assert.ok(position.x >= 8 && position.x + size.width <= width - 8);
        assert.ok(position.y >= 8 && position.y + size.height <= 252);
        assert.ok(
          x < position.x ||
            x > position.x + size.width ||
            y < position.y ||
            y > position.y + size.height,
        );
        if (width === 1000)
          assert.ok(x < position.x || x > position.x + size.width);
      }
    }
  }
});

test("single-entry messages are expanded on first render", async () => {
  const document = await FitDocument.open(activity(20), "activity.fit");
  const markup = renderToStaticMarkup(
    createElement(Messages, {
      client: new DocumentClient(),
      summary: document.summary(),
      developer: false,
      active: true,
      download() {},
    }),
  );
  assert.match(
    markup,
    /aria-label="Collapse single-entry messages"[^>]*aria-expanded="true"/,
  );
  assert.ok(!markup.includes('id="single-entry-navigation-items" hidden'));
});
