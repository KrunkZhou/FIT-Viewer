import { contextBridge, ipcRenderer } from "electron";
import type { FileSet } from "../src/document/input";
import type { UpdateState } from "../src/updates";

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
  updates: {
    getState: () => ipcRenderer.invoke("updates:state"),
    setEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("updates:enabled", enabled),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    onChange(callback: (state: UpdateState) => void) {
      const listener = (_event: unknown, state: UpdateState) => callback(state);
      ipcRenderer.on("updates:changed", listener);
      return () => ipcRenderer.removeListener("updates:changed", listener);
    },
  },
});
