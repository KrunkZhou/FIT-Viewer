import type { Job, Position } from "../model";
import type { MapPlaybackIndex } from "./map-playback";

const BLOCK_SIZE = 8192;
interface Block {
  lat: Float64Array;
  lon: Float64Array;
  time: Float64Array;
  elevation: Float64Array;
  distance: Float64Array;
  record: Uint32Array;
}

/** Column storage keeps full-resolution routes out of the object heap. */
export class MapTrack {
  private blocks: Block[] = [];
  length = 0;

  add(point: Position): void {
    const slot = this.length % BLOCK_SIZE;
    if (!slot)
      this.blocks.push({
        lat: new Float64Array(BLOCK_SIZE),
        lon: new Float64Array(BLOCK_SIZE),
        time: new Float64Array(BLOCK_SIZE),
        elevation: new Float64Array(BLOCK_SIZE),
        distance: new Float64Array(BLOCK_SIZE),
        record: new Uint32Array(BLOCK_SIZE),
      });
    const block = this.blocks.at(-1)!;
    block.lat[slot] = point.lat;
    block.lon[slot] = point.lon;
    block.time[slot] = point.time ?? NaN;
    block.elevation[slot] = point.elevation ?? NaN;
    block.distance[slot] = point.distance ?? NaN;
    block.record[slot] = point.record;
    this.length++;
  }
  latitude(index: number): number {
    return this.blocks[Math.floor(index / BLOCK_SIZE)].lat[index % BLOCK_SIZE];
  }
  longitude(index: number): number {
    return this.blocks[Math.floor(index / BLOCK_SIZE)].lon[index % BLOCK_SIZE];
  }
  point(index: number): Position {
    const block = this.blocks[Math.floor(index / BLOCK_SIZE)];
    const slot = index % BLOCK_SIZE;
    return {
      lat: block.lat[slot],
      lon: block.lon[slot],
      time: Number.isNaN(block.time[slot]) ? undefined : block.time[slot],
      record: block.record[slot],
      ...(Number.isNaN(block.elevation[slot])
        ? {}
        : { elevation: block.elevation[slot] }),
      ...(Number.isNaN(block.distance[slot])
        ? {}
        : { distance: block.distance[slot] }),
    };
  }
  async playback(
    index: MapPlaybackIndex,
    route: number,
    job: Job,
  ): Promise<void> {
    let offset = 0;
    for (const block of this.blocks) {
      const length = Math.min(BLOCK_SIZE, this.length - offset);
      await index.addColumns(
        block.time.subarray(0, length),
        block.record.subarray(0, length),
        route,
        job,
      );
      offset += length;
    }
  }
  async display(full: boolean, job: Job): Promise<Position[]> {
    const keep = new Uint8Array(this.length);
    if (full) keep.fill(1);
    else if (this.length) {
      keep[0] = keep[this.length - 1] = 1;
      const stack = [[0, this.length - 1, 0]];
      let work = 0;
      while (stack.length) {
        const [first, last, depth] = stack.pop()!;
        // Pathological GPS jitter can make RDP quadratic. Retaining unresolved
        // vertices bounds work without weakening the geometric error tolerance.
        if (depth >= 32) {
          for (let i = first; i <= last; i++) {
            keep[i] = 1;
            if (++work % 4096 === 0) await job.yield();
          }
          continue;
        }
        const ax = this.longitude(first),
          ay = this.latitude(first);
        const dx = this.longitude(last) - ax,
          dy = this.latitude(last) - ay;
        const length = dx * dx + dy * dy;
        let farthest = -1,
          maximum = 0.00002 ** 2;
        for (let i = first + 1; i < last; i++) {
          const x = this.longitude(i) - ax,
            y = this.latitude(i) - ay;
          const fraction = length
            ? Math.max(0, Math.min(1, (x * dx + y * dy) / length))
            : 0;
          const distance = (x - fraction * dx) ** 2 + (y - fraction * dy) ** 2;
          if (distance > maximum) {
            maximum = distance;
            farthest = i;
          }
          if (++work % 4096 === 0) await job.yield();
        }
        if (farthest >= 0) {
          keep[farthest] = 1;
          stack.push([first, farthest, depth + 1], [farthest, last, depth + 1]);
        }
      }
    }
    const output: Position[] = [];
    for (let i = 0; i < this.length; i++) {
      if (keep[i]) output.push(this.point(i));
      if (i % 4096 === 0) await job.yield();
    }
    return output;
  }
}
