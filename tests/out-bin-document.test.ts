import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { activity } from "./fixtures";
import { syntheticSettings } from "./ciq-fixtures";
import { outBinFixture } from "./out-bin-fixtures";

test("standalone OUT.BIN opens an app inventory without FIT or SET records", async () => {
  const document = await FitDocument.open(outBinFixture(), "OUT.BIN");
  const summary = document.summary();
  assert.equal(summary.appInventories?.length, 1);
  assert.equal(summary.appInventories?.[0].inventory.entries.length, 5);
  assert.equal(summary.ciqSettings, undefined);
  assert.equal(summary.records, 0);
  assert.equal(summary.hasCharts, false);
  assert.equal(summary.hasMap, false);
  assert.equal(summary.diagnosticCount, 0);
  assert.equal(summary.repairable, false);
  assert.deepEqual(summary.fileTypes, ["Garmin app inventory"]);
  await assert.rejects(
    exportDocument(document, { format: "fit" }),
    /cannot be repaired/,
  );
});

test("mixed FIT, SET, and OUT.BIN sources retain offsets and independent views", async () => {
  const inventory = outBinFixture();
  const settings = syntheticSettings();
  const fit = activity(32);
  const document = await FitDocument.openSources(
    [
      { filename: "GARMIN/Apps/OUT.BIN", bytes: inventory },
      { filename: "GARMIN/Apps/SETTINGS/app.SET", bytes: settings },
      { filename: "GARMIN/Activity/run.fit", bytes: fit },
    ],
    "Garmin",
  );
  const summary = document.summary();
  assert.equal(summary.sources.length, 3);
  assert.equal(summary.appInventories?.[0].source, 0);
  assert.equal(summary.ciqSettings?.[0].source, 1);
  assert.equal(summary.subfiles[0].source, 2);
  assert.equal(summary.sources[2].start, inventory.length + settings.length);
  assert.equal(document.recordIds(20, 2).length, 32);
  assert.equal(document.recordIds(20, 0).length, 0);
  const query = { message: 20, page: 0, size: 20, developer: false };
  const baseline = await FitDocument.open(fit, "run.fit");
  const expected = await baseline.table(query);
  const combined = await document.table(query);
  assert.deepEqual(
    combined.rows.map((row) => row.cells),
    expected.rows.map((row) => row.cells),
  );
  assert.equal(summary.hasMap, true);
});

test("invalid OUT.BIN fails alone and produces source diagnostics in a mixed import", async () => {
  const bad = new Uint8Array([0x1a, 0x80]);
  await assert.rejects(FitDocument.open(bad, "out.bin"));
  const document = await FitDocument.openSources(
    [
      { filename: "run.fit", bytes: activity(12) },
      { filename: "OUT.BIN", bytes: bad },
    ],
    "Mixed",
  );
  const summary = document.summary();
  assert.equal(summary.appInventories, undefined);
  assert.ok(summary.sources[1].error);
  assert.ok(
    summary.diagnostics.some(
      (issue) => issue.source === 1 && issue.code === "unreadable-file",
    ),
  );
  assert.equal(document.recordIds(20).length, 12);
});

test("workspace display names cannot change the source decoder", async () => {
  const fit = await FitDocument.openSources(
    [{ filename: "run.fit", bytes: activity(12) }],
    "OUT.BIN",
  );
  assert.equal(fit.recordIds(20).length, 12);
  assert.equal(fit.summary().appInventories, undefined);
  assert.equal(fit.summary().sources[0].filename, "run.fit");
  const inventory = await FitDocument.openSources(
    [{ filename: "OUT.BIN", bytes: outBinFixture() }],
    "display.fit",
  );
  assert.equal(inventory.summary().filename, "display.fit");
  assert.equal(inventory.summary().appInventories?.length, 1);
});

test("FIT repair archives preserve OUT.BIN and SET payloads unchanged", async () => {
  const inventory = outBinFixture();
  const settings = syntheticSettings();
  const fit = activity(12);
  fit[fit.length - 1] ^= 1;
  const document = await FitDocument.openSources(
    [
      { filename: "Apps/OUT.BIN", bytes: inventory },
      { filename: "Apps/SETTINGS/app.SET", bytes: settings },
      { filename: "Activity/run.fit", bytes: fit },
    ],
    "Garmin.zip",
  );
  const exported = await exportDocument(document, { format: "fit" });
  const archive = await JSZip.loadAsync(await exported.blob.arrayBuffer());
  const inventoryFile = Object.values(archive.files).find((file) =>
    file.name.endsWith("OUT.BIN"),
  );
  const settingsFile = Object.values(archive.files).find((file) =>
    file.name.endsWith("app.SET"),
  );
  assert.ok(inventoryFile);
  assert.ok(settingsFile);
  assert.deepEqual(await inventoryFile.async("uint8array"), inventory);
  assert.deepEqual(await settingsFile.async("uint8array"), settings);
  const report = JSON.parse(
    await archive.file("repair-report.json")!.async("string"),
  );
  assert.equal(
    report.find((row: { source: string }) => row.source.endsWith("OUT.BIN"))
      .status,
    "unchanged",
  );
});
