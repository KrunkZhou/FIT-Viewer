import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { activity, file, join, type Field } from "./fixtures";
import { createJob } from "../src/document/jobs";

interface Feature {
  type: string;
  id: number;
  geometry: { type: string; coordinates: number[] };
  properties: {
    kind: string;
    route_id: number | null;
    subfile: number;
    timestamp: string | null;
    elevation_m: number | null;
    distance_m: number | null;
    name: string | null;
    record_index: number;
  };
}

test("GeoJSON retains full-resolution GPS data, coordinate order, and metric attributes", async () => {
  const bytes = activity(1000);
  const before = bytes.slice();
  const document = await FitDocument.open(bytes, "sample.FIT");
  const result = await exportDocument(document, { format: "geojson" });
  assert.equal(result.filename, "sample-gps.geojson");
  assert.equal(result.blob.type, "application/geo+json");
  const parsed = JSON.parse(await result.blob.text());
  assert.equal(parsed.type, "FeatureCollection");
  assert.equal(parsed.features.length, 1000);
  assert.ok(!("crs" in parsed));
  const features: Feature[] = parsed.features;
  const first = features[0];
  assert.equal(first.type, "Feature");
  assert.equal(first.geometry.type, "Point");
  assert.deepEqual(first.geometry.coordinates, [
    (-900000000 * 180) / 2147483648,
    (600000000 * 180) / 2147483648,
  ]);
  assert.equal(
    first.properties.timestamp,
    new Date(631065600000 + 1100000000 * 1000).toISOString(),
  );
  assert.equal(first.properties.elevation_m, 100);
  assert.equal(first.properties.distance_m, 0);
  assert.equal(first.properties.route_id, 1);
  assert.equal(features.at(-1)!.properties.distance_m, 999 * 2.5);
  assert.equal(new Set(features.map((point) => point.id)).size, 1000);
  assert.deepEqual(bytes, before);
});

test("GeoJSON route IDs split at invalid GPS, reversed time and subfiles without losing zero or missing values", async () => {
  const gps = (time: number, lat: number): Field[] => [
    [253, 6, time],
    [0, 5, lat],
    [1, 5, 0],
    [5, 6, 0],
  ];
  const waypoint = 'Way "A"\nB';
  const document = await FitDocument.open(
    join([
      file(
        [
          { message: 20, fields: gps(0, 0) },
          { message: 20, fields: gps(1, 0) },
          { message: 20, fields: gps(2, 2147483647) },
          { message: 20, fields: gps(3, 0) },
          { message: 20, fields: gps(1, 0) },
          {
            message: 32,
            fields: [
              [2, 5, 0],
              [3, 5, 0],
              [6, 7, waypoint],
            ],
          },
          {
            message: 32,
            fields: [
              [1, 6, 0],
              [2, 5, 0],
              [3, 5, 0],
              [6, 7, "Timed waypoint"],
            ],
          },
        ],
        false,
      ),
      file([{ message: 20, fields: gps(0, 0) }], false),
    ]),
    "segments.fit",
  );
  const parsed = JSON.parse(
    await (await exportDocument(document, { format: "geojson" })).blob.text(),
  );
  const track: Feature[] = parsed.features.filter(
    (point: Feature) => point.properties.kind === "record",
  );
  assert.deepEqual(
    track.map((point) => point.properties.route_id),
    [1, 1, 2, 3, 4],
  );
  assert.deepEqual(
    track.map((point) => point.properties.subfile),
    [1, 1, 1, 1, 2],
  );
  for (const point of parsed.features) {
    assert.deepEqual(point.geometry.coordinates, [0, 0]);
    assert.equal(point.geometry.coordinates.length, 2);
    assert.equal(point.properties.elevation_m, null);
  }
  const named: Feature = parsed.features.find(
    (point: Feature) => point.properties.kind === "waypoint",
  );
  assert.equal(named.properties.name, waypoint);
  assert.equal(named.properties.timestamp, null);
  assert.equal(named.properties.distance_m, null);
  assert.equal(named.properties.route_id, null);
  const timed = parsed.features.find(
    (point: Feature) => point.properties.name === "Timed waypoint",
  );
  assert.equal(timed.properties.timestamp, "1989-12-31T00:00:00.000Z");
});

test("GeoJSON empty output is valid, progress is reported, and cancellation rejects partial output", async () => {
  const empty = await FitDocument.open(file([], false), "empty.fit");
  assert.deepEqual(
    JSON.parse(
      await (await exportDocument(empty, { format: "geojson" })).blob.text(),
    ),
    { type: "FeatureCollection", features: [] },
  );
  const document = await FitDocument.open(activity(10000), "cancel.fit");
  const controller = new AbortController();
  const phases: string[] = [];
  const job = createJob(controller.signal, (completed, _total, phase) => {
    phases.push(phase);
    if (completed >= 512) controller.abort();
  });
  await assert.rejects(exportDocument(document, { format: "geojson" }, job), {
    name: "AbortError",
  });
  assert.ok(phases.every((phase) => phase === "Exporting GeoJSON"));
  const retried = JSON.parse(
    await (await exportDocument(document, { format: "geojson" })).blob.text(),
  );
  assert.equal(retried.features.length, 10000);
});
