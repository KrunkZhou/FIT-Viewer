import type JSZip from "jszip";
import type { Job } from "../model";

export async function zipChunks(
  stream: JSZip.JSZipStreamHelper<Uint8Array>,
  job: Job,
  phase: string,
  limit = Infinity,
): Promise<Uint8Array[]> {
  const parts: Uint8Array[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      stream.pause();
      job.signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => finish(new DOMException("Cancelled", "AbortError"));
    job.signal.addEventListener("abort", abort, { once: true });
    stream
      .on("data", (data: Uint8Array, metadata: { percent: number }) => {
        if (settled) return;
        size += data.length;
        if (size > limit) {
          finish(
            new Error(
              "Expanded FIT data exceeds the archive extraction limit.",
            ),
          );
          return;
        }
        parts.push(data);
        job.progress(metadata.percent, 100, phase);
        stream.pause();
        job.yield().then(() => {
          if (!settled) stream.resume();
        }, finish);
      })
      .on("error", finish)
      .on("end", () => finish());
    if (job.signal.aborted) abort();
    else stream.resume();
  });
  return parts;
}
