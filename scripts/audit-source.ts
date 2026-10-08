import assert from "node:assert/strict";
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
const root = resolve("src");
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((e) =>
        e.isDirectory()
          ? files(resolve(directory, e.name))
          : [resolve(directory, e.name)],
      ),
    )
  ).flat();
}
const inventory = await files(root);
const original = new Set<string>();
const provenance = JSON.parse(
  await readFile("docs/source-provenance.json", "utf8"),
) as {
  originalPaths: string[];
  retainedStyles: Record<
    string,
    {
      origin: "local-ui-work";
      baselineSha256: string;
      sha256: string;
    }
  >;
};
for (const path of provenance.originalPaths) original.add(path);
const baselinePaths = execFileSync(
  "git",
  ["ls-tree", "-r", "--name-only", "a6ccaf7", "src"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n");
const report = {
  baseline: "a6ccaf7",
  originalPaths: Array.from(original).sort(),
  inheritedOrMixed: baselinePaths.filter((path) => original.has(path)),
  localOrReconstructed: baselinePaths.filter((path) => !original.has(path)),
  retained: ["workspace.css", "theme.css"],
  retainedStyles: provenance.retainedStyles,
  newFiles: inventory.map((path) => relative(root, path)),
};
const unchanged = [];
for (const path of inventory) {
  if (!/\.(ts|tsx|css)$/.test(path)) continue;
  const content = await readFile(path, "utf8");
  if (!report.retained.includes(relative(root, path))) {
    try {
      const before = execFileSync(
        "git",
        ["show", `a6ccaf7:src/${relative(root, path)}`],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      );
      if (before === content) unchanged.push(relative(root, path));
    } catch {}
  }
  assert.ok(
    !/makeGarminRequest|postMessageAsync|THUNDERFOREST_TOKEN|ESRI_TOKEN|ho_logo|buymeacoffee|paypal\.com|sendAnonymous/.test(
      content,
    ),
    `Legacy service or asset in ${path}`,
  );
  for (const match of content.matchAll(
    /(?:from\s*|import\s*\(|new URL\(\s*)['"](\.[^'"]+)['"]/g,
  )) {
    const target = resolve(dirname(path), match[1]);
    assert.ok(
      target.startsWith(root + "/") || target === root,
      `Import escapes rewritten runtime: ${path} -> ${match[1]}`,
    );
  }
}
assert.deepEqual(
  unchanged,
  [],
  "Unaudited baseline source was retained unchanged.",
);
for (const filename of report.retained) {
  const baseline = execFileSync("git", ["show", `a6ccaf7:src/${filename}`], {
    encoding: "utf8",
  });
  const approved = provenance.retainedStyles[filename];
  assert.equal(approved.origin, "local-ui-work");
  assert.ok(
    !original.has(`src/${filename}`),
    `Original source was misclassified: ${filename}`,
  );
  const hash = (content: string) =>
    createHash("sha256").update(content).digest("hex");
  assert.equal(hash(baseline), approved.baselineSha256);
  assert.equal(
    hash(await readFile(resolve(root, filename), "utf8")),
    approved.sha256,
    `Retained stylesheet changed without inventory update: ${filename}`,
  );
}
await mkdir(".cache", { recursive: true });
await writeFile(
  ".cache/source-inventory.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  `Source audit passed: ${inventory.length} rewrite files, no inherited runtime imports; ${report.inheritedOrMixed.length} baseline paths overlap original sourcemaps.`,
);
