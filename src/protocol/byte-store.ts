interface Segment {
  start: number;
  end: number;
  bytes: Uint8Array;
  view: DataView;
}

/** Logical workspace offsets backed by the original, separate source buffers. */
export class ByteStore {
  readonly length: number;
  private readonly segments: Segment[] = [];
  private last?: Segment;

  constructor(sources: readonly Uint8Array[]) {
    let start = 0;
    for (const bytes of sources) {
      if (!bytes.length) continue;
      const end = start + bytes.length;
      this.segments.push({
        start,
        end,
        bytes,
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      });
      start = end;
    }
    this.length = start;
  }

  segment(offset: number): Segment {
    if (this.last && offset >= this.last.start && offset < this.last.end)
      return this.last;
    let low = 0;
    let high = this.segments.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.segments[mid].end <= offset) low = mid + 1;
      else high = mid;
    }
    const segment = this.segments[low];
    if (!segment || offset < segment.start || !Number.isSafeInteger(offset))
      throw new RangeError("Invalid source byte offset.");
    this.last = segment;
    return segment;
  }

  subarray(start = 0, end = this.length): Uint8Array {
    const bound = (value: number) =>
      Math.min(
        this.length,
        Math.max(
          0,
          value < 0 ? this.length + Math.trunc(value) : Math.trunc(value),
        ),
      );
    start = bound(start);
    end = bound(end);
    if (end <= start) return new Uint8Array();
    const first = this.segment(start);
    if (end <= first.end)
      return first.bytes.subarray(start - first.start, end - first.start);
    // Only explicitly requested cross-source ranges need a contiguous allocation.
    const result = new Uint8Array(end - start);
    for (let cursor = start; cursor < end;) {
      const segment = this.segment(cursor);
      const next = Math.min(end, segment.end);
      result.set(
        segment.bytes.subarray(cursor - segment.start, next - segment.start),
        cursor - start,
      );
      cursor = next;
    }
    return result;
  }
}
