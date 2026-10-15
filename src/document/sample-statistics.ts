import type { FitDocument } from "./document";

// One small summary per sensor, never expanded sample arrays. Weak document
// ownership releases these with the worker/document on file replacement.
const documents = new WeakMap<
  FitDocument,
  Map<boolean, Map<string, SampleStatistics>>
>();
export function sampleStatistics(document: FitDocument, developer: boolean) {
  let modes = documents.get(document);
  if (!modes) documents.set(document, (modes = new Map()));
  let entries = modes.get(developer);
  if (!entries) modes.set(developer, (entries = new Map()));
  return entries;
}

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
