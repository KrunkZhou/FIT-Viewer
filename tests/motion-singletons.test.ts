import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { chart, chartPoints, sensors } from "../src/document/series";
import { createJob } from "../src/document/jobs";
import { idleJob } from "../src/protocol/reader";
import { exportDocument } from "../src/export/export";
import { file, join, type Field } from "./fixtures";

function motion(count = 1000) {
  return file(
    Array.from({ length: count }, (_, i) => ({
      message: i % 2 ? 164 : 165,
      fields: [
        [253, 6, 100 + Math.floor(i / 4)],
        [0, 4, (i % 4) * 250],
        [1, 4, Array.from({ length: 25 }, (_, j) => j * 10)],
        [
          5,
          8,
          Array.from({ length: 25 }, (_, j) =>
            i === 502 && j === 13 ? 9999 : Math.sin(i + j),
          ),
        ],
        [6, 8, Array.from({ length: 25 }, (_, j) => (j % 13 === 0 ? NaN : -j))],
      ] as Field[],
      little: i % 3 !== 0,
    })),
    false,
  );
}
test("combined view returns only single-entry messages with mode-correct field visibility", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 0,
          fields: [
            [0, 0, 2],
            [200, 2, 42],
          ],
        },
        { message: 12, fields: [[0, 0, 1]] },
        { message: 64000, fields: [[7, 6, 42]] },
        { message: 20, fields: [[253, 6, 0]] },
        { message: 20, fields: [[253, 6, 1]] },
      ],
      false,
    ),
    "single.fit",
  );
  const user = await document.singletons(false);
  assert.deepEqual(
    user.entries.map((e) => e.message.id),
    [0, 12],
  );
  assert.ok(!user.entries[0].fields.some((f) => f.id === 200));
  const raw = await document.singletons(true);
  assert.deepEqual(
    raw.entries.map((e) => e.message.id),
    [0, 12],
  );
  assert.equal(raw.entries[0].row.cells["200"].raw, 42);
  const unknown = await document.table({
    message: 64000,
    developer: true,
    page: 0,
    size: 20,
  });
  assert.equal(unknown.rows[0].cells["7"].raw, 42);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    document.singletons(true, createJob(controller.signal)),
    { name: "AbortError" },
  );
});
test("motion samples use fractional packet time and aligned offsets across seconds", async () => {
  const original = file(
    [
      {
        message: 165,
        fields: [
          [253, 6, 0],
          [0, 4, 900],
          [1, 4, [0, 100, 250]],
          [5, 8, [1, 2, 3]],
        ],
        little: false,
      },
    ],
    false,
  );
  const before = original.slice();
  const document = await FitDocument.open(original, "motion.fit");
  const available = sensors(document, false);
  assert.ok(!available.some((s) => ["165:0", "165:1"].includes(s.key)));
  const points = [];
  for await (const point of chartPoints(
    document,
    available[0],
    false,
    idleJob(),
  ))
    points.push(point);
  assert.deepEqual(points, [
    { time: 0.9, value: 1 },
    { time: 1, value: 2 },
    { time: 1.15, value: 3 },
  ]);
  assert.deepEqual(original, before);
  const json = JSON.parse(
    await (
      await exportDocument(document, { format: "json", sensors: ["165:5"] })
    ).blob.text(),
  );
  assert.deepEqual(json.series["165:5"], points);
});
test("motion envelopes bound output while retaining peaks and invalid-slot gaps", async () => {
  const document = await FitDocument.open(motion(), "motion.fit");
  const selected = ["165:5", "165:6", "164:5", "164:6"];
  const data = await chart(document, {
    sensors: selected,
    width: 100,
    developer: false,
  });
  assert.ok(data.series["165:5"].some((p) => p.value === 9999));
  for (const key of selected) assert.ok(data.series[key].length <= 200);
  const full = await chart(
    document,
    { sensors: ["165:6"], width: 100, developer: false },
    idleJob(),
    true,
  );
  const source = full.series["165:6"];
  for (let i = 1; i < data.series["165:6"].length; i++) {
    const a = data.series["165:6"][i - 1],
      b = data.series["165:6"][i];
    if (a.value === null || b.value === null) continue;
    assert.ok(
      !source.some(
        (p) => p.time > a.time && p.time < b.time && p.value === null,
      ),
    );
  }
  const zoom = await chart(document, {
    sensors: ["165:5"],
    width: 100,
    developer: false,
    start: 100,
    end: 100.24,
  });
  assert.equal(zoom.series["165:5"].length, 25);
});
test("missing motion timing never fabricates samples and subfiles always split series", async () => {
  const document = await FitDocument.open(
    join([
      file(
        [
          {
            message: 164,
            fields: [
              [253, 6, 0],
              [0, 4, 0],
              [1, 4, [0, 10, 65535, 30]],
              [2, 4, [1, 65535, 3, 4]],
            ],
          },
        ],
        false,
      ),
      file(
        [
          {
            message: 164,
            fields: [
              [253, 6, 0],
              [0, 4, 0],
              [1, 4, 0],
              [2, 4, 8],
            ],
          },
        ],
        false,
      ),
    ]),
    "joined.fit",
  );
  const data = await chart(document, {
    sensors: ["164:2"],
    width: 100,
    developer: true,
  });
  assert.deepEqual(data.series["164:2"], [
    { time: 0, value: 1 },
    { time: 0.01, value: null },
    { time: 0.03, value: null },
    { time: 0.03, value: 4 },
    { time: 0, value: null },
    { time: 0, value: 8 },
  ]);
  const absent = await FitDocument.open(
    file(
      [
        {
          message: 164,
          fields: [
            [253, 6, 0],
            [5, 8, [1, 2]],
          ],
        },
      ],
      false,
    ),
    "no-time.fit",
  );
  assert.deepEqual(
    (await chart(absent, { sensors: ["164:5"], width: 100, developer: false }))
      .series["164:5"],
    undefined,
  );
});
test("unequal motion axes cannot break the display budget and zero filters remain effective", async () => {
  const document = await FitDocument.open(
    file(
      Array.from({ length: 400 }, (_, i) => ({
        message: 165,
        fields: [
          [253, 6, i],
          [0, 4, 0],
          [1, 4, Array.from({ length: 25 }, (_, j) => j * 10)],
          [5, 8, 0],
          [6, 8, Array.from({ length: 25 }, () => 1)],
        ] as Field[],
      })),
      false,
    ),
    "unequal.fit",
  );
  const data = await chart(document, {
    sensors: ["165:5", "165:6"],
    width: 20,
    developer: false,
    filter: { min: 0, max: 0 },
  });
  assert.ok(data.series["165:5"].some((p) => p.value === 0));
  for (const points of Object.values(data.series)) {
    assert.ok(points.length <= 40);
    assert.ok(points.every((p) => p.value === 0 || p.value === null));
  }
});
test("motion chart jobs yield cooperatively and can be cancelled", async () => {
  const document = await FitDocument.open(motion(4000), "cancel.fit");
  const controller = new AbortController();
  let progressed = false;
  await assert.rejects(
    chart(
      document,
      { sensors: ["165:5", "164:5"], width: 640, developer: false },
      createJob(controller.signal, () => {
        progressed = true;
        controller.abort();
      }),
    ),
    { name: "AbortError" },
  );
  assert.equal(progressed, true);
});
