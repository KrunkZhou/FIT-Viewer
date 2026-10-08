import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { app } from "electron";
import { createWindow, registerBundle } from "./app";
import { activity } from "../tests/fixtures";

const profile = resolve(".cache/electron-smoke-profile");
mkdirSync(profile, { recursive: true });
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setPath("logs", profile);
const timeout = setTimeout(() => {
  console.error("Desktop smoke timed out", { ready: app.isReady() });
  app.exit(1);
}, 30000);

app
  .whenReady()
  .then(async () => {
    await registerBundle(resolve("desktop/dist"));
    const window = await createWindow(false);
    const bytes = Array.from(activity(32));
    const result = await window.webContents.executeJavaScript(`(async () => {
    const waitFor = async (predicate) => {
      const deadline = performance.now() + 15000;
      while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Desktop UI did not become ready");
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await waitFor(() => document.querySelector('input[type="file"]'));
    if (typeof window.require !== "undefined") throw new Error("Renderer exposes Node.js");
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(${JSON.stringify(bytes)})], "desktop-smoke.fit"));
    const input = document.querySelector('input[type="file"]');
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await waitFor(() => document.body.textContent.includes("File overview"));
    const tab = name => [...document.querySelectorAll('[role="tab"]')].find(button => button.textContent.includes(name));
    tab("Messages").click();
    await waitFor(() => document.querySelector("table"));
    const rows = document.querySelectorAll("table tbody tr").length;
    tab("Chart").click();
    await waitFor(() => document.querySelector(".recharts-wrapper"));
    const removed = await fetch("/develop");
    return { title: document.title, rows, chart: !!document.querySelector(".recharts-surface"), removedStatus: removed.status, nodeAccess: typeof window.require };
  })()`);
    assert.equal(result.title, "FIT Viewer");
    assert.ok(result.rows > 0);
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
  .catch((error) => {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  });
