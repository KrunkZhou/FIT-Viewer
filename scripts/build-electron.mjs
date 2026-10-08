import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { valid } from "semver";

const metadata = JSON.parse(await readFile("package.json", "utf8"));
const version = process.env.RELEASE_VERSION || metadata.version;
if (valid(version) !== version)
  throw new Error(`Invalid desktop version: ${version}`);
await rm("desktop", { recursive: true, force: true });
await mkdir("desktop", { recursive: true });
await cp("dist", "desktop/dist", {
  recursive: true,
  filter: (path) => !path.endsWith(".map"),
});
await build({
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
  outdir: "desktop",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
});
await writeFile(
  "desktop/package.json",
  JSON.stringify(
    {
      name: metadata.name,
      version,
      description: metadata.description,
      private: true,
      main: "main.cjs",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Staged FIT Viewer ${version} with no renderer node_modules or sourcemaps.`,
);
