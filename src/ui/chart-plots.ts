import type { ChartData, ChartPoint, Sensor } from "../model";
import { chartLines, type ChartGroup, type ChartTrace } from "./chart-groups";

export interface PreparedPlot {
  sensor: Sensor;
  traces: ChartTrace[];
  lines: ReturnType<typeof chartLines>;
  points: ChartPoint[];
}
const EMPTY_POINTS: ChartPoint[] = [];

export class ChartPlotCache {
  private entries = new Map<string, PreparedPlot>();

  prepare(
    groups: ChartGroup[],
    series: ChartData["series"],
    color: (sensor: Sensor) => string,
  ): PreparedPlot[] {
    const next = new Map<string, PreparedPlot>();
    for (const group of groups) {
      const existing = this.entries.get(group.sensor.key);
      if (
        existing &&
        existing.traces.length === group.members.length &&
        existing.traces.every(
          (trace, i) =>
            trace.sensor === group.members[i] &&
            trace.points === (series[trace.sensor.key] ?? EMPTY_POINTS),
        )
      ) {
        next.set(group.sensor.key, existing);
        continue;
      }
      const traces = group.members.map((member) => ({
        sensor: member,
        points: series[member.key] ?? EMPTY_POINTS,
        color: color({ ...member, key: group.sensor.key }),
      }));
      const lines = chartLines(traces);
      const points =
        lines.length > 1
          ? lines
              .flatMap((trace) => trace.points)
              .sort((a, b) => a.time - b.time)
          : (lines[0]?.points ?? EMPTY_POINTS);
      if (points.length)
        next.set(group.sensor.key, {
          sensor: group.sensor,
          traces,
          lines,
          points,
        });
    }
    this.entries = next;
    return [...next.values()];
  }
}
