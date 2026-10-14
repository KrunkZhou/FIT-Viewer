import type { MapPlaybackRoute } from "../model";

export interface MapTimeInterval {
  start: number;
  end: number;
  offset: number;
  length: number;
}

export interface MapTimeRange {
  start: number;
  end: number;
  routes: number[];
  intervals: MapTimeInterval[];
  length: number;
}

function visibleRoutes(routes: MapPlaybackRoute[], hidden: number[]) {
  const excluded = new Set(hidden);
  return routes.filter(
    (route) =>
      !excluded.has(route.route) &&
      Number.isInteger(route.route) &&
      route.route >= 0 &&
      Number.isFinite(route.start) &&
      Number.isFinite(route.end) &&
      route.start <= route.end,
  );
}

export function mapTimeRange(
  routes: MapPlaybackRoute[],
  hidden: number[],
): MapTimeRange | undefined {
  const visible = visibleRoutes(routes, hidden);
  if (!visible.length) return undefined;
  const intervals: MapTimeInterval[] = [];
  for (const route of [...visible].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    const previous = intervals.at(-1);
    if (previous && route.start <= previous.end)
      previous.end = Math.max(previous.end, route.end);
    else
      intervals.push({
        start: route.start,
        end: route.end,
        offset: 0,
        length: 0,
      });
  }
  let length = 0;
  for (const interval of intervals) {
    interval.offset = length;
    // Isolated GPS timestamps need a selectable slot, not an invented timestamp.
    interval.length =
      interval.end > interval.start ? interval.end - interval.start : 1;
    length += interval.length;
  }
  return {
    start: intervals[0].start,
    end: intervals.at(-1)!.end,
    routes: visible.map((route) => route.route),
    intervals,
    length,
  };
}

function timeIntervalIndex(
  intervals: readonly { start: number }[],
  time: number,
): number {
  let start = 0;
  let end = intervals.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (intervals[middle].start <= time) start = middle + 1;
    else end = middle;
  }
  return Math.max(0, start - 1);
}

export function mapCursorTime(
  time: number | undefined,
  range:
    | {
        start: number;
        end: number;
        intervals?: readonly { start: number; end: number }[];
      }
    | undefined,
) {
  if (!range) return undefined;
  const value =
    time === undefined || !Number.isFinite(time)
      ? range.start
      : Math.max(range.start, Math.min(range.end, time));
  if (!range.intervals?.length) return value;
  const index = timeIntervalIndex(range.intervals, value);
  const previous = range.intervals[index];
  if (value <= previous.end) return value;
  const next = range.intervals[index + 1];
  return !next || value - previous.end <= next.start - value
    ? previous.end
    : next.start;
}

export function mapProgressFromTime(
  time: number | undefined,
  range: MapTimeRange | undefined,
): number | undefined {
  const value = mapCursorTime(time, range);
  if (!range || value === undefined) return undefined;
  if (value === range.start) return 0;
  if (value === range.end) return range.length;
  const interval = range.intervals[timeIntervalIndex(range.intervals, value)];
  return (
    interval.offset +
    (interval.end > interval.start
      ? value - interval.start
      : interval.length / 2)
  );
}

export function mapTimeFromProgress(
  progress: number,
  range: MapTimeRange | undefined,
): number | undefined {
  if (!range) return undefined;
  const value = Number.isFinite(progress)
    ? Math.max(0, Math.min(range.length, progress))
    : 0;
  if (value === 0) return range.start;
  if (value === range.length) return range.end;
  let start = 0;
  let end = range.intervals.length - 1;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    const interval = range.intervals[middle];
    if (interval.offset + interval.length < value) start = middle + 1;
    else end = middle;
  }
  const interval = range.intervals[start];
  return (
    interval.start +
    ((value - interval.offset) / interval.length) *
      (interval.end - interval.start)
  );
}

export interface MapTimelineSegment {
  start: number;
  end: number;
  colors: string[];
}

export function mapTimelineSegments(
  routes: MapPlaybackRoute[],
  hidden: number[],
  palette: string[],
  axis?: MapTimeRange,
): MapTimelineSegment[] {
  if (!palette.length) return [];
  const visible = visibleRoutes(routes, hidden);
  const range = axis ?? mapTimeRange(visible, []);
  if (!range) return [];
  const colors = [...new Set(palette)];
  if (range.start === range.end)
    return [
      {
        start: 0,
        end: 100,
        colors: colors.filter((color) =>
          visible.some(
            (route) => palette[route.route % palette.length] === color,
          ),
        ),
      },
    ];

  // A bounded color histogram keeps large folder imports from creating thousands of DOM segments.
  const steps = 512;
  const lanes = colors.map(() => new Int32Array(steps + 1));
  const scale = steps / range.length;
  for (const route of visible) {
    const interval =
      range.intervals[timeIntervalIndex(range.intervals, route.start)];
    const from = interval.offset + (route.start - interval.start);
    const to =
      interval.end > interval.start
        ? interval.offset + (route.end - interval.start)
        : interval.offset + interval.length;
    const first = Math.max(0, Math.min(steps - 1, Math.floor(from * scale)));
    const last = Math.max(first + 1, Math.min(steps, Math.ceil(to * scale)));
    const lane = lanes[colors.indexOf(palette[route.route % palette.length])];
    lane[first]++;
    lane[last]--;
  }
  const counts = colors.map(() => 0);
  const bins: string[][] = [];
  for (let step = 0; step < steps; step++) {
    const active: string[] = [];
    lanes.forEach((lane, index) => {
      counts[index] += lane[step];
      if (counts[index] > 0) active.push(colors[index]);
    });
    bins.push(active);
  }
  const output: MapTimelineSegment[] = [];
  for (let step = 0; step < steps; step++) {
    const active = bins[step];
    const previous = output.at(-1);
    const end = ((step + 1) * 100) / steps;
    if (
      previous &&
      previous.colors.length === active.length &&
      previous.colors.every((color, index) => color === active[index])
    )
      previous.end = end;
    else output.push({ start: (step * 100) / steps, end, colors: active });
  }
  return output;
}
