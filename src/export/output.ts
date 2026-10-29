import type { Job } from "../model";

export const EXPORT_CHUNK_BYTES = 256 * 1024;

/** Batches formatting output with backpressure; Blob fallback for older browsers. */
export class ExportOutput {
  private parts: BlobPart[] = [];
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private pendingBytes = 0;
  private signal?: AbortSignal;
  constructor(stream?: WritableStream<Uint8Array>) {
    this.writer = stream?.getWriter();
  }
  push(...parts: BlobPart[]): void {
    this.parts.push(...parts);
    for (const part of parts)
      this.pendingBytes +=
        typeof part === "string"
          ? part.length * 3
          : part instanceof Blob
            ? part.size
            : part.byteLength;
  }
  async flush(): Promise<void> {
    if (!this.writer || !this.parts.length) return;
    const blob = new Blob(this.parts);
    this.parts = [];
    this.pendingBytes = 0;
    for (let start = 0; start < blob.size; start += EXPORT_CHUNK_BYTES) {
      this.signal?.throwIfAborted();
      await this.writer.write(
        new Uint8Array(
          await blob.slice(start, start + EXPORT_CHUNK_BYTES).arrayBuffer(),
        ),
      );
      this.signal?.throwIfAborted();
    }
  }
  job(job: Job): Job {
    this.signal = job.signal;
    return {
      ...job,
      yield: async () => {
        job.signal.throwIfAborted();
        if (this.pendingBytes >= EXPORT_CHUNK_BYTES) await this.flush();
        await job.yield();
      },
    };
  }
  async finish(type: string): Promise<Blob> {
    this.signal?.throwIfAborted();
    await this.flush();
    if (this.writer) {
      await this.writer.close();
      this.writer.releaseLock();
      this.writer = undefined;
    }
    const blob = new Blob(this.parts, { type });
    this.parts = [];
    this.pendingBytes = 0;
    return blob;
  }
  async abort(error: unknown): Promise<void> {
    this.parts = [];
    this.pendingBytes = 0;
    if (this.writer) {
      try {
        await this.writer.abort(error);
      } catch {
        /* Destination may already be closed. */
      }
      this.writer.releaseLock();
      this.writer = undefined;
    }
  }
}
