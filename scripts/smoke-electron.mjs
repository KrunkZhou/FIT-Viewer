import { build } from "esbuild";
import electron from "electron";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";

await mkdir(".cache", { recursive: true });
await build({
  entryPoints: ["electron/smoke.ts"],
  outfile: ".cache/electron-smoke.cjs",
  platform: "node",
  format: "cjs",
  bundle: true,
  external: ["electron"],
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [".cache/electron-smoke.cjs"], {
  stdio: "inherit",
  env,
});
const timeout = setTimeout(() => child.kill(), 45000);
child.on("error", (error) => {
  console.error(error);
  clearTimeout(timeout);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  clearTimeout(timeout);
  if (code !== 0)
    console.error("Electron exited before smoke success", { code, signal });
  process.exitCode = code ?? 1;
});
