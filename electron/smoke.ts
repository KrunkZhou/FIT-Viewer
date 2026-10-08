import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { app, type BrowserWindow } from "electron";
import { createWindow, registerBundle } from "./app";
import { activity } from "../tests/fixtures";
import { checkRenderer } from "./smoke-renderer";

const profile = resolve(".cache/electron-smoke-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setPath("logs", profile);
const timeout = setTimeout(() => {
  console.error("Desktop smoke timed out", { ready: app.isReady() });
  app.exit(1);
}, 30000);
let smokeWindow: BrowserWindow | undefined;

app
  .whenReady()
  .then(async () => {
    await registerBundle(resolve("desktop/dist"));
    const window = await createWindow(false);
    smokeWindow = window;
    const bytes = Array.from(activity(32));
    const result = await window.webContents.executeJavaScript(
      `(${checkRenderer.toString()})(${JSON.stringify(bytes)})`,
    );
    assert.equal(result.title, "FIT Viewer");
    assert.equal(result.rows, 20);
    assert.equal(result.chart, true);
    assert.equal(result.removedStatus, 404);
    assert.equal(result.nodeAccess, "undefined");
    const image = await window.webContents.capturePage();
    await writeFile(".cache/electron-smoke.png", image.toPNG());
    console.log(`Desktop smoke passed: ${JSON.stringify(result)}`);
    clearTimeout(timeout);
    window.destroy();
    app.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    if (smokeWindow && !smokeWindow.isDestroyed()) {
      try {
        console.error(
          "Desktop renderer at failure:",
          await smokeWindow.webContents.executeJavaScript(
            "document.body.innerText.slice(0, 4000)",
          ),
        );
        const image = await smokeWindow.webContents.capturePage();
        await writeFile(".cache/electron-smoke-failure.png", image.toPNG());
      } catch (diagnosticError) {
        console.error("Cannot capture desktop failure", diagnosticError);
      }
    }
    clearTimeout(timeout);
    app.exit(1);
  });
