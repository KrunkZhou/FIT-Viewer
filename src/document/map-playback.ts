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
    for (let index = 0; index < track.length; index++) {
      if (index % 4096 === 0) await job.yield();
      const point = track[index];
      if (point.time === undefined || !Number.isFinite(point.time)) continue;
      // Keep unsorted timestamp runs separate rather than inventing a route order.
      if (count > first && point.time < times[count - 1]) finish();
      times[count] = point.time;
      records[count++] = point.record;
      start = Math.min(start, point.time);
      end = Math.max(end, point.time);
    }
    finish();
    if (count) this.routes.push({ route, start, end, count });
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
    const cells = document.cells(nearest.record);
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
