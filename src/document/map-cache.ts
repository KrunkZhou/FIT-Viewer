import type { Job, MapData, TimeRange } from "../model";
import type { FitDocument } from "./document";
import { MapPlaybackIndex } from "./map-playback";
import { mapData } from "./series";

interface PreparedMap {
  data: MapData;
  index: MapPlaybackIndex;
}

export class MapCache {
  // Retain only the latest filter per document; document replacement releases it.
  private documents = new WeakMap<
    FitDocument,
    { key: string; map: PreparedMap }
  >();

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
    const cached = this.documents.get(document);
    if (cached?.key === key) return cached.map;
    const index = new MapPlaybackIndex();
    const data = await mapData(document, job, false, dates, index);
    await job.yield();
    const map = { data, index };
    this.documents.set(document, { key, map });
    return map;
  }
}
