import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { collectDrop } from "../src/ui/file-drop";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { FitDocument } from "../src/document/document";
import { activity } from "./fixtures";

const controller = () => new AbortController();
function file(name: string, bytes = activity(12)): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve: (file: File) => void) {
      resolve(new File([bytes.slice()], name));
    },
  } as unknown as FileSystemEntry;
}
function directory(
  name: string,
  ...batches: FileSystemEntry[][]
): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let index = 0;
      return {
        readEntries(resolve: (batch: FileSystemEntry[]) => void) {
          resolve(batches[index++] ?? []);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

test("folder imports read every directory batch, preserve paths and combine FIT sources", async () => {
  const signal = controller().signal;
  const root = directory(
    "Activity",
    [file("first.FIT"), file("notes.txt")],
    [directory("nested", [file("second.fit"), file("skip.zip")])],
    [directory("__MACOSX", [file("hidden.fit")]), file("._hidden.fit")],
  );
  const selection = await collectDrop(
    { entries: [root], files: [] },
    signal,
    100000,
    () => {},
  );
  assert.equal(selection.name, "Activity");
  assert.deepEqual(
    selection.files.map((file) => file.name),
    ["Activity/first.FIT", "Activity/nested/second.fit"],
  );
  const job = createJob(signal);
  const loaded = await loadFile(selection, 100000, job);
  const document = await FitDocument.openSources(
    loaded.sources,
    loaded.filename,
    job,
  );
  assert.equal(document.summary().sources.length, 2);
  assert.equal(document.summary().filename, "Activity");
  assert.equal(
    document.summary().messages.find((message) => message.id === 20)?.count,
    24,
  );
});

test("folder scan honors aggregate limits, cancellation and empty-folder errors", async () => {
  const entry = directory("Activity", [file("one.fit"), file("two.fit")]);
  await assert.rejects(
    collectDrop(
      { entries: [entry], files: [] },
      controller().signal,
      1,
      () => {},
    ),
    /size limit/,
  );
  const abort = controller();
  await assert.rejects(
    collectDrop({ entries: [entry], files: [] }, abort.signal, 100000, () =>
      abort.abort(),
    ),
    { name: "AbortError" },
  );
  await assert.rejects(
    collectDrop(
      { entries: [directory("Empty", [file("notes.txt")])], files: [] },
      controller().signal,
      100000,
      () => {},
    ),
    /no FIT files/,
  );
});

test("folder-picker paths and multi-file drops remain distinct", async () => {
  const files = [
    new File([activity(12).slice()], "data.fit"),
    new File([activity(12).slice()], "data.fit"),
  ];
  Object.defineProperty(files[0], "webkitRelativePath", {
    value: "Folder/a/data.fit",
  });
  Object.defineProperty(files[1], "webkitRelativePath", {
    value: "Folder/b/data.fit",
  });
  const selected = await collectDrop(
    { entries: [], files },
    controller().signal,
    100000,
    () => {},
  );
  assert.equal(selected.name, "Folder");
  assert.deepEqual(
    selected.files.map((file) => file.name),
    ["Folder/a/data.fit", "Folder/b/data.fit"],
  );
});

test("multi-file processing bounds the sum of FIT data and expanded ZIP entries", async () => {
  const zip = new JSZip().file("second.fit", activity(2000));
  const zipped = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const first = new File([activity(12).slice()], "first.fit");
  const second = new File([zipped.slice()], "second.zip");
  const selected = { name: "Two files", files: [first, second] };
  const limit = first.size + second.size + 1;
  await assert.rejects(
    loadFile(selected, limit, createJob(controller().signal)),
    /limit/,
  );
  const result = await loadFile(
    selected,
    100000,
    createJob(controller().signal),
  );
  assert.deepEqual(
    result.sources.map((source) => source.filename),
    ["first.fit", "second.zip/second.fit"],
  );
  await assert.rejects(
    loadFile(
      {
        name: "invalid",
        files: [{ name: "bad.fit", size: 1, url: "file:///secret.fit" }],
      },
      1000,
      createJob(controller().signal),
    ),
    /Invalid desktop/,
  );
});
