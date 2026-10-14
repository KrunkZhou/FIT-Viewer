import { win32 } from "node:path";

export const FIT_PROG_ID = "app.fitviewer.desktop.fit";
export const DEFAULT_APPS_URL =
  "ms-settings:defaultapps?registeredAppUser=FIT%20Viewer";

export function associationRegistration(executable: string) {
  const capabilities = "HKCU\\Software\\FITViewer\\Capabilities";
  const progId = `HKCU\\Software\\Classes\\${FIT_PROG_ID}`;
  return [
    [capabilities, "ApplicationName", "FIT Viewer"],
    [
      capabilities,
      "ApplicationDescription",
      "View local FIT activity and sensor files",
    ],
    [capabilities, "ApplicationIcon", `"${executable}",0`],
    [`${capabilities}\\FileAssociations`, ".fit", FIT_PROG_ID],
    [
      "HKCU\\Software\\RegisteredApplications",
      "FIT Viewer",
      "Software\\FITViewer\\Capabilities",
    ],
    [progId, "", "FIT activity file"],
    [`${progId}\\DefaultIcon`, "", `"${executable}",0`],
    [`${progId}\\shell\\open\\command`, "", `"${executable}" "%1"`],
    ["HKCU\\Software\\Classes\\.fit\\OpenWithProgids", FIT_PROG_ID, ""],
  ] as const;
}

export async function completeAssociationPrompt(
  response: number,
  actions: {
    dismiss: () => Promise<void>;
    register: () => Promise<void>;
    openSettings: () => Promise<void>;
  },
): Promise<void> {
  // Remember every answer, including Esc/window close (the "Not now" response).
  await actions.dismiss();
  if (response !== 0) return;
  await actions.register();
  await actions.openSettings();
}

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
