import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentClient } from "../src/document/client";
import { loadFile } from "../src/document/files";
import { ImportSizeError, WEB_IMPORT_LIMIT_BYTES } from "../src/document/input";
import { createJob } from "../src/document/jobs";
import type { WorkerRequest, WorkerResponsePayload } from "../src/model";
import { collectDrop } from "../src/ui/file-drop";
import { ImportLimitDialog } from "../src/ui/ImportLimitDialog";

test("file, combined selection, and dropped-file overflows have an explicit size-limit error", async () => {
  const file = new File([new Uint8Array(20)], "large.fit");
  const job = createJob(new AbortController().signal);
  for (const input of [file, { name: "Activity", files: [file, file] }])
    await assert.rejects(loadFile(input, 10, job), ImportSizeError);
  await assert.rejects(
    collectDrop({ entries: [], files: [file] }, job.signal, 10, () => {}),
    ImportSizeError,
  );
  await assert.rejects(
    loadFile(file, 0, job),
    (error) => error instanceof Error && !(error instanceof ImportSizeError),
  );
});

test("ZIP extraction overflows use the same error without misclassifying invalid archives or cancellation", async () => {
  const zip = new JSZip()
    .file("one.fit", new Uint8Array(6000))
    .file("two.fit", new Uint8Array(6000));
  const archive = new File(
    [
      (
        await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" })
      ).slice(),
    ],
    "large.zip",
  );
  const controller = new AbortController();
  const job = createJob(controller.signal);
  assert.ok(archive.size < 10000);
  await assert.rejects(loadFile(archive, 10000, job), ImportSizeError);
  await assert.rejects(
    loadFile(new File(["invalid"], "broken.zip"), 10000, job),
    (error) => error instanceof Error && !(error instanceof ImportSizeError),
  );
  controller.abort();
  await assert.rejects(loadFile(archive, 10000, job), { name: "AbortError" });
});

test("worker size-limit codes survive transport but ordinary errors and cancellation stay distinct", async () => {
  const original = globalThis.Worker;
  let response: WorkerResponsePayload = {
    kind: "error",
    message: "Too large",
    code: "import-size-limit",
  };
  class FakeWorker {
    onmessage?: (event: { data: unknown }) => void;
    postMessage(request: WorkerRequest) {
      queueMicrotask(() =>
        this.onmessage?.({
          data: {
            ...response,
            documentId: request.documentId,
            requestId: request.requestId,
          },
        }),
      );
    }
    terminate() {}
  }
  globalThis.Worker = FakeWorker as unknown as typeof Worker;
  const client = new DocumentClient();
  const file = new File([], "test.fit");
  try {
    await assert.rejects(client.open(file), ImportSizeError);
    response = { kind: "error", message: "Invalid file" };
    await assert.rejects(
      client.open(file),
      (error) => error instanceof Error && !(error instanceof ImportSizeError),
    );
    response = {
      kind: "error",
      message: "Cancelled",
      code: "import-size-limit",
      aborted: true,
    };
    await assert.rejects(client.open(file), { name: "AbortError" });
  } finally {
    client.destroy();
    globalThis.Worker = original;
  }
});

test("oversize prompt names the configured web limit and bounded desktop capacity with a safe release link", () => {
  for (const limit of [WEB_IMPORT_LIMIT_BYTES, 128 * 1048576, 4096 * 1048576]) {
    const markup = renderToStaticMarkup(
      createElement(ImportLimitDialog, { limit, onClose() {} }),
    );
    assert.ok(markup.includes(`${limit / 1048576} MiB`));
    assert.match(markup, /up to 2 GiB per import/);
    assert.match(markup, /extracted FIT data/);
    assert.match(
      markup,
      /href="https:\/\/github.com\/KrunkZhou\/FIT-Viewer\/releases\/latest"/,
    );
    assert.match(markup, /target="_blank" rel="noopener noreferrer"/);
    assert.match(markup, /aria-label="Close"/);
    assert.equal(markup.includes("For larger imports"), limit < 2 * 1024 ** 3);
  }
});
