import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { app, type BrowserWindow } from "electron";
import { createWindow, registerBundle } from "./app";
import { activity } from "../tests/fixtures";
import { syntheticSettings } from "../tests/ciq-fixtures";
import { outBinFixture } from "../tests/out-bin-fixtures";
import {
  checkAppInformation,
  checkCiqRenderer,
  checkDesktopSelection,
  checkDesktopNotifications,
  checkMapTimeline,
  checkOutBinRenderer,
  checkRenderer,
} from "./smoke-renderer";
import { OpenFiles } from "./open-files";
import { desktopUpdates } from "./updates";
import { desktopPrompts } from "./prompts";

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
    const files = new OpenFiles();
    const notifications = desktopPrompts();
    const updates = await desktopUpdates(notifications);
    const first = resolve(".cache/desktop-first.fit");
    const second = resolve(".cache/desktop-second.fit");
    await writeFile(first, activity(32));
    await writeFile(second, activity(32));
    await registerBundle(resolve("desktop/dist"), files.access);
    files.open([first, second]);
    const window = await createWindow(
      false,
      resolve("desktop/preload.cjs"),
      (window) => {
        files.attach(window);
        notifications.attach(window);
        updates.attach(window);
      },
    );
    smokeWindow = window;
    const initial = await window.webContents.executeJavaScript(
      `(${checkDesktopSelection.toString()})("2 files", 2)`,
    );
    const metadata = JSON.parse(await readFile("desktop/package.json", "utf8"));
    const info = await window.webContents.executeJavaScript(
      `(${checkAppInformation.toString()})(${JSON.stringify(metadata.version)})`,
    );
    // Synthetic offers exercise the production IPC/UI without changing Windows defaults or installing an update.
    const updateAnswer = notifications.show({
      kind: "install",
      version: "1.2.3",
    });
    const associationAnswer = notifications.show({ kind: "association" });
    const prompts = await window.webContents.executeJavaScript(
      `(${checkDesktopNotifications.toString()})()`,
    );
    assert.equal(await updateAnswer, false);
    assert.equal(await associationAnswer, false);
    await window.webContents.executeJavaScript(
      `(${checkRenderer.toString()})()`,
    );
    files.open([second]);
    const replacement = await window.webContents.executeJavaScript(
      `(${checkDesktopSelection.toString()})("desktop-second.fit", 1)`,
    );
    await window.webContents.executeJavaScript(
      `(${checkRenderer.toString()})()`,
    );
    const bytes = Array.from(activity(32));
    const result = await window.webContents.executeJavaScript(
      `(${checkRenderer.toString()})(${JSON.stringify(bytes)})`,
    );
    assert.equal(result.title, "FIT Viewer");
    assert.equal(result.rows, 20);
    assert.equal(result.chart, true);
    assert.equal(result.removedStatus, 404);
    assert.equal(result.nodeAccess, "undefined");
    const timeline = await window.webContents.executeJavaScript(
      `(${checkMapTimeline.toString()})()`,
    );
    const ciq = await window.webContents.executeJavaScript(
      `(${checkCiqRenderer.toString()})(${JSON.stringify(Array.from(syntheticSettings()))}, ${JSON.stringify(bytes)})`,
    );
    const ciqImage = await window.webContents.capturePage();
    await writeFile(".cache/electron-ciq-smoke.png", ciqImage.toPNG());
    const inventory = await window.webContents.executeJavaScript(
      `(${checkOutBinRenderer.toString()})(${JSON.stringify(Array.from(outBinFixture()))}, ${JSON.stringify(Array.from(syntheticSettings()))}, ${JSON.stringify(bytes)})`,
    );
    const inventoryImage = await window.webContents.capturePage();
    await writeFile(
      ".cache/electron-out-bin-smoke.png",
      inventoryImage.toPNG(),
    );
    await window.webContents.executeJavaScript(
      `(${checkRenderer.toString()})(${JSON.stringify(bytes)})`,
    );
    const image = await window.webContents.capturePage();
    await writeFile(".cache/electron-smoke.png", image.toPNG());
    console.log(
      `Desktop smoke passed: ${JSON.stringify({ ...result, initial, replacement, info, prompts, ciq, timeline, inventory })}`,
    );
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
