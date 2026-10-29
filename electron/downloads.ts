import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainInvokeEvent,
} from "electron";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { appNavigation } from "./resources";
import { DownloadFile } from "./download-file";

interface Owner {
  window: BrowserWindow;
  generation: number;
  opening: boolean;
  files: Map<string, DownloadFile>;
}
const owners = new Map<number, Owner>();
let registered = false;

export function attachDownloads(window: BrowserWindow): void {
  const id = window.webContents.id;
  const owner: Owner = {
    window,
    generation: 0,
    opening: false,
    files: new Map(),
  };
  owners.set(id, owner);
  const clear = () => {
    owner.generation++;
    for (const file of owner.files.values()) void file.abort();
    owner.files.clear();
  };
  window.webContents.on(
    "did-start-navigation",
    (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) clear();
    },
  );
  window.webContents.on("render-process-gone", clear);
  window.once("closed", () => {
    clear();
    owners.delete(id);
  });
  if (registered) return;
  registered = true;
  const access = (event: IpcMainInvokeEvent) => {
    const owner = owners.get(event.sender.id);
    if (
      !owner ||
      event.senderFrame !== event.sender.mainFrame ||
      !appNavigation(event.senderFrame.url)
    )
      throw new Error("Download access denied.");
    return owner;
  };
  ipcMain.handle("downloads:open", async (event, name: unknown) => {
    const owner = access(event);
    if (
      typeof name !== "string" ||
      name.length > 240 ||
      owner.opening ||
      owner.files.size
    )
      throw new Error(
        "Another download is already active or the filename is invalid.",
      );
    owner.opening = true;
    const generation = owner.generation;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(owner.window, {
        defaultPath: basename(name),
        title: "Save download",
      });
      if (canceled || !filePath || generation !== owner.generation) return;
      const file = await DownloadFile.open(filePath);
      if (generation !== owner.generation) {
        await file.abort();
        return;
      }
      const token = randomUUID();
      owner.files.set(token, file);
      return token;
    } finally {
      owner.opening = false;
    }
  });
  ipcMain.handle(
    "downloads:write",
    async (event, token: string, bytes: Uint8Array) => {
      const file = access(event).files.get(token);
      if (!file) throw new Error("Download is unavailable.");
      await file.write(bytes);
    },
  );
  for (const action of ["finish", "abort"] as const)
    ipcMain.handle(`downloads:${action}`, async (event, token: string) => {
      const owner = access(event);
      const file = owner.files.get(token);
      if (!file) {
        if (action === "finish") throw new Error("Download is unavailable.");
        return;
      }
      try {
        await file[action]();
      } catch (error) {
        await file.abort();
        throw error;
      } finally {
        owner.files.delete(token);
      }
    });
}
