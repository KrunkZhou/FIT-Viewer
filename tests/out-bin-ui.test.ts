import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { documentTabs, initialDocumentTab } from "../src/App";
import { FitDocument } from "../src/document/document";
import type { DocumentSummary } from "../src/model";
import type { OutBinAppEntry, OutBinInventory } from "../src/protocol/out-bin";
import {
  AppInventory,
  inventoryPage,
  unknownFieldValue,
} from "../src/ui/AppInventory";
import { Overview } from "../src/ui/Overview";
import { TableScroll } from "../src/ui/TableScroll";
import { activity } from "./fixtures";

function appEntry(index = 0): OutBinAppEntry {
  return {
    appId: `12345678-1234-5678-9012-${String(index).padStart(12, "0")}`,
    appIdHex: `12345678123456789012${String(index).padStart(12, "0")}`,
    appType: 2,
    name: `App ${index}`,
    disabled: false,
    unknownFields: [],
  };
}

function inventorySummary(): DocumentSummary {
  const inventory: OutBinInventory = {
    metadata: 18446744073709551615n,
    status: 0,
    entries: [appEntry()],
    unknownFields: { root: [], service: [], inventory: [] },
  };
  return {
    filename: "OUT.BIN",
    sources: [
      {
        id: 0,
        filename: "OUT.BIN",
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
    fileTypes: ["App inventory"],
    messages: [],
    subfiles: [],
    diagnostics: [],
    diagnosticCount: 0,
    hasMap: false,
    hasCharts: false,
    hasHrv: false,
    repairable: false,
    appInventories: [{ source: 0, filename: "OUT.BIN", inventory }],
  };
}

test("parsed OUT.BIN adds and selects inventory, including an empty inventory", async () => {
  const summary = inventorySummary();
  assert.deepEqual(
    documentTabs(summary).map((tab) => tab.id),
    ["overview", "inventory"],
  );
  assert.equal(initialDocumentTab(summary), "inventory");
  summary.appInventories![0].inventory.entries = [];
  assert.equal(initialDocumentTab(summary), "inventory");
  assert.ok(documentTabs(summary).some((tab) => tab.title === "App Inventory"));

  const fit = (await FitDocument.open(activity(2), "activity.fit")).summary();
  assert.ok(!documentTabs(fit).some((tab) => tab.id === "inventory"));
  assert.equal(initialDocumentTab(fit), "overview");
  const mixed = { ...fit, appInventories: summary.appInventories };
  assert.ok(documentTabs(mixed).some((tab) => tab.id === "messages"));
  assert.ok(documentTabs(mixed).some((tab) => tab.id === "inventory"));
  assert.equal(initialDocumentTab(mixed), "overview");
  const settings: DocumentSummary = {
    ...summary,
    appInventories: [],
    ciqSettings: [
      {
        source: 1,
        filename: "app.SET",
        settings: { type: "dictionary" as const, entries: [] },
      },
    ],
  };
  assert.equal(initialDocumentTab(settings), "settings");
  settings.appInventories = summary.appInventories!;
  assert.equal(
    initialDocumentTab(settings),
    "overview",
    "Mixed SET and OUT.BIN selections open the overview",
  );
});

test("unparsed inventories expose diagnostics without an inventory section", () => {
  const summary = inventorySummary();
  summary.appInventories = [];
  summary.sources[0].error = "Invalid OUT.BIN";
  summary.diagnosticCount = 1;
  assert.deepEqual(
    documentTabs(summary).map((tab) => tab.id),
    ["overview", "diagnostics"],
  );
  assert.equal(initialDocumentTab(summary), "overview");
});

test("inventory renders safe names, UUIDs, types, optional flags and exact integer metadata", () => {
  const files = inventorySummary().appInventories!;
  files[0].inventory.entries = [
    {
      ...appEntry(1),
      appType: 1,
      favorite: true,
      version: 0,
      filename: "<script>.PRG",
      fileSize: 18446744073709551615n,
      nativeType: 0,
    },
    { ...appEntry(2), appType: 2, favorite: false, disabled: true },
    { ...appEntry(3), appType: 3, name: "<img onerror=alert(1)>" },
    { ...appEntry(4), appType: 8 },
    { ...appEntry(5), appType: 99 },
  ];
  files[0].inventory.unknownFields.root = [
    { number: 7, wireType: 2, bytes: new Uint8Array(300) },
  ];
  const markup = renderToStaticMarkup(createElement(AppInventory, { files }));
  assert.ok(markup.includes('aria-label="Apps in OUT.BIN"'));
  assert.ok(
    markup.includes('aria-label="Scrollable app inventory in OUT.BIN"'),
  );
  assert.ok(markup.includes('aria-label="Search apps in OUT.BIN"'));
  assert.ok(markup.includes("5 apps"));
  assert.ok(markup.includes("12345678-1234-5678-9012-000000000001"));
  for (const type of [
    "Watch app (1)",
    "Widget / glance (2)",
    "Watch face (3)",
    "Activity (8)",
    "Unknown (99)",
  ])
    assert.ok(markup.includes(type), type);
  assert.ok(markup.includes("&lt;img onerror=alert(1)&gt;"));
  assert.ok(markup.includes("&lt;script&gt;.PRG"));
  assert.ok(!markup.includes("<img"));
  assert.ok(!markup.includes("<script"));
  assert.ok(
    markup.includes("<dt>Inventory field 1</dt><dd>18446744073709551615</dd>"),
  );
  assert.ok(markup.includes("<dt>Inventory field 2</dt><dd>0</dd>"));
  assert.ok(
    markup.includes("<dt>File size</dt><dd>18446744073709551615 bytes</dd>"),
  );
  assert.ok(markup.includes("<dt>Version</dt><dd>0</dd>"));
  assert.ok(markup.includes("<dt>Native ID</dt><dd>0</dd>"));
  assert.ok(markup.includes("<dt>File size</dt><dd>-</dd>"));
  assert.match(
    markup,
    /Widget \/ glance \(2\)<\/td>.*?<td>No<\/td><td>No<\/td>/,
  );
  assert.match(markup, /Unknown \(99\)<\/td>.*?<td>Yes<\/td><td>-<\/td>/);
  assert.ok(markup.includes("Unknown fields (1)"));
  assert.ok(
    !markup.includes('aria-label="Unknown inventory fields"'),
    "Unknown fields are rendered when expanded",
  );
  assert.ok(!markup.includes("Timestamp"));
});

test("empty inventory remains visible with per-file metadata", () => {
  const files = inventorySummary().appInventories!;
  files[0].inventory.entries = [];
  files.push({
    source: 1,
    filename: "another/OUT.BIN",
    inventory: { ...files[0].inventory, metadata: 7n, status: 9 },
  });
  const markup = renderToStaticMarkup(createElement(AppInventory, { files }));
  assert.ok(markup.includes("2 inventory files"));
  assert.ok(markup.includes("another/OUT.BIN"));
  assert.ok(markup.includes("No apps in this inventory."));
  assert.ok(markup.includes("<dt>Inventory field 1</dt><dd>7</dd>"));
  assert.ok(markup.includes("<dt>Inventory field 2</dt><dd>9</dd>"));
});

test("large inventories limit rendered rows and retain search and final-page access", () => {
  const files = inventorySummary().appInventories!;
  const entries = Array.from({ length: 10_000 }, (_, index) => appEntry(index));
  files[0].inventory.entries = entries;
  const markup = renderToStaticMarkup(createElement(AppInventory, { files }));
  assert.equal((markup.match(/scope="row"/g) ?? []).length, 50);
  assert.ok(markup.includes("1-50 of 10,000"));
  assert.ok(markup.includes('aria-label="Last page"'));
  assert.ok(!markup.includes("App 9999</th>"));
  const final = inventoryPage(entries, "", 199, 50);
  assert.equal(final.rows.length, 50);
  assert.equal(final.rows.at(-1)?.name, "App 9999");
  const search = inventoryPage(entries, "  APP 9999  ", 199, 50);
  assert.equal(search.page, 0);
  assert.equal(search.total, 1);
  assert.equal(search.rows[0].name, "App 9999");
  const uuid = inventoryPage(entries, entries[9999].appId.toUpperCase(), 0, 50);
  assert.equal(uuid.rows[0].name, "App 9999");
  const noMatch = inventoryPage(entries, "not in this inventory", 199, 50);
  assert.equal(noMatch.page, 0);
  assert.equal(noMatch.pages, 1);
  assert.deepEqual(noMatch.rows, []);
});

test("unknown field previews preserve varints and bound opaque bytes", () => {
  assert.equal(
    unknownFieldValue({ number: 7, wireType: 0, value: 18446744073709551615n }),
    "18446744073709551615",
  );
  const preview = unknownFieldValue({
    number: 8,
    wireType: 2,
    bytes: Uint8Array.from({ length: 100 }, (_, index) => index),
  });
  assert.ok(preview.startsWith("100 bytes: 00 01 02"));
  assert.ok(preview.endsWith("1e 1f …"));
  assert.ok(!preview.includes("20 21"));
  assert.equal(
    unknownFieldValue({
      number: 9,
      wireType: 1,
      bytes: new Uint8Array([255, 0]),
    }),
    "2 bytes: ff 00",
  );
  const defaultScroll = renderToStaticMarkup(
    createElement(TableScroll, { children: "table" }),
  );
  assert.ok(defaultScroll.includes('aria-label="Scrollable message table"'));
});

test("inventory-only overview has app counts without empty FIT metrics", () => {
  const markup = renderToStaticMarkup(
    createElement(Overview, {
      summary: inventorySummary(),
      diagnostics: () => {},
    }),
  );
  assert.ok(markup.includes("<dt>Inventory files</dt><dd>1</dd>"));
  assert.ok(markup.includes("<dt>Apps</dt><dd>1</dd>"));
  for (const label of [
    "Start - end time",
    "GPS points",
    "Activity records",
    "Profile version",
    "Size per hour",
  ])
    assert.ok(!markup.includes(label), label);
});

test("mixed overview reports inventory source app counts alongside FIT and settings", async () => {
  const summary = (
    await FitDocument.open(activity(2), "activity.fit")
  ).summary();
  const inventory = inventorySummary();
  inventory.appInventories![0].source = 1;
  inventory.sources[0].id = 1;
  summary.appInventories = inventory.appInventories;
  summary.sources.push(inventory.sources[0]);
  summary.ciqSettings = [
    {
      source: 2,
      filename: "app.SET",
      settings: { type: "dictionary", entries: [] },
    },
  ];
  summary.sources.push({
    id: 2,
    filename: "app.SET",
    bytes: 17,
    start: 100,
    end: 117,
    records: 0,
  });
  const markup = renderToStaticMarkup(
    createElement(Overview, { summary, diagnostics: () => {} }),
  );
  assert.ok(markup.includes("<dt>Apps</dt><dd>1</dd>"));
  assert.ok(markup.includes("<dt>Activity records</dt>"));
  assert.match(
    markup,
    /<td title="OUT.BIN">OUT.BIN<\/td><td>100 bytes<\/td><td>-<\/td><td>-<\/td><td>1<\/td>/,
  );
  assert.match(
    markup,
    /<td title="app.SET">app.SET<\/td><td>17 bytes<\/td><td>-<\/td><td>0<\/td><td>-<\/td>/,
  );
});
