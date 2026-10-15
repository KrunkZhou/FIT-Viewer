import type { CiqSettingsFile, Job, SourceInfo } from "../model";
import { type FitIndex, rawRecord, readFit } from "../protocol/reader";
import { readCiqSettings } from "../protocol/ciq-settings";
import type { SourceInput } from "./files";
import { isSetPath } from "./input";
import { ByteStore } from "../protocol/byte-store";

export async function readWorkspace(
  sources: SourceInput[],
  job: Job,
): Promise<{
  index: FitIndex;
  sources: SourceInfo[];
  ciqSettings: CiqSettingsFile[];
}> {
  const bytes = new ByteStore(sources.map((source) => source.bytes));
  let offset = 0;
  const index: FitIndex = {
    bytes,
    records: [],
    definitions: [],
    messages: new Map(),
    subfiles: [],
    diagnostics: [],
    raw: (record) => rawRecord(index, record),
  };
  const info: SourceInfo[] = [];
  const ciqSettings: CiqSettingsFile[] = [];
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
      if (isSetPath(source.filename)) {
        const settings = await readCiqSettings(
          bytes.subarray(entry.start, entry.end),
          job,
        );
        ciqSettings.push({ source: id, filename: source.filename, settings });
        offset = entry.end;
        job.progress(id + 1, sources.length, "Reading CIQ settings");
        await job.yield();
        continue;
      }
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
      for (const [i, definition] of parsed.definitions.entries()) {
        definition.offset += offset;
        definition.end += offset;
        definition.subfile += fileBase;
        index.definitions.push(definition);
        if (i % 1024 === 0) await job.yield();
      }
      for (const [i, record] of parsed.records.entries()) {
        record.offset += offset;
        record.end += offset;
        record.subfile += fileBase;
        const ids = index.messages.get(record.definition.message) ?? [];
        ids.push(index.records.length);
        index.messages.set(record.definition.message, ids);
        index.records.push(record);
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
  return { index, sources: info, ciqSettings };
}
