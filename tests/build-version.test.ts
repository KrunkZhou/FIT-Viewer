import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVersion } from "../scripts/build-version";

test("web builds prefer the shared release version before its tag exists, with a Git fallback for local builds", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fitviewer-web-version-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const version = (releaseVersion?: string) =>
    buildVersion({ cwd, packageVersion: "0.0.0", releaseVersion });
  try {
    git("init");
    git("config", "user.name", "Version test");
    git("config", "user.email", "test@example.invalid");
    git("config", "commit.gpgsign", "false");
    git("config", "core.hooksPath", "/dev/null");
    git("commit", "--allow-empty", "-m", "initial");
    const first = git("rev-parse", "--short=8", "HEAD");
    assert.equal(version(), `dev+${first}`);
    git("tag", "v0.0.16");
    assert.equal(version(), "0.0.16");
    git("tag", "commit-legacy");
    git("tag", "v9.0.0-beta.1");
    assert.equal(version(), "0.0.16");
    git("commit", "--allow-empty", "-m", "next");
    const next = git("rev-parse", "--short=8", "HEAD");
    assert.equal(version(), `0.0.16+1.${next}`);
    assert.equal(version("0.0.17"), "0.0.17");
    git("tag", "v0.0.17");
    assert.equal(version(), "0.0.17");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("source archives without Git use a real package version or an explicit development label", () => {
  const cwd = mkdtempSync(join(tmpdir(), "fitviewer-no-git-"));
  try {
    assert.equal(buildVersion({ cwd, packageVersion: "0.0.0" }), "development");
    assert.equal(buildVersion({ cwd, packageVersion: "1.2.3" }), "1.2.3");
    assert.equal(
      buildVersion({ cwd, packageVersion: "0.0.0", releaseVersion: "2.3.4" }),
      "2.3.4",
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
