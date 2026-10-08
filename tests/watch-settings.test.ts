import assert from "node:assert/strict";
import test from "node:test";
import { Profile } from "@garmin/fitsdk";
import metadata from "../src/metadata/watch-settings.json";
import { FitDocument } from "../src/document/document";
import { TYPE_NAMES } from "../src/protocol/binary";
import { data, definition, file, join, type Field } from "./fixtures";
import { wrapBody } from "../src/protocol/writer";
const hotkeys = (): Field[] =>
  [52, 43, 42, 0, 25, 99, 29, 255].map((value, id) => [id, 0, value]);

test("independent watch reference contains 169 fields without user configuration values", () => {
  assert.equal(Object.keys(metadata.messages).length, 20);
  assert.equal(
    Object.values(metadata.messages).reduce(
      (n, m) => n + Object.keys(m.fields).length,
      0,
    ),
    169,
  );
  assert.equal(
    metadata.sha256,
    "837a60687f2957cc4b0e67bea876b87e42b116fdfcb2d3edf1813320b2e5f532",
  );
  for (const message of Object.values(metadata.messages))
    for (const field of Object.values(message.fields)) {
      assert.ok(!("enabled" in field) && !("value" in field));
    }
});
test("every watch field enriches only a matching wire layout", async () => {
  for (const [number, message] of Object.entries(metadata.messages)) {
    const fields = new Map<number, Field>();
    for (const [id, untyped] of Object.entries(message.fields)) {
      const field = untyped as {
        baseType?: number;
        values?: Record<string, string>;
        recordGuard?: {
          fields: { number: number; baseType: number; size: number }[];
        };
      };
      const official = Profile.messages[Number(number)]?.fields[Number(id)];
      const type =
        (field.baseType ??
          Math.max(0, TYPE_NAMES.indexOf(official?.baseType ?? "uint32"))) & 31;
      fields.set(Number(id), [
        Number(id),
        type,
        type === 7 ? "" : Number(Object.keys(field.values ?? {})[0] ?? 0),
      ]);
    }
    for (const untyped of Object.values(message.fields))
      for (const guard of (
        untyped as {
          recordGuard?: {
            fields: { number: number; baseType: number; size: number }[];
          };
        }
      ).recordGuard?.fields ?? []) {
        fields.set(guard.number, [
          guard.number,
          guard.baseType & 31,
          (guard.baseType & 31) === 7
            ? ""
            : (fields.get(guard.number)?.[2] ?? 0),
          guard.size,
        ]);
      }
    const document = await FitDocument.open(
      file([{ message: Number(number), fields: Array.from(fields.values()) }]),
      "settings.fit",
    );
    const recordId = document.index.messages.get(Number(number))![0];
    const record = document.index.records[recordId];
    const raw = document.raw(recordId);
    for (const id of Object.keys(message.fields))
      assert.ok(
        document.metadata.watchField(
          record,
          record.definition.fields.find((f) => f.id === Number(id))!,
          raw,
        ),
        `${number}:${id}`,
      );
  }
});
test("identity may follow settings and does not cross subfile boundaries", async () => {
  const fields = hotkeys();
  const identity: Field[] = [
    [0, 0, 2],
    [1, 4, 1],
    [2, 4, 4586],
  ];
  const late = wrapBody(
    join([
      definition(354, fields),
      data(fields),
      definition(0, identity),
      data(identity),
    ]),
  );
  const matched = await FitDocument.open(late, "late.fit");
  assert.equal(matched.cells(0)["0"].value, "Settings");
  const unmatched = await FitDocument.open(
    file([{ message: 354, fields }], true, 999),
    "other.fit",
  );
  assert.equal(unmatched.getFields(354, false).length, 0);
  assert.equal(unmatched.cells(1)["0"].raw, 52);
  const combined = await FitDocument.open(
    join([late, file([{ message: 354, fields }], false)]),
    "combined.fit",
  );
  assert.equal(combined.cells(2)["0"].value, 52);
  assert.equal(Profile.messages[354], undefined);
});
test("big endian, invalid array slots, flags, and unknown enum codes retain raw values", async () => {
  const bytes = file([
    { message: 354, fields: hotkeys(), little: false },
    { message: 242, fields: [[1, 2, [1, 255, 3, 0]]] },
    {
      message: 2,
      fields: [
        [90, 6, 0x80000000],
        [217, 0, 7],
      ],
    },
    { message: 2, fields: [[90, 6, 0x1001]] },
  ]);
  const original = bytes.slice();
  const document = await FitDocument.open(bytes, "values.fit");
  assert.equal(document.cells(1)["0"].value, "Settings");
  assert.deepEqual(document.cells(2)["1"].value, [1, null, 3, 0]);
  assert.equal(document.cells(3)["217"].value, 7);
  assert.match(String(document.cells(3)["90"].value), /Reserved/);
  assert.match(String(document.cells(4)["90"].value), /0x1000/);
  assert.deepEqual(bytes, original);
});
test("layout and sleep index guard mismatches keep unidentified values raw", async () => {
  const wrongType = hotkeys();
  wrongType[0][1] = 2;
  const document = await FitDocument.open(
    file([
      { message: 354, fields: wrongType },
      {
        message: 379,
        fields: [
          [0, 6, 79200],
          [1, 6, 25200],
          [254, 4, 7],
        ],
      },
    ]),
    "guards.fit",
  );
  const keys = document.index.records[1];
  assert.equal(
    document.metadata.field(keys, keys.definition.fields[0], document.raw(1))
      .unknown,
    true,
  );
  const sleep = document.index.records[2];
  assert.equal(
    document.metadata.watchField(
      sleep,
      sleep.definition.fields[0],
      document.raw(2),
    ),
    undefined,
  );
  assert.equal(document.cells(2)["0"].raw, 79200);
});
test("known official scale takes precedence over supplemental watch metadata", async () => {
  const document = await FitDocument.open(
    file([
      {
        message: 3,
        fields: [
          [3, 2, 180],
          [4, 4, 725],
        ],
      },
    ]),
    "profile.fit",
  );
  assert.equal(document.cells(1)["3"].value, 1.8);
  assert.equal(document.cells(1)["4"].value, 72.5);
});
