import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DocumentClient } from "../src/document/client";
import Charts from "../src/ui/Charts";
import { LoadingIndicator } from "../src/ui/controls";

test("loading icons have accessible status labels and decorative SVGs", () => {
  for (const label of [
    "Loading chart data",
    "Loading map data",
    "Loading map tiles",
  ]) {
    const markup = renderToStaticMarkup(
      createElement(LoadingIndicator, { label }),
    );
    assert.ok(markup.includes(`role="status" aria-label="${label}"`));
    assert.match(markup, /<svg[^>]+aria-hidden="true"/);
    assert.ok(markup.includes("spin"));
  }
});

test("charts show an initial spinner instead of a premature empty state", () => {
  const markup = renderToStaticMarkup(
    createElement(Charts, {
      client: new DocumentClient(),
      developer: false,
      download() {},
      active: true,
    }),
  );
  assert.ok(markup.includes('aria-label="Loading chart data"'));
  assert.ok(markup.includes('aria-busy="true"'));
  assert.ok(!markup.includes("No sensors selected."));
  assert.ok(markup.includes("viewer-chart-plots"));
});
