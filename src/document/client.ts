import type {
  DocumentSummary,
  ExportQuery,
  ExportResult,
  RequestPayload,
  WorkerRequest,
  WorkerResponse,
} from "../model";
import {
  validationStartDocument,
  validationValue,
  validationWorker,
} from "./validation";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  progress?: (completed: number, total: number, phase: string) => void;
  cleanup: () => void;
}
export class DocumentClient {
  private worker?: Worker;
  private nextRequest = 1;
  private documentId = 0;
  private source?: number;
  private pending = new Map<number, Pending>();
  private cancellations = new Map<number, number>();
  private newWorker(): void {
    const worker = new Worker(
      new URL("./document.worker.ts", import.meta.url),
      {
        type: "module",
      },
    );
    this.worker = worker;
    validationWorker(1);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const message = event.data;
      if (worker !== this.worker || message.documentId !== this.documentId)
        return;
      const cancellation = this.cancellations.get(message.requestId);
      if (cancellation !== undefined) {
        validationValue("cancel-ack-ms", performance.now() - cancellation);
        this.cancellations.delete(message.requestId);
      }
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      if (message.kind === "progress") {
        pending.progress?.(message.completed, message.total, message.phase);
        return;
      }
      this.pending.delete(message.requestId);
      pending.cleanup();
      if (message.kind === "error")
        pending.reject(
          message.aborted
            ? new DOMException(message.message, "AbortError")
            : new Error(message.message),
        );
      else pending.resolve(message.result);
    };
    const fail = () => {
      if (worker !== this.worker) return;
      this.destroy(
        new Error(
          "The document worker stopped unexpectedly. Open the file again to recover.",
        ),
      );
    };
    worker.onerror = fail;
    worker.onmessageerror = fail;
  }
  destroy(reason: Error = new DOMException("Cancelled", "AbortError")): void {
    if (this.worker) {
      this.worker.terminate();
      validationWorker(-1);
    }
    this.worker = undefined;
    this.cancellations.clear();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.reject(reason);
    }
    this.pending.clear();
  }
  open(
    file: File,
    options: {
      limit?: number;
      signal?: AbortSignal;
      progress?: Pending["progress"];
    } = {},
  ): Promise<DocumentSummary> {
    if (options.signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    this.destroy();
    validationStartDocument();
    this.documentId++;
    this.source = undefined;
    try {
      this.newWorker();
    } catch (error) {
      return Promise.reject(error);
    }
    return this.request(
      {
        kind: "open",
        file,
        limit: options.limit ?? 512 * 1048576,
      },
      options.signal,
      options.progress,
    );
  }
  selectSource(
    source: number | undefined,
    signal?: AbortSignal,
    progress?: Pending["progress"],
  ): Promise<DocumentSummary> {
    for (const [requestId, pending] of this.pending) {
      this.worker?.postMessage({
        kind: "cancel",
        target: requestId,
        requestId: this.nextRequest++,
        documentId: this.documentId,
      } satisfies WorkerRequest);
      pending.cleanup();
      pending.reject(new DOMException("Cancelled", "AbortError"));
    }
    this.pending.clear();
    this.source = source;
    return this.request({ kind: "summary" }, signal, progress);
  }
  request<T>(
    payload: RequestPayload,
    signal?: AbortSignal,
    progress?: Pending["progress"],
  ): Promise<T> {
    if (!this.worker || signal?.aborted)
      return Promise.reject(new DOMException("Cancelled", "AbortError"));
    const requestId = this.nextRequest++;
    const started = performance.now();
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", abort);
        if (payload.kind === "open") {
          this.destroy();
          validationValue("cancel-ack-ms", 0);
        } else {
          const cancelId = this.nextRequest++;
          this.cancellations.set(cancelId, performance.now());
          this.worker?.postMessage({
            kind: "cancel",
            target: requestId,
            requestId: cancelId,
            documentId: this.documentId,
          } satisfies WorkerRequest);
        }
        reject(new DOMException("Cancelled", "AbortError"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.set(requestId, {
        resolve: (value) => {
          validationValue(`${payload.kind}-ms`, performance.now() - started);
          resolve(value as T);
        },
        reject,
        progress,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      try {
        this.worker!.postMessage({
          source: this.source,
          ...payload,
          requestId,
          documentId: this.documentId,
        });
      } catch (error) {
        this.pending.delete(requestId);
        signal?.removeEventListener("abort", abort);
        reject(error);
      }
    });
  }
  export(
    query: ExportQuery,
    signal?: AbortSignal,
    progress?: Pending["progress"],
  ): Promise<ExportResult> {
    return this.request({ kind: "export", query }, signal, progress);
  }
}
