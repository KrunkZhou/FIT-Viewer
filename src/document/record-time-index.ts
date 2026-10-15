import type { Job, TimeRange } from "../model";
import type { FitDocument } from "./document";
import { hasTimeRange } from "./time-range";

interface Block {
  start: number;
  end: number;
  min: number;
  max: number;
}
const indexes = new WeakMap<FitDocument, Map<number[], Block[]>>();

/** Block bounds also work for duplicate, missing and out-of-order timestamps. */
export async function recordTimeSpans(
  document: FitDocument,
  ids: number[],
  range: TimeRange | undefined,
  job: Job,
): Promise<[number, number][]> {
  await job.yield();
  if (!hasTimeRange(range)) return [[0, ids.length]];
  let cached = indexes.get(document);
  if (!cached) indexes.set(document, (cached = new Map()));
  let blocks = cached.get(ids);
  if (!blocks) {
    blocks = [];
    for (let start = 0; start < ids.length; start += 1024) {
      const end = Math.min(start + 1024, ids.length);
      let min = Infinity;
      let max = -Infinity;
      for (let i = start; i < end; i++) {
        const time = document.index.records[ids[i]].timestamp;
        if (time !== undefined) {
          min = Math.min(min, time);
          max = Math.max(max, time);
        }
      }
      blocks.push({ start, end, min, max });
      await job.yield();
    }
    cached.set(ids, blocks);
  }
  const spans: [number, number][] = [];
  for (const block of blocks) {
    const min = Math.max(block.min, range?.start ?? -Infinity);
    const max = Math.min(block.max, range?.end ?? Infinity);
    if (
      min > max ||
      (range?.intervals !== undefined &&
        !range.intervals.some(
          (interval) => interval.start <= max && interval.end >= min,
        ))
    )
      continue;
    const last = spans.at(-1);
    if (last?.[1] === block.start) last[1] = block.end;
    else spans.push([block.start, block.end]);
  }
  return spans;
}
