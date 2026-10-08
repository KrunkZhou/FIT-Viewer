import type { FileSet } from "./document/input";

declare global {
  interface Window {
    fitDesktop?: {
      onOpen: (callback: (selection: FileSet) => void) => () => void;
      release: (urls: string[]) => void;
    };
  }
}
