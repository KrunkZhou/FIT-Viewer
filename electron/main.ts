import { app, BrowserWindow, dialog } from "electron";
import { createWindow, registerBundle } from "./app";
import { launchFiles } from "./file-access";
import { OpenFiles } from "./open-files";
import { askFileAssociation } from "./windows-association";
import { desktopUpdates } from "./updates";
import { desktopPrompts, type DesktopPromptHost } from "./prompts";

app.setName("FIT Viewer");
app.setAppUserModelId("app.fitviewer.desktop");
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  const files = new OpenFiles();
  let updates: Awaited<ReturnType<typeof desktopUpdates>>;
  let notifications: DesktopPromptHost;
  const initialPaths = launchFiles(
    process.argv.slice(app.isPackaged ? 1 : 2),
    process.cwd(),
  );
  let pending: string[] = [];
  let ready = false;
  let creating: Promise<BrowserWindow> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const ensureWindow = (): Promise<BrowserWindow> => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (creating) return creating;
    if (existing) return Promise.resolve(existing);
    creating = createWindow(true, undefined, (window) => {
      files.attach(window);
      notifications.attach(window);
      updates.attach(window);
    }).finally(() => {
      creating = undefined;
    });
    return creating;
  };
  const deliver = async () => {
    const window = await ensureWindow();
    const paths = pending;
    pending = [];
    files.open(paths);
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };
  const schedule = () => {
    if (!ready) return;
    clearTimeout(openTimer);
    openTimer = setTimeout(() => void deliver().catch(console.error), 50);
  };
  app.on("open-file", (event, path) => {
    event.preventDefault();
    pending.push(path);
    schedule();
  });
  app.on("second-instance", (_event, argv, cwd) => {
    void launchFiles(argv.slice(app.isPackaged ? 1 : 2), cwd)
      .then((paths) => {
        pending.push(...paths);
        schedule();
      })
      .catch(console.error);
  });
  app
    .whenReady()
    .then(async () => {
      pending.unshift(...(await initialPaths));
      await registerBundle(undefined, files.access);
      notifications = desktopPrompts();
      updates = await desktopUpdates(notifications);
      const window = await ensureWindow();
      ready = true;
      await deliver();
      void askFileAssociation(window, notifications).catch(console.error);
      app.on("activate", () => {
        void ensureWindow().catch(console.error);
      });
    })
    .catch((error: Error) => {
      dialog.showErrorBox("FIT Viewer could not start", error.message);
      app.exit(1);
    });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
