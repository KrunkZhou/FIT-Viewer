import assert from "node:assert/strict";
import test from "node:test";
import { Decoder, Stream } from "@garmin/fitsdk";
import { FitDocument } from "../src/document/document";
import { readFit } from "../src/protocol/reader";
import { wrapBody } from "../src/protocol/writer";
import { repair, addSummaryDiagnostics } from "../src/repair/repair";
import {
  activity,
  checksum,
  data,
  definition,
  file,
  join,
  type Field,
} from "./fixtures";

test("official SDK and independent decoder agree on supported activity fields", async () => {
  const bytes = activity(25);
  const document = await FitDocument.open(bytes, "activity.fit");
  const sdk = new Decoder(Stream.fromByteArray(Array.from(bytes))).read({
    convertDateTimesToDates: false,
  });
  assert.equal(sdk.errors.length, 0);
  const official = (
    sdk.messages as unknown as {
      recordMesgs: { heartRate: number; speed: number; distance: number }[];
    }
  ).recordMesgs;
  const page = await document.table({
    message: 20,
    developer: false,
    page: 0,
    size: 25,
  });
  page.rows.forEach((row, i) => {
    assert.equal(row.cells["3"].value, official[i].heartRate);
    assert.equal(row.cells["6"].value, official[i].speed);
    assert.equal(row.cells["5"].value, official[i].distance);
  });
});
test("compressed timestamp wrap and zero base are retained", async () => {
  const fields: Field[] = [
    [253, 6, 0],
    [3, 2, 100],
  ];
  const bytes = wrapBody(
    join([
      definition(20, fields),
      data(fields),
      data(fields, 0, true, 31),
      data(fields, 0, true, 0),
    ]),
  );
  const index = await readFit(bytes);
  assert.deepEqual(
    index.records.map((r) => r.timestamp),
    [0, 31, 32],
  );
  assert.equal(index.raw(index.records[2])["253"], 32);
  assert.equal(index.diagnostics.length, 0);
});
test("definition changes, big endian, arrays, invalid slots, and 64-bit precision", async () => {
  const large = 18446744073709551614n;
  const bytes = file(
    [
      {
        message: 600,
        little: false,
        fields: [
          [0, 4, [1, 65535, 3]],
          [1, 15, large],
          [2, 16, 0n],
          [3, 9, 1.25],
        ],
      },
      { message: 600, fields: [[0, 5, -42]] },
    ],
    false,
  );
  const document = await FitDocument.open(bytes, "unknown.fit");
  const page = await document.table({
    message: 600,
    developer: true,
    size: 20,
    page: 0,
  });
  assert.deepEqual(page.rows[0].cells["0"].raw, [1, 65535, 3]);
  assert.deepEqual(page.rows[0].cells["0"].value, [1, null, 3]);
  assert.equal(page.rows[0].cells["1"].raw, large);
  assert.equal(page.rows[0].cells["2"].value, null);
  assert.equal(page.rows[1].cells["0"].raw, -42);
  assert.equal(
    (
      await document.table({
        message: 600,
        developer: false,
        size: 20,
        page: 0,
      })
    ).fields.length,
    0,
  );
});
test("developer descriptions arriving after records retain arrays and scale", async () => {
  const fields: Field[] = [[253, 6, 100]];
  const description: Field[] = [
    [0, 2, 0],
    [1, 2, 4],
    [2, 2, 132],
    [3, 7, "Custom sensor"],
    [6, 2, 10],
    [8, 7, "m"],
  ];
  const bytes = wrapBody(
    join([
      definition(20, fields, 0, true, [[4, 4, 0]]),
      data(fields, 0, true, undefined, Uint8Array.of(100, 0, 200, 0)),
      definition(206, description, 1),
      data(description, 1),
    ]),
  );
  const document = await FitDocument.open(bytes, "developer.fit");
  const page = await document.table({
    message: 20,
    developer: false,
    page: 0,
    size: 20,
  });
  assert.equal(
    page.fields.find((f) => f.key === "d0:4")?.name,
    "Custom sensor",
  );
  assert.deepEqual(page.rows[0].cells["d0:4"].raw, [100, 200]);
  assert.deepEqual(page.rows[0].cells["d0:4"].value, [10, 20]);
});
test("multiple FIT subfiles reset definitions, identity, and timestamp bases", async () => {
  const bytes = join([
    file([
      {
        message: 20,
        fields: [
          [253, 6, 100],
          [3, 2, 150],
        ],
      },
    ]),
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 0],
            [3, 2, 110],
          ],
        },
      ],
      true,
      999,
    ),
  ]);
  const index = await readFit(bytes);
  assert.equal(index.subfiles.length, 2);
  assert.deepEqual(
    index.subfiles.map((f) => f.product),
    [4586, 999],
  );
  assert.deepEqual(
    index.records
      .filter((r) => r.definition.message === 20)
      .map((r) => r.timestamp),
    [100, 0],
  );
  assert.equal(index.diagnostics.length, 0);
});
test("CRC repair preserves every original body byte, including unknown and developer records", async () => {
  const bytes = file(
    [
      {
        message: 600,
        fields: [
          [0, 15, 12345678901234567890n],
          [2, 13, [1, 2, 255]],
        ],
      },
    ],
    false,
  );
  bytes[bytes.length - 1] ^= 1;
  const document = await FitDocument.open(bytes, "crc.fit");
  const result = await repair(document);
  assert.deepEqual(result.bytes.subarray(14, -2), bytes.subarray(14, -2));
  assert.equal((await readFit(result.bytes)).diagnostics.length, 0);
  assert.equal(result.partial, false);
});
test("truncated data is omitted explicitly; verified prefix survives", async () => {
  const source = activity(25);
  const truncated = source.slice(0, -11);
  const document = await FitDocument.open(truncated, "short.fit");
  const result = await repair(document);
  assert.equal(result.partial, true);
  assert.ok(
    document.index.diagnostics.some((d) => d.code === "undecodable-tail"),
  );
  assert.equal(
    (await readFit(result.bytes)).diagnostics.filter(
      (d) => d.severity === "error",
    ).length,
    0,
  );
  const file = document.index.subfiles[0];
  assert.deepEqual(
    result.bytes.subarray(14, 14 + file.bodyEnd - file.bodyStart),
    source.subarray(file.bodyStart, file.bodyEnd),
  );
});
test("missing summaries are generated only with sport and ordered source evidence", async () => {
  const document = await FitDocument.open(activity(25), "activity.fit");
  await addSummaryDiagnostics(document);
  assert.equal(document.summary().repairable, true);
  const result = await repair(document);
  const repaired = await readFit(result.bytes);
  assert.deepEqual(
    result.generated.map((s) => s.split(": ")[1].split(" ")[0]),
    ["Lap", "Session", "Activity"],
  );
  assert.ok(repaired.messages.has(18));
  assert.ok(repaired.messages.has(34));
  const unknown = await FitDocument.open(
    file(
      [
        { message: 20, fields: [[253, 6, 100]] },
        { message: 20, fields: [[253, 6, 90]] },
      ],
      false,
    ),
    "unknown.fit",
  );
  assert.equal((await repair(unknown)).generated.length, 0);
  assert.ok(
    unknown.index.diagnostics.some((d) => d.code === "timestamp-order"),
  );
});
test("timestamp search aligns to a page and navigation remains clamped", async () => {
  const document = await FitDocument.open(activity(50), "activity.fit");
  const page = await document.table({
    message: 20,
    developer: false,
    page: -10,
    size: 20,
    timestamp: 1100000023,
  });
  assert.equal(page.page, 1);
  assert.equal(page.rows.length, 20);
  assert.equal(page.selected, document.index.messages.get(20)![23]);
  assert.equal(
    (
      await document.table({
        message: 20,
        developer: false,
        page: 500,
        size: 20,
      })
    ).page,
    2,
  );
});
test("invalid definition does not trigger speculative resynchronization", async () => {
  const source = activity(5);
  source[15] = 0xff;
  checksum(source);
  const index = await readFit(source);
  assert.ok(index.diagnostics.some((d) => d.code === "undecodable-tail"));
  assert.equal(index.records.length, 0);
});
test("overview activity facts come from retained records without fabricated summaries", async () => {
  const document = await FitDocument.open(activity(180), "overview.fit");
  const summary = document.summary();
  assert.equal(summary.records, 182);
  assert.equal(summary.gpsPoints, 180);
  assert.equal(summary.startTimestamp, 1100000000);
  assert.equal(summary.endTimestamp, 1100000179);
  assert.deepEqual(summary.sports, ["Running"]);
  assert.deepEqual(summary.fileTypes, ["Activity"]);
  assert.equal(
    summary.messages.some((message) => message.id === 18),
    false,
  );
});
