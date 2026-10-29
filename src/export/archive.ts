import { Zip, ZipPassThrough } from "fflate";
import type { ExportResult, Job } from "../model";
import { FitDocument } from "../document/document";
import { addSummaryDiagnostics, repair } from "../repair/repair";
import { EXPORT_CHUNK_BYTES, ExportOutput } from "./output";
import { exportBase } from "./filename";

export async function repairArchive(
  document: FitDocument,
  job: Job,
  output = new ExportOutput(),
): Promise<ExportResult> {
  const zip = new Zip((error, chunk) => {
    if (error) throw error;
    output.push(chunk as Uint8Array<ArrayBuffer>);
  });
  const writeEntry = async (name: string, bytes: Uint8Array) => {
    job.signal.throwIfAborted();
    const entry = new ZipPassThrough(name);
    entry.mtime = new Date(1980, 0, 1);
    zip.add(entry);
    // Finish each entry before starting the next; ZIP retains only directory metadata.
    for (
      let offset = 0;
      offset < bytes.length || offset === 0;
      offset += EXPORT_CHUNK_BYTES
    ) {
      job.signal.throwIfAborted();
      const end = Math.min(offset + EXPORT_CHUNK_BYTES, bytes.length);
      entry.push(bytes.subarray(offset, end), end === bytes.length);
      job.progress(end, bytes.length, "Packaging repaired ZIP");
      await output.flush();
      await job.yield();
    }
  };
  const report: {
    source: string;
    output: string;
    status: string;
    generated: string[];
    unresolved: string[];
  }[] = [];
  let partial = false;
  const generated: string[] = [];
  const unresolved: string[] = [];
  try {
    for (const source of document.sources) {
      await job.yield();
      const bytes = document.index.bytes.subarray(source.start, source.end);
      const basename = source.filename.split(/[\\/]/).at(-1) || "source.fit";
      let entryName = `${String(source.id + 1).padStart(3, "0")}-${basename}`;
      let status = "unchanged";
      let additions: string[] = [];
      let omissions: string[] = [];
      let repaired: Uint8Array = bytes;
      if (source.error) {
        entryName = `unrecovered/${entryName}`;
        status = "unrecovered";
        omissions = [source.error];
        partial = true;
      } else {
        const entry = await FitDocument.open(bytes, source.filename, job);
        await addSummaryDiagnostics(entry, job);
        if (entry.summary().repairable) {
          const result = await repair(entry, job);
          repaired = result.bytes;
          additions = result.generated;
          omissions = result.unresolved;
          partial ||= result.partial;
          entryName = entryName.replace(/\.fit$/i, "-fixed.fit");
          status = result.partial ? "partial" : "repaired";
        } else
          omissions = entry.index.diagnostics.map((issue) => issue.message);
      }
      await writeEntry(entryName, repaired);
      report.push({
        source: source.filename,
        output: entryName,
        status,
        generated: additions,
        unresolved: omissions,
      });
      generated.push(...additions.map((text) => `${source.filename}: ${text}`));
      unresolved.push(
        ...omissions.map((text) => `${source.filename}: ${text}`),
      );
      job.progress(
        source.id + 1,
        document.sources.length,
        "Repairing ZIP entries",
      );
    }
    await writeEntry(
      "repair-report.json",
      new TextEncoder().encode(JSON.stringify(report, null, 2)),
    );
    job.signal.throwIfAborted();
    zip.end();
    return {
      blob: await output.finish("application/zip"),
      filename: `${exportBase(document.filename)}-fixed.zip`,
      partial,
      generated,
      unresolved,
    };
  } finally {
    zip.terminate();
  }
}
