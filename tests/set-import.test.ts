import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import { FileAccess, launchFiles } from "../electron/file-access";
import { loadFile } from "../src/document/files";
import {
  isDocumentPath,
  isFitPath,
  isSetPath,
  isZipPath,
} from "../src/document/input";
import { createJob } from "../src/document/jobs";
import { collectDrop } from "../src/ui/file-drop";

const settingsBytes = Uint8Array.of(1, 2, 3, 4);
const signal = () => new AbortController().signal;
const job = () => createJob(signal());

function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve: (file: File) => void) {
      resolve(new File([settingsBytes], name));
    },
  } as unknown as FileSystemEntry;
}

function directoryEntry(
  name: string,
  entries: FileSystemEntry[],
): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader() {
      let read = false;
      return {
        readEntries(resolve: (entries: FileSystemEntry[]) => void) {
          resolve(read ? [] : entries);
          read = true;
        },
      };
    },
  } as unknown as FileSystemEntry;
}

test("document filtering accepts SET paths without broadening FIT-only checks", () => {
  assert.equal(isFitPath("app.SET"), false);
  assert.equal(isSetPath("app.SET"), true);
  assert.equal(isDocumentPath("Apps/settings.set"), true);
  assert.equal(isDocumentPath("Activity/data.FIT"), true);
  assert.equal(isDocumentPath("Activity/archive.zip"), false);
  for (const prefix of ["__MACOSX/", "Folder/__MACOSX/", "Folder\\._", "._"])
    for (const extension of ["fit", "set", "zip"]) {
      const path = `${prefix}app.${extension}`;
      assert.equal(isDocumentPath(path), false, path);
      assert.equal(isZipPath(path), false, path);
    }
});

test("single and multiple selections retain SET filenames and raw bytes", async () => {
  const settings = new File([settingsBytes], "app.SET");
  const single = await loadFile(settings, 100000, job());
  assert.equal(single.filename, "app.SET");
  assert.deepEqual(single.sources, [
    { filename: "app.SET", bytes: settingsBytes },
  ]);
  const zipped = await new JSZip()
    .file("nested/other.set", settingsBytes)
    .generateAsync({ type: "uint8array" });
  const multiple = await loadFile(
    {
      name: "Two files",
      files: [settings, new File([zipped.slice()], "settings.zip")],
    },
    100000,
    job(),
  );
  assert.deepEqual(multiple.sources, [
    { filename: "app.SET", bytes: settingsBytes },
    { filename: "settings.zip/nested/other.set", bytes: settingsBytes },
  ]);
});

test("browser drops and folder pickers include SET files and exclude metadata", async () => {
  const root = directoryEntry("Apps", [
    fileEntry("one.SET"),
    directoryEntry("nested", [fileEntry("two.set"), fileEntry("skip.zip")]),
    fileEntry("._one.SET"),
    directoryEntry("__MACOSX", [fileEntry("hidden.SET")]),
  ]);
  const folder = await collectDrop(
    { entries: [root], files: [] },
    signal(),
    100000,
    () => {},
  );
  assert.equal(folder.name, "Apps");
  assert.deepEqual(
    folder.files.map((file) => file.name),
    ["Apps/nested/two.set", "Apps/one.SET"],
  );
  const pickerFiles = [
    ["one.SET", "Apps/one.SET"],
    ["hidden.SET", "Apps/__MACOSX/hidden.SET"],
    ["skip.zip", "Apps/skip.zip"],
  ].map(([name, relativePath]) => {
    const file = new File([settingsBytes], name);
    Object.defineProperty(file, "webkitRelativePath", { value: relativePath });
    return file;
  });
  const picker = await collectDrop(
    { entries: [], files: pickerFiles },
    signal(),
    100000,
    () => {},
  );
  assert.deepEqual(
    picker.files.map((file) => file.name),
    ["Apps/one.SET"],
  );
  const drop = await collectDrop(
    {
      entries: [],
      files: [
        new File([settingsBytes], "app.SET"),
        new File([settingsBytes], "._app.SET"),
        new File([settingsBytes], "._archive.zip"),
      ],
    },
    signal(),
    100000,
    () => {},
  );
  assert.deepEqual(
    drop.files.map((file) => file.name),
    ["app.SET"],
  );
});

test("ZIP loading includes SET-only and mixed archives with shared extraction limits", async () => {
  const archive = async (zip: JSZip) =>
    new File(
      [
        (
          await zip.generateAsync({
            type: "uint8array",
            compression: "DEFLATE",
          })
        ).slice(),
      ],
      "settings.zip",
    );
  const mixed = await loadFile(
    await archive(
      new JSZip()
        .file("activity.fit", settingsBytes)
        .file("Apps/app.SET", settingsBytes)
        .file("__MACOSX/Apps/app.SET", settingsBytes)
        .file("Apps/._app.SET", settingsBytes)
        .file("notes.txt", "ignored"),
    ),
    100000,
    job(),
  );
  assert.deepEqual(
    mixed.sources.map((source) => source.filename),
    ["activity.fit", "Apps/app.SET"],
  );
  const setOnly = await loadFile(
    await archive(new JSZip().file("app.SET", settingsBytes)),
    100000,
    job(),
  );
  assert.equal(setOnly.filename, "app.SET");
  assert.deepEqual(setOnly.sources[0].bytes, settingsBytes);
  const large = await archive(
    new JSZip()
      .file("one.SET", new Uint8Array(6000))
      .file("two.set", new Uint8Array(6000)),
  );
  await assert.rejects(loadFile(large, 10000, job()), /exceeds/);
});

test("desktop launch and grants support SET files and folders with private read URLs", async () => {
  const root = await mkdtemp(join(tmpdir(), "fitviewer-set-"));
  try {
    const folder = join(root, "Apps");
    await mkdir(join(folder, "nested"), { recursive: true });
    await mkdir(join(folder, "__MACOSX"));
    const standalone = join(root, "standalone.SET");
    await writeFile(standalone, settingsBytes);
    await writeFile(join(folder, "app.set"), settingsBytes);
    await writeFile(join(folder, "nested", "other.SET"), settingsBytes);
    await writeFile(join(folder, "._app.set"), settingsBytes);
    await writeFile(join(folder, "__MACOSX", "app.set"), settingsBytes);
    await writeFile(join(folder, "nested.zip"), settingsBytes);
    assert.deepEqual(
      await launchFiles(
        [
          "standalone.SET",
          "Apps",
          "._app.set",
          "__MACOSX/hidden.set",
          "--app.set",
        ],
        root,
      ),
      [standalone, folder],
    );
    const access = new FileAccess(100000);
    const single = (await access.grant([standalone]))!;
    assert.equal(single.name, "standalone.SET");
    const selection = (await access.grant([folder, standalone]))!;
    assert.deepEqual(
      selection.files.map((file) => file.name),
      ["Apps/app.set", "Apps/nested/other.SET", "standalone.SET"],
    );
    assert.equal(JSON.stringify(selection).includes(root), false);
    const fetchFile = async (url: string) =>
      new Response(await readFile(fileURLToPath(url)));
    for (const file of selection.files) {
      assert.ok("url" in file);
      const response = await access.read(new Request(file.url), fetchFile);
      assert.deepEqual(
        new Uint8Array(await response.arrayBuffer()),
        settingsBytes,
      );
    }
    await assert.rejects(
      new FileAccess(settingsBytes.length).grant([folder]),
      /size limit/,
    );
    access.clear();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
