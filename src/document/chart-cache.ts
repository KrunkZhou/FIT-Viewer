import type { ChartData, ChartQuery, Job } from "../model";
import type { FitDocument } from "./document";
import { chart, chartSensors } from "./series";
import { chartQueryGroups, chartQueryKey } from "./chart-query";

export class ChartCache {
  private documents = new WeakMap<
    FitDocument,
    Map<string, { data: ChartData; points: number }>
  >();
  constructor(
    private readonly maxEntries = 24,
    private readonly maxPoints = 100_000,
  ) {}

  clear(): void {
    this.documents = new WeakMap();
  }

  async query(
    document: FitDocument,
    query: ChartQuery,
    job: Job,
  ): Promise<ChartData> {
    await job.yield();
    const sensors = await chartSensors(document, query.developer, job);
    const groups = chartQueryGroups(sensors, query);
    const series: ChartData["series"] = {};
    let start = Infinity;
    let end = -Infinity;
    let single: ChartData | undefined;
    for (const group of groups) {
      const data = await this.group(document, group, job);
      single = data;
      Object.assign(series, data.series);
      if (Object.values(data.series).some((points) => points.length)) {
        start = Math.min(start, data.start);
        end = Math.max(end, data.end);
      }
    }
    if (groups.length === 1) return single!;
    return {
      sensors,
      series,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
    };
  }

  private async group(
    document: FitDocument,
    query: ChartQuery,
    job: Job,
  ): Promise<ChartData> {
    const key = chartQueryKey(query);
    let entries = this.documents.get(document);
    if (!entries) this.documents.set(document, (entries = new Map()));
    const cached = entries?.get(key);
    if (cached) {
      entries!.delete(key);
      entries!.set(key, cached);
      return cached.data;
    }
    const data = await chart(document, query, job);
    await job.yield();
    const points = Object.values(data.series).reduce(
      (sum, series) => sum + series.length,
      0,
    );
    // Never keep source buffers alive through the cache or retain an unbounded display result.
    if (points > this.maxPoints || this.maxEntries < 1) return data;
    entries.set(key, { data, points });
    let retained = [...entries.values()].reduce(
      (sum, entry) => sum + entry.points,
      0,
    );
    while (entries.size > this.maxEntries || retained > this.maxPoints) {
      const oldest = entries.keys().next().value!;
      retained -= entries.get(oldest)!.points;
      entries.delete(oldest);
    }
    return data;
  }
}
