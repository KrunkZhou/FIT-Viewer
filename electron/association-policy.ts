import { win32 } from "node:path";

export const FIT_PROG_ID = "app.fitviewer.desktop.fit";
export const DEFAULT_APPS_URL =
  "ms-settings:defaultapps?registeredAppUser=FIT%20Viewer";

export function shouldPromptForAssociation(state: {
  platform: string;
  packaged: boolean;
  portable: boolean;
  executable: string;
  installedExecutable?: string;
  currentProgId?: string;
  dismissed: boolean;
}): boolean {
  return (
    state.platform === "win32" &&
    state.packaged &&
    !state.portable &&
    !state.dismissed &&
    Boolean(state.installedExecutable) &&
    win32.normalize(state.executable).toLowerCase() ===
      win32.normalize(state.installedExecutable!).toLowerCase() &&
    state.currentProgId?.toLowerCase() !== FIT_PROG_ID
  );
}
