import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitDocument } from "../src/document/document";
import type { DocumentSummary } from "../src/model";
import { FIT_EPOCH } from "../src/protocol/time";
import { Overview } from "../src/ui/Overview";
import { Toggle } from "../src/ui/controls";
import { activity, file, join } from "./fixtures";

function render(summary: DocumentSummary): string {
  return renderToStaticMarkup(
    createElement(Overview, {
      summary,
      diagnostics: () => {},
      download: () => {},
    }),
  );
}

test("overview timestamp bounds ignore missing timestamps and non-activity messages", async () => {
  const source = join([
    file([
      { message: 20, fields: [[253, 6, 120]] },
      { message: 20, fields: [[253, 6, 0xffffffff]] },
      { message: 20, fields: [[253, 6, 60]] },
      { message: 21, fields: [[253, 6, 9999]] },
    ]),
    file([{ message: 20, fields: [[253, 6, 180]] }]),
  ]);
  const original = source.slice();
  const document = await FitDocument.open(source, "bounds.fit");
  assert.equal(document.summary().startTimestamp, 60);
  assert.equal(document.summary().endTimestamp, 180);
  assert.deepEqual(source, original);
});

test("overview shows elapsed duration, both timestamps and hourly file size without removed content", async () => {
  const summary = (
    await FitDocument.open(activity(180), "overview.fit")
  ).summary();
  summary.bytes = 3600;
  summary.endTimestamp = summary.startTimestamp! + 7200;
  summary.durationSeconds = 7200;
  summary.diagnosticCount = 0;
  const markup = render(summary);
  assert.ok(markup.includes("Start - end time"));
  assert.ok(
    markup.includes(
      new Date(FIT_EPOCH + summary.startTimestamp! * 1000).toISOString(),
    ),
  );
  assert.ok(
    markup.includes(
      new Date(FIT_EPOCH + summary.endTimestamp * 1000).toISOString(),
    ),
  );
  assert.ok(markup.includes("02:00:00"));
  assert.ok(markup.includes(`${summary.bytes.toLocaleString()} bytes`));
  assert.ok(markup.includes(`${(1800).toLocaleString()} bytes/hour`));
  assert.ok(markup.includes("Size per hour"));
  for (const removed of [
    "Manufacturer",
    "Product",
    "Message types",
    "View messages",
    "No issues detected",
    "viewer-status",
  ]) {
    assert.ok(!markup.includes(removed), removed);
  }
});

test("overview handles zero, missing and multi-day durations without infinite hourly sizes", async () => {
  const summary = (await FitDocument.open(activity(1), "short.fit")).summary();
  assert.ok(render(summary).includes("00:00:00"));
  assert.ok(render(summary).includes("<dt>Size per hour</dt><dd>-</dd>"));
  summary.endTimestamp = undefined;
  summary.durationSeconds = undefined;
  assert.ok(render(summary).includes("<dd>-</dd>"));
  assert.ok(!render(summary).includes("NaN"));
  summary.endTimestamp = summary.startTimestamp! + 50 * 3600 + 62;
  summary.durationSeconds = 50 * 3600 + 62;
  assert.ok(render(summary).includes("50:01:02"));
});

test("overview retains the issue banner and switches expose their description", async () => {
  const summary = (await FitDocument.open(activity(1), "issues.fit")).summary();
  summary.diagnosticCount = 1;
  assert.match(render(summary), /1 issue detected/);
  assert.ok(render(summary).includes("viewer-status-warning"));
  summary.diagnosticCount = 2;
  assert.match(render(summary), /2 issues detected/);
  const markup = renderToStaticMarkup(
    createElement(Toggle, {
      label: "Developer Mode",
      checked: false,
      onChange: () => {},
      descriptionId: "developer-mode-help",
    }),
  );
  assert.ok(markup.includes('aria-describedby="developer-mode-help"'));
});

test("overview hides GPS exports without usable positions and restores them for GPS files", async () => {
  for (const fields of [
    [[3, 2, 120]],
    [
      [0, 5, 0x7fffffff],
      [1, 5, 0x7fffffff],
    ],
    [
      [0, 5, 0],
      [1, 5, 0],
    ],
  ] as import("./fixtures").Field[][]) {
    const summary = (
      await FitDocument.open(
        file([{ message: 20, fields }], false),
        "positions.fit",
      )
    ).summary();
    const markup = render(summary);
    assert.equal(markup.includes("QGIS GeoJSON"), summary.hasMap);
    assert.equal(markup.includes("Export GPX"), summary.hasMap);
  }
});
