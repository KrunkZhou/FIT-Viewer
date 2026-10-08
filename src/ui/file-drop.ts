import { isFitPath, MAX_INPUT_FILES, type FileSet } from "../document/input";

export interface DroppedFiles {
  entries: FileSystemEntry[];
  files: File[];
}

// Capture entries during the drop event, before Chromium clears the data store.
export function captureDrop(data: DataTransfer): DroppedFiles {
  return {
    entries: Array.from(data.items).flatMap((item) => {
      const entry = item.webkitGetAsEntry?.();
      return entry ? [entry] : [];
    }),
    files: Array.from(data.files),
  };
}

export async function collectDrop(
  drop: DroppedFiles,
  signal: AbortSignal,
  limit: number,
  progress: (count: number) => void,
): Promise<FileSet> {
  const files: File[] = [];
  let total = 0;
  let visited = 0;
  const add = (file: File, name = file.name) => {
    signal.throwIfAborted();
    if (!isFitPath(name) && !/\.zip$/i.test(name)) return;
    total += file.size;
    if (total > limit)
      throw new Error("The selected files exceed the configured size limit.");
    if (files.length >= MAX_INPUT_FILES)
      throw new Error(`Select no more than ${MAX_INPUT_FILES} FIT files.`);
    files.push(
      name === file.name
        ? file
        : new File([file], name, { lastModified: file.lastModified }),
    );
    progress(files.length);
  };
  const visit = async (
    entry: FileSystemEntry,
    path = "",
    depth = 0,
  ): Promise<void> => {
    signal.throwIfAborted();
    if (++visited > 100000 || depth > 64)
      throw new Error("The selected folder is too large or too deeply nested.");
    if (visited % 128 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
    if (entry.name === "__MACOSX" || entry.name.startsWith("._")) return;
    const name = path + entry.name;
    if (entry.isFile) {
      // A folder import selects FIT files, not arbitrary nested archives.
      if (path && !isFitPath(name)) return;
      if (!path && !isFitPath(name) && !/\.zip$/i.test(name)) return;
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject),
      );
      add(file, name);
    } else if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader();
      while (true) {
        signal.throwIfAborted();
        const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await visit(child, `${name}/`, depth + 1);
      }
    }
  };
  if (drop.entries.length) {
    for (const entry of drop.entries) await visit(entry);
  } else {
    for (const file of drop.files) {
      if (++visited % 128 === 0)
        await new Promise((resolve) => setTimeout(resolve, 0));
      if (file.webkitRelativePath && !isFitPath(file.webkitRelativePath))
        continue;
      add(file, file.webkitRelativePath || file.name);
    }
  }
  signal.throwIfAborted();
  if (!files.length) throw new Error("The selection contains no FIT files.");
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    name:
      drop.entries.length === 1 && drop.entries[0].isDirectory
        ? drop.entries[0].name
        : drop.files[0]?.webkitRelativePath?.split("/")[0] ||
          (files.length === 1 ? files[0].name : `${files.length} files`),
    files,
  };
}
