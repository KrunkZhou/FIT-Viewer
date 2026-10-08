import type { WorkerRequest, WorkerResponsePayload } from "../model";
import { FitDocument } from "./document";
import { createJob } from "./jobs";
import { loadFile } from "./files";
import { chart, mapData } from "./series";
import { exportDocument } from "../export/export";
import { addSummaryDiagnostics } from "../repair/repair";

const scope = self as unknown as DedicatedWorkerGlobalScope;
let document: FitDocument | undefined;
let sourceView: { source: number; document: FitDocument } | undefined;
let activeDocument = 0;
const jobs = new Map<number, AbortController>();
scope.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  const send = (payload: WorkerResponsePayload) =>
    scope.postMessage({
      ...payload,
      requestId: request.requestId,
      documentId: request.documentId,
    });
  if (request.kind === "cancel") {
    jobs.get(request.target)?.abort();
    send({ kind: "result", result: null });
    return;
  }
  if (request.kind === "dispose") {
    for (const job of jobs.values()) job.abort();
    document = undefined;
    sourceView = undefined;
    jobs.clear();
    scope.close();
    return;
  }
  if (request.kind === "open") {
    for (const job of jobs.values()) job.abort();
    document = undefined;
    sourceView = undefined;
    activeDocument = request.documentId;
  } else if (request.documentId !== activeDocument || !document) {
    send({ kind: "error", message: "This document is no longer active." });
    return;
  }
  const controller = new AbortController();
  jobs.set(request.requestId, controller);
  const job = createJob(controller.signal, (completed, total, phase) =>
    send({ kind: "progress", completed, total, phase }),
  );
  try {
    let current = document;
    if (request.kind !== "open" && request.source !== undefined) {
      const source = document!.sources[request.source];
      if (!Number.isInteger(request.source) || !source || source.error)
        throw new Error(source?.error ?? "The source file is unavailable.");
      if (sourceView?.source === request.source) current = sourceView.document;
      else {
        current = await FitDocument.open(
          document!.index.bytes.subarray(source.start, source.end),
          source.filename,
          job,
        );
        await addSummaryDiagnostics(current, job);
        await job.yield();
        if (request.documentId !== activeDocument)
          throw new DOMException("Cancelled", "AbortError");
        sourceView = { source: request.source, document: current };
      }
    }
    let result: Extract<WorkerResponsePayload, { kind: "result" }>["result"];
    switch (request.kind) {
      case "open": {
        const source = await loadFile(request.file, request.limit, job);
        const next = await FitDocument.openSources(
          source.sources,
          request.filename ?? source.filename,
          job,
        );
        await addSummaryDiagnostics(next, job);
        if (controller.signal.aborted || request.documentId !== activeDocument)
          throw new DOMException("Cancelled", "AbortError");
        document = next;
        result = next.summary();
        break;
      }
      case "summary":
        result = current!.summary();
        break;
      case "table":
        result = await current!.table(request.query, job);
        break;
      case "singletons":
        result = await current!.singletons(request.developer, job);
        break;
      case "chart":
        result = await chart(current!, request.query, job);
        break;
      case "map":
        result = await mapData(current!, job);
        break;
      case "diagnostics": {
        const size = Math.min(100, Math.max(1, Math.trunc(request.size) || 50));
        const issues = current!.index.diagnostics;
        const page = Math.max(
          0,
          Math.min(
            Math.ceil(issues.length / size) - 1,
            Math.trunc(request.page) || 0,
          ),
        );
        result = {
          issues: issues.slice(page * size, (page + 1) * size).map((issue) => ({
            ...issue,
            messageId:
              issue.record === undefined
                ? undefined
                : current!.index.records[issue.record]?.definition.message,
          })),
          total: issues.length,
          page,
          size,
        };
        break;
      }
      case "export":
        result = await exportDocument(current!, request.query, job);
        break;
    }
    if (controller.signal.aborted)
      throw new DOMException("Cancelled", "AbortError");
    send({ kind: "result", result });
  } catch (error) {
    send({
      kind: "error",
      message: (error as Error).message,
      aborted:
        controller.signal.aborted || (error as Error).name === "AbortError",
    });
  } finally {
    jobs.delete(request.requestId);
  }
};
