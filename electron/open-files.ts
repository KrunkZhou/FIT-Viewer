import {
  dialog,
  ipcMain,
  type BrowserWindow,
  type IpcMainEvent,
} from "electron";
import { appNavigation } from "./resources";
import { FileAccess } from "./file-access";

export class OpenFiles {
  readonly access = new FileAccess();
  private window?: BrowserWindow;
  private ready = false;
  private pending?: string[];

  constructor() {
    const trusted = (event: IpcMainEvent) =>
      this.window &&
      event.sender === this.window.webContents &&
      event.senderFrame === event.sender.mainFrame &&
      appNavigation(event.senderFrame.url);
    ipcMain.on("files:ready", (event) => {
      if (!trusted(event)) return;
      this.ready = true;
      void this.flush();
    });
    ipcMain.on("files:release", (event, urls: unknown) => {
      if (trusted(event)) this.access.release(urls);
    });
  }
  attach(window: BrowserWindow): void {
    this.window = window;
    this.ready = false;
    window.on("closed", () => {
      this.window = undefined;
      this.ready = false;
      this.access.clear();
    });
    window.webContents.on(
      "did-start-navigation",
      (_event, _url, inPlace, mainFrame) => {
        if (mainFrame && !inPlace) this.ready = false;
      },
    );
  }
  open(paths: string[]): void {
    if (!paths.length) return;
    this.pending = paths;
    void this.flush();
  }
  private async flush(): Promise<void> {
    if (!this.pending || !this.ready || !this.window) return;
    const paths = this.pending;
    const window = this.window;
    this.pending = undefined;
    try {
      const selection = await this.access.grant(paths);
      if (selection && this.window === window && !window.isDestroyed()) {
        if (!this.ready) {
          this.pending ??= paths;
          this.access.clear();
          return;
        }
        window.webContents.send("files:open", selection);
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
      }
    } catch (error) {
      if (!window.isDestroyed())
        await dialog.showMessageBox(window, {
          type: "error",
          message: "Could not open the selected files",
          detail: (error as Error).message,
        });
    }
  }
}
