import { appendFile } from "node:fs/promises";
import { valid, prerelease } from "semver";

let tag = process.env.RELEASE_TAG || "";
let version;
let isPrerelease;
if (tag) {
  version = tag.startsWith("v") ? tag.slice(1) : "";
  if (valid(version) !== version || version.includes("+"))
    throw new Error(
      "Release tag must be vMAJOR.MINOR.PATCH, optionally with a prerelease suffix; build metadata is not supported.",
    );
  isPrerelease = prerelease(version) !== null;
} else {
  const commit = process.env.RELEASE_COMMIT || "";
  const run = process.env.RELEASE_RUN_NUMBER || "";
  if (!/^[a-f0-9]{40}$/.test(commit))
    throw new Error("Commit releases require a full lowercase commit SHA.");
  if (!/^[1-9]\d*$/.test(run) || Number(run) > 0xffff_ffff)
    throw new Error(
      "Release run number must be an integer from 1 to 4294967295.",
    );
  const runNumber = Number(run);
  // Native Windows version components must fit in 16 bits.
  version = `0.${Math.floor(runNumber / 65536)}.${runNumber % 65536}`;
  tag = `commit-${commit}`;
  isPrerelease = true;
}
const output = `tag=${tag}\nversion=${version}\nprerelease=${isPrerelease}\n`;
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, output);
process.stdout.write(output);
