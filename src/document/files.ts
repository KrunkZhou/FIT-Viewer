import JSZip from "jszip";
import type { Job } from "../model";

export async function loadFile(
  file: File,
  entry: string | undefined,
  limit: number,
  job: Job,
): Promise<{ bytes: Uint8Array; filename: string } | { entries: string[] }> {
  if (file.size > limit)
    throw new Error(
      `The selected file exceeds the ${Math.round(limit / 1048576)} MiB limit.`,
    );
  const bytes = new Uint8Array(await file.arrayBuffer());
  await job.yield();
  if (!/\.zip$/i.test(file.name) && !(bytes[0] === 80 && bytes[1] === 75))
    return { bytes, filename: file.name };
  const zip = await JSZip.loadAsync(bytes);
  const entries = Object.values(zip.files)
    .filter(
      (f) =>
        !f.dir &&
        /\.fit$/i.test(f.name) &&
        !f.name.split("/").includes("__MACOSX"),
    )
    .map((f) => f.name);
  if (!entries.length)
    throw new Error("The ZIP archive contains no FIT files.");
  if (!entry && entries.length > 1) return { entries };
  const selected = entry ?? entries[0];
  if (!entries.includes(selected))
    throw new Error("The selected FIT entry is no longer available.");
  const source = zip.file(selected)!;
  const parts: Uint8Array[] = [];
  let size = 0;
  const stream = (
    source as JSZip.JSZipObject & {
      internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
    }
  ).internalStream("uint8array");
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      stream.pause();
      reject(new DOMException("Cancelled", "AbortError"));
    };
    job.signal.addEventListener("abort", abort, { once: true });
    stream
      .on("data", (data: Uint8Array, metadata: { percent: number }) => {
        size += data.length;
        if (size > limit || job.signal.aborted) {
          stream.pause();
          job.signal.removeEventListener("abort", abort);
          reject(
            new Error(
              `Extracted FIT file exceeds the ${Math.round(limit / 1048576)} MiB limit or was cancelled.`,
            ),
          );
          return;
        }
        parts.push(data);
        job.progress(metadata.percent, 100, "Extracting ZIP");
      })
      .on("error", (error: Error) => {
        job.signal.removeEventListener("abort", abort);
        reject(error);
      })
      .on("end", () => {
        job.signal.removeEventListener("abort", abort);
        resolve();
      });
    if (job.signal.aborted) abort();
    else stream.resume();
  });
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
    if (offset % 1048576 < part.length) await job.yield();
  }
  return { bytes: result, filename: selected.split("/").at(-1)! };
}
