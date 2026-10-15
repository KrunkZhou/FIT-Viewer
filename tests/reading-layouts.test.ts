import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { NumericReader } from "../src/document/numeric-reader";
import { wrapBody } from "../src/protocol/writer";
import { data, definition, join, type Field } from "./fixtures";

test("cached record layouts preserve middle timestamps, endian redefinitions and compressed offsets", async () => {
  const first: Field[] = [
    [3, 2, 123],
    [253, 6, 30],
    [0, 5, -12345],
  ];
  const second: Field[] = [
    [0, 5, 12345],
    [253, 6, 100],
    [3, 2, 140],
  ];
  const bytes = wrapBody(
    join([
      definition(20, first),
      data(first),
      data(first, 0, true, 31),
      definition(20, second, 0, false),
      data(second, 0, false),
      data(second, 0, false, 5),
    ]),
  );
  const document = await FitDocument.open(bytes, "layout.fit");
  assert.deepEqual(
    document.index.records.map((r) => r.timestamp),
    [30, 31, 100, 101],
  );
  const keys = ["0", "3", "253"];
  for (const developer of [false, true]) {
    const reader = new NumericReader(document, keys, developer);
    for (const id of [0, 1, 2, 3]) {
      const cells = document.cells(id, !developer);
      assert.deepEqual(
        reader.read(id),
        keys.map((key) => cells[key]),
      );
    }
  }
  for (const id of [0, 1, 2, 3]) {
    const all = document.cells(id);
    const record = document.index.records[id];
    assert.equal(all["0"].raw, id < 2 ? -12345 : 12345);
    for (const key of Object.keys(all)) {
      assert.deepEqual(document.cells(id, true, new Set([key])), {
        [key]: all[key],
      });
      assert.deepEqual(document.metadata.raw(record, new Set([key])), {
        [key]: all[key].raw,
      });
    }
  }
  assert.deepEqual(document.index.bytes.subarray(), bytes);
  assert.equal(document.index.bytes.subarray().buffer, bytes.buffer);
});
