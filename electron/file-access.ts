import { randomUUID } from "node:crypto";
import { lstat, opendir } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isDesktopFileUrl,
  isDocumentPath,
  isIgnoredPath,
  isZipPath,
  DESKTOP_IMPORT_LIMIT_BYTES,
  MAX_INPUT_FILES,
  type FileSet,
} from "../src/document/input";

export async function launchFiles(
  args: string[],
  cwd: string,
): Promise<string[]> {
  const candidates = [
    ...new Set(
      args
        .filter(
          (value) =>
            value &&
            !value.startsWith("-") &&
            !/^[a-z][a-z\d+.-]*:\/\//i.test(value),
        )
        .map((value) => resolve(cwd, value)),
    ),
  ];
  const paths: string[] = [];
  for (const path of candidates) {
    if (isIgnoredPath(path)) continue;
    if (isDocumentPath(path) || isZipPath(path)) paths.push(path);
    else if (
      await lstat(path).then(
        (stat) => stat.isDirectory(),
        () => false,
      )
    )
      paths.push(path);
  }
  return paths;
}

export class FileAccess {
  private files = new Map<
    string,
    { path: string; size: number; mtime: number }
  >();
  private generation = 0;
  constructor(private readonly maxBytes = DESKTOP_IMPORT_LIMIT_BYTES) {}

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
    let visited = 0;
    let folderName: string | undefined;
    const seen = new Set<string>();
    const active = () => generation === this.generation;
    const visit = async (
      path: string,
      name: string,
      depth: number,
      nested: boolean,
    ): Promise<void> => {
      if (!active()) return;
      if (isIgnoredPath(name) || isIgnoredPath(path)) return;
      const stat = await lstat(path);
      if (!active()) return;
      if (stat.isDirectory()) {
        if (depth > 64)
          throw new Error("The selected folder is too deeply nested.");
        if (unique.length === 1 && !nested) folderName = basename(path);
        const directory = await opendir(path);
        for await (const entry of directory) {
          if (!active()) return;
          if (++visited > 100000)
            throw new Error("The selected folder is too large.");
          if (isIgnoredPath(entry.name)) continue;
          if (
            entry.isDirectory() ||
            (entry.isFile() && isDocumentPath(entry.name))
          )
            await visit(
              join(path, entry.name),
              `${name}/${entry.name}`,
              depth + 1,
              true,
            );
        }
        return;
      }
      if (!stat.isFile())
        throw new Error("Select a regular FIT, SET or ZIP file or folder.");
      if (
        nested
          ? !isDocumentPath(name)
          : !isDocumentPath(path) && !isZipPath(path)
      )
        throw new Error("Only FIT, SET or ZIP files or folders can be opened.");
      if (seen.has(path)) return;
      seen.add(path);
      if (files.length >= MAX_INPUT_FILES)
        throw new Error(
          `Select no more than ${MAX_INPUT_FILES} FIT or SET files.`,
        );
      total += stat.size;
      if (total > this.maxBytes)
        throw new Error(
          `The selected files exceed the desktop size limit (${Math.round(this.maxBytes / 1048576)} MiB).`,
        );
      const url = `fitviewer://app/import/${randomUUID()}`;
      next.set(url, { path, size: stat.size, mtime: stat.mtimeMs });
      files.push({ name, size: stat.size, url });
    };
    for (const path of unique) {
      if (!isAbsolute(path))
        throw new Error(
          "Only absolute FIT, SET or ZIP file or folder paths can be opened.",
        );
      await visit(resolve(path), basename(path), 0, false);
      if (!active()) return;
    }
    if (!files.length)
      throw new Error("The selected folders contain no FIT or SET files.");
    files.sort((a, b) => a.name.localeCompare(b.name));
    this.files = next;
    return {
      name:
        folderName ||
        (files.length === 1 ? files[0].name : `${files.length} files`),
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
