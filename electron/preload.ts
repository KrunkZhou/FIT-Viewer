import { contextBridge, ipcRenderer } from "electron";
import type { FileSet } from "../src/document/input";

contextBridge.exposeInMainWorld("fitDesktop", {
  onOpen(callback: (selection: FileSet) => void) {
    const listener = (_event: unknown, selection: FileSet) =>
      callback(selection);
    ipcRenderer.on("files:open", listener);
    ipcRenderer.send("files:ready");
    return () => ipcRenderer.removeListener("files:open", listener);
  },
  release(urls: string[]) {
    ipcRenderer.send("files:release", urls);
  },
});
