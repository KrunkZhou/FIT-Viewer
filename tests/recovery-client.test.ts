import test from "node:test";
import assert from "node:assert/strict";
import { CrcCalculator, Decoder, Stream } from "@garmin/fitsdk";
import { FitDocument } from "../src/document/document";
import { DocumentClient } from "../src/document/client";
import { Downloads } from "../src/ui/download";
import {
  addSummaryDiagnostics,
  repair,
  summaryCandidates,
} from "../src/repair/repair";
import { createJob } from "../src/document/jobs";
import { definition, data, join, file, activity, type Field } from "./fixtures";
import { wrapBody } from "../src/protocol/writer";

test("multiple indexed laps recover a session with the official lap sport field", async () => {
  const t = 1000000000;
  const input = file(
    [
      { message: 0, fields: [[0, 0, 4]] },
      ...[0, 1, 2, 3].map((i) => ({
        message: 20,
        fields: [
          [253, 6, t + i],
          [5, 6, i * 100],
        ] as Field[],
      })),
      {
        message: 19,
        fields: [
          [254, 4, 3],
          [2, 6, t],
          [253, 6, t + 1],
          [25, 0, 1],
        ],
      },
      {
        message: 19,
        fields: [
          [254, 4, 4],
          [2, 6, t + 2],
          [253, 6, t + 3],
          [25, 0, 1],
        ],
      },
    ],
    false,
  );
  const document = await FitDocument.open(input, "laps.fit");
  const candidates = await summaryCandidates(document, 0);
  assert.deepEqual(
    candidates.map((c) => c.message),
    [18, 34],
  );
  assert.equal(candidates[0].values.sport, 1);
  assert.equal(candidates[0].values.firstLapIndex, 3);
  assert.equal(candidates[0].values.numLaps, 2);
  const result = await repair(document);
  assert.equal(
    CrcCalculator.calculateCRC(result.bytes, 0, result.bytes.length),
    0,
  );
  const oracle = new Decoder(Stream.fromByteArray(result.bytes)).read();
  assert.equal(oracle.errors.length, 0);
  assert.ok(oracle.messages.sessionMesgs);
  assert.equal(oracle.messages.sessionMesgs[0].sport, "running");
  assert.equal(oracle.messages.sessionMesgs[0].numLaps, 2);
  assert.deepEqual(
    result.bytes.slice(14, input.length - 2),
    input.slice(14, -2),
  );
});

test("ambiguous laps and absent evidence remain explicit unresolved omissions", async () => {
  const document = await FitDocument.open(
    file([{ message: 0, fields: [[0, 0, 4]] }], false),
    "empty.fit",
  );
  await addSummaryDiagnostics(document);
  assert.equal(document.summary().diagnosticCount, 3);
  assert.ok(document.index.diagnostics.every((d) => d.repair === "none"));
  assert.equal(document.summary().repairable, false);
});

test("warnings are bounded in the UI summary and never delete duplicate readings", async () => {
  const fields: Field[] = [
    [253, 6, 1000000000],
    [3, 2, 0],
  ];
  const bytes = wrapBody(
    join([
      definition(20, fields),
      ...Array.from({ length: 250 }, () => data(fields)),
    ]),
  );
  const document = await FitDocument.open(bytes, "duplicates.fit");
  assert.equal(document.summary().diagnosticCount, 249);
  assert.equal(document.summary().diagnostics.length, 50);
  const output = await repair(document);
  assert.deepEqual(output.bytes, bytes);
});

test("CRC generation and verification can be cancelled without mutating input", async () => {
  const bytes = activity(10000);
  const before = bytes.slice();
  const document = await FitDocument.open(bytes, "large.fit");
  const controller = new AbortController();
  let turns = 0;
  const job = createJob(controller.signal, () => {});
  const yieldJob = {
    ...job,
    yield: async () => {
      if (++turns > 5) controller.abort();
      await job.yield();
    },
  };
  await assert.rejects(repair(document, yieldJob), { name: "AbortError" });
  assert.deepEqual(bytes, before);
});

test("client replacement rejects old queries, ignores stale results and terminates owned workers", async () => {
  const original = globalThis.Worker;
  class FakeWorker {
    static all: FakeWorker[] = [];
    onmessage?: (event: { data: unknown }) => void;
    onerror?: () => void;
    sent: any[] = [];
    terminated = false;
    constructor() {
      FakeWorker.all.push(this);
    }
    postMessage(message: unknown) {
      this.sent.push(message);
    }
    terminate() {
      this.terminated = true;
    }
    respond(index: number, result: unknown) {
      const request = this.sent[index];
      this.onmessage?.({
        data: {
          kind: "result",
          result,
          requestId: request.requestId,
          documentId: request.documentId,
        },
      });
    }
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  try {
    const client = new DocumentClient();
    const blob = new File([], "test.fit");
    const first = client.open(blob);
    const rejected = assert.rejects(first, { name: "AbortError" });
    const next = client.open(blob);
    await rejected;
    assert.equal(FakeWorker.all[0].terminated, true);
    FakeWorker.all[0].respond(0, { filename: "stale" });
    FakeWorker.all[0].onerror?.();
    assert.equal(FakeWorker.all[1].terminated, false);
    FakeWorker.all[1].respond(0, { filename: "current" });
    assert.equal(((await next) as any).filename, "current");
    const controller = new AbortController();
    const query = client.request({ kind: "map" }, controller.signal);
    const aborted = assert.rejects(query, { name: "AbortError" });
    controller.abort();
    await aborted;
    assert.equal(FakeWorker.all[1].sent.at(-1).kind, "cancel");
    const pending = client.request({ kind: "map" });
    const disposed = assert.rejects(pending, { name: "AbortError" });
    client.destroy();
    await disposed;
    assert.equal(FakeWorker.all[1].terminated, true);
  } finally {
    globalThis.Worker = original;
  }
});

test("download resources are released on document replacement and failure", () => {
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const revoked: string[] = [];
  let count = 0;
  let fail = false;
  globalThis.document = {
    body: { append() {} },
    createElement: () => ({
      href: "",
      download: "",
      click() {
        if (fail) throw new Error("blocked");
      },
      remove() {},
    }),
  } as unknown as Document;
  URL.createObjectURL = () => `blob:test-${++count}`;
  URL.revokeObjectURL = (url) => {
    revoked.push(url);
  };
  try {
    const downloads = new Downloads();
    downloads.save({ blob: new Blob(["test"]), filename: "test.csv" });
    downloads.clear();
    assert.deepEqual(revoked, ["blob:test-1"]);
    fail = true;
    assert.throws(() =>
      downloads.save({ blob: new Blob(), filename: "fail.csv" }),
    );
    assert.deepEqual(revoked, ["blob:test-1", "blob:test-2"]);
    downloads.clear();
    assert.equal(revoked.length, 2);
  } finally {
    globalThis.document = originalDocument;
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
  }
});

test("worker startup failures reject cleanly without creating a pending job", async () => {
  const original = globalThis.Worker;
  globalThis.Worker = class {
    constructor() {
      throw new Error("Worker unavailable");
    }
  } as unknown as typeof Worker;
  try {
    const client = new DocumentClient();
    await assert.rejects(
      client.open(new File([], "test.fit")),
      /Worker unavailable/,
    );
    client.destroy();
  } finally {
    globalThis.Worker = original;
  }
});

test("summary omissions are tracked independently in concatenated activity files", async () => {
  const first = file(
    [
      { message: 0, fields: [[0, 0, 4]] },
      { message: 18, fields: [[5, 0, 1]] },
    ],
    false,
  );
  const second = file([{ message: 0, fields: [[0, 0, 4]] }], false);
  const document = await FitDocument.open(
    join([first, second]),
    "multiple.fit",
  );
  await addSummaryDiagnostics(document);
  assert.ok(
    document.index.diagnostics.some(
      (d) => d.subfile === 1 && d.id === "summary:1:19",
    ),
  );
  const output = await repair(document);
  assert.ok(
    output.unresolved.some((message) =>
      message.startsWith("Lap summary is missing"),
    ),
  );
});

test("recovery restarts only at a complete CRC-verified subfile", async () => {
  const fields: Field[] = [
    [253, 6, 1000000000],
    [3, 2, 120],
  ];
  const broken = wrapBody(
    join([definition(20, fields), data(fields), Uint8Array.of(31, 255, 255)]),
  );
  const fake = file(
    [
      {
        message: 20,
        fields: [
          [253, 6, 1000000010],
          [3, 2, 121],
        ],
      },
    ],
    false,
  );
  fake[fake.length - 1] ^= 1;
  const good = file(
    [
      {
        message: 20,
        fields: [
          [253, 6, 1000000020],
          [3, 2, 122],
        ],
      },
    ],
    false,
  );
  const document = await FitDocument.open(
    join([broken, fake, good]),
    "recovery.fit",
  );
  assert.equal(document.index.subfiles.length, 2);
  assert.deepEqual(
    document.index.records.map((_, id) => document.raw(id)["3"]),
    [120, 122],
  );
  const result = await repair(document);
  assert.equal(result.partial, true);
  const reopened = await FitDocument.open(result.bytes, "recovered.fit");
  assert.equal(reopened.index.diagnostics.length, 0);
  assert.deepEqual(
    reopened.index.records.map((_, id) => reopened.raw(id)["3"]),
    [120, 122],
  );
});

test("a missing checksum alone is not reported as partial data recovery", async () => {
  const complete = file(
    [
      {
        message: 20,
        fields: [
          [253, 6, 1000000000],
          [3, 2, 120],
        ],
      },
    ],
    false,
  );
  const document = await FitDocument.open(
    complete.slice(0, -2),
    "crc-missing.fit",
  );
  const result = await repair(document);
  assert.equal(result.partial, false);
  assert.deepEqual(result.bytes, complete);
});
