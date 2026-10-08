import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { chart, chartSensors, mapData } from "../src/document/series";
import { exportDocument } from "../src/export/export";
import { groupSensors } from "../src/ui/chart-groups";
import { createJob } from "../src/document/jobs";
import { definition, file, join, type Field } from "./fixtures";
import { wrapBody } from "../src/protocol/writer";
import { positionCoordinates } from "../src/document/positions";

test("GPS availability requires usable coordinates, not declared or empty fields", async () => {
  const cases: Field[][] = [
    [[3, 2, 120]],
    [[0, 5, 0]],
    [[1, 5, 0]],
    [
      [0, 5, 0x7fffffff],
      [1, 5, 0],
    ],
    [
      [0, 5, 0],
      [1, 5, 0x7fffffff],
    ],
    [
      [0, 5, 1200000000],
      [1, 5, 0],
    ],
  ];
  for (const fields of cases) {
    const document = await FitDocument.open(
      file([{ message: 20, fields }], false),
      "no-gps.fit",
    );
    assert.equal(document.summary().hasMap, false, JSON.stringify(fields));
    assert.deepEqual(await mapData(document), { tracks: [], points: [] });
  }
  const definitionsOnly = await FitDocument.open(
    wrapBody(
      definition(20, [
        [0, 5, 0],
        [1, 5, 0],
      ]),
    ),
    "definition.fit",
  );
  assert.equal(definitionsOnly.summary().hasMap, false);
  const incomplete = await FitDocument.open(
    file(
      [
        { message: 20, fields: [[0, 5, 0]] },
        { message: 20, fields: [[1, 5, 0]] },
        {
          message: 64000,
          fields: [
            [0, 5, 0],
            [1, 5, 0],
          ],
        },
      ],
      false,
    ),
    "incomplete.fit",
  );
  assert.equal(incomplete.summary().hasMap, false);
});

test("GPS availability preserves zero coordinates, waypoints and later subfiles", async () => {
  for (const message of [20, 32]) {
    const document = await FitDocument.open(
      file(
        [
          {
            message,
            fields:
              message === 20
                ? [
                    [0, 5, 0],
                    [1, 5, 0],
                  ]
                : [
                    [2, 5, 0],
                    [3, 5, 0],
                  ],
          },
        ],
        false,
      ),
      "gps.fit",
    );
    assert.equal(document.summary().hasMap, true);
    const map = await mapData(document);
    assert.ok(map.tracks.length || map.points.length);
  }
  const document = await FitDocument.open(
    join([
      file(
        [
          {
            message: 20,
            fields: [
              [0, 5, 0x7fffffff],
              [1, 5, 0x7fffffff],
            ],
          },
        ],
        false,
      ),
      file(
        [
          {
            message: 20,
            fields: [
              [0, 5, 0],
              [1, 5, 0],
            ],
          },
        ],
        false,
      ),
    ]),
    "joined.fit",
  );
  assert.equal(document.summary().hasMap, true);
  assert.equal((await mapData(document)).tracks.length, 1);
  for (const value of [NaN, Infinity, -Infinity, 91])
    assert.equal(positionCoordinates(value, 0), undefined);
  assert.equal(positionCoordinates(0, 181), undefined);
});

test("chart inventory requires ten finite source points, counting zero values and packet arrays", async () => {
  const document = await FitDocument.open(
    file(
      [
        ...Array.from({ length: 12 }, (_, i) => ({
          message: 20,
          fields: [
            [253, 6, i],
            [3, 2, i < 9 ? 100 : 255],
            [4, 2, 255],
            [6, 4, i < 10 ? i : 65535],
          ] as Field[],
        })),
        {
          message: 18,
          fields: [
            [253, 6, 0],
            [9, 6, 10],
          ],
        },
        {
          message: 165,
          fields: [
            [253, 6, 0],
            [0, 4, 0],
            [1, 4, Array.from({ length: 12 }, (_, i) => i * 10)],
            [5, 8, [...Array.from({ length: 10 }, (_, i) => i), NaN, NaN]],
            [6, 8, [...Array.from({ length: 9 }, (_, i) => i), NaN, NaN, NaN]],
            [7, 8, Array.from({ length: 12 }, () => NaN)],
          ],
        },
        {
          message: 64000,
          fields: [
            [7, 6, Array.from({ length: 10 }, (_, i) => i)],
            [8, 6, Array.from({ length: 9 }, (_, i) => i)],
          ],
        },
      ],
      false,
    ),
    "inventory.fit",
  );
  const user = await chartSensors(document, false);
  assert.ok(user.some((sensor) => sensor.key === "20:6"));
  assert.ok(user.some((sensor) => sensor.key === "165:5"));
  for (const key of ["20:3", "20:4", "18:9", "165:6", "165:7", "64000:7"])
    assert.ok(!user.some((sensor) => sensor.key === key), key);
  const raw = await chartSensors(document, true);
  assert.ok(raw.some((sensor) => sensor.key === "64000:7"));
  assert.ok(!raw.some((sensor) => sensor.key === "20:3"));
  for (const key of ["64000:8", "165:6", "165:7"])
    assert.ok(!raw.some((sensor) => sensor.key === key), key);
  const plotted = await chart(document, {
    sensors: ["20:3", "20:6", "165:5", "165:6"],
    width: 100,
    developer: false,
  });
  assert.deepEqual(Object.keys(plotted.series), ["165:5", "20:6"]);
  assert.equal(await chartSensors(document, false), user);
  assert.equal(user.find((sensor) => sensor.key === "20:6")?.pointCount, 10);
  assert.equal(user.find((sensor) => sensor.key === "165:5")?.pointCount, 10);
  assert.equal(raw.find((sensor) => sensor.key === "64000:7")?.pointCount, 10);
});

test("chart inventory ignores constant values and invalid slots but counts a late change before downsampling", async () => {
  const document = await FitDocument.open(
    file(
      [
        ...Array.from({ length: 100 }, (_, i) => ({
          message: 20,
          fields: [
            [253, 6, i],
            [3, 2, i === 30 ? 255 : 100],
            [4, 2, 0],
            [6, 4, i === 99 ? 1 : 0],
            [7, 4, i % 3 ? 65535 : 12],
          ] as Field[],
        })),
        {
          message: 165,
          fields: [
            [253, 6, 100],
            [0, 4, 0],
            [1, 4, Array.from({ length: 12 }, (_, i) => i * 10)],
            [5, 8, Array.from({ length: 12 }, () => 0)],
            [6, 8, Array.from({ length: 12 }, (_, i) => (i === 8 ? NaN : 7))],
            [7, 8, Array.from({ length: 12 }, (_, i) => (i === 11 ? 3 : 2))],
          ],
        },
        {
          message: 165,
          fields: [
            [253, 6, 101],
            [0, 4, 0],
            [1, 4, [65535, 65535]],
            [7, 8, [4, 5]],
          ],
        },
      ],
      false,
    ),
    "constant.fit",
  );
  for (const developer of [false, true]) {
    const inventory = await chartSensors(document, developer);
    assert.deepEqual(
      inventory.map((sensor) => [sensor.key, sensor.pointCount]),
      developer
        ? [
            ["20:6", 100],
            ["165:7", 12],
          ]
        : [
            ["20:6", 100],
            ["20:73", 100],
            ["165:7", 12],
          ],
    );
    const data = await chart(document, {
      developer,
      sensors: ["20:3", "20:4", "20:6", "165:5", "165:7"],
      width: 1,
    });
    assert.deepEqual(Object.keys(data.series), ["165:7", "20:6"]);
  }
  const exported = JSON.parse(
    await (
      await exportDocument(document, {
        format: "json",
        sensors: ["20:4", "165:5"],
      })
    ).blob.text(),
  );
  assert.equal(exported.series["20:4"].length, 100);
  assert.ok(
    exported.series["20:4"].every(
      (point: { value: number }) => point.value === 0,
    ),
  );
  assert.equal(exported.series["165:5"].length, 12);
});

test("combined sensor counts sum nonconstant source traces without changing per-file eligibility", async () => {
  const source = (count: number, constant: boolean) =>
    file(
      Array.from({ length: count }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, i],
          [3, 2, constant ? 100 : 100 + i],
        ] as Field[],
      })),
      false,
    );
  const document = await FitDocument.openSources(
    [
      { filename: "A.fit", bytes: source(10, false) },
      { filename: "B.fit", bytes: source(12, false) },
      { filename: "constant.fit", bytes: source(30, true) },
      { filename: "short.fit", bytes: source(9, false) },
    ],
    "traces.zip",
  );
  const inventory = await chartSensors(document, false);
  assert.deepEqual(
    inventory.map((sensor) => sensor.pointCount),
    [10, 12],
  );
  const groups = groupSensors(inventory);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].sensor.pointCount, 22);
});

test("chart inventory scanning can be cancelled without caching incomplete results", async () => {
  const document = await FitDocument.open(
    file(
      [
        ...Array.from({ length: 10 }, (_, i) => ({
          message: 20,
          fields: [
            [253, 6, i],
            [3, 2, 100 + i],
          ] as Field[],
        })),
      ],
      false,
    ),
    "cancel.fit",
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    chartSensors(document, false, createJob(controller.signal)),
    { name: "AbortError" },
  );
  assert.ok(
    (await chartSensors(document, false)).some((s) => s.key === "20:3"),
  );
});

test("map point route identities survive simplification and separate subfiles", async () => {
  const route = (latitude: number) =>
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 0],
            [0, 5, latitude],
            [1, 5, 100000],
            [5, 6, 0],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1],
            [0, 5, latitude + 10000],
            [1, 5, 110000],
            [5, 6, 100000],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 2],
            [0, 5, latitude + 20000],
            [1, 5, 120000],
            [5, 6, 200000],
          ],
        },
      ],
      false,
    );
  const original = join([route(1000000), route(2000000)]);
  const before = original.slice();
  const document = await FitDocument.open(original, "routes.fit");
  const map = await mapData(document);
  assert.equal(map.tracks.length, 2);
  for (const kind of ["distance", "start", "finish"])
    assert.deepEqual(
      [
        ...new Set(
          map.points.filter((p) => p.kind === kind).map((p) => p.route),
        ),
      ],
      [0, 1],
    );
  assert.deepEqual(
    map.points.filter((p) => p.kind === "distance").map((p) => p.name),
    ["1 km", "2 km", "1 km", "2 km"],
  );
  assert.deepEqual(original, before);
});
