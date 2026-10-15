import type { FileSet } from "./document/input";
import type { DesktopUpdates } from "./updates";
import type { DesktopPromptsApi } from "./desktop-prompts";

declare global {
  interface Window {
    fitDesktop?: {
      onOpen: (callback: (selection: FileSet) => void) => () => void;
      release: (urls: string[]) => void;
      onBeforeClose: (callback: () => void) => () => void;
      discardAndClose: () => void;
      updates: DesktopUpdates;
      prompts: DesktopPromptsApi;
    };
  }
}
