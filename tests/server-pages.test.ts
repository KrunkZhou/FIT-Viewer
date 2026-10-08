import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

test("the root page loads while removed and missing pages return 404 without redirects", async () => {
  const server = await createServer({
    configFile: fileURLToPath(new URL("../vite.config.js", import.meta.url)),
    logLevel: "silent",
    server: {
      host: "127.0.0.1",
      hmr: false,
      watch: null,
    },
  });
  try {
    // Listen directly so the OS chooses a port instead of Vite's default.
    const listening = once(server.httpServer!, "listening");
    server.httpServer!.listen(0, "127.0.0.1");
    await listening;
    const address = server.httpServer!.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const root = await fetch(base, { redirect: "manual" });
    assert.equal(root.status, 200);
    assert.match(await root.text(), /src\/main\.tsx/);
    for (const path of ["/develop", "/develop/", "/develop?test=1", "/missing"])
      for (const method of ["GET", "HEAD"]) {
        const response = await fetch(base + path, { method, redirect: "manual" });
        assert.equal(response.status, 404, `${method} ${path}`);
        assert.equal(response.headers.get("location"), null);
        await response.arrayBuffer();
      }
  } finally {
    await server.close();
  }
});
