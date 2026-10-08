export class SampleStatistics {
  count = 0;
  minimum = Infinity;
  maximum = -Infinity;

  add(value: unknown): void {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    this.count++;
    this.minimum = Math.min(this.minimum, value);
    this.maximum = Math.max(this.maximum, value);
  }
}
