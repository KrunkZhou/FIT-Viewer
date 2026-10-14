import type { ChartPoint, Sensor, TimeRange } from "../model";
import { FIT_EPOCH, HOUR_CYCLE, formatTimestamp } from "../protocol/time";

export const DAY_PERIODS = [
  { name: "Night", start: 0, end: 6, color: "#817eac" },
  { name: "Morning", start: 6, end: 12, color: "#d4aa42" },
  { name: "Afternoon", start: 12, end: 18, color: "#539fc1" },
  { name: "Evening", start: 18, end: 22, color: "#c87e86" },
  { name: "Night", start: 22, end: 24, color: "#817eac" },
] as const;

export function dayPeriodRange(name: string): string {
  const period = DAY_PERIODS.find((period) => period.name === name);
  if (!period) return "";
  return name === "Night"
    ? "22:00 - 06:00 (next day)"
    : `${String(period.start).padStart(2, "0")}:00 - ${String(period.end).padStart(2, "0")}:00`;
}

export function dividerDate(
  time: number,
  multipleYears: boolean,
  locale?: string,
): string {
  return chartDate(time).toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(multipleYears ? { year: "numeric" as const } : {}),
  });
}

export const chartDate = (time: number) => new Date(FIT_EPOCH + time * 1000);
const fitTime = (date: Date) => (date.getTime() - FIT_EPOCH) / 1000;
const calendarDay = (date: Date) =>
  Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000;

export interface ChartTimeline {
  multipleDates: boolean;
  multipleYears: boolean;
  midnights: number[];
  periods: { start: number; end: number; name: string; color: string }[];
}

export type ChartTimeDomain = [number, number];

export function chartTimeDomain(
  plots: readonly {
    sensor: Pick<Sensor, "axis">;
    points: readonly ChartPoint[];
  }[],
  zoom: Pick<TimeRange, "start" | "end"> = {},
): ChartTimeDomain | undefined {
  let start = Infinity;
  let end = -Infinity;
  for (const plot of plots) {
    if (plot.sensor.axis === "sample") continue;
    for (const point of plot.points) {
      if (!Number.isFinite(point.time)) continue;
      start = Math.min(start, point.time);
      end = Math.max(end, point.time);
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  if (zoom.start !== undefined && Number.isFinite(zoom.start))
    start = zoom.start;
  if (zoom.end !== undefined && Number.isFinite(zoom.end)) end = zoom.end;
  if (start > end) return undefined;
  return start === end ? [start - 0.5, end + 0.5] : [start, end];
}

export function chartTimeTicks(
  domain: ChartTimeDomain,
  width: number,
): number[] {
  const count = Math.max(2, Math.min(6, Math.floor((width - 72) / 140)));
  return Array.from({ length: count }, (_, index) =>
    index === count - 1
      ? domain[1]
      : domain[0] + ((domain[1] - domain[0]) * index) / (count - 1),
  );
}

export function chartTimeline(
  points: ChartPoint[],
  axis: Sensor["axis"],
  domain?: ChartTimeDomain,
): ChartTimeline {
  const result: ChartTimeline = {
    multipleDates: false,
    multipleYears: false,
    midnights: [],
    periods: [],
  };
  if (axis === "sample") return result;
  let [start, end] = domain ?? [Infinity, -Infinity];
  if (!domain)
    for (const point of points) {
      if (!Number.isFinite(point.time)) continue;
      start = Math.min(start, point.time);
      end = Math.max(end, point.time);
    }
  const first = chartDate(start);
  const last = chartDate(end);
  if (!Number.isFinite(first.getTime()) || !Number.isFinite(last.getTime()))
    return result;
  const days = calendarDay(last) - calendarDay(first);
  result.multipleDates = days > 0;
  result.multipleYears = first.getFullYear() !== last.getFullYear();

  // Advance calendar dates, not 24-hour durations: local days can cross DST.
  const boundary = (day: number, hour = 0) =>
    fitTime(
      new Date(
        first.getFullYear(),
        first.getMonth(),
        first.getDate() + day,
        hour,
      ),
    );
  const stride = Math.max(1, Math.ceil(days / 64));
  for (let day = stride; day <= days; day += stride) {
    const time = boundary(day);
    if (time > start && time < end) result.midnights.push(time);
  }
  // Keep rendering bounded for very long recordings and corrupt time ranges.
  if (days > 31) return result;
  for (let day = 0; day <= days; day++) {
    for (const period of DAY_PERIODS) {
      const from = Math.max(start, boundary(day, period.start));
      const to = Math.min(end, boundary(day, period.end));
      if (to > from)
        result.periods.push({
          start: from,
          end: to,
          name: period.name,
          color: period.color,
        });
    }
  }
  return result;
}

export function chartTick(
  time: number,
  timeline: ChartTimeline,
  locale?: string,
) {
  const date = chartDate(time);
  return {
    time: date.toLocaleTimeString(locale, {
      hourCycle: HOUR_CYCLE,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }),
    date: timeline.multipleDates
      ? dividerDate(time, timeline.multipleYears, locale)
      : undefined,
  };
}

export function chartTimeLabel(time: number, locale?: string): string {
  const date = chartDate(time);
  const period = DAY_PERIODS.find(
    (period) => date.getHours() >= period.start && date.getHours() < period.end,
  );
  return `${formatTimestamp(time, locale)}${period ? ` - ${period.name}` : ""}`;
}
