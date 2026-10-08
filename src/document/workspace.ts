import type { Definition, Job, SourceInfo } from "../model";
import { type FitIndex, rawRecord, readFit } from "../protocol/reader";
import type { SourceInput } from "./files";

export async function readWorkspace(
  sources: SourceInput[],
  job: Job,
): Promise<{ index: FitIndex; sources: SourceInfo[] }> {
  const bytes = new Uint8Array(
    sources.reduce((size, source) => size + source.bytes.length, 0),
  );
  let offset = 0;
  for (const source of sources) {
    for (let start = 0; start < source.bytes.length; start += 65536) {
      bytes.set(source.bytes.subarray(start, start + 65536), offset + start);
      await job.yield();
    }
    offset += source.bytes.length;
  }
  const index: FitIndex = {
    bytes,
    view: new DataView(bytes.buffer),
    records: [],
    definitions: [],
    messages: new Map(),
    subfiles: [],
    diagnostics: [],
    raw: (record) => rawRecord(index, record),
  };
  const info: SourceInfo[] = [];
  offset = 0;
  for (const [id, source] of sources.entries()) {
    const entry: SourceInfo = {
      id,
      filename: source.filename,
      bytes: source.bytes.length,
      start: offset,
      end: offset + source.bytes.length,
      records: 0,
    };
    info.push(entry);
    try {
      const parsed = await readFit(bytes.subarray(entry.start, entry.end), {
        ...job,
        progress: (completed, total) =>
          job.progress(
            id + (total ? completed / total : 0),
            sources.length,
            `Reading ${source.filename}`,
          ),
      });
      const fileBase = index.subfiles.length;
      const recordBase = index.records.length;
      entry.records = parsed.records.length;
      for (const file of parsed.subfiles)
        index.subfiles.push({
          ...file,
          index: file.index + fileBase,
          source: id,
          start: file.start + offset,
          bodyStart: file.bodyStart + offset,
          declaredEnd: file.declaredEnd + offset,
          bodyEnd: file.bodyEnd + offset,
          end: file.end + offset,
        });
      const definitions = new Map<Definition, Definition>();
      for (const [i, definition] of parsed.definitions.entries()) {
        const mapped = {
          ...definition,
          offset: definition.offset + offset,
          end: definition.end + offset,
          subfile: definition.subfile + fileBase,
        };
        definitions.set(definition, mapped);
        index.definitions.push(mapped);
        if (i % 1024 === 0) await job.yield();
      }
      for (const [i, record] of parsed.records.entries()) {
        const mapped = {
          ...record,
          definition: definitions.get(record.definition)!,
          offset: record.offset + offset,
          end: record.end + offset,
          subfile: record.subfile + fileBase,
        };
        const ids = index.messages.get(mapped.definition.message) ?? [];
        ids.push(index.records.length);
        index.messages.set(mapped.definition.message, ids);
        index.records.push(mapped);
        if (i % 1024 === 0) await job.yield();
      }
      for (const diagnostic of parsed.diagnostics)
        index.diagnostics.push({
          ...diagnostic,
          id: `source:${id}:${diagnostic.id}`,
          source: id,
          offset: diagnostic.offset + offset,
          end: diagnostic.end + offset,
          subfile: diagnostic.subfile + fileBase,
          record:
            diagnostic.record === undefined
              ? undefined
              : diagnostic.record + recordBase,
        });
    } catch (error) {
      if (job.signal.aborted || (error as Error).name === "AbortError")
        throw error;
      entry.error = (error as Error).message;
      index.diagnostics.push({
        id: `source:${id}:unreadable`,
        source: id,
        subfile: -1,
        offset: entry.start,
        end: entry.end,
        severity: "error",
        code: "unreadable-file",
        message: `${entry.filename}: ${entry.error}`,
        repair: "none",
      });
    }
    offset = entry.end;
    job.progress(id + 1, sources.length, "Reading ZIP entries");
    await job.yield();
  }
  return { index, sources: info };
}
