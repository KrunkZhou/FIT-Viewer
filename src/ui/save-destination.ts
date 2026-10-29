import type { DocumentSummary, ExportQuery } from "../model";
import { exportBase } from "../export/filename";

export interface SaveDestination {
  stream: WritableStream<Uint8Array>;
  commit(): Promise<void>;
  abort(): Promise<void>;
}
interface FilePickerHost {
  fitDesktop?: Window["fitDesktop"];
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{
    createWritable(): Promise<WritableStream<Uint8Array>>;
  }>;
}

export function exportFilename(
  summary: DocumentSummary,
  query: ExportQuery,
): string {
  const base = exportBase(summary.filename);
  if (query.format === "set")
    return (
      summary.ciqSettings
        ?.find((file) => file.source === query.settings?.source)
        ?.filename.split(/[\\/]/)
        .pop() ?? `${base}.SET`
    );
  return (
    base +
    {
      csv: `-${query.message ?? 20}.csv`,
      gpx: ".gpx",
      geojson: "-gps.geojson",
      hrv: "-rr.txt",
      json: "-charts.json",
      fit: summary.sources.length > 1 ? "-fixed.zip" : "-fixed.fit",
    }[query.format]
  );
}

export async function saveDestination(
  name: string,
  signal: AbortSignal,
  host: FilePickerHost = window,
): Promise<SaveDestination | undefined> {
  signal.throwIfAborted();
  let write: (bytes: Uint8Array) => Promise<void>;
  let finish: () => Promise<void>;
  let cancel: () => Promise<void>;
  if (host.fitDesktop?.downloads) {
    const api = host.fitDesktop.downloads;
    const token = await api.open(name);
    if (!token) throw new DOMException("Cancelled", "AbortError");
    write = (bytes) => api.write(token, bytes);
    finish = () => api.finish(token);
    cancel = () => api.abort(token);
  } else if (host.showSaveFilePicker) {
    const handle = await host.showSaveFilePicker({ suggestedName: name });
    const writer = (await handle.createWritable()).getWriter();
    write = (bytes) => writer.write(bytes);
    finish = async () => {
      try {
        await writer.close();
      } finally {
        writer.releaseLock();
      }
    };
    cancel = async () => {
      try {
        await writer.abort();
      } finally {
        writer.releaseLock();
      }
    };
  } else return;
  let state: "open" | "closed" = "open";
  let drained!: () => void;
  let failed!: (error: unknown) => void;
  const completion = new Promise<void>((resolve, reject) => {
    drained = resolve;
    failed = reject;
  });
  void completion.catch(() => {});
  let aborted: Promise<void> | undefined;
  const abort = () => {
    if (state === "closed") return aborted ?? Promise.resolve();
    state = "closed";
    failed(new DOMException("Cancelled", "AbortError"));
    signal.removeEventListener("abort", onAbort);
    aborted = cancel();
    return aborted;
  };
  const onAbort = () => {
    void abort().catch(() => {});
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) {
    await abort();
    signal.throwIfAborted();
  }
  return {
    stream: new WritableStream<Uint8Array>({
      async write(bytes) {
        try {
          signal.throwIfAborted();
          if (state !== "open") throw new Error("Download was closed.");
          await write(bytes);
        } catch (error) {
          failed(error);
          throw error;
        }
      },
      // Closing the worker stream does not commit a file until validation succeeds.
      close: drained,
      abort,
    }),
    async commit() {
      // A transferred writer may close before its final chunk reaches this realm.
      await completion;
      signal.throwIfAborted();
      if (state !== "open") throw new Error("Download was closed.");
      state = "closed";
      signal.removeEventListener("abort", onAbort);
      await finish();
    },
    abort,
  };
}
