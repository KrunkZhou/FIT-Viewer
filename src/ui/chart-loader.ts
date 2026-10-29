import type { ChartData, ChartDisplay, ChartPoint, ChartQuery } from "../model";
import { chartBatchKey, chartQueryKey } from "../document/chart-query";
import { chartDisplayKey } from "../document/chart-display";

interface Entry {
  query: ChartQuery;
  data?: ChartData;
  controller?: AbortController;
  error?: string;
  points: number;
}
export interface ChartLoadSnapshot {
  series: Record<string, ChartPoint[]>;
  display: Record<string, ChartDisplay>;
  loading: boolean;
  error: string;
}

export class ChartGroupLoader {
  private entries = new Map<string, Entry>();
  private selected: string[] = [];
  private running = new Set<{
    entries: Entry[];
    controller: AbortController;
  }>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private snapshot: ChartLoadSnapshot = {
    series: {},
    display: {},
    loading: false,
    error: "",
  };

  constructor(
    private readonly request: (
      query: ChartQuery,
      signal: AbortSignal,
    ) => Promise<ChartData>,
    private readonly maxEntries = 24,
    private readonly maxPoints = 100_000,
  ) {}

  getSnapshot = (): ChartLoadSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  select(queries: ChartQuery[]): void {
    if (this.disposed) return;
    this.selected = [...new Set(queries.map(chartQueryKey))];
    const selected = new Set(this.selected);
    for (const [key, entry] of this.entries) {
      if (selected.has(key) || (!entry.controller && !entry.error)) continue;
      this.entries.delete(key);
    }
    for (const query of queries) {
      const key = chartQueryKey(query);
      const entry = this.entries.get(key) ?? { query, points: 0 };
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    this.cancelUnwanted();
    this.publish();
    this.trim();
    this.pump();
  }

  retry(): void {
    if (this.disposed) return;
    for (const key of this.selected) {
      const entry = this.entries.get(key);
      if (entry) entry.error = undefined;
    }
    this.publish();
    this.pump();
  }

  seed(queries: ChartQuery[], data: ChartData): void {
    if (this.disposed) return;
    for (const query of queries) {
      if (!query.sensors.every((key) => Object.hasOwn(data.series, key)))
        continue;
      const key = chartQueryKey(query);
      const previous = this.entries.get(key);
      if (previous?.data) continue;
      const series = Object.fromEntries(
        query.sensors.map((key) => [key, data.series[key]]),
      );
      this.entries.set(key, {
        query,
        data: this.selectData(data, query),
        points: Object.values(series).reduce(
          (total, points) => total + points.length,
          0,
        ),
      });
    }
    this.cancelUnwanted();
    this.publish();
    this.trim();
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const batch of this.running) batch.controller.abort();
    this.running.clear();
    this.entries.clear();
    this.listeners.clear();
    this.snapshot = { series: {}, display: {}, loading: false, error: "" };
  }

  private publish(): void {
    const series: ChartLoadSnapshot["series"] = {};
    const display: ChartLoadSnapshot["display"] = {};
    let loading = false;
    let error = "";
    for (const key of this.selected) {
      const entry = this.entries.get(key)!;
      if (entry.data) {
        Object.assign(series, entry.data.series);
        for (const plot of entry.data.display ?? [])
          display[chartDisplayKey(plot.members)] = plot;
      } else if (entry.error) error ||= entry.error;
      else loading = true;
    }
    this.snapshot = { series, display, loading, error };
    for (const listener of this.listeners) listener();
  }

  private trim(): void {
    const selected = new Set(this.selected);
    let points = [...this.entries.values()].reduce(
      (sum, entry) => sum + entry.points,
      0,
    );
    // Selected data is the visible view; bound only the extra retained results.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && points <= this.maxPoints)
        break;
      if (selected.has(key)) continue;
      this.entries.delete(key);
      points -= entry.points;
    }
  }

  private pump(): void {
    if (this.disposed) return;
    for (const key of this.selected) {
      if (this.running.size >= 2) break;
      const entry = this.entries.get(key)!;
      if (entry.data || entry.error || entry.controller) continue;
      const controller = new AbortController();
      const batchKey = chartBatchKey(entry.query);
      const members =
        batchKey === undefined
          ? [entry]
          : this.selected
              .flatMap((selected) => {
                const candidate = this.entries.get(selected)!;
                return !candidate.data &&
                  !candidate.error &&
                  !candidate.controller &&
                  chartBatchKey(candidate.query) === batchKey
                  ? [candidate]
                  : [];
              })
              .slice(0, 8);
      const batch = { entries: members, controller };
      for (const member of members) member.controller = controller;
      this.running.add(batch);
      const query = {
        ...entry.query,
        sensors: members.flatMap((member) => member.query.sensors),
      };
      this.request(query, controller.signal)
        .then((data) => {
          if (this.disposed || controller.signal.aborted) return;
          for (const member of members) {
            if (this.entries.get(chartQueryKey(member.query)) !== member)
              continue;
            member.data = this.selectData(data, member.query);
            member.points = Object.values(member.data.series).reduce(
              (sum, points) => sum + points.length,
              0,
            );
          }
        })
        .catch((error: Error) => {
          if (!this.disposed && !controller.signal.aborted)
            for (const member of members)
              if (this.entries.get(chartQueryKey(member.query)) === member)
                member.error = error.message;
        })
        .finally(() => {
          this.running.delete(batch);
          if (this.disposed || controller.signal.aborted) return;
          for (const member of members) member.controller = undefined;
          this.publish();
          this.trim();
          this.pump();
        });
    }
  }

  private selectData(data: ChartData, query: ChartQuery): ChartData {
    const keys = new Set(query.sensors);
    return {
      ...data,
      sensors: data.sensors.filter((sensor) => keys.has(sensor.key)),
      series: Object.fromEntries(
        Object.entries(data.series).filter(([key]) => keys.has(key)),
      ),
      display: data.display?.filter((plot) =>
        plot.members.every((key) => keys.has(key)),
      ),
    };
  }

  private cancelUnwanted(): void {
    for (const batch of this.running) {
      if (
        batch.entries.some(
          (entry) => this.entries.get(chartQueryKey(entry.query)) === entry,
        )
      )
        continue;
      batch.controller.abort();
      this.running.delete(batch);
    }
  }
}
