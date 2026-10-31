import assert from "node:assert/strict";
import test from "node:test";
import {
  ChartLineCoverage,
  chartTooltipPosition,
  type Point,
  type PlottedLine,
} from "../src/ui/chart-tooltip-layout";

const bounds = { x: 0, y: 0, width: 600, height: 260 };
const line = (
  points: PlottedLine["points"],
  connectNulls = true,
): PlottedLine => ({ points, connectNulls });

test("tooltip avoids full segments even when neither endpoint is inside it", () => {
  const coverage = new ChartLineCoverage();
  coverage.update(
    [
      line([
        { x: 0, y: 20 },
        { x: 600, y: 240 },
      ]),
    ],
    bounds,
  );
  const blocked = { x: 260, y: 110, width: 90, height: 40 };
  assert.ok(coverage.overlap(blocked) > 0);
  const size = { width: 180, height: 64 };
  const point = { x: 300, y: 130 };
  const result = chartTooltipPosition(bounds, size, point, [point], coverage);
  assert.equal(coverage.overlap({ ...result, ...size }), 0);
});

test("tooltip searches beyond the active point's four corners and checks every XYZ trace", () => {
  const coverage = new ChartLineCoverage();
  const traces = [60, 130, 200].map((y) =>
    line([
      { x: 40, y },
      { x: 600, y },
    ]),
  );
  coverage.update(traces, bounds);
  const size = { width: 160, height: 36 };
  const point = { x: 300, y: 130 };
  const withoutLines = chartTooltipPosition(bounds, size, point, [point]);
  // Cross an initially preferred location with a different series.
  coverage.update(
    [
      ...traces,
      line([
        { x: withoutLines.x - 20, y: withoutLines.y + 18 },
        { x: withoutLines.x + size.width + 20, y: withoutLines.y + 18 },
      ]),
    ],
    bounds,
  );
  assert.ok(coverage.overlap({ ...withoutLines, ...size }) > 0);
  const result = chartTooltipPosition(bounds, size, point, [point], coverage);
  assert.equal(coverage.overlap({ ...result, ...size }), 0);
});

test("coverage follows connected missing values, breaks and separate traces", () => {
  const coverage = new ChartLineCoverage();
  const points = [
    { x: 0, y: 20 },
    { x: 300, y: null },
    { x: 600, y: 240 },
  ];
  const rect = { x: 290, y: 120, width: 20, height: 20 };
  coverage.update([line(points)], bounds);
  assert.ok(coverage.overlap(rect) > 0);
  coverage.update([line(points, false)], bounds);
  assert.equal(coverage.overlap(rect), 0);
  coverage.update(
    [
      line([
        { x: 0, y: 20 },
        { x: 100, y: 20 },
      ]),
      line([
        { x: 500, y: 240 },
        { x: 600, y: 240 },
      ]),
    ],
    bounds,
  );
  assert.equal(coverage.overlap(rect), 0);
});

test("coverage clips offscreen geometry and includes viewport-edge and vertical lines", () => {
  const coverage = new ChartLineCoverage();
  coverage.update(
    [
      line([
        { x: -1e9, y: 0 },
        { x: 1e9, y: 260 },
      ]),
      line([
        { x: 600, y: -1e9 },
        { x: 600, y: 1e9 },
      ]),
      line([
        { x: -1e9, y: 260 },
        { x: 1e9, y: 260 },
      ]),
    ],
    bounds,
  );
  assert.ok(coverage.overlap({ x: 580, y: 120, width: 20, height: 20 }) > 0);
  assert.ok(coverage.overlap({ x: 200, y: 240, width: 20, height: 20 }) > 0);
  assert.equal(coverage.overlap({ x: 100, y: 30, width: 60, height: 40 }), 0);
});

test("dense charts choose least overlap while remaining inside mobile bounds", () => {
  const coverage = new ChartLineCoverage();
  const mobile = { x: 0, y: 0, width: 366, height: 230 };
  coverage.update(
    Array.from({ length: 58 }, (_, i) =>
      line([
        { x: 0, y: i * 4 },
        { x: 366, y: i * 4 },
      ]),
    ),
    mobile,
  );
  const size = { width: 280, height: 90 };
  const result = chartTooltipPosition(
    mobile,
    size,
    { x: 180, y: 100 },
    [],
    coverage,
  );
  const overlap = coverage.overlap({ ...result, ...size });
  assert.ok(overlap > 0);
  assert.ok(result.x >= 8 && result.x + size.width <= 358);
  assert.ok(result.y >= 8 && result.y + size.height <= 222);
  for (let y = 8; y <= 132; y += 4)
    for (let x = 8; x <= 78; x += 4)
      assert.ok(overlap <= coverage.overlap({ x, y, ...size }));
});

test("dense plots can float over existing heading space without covering any line", () => {
  const coverage = new ChartLineCoverage();
  coverage.update(
    Array.from({ length: 66 }, (_, i) =>
      line([
        { x: 0, y: i * 4 },
        { x: 600, y: i * 4 },
      ]),
    ),
    bounds,
  );
  const size = { width: 200, height: 52 };
  const result = chartTooltipPosition(
    bounds,
    size,
    { x: 300, y: 90 },
    [],
    coverage,
    70,
  );
  assert.ok(result.y >= -70 && result.y < 0);
  assert.equal(coverage.overlap({ ...result, ...size }), 0);
});

test("coverage is reused while hovering, and invalidated by layout or series changes", () => {
  let reads = 0;
  const points = new Proxy(
    [
      { x: 0, y: 20 },
      { x: 600, y: 240 },
    ],
    {
      get(target, key, receiver) {
        if (key === "0" || key === "1") reads++;
        return Reflect.get(target, key, receiver);
      },
    },
  );
  const coverage = new ChartLineCoverage();
  coverage.update([line(points)], bounds);
  const rect = { x: 280, y: 110, width: 40, height: 40 };
  coverage.overlap(rect);
  const firstRead = reads;
  assert.ok(firstRead > 0);
  coverage.update([line(points)], { ...bounds });
  for (let i = 0; i < 100; i++) coverage.overlap(rect);
  assert.equal(reads, firstRead);
  coverage.update([line(points)], { ...bounds, width: 400 });
  coverage.overlap(rect);
  assert.ok(reads > firstRead);
  coverage.update(
    [
      line([
        { x: 0, y: 20 },
        { x: 600, y: 20 },
      ]),
    ],
    bounds,
  );
  assert.equal(coverage.overlap(rect), 0);
});

test("raster coverage never loses a finite segment through a queried rectangle", () => {
  const coverage = new ChartLineCoverage();
  for (let i = 0; i < 80; i++) {
    const a = { x: i * 7.1, y: (i * 17.7) % 260 };
    const b = { x: (i * 19.3) % 600, y: (i * 31.7) % 260 };
    coverage.update([line([a, b])], bounds);
    for (let j = 1; j < 10; j++) {
      const point: Point = {
        x: a.x + ((b.x - a.x) * j) / 10,
        y: a.y + ((b.y - a.y) * j) / 10,
      };
      assert.ok(coverage.overlap({ ...point, width: 1, height: 1 }, 0) > 0);
    }
  }
});
