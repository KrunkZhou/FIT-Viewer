import JSZip from "jszip";
import type { Job } from "../model";
import { zipChunks } from "./zip-stream";

export interface SourceInput {
  filename: string;
  bytes: Uint8Array;
}
export interface LoadedFile {
  filename: string;
  sources: SourceInput[];
}

export async function loadFile(
  file: File,
  limit: number,
  job: Job,
): Promise<LoadedFile> {
  if (file.size > limit)
    throw new Error(
      `The selected file exceeds the ${Math.round(limit / 1048576)} MiB limit.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  await job.yield();
  if (!/\.zip$/i.test(file.name) && !(bytes[0] === 80 && bytes[1] === 75))
    return { filename: file.name, sources: [{ filename: file.name, bytes }] };
  const zip = await JSZip.loadAsync(bytes);
  await job.yield();
  const entries = Object.values(zip.files).filter(
    (f) =>
      !f.dir &&
      /\.fit$/i.test(f.name) &&
      !f.name.split("/").includes("__MACOSX") &&
      !f.name.split("/").at(-1)!.startsWith("._"),
  );
  if (!entries.length)
    throw new Error("The ZIP archive contains no FIT files.");
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
