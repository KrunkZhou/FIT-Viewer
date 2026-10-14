import type { ChartData, ChartQuery, Job } from "../model";
import type { FitDocument } from "./document";
import { chart } from "./series";

function cacheKey(query: ChartQuery): string {
  return JSON.stringify([
    [...new Set(query.sensors)].sort(),
    query.width,
    query.detail ?? "standard",
    query.developer,
    query.start,
    query.end,
    query.filter?.min,
    query.filter?.max,
    query.dates?.start,
    query.dates?.end,
    query.dates?.intervals,
  ]);
}

export class ChartCache {
  private documents = new WeakMap<
    FitDocument,
    Map<string, { data: ChartData; points: number }>
  >();
  constructor(
    private readonly maxEntries = 6,
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
    const key = cacheKey(query);
    let entries = this.documents.get(document);
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
    if (!entries) this.documents.set(document, (entries = new Map()));
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
