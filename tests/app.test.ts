import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import App from "../src/App";

test("empty app keeps file controls without section tabs or orphaned tab panels", () => {
  const markup = renderToStaticMarkup(createElement(App));
  assert.ok(markup.includes("No file selected"));
  assert.ok(markup.includes("Open FIT file"));
  assert.ok(markup.includes("Developer"));
  assert.ok(markup.includes("viewer-empty"));
  assert.ok(!markup.includes('role="tablist"'));
  assert.ok(!markup.includes('role="tabpanel"'));
  assert.ok(!markup.includes('aria-labelledby="tab-'));
  assert.ok(!markup.includes("viewer-tab-navigation"));
});
