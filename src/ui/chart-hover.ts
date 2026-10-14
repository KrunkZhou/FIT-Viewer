import type { ChartTimeDomain } from "./chart-time";

export function chartHoverTime(
  value: unknown,
  active: boolean,
  domain: ChartTimeDomain,
): number | undefined {
  if (
    !active ||
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && !value.trim())
  )
    return undefined;
  const time = Number(value);
  return Number.isFinite(time) && time >= domain[0] && time <= domain[1]
    ? time
    : undefined;
}

export class ChartHoverStore {
  private time: number | undefined;
  private listeners = new Set<() => void>();
  getSnapshot = () => this.time;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  update = (value: unknown, active: boolean, domain: ChartTimeDomain) => {
    this.publish(chartHoverTime(value, active, domain));
  };
  clear = () => this.publish(undefined);
  private publish(time: number | undefined) {
    if (this.time === time) return;
    this.time = time;
    for (const listener of this.listeners) listener();
  }
}
