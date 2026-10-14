import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import {
  applyCiqEdits,
  ciqScalarText,
  parseCiqInput,
} from "../src/protocol/ciq-edit";
import {
  readCiqSettings,
  type CiqDictionary,
  type CiqScalar,
} from "../src/protocol/ciq-settings";
import { writeCiqSettings } from "../src/protocol/ciq-write";
import { idleJob } from "../src/protocol/reader";
import { activity } from "./fixtures";
import { SDK_TYPED_SETTINGS, SYNTHETIC_SETTINGS } from "./ciq-fixtures";

test("SET encoder matches the SDK fixtures byte for byte and keeps typed nested values", async () => {
  for (const bytes of [SDK_TYPED_SETTINGS, SYNTHETIC_SETTINGS]) {
    const settings = await readCiqSettings(bytes);
    const encoded = await writeCiqSettings(settings);
    assert.deepEqual(encoded, bytes);
    assert.deepEqual(await readCiqSettings(encoded), settings);
  }
  assert.deepEqual(
    await writeCiqSettings({ type: "dictionary", entries: [] }),
    Uint8Array.from(Buffer.from("DA7ADA7A000000050B00000000", "hex")),
  );
});

test("SET encoder preserves empty, multiline and Unicode strings, typed keys and all scalar types", async () => {
  const values: CiqScalar[] = [
    { type: "string", value: "" },
    { type: "string", value: '\uFEFFline\n"quoted" \u51ac\u{1f600}' },
    { type: "integer", value: -2147483648 },
    { type: "long", value: -9223372036854775808n },
    { type: "float", value: -0 },
    { type: "float", value: Infinity },
    { type: "double", value: NaN },
    { type: "boolean", value: false },
    { type: "null", value: null },
  ];
  const settings: CiqDictionary = {
    type: "dictionary",
    entries: values.map((value, index) => ({
      key: { type: "integer", value: index },
      value,
    })),
  };
  const bytes = await writeCiqSettings(settings);
  assert.deepEqual(await readCiqSettings(bytes), settings);
});

test("value input parsing preserves scalar types, exact long precision and float rounding", () => {
  assert.deepEqual(
    parseCiqInput({ type: "string", value: "old" }, 'new\n"text"'),
    { type: "string", value: 'new\n"text"' },
  );
  assert.deepEqual(parseCiqInput({ type: "boolean", value: false }, "true"), {
    type: "boolean",
    value: true,
  });
  assert.deepEqual(
    parseCiqInput({ type: "integer", value: 1 }, "-2147483648"),
    { type: "integer", value: -2147483648 },
  );
  assert.deepEqual(
    parseCiqInput({ type: "long", value: 0n }, "9223372036854775807"),
    { type: "long", value: 9223372036854775807n },
  );
  assert.deepEqual(parseCiqInput({ type: "float", value: 0 }, "1.1"), {
    type: "float",
    value: Math.fround(1.1),
  });
  assert.deepEqual(parseCiqInput({ type: "double", value: 0 }, "-1.25e3"), {
    type: "double",
    value: -1250,
  });
  assert.equal(ciqScalarText({ type: "double", value: -0 }), "-0");
  const cases: [CiqScalar, string][] = [
    [{ type: "integer", value: 0 }, "2147483648"],
    [{ type: "integer", value: 0 }, "1.5"],
    [{ type: "long", value: 0n }, "9223372036854775808"],
    [{ type: "long", value: 0n }, "-9223372036854775809"],
    [{ type: "float", value: 0 }, "1e39"],
    [{ type: "double", value: 0 }, "Infinity"],
    [{ type: "double", value: 0 }, ""],
    [{ type: "boolean", value: false }, "1"],
    [{ type: "string", value: "" }, "embedded\0null"],
    [{ type: "string", value: "" }, "\ud800"],
    [{ type: "string", value: "" }, "x".repeat(32767)],
  ];
  for (const [value, text] of cases)
    assert.throws(() => parseCiqInput(value, text));
});

test("edits use source indexes rather than sorted display positions and leave originals untouched", async () => {
  const original = await readCiqSettings(SDK_TYPED_SETTINGS);
  const before = structuredClone(original);
  const edited = applyCiqEdits(original, [
    { path: [0, 1, 0], value: { type: "string", value: "nested edit" } },
    { path: [0, 2, 1], value: { type: "integer", value: 77 } },
    { path: [2], value: { type: "long", value: -9223372036854775808n } },
    { path: [5, 0], value: { type: "integer", value: 19 } },
  ]);
  assert.deepEqual(original, before);
  assert.equal(edited.entries[2].key, original.entries[2].key);
  assert.deepEqual(edited.entries[2].value, {
    type: "long",
    value: -9223372036854775808n,
  });
  assert.deepEqual(
    await readCiqSettings(await writeCiqSettings(edited)),
    edited,
  );
  assert.equal(applyCiqEdits(original, []), original);
  assert.equal(edited.entries[1], original.entries[1]);
  const invalid = [
    { path: [], value: { type: "string", value: "bad" } },
    { path: [-1], value: { type: "string", value: "bad" } },
    { path: [99], value: { type: "string", value: "bad" } },
    { path: [2], value: { type: "integer", value: 1 } },
    { path: [0], value: { type: "string", value: "bad" } },
    { path: [1, 0], value: { type: "integer", value: 1 } },
  ] as const;
  for (const edit of invalid)
    assert.throws(() =>
      applyCiqEdits(original, [{ path: [...edit.path], value: edit.value }]),
    );
  assert.deepEqual(original, before);
});

test("SET downloads export only the selected source and do not modify loaded or mixed files", async () => {
  const original = SYNTHETIC_SETTINGS.slice();
  const document = await FitDocument.openSources(
    [
      { filename: "activity.fit", bytes: activity(20) },
      { filename: "folder/example.SET", bytes: original },
      { filename: "other.SET", bytes: SDK_TYPED_SETTINGS.slice() },
    ],
    "three files",
  );
  const download = await exportDocument(document, {
    format: "set",
    settings: {
      source: 1,
      edits: [{ path: [2], value: { type: "string", value: "edited-value" } }],
    },
  });
  assert.equal(download.filename, "example.SET");
  assert.equal(download.blob.type, "application/octet-stream");
  const decoded = await readCiqSettings(
    new Uint8Array(await download.blob.arrayBuffer()),
  );
  assert.deepEqual(decoded.entries[2].value, {
    type: "string",
    value: "edited-value",
  });
  assert.deepEqual(
    document.ciqSettings[0].settings,
    await readCiqSettings(original),
  );
  assert.deepEqual(original, SYNTHETIC_SETTINGS);
  for (const [source, expected] of [
    [1, SYNTHETIC_SETTINGS],
    [2, SDK_TYPED_SETTINGS],
  ] as const) {
    const unchanged = await exportDocument(document, {
      format: "set",
      settings: { source, edits: [] },
    });
    assert.deepEqual(
      new Uint8Array(await unchanged.blob.arrayBuffer()),
      expected,
    );
  }
  await assert.rejects(
    exportDocument(document, {
      format: "set",
      settings: { source: 0, edits: [] },
    }),
    /unavailable/,
  );
  await assert.rejects(
    exportDocument(document, { format: "set" }),
    /unavailable/,
  );
});

test("SET encoding rejects invalid values, cyclic nesting, oversize output and cancellation", async () => {
  const root = (value: CiqScalar): CiqDictionary => ({
    type: "dictionary",
    entries: [{ key: { type: "integer", value: 1 }, value }],
  });
  await assert.rejects(
    writeCiqSettings(root({ type: "long", value: 1n << 63n })),
    /64-bit/,
  );
  await assert.rejects(
    writeCiqSettings(root({ type: "string", value: "bad\0value" })),
    /null/,
  );
  const cyclic: CiqDictionary = { type: "dictionary", entries: [] };
  cyclic.entries.push({ key: { type: "integer", value: 1 }, value: cyclic });
  await assert.rejects(writeCiqSettings(cyclic), /64 levels/);
  const large: CiqDictionary = {
    type: "dictionary",
    entries: Array.from({ length: 40 }, (_, index) => ({
      key: { type: "integer", value: index },
      value: { type: "string", value: `${index}${"x".repeat(30000)}` },
    })),
  };
  await assert.rejects(writeCiqSettings(large), /1 MiB/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    writeCiqSettings(root({ type: "integer", value: 1 }), {
      ...idleJob(),
      signal: controller.signal,
    }),
    { name: "AbortError" },
  );
  const running = new AbortController();
  const many: CiqDictionary = {
    type: "dictionary",
    entries: Array.from({ length: 1024 }, (_, value) => ({
      key: { type: "integer", value },
      value: { type: "integer", value },
    })),
  };
  await assert.rejects(
    writeCiqSettings(many, {
      ...idleJob(),
      signal: running.signal,
      yield: async () => running.abort(),
    }),
    { name: "AbortError" },
  );
});
