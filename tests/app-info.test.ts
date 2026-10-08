import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Popover from "@radix-ui/react-popover";
import { transformSync } from "esbuild";
import { readFileSync } from "node:fs";
import { version } from "../package.json";
import { APP_VERSION, GITHUB_URL } from "../src/app-info";
import { AppInfo, AppInfoDetails } from "../src/ui/AppInfo";

test("app icon is a named popup trigger with fixed dimensions", () => {
  const markup = renderToStaticMarkup(createElement(AppInfo));
  assert.match(markup, /aria-label="App information"/);
  assert.match(markup, /aria-haspopup="dialog"/);
  assert.match(markup, /icons\/icon-32\.png/);
  assert.match(markup, /width="32" height="32"/);
});

test("app information shows this build's version and a safe GitHub link", () => {
  const markup = renderToStaticMarkup(
    createElement(Popover.Root, null, createElement(AppInfoDetails)),
  );
  assert.equal(APP_VERSION, version);
  assert.ok(markup.includes(`Version ${version}`));
  assert.ok(markup.includes(`href="${GITHUB_URL}"`));
  assert.match(markup, /rel="noopener noreferrer"/);
  assert.match(markup, /aria-label="Close app information"/);
});

test("release builds embed their actual version without retaining the local fallback", () => {
  const source = readFileSync("src/app-info.ts", "utf8");
  const { code } = transformSync(source, {
    loader: "ts",
    define: { __APP_VERSION__: JSON.stringify("1.2.42") },
    minify: true,
  });
  assert.ok(code.includes('"1.2.42"'));
  assert.ok(!code.includes("__APP_VERSION__"));
});
