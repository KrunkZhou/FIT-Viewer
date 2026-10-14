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
  assert.ok(
    render(summary).includes(
      `50:01:02 (${(2.08).toLocaleString(undefined, { minimumFractionDigits: 2 })} days)`,
    ),
  );
  summary.durationSeconds = 86400;
  assert.ok(!render(summary).includes(" days)"));
});

test("overview hourly size uses the same units and two decimals as file size", async () => {
  const summary = (await FitDocument.open(activity(1), "hourly.fit")).summary();
  summary.durationSeconds = 3600;
  for (const [bytes, unit] of [
    [1024, "KB"],
    [1024 ** 2, "MB"],
    [1024 ** 3, "GB"],
    [1024 ** 4, "TB"],
  ] as const) {
    const value = (1).toLocaleString(undefined, { minimumFractionDigits: 2 });
    assert.ok(
      render({ ...summary, bytes }).includes(
        `<dt>Size per hour</dt><dd>${value} ${unit}/hour (${bytes.toLocaleString()} bytes/hour)</dd>`,
      ),
    );
  }
});

test("overview formats file size with two decimals, unit thresholds and exact bytes", async () => {
  const summary = (await FitDocument.open(activity(1), "size.fit")).summary();
  const cases: [number, number, string][] = [
    [0, 0, "KB"],
    [1, 0, "KB"],
    [512, 0.5, "KB"],
    [1024, 1, "KB"],
    [3600, 3.52, "KB"],
    [1024 ** 2 - 1, 1024, "KB"],
    [1024 ** 2, 1, "MB"],
    [41_846_438, 39.91, "MB"],
    [1024 ** 3 - 1, 1024, "MB"],
    [1024 ** 3, 1, "GB"],
    [1024 ** 4 - 1, 1024, "GB"],
    [1024 ** 4, 1, "TB"],
    [1.25 * 1024 ** 4, 1.25, "TB"],
    [1024 ** 5, 1024, "TB"],
  ];
  for (const [bytes, size, unit] of cases) {
    const formatted = size.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    assert.ok(
      render({ ...summary, bytes }).includes(
        `<dt>File size</dt><dd>${formatted} ${unit} (${bytes.toLocaleString()} bytes)</dd>`,
      ),
      `File size for ${bytes} bytes`,
    );
  }
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

test("overview never shows GPS export buttons, including files with GPS positions", async () => {
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
    assert.equal(markup.includes("Download GeoJSON"), false);
    assert.equal(markup.includes("QGIS"), false);
    assert.equal(markup.includes("Export GPX"), false);
  }
});
