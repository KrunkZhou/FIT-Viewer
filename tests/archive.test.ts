import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitDocument } from "../src/document/document";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { chart, chartSensors, mapData } from "../src/document/series";
import { exportDocument, escapeCsv } from "../src/export/export";
import { readFit } from "../src/protocol/reader";
import { wrapBody } from "../src/protocol/writer";
import { Overview } from "../src/ui/Overview";
import { chartMemberKeys, groupSensors } from "../src/ui/chart-groups";
import {
  activity,
  data,
  definition,
  file,
  join,
  uiActivity,
  type Field,
} from "./fixtures";

test("combined ZIP documents preserve source offsets, table values and separate GPS routes", async () => {
  const sources = [
    { filename: 'nested/A,"run".FIT', bytes: activity(3) },
    { filename: "B.fit", bytes: activity(2) },
  ];
  const originals = sources.map((source) => source.bytes.slice());
  const document = await FitDocument.openSources(sources, "activities.zip");
  assert.equal(document.summary().gpsPoints, 5);
  assert.equal(document.summary().durationSeconds, 3);
  assert.deepEqual(
    document.summary().sources.map((source) => source.filename),
    sources.map((source) => source.filename),
  );
  assert.deepEqual(
    document.index.subfiles.map((source) => source.source),
    [0, 1],
  );
  const page = await document.table({
    message: 20,
    developer: false,
    page: 999,
    size: 20,
  });
  assert.equal(page.total, 5);
  assert.equal(page.page, 0);
  assert.deepEqual(
    page.rows.map((row) => row.cells["3"].value),
    [120, 121, 122, 120, 121],
  );
  assert.deepEqual(
    page.rows.map((row) => document.sourceName(row.subfile)),
    [
      sources[0].filename,
      sources[0].filename,
      sources[0].filename,
      "B.fit",
      "B.fit",
    ],
  );
  assert.equal(document.recordIds(20, 0).length, 3);
  assert.equal(document.recordIds(20, 1).length, 2);
  const map = await mapData(document, undefined, true);
  assert.deepEqual(
    map.tracks.map((track) => track.length),
    [3, 2],
  );
  assert.equal(map.routeNames?.length, 2);
  const csv = await (
    await exportDocument(document, { format: "csv" })
  ).blob.text();
  assert.ok(csv.startsWith("Source file,"));
  assert.ok(
    csv.split("\n")[1].startsWith(`${escapeCsv(sources[0].filename)},`),
  );
  assert.ok(csv.split("\n").at(-1)!.startsWith("B.fit,"));
  const geojson = JSON.parse(
    await (await exportDocument(document, { format: "geojson" })).blob.text(),
  );
  assert.deepEqual(
    geojson.features.map((feature: any) => feature.properties.source_file),
    page.rows.map((row) => document.sourceName(row.subfile)),
  );
  const gpx = await (
    await exportDocument(document, { format: "gpx" })
  ).blob.text();
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 2);
  const markup = renderToStaticMarkup(
    createElement(Overview, {
      summary: document.summary(),
      diagnostics() {},
      download() {},
    }),
  );
  assert.ok(markup.includes("Source files"));
  assert.ok(markup.includes("B.fit"));
  assert.ok(markup.includes("00:00:03"));
  assert.equal((markup.match(/21\.205/g) ?? []).length, 1);
  assert.ok(
    markup.includes(
      `${Math.round((document.summary().bytes * 3600) / 3).toLocaleString()} bytes/hour`,
    ),
  );
  sources.forEach((source, index) =>
    assert.deepEqual(source.bytes, originals[index]),
  );
});

test("ZIP duration adds file durations instead of counting gaps or merging overlaps", async () => {
  const timed = (start: number, end: number) =>
    file(
      [
        { message: 20, fields: [[253, 6, start]] },
        { message: 20, fields: [[253, 6, end]] },
      ],
      false,
    );
  const document = await FitDocument.openSources(
    [
      { filename: "A.fit", bytes: timed(100, 160) },
      { filename: "B.fit", bytes: timed(10000, 10120) },
      { filename: "C.fit", bytes: timed(110, 140) },
      {
        filename: "settings.fit",
        bytes: file([{ message: 12, fields: [[0, 0, 1]] }], false),
      },
    ],
    "duration.zip",
  );
  assert.equal(document.summary().startTimestamp, 100);
  assert.equal(document.summary().endTimestamp, 10120);
  assert.equal(document.summary().durationSeconds, 210);
});

test("ZIP entries decode independently even with truncated tails, unknown fields and invalid headers", async () => {
  const valid = activity(3);
  const broken = valid.slice(0, valid.length - 6);
  const fields: Field[] = [
    [253, 6, 32],
    [7, 15, 9007199254740993n],
    [8, 4, [1, 65535, 3]],
  ];
  const unknown = file([{ message: 64000, fields, little: false }], false);
  const document = await FitDocument.openSources(
    [
      { filename: "truncated.fit", bytes: broken },
      {
        filename: "invalid.fit",
        bytes: new TextEncoder().encode("not a FIT header"),
      },
      { filename: "unknown.fit", bytes: unknown },
      { filename: "good.fit", bytes: valid },
    ],
    "mixed.zip",
  );
  const id = document.index.messages.get(64000)![0];
  assert.equal(document.cells(id)["7"].raw, 9007199254740993n);
  assert.deepEqual(document.cells(id)["8"].value, [1, null, 3]);
  assert.equal(document.recordIds(20, 3).length, 3);
  assert.match(document.sources[1].error!, /header/);
  assert.ok(
    document.index.diagnostics.some(
      (issue) => issue.source === 1 && issue.code === "unreadable-file",
    ),
  );
  assert.equal(document.index.subfiles.at(-1)!.source, 3);
  const timestamp: Field[] = [
    [253, 6, 31],
    [3, 2, 120],
  ];
  const compressed = wrapBody(
    join([definition(20, timestamp), data(timestamp, 0, true, 0)]),
  );
  const isolated = await FitDocument.openSources(
    [
      {
        filename: "base.fit",
        bytes: file([{ message: 20, fields: timestamp }], false),
      },
      { filename: "missing-base.fit", bytes: compressed },
    ],
    "timestamps.zip",
  );
  assert.equal(isolated.recordIds(20, 1).length, 0);
  assert.ok(
    isolated.index.diagnostics.some(
      (issue) => issue.source === 1 && issue.message.includes("timestamp base"),
    ),
  );
});

test("device-specific settings metadata does not cross ZIP entry boundaries", async () => {
  const fields: Field[] = [52, 43, 42, 0, 25, 99, 29, 255].map((value, id) => [
    id,
    0,
    value,
  ]);
  const document = await FitDocument.openSources(
    [
      { filename: "watch.fit", bytes: file([{ message: 354, fields }]) },
      {
        filename: "other.fit",
        bytes: file([{ message: 354, fields }], true, 999),
      },
    ],
    "settings.zip",
  );
  const [watch, other] = document.index.messages.get(354)!;
  assert.equal(document.cells(watch)["0"].value, "Settings");
  assert.equal(document.cells(other)["0"].value, 52);
  assert.equal(document.getFields(354, false, 1).length, 0);
});

test("ZIP charts separate overlapping activity and motion series by source", async () => {
  const motion = (value: number) =>
    file(
      [
        {
          message: 165,
          fields: [
            [253, 6, 100],
            [0, 4, 0],
            [1, 4, [0, 10, 20]],
            [5, 8, [value, value + 1, value + 2]],
          ],
        },
      ],
      false,
    );
  const document = await FitDocument.openSources(
    [
      { filename: "A.fit", bytes: join([activity(3), motion(10)]) },
      { filename: "B.fit", bytes: join([activity(2), motion(50)]) },
    ],
    "charts.zip",
  );
  const inventory = await chartSensors(document, false);
  const groups = groupSensors(inventory);
  const heartRate = groups.find((group) => group.sensor.key === "20:3")!;
  assert.equal(heartRate.sensor.name, "Heart Rate");
  assert.equal(heartRate.members.length, 2);
  assert.deepEqual(chartMemberKeys(groups, ["20:3"]), [
    "20:3:file:0",
    "20:3:file:1",
  ]);
  assert.equal(groups.filter((group) => group.sensor.field === "3").length, 1);
  assert.equal(
    groups.find((group) => group.sensor.key === "165:5")!.members.length,
    2,
  );
  const selected = [
    "20:3:file:0",
    "20:3:file:1",
    "165:5:file:0",
    "165:5:file:1",
  ];
  for (const key of selected)
    assert.ok(
      inventory.some((sensor) => sensor.key === key),
      key,
    );
  const plotted = await chart(document, {
    sensors: selected,
    width: 100,
    developer: false,
  });
  assert.deepEqual(
    plotted.series[selected[0]].map((point) => point.value),
    [120, 121, 122],
  );
  assert.deepEqual(
    plotted.series[selected[1]].map((point) => point.value),
    [120, 121],
  );
  assert.deepEqual(
    plotted.series[selected[2]].map((point) => point.value),
    [10, 11, 12],
  );
  assert.deepEqual(
    plotted.series[selected[3]].map((point) => point.value),
    [50, 51, 52],
  );
  const combinedExport = JSON.parse(
    await (
      await exportDocument(document, {
        format: "json",
        sensors: chartMemberKeys(groups, ["20:3"]),
      })
    ).blob.text(),
  );
  assert.deepEqual(Object.keys(combinedExport.series), [
    "20:3:file:0",
    "20:3:file:1",
  ]);
  assert.equal(combinedExport.series["20:3:file:0"].length, 3);
  assert.equal(combinedExport.series["20:3:file:1"].length, 2);
  const exported = JSON.parse(
    await (
      await exportDocument(document, { format: "json", sensors: selected })
    ).blob.text(),
  );
  assert.deepEqual(
    exported.series[selected[3]].map((point: any) => point.value),
    [50, 51, 52],
  );
});

test("combined chart groups never mix different units, axes, or developer sensor meanings", () => {
  const sensor = {
    key: "20:d0:4:file:0",
    message: 20,
    field: "d0:4",
    source: 0,
    name: "Temperature A.fit",
    label: "Temperature",
    units: "C",
    axis: "time" as const,
  };
  const groups = groupSensors([
    sensor,
    { ...sensor, key: "20:d0:4:file:1", source: 1, name: "Temperature B.fit" },
    { ...sensor, key: "20:d0:4:file:2", source: 2, units: "F" },
    { ...sensor, key: "20:d0:4:file:3", source: 3, label: "Pressure" },
    { ...sensor, key: "20:d0:4:file:4", source: 4, axis: "sample" },
  ]);
  assert.deepEqual(
    groups.map((group) => group.members.length),
    [2, 1, 1, 1],
  );
  assert.equal(new Set(groups.map((group) => group.sensor.key)).size, 4);
});

test("archive repairs preserve clean entries and report partial and unrecovered files separately", async () => {
  const clean = uiActivity();
  const damaged = activity(3).slice(0, -6);
  const invalid = new TextEncoder().encode("invalid FIT");
  const document = await FitDocument.openSources(
    [
      { filename: "clean.fit", bytes: clean },
      { filename: "damaged.fit", bytes: damaged },
      { filename: "broken.fit", bytes: invalid },
    ],
    "repair.zip",
  );
  const result = await exportDocument(document, { format: "fit" });
  assert.equal(result.filename, "repair-fixed.zip");
  assert.equal(result.partial, true);
  const zip = await JSZip.loadAsync(await result.blob.arrayBuffer());
  const report = JSON.parse(
    await zip.file("repair-report.json")!.async("string"),
  );
  assert.deepEqual(
    report.map((entry: any) => entry.status),
    ["unchanged", "partial", "unrecovered"],
  );
  assert.deepEqual(
    await zip.file(report[0].output)!.async("uint8array"),
    clean,
  );
  assert.deepEqual(
    await zip.file(report[2].output)!.async("uint8array"),
    invalid,
  );
  const repaired = await readFit(
    await zip.file(report[1].output)!.async("uint8array"),
  );
  assert.ok(!repaired.diagnostics.some((issue) => issue.severity === "error"));
  assert.ok(result.generated?.length);
  assert.ok(result.unresolved?.some((text) => text.includes("broken.fit")));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    exportDocument(document, { format: "fit" }, createJob(controller.signal)),
    { name: "AbortError" },
  );
});

test("ZIP extraction applies one aggregate expanded-data limit and supports cancellation", async () => {
  const zip = new JSZip()
    .file("one.fit", new Uint8Array(6000))
    .file("two.fit", new Uint8Array(6000));
  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
  });
  const archive = new File([bytes.slice()], "limit.zip");
  await assert.rejects(
    loadFile(archive, 10000, createJob(new AbortController().signal)),
    /exceeds/,
  );
  const controller = new AbortController();
  const job = createJob(controller.signal, () => controller.abort());
  await assert.rejects(loadFile(archive, 20000, job), { name: "AbortError" });
  await assert.rejects(
    loadFile(
      new File(
        [
          (
            await new JSZip()
              .file("readme.txt", "text")
              .generateAsync({ type: "uint8array" })
          ).slice(),
        ],
        "empty.zip",
      ),
      10000,
      createJob(new AbortController().signal),
    ),
    /no FIT/,
  );
});

test("combined exports retain per-file developer precision and mixed RR sources", async () => {
  const developer = (scale: number) => {
    const fields: Field[] = [[253, 6, 100]];
    const description: Field[] = [
      [0, 2, 0],
      [1, 2, 4],
      [2, 2, 132],
      [3, 7, "Custom sensor"],
      [6, 2, scale],
      [8, 7, "m"],
    ];
    return wrapBody(
      join([
        definition(20, fields, 0, true, [[4, 2, 0]]),
        data(fields, 0, true, undefined, Uint8Array.of(123, 0)),
        definition(206, description, 1),
        data(description, 1),
      ]),
    );
  };
  const document = await FitDocument.openSources(
    [
      {
        filename: "A.fit",
        bytes: join([
          developer(10),
          file([{ message: 78, fields: [[0, 4, [800, 900]]] }], false),
        ]),
      },
      {
        filename: "B.fit",
        bytes: join([
          developer(100),
          file([{ message: 132, fields: [[9, 6, [1024, 2048, 3072]]] }], false),
        ]),
      },
    ],
    "mixed.zip",
  );
  const csv = await (
    await exportDocument(document, { format: "csv" })
  ).blob.text();
  assert.ok(csv.split("\n")[1].endsWith(",12.3"), csv);
  assert.ok(csv.split("\n")[2].endsWith(",1.23"), csv);
  const rr = await (
    await exportDocument(document, { format: "hrv" })
  ).blob.text();
  assert.equal(rr, "800\n900\n1000\n1000\n");
});

test("combined decoding and ZIP packaging cancel in flight", async () => {
  const sources = [
    { filename: "A.fit", bytes: uiActivity() },
    { filename: "B.fit", bytes: uiActivity() },
  ];
  const decode = new AbortController();
  await assert.rejects(
    FitDocument.openSources(
      sources,
      "cancel.zip",
      createJob(decode.signal, () => decode.abort()),
    ),
    { name: "AbortError" },
  );
  const document = await FitDocument.openSources(sources, "cancel.zip");
  const controller = new AbortController();
  const job = createJob(controller.signal, (_, __, phase) => {
    if (phase === "Packaging repaired ZIP") controller.abort();
  });
  await assert.rejects(exportDocument(document, { format: "fit" }, job), {
    name: "AbortError",
  });
  assert.equal(document.summary().gpsPoints, 360);
});
