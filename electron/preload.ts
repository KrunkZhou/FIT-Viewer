import { contextBridge, ipcRenderer } from "electron";
import type { FileSet } from "../src/document/input";
import type { UpdateState } from "../src/updates";
import type { DesktopPromptState } from "../src/desktop-prompts";

contextBridge.exposeInMainWorld("fitDesktop", {
  downloads: {
    open: (name: string) => ipcRenderer.invoke("downloads:open", name),
    write: (token: string, bytes: Uint8Array) =>
      ipcRenderer.invoke("downloads:write", token, bytes),
    finish: (token: string) => ipcRenderer.invoke("downloads:finish", token),
    abort: (token: string) => ipcRenderer.invoke("downloads:abort", token),
  },
  onBeforeClose(callback: () => void) {
    const listener = () => callback();
    ipcRenderer.on("files:confirm-close", listener);
    return () => ipcRenderer.removeListener("files:confirm-close", listener);
  },
  discardAndClose: () => ipcRenderer.send("files:discard-close"),
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
  prompts: {
    getState: () => ipcRenderer.invoke("prompts:state"),
    respond: (id: number, accepted: boolean) =>
      ipcRenderer.invoke("prompts:respond", id, accepted),
    onChange(callback: (state: DesktopPromptState) => void) {
      const listener = (_event: unknown, state: DesktopPromptState) =>
        callback(state);
      ipcRenderer.on("prompts:changed", listener);
      return () => ipcRenderer.removeListener("prompts:changed", listener);
    },
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
