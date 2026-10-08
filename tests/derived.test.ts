import test from "node:test";
import assert from "node:assert/strict";
import { FitDocument } from "../src/document/document";
import { file, join, type Field } from "./fixtures";

test("single-slot official arrays keep their array shape and invalid slots", async () => {
  const document = await FitDocument.open(
    file([{ message: 78, fields: [[0, 4, 65535]] }], false),
    "rr.fit",
  );
  assert.deepEqual(document.raw(0)["0"], [65535]);
  assert.deepEqual(document.cells(0)["0"].value, [null]);
});

test("heart-rate events use anchored timing without altering original missing samples", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 132,
          fields: [
            [253, 6, 1000000000],
            [6, 2, 80],
            [9, 6, 0],
          ],
        },
        {
          message: 132,
          fields: [
            [6, 2, [100, 120]],
            [9, 6, [1024, 2048]],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1000000000],
            [3, 2, 255],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1000000001],
            [3, 2, 255],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 1000000002],
            [3, 2, 255],
          ],
        },
      ],
      false,
    ),
    "hr.fit",
  );
  assert.deepEqual(
    [2, 3, 4].map((id) => document.cells(id)["3"].value),
    [80, 85, 105],
  );
  assert.deepEqual(
    [2, 3, 4].map((id) => document.raw(id)["3"]),
    [255, 255, 255],
  );
  assert.equal(document.index.diagnostics.length, 0);
});

test("unanchored HR samples remain inspectable with a warning instead of guessed timing", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 132,
          fields: [
            [6, 2, 100],
            [9, 6, 1024],
          ],
        },
      ],
      false,
    ),
    "hr.fit",
  );
  assert.ok(document.index.diagnostics.some((d) => d.code === "hr-timing"));
  assert.equal(document.mergedHr.size, 0);
});

test("memo parts use subfile-local parent ordinals, modern data and continuous UTF-8", async () => {
  const memo = (
    order: number,
    bytes: number[],
  ): { message: number; fields: Field[] } => ({
    message: 145,
    fields: [
      [250, 6, order],
      [1, 4, 19],
      [2, 4, 1],
      [3, 2, 0],
      [0, 13, [88]],
      [4, 10, bytes],
    ],
  });
  const original = join([
    file(
      [
        {
          message: 19,
          fields: [
            [254, 4, 1],
            [0, 7, "first"],
          ],
        },
        {
          message: 19,
          fields: [
            [254, 4, 9],
            [0, 7, "second"],
          ],
        },
        memo(1, [0x82, 0xac, 0]),
        memo(0, [65, 0xe2]),
      ],
      false,
    ),
    file(
      [
        {
          message: 19,
          fields: [
            [254, 4, 1],
            [0, 7, "third"],
          ],
        },
        {
          message: 19,
          fields: [
            [254, 4, 9],
            [0, 7, "fourth"],
          ],
        },
        memo(0, [66, 0]),
      ],
      false,
    ),
  ]);
  const before = original.slice();
  const document = await FitDocument.open(original, "memo.fit");
  assert.equal(document.cells(0)["0"].value, "first");
  assert.equal(document.cells(1)["0"].value, "A\u20ac");
  assert.equal(document.cells(4)["0"].value, "third");
  assert.equal(document.cells(5)["0"].value, "B");
  assert.equal(document.raw(1)["0"], "second");
  assert.equal(document.raw(5)["0"], "fourth");
  assert.deepEqual(original, before);
});
