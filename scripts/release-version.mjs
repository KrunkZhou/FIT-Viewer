import { appendFile } from "node:fs/promises";
import { valid, prerelease } from "semver";

const tag = process.env.RELEASE_TAG || "";
const version = tag.startsWith("v") ? tag.slice(1) : "";
if (valid(version) !== version || version.includes("+"))
  throw new Error(
    "Release tag must be vMAJOR.MINOR.PATCH, optionally with a prerelease suffix; build metadata is not supported.",
  );
const output = `tag=${tag}\nversion=${version}\nprerelease=${prerelease(version) !== null}\n`;
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, output);
process.stdout.write(output);
