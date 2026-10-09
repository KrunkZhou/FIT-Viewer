import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface DependencyNode {
  path: string;
  dependencies?: Record<string, DependencyNode>;
  optionalDependencies?: Record<string, DependencyNode>;
}
// Read the installed graph rather than depending on pnpm's global store index.
const projects = JSON.parse(
  execFileSync("pnpm", ["list", "--prod", "--depth", "Infinity", "--json"], {
    encoding: "utf8",
  }),
) as DependencyNode[];
const roots = new Set<string>();
function collect(node: DependencyNode): void {
  for (const child of Object.values({
    ...node.dependencies,
    ...node.optionalDependencies,
  })) {
    roots.add(child.path);
    collect(child);
  }
}
for (const project of projects) collect(project);
const dependencies = new Map<
  string,
  {
    name: string;
    version: string;
    license: string;
    homepage?: string;
    root: string;
  }
>();
for (const root of roots) {
  const metadata = JSON.parse(
    await readFile(resolve(root, "package.json"), "utf8"),
  );
  dependencies.set(`${metadata.name}@${metadata.version}`, {
    ...metadata,
    root,
  });
}
async function notices(directory: string, depth = 0): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (
      entry.isFile() &&
      /^(licen[cs]e|copying|notice)(\.|$|-|_)/i.test(entry.name)
    )
      found.push(path);
    else if (entry.isDirectory() && entry.name !== "node_modules" && depth < 4)
      found.push(...(await notices(path, depth + 1)));
  }
  return found.sort();
}
const output = [
  "Third-party dependency notices",
  "Generated from installed production dependencies. Original license texts follow.",
];
let count = 0;
for (const dependency of [...dependencies.values()].sort((a, b) =>
  a.name.localeCompare(b.name),
)) {
  output.push(
    `\n${"=".repeat(72)}\n${dependency.name} ${dependency.version}\nLicense: ${dependency.license ?? "See license text"}\n${dependency.homepage ?? ""}`,
  );
  const root = dependency.root;
  for (const path of await notices(root))
    output.push(`\n${relative(root, path)}\n${await readFile(path, "utf8")}`);
  count++;
}
await mkdir("public", { recursive: true });
await writeFile("public/THIRD_PARTY_NOTICES.txt", output.join("\n") + "\n");
console.log(`Preserved original notices for ${count} production dependencies.`);
