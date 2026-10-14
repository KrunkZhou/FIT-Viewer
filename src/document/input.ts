export const MAX_INPUT_FILES = 10000;
export const WEB_IMPORT_LIMIT_BYTES = 512 * 1048576;
export const DESKTOP_IMPORT_LIMIT_BYTES = 2048 * 1048576;

export class ImportSizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportSizeError";
  }
}

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
  return /\.fit$/i.test(name) && !isIgnoredPath(name);
}

export function isSetPath(name: string): boolean {
  return /\.set$/i.test(name) && !isIgnoredPath(name);
}

export function isOutBinPath(name: string): boolean {
  return /(?:^|[\\/])out\.bin$/i.test(name) && !isIgnoredPath(name);
}

export function isDocumentPath(name: string): boolean {
  return isFitPath(name) || isSetPath(name) || isOutBinPath(name);
}

export function isZipPath(name: string): boolean {
  return /\.zip$/i.test(name) && !isIgnoredPath(name);
}

export function isIgnoredPath(name: string): boolean {
  return name
    .split(/[\\/]/)
    .some((part) => part === "__MACOSX" || part.startsWith("._"));
}
