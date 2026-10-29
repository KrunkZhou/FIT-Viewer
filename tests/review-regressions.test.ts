import assert from "node:assert/strict";
import test from "node:test";
import { Decoder, Stream } from "@garmin/fitsdk";
import { FitDocument } from "../src/document/document";
import { NumericReader } from "../src/document/numeric-reader";
import { exportDocument } from "../src/export/export";
import { sensors } from "../src/document/series";
import { wrapBody } from "../src/protocol/writer";
import { data, definition, file, join, type Field } from "./fixtures";

test("invalid first samples do not hide later derived fields under the same definition", async () => {
  for (const little of [true, false]) {
    const fields: Field[] = [
      [253, 6, 100],
      [6, 4, 65535],
      [2, 4, 65535],
    ];
    const document = await FitDocument.open(
      wrapBody(
        join([
          definition(20, fields, 0, little),
          data(fields, 0, little),
          ...Array.from({ length: 20 }, (_, i) =>
            data(
              [
                [253, 6, 101 + i],
                [6, 4, 1200 + i],
                [2, 4, 3000 + i],
              ],
              0,
              little,
            ),
          ),
        ]),
      ),
      "invalid-first.fit",
    );
    assert.ok(
      document.getFields(20, false).some((field) => field.key === "73"),
    );
    assert.ok(
      document.getFields(20, false).some((field) => field.key === "78"),
    );
    assert.equal(document.cells(0)["73"], undefined);
    assert.equal(document.cells(1)["73"].value, 1.2);
    assert.ok(
      sensors(document, false).some((sensor) => sensor.key === "20:73"),
    );
    const csv = await (
      await exportDocument(document, { format: "csv" })
    ).blob.text();
    assert.match(csv.split("\n")[0], /Enhanced Speed,Enhanced Altitude/);
    assert.ok(csv.split("\n")[1].endsWith(",,,,"));
  }
});

test("CSV resolves active subfields per row without borrowing labels or rounding precision", async () => {
  const fields: Field[] = [
    [253, 6, 100],
    [0, 0, 0],
    [1, 0, 0],
    [3, 6, 0],
  ];
  const document = await FitDocument.open(
    wrapBody(
      join([
        definition(21, fields),
        data(fields),
        data([
          [253, 6, 101],
          [0, 0, 15],
          [1, 0, 3],
          [3, 6, 1234],
        ]),
        data([
          [253, 6, 102],
          [0, 0, 11],
          [1, 0, 3],
          [3, 6, 3876],
        ]),
      ]),
    ),
    "events.fit",
  );
  const csv = await (
    await exportDocument(document, { format: "csv", message: 21 })
  ).blob.text();
  assert.equal(csv.split("\n")[0], "Timestamp,Event,Event Type,Data");
  assert.ok(csv.includes(",Speed High Alert,Marker,1.234"));
  assert.ok(csv.includes(",Battery,Marker,3.876"));
  assert.ok(csv.includes(",Timer,Start,Manual"));
  const raw = await (
    await exportDocument(document, {
      format: "csv",
      message: 21,
      developer: true,
    })
  ).blob.text();
  assert.ok(raw.includes("101,15,3,1234"));
});

test("active packed subfields expand like Garmin and remain readable through projections", async () => {
  for (const little of [true, false]) {
    const fields: Field[] = [
      [253, 6, 100],
      [0, 0, 0],
      [1, 0, 0],
      [3, 6, 0],
    ];
    const bytes = wrapBody(
      join([
        definition(21, fields, 0, little),
        data(fields, 0, little),
        data(
          [
            [253, 6, 101],
            [0, 0, 42],
            [1, 0, 3],
            [3, 6, 0x34210201],
          ],
          0,
          little,
        ),
      ]),
    );
    const document = await FitDocument.open(bytes, "gears.fit");
    const sdk = new Decoder(Stream.fromByteArray(Array.from(bytes))).read({
      convertDateTimesToDates: false,
    });
    assert.equal(sdk.errors.length, 0);
    const official = (
      sdk.messages as unknown as { eventMesgs: Record<string, number>[] }
    ).eventMesgs[1];
    for (const [key, name] of [
      ["9", "frontGearNum"],
      ["10", "frontGear"],
      ["11", "rearGearNum"],
      ["12", "rearGear"],
    ]) {
      assert.equal(document.cells(1)[key].value, official[name]);
      assert.equal(
        document.cells(1, true, new Set([key]))[key].value,
        official[name],
      );
      assert.ok(
        document.getFields(21, false).some((field) => field.key === key),
      );
    }
    assert.equal(document.cells(0)["9"], undefined);
    assert.equal(document.cells(1, false)["9"], undefined);
  }
});

test("derived dynamic columns also use neutral headers and per-record precision", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 21,
          fields: [
            [253, 6, 100],
            [0, 0, 0],
            [2, 4, 0],
          ],
        },
        {
          message: 21,
          fields: [
            [253, 6, 101],
            [0, 0, 15],
            [2, 4, 1234],
          ],
        },
      ],
      false,
    ),
    "data16.fit",
  );
  assert.equal(
    document.getFields(21, false).find((field) => field.key === "3")?.name,
    "Data",
  );
  const csv = await (
    await exportDocument(document, { format: "csv", message: 21 })
  ).blob.text();
  assert.ok(csv.split("\n")[2].endsWith(",1.234"));
});

const motion = (start: number) =>
  file(
    [0, 1].map((i) => ({
      message: 165,
      fields: [
        [253, 6, start + i],
        [0, 4, 500],
        [1, 4, [20, 0, 65535, 40]],
        [5, 8, [i, 1 + i, 2 + i, 3 + i]],
      ] as Field[],
    })),
    false,
  );

test("CSV keeps developer precision when a description changes under a shared data definition", async () => {
  const description = (scale: number): Field[] => [
    [0, 2, 0],
    [1, 2, 4],
    [2, 2, 132],
    [3, 7, "Measurement"],
    [6, 2, scale],
    [8, 7, "m"],
  ];
  const fields: Field[] = [[253, 6, 100]];
  const bytes = wrapBody(
    join([
      definition(206, description(100), 1),
      data(description(100), 1),
      definition(20, fields, 0, true, [[4, 2, 0]]),
      data(fields, 0, true, undefined, Uint8Array.of(210, 4)),
      data(description(10), 1),
      data([[253, 6, 101]], 0, true, undefined, Uint8Array.of(210, 4)),
    ]),
  );
  const document = await FitDocument.open(bytes, "developer-scales.fit");
  const csv = await (
    await exportDocument(document, { format: "csv" })
  ).blob.text();
  assert.ok(csv.split("\n")[1].endsWith(",12.34"));
  assert.ok(csv.split("\n")[2].endsWith(",123.4"));
});

test("motion summary bounds include packet milliseconds and offsets, without overriding record timing", async () => {
  const document = await FitDocument.openSources(
    [
      { filename: "first.fit", bytes: motion(100) },
      { filename: "second.fit", bytes: motion(200) },
    ],
    "motion-folder",
  );
  const summary = document.summary();
  assert.equal(summary.startTimestamp, 100.5);
  assert.equal(summary.endTimestamp, 201.54);
  assert.ok(Math.abs(summary.durationSeconds! - 2.08) < 0.000001);
  const records = file(
    [
      { message: 20, fields: [[253, 6, 300]] },
      { message: 20, fields: [[253, 6, 310]] },
    ],
    false,
  );
  const concatenated = await FitDocument.open(
    join([records, motion(400)]),
    "concatenated.fit",
  );
  assert.equal(concatenated.summary().startTimestamp, 300);
  assert.equal(concatenated.summary().endTimestamp, 401.54);
  const sameSubfile = await FitDocument.open(
    file(
      [
        { message: 20, fields: [[253, 6, 300]] },
        { message: 20, fields: [[253, 6, 310]] },
        {
          message: 165,
          fields: [
            [253, 6, 100],
            [0, 4, 0],
            [1, 4, [0, 10]],
            [5, 8, [1, 2]],
          ],
        },
      ],
      false,
    ),
    "mixed.fit",
  );
  assert.equal(sameSubfile.summary().startTimestamp, 300);
  assert.equal(sameSubfile.summary().endTimestamp, 310);
});

test("reusable numeric rows agree with Cell reads across invalid, derived and dynamic values", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 100],
            [0, 5, 100],
            [1, 5, -100],
            [6, 4, 65535],
            [2, 4, 65535],
          ],
        },
        {
          message: 20,
          little: false,
          fields: [
            [253, 6, 101],
            [0, 5, 200],
            [1, 5, -200],
            [6, 4, 2345],
            [2, 4, 3001],
          ],
        },
        {
          message: 21,
          fields: [
            [253, 6, 102],
            [0, 0, 42],
            [3, 6, 0x34210201],
          ],
        },
      ],
      false,
    ),
    "numeric.fit",
  );
  for (const developer of [true, false]) {
    const reader = new NumericReader(
      document,
      ["0", "1", "6", "2", "73", "78", "9", "253"],
      developer,
    );
    const values: Parameters<typeof reader.values>[1] = [];
    for (let id = 0; id < document.index.records.length; id++) {
      reader.values(id, values);
      assert.deepEqual(
        values,
        reader.read(id).map((cell) => cell?.value),
      );
    }
  }
});
