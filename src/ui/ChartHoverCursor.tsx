import { useSyncExternalStore } from "react";
import type { ChartTimeDomain } from "./chart-time";
import type { ChartHoverStore } from "./chart-hover";

export function ChartHoverCursor({
  store,
  domain,
  xAxisMap,
  offset,
}: {
  store: ChartHoverStore;
  domain: ChartTimeDomain;
  xAxisMap?: Record<string, { scale?: (time: number) => number }>;
  offset?: { left?: number; top?: number; width?: number; height?: number };
}) {
  const time = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const scale = xAxisMap?.["0"]?.scale;
  if (
    time === undefined ||
    time < domain[0] ||
    time > domain[1] ||
    !scale ||
    offset?.top === undefined ||
    offset.height === undefined ||
    offset.left === undefined ||
    offset.width === undefined
  )
    return null;
  const x = scale(time);
  if (
    !Number.isFinite(x) ||
    x < offset.left ||
    x > offset.left + offset.width ||
    offset.height <= 0
  )
    return null;
  return (
    <line
      className="viewer-chart-hover-line"
      data-time={time}
      x1={x}
      x2={x}
      y1={offset.top}
      y2={offset.top + offset.height}
      stroke="var(--viewer-muted)"
      strokeWidth={1}
      pointerEvents="none"
      aria-hidden="true"
    />
  );
}
