export type Point = { x: number; y: number };
type Size = { width: number; height: number };
export type Rectangle = Point & Size;
export interface PlottedLine {
  points: readonly { x: number | null; y: number | null }[];
  connectNulls: boolean;
}

const CELL = 4;

// Cache a conservative coverage grid of the rendered linear segments. Its summed
// area table makes each tooltip candidate an O(1) query, independent of data size.
export class ChartLineCoverage {
  private lines: readonly PlottedLine[] = [];
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private sums?: Uint32Array;
  private columns = 0;
  private rows = 0;

  update(lines: readonly PlottedLine[], bounds: Rectangle): void {
    if (
      bounds.x === this.bounds.x &&
      bounds.y === this.bounds.y &&
      bounds.width === this.bounds.width &&
      bounds.height === this.bounds.height &&
      lines.length === this.lines.length &&
      lines.every(
        (line, i) =>
          line.points === this.lines[i].points &&
          line.connectNulls === this.lines[i].connectNulls,
      )
    )
      return;
    this.lines = lines;
    this.bounds = bounds;
    this.sums = undefined;
  }

  overlap(rect: Rectangle, padding = 6): number {
    if (!this.sums) this.build();
    const { x, y } = this.bounds;
    const left = Math.max(0, Math.floor((rect.x - padding - x) / CELL));
    const top = Math.max(0, Math.floor((rect.y - padding - y) / CELL));
    const right = Math.min(
      this.columns,
      Math.ceil((rect.x + rect.width + padding - x) / CELL),
    );
    const bottom = Math.min(
      this.rows,
      Math.ceil((rect.y + rect.height + padding - y) / CELL),
    );
    if (right <= left || bottom <= top) return 0;
    const stride = this.columns + 1;
    const sums = this.sums!;
    return (
      sums[bottom * stride + right] -
      sums[top * stride + right] -
      sums[bottom * stride + left] +
      sums[top * stride + left]
    );
  }

  private build(): void {
    const { x, y, width, height } = this.bounds;
    const columns = (this.columns = Math.max(0, Math.ceil(width / CELL)));
    const rows = (this.rows = Math.max(0, Math.ceil(height / CELL)));
    const cells = new Uint8Array(columns * rows);
    const column = (value: number) =>
      Math.max(0, Math.min(columns - 1, Math.floor((value - x) / CELL)));
    const rowIndex = (value: number) =>
      Math.max(0, Math.min(rows - 1, Math.floor((value - y) / CELL)));
    const segment = (a: Point, b: Point) => {
      const dx = b.x - a.x,
        dy = b.y - a.y;
      let start = 0,
        end = 1;
      // Clip before walking cells, including segments crossing the whole viewport.
      if (
        a.x < x ||
        a.x > x + width ||
        b.x < x ||
        b.x > x + width ||
        a.y < y ||
        a.y > y + height ||
        b.y < y ||
        b.y > y + height
      ) {
        for (const [origin, delta, low, high] of [
          [a.x, dx, x, x + width],
          [a.y, dy, y, y + height],
        ]) {
          if (delta === 0) {
            if (origin < low || origin > high) return;
          } else {
            const first = (low - origin) / delta,
              last = (high - origin) / delta;
            start = Math.max(start, Math.min(first, last));
            end = Math.min(end, Math.max(first, last));
            if (start > end) return;
          }
        }
      }
      let previousX = column(a.x + dx * start);
      let previousY = rowIndex(a.y + dy * start);
      if (
        previousX === column(a.x + dx * end) &&
        previousY === rowIndex(a.y + dy * end)
      ) {
        cells[previousY * columns + previousX] = 1;
        return;
      }
      const steps = Math.max(
        1,
        Math.ceil(
          (Math.max(Math.abs(dx), Math.abs(dy)) * (end - start)) / CELL,
        ),
      );
      for (let i = 0; i <= steps; i++) {
        const t = start + ((end - start) * i) / steps;
        const currentX = column(a.x + dx * t);
        const currentY = rowIndex(a.y + dy * t);
        for (
          let row = Math.max(0, Math.min(previousY, currentY));
          row <= Math.min(rows - 1, Math.max(previousY, currentY));
          row++
        )
          for (
            let col = Math.max(0, Math.min(previousX, currentX));
            col <= Math.min(columns - 1, Math.max(previousX, currentX));
            col++
          )
            cells[row * columns + col] = 1;
        previousX = currentX;
        previousY = currentY;
      }
    };
    if (columns && rows)
      for (const line of this.lines) {
        let previous: Point | undefined;
        for (const point of line.points) {
          if (
            point.x === null ||
            point.y === null ||
            !Number.isFinite(point.x) ||
            !Number.isFinite(point.y)
          ) {
            if (!line.connectNulls) previous = undefined;
            continue;
          }
          const next = point as Point;
          if (previous) segment(previous, next);
          previous = next;
        }
      }
    const stride = columns + 1;
    const sums = (this.sums = new Uint32Array(stride * (rows + 1)));
    for (let row = 0; row < rows; row++) {
      let count = 0;
      for (let col = 0; col < columns; col++) {
        count += cells[row * columns + col];
        sums[(row + 1) * stride + col + 1] =
          sums[row * stride + col + 1] + count;
      }
    }
  }
}

export function chartTooltipPosition(
  bounds: Size,
  size: Size,
  anchor: Point,
  points: Point[],
  coverage?: ChartLineCoverage,
  headroom = 0,
): Point {
  const inset = 8,
    gap = 14;
  const maxX = Math.max(inset, bounds.width - size.width - inset);
  const maxY = Math.max(inset, bounds.height - size.height - inset);
  const samples = points.length ? points : [anchor];
  const top = Math.min(...samples.map((point) => point.y));
  const bottom = Math.max(...samples.map((point) => point.y));
  let best = { x: inset, y: inset };
  let bestOverlap = Infinity,
    bestPoints = Infinity,
    bestDistance = Infinity;
  let minY = inset;
  const consider = (x: number, y: number) => {
    x = Math.max(inset, Math.min(x, maxX));
    y = Math.max(minY, Math.min(y, maxY));
    const overlap = coverage?.overlap({ x, y, ...size }) ?? 0;
    if (overlap > bestOverlap) return;
    const covered = samples.filter(
      (point) =>
        point.x >= x - 6 &&
        point.x <= x + size.width + 6 &&
        point.y >= y - 6 &&
        point.y <= y + size.height + 6,
    ).length;
    const crossesCursor = anchor.x >= x && anchor.x <= x + size.width;
    const distance =
      Number(crossesCursor) * 10000 +
      Math.hypot(x + size.width / 2 - anchor.x, y + size.height / 2 - anchor.y);
    if (
      overlap < bestOverlap ||
      (overlap === bestOverlap &&
        (covered < bestPoints ||
          (covered === bestPoints && distance < bestDistance)))
    ) {
      best = { x, y };
      bestOverlap = overlap;
      bestPoints = covered;
      bestDistance = distance;
    }
  };
  for (const x of [anchor.x + gap, anchor.x - gap - size.width])
    for (const y of [top - gap - size.height, bottom + gap]) consider(x, y);
  // Search the full canvas, not just the four positions around the active point.
  if (coverage)
    for (let y = inset; y < maxY + CELL; y += CELL)
      for (let x = inset; x < maxX + CELL; x += CELL) consider(x, y);
  // A narrow/dense plot may have no clear rectangle. Float over its existing
  // heading only as a fallback; never reserve layout space or cover another plot.
  if (coverage && bestOverlap > 0 && headroom > 0) {
    minY = -headroom;
    for (let y = -headroom; y < inset; y += CELL)
      for (let x = inset; x < maxX + CELL; x += CELL) consider(x, y);
  }
  return best;
}
