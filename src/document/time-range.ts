import type { TimeRange } from "../model";

export function hasTimeRange(range?: TimeRange): boolean {
  return (
    range?.start !== undefined ||
    range?.end !== undefined ||
    range?.intervals !== undefined
  );
}

export function inTimeRange(
  time: number | undefined,
  range?: TimeRange,
): boolean {
  if (!hasTimeRange(range)) return true;
  return (
    time !== undefined &&
    Number.isFinite(time) &&
    (range?.start === undefined || time >= range.start) &&
    (range?.end === undefined || time <= range.end) &&
    (range?.intervals === undefined ||
      range.intervals.some(
        (interval) => time >= interval.start && time <= interval.end,
      ))
  );
}

export function intersectTimeRanges(a: TimeRange, b?: TimeRange): TimeRange {
  return {
    start:
      a.start === undefined
        ? b?.start
        : b?.start === undefined
          ? a.start
          : Math.max(a.start, b.start),
    end:
      a.end === undefined
        ? b?.end
        : b?.end === undefined
          ? a.end
          : Math.min(a.end, b.end),
  };
}
