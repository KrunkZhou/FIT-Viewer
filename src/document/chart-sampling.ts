import type { ChartDetail } from "../model";

export function chartPointBudget(
  width: number,
  detail: ChartDetail = "standard",
): number {
  const density = { standard: 2, high: 4, maximum: 8 }[detail] ?? 2;
  const pixels = Number.isFinite(width) ? Math.max(0, Math.round(width)) : 0;
  return Math.max(8, Math.min(8192, pixels * density));
}
