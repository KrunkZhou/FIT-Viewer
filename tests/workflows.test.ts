import assert from "node:assert/strict";
import test from "node:test";
import {
  readFileSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
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

test("build workflows retain portable install, typecheck and test gates", () => {
  const pages = workflow("pages");
  const release = workflow("desktop-release");
  for (const [job, expected] of [
    [
      pages.jobs.build,
      [
        "pnpm install --frozen-lockfile",
        "pnpm run typecheck",
        "pnpm test",
        "pnpm run build",
      ],
    ],
    [
      release.jobs.validate,
      ["pnpm install --frozen-lockfile", "pnpm run typecheck", "pnpm test"],
    ],
  ] as const) {
    const commands = job.steps
      .filter((step: { run?: string }) => step.run?.startsWith("pnpm "))
      .map((step: { run: string }) => step.run);
    assert.deepEqual(commands, expected);
  }
});

test("Intel macOS installs the pinned JavaScript pnpm CLI without a native bootstrap", () => {
  const release = workflow("desktop-release");
  const metadata = JSON.parse(readFileSync("package.json", "utf8"));
  const fallback = release.jobs.build.steps.find(
    (step: { name?: string }) =>
      step.name === "Install pinned pnpm on Intel macOS",
  );
  assert.equal(fallback.if, "runner.os == 'macOS' && runner.arch == 'X64'");
  assert.equal(fallback.run, `npm install --global ${metadata.packageManager}`);
  const setup = release.jobs.build.steps.find((step: { uses?: string }) =>
    step.uses?.startsWith("pnpm/action-setup@"),
  );
  assert.equal(setup.if, "runner.os != 'macOS' || runner.arch != 'X64'");
  const nodeIndex = release.jobs.build.steps.findIndex(
    (step: { uses?: string }) => step.uses?.startsWith("actions/setup-node@"),
  );
  assert.ok(nodeIndex < release.jobs.build.steps.indexOf(fallback));
});

test("desktop release titles use the packaged commit, including existing releases", () => {
  const release = workflow("desktop-release");
  assert.equal(
    release.jobs.validate.outputs.commit,
    "${{ steps.commit.outputs.commit }}",
  );
  const publish = release.jobs.release.steps.find(
    (step: { name?: string }) => step.name === "Publish GitHub Release",
  );
  assert.equal(
    publish.env.RELEASE_COMMIT,
    "${{ needs.validate.outputs.commit }}",
  );
  assert.ok(publish.run.includes('--title "$RELEASE_COMMIT" "${options[@]}"'));
  assert.ok(
    publish.run.includes(
      'gh release edit "$RELEASE_TAG" --title "$RELEASE_COMMIT" --draft=false',
    ),
  );
  assert.ok(!publish.run.includes('--title "FIT Viewer $RELEASE_TAG"'));
});

test("desktop releases accept branch pushes and manual runs without requiring tags", () => {
  const release = workflow("desktop-release");
  assert.deepEqual(release.on.push.branches, ["**"]);
  assert.deepEqual(release.on.push.tags, ["v*"]);
  assert.equal(release.on.workflow_dispatch.inputs.tag.required, false);
  assert.match(release.jobs.validate.if, /!github\.event\.deleted/);
  assert.equal(
    release.jobs.validate.steps[0].with.ref,
    "${{ inputs.tag || github.sha }}",
  );
  const version = release.jobs.validate.steps.find(
    (step: { id?: string }) => step.id === "version",
  );
  assert.equal(
    version.env.RELEASE_COMMIT,
    "${{ steps.commit.outputs.commit }}",
  );
  assert.equal(version.env.RELEASE_RUN_NUMBER, "${{ github.run_number }}");
  assert.ok(version.env.RELEASE_TAG.includes("github.ref_type == 'tag'"));
  assert.equal(
    release.concurrency.group,
    "desktop-release-${{ inputs.tag || github.sha }}",
  );
  const publish = release.jobs.release.steps.find(
    (step: { name?: string }) => step.name === "Publish GitHub Release",
  );
  assert.ok(publish.run.includes('--target "$RELEASE_COMMIT"'));
  assert.ok(publish.run.includes('if [[ "$RELEASE_TAG" == commit-* ]]'));
  assert.ok(publish.run.includes('--verify-tag --target "$RELEASE_COMMIT"'));
  assert.ok(publish.run.includes("options+=(--prerelease --latest=false)"));
  assert.ok(
    publish.run.includes('gh api "repos/$GH_REPO/commits/$RELEASE_TAG"'),
  );
});

test("publishing creates exact commit tags, supports reruns, and rejects mismatched tags before uploads", () => {
  const directory = mkdtempSync(join(tmpdir(), "fitviewer-publish-"));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  try {
    const bin = join(directory, "bin");
    const assets = join(directory, "release");
    mkdirSync(bin);
    mkdirSync(assets);
    for (const extension of ["exe", "dmg", "zip"])
      writeFileSync(join(assets, `test.${extension}`), "fixture");
    writeFileSync(
      join(bin, "sha256sum"),
      '#!/usr/bin/env node\nprocess.stdout.write("fixture checksum\\n");\n',
      { mode: 0o755 },
    );
    writeFileSync(
      join(bin, "gh"),
      String.raw`#!/usr/bin/env node
const { readFileSync, writeFileSync, appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const stateFile = process.env.GH_STUB_STATE;
const state = JSON.parse(readFileSync(stateFile, "utf8"));
appendFileSync(process.env.GH_STUB_LOG, JSON.stringify(args) + "\n");
if (args[0] === "api") {
  if (args.includes("POST")) {
    if (state.tag) throw new Error("Tag already exists");
    state.tag = true;
    state.sha = args.find((arg) => arg.startsWith("sha=")).slice(4);
    state.ref = args.find((arg) => arg.startsWith("ref=")).slice(4);
  } else if (args[1].includes("/git/ref/")) {
    if (!state.tag) process.exit(1);
  } else if (args[1].includes("/commits/")) {
    if (!state.tag) process.exit(1);
    process.stdout.write(state.sha + "\n");
  } else throw new Error("Unexpected API command");
} else if (args[0] === "release") {
  if (args[1] === "view") process.exit(state.release ? 0 : 1);
  if (args[1] === "create") {
    if (!state.tag || !args.includes("--verify-tag"))
      throw new Error("Draft releases must use an existing tag");
    state.release = true;
  } else if (args[1] === "upload" || args[1] === "edit") {
    if (!state.release) throw new Error("No release for upload/edit");
  } else throw new Error("Unexpected release command");
} else throw new Error("Unexpected gh command");
writeFileSync(stateFile, JSON.stringify(state));
`,
      { mode: 0o755 },
    );
    const publish = workflow("desktop-release").jobs.release.steps.find(
      (step: { name?: string }) => step.name === "Publish GitHub Release",
    );
    const stateFile = join(directory, "state.json");
    const log = join(directory, "commands.jsonl");
    for (const scenario of [
      { tag: `commit-${commit}`, exists: false, release: false, matches: true },
      { tag: `commit-${commit}`, exists: true, release: true, matches: true },
      { tag: "v1.2.3", exists: true, release: false, matches: true },
      { tag: `commit-${commit}`, exists: true, release: true, matches: false },
    ]) {
      writeFileSync(
        stateFile,
        JSON.stringify({
          tag: scenario.exists,
          release: scenario.release,
          sha: scenario.matches ? commit : "f".repeat(40),
        }),
      );
      writeFileSync(log, "");
      const run = () =>
        execFileSync("bash", ["-e", "-o", "pipefail", "-c", publish.run], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH || ""}`,
            GH_TOKEN: "test-token",
            GH_REPO: "test/repository",
            RELEASE_TAG: scenario.tag,
            RELEASE_COMMIT: commit,
            PRERELEASE: String(scenario.tag.startsWith("commit-")),
            GH_STUB_STATE: stateFile,
            GH_STUB_LOG: log,
          },
          stdio: "pipe",
        });
      if (scenario.matches) run();
      else assert.throws(run);
      const commands: string[][] = readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const createsTag = commands.some((args) => args.includes("POST"));
      assert.equal(createsTag, !scenario.exists);
      const createsRelease = commands.find((args) => args[1] === "create");
      assert.equal(
        Boolean(createsRelease),
        scenario.matches && !scenario.release,
      );
      if (createsRelease) {
        assert.equal(
          createsRelease[createsRelease.indexOf("--target") + 1],
          commit,
        );
        assert.equal(
          createsRelease[createsRelease.indexOf("--title") + 1],
          commit,
        );
        assert.equal(
          createsRelease.includes("--prerelease"),
          scenario.tag.startsWith("commit-"),
        );
      }
      assert.equal(
        commands.some((args) => args[1] === "upload"),
        scenario.matches,
      );
      assert.equal(
        commands.some((args) => args[1] === "edit"),
        scenario.matches,
      );
      if (createsTag) {
        const state = JSON.parse(readFileSync(stateFile, "utf8"));
        assert.equal(state.sha, commit);
        assert.equal(state.ref, `refs/tags/${scenario.tag}`);
      }
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("untagged releases derive unique tags and native-safe versions from their commit and run", () => {
  const directory = mkdtempSync(join(tmpdir(), "fitviewer-commit-release-"));
  const commit = "0123456789abcdef0123456789abcdef01234567";
  try {
    const output = join(directory, "outputs");
    const run = (sha: string, runNumber: string) =>
      execFileSync(process.execPath, ["scripts/release-version.mjs"], {
        env: {
          ...process.env,
          RELEASE_TAG: "",
          RELEASE_COMMIT: sha,
          RELEASE_RUN_NUMBER: runNumber,
          GITHUB_OUTPUT: output,
        },
        encoding: "utf8",
        stdio: "pipe",
      });
    const expected = `tag=commit-${commit}\nversion=0.0.42\nprerelease=true\n`;
    assert.equal(run(commit, "42"), expected);
    assert.equal(run(commit, "42"), expected);
    assert.ok(readFileSync(output, "utf8").includes(expected));
    assert.match(run(commit, "65536"), /version=0\.1\.0\n/);
    assert.match(run(commit, "4294967295"), /version=0\.65535\.65535\n/);
    const otherCommit = "abcdef0123456789abcdef0123456789abcdef01";
    assert.ok(run(otherCommit, "42").includes(`tag=commit-${otherCommit}\n`));
    for (const sha of ["", "abc123", "A".repeat(40), commit + "\ntag=bad"])
      assert.throws(() => run(sha, "42"), sha);
    for (const runNumber of [
      "",
      "0",
      "01",
      "-1",
      "1.2",
      "NaN",
      "4294967296",
      "1\ntag=bad",
    ])
      assert.throws(() => run(commit, runNumber), runNumber);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
