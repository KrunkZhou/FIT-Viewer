import { app, BrowserWindow, dialog } from "electron";
import { createWindow, registerBundle } from "./app";
import { launchFiles } from "./file-access";
import { OpenFiles } from "./open-files";
import { askFileAssociation } from "./windows-association";
import { desktopUpdates } from "./updates";

app.setName("FIT Viewer");
app.setAppUserModelId("app.fitviewer.desktop");
const primary = app.requestSingleInstanceLock();
if (!primary) app.quit();
else {
  const files = new OpenFiles();
  let updates: Awaited<ReturnType<typeof desktopUpdates>>;
  let pending = launchFiles(
    process.argv.slice(app.isPackaged ? 1 : 2),
    process.cwd(),
  );
  let ready = false;
  let creating: Promise<BrowserWindow> | undefined;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  const ensureWindow = (): Promise<BrowserWindow> => {
    const existing = BrowserWindow.getAllWindows()[0];
    if (creating) return creating;
    if (existing) return Promise.resolve(existing);
    creating = createWindow(true, undefined, (window) => {
      files.attach(window);
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
    pending.push(...launchFiles(argv.slice(app.isPackaged ? 1 : 2), cwd));
    schedule();
  });
  app
    .whenReady()
    .then(async () => {
      await registerBundle(undefined, files.access);
      updates = await desktopUpdates();
      const window = await ensureWindow();
      ready = true;
      await deliver();
      void askFileAssociation(window).catch(console.error);
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
