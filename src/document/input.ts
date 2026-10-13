export const MAX_INPUT_FILES = 10000;
export const WEB_IMPORT_LIMIT_BYTES = 512 * 1048576;
export const DESKTOP_IMPORT_LIMIT_BYTES = 2048 * 1048576;

export function importLimitBytes(
  desktop: boolean,
  webLimitMiB?: string,
): number {
  if (desktop) return DESKTOP_IMPORT_LIMIT_BYTES;
  const configured = Number(webLimitMiB) * 1048576;
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : WEB_IMPORT_LIMIT_BYTES;
}

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
