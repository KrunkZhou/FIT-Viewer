export const FIT_EPOCH = 631065600000;
export const HOUR_CYCLE = "h23" as const;

export function formatTimestamp(time: number, locale?: string): string {
  return new Date(FIT_EPOCH + time * 1000).toLocaleString(locale, {
    hourCycle: HOUR_CYCLE,
  });
}

export function localDateKey(time?: number): string {
  if (time === undefined) return "";
  const date = new Date(FIT_EPOCH + time * 1000);
  if (!Number.isFinite(date.getTime())) return "";
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}
