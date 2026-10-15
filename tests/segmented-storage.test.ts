import assert from "node:assert/strict";
import test from "node:test";
import { ByteStore } from "../src/protocol/byte-store";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { repair } from "../src/repair/repair";
import { syntheticSettings } from "./ciq-fixtures";
import { activity, file } from "./fixtures";

test("segmented storage preserves buffer identity and translates cross-source ranges", () => {
  const a = Uint8Array.of(99, 1, 2, 3, 88).subarray(1, 4);
  const b = Uint8Array.of(4, 5);
  const store = new ByteStore([a, new Uint8Array(), b]);
  assert.equal(store.length, 5);
  assert.equal(store.subarray(0, 3).buffer, a.buffer);
  assert.equal(store.subarray(3).buffer, b.buffer);
  assert.deepEqual([...store.subarray(1, 4)], [2, 3, 4]);
  assert.deepEqual([...store.subarray(-2)], [4, 5]);
  assert.equal(store.segment(4).view.getUint8(1), 5);
  assert.equal(store.segment(0).view.getUint8(0), 1);
  assert.throws(() => store.segment(5), RangeError);
  assert.deepEqual([...store.subarray(5)], []);
});

test("mixed workspaces keep original buffers, raw values, settings and repaired records", async () => {
  const sources = [
    { filename: "a.fit", bytes: activity(10) },
    { filename: "settings.SET", bytes: syntheticSettings() },
    {
      filename: "b.fit",
      bytes: file(
        [
          {
            message: 600,
            little: false,
            fields: [
              [1, 15, 18446744073709551614n],
              [2, 4, [1, 65535, 3]],
            ],
          },
        ],
        false,
      ),
    },
  ];
  const before = sources.map((s) => s.bytes.slice());
  const workspace = await FitDocument.openSources(sources, "folder");
  for (const source of workspace.sources) {
    assert.equal(
      workspace.index.bytes.subarray(source.start, source.end).buffer,
      sources[source.id].bytes.buffer,
    );
    if (source.filename.endsWith(".SET")) {
      const exported = await exportDocument(workspace, {
        format: "set",
        settings: { source: source.id, edits: [] },
      });
      assert.deepEqual(
        new Uint8Array(await exported.blob.arrayBuffer()),
        before[source.id],
      );
      continue;
    }
    const single = await FitDocument.open(
      sources[source.id].bytes,
      source.filename,
    );
    const ids = workspace.index.records.flatMap((record, id) =>
      workspace.index.subfiles[record.subfile].source === source.id ? [id] : [],
    );
    ids.forEach((id, i) =>
      assert.deepEqual(workspace.cells(id), single.cells(i)),
    );
  }
  const fixed = await repair(workspace);
  const reopened = await FitDocument.open(fixed.bytes, "fixed.fit");
  const id = reopened.index.messages.get(600)![0];
  assert.deepEqual(reopened.raw(id), {
    "1": 18446744073709551614n,
    "2": [1, 65535, 3],
  });
  sources.forEach((source, i) => assert.deepEqual(source.bytes, before[i]));
});
