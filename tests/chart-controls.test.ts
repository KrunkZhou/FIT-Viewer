import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ChartDetailButton,
  ReferenceValuesButton,
  ValueFilterButton,
  parseReferenceValues,
  parseValueBounds,
} from "../src/ui/ChartControls";

test("chart bounds preserve zero, negative and fractional values and support open bounds", () => {
  assert.deepEqual(parseValueBounds("", ""), {});
  assert.deepEqual(parseValueBounds("  ", "0"), { max: 0 });
  assert.deepEqual(parseValueBounds("0", ""), { min: 0 });
  assert.deepEqual(parseValueBounds("-3.5", "0"), { min: -3.5, max: 0 });
  assert.deepEqual(parseValueBounds("1e-3", "1e3"), { min: 0.001, max: 1000 });
  assert.deepEqual(parseValueBounds("0", "0"), { min: 0, max: 0 });
});

test("invalid bounds are rejected before a worker query is requested", () => {
  for (const bounds of [
    ["Infinity", ""],
    ["", "NaN"],
    ["bad", "4"],
    ["1e309", ""],
  ])
    assert.throws(
      () => parseValueBounds(...(bounds as [string, string])),
      /finite/,
    );
  assert.throws(
    () => parseValueBounds("2", "1"),
    /Minimum must not exceed maximum/,
  );
});

test("reference lines accept zero and decimals without silently dropping invalid values", () => {
  assert.deepEqual(parseReferenceValues(""), []);
  assert.deepEqual(parseReferenceValues(" , , "), []);
  assert.deepEqual(parseReferenceValues("0, -12.25, 1e3,"), [0, -12.25, 1000]);
  for (const input of ["0, bad, 1", "Infinity", "NaN", "1e309"])
    assert.throws(() => parseReferenceValues(input), /finite numbers/);
});

test("chart controls are compact tooltip-linked popup triggers without permanent inputs", () => {
  const reference = renderToStaticMarkup(
    createElement(ReferenceValuesButton, { value: "", onChange() {} }),
  );
  const activeReference = renderToStaticMarkup(
    createElement(ReferenceValuesButton, { value: "0", onChange() {} }),
  );
  const emptyReference = renderToStaticMarkup(
    createElement(ReferenceValuesButton, { value: ", ", onChange() {} }),
  );
  const filter = renderToStaticMarkup(
    createElement(ValueFilterButton, { value: { min: 0 }, onChange() {} }),
  );
  const detail = renderToStaticMarkup(
    createElement(ChartDetailButton, { value: "high", onChange() {} }),
  );
  for (const markup of [reference, filter, detail]) {
    assert.match(markup, /aria-haspopup="dialog"/);
    assert.match(markup, /aria-describedby=/);
    assert.ok(!markup.includes("<input"));
    assert.ok(!markup.includes("<select"));
  }
  assert.match(reference, /Reference values/);
  assert.match(activeReference, /data-active="true"/);
  assert.match(emptyReference, /data-active="false"/);
  assert.match(filter, /data-active="true"/);
  assert.match(filter, /Current range: 0 to unrestricted/);
  assert.match(detail, /aria-label="Chart detail"/);
  assert.match(detail, /data-detail="high"/);
  assert.match(detail, /Chart detail: High/);
});
