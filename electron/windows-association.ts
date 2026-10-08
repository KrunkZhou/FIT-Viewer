import { app, dialog, shell, type BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_APPS_URL,
  shouldPromptForAssociation,
} from "./association-policy";

const run = promisify(execFile);
async function registryValue(
  key: string,
  name: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
      ["query", key, "/v", name],
      { windowsHide: true, timeout: 3000 },
    );
    return stdout.match(/\sREG_SZ\s+([^\r\n]+)/)?.[1].trim();
  } catch {
    return;
  }
}

export async function askFileAssociation(window: BrowserWindow): Promise<void> {
  if (
    process.platform !== "win32" ||
    !app.isPackaged ||
    process.env.PORTABLE_EXECUTABLE_FILE
  )
    return;
  const preferencePath = join(app.getPath("userData"), "file-association.json");
  let dismissed = false;
  try {
    dismissed =
      JSON.parse(await readFile(preferencePath, "utf8")).dismissed === true;
  } catch {
    /* First launch. */
  }
  const installedExecutable = await registryValue(
    "HKCU\\Software\\FITViewer",
    "Executable",
  );
  const currentProgId = await registryValue(
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.fit\\UserChoice",
    "ProgId",
  );
  if (
    !shouldPromptForAssociation({
      platform: process.platform,
      packaged: app.isPackaged,
      portable: false,
      executable: process.execPath,
      installedExecutable,
      currentProgId,
      dismissed,
    }) ||
    window.isDestroyed()
  )
    return;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "Open FIT files with FIT Viewer",
    message: "Use FIT Viewer to open .fit files?",
    detail:
      "Choose FIT Viewer for .fit files in Windows Settings. Your current default will not change until you confirm it there.",
    buttons: ["Choose default app", "Not now", "Don't ask again"],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) await shell.openExternal(DEFAULT_APPS_URL);
  if (response === 0 || response === 2)
    await writeFile(
      preferencePath,
      JSON.stringify({ dismissed: true }) + "\n",
      "utf8",
    );
}
