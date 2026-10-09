import assert from "node:assert/strict";
import test from "node:test";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const afterPack = createRequire(import.meta.url)("../build/after-pack.cjs");

test("Linux packaging supplies a launcher that preserves arguments without disabling the sandbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fitviewer-linux-"));
  try {
    const appOutDir = join(directory, "FIT Viewer");
    await mkdir(appOutDir);
    await afterPack({
      electronPlatformName: "linux",
      appOutDir,
      packager: { projectDir: resolve(".") },
    });
    const launcher = await readFile(join(appOutDir, "AppRun"), "utf8");
    assert.equal(launcher, await readFile("build/AppRun", "utf8"));
    assert.ok((await stat(join(appOutDir, "AppRun"))).mode & 0o111);
    assert.doesNotMatch(launcher, /--no-sandbox|--disable-setuid-sandbox|eval/);
    await writeFile(
      join(appOutDir, "fit-viewer"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@"\n',
      { mode: 0o755 },
    );
    assert.equal(
      execFileSync(
        "bash",
        [
          join(appOutDir, "AppRun"),
          "activity with spaces.fit",
          "file:///tmp/activity%20two.fit",
        ],
        {
          env: { ...process.env, APPDIR: appOutDir },
          encoding: "utf8",
        },
      ),
      "activity with spaces.fit\nfile:///tmp/activity%20two.fit\n",
    );
    for (const platform of ["win32", "darwin"])
      await afterPack({
        electronPlatformName: platform,
        appOutDir: join(directory, "not-created"),
        packager: { projectDir: resolve(".") },
      });
    await assert.rejects(stat(join(directory, "not-created")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
