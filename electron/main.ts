import { app, BrowserWindow, dialog } from "electron";
import { createWindow, registerBundle } from "./app";

app.setName("FIT Viewer");
app
  .whenReady()
  .then(async () => {
    await registerBundle();
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0)
        void createWindow().catch(console.error);
    });
  })
  .catch((error: Error) => {
    dialog.showErrorBox("FIT Viewer could not start", error.message);
    app.exit(1);
  });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
