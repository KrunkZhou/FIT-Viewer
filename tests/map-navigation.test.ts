import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { MapPlaybackIndex } from "../src/document/map-playback";
import { mapData } from "../src/document/series";
import { idleJob } from "../src/protocol/reader";
import { file, type Field } from "./fixtures";
import type { TableRow } from "../src/model";
import { exportDocument } from "../src/export/export";

test("brief missing GPS samples remain in one route without changing source records", async () => {
  const bytes = file(
    Array.from({ length: 7 }, (_, index) => ({
      message: 20,
      fields: [
        [253, 6, 1100000000 + index],
        [
          0,
          5,
          index === 2 || index === 4 ? 0x7fffffff : 100000000 + index * 1000,
        ],
        [1, 5, index === 2 || index === 4 ? 0x7fffffff : 100000000],
      ] as Field[],
    })),
    false,
  );
  const original = bytes.slice();
  const document = await FitDocument.open(bytes, "gps-dropouts.fit");
  const map = await mapData(document, idleJob(), true);
  assert.deepEqual(
    map.tracks.map((track) => track.map((point) => point.time)),
    [[1100000000, 1100000001, 1100000003, 1100000005, 1100000006]],
  );
  assert.equal(document.recordIds(20).length, 7);
  assert.equal(document.cells(document.recordIds(20)[2])["0"].raw, 0x7fffffff);
  assert.deepEqual(bytes, original);
});

function gpsRecord(
  time: number | undefined,
  gps: "valid" | "invalid" | "empty" = "valid",
) {
  return {
    message: 20,
    fields: [
      ...(time === undefined ? [] : [[253, 6, time]]),
      ...(gps === "empty"
        ? []
        : [
            [0, 5, gps === "invalid" ? 0x7fffffff : 100000000],
            [1, 5, 100000000],
          ]),
    ] as Field[],
  };
}

test("30-second GPS dropout boundary is shared by map, timeline, GPX and GeoJSON", async () => {
  for (const gap of [29, 30, 31]) {
    const bytes = file(
      [
        gpsRecord(0),
        gpsRecord(1, "invalid"),
        gpsRecord(10, "empty"),
        gpsRecord(gap),
      ],
      false,
    );
    const before = bytes.slice();
    const document = await FitDocument.open(bytes, "dropout.fit");
    const playback = new MapPlaybackIndex();
    const map = await mapData(document, idleJob(), true, undefined, playback);
    const routes = gap <= 30 ? 1 : 2;
    assert.equal(map.tracks.length, routes, `${gap}-second gap`);
    assert.equal(playback.routes.length, routes);
    assert.deepEqual(
      map.tracks.flat().map((point) => point.time),
      [0, gap],
    );
    const position = await playback.position(document, 2, [0], idleJob());
    assert.equal(position?.time, 0);
    assert.equal(position?.record, document.recordIds(20)[0]);
    const gpx = await (
      await exportDocument(document, { format: "gpx" })
    ).blob.text();
    assert.equal((gpx.match(/<trkseg>/g) ?? []).length, routes);
    assert.equal((gpx.match(/<trkpt /g) ?? []).length, 2);
    const geojson = JSON.parse(
      await (await exportDocument(document, { format: "geojson" })).blob.text(),
    );
    assert.deepEqual(
      geojson.features.map(
        (feature: { properties: { route_id: number } }) =>
          feature.properties.route_id,
      ),
      [1, routes],
    );
    assert.equal(document.recordIds(20).length, 4);
    assert.deepEqual(bytes, before);
  }
});

test("untimed dropouts and backwards timestamps still split routes", async () => {
  for (const [start, end] of [
    [undefined, 5],
    [0, undefined],
    [10, 5],
  ]) {
    const document = await FitDocument.open(
      file([gpsRecord(start), gpsRecord(1, "empty"), gpsRecord(end)], false),
      "uncertain-gap.fit",
    );
    assert.equal((await mapData(document, idleJob(), true)).tracks.length, 2);
  }
});

test("excluded timestamps are hard route boundaries even during a short dropout", async () => {
  const document = await FitDocument.open(
    file([gpsRecord(0), gpsRecord(1, "invalid"), gpsRecord(2)], false),
    "filtered-gap.fit",
  );
  const dates = {
    intervals: [
      { start: 0, end: 0 },
      { start: 2, end: 2 },
    ],
  };
  assert.equal((await mapData(document, idleJob(), true)).tracks.length, 1);
  assert.equal(
    (await mapData(document, idleJob(), true, dates)).tracks.length,
    2,
  );
  const gpx = await (
    await exportDocument(document, { format: "gpx", dates })
  ).blob.text();
  assert.equal((gpx.match(/<trkseg>/g) ?? []).length, 2);
  const geojson = JSON.parse(
    await (
      await exportDocument(document, { format: "geojson", dates })
    ).blob.text(),
  );
  assert.deepEqual(
    geojson.features.map(
      (feature: { properties: { route_id: number } }) =>
        feature.properties.route_id,
    ),
    [1, 2],
  );
});

test("short GPS dropouts never join separate source files", async () => {
  const document = await FitDocument.openSources(
    [
      {
        filename: "first.fit",
        bytes: file([gpsRecord(0), gpsRecord(1, "empty")], false),
      },
      { filename: "second.fit", bytes: file([gpsRecord(2)], false) },
    ],
    "two files",
  );
  assert.equal((await mapData(document, idleJob(), true)).tracks.length, 2);
});

test("GPS navigation targets the exact source record and table page even with duplicate timestamps", async () => {
  const entries = [0, 1].map((source) => ({
    filename: `source-${source}.fit`,
    bytes: file(
      Array.from({ length: 60 }, (_, index) => ({
        message: 20,
        fields: [
          [253, 6, 1100000000 + index],
          [0, 5, 100000000 + source * 100000 + index * 1000],
          [1, 5, 100000000],
        ] as Field[],
      })),
      false,
    ),
  }));
  const document = await FitDocument.openSources(entries, "combined.zip");
  const playback = new MapPlaybackIndex();
  await mapData(document, idleJob(), false, undefined, playback);
  const position = await playback.position(
    document,
    1100000039,
    [1],
    idleJob(),
  );
  assert.ok(position);
  assert.equal(position.record, document.recordIds(20, 1)[39]);
  for (const developer of [false, true]) {
    const table = await document.table({
      message: 20,
      developer,
      page: 0,
      size: 20,
      filters: {},
      target: position.record,
    });
    assert.equal(table.selected, position.record);
    assert.equal(table.page, 4);
    const matched: TableRow | undefined = table.rows.find(
      (entry) => entry.index === position.record,
    );
    assert.ok(matched);
    assert.equal(document.index.subfiles[matched.subfile].source, 1);
    assert.equal(matched.cells["0"].raw, 100139000);
  }
});
