import type { ChartPoint } from "../model";

interface Located {
  point: ChartPoint;
  index: number;
}
interface Sample extends Located {
  gap?: Located;
}
interface Bucket {
  first: Sample;
  last: Sample;
  min?: Sample;
  max?: Sample;
}

/** Bounded, streaming extrema buckets. Gap markers survive bucket merges. */
export class PointSampler {
  private exact: ChartPoint[] | undefined = [];
  private buckets: Bucket[] = [];
  private current?: Bucket;
  private gap?: Located;
  private index = 0;
  private size = 1;
  private inBucket = 0;
  private readonly limit: number;
  constructor(private readonly capacity: number) {
    this.limit = Math.max(1, Math.floor(capacity / 8));
  }
  add(point: ChartPoint): void {
    if (this.exact) {
      this.exact.push(point);
      if (this.exact.length <= this.capacity) return;
      const pending = this.exact;
      this.exact = undefined;
      for (const sample of pending) this.append(sample);
    } else this.append(point);
  }
  private append(point: ChartPoint): void {
    const sample: Sample = { point, index: this.index++, gap: this.gap };
    if (point.value === null) this.gap = { point, index: sample.index };
    if (!this.current) this.current = { first: sample, last: sample };
    const bucket = this.current;
    bucket.last = sample;
    if (point.value !== null) {
      if (!bucket.min || point.value < bucket.min.point.value!)
        bucket.min = sample;
      if (!bucket.max || point.value > bucket.max.point.value!)
        bucket.max = sample;
    }
    if (++this.inBucket >= this.size) this.flush();
  }
  private flush(): void {
    if (!this.current) return;
    this.buckets.push(this.current);
    this.current = undefined;
    this.inBucket = 0;
    if (this.buckets.length <= this.limit) return;
    const merged: Bucket[] = [];
    for (let i = 0; i < this.buckets.length; i += 2) {
      const a = this.buckets[i];
      const b = this.buckets[i + 1];
      if (!b) {
        this.current = a;
        this.inBucket = this.size;
        break;
      }
      merged.push({
        first: a.first,
        last: b.last,
        min: !a.min
          ? b.min
          : !b.min || a.min.point.value! <= b.min.point.value!
            ? a.min
            : b.min,
        max: !a.max
          ? b.max
          : !b.max || a.max.point.value! >= b.max.point.value!
            ? a.max
            : b.max,
      });
    }
    this.buckets = merged;
    this.size *= 2;
  }
  finish(): ChartPoint[] {
    if (this.exact) return this.exact;
    this.flush();
    const output = new Map<number, ChartPoint>();
    for (const bucket of [
      ...this.buckets,
      ...(this.current ? [this.current] : []),
    ]) {
      for (const sample of [
        bucket.first,
        bucket.min,
        bucket.max,
        bucket.last,
      ]) {
        if (!sample) continue;
        output.set(sample.index, sample.point);
        if (sample.gap) output.set(sample.gap.index, sample.gap.point);
      }
    }
    return [...output].sort((a, b) => a[0] - b[0]).map(([, point]) => point);
  }
}
