import { execFileSync } from "node:child_process";

export function buildVersion({
  cwd,
  packageVersion,
  releaseVersion,
}: {
  cwd: string;
  packageVersion: string;
  releaseVersion?: string;
}): string {
  if (releaseVersion) return releaseVersion;
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const stableTag = (tags: string) =>
    tags.split("\n").find((tag) => /^v\d+\.\d+\.\d+$/.test(tag));
  try {
    const exact = stableTag(
      git("tag", "--points-at", "HEAD", "--sort=-version:refname"),
    );
    if (exact) return exact.slice(1);
    const commit = git("rev-parse", "--short=8", "HEAD");
    const base = stableTag(
      git("tag", "--merged", "HEAD", "--sort=-version:refname"),
    );
    // Pages can build before the parallel desktop release creates its tag.
    if (base) {
      const count = git("rev-list", "--count", `${base}..HEAD`);
      return `${base.slice(1)}+${count}.${commit}`;
    }
    return `${packageVersion === "0.0.0" ? "dev" : packageVersion}+${commit}`;
  } catch {
    return packageVersion === "0.0.0" ? "development" : packageVersion;
  }
}
