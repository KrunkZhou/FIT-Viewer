import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { FileAccess } from "./file-access";
import {
  APP_URL,
  appNavigation,
  bundlePath,
  contentSecurityPolicy,
  externalLink,
} from "./resources";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "fitviewer",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

export async function registerBundle(
  root = join(app.getAppPath(), "dist"),
  access?: FileAccess,
): Promise<void> {
  const csp = contentSecurityPolicy(
    await readFile(join(root, "index.html"), "utf8"),
  );
  protocol.handle("fitviewer", async (request) => {
    if (access && new URL(request.url).pathname.startsWith("/import/"))
      return access.read(request, (url) => net.fetch(url));
    const path = bundlePath(request.url, root);
    if (!path || !["GET", "HEAD"].includes(request.method))
      return new Response("Not found", { status: 404 });
    try {
      const response = await net.fetch(pathToFileURL(path).href);
      const headers = new Headers(response.headers);
      headers.set("Content-Security-Policy", csp);
      headers.set("X-Content-Type-Options", "nosniff");
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers,
      });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
}

export async function createWindow(
  show = true,
  preload = join(app.getAppPath(), "preload.cjs"),
  configure?: (window: BrowserWindow) => void,
): Promise<BrowserWindow> {
  const window = new BrowserWindow({
    title: "FIT Viewer",
    icon: join(app.getAppPath(), "dist/icons/icon-512.png"),
    width: 1366,
    height: 900,
    minWidth: 390,
    minHeight: 480,
    show: false,
    backgroundColor: "#181a1b",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload,
    },
  });
  configure?.(window);
  const openExternal = (url: string) => {
    if (externalLink(url)) void shell.openExternal(url).catch(console.error);
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!appNavigation(url)) {
      event.preventDefault();
      openExternal(url);
    }
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  await window.loadURL(APP_URL);
  if (show) window.show();
  return window;
}
