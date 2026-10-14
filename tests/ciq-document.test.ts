import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { FitDocument } from "../src/document/document";
import { loadFile } from "../src/document/files";
import { exportDocument } from "../src/export/export";
import { activity } from "./fixtures";
import { syntheticSettings } from "./ciq-fixtures";
import { idleJob } from "../src/protocol/reader";

test("standalone CIQ settings produce typed properties without FIT records or diagnostics", async () => {
  const document = await FitDocument.open(syntheticSettings(), "example.SET");
  const summary = document.summary();
  assert.equal(summary.ciqSettings?.length, 1);
  assert.equal(summary.ciqSettings?.[0].settings.entries.length, 6);
  assert.equal(summary.sources[0].filename, "example.SET");
  assert.equal(summary.records, 0);
  assert.equal(summary.subfiles.length, 0);
  assert.equal(summary.diagnosticCount, 0);
  assert.equal(summary.hasCharts, false);
  assert.equal(summary.hasMap, false);
  assert.equal(summary.repairable, false);
  assert.deepEqual(summary.fileTypes, ["Connect IQ settings"]);
  await assert.rejects(
    exportDocument(document, { format: "fit" }),
    /cannot be repaired/,
  );
});

test("mixed SET and FIT sources retain FIT offsets, derived data, and settings identity", async () => {
  const fit = activity(32);
  const document = await FitDocument.openSources(
    [
      { filename: "Apps/SETTINGS/example.SET", bytes: syntheticSettings() },
      { filename: "Activity/run.FIT", bytes: fit },
    ],
    "Garmin",
  );
  const summary = document.summary();
  assert.equal(summary.ciqSettings?.[0].source, 0);
  assert.equal(summary.sources.length, 2);
  assert.equal(summary.sources[0].records, 0);
  assert.equal(summary.sources[1].start, syntheticSettings().length);
  assert.ok(summary.sources[1].records > 0);
  assert.equal(summary.subfiles[0].source, 1);
  assert.equal(summary.hasMap, true);
  assert.equal(summary.hasCharts, true);
  assert.equal(document.recordIds(20, 0).length, 0);
  assert.equal(document.recordIds(20, 1).length, 32);
  const baseline = await FitDocument.open(fit, "run.FIT");
  const query = { message: 20, page: 0, size: 20, developer: false };
  const combined = await document.table(query);
  const expected = await baseline.table(query);
  assert.deepEqual(
    combined.rows.map((row) => row.cells),
    expected.rows.map((row) => row.cells),
  );
});

test("source filenames choose the decoder independently of the workspace display name", async () => {
  const fit = await FitDocument.openSources(
    [{ filename: "run.fit", bytes: activity(12) }],
    "display.SET",
  );
  assert.equal(fit.summary().filename, "display.SET");
  assert.equal(fit.recordIds(20).length, 12);
  assert.equal(fit.summary().ciqSettings, undefined);
  const settings = await FitDocument.openSources(
    [{ filename: "example.SET", bytes: syntheticSettings() }],
    "display.fit",
  );
  assert.equal(settings.summary().filename, "display.fit");
  assert.equal(settings.summary().ciqSettings?.length, 1);
});

test("invalid SET data fails alone and appears as a diagnostic in a mixed workspace", async () => {
  const bad = new TextEncoder().encode("invalid settings");
  await assert.rejects(FitDocument.open(bad, "bad.SET"));
  const document = await FitDocument.openSources(
    [
      { filename: "run.fit", bytes: activity(12) },
      { filename: "bad.SET", bytes: bad },
    ],
    "Mixed files",
  );
  const summary = document.summary();
  assert.equal(summary.ciqSettings, undefined);
  assert.ok(summary.sources[1].error);
  assert.ok(
    summary.diagnostics.some(
      (issue) => issue.source === 1 && issue.code === "unreadable-file",
    ),
  );
  assert.equal(document.recordIds(20).length, 12);
});

test("ZIP imports route CIQ settings separately and FIT repair preserves settings bytes", async () => {
  const fit = activity(12);
  fit[fit.length - 1] ^= 1;
  const zip = await new JSZip()
    .file("Apps/SETTINGS/example.SET", syntheticSettings())
    .file("Activity/run.fit", fit)
    .generateAsync({ type: "uint8array" });
  const loaded = await loadFile(
    new File([zip.slice()], "Garmin.zip"),
    1e6,
    idleJob(),
  );
  const document = await FitDocument.openSources(
    loaded.sources,
    loaded.filename,
  );
  assert.equal(document.summary().ciqSettings?.length, 1);
  const exported = await exportDocument(document, { format: "fit" });
  const repaired = await JSZip.loadAsync(await exported.blob.arrayBuffer());
  const settings = Object.values(repaired.files).find((file) =>
    /\.SET$/i.test(file.name),
  );
  assert.ok(settings);
  assert.deepEqual(await settings.async("uint8array"), syntheticSettings());
  const report = JSON.parse(
    await repaired.file("repair-report.json")!.async("string"),
  );
  assert.equal(
    report.find((row: { source: string }) => row.source.endsWith("example.SET"))
      .status,
    "unchanged",
  );
});
