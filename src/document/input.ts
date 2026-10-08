export const MAX_INPUT_FILES = 10000;

// Only the desktop host can grant these short-lived, opaque file URLs.
export interface DesktopFile {
  name: string;
  size: number;
  url: string;
}
export interface FileSet {
  name: string;
  files: (File | DesktopFile)[];
}
export type DocumentInput = File | FileSet;

export function isDesktopFileUrl(url: string): boolean {
  return /^fitviewer:\/\/app\/import\/[0-9a-f-]{36}$/.test(url);
}

export function isFitPath(name: string): boolean {
  return (
    /\.fit$/i.test(name) &&
    !name
      .split(/[\\/]/)
      .some((part) => part === "__MACOSX" || part.startsWith("._"))
  );
}
