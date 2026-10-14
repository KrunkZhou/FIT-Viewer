import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chartHoverTime, ChartHoverStore } from "../src/ui/chart-hover";
import { ChartHoverCursor } from "../src/ui/ChartHoverCursor";

test("shared hover uses timestamps, preserves zero and fractional values, and rejects inactive or invalid cursors", () => {
  assert.equal(chartHoverTime(0, true, [0, 10]), 0);
  assert.equal(chartHoverTime("3.25", true, [0, 10]), 3.25);
  for (const value of [
    undefined,
    null,
    "",
    " ",
    "bad",
    NaN,
    Infinity,
    {},
    -1,
    11,
  ])
    assert.equal(chartHoverTime(value, true, [0, 10]), undefined);
  assert.equal(chartHoverTime(5, false, [0, 10]), undefined);
});

test("cursor subscribers update together without notifying unchanged times and release subscriptions", () => {
  const store = new ChartHoverStore();
  const first: (number | undefined)[] = [];
  const second: (number | undefined)[] = [];
  const unsubscribeFirst = store.subscribe(() =>
    first.push(store.getSnapshot()),
  );
  const unsubscribeSecond = store.subscribe(() =>
    second.push(store.getSnapshot()),
  );
  store.update(0, true, [0, 10]);
  store.update(0, true, [0, 10]);
  store.update(3.25, true, [0, 10]);
  store.clear();
  assert.deepEqual(first, [0, 3.25, undefined]);
  assert.deepEqual(second, first);
  unsubscribeFirst();
  store.update(10, true, [0, 10]);
  assert.deepEqual(first, [0, 3.25, undefined]);
  assert.equal(second.at(-1), 10);
  unsubscribeSecond();
  store.clear();
  assert.equal(second.at(-1), 10);
});

test("shared cursor draws at the same scaled time despite different data coverage, and never adds tooltip values", () => {
  const store = new ChartHoverStore();
  store.update(3.25, true, [0, 10]);
  const props = {
    store,
    domain: [0, 10] as [number, number],
    xAxisMap: { "0": { scale: (time: number) => 100 + time * 2 } },
    offset: { left: 100, width: 20, top: 5, height: 80 },
  };
  const markup = renderToStaticMarkup(createElement(ChartHoverCursor, props));
  assert.match(markup, /data-time="3.25" x1="106.5" x2="106.5" y1="5" y2="85"/);
  assert.match(markup, /pointer-events="none" aria-hidden="true"/);
  assert.ok(!markup.includes("tooltip"));
  assert.equal(
    renderToStaticMarkup(
      createElement(ChartHoverCursor, { ...props, domain: [4, 10] }),
    ),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChartHoverCursor, { ...props, xAxisMap: undefined }),
    ),
    "",
  );
  store.clear();
  assert.equal(
    renderToStaticMarkup(createElement(ChartHoverCursor, props)),
    "",
  );
});
