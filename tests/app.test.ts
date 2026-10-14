import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/App";

test("empty app keeps file controls without section tabs or orphaned tab panels", () => {
  const markup = renderToStaticMarkup(createElement(App));
  assert.ok(markup.includes("<h2>FIT Viewer</h2>"));
  assert.ok(markup.includes("Drop or open FIT or SET files here"));
  assert.ok(markup.includes('accept=".fit,.set,.zip"'));
  assert.ok(markup.includes('aria-label="Open FIT or SET file"'));
  assert.ok(markup.includes("viewer-drop-button"));
  assert.ok(!markup.includes('class="open-file"'));
  assert.ok(markup.includes("Developer"));
  assert.ok(markup.includes('aria-label="App information"'));
  assert.ok(markup.includes("viewer-empty"));
  assert.ok(!markup.includes('role="tablist"'));
  assert.ok(!markup.includes('role="tabpanel"'));
  assert.ok(!markup.includes('aria-labelledby="tab-'));
  assert.ok(!markup.includes("viewer-tab-navigation"));
});
