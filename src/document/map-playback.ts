import type {
  Job,
  MapPlaybackPosition,
  MapPlaybackRoute,
  Position,
} from "../model";
import type { FitDocument } from "./document";
import { positionCoordinates } from "./positions";

interface Segment {
  route: number;
  times: Float64Array;
  records: Uint32Array;
}
const POSITION_FIELDS = new Set(["0", "1", "2", "5", "78"]);

function lowerBound(times: Float64Array, target: number): number {
  let start = 0;
  let end = times.length;
  while (start < end) {
    const middle = start + Math.floor((end - start) / 2);
    if (times[middle] < target) start = middle + 1;
    else end = middle;
  }
  return start;
}

export class MapPlaybackIndex {
  readonly routes: MapPlaybackRoute[] = [];
  private segments: Segment[] = [];

  async addTrack(track: Position[], route: number, job: Job): Promise<void> {
    const times = new Float64Array(track.length);
    const records = new Uint32Array(track.length);
    for (let i = 0; i < track.length; i++) {
      times[i] = track[i].time ?? NaN;
      records[i] = track[i].record;
      if (i % 4096 === 0) await job.yield();
    }
    await this.addColumns(times, records, route, job);
  }

  async addColumns(
    inputTimes: Float64Array,
    inputRecords: Uint32Array,
    route: number,
    job: Job,
  ): Promise<void> {
    // Own compact arrays so a short route never retains a mostly empty block.
    const times = inputTimes.slice();
    const records = inputRecords.slice();
    let count = 0;
    let first = 0;
    let start = Infinity;
    let end = -Infinity;
    const finish = () => {
      if (count > first)
        this.segments.push({
          route,
          times: times.subarray(first, count),
          records: records.subarray(first, count),
        });
      first = count;
    };
    for (let index = 0; index < inputTimes.length; index++) {
      if (index % 4096 === 0) await job.yield();
      const time = inputTimes[index];
      if (!Number.isFinite(time)) continue;
      // Keep unsorted timestamp runs separate rather than inventing a route order.
      if (count > first && time < times[count - 1]) finish();
      times[count] = time;
      records[count++] = inputRecords[index];
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
    finish();
    if (count) {
      const existing = this.routes.at(-1);
      if (existing?.route === route) {
        existing.start = Math.min(existing.start, start);
        existing.end = Math.max(existing.end, end);
        existing.count += count;
      } else this.routes.push({ route, start, end, count });
    }
  }

  async position(
    document: FitDocument,
    time: number,
    routes: number[],
    job: Job,
  ): Promise<MapPlaybackPosition | null> {
    if (!Number.isFinite(time)) return null;
    const allowed = new Set(routes);
    let nearest: { time: number; record: number; route: number } | undefined;
    let distance = Infinity;
    for (let index = 0; index < this.segments.length; index++) {
      if (index % 128 === 0) await job.yield();
      const segment = this.segments[index];
      if (!allowed.has(segment.route)) continue;
      const insertion = lowerBound(segment.times, time);
      for (const candidate of [insertion - 1, insertion]) {
        if (candidate < 0 || candidate >= segment.times.length) continue;
        const timestamp = segment.times[candidate];
        const first = lowerBound(segment.times, timestamp);
        const record = segment.records[first];
        const delta = Math.abs(time - timestamp);
        if (
          delta < distance ||
          (delta === distance &&
            (!nearest ||
              timestamp < nearest.time ||
              (timestamp === nearest.time && record < nearest.record)))
        ) {
          distance = delta;
          nearest = { time: timestamp, record, route: segment.route };
        }
      }
    }
    if (!nearest) return null;
    const cells = document.cells(nearest.record, true, POSITION_FIELDS);
    const coordinates = positionCoordinates(
      cells["0"]?.value,
      cells["1"]?.value,
    );
    if (!coordinates) return null;
    const elevation = cells["78"]?.value ?? cells["2"]?.value;
    const distanceValue = cells["5"]?.value;
    return {
      ...coordinates,
      ...nearest,
      ...(typeof elevation === "number" ? { elevation } : {}),
      ...(typeof distanceValue === "number" ? { distance: distanceValue } : {}),
    };
  }
}
