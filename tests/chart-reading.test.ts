import assert from "node:assert/strict";
import test from "node:test";
import { NumericReader } from "../src/document/numeric-reader";
import { PointSampler } from "../src/document/point-sampler";
import { FitDocument } from "../src/document/document";
import { chart, chartPoints, sensors } from "../src/document/series";
import { idleJob } from "../src/protocol/reader";
import { activity, file, type Field } from "./fixtures";

test("compiled numeric reads match full cells across layouts, arrays, invalids, large integers and derived fields", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "native.fit", bytes: activity(20) },
      {
        filename: "arrays.fit",
        bytes: file(
          [
            {
              message: 20,
              little: false,
              fields: [
                [253, 6, 100],
                [3, 2, 255],
                [6, 4, 1234],
              ],
            },
            {
              message: 600,
              fields: [
                [1, 4, [1, 65535, 0]],
                [2, 8, [0, NaN, 1.5]],
                [3, 15, 18446744073709551614n],
              ],
            },
            {
              message: 164,
              fields: [
                [253, 6, 100],
                [5, 8, [1]],
              ],
            },
          ],
          false,
        ),
      },
    ],
    "readers",
  );
  for (const developer of [false, true]) {
    for (const message of document.messageInfo) {
      const keys = document
        .getFields(message.id, true)
        .map((field) => field.key);
      const reader = new NumericReader(document, keys, developer);
      for (const id of document.recordIds(message.id)) {
        const cells = document.cells(id, !developer);
        assert.deepEqual(
          reader.read(id),
          keys.map((key) => cells[key]),
        );
      }
    }
  }
});

test("streaming chart sampling is bounded and retains endpoints, extrema and gaps", () => {
  for (const capacity of [8, 40, 128, 1024]) {
    const points = Array.from({ length: 10001 }, (_, time) => ({
      time,
      value:
        time % 13 === 0
          ? null
          : time === 777
            ? 99999
            : time === 888
              ? -99999
              : time % 101,
    }));
    const sampler = new PointSampler(capacity);
    points.forEach((point) => sampler.add(point));
    const result = sampler.finish();
    assert.ok(result.length <= capacity, `${result.length} > ${capacity}`);
    assert.deepEqual(result[0], points[0]);
    assert.deepEqual(result.at(-1), points.at(-1));
    assert.ok(result.some((point) => point.value === 99999));
    assert.ok(result.some((point) => point.value === -99999));
    for (let i = 1; i < result.length; i++) {
      if (result[i - 1].value === null || result[i].value === null) continue;
      assert.ok(
        !points
          .slice(result[i - 1].time + 1, result[i].time)
          .some((point) => point.value === null),
      );
    }
  }
  const small = new PointSampler(40);
  const points = Array.from({ length: 40 }, (_, time) => ({
    time,
    value: time,
  }));
  points.forEach((point) => small.add(point));
  assert.deepEqual(small.finish(), points);
});

test("zoomed charts avoid decoding offscreen records and retain out-of-order timestamps", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 10000 }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, i === 8000 ? 100 : i],
          [3, 2, 100 + (i % 50)],
        ] as Field[],
      })),
      false,
    ),
    "time-index.fit",
  );
  await chart(document, { sensors: [], developer: false, width: 100 });
  const read = NumericReader.prototype.read;
  let decoded = 0;
  NumericReader.prototype.read = function (id) {
    decoded++;
    return read.call(this, id);
  };
  try {
    const result = await chart(document, {
      sensors: ["20:3"],
      developer: false,
      width: 100,
      start: 100,
      end: 110,
    });
    assert.equal(decoded, 12);
    const expected = document
      .recordIds(20)
      .filter((id) => {
        const time = document.index.records[id].timestamp!;
        return time >= 100 && time <= 110;
      })
      .map((id) => ({
        time: document.index.records[id].timestamp!,
        value: document.cells(id)["3"].value,
      }));
    assert.deepEqual(
      result.series["20:3"].filter((point) => point.value !== null),
      expected,
    );
    const sensor = sensors(document, false).find((s) => s.key === "20:3")!;
    let exported = 0;
    for await (const point of chartPoints(document, sensor, false, idleJob()))
      if (point.value !== null) exported++;
    assert.equal(exported, 10000);
  } finally {
    NumericReader.prototype.read = read;
  }
});
