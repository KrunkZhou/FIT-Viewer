import {
  app,
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { appNavigation } from "./resources";
import { UpdateController } from "./update-controller";
import { createUpdateBackend } from "./update-backend";
import {
  readUpdatePreference,
  writeUpdatePreference,
} from "./update-preference";

export async function desktopUpdates() {
  const path = join(app.getPath("userData"), "updates.json");
  const controller = new UpdateController(
    createUpdateBackend(
      process.platform,
      app.isPackaged,
      Boolean(process.env.PORTABLE_EXECUTABLE_FILE),
      app.getVersion(),
    ),
    await readUpdatePreference(path),
    (enabled) => writeUpdatePreference(path, enabled),
  );
  let window: BrowserWindow | undefined;
  const trusted = (event: IpcMainInvokeEvent) => {
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !appNavigation(event.senderFrame.url)
    )
      throw new Error("Untrusted update request.");
  };
  ipcMain.handle("updates:state", (event) => {
    trusted(event);
    return controller.snapshot();
  });
  ipcMain.handle("updates:enabled", (event, enabled: unknown) => {
    trusted(event);
    if (typeof enabled !== "boolean")
      throw new Error("Invalid update preference.");
    return controller.setEnabled(enabled);
  });
  ipcMain.handle("updates:check", (event) => {
    trusted(event);
    return controller.check(true);
  });
  let confirming = false;
  ipcMain.handle("updates:install", async (event) => {
    trusted(event);
    if (confirming || controller.snapshot().phase !== "ready") return;
    confirming = true;
    try {
      const { response } = await dialog.showMessageBox(window!, {
        type: "question",
        title: "Update FIT Viewer",
        message: "Restart to install the update?",
        detail: "Open files and current view selections will be closed.",
        buttons: ["Restart to update", "Cancel"],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response === 0 && controller.snapshot().phase === "ready")
        controller.install();
    } finally {
      confirming = false;
    }
  });
  controller.subscribe((state) => {
    if (window && !window.isDestroyed())
      window.webContents.send("updates:changed", state);
  });
  app.once("before-quit", () => controller.dispose());
  controller.start();
  return {
    attach(next: BrowserWindow) {
      window = next;
      next.once("closed", () => {
        if (window === next) window = undefined;
      });
    },
  };
}
