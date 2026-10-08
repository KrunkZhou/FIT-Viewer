import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, relative } from "node:path";

interface PackageNotice {
  name: string;
  versions: string[];
  paths: string[];
  license: string;
  homepage?: string;
}
const grouped = JSON.parse(
  execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
  }),
) as Record<string, PackageNotice[]>;
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
for (const dependency of Object.values(grouped)
  .flat()
  .sort((a, b) => a.name.localeCompare(b.name))) {
  output.push(
    `\n${"=".repeat(72)}\n${dependency.name} ${dependency.versions.join(", ")}\nLicense: ${dependency.license}\n${dependency.homepage ?? ""}`,
  );
  const root = dependency.paths[0];
  for (const path of await notices(root))
    output.push(`\n${relative(root, path)}\n${await readFile(path, "utf8")}`);
  count++;
}
await mkdir("public", { recursive: true });
await writeFile("public/THIRD_PARTY_NOTICES.txt", output.join("\n") + "\n");
console.log(`Preserved original notices for ${count} production dependencies.`);
