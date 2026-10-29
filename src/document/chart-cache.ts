import type { ChartData, ChartQuery, Job } from "../model";
import type { FitDocument } from "./document";
import { chart, chartSensors, sensors as sensorCandidates } from "./series";
import { chartQueryGroups, chartQueryKey, isMotionSensor } from "./chart-query";
import { prepareChartDisplay } from "./chart-display";

export class ChartCache {
  private documents = new WeakMap<
    FitDocument,
    Map<string, { data: ChartData; points: number }>
  >();
  private displays = new WeakMap<ChartData, ChartData>();
  constructor(
    private readonly maxEntries = 24,
    private readonly maxPoints = 100_000,
  ) {}

  clear(): void {
    this.documents = new WeakMap();
    this.displays = new WeakMap();
  }

  async query(
    document: FitDocument,
    query: ChartQuery,
    job: Job,
    display = false,
  ): Promise<ChartData> {
    await job.yield();
    if (!query.sensors.length)
      return {
        sensors: await chartSensors(document, query.developer, job),
        series: {},
        start: 0,
        end: 0,
      };
    const groups = chartQueryGroups(
      sensorCandidates(document, query.developer),
      query,
    );
    let entries = this.documents.get(document);
    if (!entries) this.documents.set(document, (entries = new Map()));
    const candidates = new Map(
      sensorCandidates(document, query.developer).map((sensor) => [
        sensor.key,
        sensor,
      ]),
    );
    const missing = groups.filter(
      (group) =>
        !entries.has(chartQueryKey(group)) &&
        !isMotionSensor(candidates.get(group.sensors[0])!),
    );
    const prepared = new Map<string, ChartData>();
    if (missing.length) {
      const bounds = new Map<string, [number, number]>();
      const data = await chart(
        document,
        { ...query, sensors: missing.flatMap((group) => group.sensors) },
        job,
        false,
        bounds,
      );
      await job.yield();
      for (const group of missing) {
        const keys = new Set(group.sensors);
        const selected = data.sensors.filter((sensor) => keys.has(sensor.key));
        let start = Infinity;
        let end = -Infinity;
        for (const sensor of selected) {
          const range = bounds.get(sensor.key);
          if (range) {
            start = Math.min(start, range[0]);
            end = Math.max(end, range[1]);
          }
        }
        const result = {
          sensors: selected,
          series: Object.fromEntries(
            Object.entries(data.series).filter(([key]) => keys.has(key)),
          ),
          start: Number.isFinite(start) ? start : 0,
          end: Number.isFinite(end) ? end : 0,
        };
        prepared.set(chartQueryKey(group), result);
        this.retain(entries, chartQueryKey(group), result);
      }
    }
    const sensors = new Map<string, ChartData["sensors"][number]>();
    const series: ChartData["series"] = {};
    let start = Infinity;
    let end = -Infinity;
    let single: ChartData | undefined;
    const displays: NonNullable<ChartData["display"]> = [];
    for (const group of groups) {
      let data =
        prepared.get(chartQueryKey(group)) ??
        (await this.group(document, group, job));
      if (display) {
        const raw = data;
        data = this.displays.get(raw) ?? (await prepareChartDisplay(raw, job));
        this.displays.set(raw, data);
        displays.push(...(data.display ?? []));
      }
      single = data;
      for (const sensor of data.sensors) sensors.set(sensor.key, sensor);
      Object.assign(series, data.series);
      if (Object.values(data.series).some((points) => points.length)) {
        start = Math.min(start, data.start);
        end = Math.max(end, data.end);
      }
    }
    if (groups.length === 1) return single!;
    return {
      sensors: sensorCandidates(document, query.developer).flatMap((sensor) => {
        const known = sensors.get(sensor.key);
        return known ? [known] : [];
      }),
      series,
      start: Number.isFinite(start) ? start : 0,
      end: Number.isFinite(end) ? end : 0,
      ...(display ? { display: displays } : {}),
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
    this.retain(entries, key, data);
    return data;
  }

  private retain(
    entries: Map<string, { data: ChartData; points: number }>,
    key: string,
    data: ChartData,
  ): void {
    const points = Object.values(data.series).reduce(
      (sum, series) => sum + series.length,
      0,
    );
    // Never keep source buffers alive through the cache or retain an unbounded display result.
    if (points > this.maxPoints || this.maxEntries < 1) return;
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
  }
}
