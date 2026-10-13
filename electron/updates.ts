import {
  app,
  dialog,
  ipcMain,
  shell,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { appNavigation } from "./resources";
import { UpdateController } from "./update-controller";
import { createUpdateBackend } from "./update-backend";
import { UpdatePrompter, updatePromptOptions } from "./update-prompt";
import { GITHUB_URL } from "../src/app-info";
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
  const prompts = new UpdatePrompter({
    state: () => controller.snapshot(),
    canShow: () => !!window && !window.isDestroyed() && window.isFocused(),
    async show(offer, signal) {
      const parent = window;
      if (!parent || parent.isDestroyed()) return false;
      const { response } = await dialog.showMessageBox(parent, {
        ...updatePromptOptions(offer),
        signal,
      });
      return response === 0;
    },
    install: () => controller.install(),
    download: (version) =>
      shell.openExternal(`${GITHUB_URL}/releases/tag/v${version}`),
    report: (error) => console.error("Could not show the update popup", error),
  });
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
  ipcMain.handle("updates:install", async (event) => {
    trusted(event);
    if (controller.snapshot().phase === "ready") await prompts.request(true);
  });
  controller.subscribe((state) => {
    if (window && !window.isDestroyed())
      window.webContents.send("updates:changed", state);
    prompts.notify();
  });
  app.once("before-quit", () => {
    prompts.dispose();
    controller.dispose();
  });
  controller.start();
  return {
    attach(next: BrowserWindow) {
      window = next;
      next.on("focus", () => prompts.notify());
      next.once("closed", () => {
        if (window === next) {
          window = undefined;
          prompts.cancel();
        }
      });
      prompts.notify();
    },
  };
}
