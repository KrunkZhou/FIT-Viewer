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
  isOutBinPath,
  isSetPath,
  MAX_INPUT_FILES,
} from "../src/document/input";
import { createJob } from "../src/document/jobs";
import { collectDrop } from "../src/ui/file-drop";

const outputBytes = Uint8Array.of(1, 2, 3, 4);
const signal = () => new AbortController().signal;
const job = () => createJob(signal());

function fileEntry(name: string): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file(resolve: (file: File) => void) {
      resolve(new File([outputBytes], name));
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

async function archive(zip: JSZip): Promise<File> {
  return new File(
    [
      (
        await zip.generateAsync({
          type: "uint8array",
          compression: "DEFLATE",
        })
      ).slice(),
    ],
    "device.zip",
  );
}

test("OUT.BIN filtering accepts exact basenames and ignores unrelated binaries and metadata", () => {
  for (const name of ["OUT.BIN", "out.bin", "Logs/Out.Bin", "Logs\\OUT.BIN"]) {
    assert.equal(isOutBinPath(name), true, name);
    assert.equal(isDocumentPath(name), true, name);
    assert.equal(isFitPath(name), false, name);
    assert.equal(isSetPath(name), false, name);
  }
  for (const name of [
    "other.bin",
    "myout.bin",
    "OUT.BIN.bak",
    "OUT.BIN/child.bin",
    "__MACOSX/OUT.BIN",
    "Logs/__MACOSX/OUT.BIN",
    "Logs/._OUT.BIN",
    "._Logs/OUT.BIN",
  ]) {
    assert.equal(isOutBinPath(name), false, name);
    assert.equal(isDocumentPath(name), false, name);
  }
});

test("single and mixed imports preserve OUT.BIN paths and bytes", async () => {
  const output = new File([outputBytes], "OUT.BIN");
  const single = await loadFile(output, 100000, job());
  assert.deepEqual(single, {
    filename: "OUT.BIN",
    sources: [{ filename: "OUT.BIN", bytes: outputBytes }],
  });
  const multiple = await loadFile(
    {
      name: "Selected files",
      files: [
        new File([outputBytes], "activity.fit"),
        new File([outputBytes], "app.SET"),
        output,
        await archive(new JSZip().file("logs/out.bin", outputBytes)),
      ],
    },
    100000,
    job(),
  );
  assert.equal(multiple.filename, "Selected files");
  assert.deepEqual(
    multiple.sources.map((source) => source.filename),
    ["activity.fit", "app.SET", "OUT.BIN", "device.zip/logs/out.bin"],
  );
  for (const source of multiple.sources)
    assert.deepEqual(source.bytes, outputBytes);
  await assert.rejects(loadFile(output, output.size - 1, job()), /limit/);
  await assert.rejects(
    loadFile(
      { name: "Too many", files: Array(MAX_INPUT_FILES + 1).fill(output) },
      100000,
      job(),
    ),
    /number of selected files/,
  );
});

test("unsupported standalone BIN files fail before their bytes are read", async () => {
  const unsupported = new File([outputBytes], "random.BIN");
  Object.defineProperty(unsupported, "arrayBuffer", {
    value: () => assert.fail("Unsupported BIN files should not be read"),
  });
  await assert.rejects(
    loadFile(unsupported, 100000, job()),
    /Only OUT\.BIN files are supported/,
  );
  const other = new File([outputBytes], "existing.custom");
  assert.deepEqual(
    (await loadFile(other, 100000, job())).sources[0].bytes,
    outputBytes,
  );
});

test("browser drops and folder pickers collect OUT.BIN while excluding other binaries", async () => {
  const folder = await collectDrop(
    {
      entries: [
        directoryEntry("Device", [
          fileEntry("OUT.BIN"),
          fileEntry("random.bin"),
          fileEntry("._OUT.BIN"),
          directoryEntry("__MACOSX", [fileEntry("OUT.BIN")]),
          directoryEntry("nested", [
            fileEntry("out.bin"),
            fileEntry("skip.zip"),
          ]),
        ]),
      ],
      files: [],
    },
    signal(),
    100000,
    () => {},
  );
  assert.equal(folder.name, "Device");
  assert.deepEqual(
    folder.files.map((file) => file.name),
    ["Device/nested/out.bin", "Device/OUT.BIN"],
  );
  const pickerFiles = [
    ["out.bin", "Device/logs/out.bin"],
    ["random.bin", "Device/random.bin"],
    ["OUT.BIN", "Device/__MACOSX/OUT.BIN"],
    ["skip.zip", "Device/skip.zip"],
  ].map(([name, relativePath]) => {
    const file = new File([outputBytes], name);
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
    ["Device/logs/out.bin"],
  );
  const drop = await collectDrop(
    {
      entries: [],
      files: [
        new File([outputBytes], "OUT.BIN"),
        new File([outputBytes], "random.bin"),
      ],
    },
    signal(),
    100000,
    () => {},
  );
  assert.deepEqual(
    drop.files.map((file) => file.name),
    ["OUT.BIN"],
  );
  await assert.rejects(
    collectDrop(
      { entries: [], files: [new File([outputBytes], "OUT.BIN")] },
      signal(),
      outputBytes.length - 1,
      () => {},
    ),
    /size limit/,
  );
});

test("ZIPs include OUT.BIN alone or with FIT and SET while enforcing expanded size limits", async () => {
  const mixed = await loadFile(
    await archive(
      new JSZip()
        .file("activity.fit", outputBytes)
        .file("app.SET", outputBytes)
        .file("Device/OUT.BIN", outputBytes)
        .file("random.bin", outputBytes)
        .file("__MACOSX/OUT.BIN", outputBytes)
        .file("Device/._OUT.BIN", outputBytes),
    ),
    100000,
    job(),
  );
  assert.deepEqual(
    mixed.sources.map((source) => source.filename),
    ["activity.fit", "app.SET", "Device/OUT.BIN"],
  );
  const only = await loadFile(
    await archive(new JSZip().file("OUT.BIN", outputBytes)),
    100000,
    job(),
  );
  assert.equal(only.filename, "OUT.BIN");
  assert.deepEqual(only.sources[0].bytes, outputBytes);
  await assert.rejects(
    loadFile(
      await archive(new JSZip().file("random.bin", outputBytes)),
      100000,
      job(),
    ),
    /no FIT, SET or OUT\.BIN files/,
  );
  await assert.rejects(
    loadFile(
      await archive(
        new JSZip()
          .file("one/OUT.BIN", new Uint8Array(6000))
          .file("two/out.bin", new Uint8Array(6000)),
      ),
      10000,
      job(),
    ),
    /exceeds/,
  );
});

test("desktop launches and grants support OUT.BIN with private URLs and folder limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "fitviewer-output-"));
  try {
    const folder = join(root, "Device");
    await mkdir(join(folder, "nested"), { recursive: true });
    await mkdir(join(folder, "__MACOSX"));
    const standalone = join(root, "OUT.BIN");
    await writeFile(standalone, outputBytes);
    await writeFile(join(root, "random.bin"), outputBytes);
    await writeFile(join(folder, "out.bin"), outputBytes);
    await writeFile(join(folder, "nested", "OUT.BIN"), outputBytes);
    await writeFile(join(folder, "random.bin"), outputBytes);
    await writeFile(join(folder, "._OUT.BIN"), outputBytes);
    await writeFile(join(folder, "__MACOSX", "OUT.BIN"), outputBytes);
    assert.deepEqual(
      await launchFiles(
        [
          "OUT.BIN",
          "Device",
          "random.bin",
          "._OUT.BIN",
          "__MACOSX/OUT.BIN",
          "--OUT.BIN",
        ],
        root,
      ),
      [standalone, folder],
    );
    const access = new FileAccess(100000);
    const single = (await access.grant([standalone]))!;
    assert.equal(single.name, "OUT.BIN");
    const selection = (await access.grant([folder, standalone]))!;
    assert.deepEqual(
      selection.files.map((file) => file.name),
      ["Device/nested/OUT.BIN", "Device/out.bin", "OUT.BIN"],
    );
    assert.equal(JSON.stringify(selection).includes(root), false);
    const fetchFile = async (url: string) =>
      new Response(await readFile(fileURLToPath(url)));
    for (const file of selection.files) {
      assert.ok("url" in file);
      assert.deepEqual(
        new Uint8Array(
          await (
            await access.read(new Request(file.url), fetchFile)
          ).arrayBuffer(),
        ),
        outputBytes,
      );
    }
    await assert.rejects(
      new FileAccess(outputBytes.length).grant([folder]),
      /size limit/,
    );
    await assert.rejects(
      access.grant([join(root, "random.bin")]),
      /Only FIT, SET, OUT\.BIN or ZIP/,
    );
    access.clear();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
