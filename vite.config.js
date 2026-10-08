import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  appType: "mpa",
  base: process.env.VITE_BASE_PATH || "/",
  plugins: [react()],
  server: { watch: { usePolling: true, interval: 300 } },
  build: {
    sourcemap: true,
  },
});
