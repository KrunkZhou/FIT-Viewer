import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildVersion } from "./scripts/build-version";

const metadata = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

export default defineConfig({
  appType: "mpa",
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(
      buildVersion({
        cwd: fileURLToPath(new URL(".", import.meta.url)),
        packageVersion: metadata.version,
        releaseVersion: process.env.RELEASE_VERSION,
      }),
    ),
  },
  server: { watch: { usePolling: true, interval: 300 } },
  build: {
    sourcemap: true,
  },
});
