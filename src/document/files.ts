import JSZip from "jszip";
import type { Job } from "../model";
import { zipChunks } from "./zip-stream";
import {
  isDesktopFileUrl,
  isFitPath,
  MAX_INPUT_FILES,
  type DesktopFile,
  type DocumentInput,
} from "./input";

export interface SourceInput {
  filename: string;
  bytes: Uint8Array;
}
export interface LoadedFile {
  filename: string;
  sources: SourceInput[];
}

export async function loadFile(
  input: DocumentInput,
  limit: number,
  job: Job,
): Promise<LoadedFile> {
  if (!(limit > 0) || !Number.isFinite(limit))
    throw new Error("Invalid file size limit.");
  const files = "files" in input ? input.files : [input];
  if (!files.length || files.length > MAX_INPUT_FILES)
    throw new Error("Invalid number of selected files.");
  if (files.reduce((size, file) => size + file.size, 0) > limit)
    throw new Error(
      `The selected files exceed the ${Math.round(limit / 1048576)} MiB limit.`,
    );
  const sources: SourceInput[] = [];
  let total = 0;
  for (const [index, file] of files.entries()) {
    await job.yield();
    job.progress(index, files.length, `Reading ${file.name}`);
    const loaded = await loadSingleFile(file, limit - total, job);
    for (const source of loaded.sources) {
      if (sources.length >= MAX_INPUT_FILES)
        throw new Error(`Select no more than ${MAX_INPUT_FILES} FIT files.`);
      total += source.bytes.length;
      sources.push({
        ...source,
        filename:
          files.length > 1 && /\.zip$/i.test(file.name)
            ? `${file.name}/${source.filename}`
            : source.filename,
      });
    }
  }
  return {
    filename: sources.length === 1 ? sources[0].filename : input.name,
    sources,
  };
}

async function loadSingleFile(
  file: File | DesktopFile,
  limit: number,
  job: Job,
): Promise<LoadedFile> {
  if (file.size > limit)
    throw new Error(
      `The selected file exceeds the ${Math.round(limit / 1048576)} MiB limit.`,
    );
  let buffer: ArrayBuffer;
  if ("url" in file) {
    if (!isDesktopFileUrl(file.url))
      throw new Error("Invalid desktop file URL.");
    const response = await fetch(file.url);
    if (!response.ok)
      throw new Error(
        "The selected desktop file is no longer available. Open it again.",
      );
    buffer = await response.arrayBuffer();
    if (buffer.byteLength !== file.size || buffer.byteLength > limit)
      throw new Error("The file changed while opening it.");
  } else buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  await job.yield();
  if (!/\.zip$/i.test(file.name) && !(bytes[0] === 80 && bytes[1] === 75))
    return { filename: file.name, sources: [{ filename: file.name, bytes }] };
  const zip = await JSZip.loadAsync(bytes);
  await job.yield();
  const entries = Object.values(zip.files).filter(
    (f) => !f.dir && isFitPath(f.name),
  );
  if (!entries.length)
    throw new Error("The ZIP archive contains no FIT files.");
  if (entries.length > MAX_INPUT_FILES)
    throw new Error(`Select no more than ${MAX_INPUT_FILES} FIT files.`);
  const sources: SourceInput[] = [];
  let total = 0;
  for (const [index, entry] of entries.entries()) {
    const source = entry as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    };
    const parts = await zipChunks(
      source.internalStream("uint8array"),
      {
        ...job,
        progress: (completed, maximum) =>
          job.progress(
            index + completed / maximum,
            entries.length,
            `Extracting ${entry.name}`,
          ),
      },
      "Extracting ZIP",
      limit - total,
    );
    const size = parts.reduce((sum, part) => sum + part.length, 0);
    const extracted = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      extracted.set(part, offset);
      offset += part.length;
      await job.yield();
    }
    total += size;
    sources.push({ filename: entry.name, bytes: extracted });
    await job.yield();
  }
  return {
    filename: sources.length === 1 ? sources[0].filename : file.name,
    sources,
  };
}
