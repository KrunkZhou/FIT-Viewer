import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../src/model";
import {
  MAX_OUT_BIN_BYTES,
  MAX_OUT_BIN_ENTRIES,
  MAX_OUT_BIN_FIELDS,
  readOutBin,
} from "../src/protocol/out-bin";
import {
  OUT_BIN_APP_ID,
  OUT_BIN_WIDGET_ID,
  appField,
  appFields,
  bytesField,
  concatBytes,
  encodeVarint,
  fixtureId,
  numberField,
  outBinFixture,
  textField,
  wrapInventory,
} from "./out-bin-fixtures";

const hex = (value: string): Uint8Array =>
  Uint8Array.from(Buffer.from(value, "hex"));
const withAppFields = (fields: Uint8Array): Uint8Array =>
  wrapInventory(bytesField(3, fields));

test("decodes the Clover-compatible mixed OUT.BIN inventory without changing input", async () => {
  const bytes = outBinFixture();
  const original = bytes.slice();
  const result = await readOutBin(bytes);
  assert.equal(result.metadata, 9_876_543_210n);
  assert.equal(result.status, 17);
  assert.deepEqual(
    result.entries.map(({ appIdHex, appType }) => [appIdHex, appType]),
    [
      [OUT_BIN_APP_ID, 1],
      [OUT_BIN_WIDGET_ID, 2],
      ["c0ffee15600d00000000000000020033", 2],
      [OUT_BIN_WIDGET_ID, 3],
      ["ffeeddccbbaa99887766554433221100", 99],
    ],
  );
  assert.deepEqual(result.entries[0], {
    appId: "00112233-4455-6677-8899-aabbccddeeff",
    appIdHex: OUT_BIN_APP_ID,
    appType: 1,
    name: "Regression recorder",
    disabled: false,
    favorite: true,
    version: 42,
    filename: "REGRESSION.PRG",
    fileSize: 1_234_567_890_123n,
    unknownFields: [],
  });
  assert.equal(result.entries[1].favorite, false);
  assert.equal(result.entries[1].nativeType, 46);
  assert.equal(result.entries[2].disabled, true);
  assert.equal(result.entries[2].favorite, undefined);
  assert.equal(result.entries[3].appId, result.entries[1].appId);
  assert.deepEqual(result.unknownFields, {
    root: [],
    service: [],
    inventory: [],
  });
  assert.deepEqual(structuredClone(result), result);
  assert.deepEqual(bytes, original);
});

test("allows an empty inventory and distinguishes absent metadata from explicit zero", async () => {
  const result = await readOutBin(wrapInventory(new Uint8Array(), 0n, 0));
  assert.equal(result.metadata, 0n);
  assert.equal(result.status, 0);
  assert.deepEqual(result.entries, []);
  const entry = await readOutBin(
    withAppFields(appFields(OUT_BIN_APP_ID, 0, "", false)),
  );
  assert.equal(entry.entries[0].name, "");
  assert.equal(entry.entries[0].appType, 0);
  assert.equal(entry.entries[0].filename, undefined);
  assert.equal(entry.entries[0].favorite, undefined);
});

test("retains uint64 metadata and file sizes without loss of precision", async () => {
  const value = 0xffff_ffff_ffff_ffffn;
  const bytes = wrapInventory(
    bytesField(3, concatBytes(appFields(), numberField(7, value))),
    value,
    0xffff_ffff,
  );
  const result = await readOutBin(bytes);
  assert.equal(result.metadata, value);
  assert.equal(result.status, 0xffff_ffff);
  assert.equal(result.entries[0].fileSize, value);
  assert.equal(String(result.entries[0].fileSize), "18446744073709551615");
});

test("preserves repeated unknown protobuf fields at all levels and isolates their bytes", async () => {
  const fixed64 = concatBytes(
    encodeVarint((13n << 3n) | 1n),
    hex("0102030405060708"),
  );
  const fixed32 = concatBytes(encodeVarint((14n << 3n) | 5n), hex("090a0b0c"));
  const unknown = concatBytes(
    numberField(11, 0xffff_ffff_ffff_ffffn),
    bytesField(12, hex("00ff")),
    fixed64,
    fixed32,
    numberField(11, 2),
  );
  const app = bytesField(3, concatBytes(appFields(), unknown));
  const body = concatBytes(numberField(1, 1), numberField(2, 2), app, unknown);
  const bytes = concatBytes(
    bytesField(3, concatBytes(bytesField(2, body), unknown)),
    unknown,
  );
  const result = await readOutBin(bytes);
  const expected = [
    { number: 11, wireType: 0, value: 0xffff_ffff_ffff_ffffn },
    { number: 12, wireType: 2, bytes: hex("00ff") },
    { number: 13, wireType: 1, bytes: hex("0102030405060708") },
    { number: 14, wireType: 5, bytes: hex("090a0b0c") },
    { number: 11, wireType: 0, value: 2n },
  ];
  assert.deepEqual(result.unknownFields.root, expected);
  assert.deepEqual(result.unknownFields.service, expected);
  assert.deepEqual(result.unknownFields.inventory, expected);
  assert.deepEqual(result.entries[0].unknownFields, expected);
  bytes.fill(0);
  assert.deepEqual(result.unknownFields.root, expected);
  assert.deepEqual(result.entries[0].unknownFields, expected);
});

test("reads UTF-8 and leading BOM characters from typed array slices", async () => {
  const bytes = withAppFields(
    concatBytes(
      bytesField(1, fixtureId(OUT_BIN_APP_ID)),
      numberField(2, 1),
      textField(3, "\uFEFF冬😀"),
      numberField(4, 0),
      textField(6, "__proto__.PRG"),
    ),
  );
  const storage = new Uint8Array(bytes.length + 20).fill(99);
  storage.set(bytes, 9);
  const result = await readOutBin(storage.subarray(9, 9 + bytes.length));
  assert.equal(result.entries[0].name, "\uFEFF冬😀");
  assert.equal(result.entries[0].filename, "__proto__.PRG");
});

test("rejects every truncated prefix of an OUT.BIN inventory", async () => {
  const bytes = outBinFixture();
  for (let length = 0; length < bytes.length; length++)
    await assert.rejects(readOutBin(bytes.subarray(0, length)), /OUT\.BIN/);
});

test("rejects missing, duplicate, mistyped and input-schema wrappers", async () => {
  const body = concatBytes(numberField(1, 1), numberField(2, 2));
  const validService = bytesField(2, body);
  for (const bytes of [
    numberField(1, 1),
    numberField(3, 1),
    concatBytes(bytesField(3, validService), bytesField(3, validService)),
    bytesField(3, new Uint8Array()),
    bytesField(3, numberField(2, 1)),
    bytesField(3, concatBytes(validService, validService)),
    bytesField(3, bytesField(5, new Uint8Array())),
    bytesField(3, concatBytes(validService, bytesField(5, new Uint8Array()))),
    bytesField(3, bytesField(2, numberField(1, 1))),
    bytesField(3, bytesField(2, numberField(2, 2))),
    bytesField(3, bytesField(2, concatBytes(body, numberField(1, 1)))),
    bytesField(3, bytesField(2, concatBytes(body, numberField(2, 2)))),
    bytesField(
      3,
      bytesField(
        2,
        concatBytes(bytesField(1, new Uint8Array()), numberField(2, 2)),
      ),
    ),
    bytesField(
      3,
      bytesField(
        2,
        concatBytes(numberField(1, 1), bytesField(2, new Uint8Array())),
      ),
    ),
    wrapInventory(numberField(3, 1)),
  ])
    await assert.rejects(readOutBin(bytes), /OUT\.BIN/);
});

test("rejects malformed protobuf tags, payloads and overflowing varints", async () => {
  for (const bytes of [
    hex("00"),
    hex("1a80"),
    hex("1b1c"),
    hex("1d00"),
    hex("1a01"),
    hex("1a01ff"),
    hex("1a03ffffff"),
    hex("1a00ff"),
    hex("1affffffffffffffffff02"),
    hex("1affffffffffffffffff01"),
    concatBytes(encodeVarint(536_870_912n << 3n), encodeVarint(1)),
    hex("098080808080808080"),
    hex("15808080"),
  ])
    await assert.rejects(readOutBin(bytes), /OUT\.BIN/);
  await assert.rejects(
    readOutBin(wrapInventory(new Uint8Array(), 1n << 64n)),
    /Overflowing/,
  );
});

test("validates all known app fields and rejects duplicate identity/type pairs", async () => {
  const fields = [
    bytesField(1, fixtureId(OUT_BIN_APP_ID)),
    numberField(2, 1),
    textField(3, "Name"),
    numberField(4, 0),
    numberField(5, 42),
    textField(6, "APP.PRG"),
    numberField(7, 1234),
    numberField(8, 1),
    numberField(9, 0),
  ];
  for (let number = 1; number <= 9; number++) {
    await assert.rejects(
      readOutBin(withAppFields(concatBytes(...fields, fields[number - 1]))),
      /duplicate/,
    );
    const wrongWire = [1, 3, 6].includes(number)
      ? numberField(number, 0)
      : bytesField(number, new Uint8Array());
    await assert.rejects(
      readOutBin(
        withAppFields(
          concatBytes(
            ...fields.filter((_, index) => index !== number - 1),
            wrongWire,
          ),
        ),
      ),
      /mistyped/,
    );
    if (number <= 4)
      await assert.rejects(
        readOutBin(
          withAppFields(
            concatBytes(...fields.filter((_, index) => index !== number - 1)),
          ),
        ),
        /Missing/,
      );
  }
  for (const bytes of [
    withAppFields(
      concatBytes(
        bytesField(1, fixtureId(OUT_BIN_APP_ID.slice(0, 30))),
        ...fields.slice(1),
      ),
    ),
    withAppFields(concatBytes(...fields.slice(0, 3), numberField(4, 2))),
    withAppFields(concatBytes(appFields(), numberField(9, 2))),
    withAppFields(
      concatBytes(fields[0], fields[1], bytesField(3, hex("ff")), fields[3]),
    ),
    withAppFields(concatBytes(appFields(), bytesField(6, hex("c080")))),
    wrapInventory(concatBytes(appField(), appField())),
  ])
    await assert.rejects(readOutBin(bytes), /OUT\.BIN/);
  for (const number of [2, 5, 8]) {
    const bytes = concatBytes(
      ...fields.filter((_, index) => index !== number - 1),
      numberField(number, 0x1_0000_0000n),
    );
    await assert.rejects(readOutBin(withAppFields(bytes)), /uint32/);
  }
  await assert.rejects(
    readOutBin(wrapInventory(new Uint8Array(), 1n, 0x1_0000_0000)),
    /uint32/,
  );
});

test("enforces file, entry and protobuf field budgets", async () => {
  await assert.rejects(
    readOutBin(new Uint8Array(MAX_OUT_BIN_BYTES + 1)),
    /16 MiB/,
  );
  const entries = Array.from({ length: MAX_OUT_BIN_ENTRIES + 1 }, (_, index) =>
    bytesField(3, appFields(index.toString(16).padStart(32, "0"))),
  );
  await assert.rejects(
    readOutBin(wrapInventory(concatBytes(...entries))),
    /10,000/,
  );
  const field = numberField(11, 1);
  const fields = new Uint8Array(field.length * MAX_OUT_BIN_FIELDS);
  for (let index = 0; index < MAX_OUT_BIN_FIELDS; index++)
    fields.set(field, index * field.length);
  await assert.rejects(
    readOutBin(concatBytes(wrapInventory(new Uint8Array()), fields)),
    /100,000/,
  );
});

test("supports cancellation before parsing and while decoding large messages", async () => {
  const controller = new AbortController();
  controller.abort();
  const canceled: Job = {
    signal: controller.signal,
    progress: () => {},
    yield: async () => {},
  };
  await assert.rejects(readOutBin(outBinFixture(), canceled), {
    name: "AbortError",
  });

  const duringParse = new AbortController();
  let yields = 0;
  const fields = concatBytes(
    ...Array.from({ length: 300 }, () => numberField(11, 1)),
  );
  await assert.rejects(
    readOutBin(concatBytes(wrapInventory(new Uint8Array()), fields), {
      signal: duringParse.signal,
      progress: () => {},
      yield: async () => {
        yields++;
        duringParse.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(yields, 1);
});
