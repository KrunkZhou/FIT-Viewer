import { open, rename, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/** A download is committed only after the worker reports successful completion. */
export class DownloadFile {
  private closed = false;
  private pending?: Promise<void>;
  private constructor(
    private target: string,
    private temporary: string,
    private file: FileHandle,
  ) {}
  static async open(target: string): Promise<DownloadFile> {
    const temporary = join(dirname(target), `.fit-viewer-${randomUUID()}.part`);
    return new DownloadFile(
      target,
      temporary,
      await open(temporary, "wx", 0o600),
    );
  }
  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed || this.pending)
      throw new Error("Download is not writable.");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > 256 * 1024)
      throw new Error("Invalid download chunk.");
    this.pending = (async () => {
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await this.file.write(
          bytes,
          offset,
          bytes.length - offset,
        );
        if (!bytesWritten) throw new Error("Unable to write download.");
        offset += bytesWritten;
      }
    })();
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }
  async finish(): Promise<void> {
    if (this.closed || this.pending) throw new Error("Download is not ready.");
    this.closed = true;
    try {
      await this.file.sync();
      await this.file.close();
      await rename(this.temporary, this.target);
    } catch (error) {
      await this.cleanup();
      throw error;
    }
  }
  async abort(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pending?.catch(() => {});
    await this.cleanup();
  }
  private async cleanup(): Promise<void> {
    await this.file.close().catch(() => {});
    await unlink(this.temporary).catch(() => {});
  }
}
