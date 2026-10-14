import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import * as Popover from "@radix-ui/react-popover";
import {
  MapDownloads,
  MapExportFormats,
  MapTimeline,
} from "../src/ui/MapControls";
import { mapTimeRange } from "../src/ui/map-playback";
import { formatTimestamp } from "../src/protocol/time";
import type { ExportQuery } from "../src/model";

test("GPS sample is on the first timeline line with a single timestamp and coordinates", () => {
  const range = mapTimeRange(
    [{ route: 0, start: 100, end: 200, count: 10 }],
    [],
  )!;
  const markup = renderToStaticMarkup(
    createElement(MapTimeline, {
      range,
      progress: 25,
      segments: [{ start: 0, end: 100, colors: ["green"] }],
      position: {
        route: 0,
        record: 2,
        time: 125,
        lat: 1.23456,
        lon: -2.34567,
      },
      routeName: "Route 1",
      color: "green",
      error: "",
      onTimeChange() {},
      onGoToData() {},
      canGoToData: true,
    }),
  );
  assert.match(markup, /viewer-map-playback-heading/);
  assert.ok(
    markup.includes(`GPS sample: <time>${formatTimestamp(125)}</time>`),
  );
  assert.ok(
    markup.includes(
      'class="viewer-map-coordinates">1.23456, -2.34567</span>',
    ),
  );
  assert.equal(
    markup.split(`<time>${formatTimestamp(125)}</time>`).length - 1,
    1,
  );
  assert.match(markup, /aria-label="Hide GPS timeline"/);
  assert.match(markup, /aria-label="Go to data"/);
  assert.ok(!markup.match(/aria-label="Go to data"[^>]*disabled/));
  assert.match(markup, /aria-expanded="true"/);
  assert.match(markup, /aria-label="Map time"/);
  assert.ok(markup.includes(`<time>${formatTimestamp(100)}</time>`));
  assert.ok(markup.includes(`<time>${formatTimestamp(200)}</time>`));
});

test("a pending position query does not invent a sample timestamp", () => {
  const markup = renderToStaticMarkup(
    createElement(MapTimeline, {
      range: mapTimeRange([{ route: 0, start: 100, end: 200, count: 10 }], [])!,
      progress: 0,
      segments: [],
      color: "gray",
      error: "",
      onTimeChange() {},
      onGoToData() {},
      canGoToData: false,
    }),
  );
  assert.ok(markup.includes("Locating GPS sample..."));
  assert.ok(!markup.includes("GPS sample:"));
  assert.match(markup, /aria-label="Go to data"[^>]*disabled/);
});

test("navigation stays disabled while the displayed sample belongs to a previous lookup", () => {
  const markup = renderToStaticMarkup(
    createElement(MapTimeline, {
      range: mapTimeRange([{ route: 0, start: 100, end: 200, count: 10 }], [])!,
      progress: 75,
      segments: [],
      position: { record: 2, route: 0, time: 125, lat: 5, lon: 5 },
      color: "green",
      error: "",
      canGoToData: false,
      onTimeChange() {},
      onGoToData() {},
    }),
  );
  assert.match(markup, /aria-label="Go to data"[^>]*disabled/);
  assert.ok(markup.includes("Waiting for the selected GPS sample"));
});

test("map exports use one disabled-capable format picker", () => {
  const markup = renderToStaticMarkup(
    createElement(MapDownloads, {
      dates: {},
      withLaps: false,
      disabled: true,
      download() {},
    }),
  );
  assert.match(markup, /aria-label="Download GPS data"[^>]*disabled/);
  assert.ok(!markup.includes('aria-label="Download GPX"'));
  const formats = renderToStaticMarkup(
    createElement(
      Popover.Root,
      null,
      createElement(MapExportFormats, {
        dates: {},
        withLaps: true,
        download() {},
      }),
    ),
  );
  assert.ok(formats.includes("GPX"));
  assert.ok(formats.includes("GeoJSON"));
});

test("the format choices preserve date filtering and GPX lap options", () => {
  const requests: ExportQuery[] = [];
  const dates = { start: 100, end: 200 };
  const element = MapExportFormats({
    dates,
    withLaps: true,
    download: (query) => requests.push(query),
  });
  for (const option of element.props.children)
    option.props.children.props.onClick();
  assert.deepEqual(requests, [
    { format: "gpx", withLaps: true, dates },
    { format: "geojson", dates },
  ]);
});
