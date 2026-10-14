import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FileAccess, launchFiles } from "../electron/file-access";
import {
  FIT_PROG_ID,
  associationRegistration,
  completeAssociationPrompt,
  shouldPromptForAssociation,
} from "../electron/association-policy";
import { activity } from "./fixtures";

test("launch arguments accept FIT and ZIP files without interpreting switches", async () => {
  assert.deepEqual(
    await launchFiles(
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
    await assert.rejects(access.grant([join(root, "empty")]), /ENOENT/);
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

test("launch paths include relative and absolute folders, spaces, and folders with extensions", async () => {
  const root = await mkdtemp(join(tmpdir(), "fitviewer-arguments-"));
  try {
    const folder = join(root, "Activity data.v1");
    await mkdir(folder);
    await writeFile(join(root, "notes.txt"), "ignored");
    assert.deepEqual(
      await launchFiles(
        [
          "Activity data.v1",
          folder,
          "sample file.fit",
          "archive.zip",
          "notes.txt",
          "https://example.com/activity.fit",
          "--inspect=data.fit",
          "--",
          "",
        ],
        root,
      ),
      [folder, join(root, "sample file.fit"), join(root, "archive.zip")],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop folder arguments recursively combine FIT files with private URLs and preserve source names", async () => {
  const root = await mkdtemp(join(tmpdir(), "fitviewer-folder-"));
  try {
    const folder = join(root, "Activity data");
    const nested = join(folder, "day two");
    const ignored = join(folder, "__MACOSX");
    await mkdir(nested, { recursive: true });
    await mkdir(ignored);
    const bytes = activity(12);
    const first = join(folder, "first.fit");
    const second = join(nested, "second.FIT");
    await writeFile(first, bytes);
    await writeFile(second, bytes);
    await writeFile(join(folder, "notes.txt"), "ignored");
    await writeFile(join(folder, "nested.zip"), "ignored archive");
    await writeFile(join(folder, "._first.fit"), "ignored");
    await writeFile(join(ignored, "hidden.fit"), bytes);
    if (process.platform !== "win32") {
      await symlink(root, join(nested, "cycle"));
      await symlink(first, join(folder, "linked.fit"));
    }
    const access = new FileAccess(bytes.length * 3);
    const selection = (await access.grant([folder]))!;
    assert.equal(selection.name, "Activity data");
    assert.deepEqual(
      selection.files.map((file) => file.name),
      ["Activity data/day two/second.FIT", "Activity data/first.fit"],
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
        bytes,
      );
    }
    const combined = (await access.grant([folder, second]))!;
    assert.equal(combined.files.length, 2);
    for (const file of selection.files) {
      assert.ok("url" in file);
      assert.equal(
        (await access.read(new Request(file.url), fetchFile)).status,
        404,
      );
    }
    const obsolete = access.grant([folder]);
    const newest = (await access.grant([first]))!;
    assert.equal(await obsolete, undefined);
    const newestFile = newest.files[0];
    assert.ok("url" in newestFile);
    assert.equal(
      (await access.read(new Request(newestFile.url), fetchFile)).status,
      200,
    );
    await assert.rejects(
      new FileAccess(bytes.length).grant([folder]),
      /size limit/,
    );
    const empty = join(root, "empty");
    await mkdir(empty);
    await assert.rejects(access.grant([empty]), /no FIT files/);
    access.clear();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Not now and dialog cancellation persist dismissal without registration or opening Settings", async () => {
  for (const response of [1, 2, -1]) {
    const calls: string[] = [];
    let dismissed = false;
    await completeAssociationPrompt(response, {
      dismiss: async () => {
        dismissed = true;
        calls.push("dismiss");
      },
      register: async () => {
        calls.push("register");
      },
      openSettings: async () => {
        calls.push("settings");
      },
    });
    assert.deepEqual(calls, ["dismiss"]);
    assert.equal(
      shouldPromptForAssociation({
        platform: "win32",
        packaged: true,
        portable: false,
        executable: "C:\\Apps\\FIT Viewer.exe",
        installedExecutable: "C:\\Apps\\FIT Viewer.exe",
        dismissed,
      }),
      false,
    );
  }
});

test("only an explicit affirmative response registers the candidate before opening Settings", async () => {
  const calls: string[] = [];
  await completeAssociationPrompt(0, {
    dismiss: async () => {
      calls.push("dismiss");
    },
    register: async () => {
      calls.push("register");
    },
    openSettings: async () => {
      calls.push("settings");
    },
  });
  assert.deepEqual(calls, ["dismiss", "register", "settings"]);
  const executable = "C:\\Apps with spaces\\FIT Viewer.exe";
  const entries = associationRegistration(executable);
  assert.ok(
    entries.some(
      ([key, name, value]) =>
        key.endsWith(".fit\\OpenWithProgids") &&
        name === FIT_PROG_ID &&
        value === "",
    ),
  );
  assert.ok(
    entries.some(
      ([key, name, value]) =>
        key.endsWith("\\shell\\open\\command") &&
        name === "" &&
        value === `"${executable}" "%1"`,
    ),
  );
  for (const [key] of entries) {
    assert.ok(key.startsWith("HKCU\\"));
    assert.doesNotMatch(key, /UserChoice|\\Classes\\\.fit$/i);
  }
});

test("a failed dismissal save never registers a file handler", async () => {
  await assert.rejects(
    completeAssociationPrompt(0, {
      dismiss: async () => {
        throw new Error("disk full");
      },
      register: async () => {
        assert.fail("registration must follow saved consent");
      },
      openSettings: async () => {
        assert.fail("Settings must follow registration");
      },
    }),
    /disk full/,
  );
});

test("installer does not register file handlers or alter existing defaults before consent", async () => {
  const script = await readFile(
    new URL("../build/installer.nsh", import.meta.url),
    "utf8",
  );
  const install = script.split("!macro customInstall")[1].split("!macroend")[0];
  assert.match(install, /WriteRegStr HKCU "Software\\FITViewer" "Executable"/);
  assert.doesNotMatch(install, /Classes|Capabilities|RegisteredApplications/);
  assert.doesNotMatch(script, /(?:WriteReg\w+|DeleteReg\w+)[^\n]*UserChoice/);
  assert.doesNotMatch(script, /DeleteRegKey[^\n]*"Software\\Classes\\\.fit/);
  assert.doesNotMatch(script, /WriteRegStr HKCU "Software\\Classes\\\.fit"/);
});
