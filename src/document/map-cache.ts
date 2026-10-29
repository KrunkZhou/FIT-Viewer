import type { Job, MapData, TimeRange } from "../model";
import type { FitDocument } from "./document";
import { MapPlaybackIndex } from "./map-playback";
import { mapData } from "./series";

interface PreparedMap {
  data: MapData;
  index: MapPlaybackIndex;
}

export class MapCache {
  // Reuse recent date selections, bounded by both entries and source samples.
  private documents = new WeakMap<FitDocument, Map<string, PreparedMap>>();
  constructor(
    private readonly maxEntries = 3,
    private readonly maxSamples = 2_000_000,
  ) {}

  clear(): void {
    this.documents = new WeakMap();
  }

  async query(
    document: FitDocument,
    job: Job,
    dates?: TimeRange,
  ): Promise<PreparedMap> {
    await job.yield();
    const key = JSON.stringify([dates?.start, dates?.end, dates?.intervals]);
    let entries = this.documents.get(document);
    if (!entries) this.documents.set(document, (entries = new Map()));
    const cached = entries.get(key);
    if (cached) {
      entries.delete(key);
      entries.set(key, cached);
      return cached;
    }
    const index = new MapPlaybackIndex();
    const data = await mapData(document, job, false, dates, index);
    await job.yield();
    const map = { data, index };
    entries.set(key, map);
    const size = (entry: PreparedMap) =>
      entry.index.routes.reduce((total, route) => total + route.count, 0) +
      entry.data.points.length;
    let samples = [...entries.values()].reduce(
      (total, entry) => total + size(entry),
      0,
    );
    while (
      entries.size > 1 &&
      (entries.size > this.maxEntries || samples > this.maxSamples)
    ) {
      const oldest = entries.keys().next().value!;
      samples -= size(entries.get(oldest)!);
      entries.delete(oldest);
    }
    return map;
  }
}
