import {
  app,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { appNavigation } from "./resources";
import { PromptQueue } from "./prompt-queue";

export function desktopPrompts() {
  let window: BrowserWindow | undefined;
  const queue = new PromptQueue((state) => {
    if (window && !window.isDestroyed())
      window.webContents.send("prompts:changed", state);
  });
  const trusted = (event: IpcMainInvokeEvent) => {
    if (
      !window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== event.sender.mainFrame ||
      !appNavigation(event.senderFrame.url)
    )
      throw new Error("Untrusted notification request.");
  };
  ipcMain.handle("prompts:state", (event) => {
    trusted(event);
    return queue.snapshot();
  });
  ipcMain.handle("prompts:respond", (event, id: unknown, accepted: unknown) => {
    trusted(event);
    queue.respond(id, accepted);
  });
  app.once("before-quit", () => queue.cancel());
  return {
    show: queue.show.bind(queue),
    attach(next: BrowserWindow) {
      window = next;
      next.once("closed", () => {
        if (window !== next) return;
        window = undefined;
        queue.cancel();
      });
    },
  };
}

export type DesktopPromptHost = ReturnType<typeof desktopPrompts>;
