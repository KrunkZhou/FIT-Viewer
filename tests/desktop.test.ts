import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
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
