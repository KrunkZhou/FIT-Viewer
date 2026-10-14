import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../src/model";
import {
  MAX_CIQ_SETTINGS_BYTES,
  readCiqSettings,
  type CiqDictionary,
  type CiqValue,
} from "../src/protocol/ciq-settings";
import {
  SYNTHETIC_SETTINGS,
  SYNTHETIC_SETTINGS_VALUES,
  SDK_TYPED_SETTINGS,
} from "./ciq-fixtures";

const hex = (value: string) => Uint8Array.from(Buffer.from(value, "hex"));
const entry = (dictionary: CiqDictionary, name: string): CiqValue => {
  const found = dictionary.entries.find(
    ({ key }) => key.type === "string" && key.value === name,
  );
  assert.ok(found, `Missing ${name}`);
  return found.value;
};
const block = (data: number[]) => {
  const bytes = new Uint8Array(8 + data.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0xda7ada7a);
  view.setInt32(4, data.length);
  bytes.set(data, 8);
  return bytes;
};

test("reads a synthetic six-property .SET file without mutating bytes", async () => {
  const original = SYNTHETIC_SETTINGS.slice();
  assert.equal(original.length, 273);
  const result = await readCiqSettings(SYNTHETIC_SETTINGS);
  assert.deepEqual(
    result.entries,
    SYNTHETIC_SETTINGS_VALUES.map(([key, value]) => ({
      key: { type: "string", value: key },
      value: { type: "string", value },
    })),
  );
  assert.deepEqual(SYNTHETIC_SETTINGS, original);
});

test("matches Garmin SDK typed scalars and breadth-first nested containers", async () => {
  const result = await readCiqSettings(SDK_TYPED_SETTINGS);
  assert.equal(result.entries.length, 8);
  assert.deepEqual(entry(result, "integer"), { type: "integer", value: -17 });
  assert.deepEqual(entry(result, "long"), {
    type: "long",
    value: 9223372036854775807n,
  });
  assert.deepEqual(entry(result, "float"), { type: "float", value: 1.25 });
  assert.deepEqual(entry(result, "double"), { type: "double", value: 2.5 });
  assert.deepEqual(entry(result, "name"), { type: "string", value: "typed" });
  assert.deepEqual(entry(result, "enabled"), { type: "boolean", value: true });
  assert.deepEqual(entry(result, "arr"), {
    type: "array",
    items: [
      { type: "integer", value: 1 },
      {
        type: "dictionary",
        entries: [
          {
            key: { type: "string", value: "k" },
            value: { type: "string", value: "v" },
          },
        ],
      },
      {
        type: "array",
        items: [
          { type: "integer", value: 5 },
          { type: "integer", value: 6 },
        ],
      },
    ],
  });
  assert.deepEqual(entry(result, "nested"), {
    type: "dictionary",
    entries: [
      {
        key: { type: "string", value: "n" },
        value: { type: "integer", value: 2 },
      },
      {
        key: { type: "string", value: "a" },
        value: {
          type: "array",
          items: [
            { type: "integer", value: 3 },
            { type: "integer", value: 4 },
          ],
        },
      },
    ],
  });
  assert.deepEqual(structuredClone(result), result);
});

test("accepts empty dictionaries, null values, typed keys, and absent string tables", async () => {
  assert.deepEqual(await readCiqSettings(hex("DA7ADA7A000000050B00000000")), {
    type: "dictionary",
    entries: [],
  });
  const result = await readCiqSettings(
    hex("DA7ADA7A0000000B0B00000001010000000700"),
  );
  assert.deepEqual(result.entries, [
    {
      key: { type: "integer", value: 7 },
      value: { type: "null", value: null },
    },
  ]);
});

test("retains full negative Long precision and SDK boolean/non-finite float values", async () => {
  const result = await readCiqSettings(
    block([
      11, 0, 0, 0, 3, 1, 0, 0, 0, 1, 14, 128, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0,
      2, 9, 255, 1, 0, 0, 0, 3, 2, 127, 128, 0, 0,
    ]),
  );
  assert.deepEqual(result.entries[0].value, {
    type: "long",
    value: -9223372036854775808n,
  });
  assert.deepEqual(result.entries[1].value, { type: "boolean", value: true });
  assert.deepEqual(result.entries[2].value, { type: "float", value: Infinity });
});

test("handles typed arrays whose underlying buffer has unrelated bytes", async () => {
  const buffer = new Uint8Array(SYNTHETIC_SETTINGS.length + 20).fill(99);
  buffer.set(SYNTHETIC_SETTINGS, 9);
  assert.deepEqual(
    await readCiqSettings(buffer.subarray(9, 9 + SYNTHETIC_SETTINGS.length)),
    await readCiqSettings(SYNTHETIC_SETTINGS),
  );
});

test("preserves SDK UTF-8 strings, empty strings and leading Unicode BOM characters", async () => {
  const result = await readCiqSettings(
    hex(
      "ABCDABCD000000290006656D70747900000100000575746638000008E586ACF09F988000" +
        "0004626F6D000005EFBBBF7800DA7ADA7A000000230B000000030300000000030000" +
        "0008030000000B0300000012030000001C0300000022",
    ),
  );
  assert.deepEqual(entry(result, "utf8"), { type: "string", value: "冬😀" });
  assert.deepEqual(entry(result, "empty"), { type: "string", value: "" });
  assert.deepEqual(entry(result, "bom"), { type: "string", value: "\uFEFFx" });
});

test("app-controlled property names cannot alter JavaScript prototypes", async () => {
  // Literal string table for '__proto__' and 'safe', then their references.
  const result = await readCiqSettings(
    hex(
      "ABCDABCD00000013000A5F5F70726F746F5F5F0000057361666500" +
        "DA7ADA7A0000000F0B000000010300000000030000000C",
    ),
  );
  assert.deepEqual(result.entries, [
    {
      key: { type: "string", value: "__proto__" },
      value: { type: "string", value: "safe" },
    },
  ]);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(({} as { safe?: string }).safe, undefined);
});

test("rejects every truncated prefix of the synthetic .SET file", async () => {
  for (let length = 0; length < SYNTHETIC_SETTINGS.length; length++)
    await assert.rejects(
      readCiqSettings(SYNTHETIC_SETTINGS.subarray(0, length)),
    );
});

test("rejects malformed magic, lengths, string offsets and encodings", async () => {
  const cases = [
    hex("00000000000000050B00000000"),
    hex("DA7ADA7AFFFFFFFF0B00000000"),
    hex("DA7ADA7A000000040B00000000"),
    hex("DA7ADA7A000000060B00000000"),
    hex("ABCDABCDFFFFFFFF"),
    hex("ABCDABCD0000000100"),
    hex("ABCDABCD000000020000DA7ADA7A000000050B00000000"),
    hex("ABCDABCD000000020002DA7ADA7A000000050B00000000"),
    hex("ABCDABCD00000003800000DA7ADA7A000000050B00000000"),
    hex("ABCDABCD00000003000101DA7ADA7A000000050B00000000"),
    hex("ABCDABCD000000040002FF00DA7ADA7A000000050B00000000"),
    hex("ABCDABCD000000050003000000DA7ADA7A000000050B00000000"),
    block([11, 0, 0, 0, 1, 1, 0, 0, 0, 1, 3, 0, 0, 0, 0]),
  ];
  for (const bytes of cases)
    await assert.rejects(readCiqSettings(bytes), /CIQ settings/);
  const badReference = SYNTHETIC_SETTINGS.slice();
  new DataView(badReference.buffer).setInt32(214, 1);
  await assert.rejects(readCiqSettings(badReference), /string table reference/);
});

test("rejects unsupported tags, null keys, invalid counts, extra roots and scalar roots", async () => {
  const cases = [
    block([11, 0, 0, 0, 1, 1, 0, 0, 0, 1, 4]),
    block([11, 0, 0, 0, 1, 0, 0]),
    block([11, 255, 255, 255, 255]),
    block([11, 127, 255, 255, 255]),
    block([11, 0, 0, 0, 1]),
    block([11, 0, 0, 0, 0, 11, 0, 0, 0, 0]),
    block([11, 0, 0, 0, 0, 0]),
    block([5, 0, 0, 0, 0]),
    block([1, 0, 0, 0, 1]),
    block([0]),
    // Both child arrays declare children, but their combined claim cannot fit.
    block([11, 0, 0, 0, 1, 5, 0, 0, 0, 2, 5, 0, 0, 0, 2, 0, 0]),
  ];
  for (const bytes of cases)
    await assert.rejects(readCiqSettings(bytes), /CIQ settings/);
});

test("bounds file size and excessive nested containers", async () => {
  await assert.rejects(
    readCiqSettings(new Uint8Array(MAX_CIQ_SETTINGS_BYTES + 1)),
    /1 MiB/,
  );
  const data = [11, 0, 0, 0, 1, 1, 0, 0, 0, 7];
  for (let depth = 0; depth < 66; depth++) data.push(5, 0, 0, 0, 1);
  data.push(0);
  await assert.rejects(readCiqSettings(block(data)), /64 levels/);
});

test("supports cooperative cancellation before parsing and during string/token work", async () => {
  const controller = new AbortController();
  controller.abort();
  const job: Job = {
    signal: controller.signal,
    progress: () => {},
    yield: async () => {},
  };
  await assert.rejects(readCiqSettings(SYNTHETIC_SETTINGS, job), {
    name: "AbortError",
  });

  const pending = new AbortController();
  let yields = 0;
  const data = [11, 0, 0, 0, 1, 1, 0, 0, 0, 7, 5, 0, 0, 8, 0];
  data.push(...new Array<number>(2048).fill(0));
  await assert.rejects(
    readCiqSettings(block(data), {
      signal: pending.signal,
      progress: () => {},
      yield: async () => {
        yields++;
        pending.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(yields, 1);

  const duringStrings = new AbortController();
  const strings = new Uint8Array(8 + 256 * 3 + 13);
  const view = new DataView(strings.buffer);
  view.setUint32(0, 0xabcdabcd);
  view.setInt32(4, 256 * 3);
  for (let index = 0; index < 256; index++) view.setInt16(8 + index * 3, 1);
  strings.set(hex("DA7ADA7A000000050B00000000"), 8 + 256 * 3);
  await assert.rejects(
    readCiqSettings(strings, {
      signal: duringStrings.signal,
      progress: () => {},
      yield: async () => {
        duringStrings.abort();
      },
    }),
    { name: "AbortError" },
  );
});
