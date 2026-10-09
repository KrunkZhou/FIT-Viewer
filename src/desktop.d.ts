import type { FileSet } from "./document/input";
import type { DesktopUpdates } from "./updates";

declare global {
  interface Window {
    fitDesktop?: {
      onOpen: (callback: (selection: FileSet) => void) => () => void;
      release: (urls: string[]) => void;
      updates: DesktopUpdates;
    };
  }
}
