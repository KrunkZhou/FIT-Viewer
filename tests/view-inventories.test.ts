import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { chartSensors, mapData } from "../src/document/series";
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

test("chart inventory excludes zero and single finite samples, but retains single-packet arrays", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 0],
            [3, 2, 100],
            [4, 2, 255],
            [6, 4, 0],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1],
            [3, 2, 255],
            [4, 2, 255],
            [6, 4, 0],
          ],
        },
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
            [1, 4, [0, 10]],
            [5, 8, [1, 2]],
            [6, 8, [NaN, 1]],
          ],
        },
        { message: 64000, fields: [[7, 6, [3, 4]]] },
      ],
      false,
    ),
    "inventory.fit",
  );
  const user = await chartSensors(document, false);
  assert.ok(user.some((sensor) => sensor.key === "20:6"));
  assert.ok(user.some((sensor) => sensor.key === "165:5"));
  for (const key of ["20:3", "20:4", "18:9", "165:6", "64000:7"])
    assert.ok(!user.some((sensor) => sensor.key === key), key);
  const raw = await chartSensors(document, true);
  assert.ok(raw.some((sensor) => sensor.key === "64000:7"));
  assert.ok(raw.some((sensor) => sensor.key === "20:3"));
  assert.equal(await chartSensors(document, false), user);
});

test("chart inventory scanning can be cancelled without caching incomplete results", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 0],
            [3, 2, 100],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1],
            [3, 2, 101],
          ],
        },
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
