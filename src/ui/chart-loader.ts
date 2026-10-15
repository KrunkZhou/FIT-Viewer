import type { ChartData, ChartPoint, ChartQuery } from "../model";
import { chartQueryKey } from "../document/chart-query";

interface Entry {
  query: ChartQuery;
  data?: ChartData;
  controller?: AbortController;
  error?: string;
  points: number;
}
export interface ChartLoadSnapshot {
  series: Record<string, ChartPoint[]>;
  loading: boolean;
  error: string;
}

export class ChartGroupLoader {
  private entries = new Map<string, Entry>();
  private selected: string[] = [];
  private running = new Set<Entry>();
  private listeners = new Set<() => void>();
  private disposed = false;
  private snapshot: ChartLoadSnapshot = {
    series: {},
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
      entry.controller?.abort();
      this.running.delete(entry);
      this.entries.delete(key);
    }
    for (const query of queries) {
      const key = chartQueryKey(query);
      const entry = this.entries.get(key) ?? { query, points: 0 };
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
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

  dispose(): void {
    this.disposed = true;
    for (const entry of this.running) entry.controller?.abort();
    this.running.clear();
    this.entries.clear();
    this.listeners.clear();
    this.snapshot = { series: {}, loading: false, error: "" };
  }

  private publish(): void {
    const series: ChartLoadSnapshot["series"] = {};
    let loading = false;
    let error = "";
    for (const key of this.selected) {
      const entry = this.entries.get(key)!;
      if (entry.data) Object.assign(series, entry.data.series);
      else if (entry.error) error ||= entry.error;
      else loading = true;
    }
    this.snapshot = { series, loading, error };
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
      entry.controller = controller;
      this.running.add(entry);
      this.request(entry.query, controller.signal)
        .then((data) => {
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.entries.get(key) !== entry
          )
            return;
          entry.data = data;
          entry.points = Object.values(data.series).reduce(
            (sum, points) => sum + points.length,
            0,
          );
        })
        .catch((error: Error) => {
          if (
            !this.disposed &&
            !controller.signal.aborted &&
            this.entries.get(key) === entry
          )
            entry.error = error.message;
        })
        .finally(() => {
          this.running.delete(entry);
          if (
            this.disposed ||
            controller.signal.aborted ||
            this.entries.get(key) !== entry
          )
            return;
          entry.controller = undefined;
          this.publish();
          this.trim();
          this.pump();
        });
    }
  }
}
