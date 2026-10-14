import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { documentTabs, initialDocumentTab } from "../src/App";
import { FitDocument } from "../src/document/document";
import type { DocumentSummary } from "../src/model";
import type { CiqDictionary } from "../src/protocol/ciq-settings";
import { CiqSettings } from "../src/ui/CiqSettings";
import { Overview } from "../src/ui/Overview";
import { activity } from "./fixtures";

const settings: CiqDictionary = {
  type: "dictionary",
  entries: [
    {
      key: { type: "string", value: "Enabled" },
      value: { type: "boolean", value: true },
    },
    {
      key: { type: "string", value: "Exact long" },
      value: { type: "long", value: 9223372036854775807n },
    },
    {
      key: { type: "string", value: "Label <img>" },
      value: { type: "string", value: '<script>alert("test")</script>' },
    },
    {
      key: { type: "string", value: "Nested" },
      value: {
        type: "array",
        items: [
          { type: "integer", value: 42 },
          { type: "float", value: 0.5 },
          { type: "double", value: 1.25 },
          { type: "null", value: null },
          {
            type: "dictionary",
            entries: [
              {
                key: { type: "integer", value: 7 },
                value: { type: "boolean", value: false },
              },
            ],
          },
          { type: "array", items: [] },
          { type: "dictionary", entries: [] },
        ],
      },
    },
  ],
};

function settingsSummary(): DocumentSummary {
  return {
    filename: "app.SET",
    sources: [
      {
        id: 0,
        filename: "app.SET",
        bytes: 100,
        start: 0,
        end: 100,
        records: 0,
      },
    ],
    bytes: 100,
    records: 0,
    gpsPoints: 0,
    availableDates: [],
    sports: [],
    fileTypes: ["CIQ settings"],
    messages: [],
    subfiles: [],
    diagnostics: [],
    diagnosticCount: 0,
    hasMap: false,
    hasCharts: false,
    hasHrv: false,
    repairable: false,
    ciqSettings: [{ source: 0, filename: "app.SET", settings }],
  };
}

test("successfully parsed SET files add a settings section and open it for settings-only selections", async () => {
  const summary = settingsSummary();
  assert.deepEqual(
    documentTabs(summary).map((tab) => tab.id),
    ["overview", "settings"],
  );
  assert.equal(initialDocumentTab(summary), "settings");
  summary.ciqSettings![0].settings = { type: "dictionary", entries: [] };
  assert.equal(
    initialDocumentTab(summary),
    "settings",
    "An empty parsed dictionary is still a settings file",
  );

  const fitSummary = (
    await FitDocument.open(activity(2), "activity.fit")
  ).summary();
  assert.ok(documentTabs(fitSummary).some((tab) => tab.id === "messages"));
  assert.ok(!documentTabs(fitSummary).some((tab) => tab.id === "settings"));
  assert.equal(initialDocumentTab(fitSummary), "overview");
  const mixed = { ...fitSummary, ciqSettings: settingsSummary().ciqSettings };
  assert.ok(documentTabs(mixed).some((tab) => tab.id === "messages"));
  assert.ok(documentTabs(mixed).some((tab) => tab.id === "settings"));
  assert.equal(initialDocumentTab(mixed), "overview");
});

test("failed SET sources do not expose a settings or FIT messages section", () => {
  const summary = settingsSummary();
  summary.ciqSettings = [];
  summary.sources[0].error = "Invalid settings file";
  summary.diagnosticCount = 1;
  assert.deepEqual(
    documentTabs(summary).map((tab) => tab.id),
    ["overview", "diagnostics"],
  );
  assert.equal(initialDocumentTab(summary), "overview");
});

test("CIQ settings render safe typed values and preserve exact longs and nested structures", () => {
  const markup = renderToStaticMarkup(
    createElement(CiqSettings, { files: settingsSummary().ciqSettings! }),
  );
  assert.ok(markup.includes('aria-label="Settings in app.SET"'));
  assert.ok(markup.includes("Property</th>"));
  assert.ok(markup.includes("Type</th>"));
  assert.ok(markup.includes("Value</th>"));
  assert.ok(markup.includes("4 properties"));
  assert.ok(markup.includes("9223372036854775807"));
  assert.ok(!markup.includes("9223372036854776000"));
  assert.ok(markup.includes("Label &lt;img&gt;"));
  assert.ok(markup.includes("&lt;script&gt;"));
  assert.ok(!markup.includes("<script>"));
  for (const type of [
    "boolean",
    "long",
    "string",
    "array",
    "integer",
    "float",
    "double",
    "null",
    "dictionary",
  ]) {
    assert.ok(markup.includes(`>${type}</`), type);
  }
  for (const value of [
    "true",
    "false",
    "42",
    "0.5",
    "1.25",
    "null",
    "7",
    "[]",
    "{}",
  ]) {
    assert.ok(markup.includes(`>${value}</`), value);
  }
  assert.ok(markup.includes('start="0"'));
});

test("CIQ settings keep each source filename and empty settings dictionaries visible", () => {
  const files = settingsSummary().ciqSettings!;
  files.push({
    source: 1,
    filename: "another.SET",
    settings: { type: "dictionary", entries: [] },
  });
  const markup = renderToStaticMarkup(createElement(CiqSettings, { files }));
  assert.ok(markup.includes("2 settings files"));
  assert.ok(markup.includes("app.SET"));
  assert.ok(markup.includes("another.SET"));
  assert.ok(markup.includes('aria-label="Settings in another.SET"'));
  assert.ok(markup.includes("0 properties"));
  assert.ok(markup.includes("No settings properties in this file."));
});

test("settings-only overview counts parsed files and properties without empty FIT metrics", () => {
  const markup = renderToStaticMarkup(
    createElement(Overview, {
      summary: settingsSummary(),
      diagnostics: () => {},
    }),
  );
  assert.ok(markup.includes("<dt>Settings files</dt><dd>1</dd>"));
  assert.ok(markup.includes("<dt>Settings properties</dt><dd>4</dd>"));
  assert.ok(markup.includes("<dt>Filename</dt><dd>app.SET</dd>"));
  for (const label of [
    "Start - end time",
    "GPS points",
    "Activity records",
    "Profile version",
    "Size per hour",
  ]) {
    assert.ok(!markup.includes(label), label);
  }
});

test("mixed overview reports settings counts beside FIT records in the source table", async () => {
  const summary = (
    await FitDocument.open(activity(2), "activity.fit")
  ).summary();
  const ciq = settingsSummary();
  ciq.ciqSettings![0].source = 1;
  ciq.sources[0].id = 1;
  summary.ciqSettings = ciq.ciqSettings;
  summary.sources.push(ciq.sources[0]);
  const markup = renderToStaticMarkup(
    createElement(Overview, { summary, diagnostics: () => {} }),
  );
  assert.ok(markup.includes("<dt>Settings properties</dt><dd>4</dd>"));
  assert.ok(markup.includes("<dt>Activity records</dt>"));
  assert.match(
    markup,
    /<td title="app.SET">app.SET<\/td><td>100 bytes<\/td><td>-<\/td><td>4<\/td>/,
  );
});
