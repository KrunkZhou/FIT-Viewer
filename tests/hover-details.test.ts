import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { fieldTooltip } from "../src/ui/format";
import { pointDetails, routeDetails } from "../src/ui/map-details";
import { Messages } from "../src/ui/Messages";
import { FitDocument } from "../src/document/document";
import { DocumentClient } from "../src/document/client";
import { file } from "./fixtures";

test("message count tooltips identify normal, unknown and combined message IDs", async () => {
  const document = await FitDocument.open(
    file([
      { message: 12, fields: [[0, 0, 1]] },
      { message: 64000, fields: [[0, 2, 1]] },
      { message: 20, fields: [[3, 2, 120]] },
      { message: 20, fields: [[3, 2, 125]] },
    ]),
    "details.fit",
  );
  const markup = renderToStaticMarkup(
    createElement(Messages, {
      client: new DocumentClient(),
      summary: document.summary(),
      developer: true,
      download: () => {},
    }),
  );
  assert.match(markup, /title="Message ID: 20">2<\/span>/);
  assert.match(markup, /title="Message ID: 64000">1<\/span>/);
  assert.match(markup, /title="Message ID: 12">1<\/span>/);
  assert.match(markup, /title="Message IDs: 0, 12"/);
});

test("field ID leads each header tooltip and identifies developer field namespaces", () => {
  const field = {
    key: "3",
    id: 3,
    name: "Heart Rate",
    type: "uint8",
    units: "bpm",
    developer: false,
    unknown: false,
  };
  assert.equal(fieldTooltip(field), "Field ID: 3\nuint8 (bpm)");
  assert.equal(
    fieldTooltip({
      ...field,
      key: "d2:3",
      developer: true,
      unknown: true,
      description: "Custom field",
    }),
    "Field ID: 3 (developer 2)\nuint8 (bpm) - undocumented\nCustom field",
  );
});

test("map legend details include coordinates, zero values, route times and displayed point counts", () => {
  const start = {
    lat: 0,
    lon: 0,
    time: 0,
    distance: 0,
    elevation: 0,
    record: 0,
  };
  const point = pointDetails({ ...start, kind: "start" }, "Start", "Route 1");
  assert.ok(point.startsWith("Start\nRoute 1\n0.0000000, 0.0000000\nTime:"));
  assert.ok(point.includes("Distance: 0.00 km\nElevation: 0.0 m"));
  const route = routeDetails(
    [start, { ...start, time: 60, distance: 1250, record: 1 }],
    "Route 1",
  );
  assert.ok(route.includes("2 displayed GPS points\nStart:"));
  assert.ok(route.includes("\nEnd:"));
  assert.ok(route.endsWith("Distance: 1.25 km"));
  assert.equal(routeDetails([], "Empty"), "Empty\n0 displayed GPS points");
  assert.equal(
    pointDetails({ lat: 1, lon: 2, record: 3, kind: "waypoint" }, "Waypoint"),
    "Waypoint\n1.0000000, 2.0000000",
  );
});
