import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAccess, launchFiles } from "../electron/file-access";
import {
  FIT_PROG_ID,
  shouldPromptForAssociation,
} from "../electron/association-policy";
import { activity } from "./fixtures";

test("launch arguments accept FIT and ZIP files without interpreting switches", () => {
  assert.deepEqual(
    launchFiles(
      [
        "data.fit",
        "data.fit",
        "second.ZIP",
        "--inspect=bad.fit",
        "https://example.com",
        "notes.txt",
      ],
      "/activity",
    ),
    [resolve("/activity/data.fit"), resolve("/activity/second.ZIP")],
  );
});

test("only this installed Windows build prompts, and a confirmed default is not nagged", () => {
  const base = {
    platform: "win32",
    packaged: true,
    portable: false,
    executable: "C:\\Apps\\FIT Viewer.exe",
    installedExecutable: "c:\\apps\\FIT Viewer.exe",
    dismissed: false,
  };
  assert.equal(shouldPromptForAssociation(base), true);
  for (const change of [
    { platform: "darwin" },
    { packaged: false },
    { portable: true },
    { dismissed: true },
    { installedExecutable: undefined },
    { installedExecutable: "C:\\Other\\Viewer.exe" },
    { currentProgId: FIT_PROG_ID },
  ])
    assert.equal(shouldPromptForAssociation({ ...base, ...change }), false);
  assert.equal(
    shouldPromptForAssociation({ ...base, currentProgId: "Another.Program" }),
    true,
  );
});

test("desktop grants read only OS-selected files and expire on release/replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "fitviewer-open-"));
  try {
    const path = join(root, "sample file.fit");
    const bytes = activity(12);
    await writeFile(path, bytes);
    const access = new FileAccess(100000);
    const fetchFile = async (url: string) =>
      new Response(await readFile(fileURLToPath(url)));
    const selection = (await access.grant([path]))!;
    const url = (selection.files[0] as { url: string }).url;
    assert.equal(selection.name, "sample file.fit");
    assert.equal(JSON.stringify(selection).includes(root), false);
    const response = await access.read(new Request(url), fetchFile);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
    assert.equal(
      (await access.read(new Request(url, { method: "POST" }), fetchFile))
        .status,
      404,
    );
    assert.equal(
      (
        await access.read(
          new Request("fitviewer://app/import/secret"),
          fetchFile,
        )
      ).status,
      404,
    );
    access.release([url]);
    assert.equal((await access.read(new Request(url), fetchFile)).status, 404);
    const next = (await access.grant([path]))!;
    const nextUrl = (next.files[0] as { url: string }).url;
    await writeFile(path, new Uint8Array([1, 2, 3]));
    assert.equal(
      (await access.read(new Request(nextUrl), fetchFile)).status,
      409,
    );
    await access.grant([path]);
    assert.equal(
      (await access.read(new Request(nextUrl), fetchFile)).status,
      404,
    );
    await assert.rejects(new FileAccess(1).grant([path]), /size limit/);
    await assert.rejects(access.grant([root]), /FIT or ZIP/);
    await assert.rejects(access.grant(["relative.fit"]), /FIT or ZIP/);
    if (process.platform !== "win32") {
      const link = join(root, "link.fit");
      await symlink(path, link);
      await assert.rejects(access.grant([link]), /regular/);
    }
    access.clear();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("installer registers an Open With candidate without writing or deleting shared defaults", async () => {
  const script = await readFile(
    new URL("../build/installer.nsh", import.meta.url),
    "utf8",
  );
  assert.match(
    script,
    /WriteRegStr HKCU "Software\\Classes\\\.fit\\OpenWithProgids" "app\.fitviewer\.desktop\.fit"/,
  );
  assert.doesNotMatch(script, /(?:WriteReg\w+|DeleteReg\w+)[^\n]*UserChoice/);
  assert.doesNotMatch(script, /DeleteRegKey[^\n]*"Software\\Classes\\\.fit/);
  assert.doesNotMatch(script, /WriteRegStr HKCU "Software\\Classes\\\.fit"/);
});
