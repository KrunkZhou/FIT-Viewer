import type { FileSet } from "./document/input";
import type { DesktopUpdates } from "./updates";
import type { DesktopPromptsApi } from "./desktop-prompts";

declare global {
  interface Window {
    fitDesktop?: {
      downloads: {
        open(name: string): Promise<string | undefined>;
        write(token: string, bytes: Uint8Array): Promise<void>;
        finish(token: string): Promise<void>;
        abort(token: string): Promise<void>;
      };
      onOpen: (callback: (selection: FileSet) => void) => () => void;
      release: (urls: string[]) => void;
      onBeforeClose: (callback: () => void) => () => void;
      discardAndClose: () => void;
      updates: DesktopUpdates;
      prompts: DesktopPromptsApi;
    };
  }
}
