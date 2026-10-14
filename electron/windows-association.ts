import { app, shell, type BrowserWindow } from "electron";
import type { DesktopPromptHost } from "./prompts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_APPS_URL,
  associationRegistration,
  completeAssociationPrompt,
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

export async function askFileAssociation(
  window: BrowserWindow,
  notifications: DesktopPromptHost,
): Promise<void> {
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
  if (dismissed) return;
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
  const accepted = await notifications.show({ kind: "association" });
  // Closing the application is not an answer to the preference prompt.
  if (accepted === undefined) return;
  await completeAssociationPrompt(accepted ? 0 : 1, {
    dismiss: () =>
      writeFile(
        preferencePath,
        JSON.stringify({ dismissed: true }) + "\n",
        "utf8",
      ),
    register: async () => {
      for (const [key, name, value] of associationRegistration(
        process.execPath,
      ))
        await run(
          join(process.env.SystemRoot || "C:\\Windows", "System32", "reg.exe"),
          [
            "add",
            key,
            ...(name ? ["/v", name] : ["/ve"]),
            "/t",
            "REG_SZ",
            "/d",
            value,
            "/f",
          ],
          { windowsHide: true, timeout: 3000 },
        );
    },
    openSettings: () => shell.openExternal(DEFAULT_APPS_URL),
  });
}
