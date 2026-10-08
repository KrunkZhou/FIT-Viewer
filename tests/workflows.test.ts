import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { parseDocument } from "yaml";

function workflow(name: string) {
  const document = parseDocument(
    readFileSync(`.github/workflows/${name}.yml`, "utf8"),
    { uniqueKeys: true },
  );
  assert.deepEqual(document.errors, []);
  return document.toJS();
}

test("Pages and desktop workflows use pinned actions, locked installs and scoped publishing permissions", () => {
  for (const name of ["pages", "desktop-release"]) {
    const config = workflow(name);
    assert.deepEqual(config.permissions, { contents: "read" });
    for (const job of Object.values(config.jobs) as {
      steps: { uses?: string; run?: string }[];
    }[])
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
        if (step.run?.startsWith("pnpm install"))
          assert.equal(step.run, "pnpm install --frozen-lockfile");
      }
  }
  const pages = workflow("pages");
  assert.deepEqual(pages.jobs.deploy.permissions, {
    pages: "write",
    "id-token": "write",
  });
  assert.equal(pages.jobs.deploy.needs, "build");
  assert.ok(pages.jobs.build.if.includes("repository.default_branch"));
  const release = workflow("desktop-release");
  assert.deepEqual(release.jobs.release.permissions, { contents: "write" });
  assert.deepEqual(release.jobs.release.needs, ["validate", "build"]);
  assert.deepEqual(
    release.jobs.build.strategy.matrix.include.map(
      (entry: { platform: string; arch: string }) =>
        `${entry.platform}-${entry.arch}`,
    ),
    ["win-x64", "mac-x64", "mac-arm64"],
  );
  assert.equal(
    release.jobs.build.steps[0].with.ref,
    "${{ needs.validate.outputs.commit }}",
  );
});

test("release versions come from validated semantic version tags, including prereleases", () => {
  const directory = mkdtempSync(join(tmpdir(), "fitviewer-version-"));
  try {
    const output = join(directory, "outputs");
    for (const [tag, prerelease] of [
      ["v1.2.3", "false"],
      ["v2.0.0-beta.1", "true"],
    ]) {
      const result = execFileSync(
        process.execPath,
        ["scripts/release-version.mjs"],
        {
          env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
          encoding: "utf8",
        },
      );
      assert.ok(result.includes(`version=${tag.slice(1)}\n`));
      assert.ok(result.includes(`prerelease=${prerelease}\n`));
    }
    assert.ok(readFileSync(output, "utf8").includes("tag=v1.2.3\n"));
    for (const tag of [
      "main",
      "1.2.3",
      "v01.2.3",
      "v1.2",
      "v1.2.3+build",
      "v1.2.3\nversion=bad",
      "v1.2.3;echo bad",
    ])
      assert.throws(
        () =>
          execFileSync(process.execPath, ["scripts/release-version.mjs"], {
            env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
            stdio: "pipe",
          }),
        tag,
      );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
