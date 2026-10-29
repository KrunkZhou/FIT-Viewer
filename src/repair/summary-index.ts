import type { FitDocument } from "../document/document";
import type { Job } from "../model";

interface SummaryEvidence {
  recordCount: number;
  messages: Map<number, number[]>;
  count: number;
  start?: number;
  end?: number;
  last: number;
  ordered: boolean;
}

const indexes = new WeakMap<FitDocument, SummaryEvidence[]>();

/** Documents are immutable; keep only small per-subfile evidence, not record copies. */
export async function summaryIndex(document: FitDocument, job: Job) {
  job.signal.throwIfAborted();
  const cached = indexes.get(document);
  if (cached) return cached;
  const files: SummaryEvidence[] = document.index.subfiles.map(() => ({
    recordCount: 0,
    messages: new Map(),
    count: 0,
    last: -1,
    ordered: true,
  }));
  for (const message of [12, 18, 19, 34]) {
    const ids = document.index.messages.get(message) ?? [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const file = files[document.index.records[id].subfile];
      const group = file.messages.get(message) ?? [];
      group.push(id);
      file.messages.set(message, group);
      if (i % 4096 === 0) await job.yield();
    }
  }
  const needed = files.map(
    (file, i) =>
      document.index.subfiles[i].type === 4 &&
      (!file.messages.has(18) || !file.messages.has(34)),
  );
  for (let id = 0; id < document.index.records.length; id++) {
    const record = document.index.records[id];
    const file = files[record.subfile];
    file.recordCount++;
    if (needed[record.subfile] && record.definition.message === 20) {
      if (
        record.timestamp === undefined ||
        (file.end !== undefined && record.timestamp < file.end)
      )
        file.ordered = false;
      file.start ??= record.timestamp;
      file.end = record.timestamp;
      file.last = id;
      file.count++;
    }
    if (id % 4096 === 0) await job.yield();
  }
  job.signal.throwIfAborted();
  indexes.set(document, files);
  return files;
}
