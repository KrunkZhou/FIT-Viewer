import { FIT_EPOCH } from "../protocol/time";
import type { TimeRange } from "../model";

export { localDateKey as dateInputValue } from "../protocol/time";

export function usesDateList(dates: string[]): boolean {
  return dates.length > 0 && dates.length < 15;
}

export function selectedDateRange(dates: string[]): TimeRange {
  const intervals = [...new Set(dates)].sort().map((date) => {
    const range = dateFilterRange(date, date);
    return { start: range.start!, end: range.end! };
  });
  return { start: intervals[0]?.start, end: intervals.at(-1)?.end, intervals };
}

export function selectedDates(available: string[], range: TimeRange): string[] {
  return available.filter((date) => {
    const day = dateFilterRange(date, date);
    const start = Math.max(day.start!, range.start ?? -Infinity);
    const end = Math.min(day.end!, range.end ?? Infinity);
    return (
      start <= end &&
      (range.intervals === undefined ||
        range.intervals.some(
          (interval) => interval.start <= end && interval.end >= start,
        ))
    );
  });
}

export function dateLabel(date: string): string {
  return localDay(date).toLocaleDateString(undefined, {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function localDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new Error("Enter a valid date.");
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  if (
    year < 100 ||
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    throw new Error("Enter a valid date.");
  return date;
}

export function dateFilterRange(from: string, through: string): TimeRange {
  const start = from ? localDay(from) : undefined;
  const last = through ? localDay(through) : undefined;
  if (start && last && start > last)
    throw new Error("The end date must be on or after the start date.");
  // Calendar arithmetic keeps the full local day on 23- and 25-hour DST days.
  if (last) last.setDate(last.getDate() + 1);
  return {
    start: start ? (start.getTime() - FIT_EPOCH) / 1000 : undefined,
    end: last ? (last.getTime() - FIT_EPOCH - 1) / 1000 : undefined,
  };
}
