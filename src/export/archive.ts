import JSZip from "jszip";
import type { ExportResult, Job } from "../model";
import { FitDocument } from "../document/document";
import { zipChunks } from "../document/zip-stream";
import { addSummaryDiagnostics, repair } from "../repair/repair";

export async function repairArchive(
  document: FitDocument,
  job: Job,
): Promise<ExportResult> {
  const zip = new JSZip();
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
  for (const source of document.sources) {
    await job.yield();
    const bytes = document.index.bytes.subarray(source.start, source.end);
    const basename = source.filename.split(/[\\/]/).at(-1) || "source.fit";
    let output = `${String(source.id + 1).padStart(3, "0")}-${basename}`;
    let status = "unchanged";
    let additions: string[] = [];
    let omissions: string[] = [];
    let repaired: Uint8Array = bytes;
    if (source.error) {
      output = `unrecovered/${output}`;
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
        output = output.replace(/\.fit$/i, "-fixed.fit");
        status = result.partial ? "partial" : "repaired";
      } else omissions = entry.index.diagnostics.map((issue) => issue.message);
    }
    zip.file(output, repaired);
    report.push({
      source: source.filename,
      output,
      status,
      generated: additions,
      unresolved: omissions,
    });
    generated.push(...additions.map((text) => `${source.filename}: ${text}`));
    unresolved.push(...omissions.map((text) => `${source.filename}: ${text}`));
    job.progress(
      source.id + 1,
      document.sources.length,
      "Repairing ZIP entries",
    );
  }
  zip.file("repair-report.json", JSON.stringify(report, null, 2));
  const chunks = await zipChunks(
    zip.generateInternalStream({
      type: "uint8array",
      compression: "STORE",
      streamFiles: true,
    }),
    job,
    "Packaging repaired ZIP",
  );
  return {
    blob: new Blob(chunks as Uint8Array<ArrayBuffer>[], {
      type: "application/zip",
    }),
    filename: `${document.filename.replace(/\.[^.]+$/, "")}-fixed.zip`,
    partial,
    generated,
    unresolved,
  };
}
