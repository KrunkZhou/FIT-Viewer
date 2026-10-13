import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  DESKTOP_IMPORT_LIMIT_BYTES,
  WEB_IMPORT_LIMIT_BYTES,
  importLimitBytes,
} from "../src/document/input";
import { FileAccess } from "../electron/file-access";
import { collectDrop } from "../src/ui/file-drop";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { DocumentClient } from "../src/document/client";
import type { WorkerRequest } from "../src/model";

// Exercise byte-count boundaries without allocating gigabytes of sample data.
function sizedFile(name: string, size: number): File {
  const file = new File([], name);
  Object.defineProperty(file, "size", { value: size });
  return file;
}

test("desktop imports allow 2 GiB while browser limits remain independently configurable", () => {
  assert.equal(importLimitBytes(true), 2 * 1024 ** 3);
  assert.equal(importLimitBytes(false), 512 * 1024 ** 2);
  assert.equal(importLimitBytes(true, "512"), DESKTOP_IMPORT_LIMIT_BYTES);
  assert.equal(importLimitBytes(true, "8192"), DESKTOP_IMPORT_LIMIT_BYTES);
  assert.equal(importLimitBytes(false, "128"), 128 * 1048576);
  assert.equal(importLimitBytes(false, "1024"), 1024 * 1048576);
  for (const value of [undefined, "", "invalid", "0", "-1", "Infinity", "1e20"])
    assert.equal(importLimitBytes(false, value), WEB_IMPORT_LIMIT_BYTES);
});

test("folder picker and directory drops share the larger desktop aggregate limit", async () => {
  for (const directoryDrop of [false, true]) {
    const makeDrop = (excess = 0) => {
      const files = [
        sizedFile("a.fit", DESKTOP_IMPORT_LIMIT_BYTES / 2),
        sizedFile("b.fit", DESKTOP_IMPORT_LIMIT_BYTES / 2 + excess),
      ];
      for (const file of files)
        Object.defineProperty(file, "webkitRelativePath", {
          value: `Activity/${file.name}`,
        });
      if (!directoryDrop) return { entries: [], files };
      const root = {
        name: "Activity",
        isDirectory: true,
        isFile: false,
        createReader() {
          let first = true;
          return {
            readEntries(done: (entries: FileSystemEntry[]) => void) {
              const entries = first
                ? files.map((file) => ({
                    name: file.name,
                    isDirectory: false,
                    isFile: true,
                    file: (done: (file: File) => void) => done(file),
                  }))
                : [];
              first = false;
              done(entries as unknown as FileSystemEntry[]);
            },
          };
        },
      } as unknown as FileSystemEntry;
      return { entries: [root], files: [] };
    };
    const signal = new AbortController().signal;
    const selected = await collectDrop(
      makeDrop(),
      signal,
      importLimitBytes(true),
      () => {},
    );
    assert.equal(selected.name, "Activity");
    assert.deepEqual(
      selected.files.map((file) => file.name),
      ["Activity/a.fit", "Activity/b.fit"],
    );
    await assert.rejects(
      collectDrop(makeDrop(), signal, importLimitBytes(false), () => {}),
      /size limit \(512 MiB\)/,
    );
    await assert.rejects(
      collectDrop(makeDrop(1), signal, importLimitBytes(true), () => {}),
      /size limit \(2048 MiB\)/,
    );
  }
});

test("worker input preflight accepts desktop totals beyond the browser cap but rejects over 2 GiB before reading", async () => {
  let reads = 0;
  const reading = new Error("Reached file reading");
  const input = (excess = 0) => ({
    name: "Activity",
    files: [
      sizedFile("a.fit", DESKTOP_IMPORT_LIMIT_BYTES / 2),
      sizedFile("b.fit", DESKTOP_IMPORT_LIMIT_BYTES / 2 + excess),
    ].map((file) => {
      Object.defineProperty(file, "arrayBuffer", {
        value: async () => {
          reads++;
          throw reading;
        },
      });
      return file;
    }),
  });
  const job = createJob(new AbortController().signal);
  await assert.rejects(
    loadFile(input(), importLimitBytes(false), job),
    /512 MiB limit/,
  );
  assert.equal(reads, 0);
  await assert.rejects(
    loadFile(input(), importLimitBytes(true), job),
    (error) => error === reading,
  );
  assert.equal(reads, 1);
  await assert.rejects(
    loadFile(input(1), importLimitBytes(true), job),
    /2048 MiB limit/,
  );
  assert.equal(reads, 1);
});

test("desktop host grants sparse selections up to 2 GiB and rejects a one-byte excess", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fitviewer-size-limit-"));
  const access = new FileAccess();
  try {
    const paths = [join(directory, "a.fit"), join(directory, "b.fit")];
    for (const path of paths) {
      const file = await open(path, "w");
      try {
        await file.truncate(DESKTOP_IMPORT_LIMIT_BYTES / 2);
      } finally {
        await file.close();
      }
    }
    const selection = await access.grant(paths);
    assert.equal(
      selection?.files.reduce((sum, file) => sum + file.size, 0),
      DESKTOP_IMPORT_LIMIT_BYTES,
    );
    const extra = join(directory, "extra.fit");
    const file = await open(extra, "w");
    try {
      await file.truncate(1);
    } finally {
      await file.close();
    }
    await assert.rejects(
      access.grant([...paths, extra]),
      /desktop size limit \(2048 MiB\)/,
    );
  } finally {
    access.clear();
    await rm(directory, { recursive: true, force: true });
  }
});

test("document client passes the selected import limit unchanged to its worker", async () => {
  const original = globalThis.Worker;
  const sent: number[] = [];
  class CaptureWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(request: WorkerRequest) {
      if (request.kind !== "open") return;
      sent.push(request.limit);
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            kind: "result",
            result: { filename: "limit.fit" },
            requestId: request.requestId,
            documentId: request.documentId,
          },
        }),
      );
    }
    terminate() {}
  }
  globalThis.Worker = CaptureWorker as unknown as typeof Worker;
  const client = new DocumentClient();
  try {
    const file = new File([], "limit.fit");
    await client.open(file);
    await client.open(file, { limit: importLimitBytes(true) });
    await client.open(file, { limit: importLimitBytes(false, "128") });
    assert.deepEqual(sent, [
      WEB_IMPORT_LIMIT_BYTES,
      DESKTOP_IMPORT_LIMIT_BYTES,
      128 * 1048576,
    ]);
  } finally {
    client.destroy();
    globalThis.Worker = original;
  }
});
