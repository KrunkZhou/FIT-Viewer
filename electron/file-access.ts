import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  isDesktopFileUrl,
  MAX_INPUT_FILES,
  type FileSet,
} from "../src/document/input";

export function launchFiles(args: string[], cwd: string): string[] {
  return [
    ...new Set(
      args.flatMap((value) => {
        if (value.startsWith("-")) return [];
        if (/^file:/i.test(value)) {
          try {
            const url = new URL(value);
            if (url.hostname || url.search || url.hash) return [];
            value = fileURLToPath(url);
          } catch {
            return [];
          }
        } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) return [];
        if (!/\.(fit|zip)$/i.test(value)) return [];
        return [isAbsolute(value) ? value : resolve(cwd, value)];
      }),
    ),
  ];
}

export class FileAccess {
  private files = new Map<
    string,
    { path: string; size: number; mtime: number }
  >();
  private generation = 0;
  constructor(private readonly maxBytes = 512 * 1048576) {}

  async grant(paths: string[]): Promise<FileSet | undefined> {
    this.clear();
    const generation = this.generation;
    const unique = [...new Set(paths)];
    if (!unique.length || unique.length > MAX_INPUT_FILES)
      throw new Error("Invalid number of files.");
    const next = new Map<
      string,
      { path: string; size: number; mtime: number }
    >();
    const files: FileSet["files"] = [];
    let total = 0;
    for (const path of unique) {
      if (!isAbsolute(path) || !/\.(fit|zip)$/i.test(path))
        throw new Error("Only FIT or ZIP files can be opened.");
      const stat = await lstat(path);
      if (generation !== this.generation) return;
      if (!stat.isFile()) throw new Error("Select a regular FIT or ZIP file.");
      total += stat.size;
      if (total > this.maxBytes)
        throw new Error("The selected files exceed the desktop size limit.");
      const url = `fitviewer://app/import/${randomUUID()}`;
      next.set(url, { path, size: stat.size, mtime: stat.mtimeMs });
      files.push({ name: basename(path), size: stat.size, url });
    }
    this.files = next;
    return {
      name: files.length === 1 ? files[0].name : `${files.length} files`,
      files,
    };
  }

  async read(
    request: Request,
    fetchFile: (url: string) => Promise<Response>,
  ): Promise<Response> {
    const file = isDesktopFileUrl(request.url)
      ? this.files.get(request.url)
      : undefined;
    if (request.method !== "GET" || !file)
      return new Response("Not found", { status: 404 });
    try {
      const stat = await lstat(file.path);
      if (
        !stat.isFile() ||
        stat.size !== file.size ||
        stat.mtimeMs !== file.mtime ||
        this.files.get(request.url) !== file
      )
        return new Response("File changed", { status: 409 });
      const response = await fetchFile(pathToFileURL(file.path).href);
      if (!response.ok || !response.body)
        return new Response("Unavailable", { status: 404 });
      let received = 0;
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > file.size)
              controller.error(new Error("File size changed"));
            else controller.enqueue(chunk);
          },
          flush(controller) {
            if (received !== file.size)
              controller.error(new Error("File size changed"));
          },
        }),
      );
      return new Response(body, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(file.size),
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response("Unavailable", { status: 404 });
    }
  }

  release(urls: unknown): void {
    if (Array.isArray(urls) && urls.length <= MAX_INPUT_FILES)
      for (const url of urls)
        if (typeof url === "string") this.files.delete(url);
  }
  clear(): void {
    this.generation++;
    this.files.clear();
  }
}
