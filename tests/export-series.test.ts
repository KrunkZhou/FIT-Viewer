import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import {
  chart,
  downsample,
  interpolate,
  mapData,
} from "../src/document/series";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { activity, file, type Field } from "./fixtures";

test("CSV escaping covers commas, quotes, CR/LF, arrays, and exact large integers", async () => {
  const bytes = file(
    [
      {
        message: 600,
        fields: [
          [0, 7, 'a,"b"\r\nc'],
          [1, 15, 18446744073709551614n],
          [2, 4, [1, 65535, 3]],
        ],
      },
    ],
    false,
  );
  const document = await FitDocument.open(bytes, "csv.fit");
  const csv = await (
    await exportDocument(document, {
      format: "csv",
      message: 600,
      developer: true,
    })
  ).blob.text();
  assert.match(csv, /"a,""b""\r\nc"/);
  assert.match(csv, /18446744073709551614/);
  assert.match(csv, /"\[1, 65535, 3\]"/);
});
test("ISO and localized timestamp exports use explicit timezone", async () => {
  const document = await FitDocument.open(activity(3), "time.fit");
  const iso = await (
    await exportDocument(document, {
      format: "csv",
      message: 20,
      timeFormat: "iso",
    })
  ).blob.text();
  const local = await (
    await exportDocument(document, {
      format: "csv",
      message: 20,
      timeFormat: "localized",
      locale: "en-US",
      timezone: "America/Toronto",
    })
  ).blob.text();
  assert.match(iso, /T\d\d:\d\d:\d\d\.000Z/);
  assert.ok(!local.includes(".000Z"));
});
test("CSV export reports progress and cancellation discards partial output", async () => {
  const document = await FitDocument.open(activity(5000), "cancel.fit");
  const controller = new AbortController();
  let progressed = false;
  const job = createJob(controller.signal, (completed) => {
    progressed = true;
    if (completed > 0) controller.abort();
  });
  await assert.rejects(
    exportDocument(document, { format: "csv", message: 20 }, job),
    { name: "AbortError" },
  );
  assert.equal(progressed, true);
});
test("chart buckets preserve extrema and missing-data gaps with zero bounds", async () => {
  const points = Array.from({ length: 10000 }, (_, i) => ({
    time: i,
    value: i === 555 ? 9999 : i === 666 ? null : 1,
  }));
  const sampled = downsample(points, 100);
  assert.ok(sampled.some((p) => p.value === 9999));
  assert.ok(sampled.some((p) => p.value === null));
  assert.ok(sampled.length < 500);
  const fragmented = Array.from({ length: 10000 }, (_, time) => ({
    time,
    value: time % 13 === 0 ? null : time % 17,
  }));
  const bounded = downsample(fragmented, 20);
  assert.ok(bounded.length <= 40);
  for (let i = 1; i < bounded.length; i++) {
    if (bounded[i - 1].value === null || bounded[i].value === null) continue;
    assert.ok(
      !fragmented
        .slice(bounded[i - 1].time + 1, bounded[i].time)
        .some((p) => p.value === null),
    );
  }
  const document = await FitDocument.open(
    file(
      [
        ...Array.from({ length: 10 }, (_, i) => ({
          message: 20,
          fields: [
            [253, 6, i],
            [3, 2, 123 + i],
          ] as Field[],
        })),
      ],
      false,
    ),
    "zero.fit",
  );
  const data = await chart(document, {
    sensors: ["20:3"],
    start: 0,
    end: 0,
    width: 100,
    developer: false,
  });
  assert.deepEqual(data.series["20:3"], [{ time: 0, value: 123 }]);
});
test("interpolation handles empty, singleton, and duplicate-time samples", () => {
  assert.equal(interpolate([], 0), null);
  assert.equal(interpolate([{ time: 0, value: 5 }], 0), 5);
  assert.equal(interpolate([{ time: 0, value: 5 }], 1), null);
  assert.equal(
    interpolate(
      [
        { time: 0, value: 5 },
        { time: 0, value: 9 },
      ],
      0,
    ),
    9,
  );
});
test("GPX and JSON exports keep full-resolution source data", async () => {
  const document = await FitDocument.open(activity(100), "map.fit");
  const full = await mapData(document, undefined, true);
  const simplified = await mapData(document);
  assert.equal(full.tracks[0].length, 100);
  assert.ok(simplified.tracks[0].length < 100);
  const gpx = await (
    await exportDocument(document, { format: "gpx" })
  ).blob.text();
  assert.equal((gpx.match(/<trkpt /g) ?? []).length, 100);
  const json = JSON.parse(
    await (
      await exportDocument(document, { format: "json", sensors: ["20:3"] })
    ).blob.text(),
  );
  assert.equal(json.series["20:3"].length, 100);
});
test("RR text exports measured intervals in milliseconds without missing slots", async () => {
  const document = await FitDocument.open(
    file([{ message: 78, fields: [[0, 4, [1000, 65535, 800]]] }], false),
    "rr.fit",
  );
  assert.equal(
    await (await exportDocument(document, { format: "hrv" })).blob.text(),
    "1000\n800\n",
  );
});
test("ZIP uploads extract all FIT entries and ignore metadata files", async () => {
  const zip = new JSZip();
  zip.file("one.FIT", activity(2));
  zip.file("nested/two.fit", activity(3));
  zip.file("__MACOSX/ignored.fit", "ignored");
  const blob = await zip.generateAsync({ type: "uint8array" });
  const archive = new File([blob.slice()], "files.zip");
  const job = createJob(new AbortController().signal);
  const loaded = await loadFile(archive, 100000, job);
  assert.equal(loaded.filename, "files.zip");
  assert.deepEqual(
    loaded.sources.map((source) => source.filename),
    ["one.FIT", "nested/two.fit"],
  );
  assert.equal(
    (
      await FitDocument.openSources(loaded.sources, loaded.filename)
    ).index.messages.get(20)?.length,
    5,
  );
});
test("compressed ZIP expansion is bounded independently of archive size", async () => {
  const zip = new JSZip();
  zip.file("bomb.fit", new Uint8Array(100000));
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  await assert.rejects(
    loadFile(
      new File([bytes.slice()], "limit.zip"),
      10000,
      createJob(new AbortController().signal),
    ),
    /exceeds/,
  );
});
