import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import {
  bundlePath,
  appNavigation,
  contentSecurityPolicy,
  externalLink,
} from "../electron/resources";

test("desktop resources stay inside the compiled bundle and removed pages are not served", () => {
  const root = resolve("desktop/dist");
  assert.equal(
    bundlePath("fitviewer://app/", root),
    resolve(root, "index.html"),
  );
  assert.equal(
    bundlePath("fitviewer://app/assets/chart.js?test=1", root),
    resolve(root, "assets/chart.js"),
  );
  for (const url of [
    "fitviewer://other/index.html",
    "fitviewer://app:123/index.html",
    "https://app/index.html",
    "fitviewer://user:pass@app/index.html",
    "fitviewer://app/develop",
    "fitviewer://app/develop/",
    "fitviewer://app/assets/%2e%2e/%2e%2e/package.json",
    "fitviewer://app/assets/..%5c..%5csecret",
    "fitviewer://app/assets/%00.js",
    "fitviewer://app/assets/%ff",
    "not a URL",
  ])
    assert.equal(bundlePath(url, root), undefined, url);
});

test("desktop navigation permits only the app and credential-free HTTPS external links", () => {
  assert.equal(appNavigation("fitviewer://app/?theme=dark#messages"), true);
  assert.equal(appNavigation("fitviewer://app/index.html"), true);
  for (const url of [
    "https://example.com",
    "fitviewer://app/develop",
    "fitviewer://other/",
    "file:///secret",
    "bad",
  ])
    assert.equal(appNavigation(url), false);
  assert.equal(externalLink("https://www.openstreetmap.org/copyright"), true);
  for (const url of [
    "file:///secret",
    "javascript:alert(1)",
    "http://example.com",
    "https://user:pass@example.com",
    "bad",
  ])
    assert.equal(externalLink(url), false);
});

test("desktop CSP hashes trusted inline initialization without permitting inline scripts", () => {
  const script = "document.documentElement.classList.add('dark');";
  const policy = contentSecurityPolicy(
    `<script>${script}</script><script src="/assets/app.js"></script>`,
  );
  assert.ok(
    policy.includes(
      `'sha256-${createHash("sha256").update(script).digest("base64")}'`,
    ),
  );
  const scripts = policy
    .split(";")
    .find((part) => part.trim().startsWith("script-src"))!;
  assert.ok(!scripts.includes("unsafe-inline"));
  assert.ok(!scripts.includes("unsafe-eval"));
  assert.ok(policy.includes("worker-src 'self' blob:"));
  assert.ok(policy.includes("object-src 'none'"));
});

function delayedRenderer(populateRows: boolean) {
  const { code } = transformSync(
    readFileSync(
      new URL("../electron/smoke-renderer.ts", import.meta.url),
      "utf8",
    ),
    {
      loader: "ts",
      format: "iife",
      globalName: "DesktopSmoke",
      target: "es2022",
    },
  );
  const rendererScript = runInNewContext(
    `${code}\nDesktopSmoke.checkRenderer.toString()`,
  );
  let stage = "open";
  let clock = 0;
  let rowPolls = 0;
  let chartPolls = 0;
  let rows = 0;
  const input = {
    files: undefined,
    dispatchEvent() {
      stage = "overview";
    },
  };
  const document = {
    title: "FIT Viewer",
    body: { textContent: "File overview" },
    querySelector(selector: string) {
      if (selector === 'input[type="file"]') return input;
      if (selector === "table") return {};
      if (selector === ".recharts-surface") return {};
      if (
        selector === ".recharts-surface path.recharts-curve" &&
        chartPolls >= 2
      )
        return { getAttribute: () => "M0,10L10,20" };
      return null;
    },
    querySelectorAll(selector: string) {
      if (selector === ".viewer-message-table table tbody tr")
        return Array.from({ length: rows });
      if (selector === '[role="tab"]')
        return [
          {
            textContent: "Messages",
            click: () => {
              stage = "messages";
            },
          },
          {
            textContent: "Chart",
            click() {
              assert.equal(rows, 20, "Chart opened before table data arrived");
              stage = "chart";
            },
          },
        ];
      return [];
    },
  };
  const context = {
    document,
    window: {},
    performance: { now: () => clock },
    Uint8Array,
    File: class {},
    Event: class {},
    DataTransfer: class {
      files = [];
      items = { add() {} };
    },
    setTimeout(callback: () => void) {
      clock += 25;
      if (stage === "messages") {
        rowPolls++;
        if (populateRows && rowPolls >= 3) rows = 20;
      }
      if (stage === "chart") chartPolls++;
      queueMicrotask(callback);
    },
    fetch: async (url: string) => {
      assert.equal(url, "/develop");
      return { status: 404 };
    },
  };
  return {
    run: () => runInNewContext(`(${rendererScript})([])`, context),
    polls: () => ({ rowPolls, chartPolls }),
  };
}

test("desktop smoke waits for worker-populated rows and chart data, not empty shells", async () => {
  const renderer = delayedRenderer(true);
  const result = await renderer.run();
  assert.equal(result.rows, 20);
  assert.equal(result.chart, true);
  assert.equal(result.nodeAccess, "undefined");
  assert.equal(result.removedStatus, 404);
  assert.deepEqual(renderer.polls(), { rowPolls: 3, chartPolls: 2 });
});

test("desktop smoke rejects a table whose worker never supplies rows", async () => {
  const renderer = delayedRenderer(false);
  await assert.rejects(renderer.run(), /20 populated message rows/);
  assert.equal(renderer.polls().chartPolls, 0);
});
