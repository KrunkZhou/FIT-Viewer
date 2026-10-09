import { gt, valid } from "semver";
import { CancellationToken, NsisUpdater } from "electron-updater";
import type { UpdateBackend } from "./update-controller";

export function stableUpdate(
  release: unknown,
  current: string,
): string | undefined {
  if (!release || typeof release !== "object")
    throw new Error("Invalid release response.");
  const value = release as {
    draft?: unknown;
    prerelease?: unknown;
    tag_name?: unknown;
  };
  if (
    value.draft !== false ||
    value.prerelease !== false ||
    typeof value.tag_name !== "string"
  )
    return;
  const version = value.tag_name.slice(1);
  if (
    !/^v\d+\.\d+\.\d+$/.test(value.tag_name) ||
    valid(version) !== version ||
    !valid(current)
  )
    return;
  return gt(version, current) ? version : undefined;
}

export function updateMode(
  platform: string,
  packaged: boolean,
  portable: boolean,
) {
  if (!packaged) return "unavailable" as const;
  return platform === "win32" && !portable
    ? ("install" as const)
    : ("download" as const);
}

export function createUpdateBackend(
  platform: string,
  packaged: boolean,
  portable: boolean,
  version: string,
): UpdateBackend {
  const mode = updateMode(platform, packaged, portable);
  if (mode !== "install")
    return {
      mode,
      async check(signal) {
        const response = await fetch(
          "https://api.github.com/repos/KrunkZhou/FIT-Viewer/releases/latest",
          {
            signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
            headers: {
              Accept: "application/vnd.github+json",
              "User-Agent": `FIT-Viewer/${version}`,
            },
          },
        );
        if (response.status === 404) return {};
        if (!response.ok) throw new Error("Release check failed.");
        return { version: stableUpdate(await response.json(), version) };
      },
      install() {
        throw new Error("Download this release from GitHub.");
      },
    };
  const updater = new NsisUpdater({
    provider: "github",
    owner: "KrunkZhou",
    repo: "FIT-Viewer",
    private: false,
  });
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableWebInstaller = true;
  // The check/download promises report errors; always consume EventEmitter errors too.
  updater.on("error", () => {});
  return {
    mode,
    async check(signal, progress) {
      signal.throwIfAborted();
      const result = await updater.checkForUpdates();
      signal.throwIfAborted();
      if (!result) throw new Error("Updater is unavailable.");
      if (!result.isUpdateAvailable) return {};
      const next = stableUpdate(
        {
          tag_name: `v${result.updateInfo.version}`,
          draft: false,
          prerelease: false,
        },
        version,
      );
      if (!next) return {};
      const cancellation = result.cancellationToken ?? new CancellationToken();
      const abort = () => cancellation.cancel();
      const report = ({ percent }: { percent: number }) =>
        progress(next, percent);
      signal.addEventListener("abort", abort, { once: true });
      updater.on("download-progress", report);
      progress(next, 0);
      try {
        await updater.downloadUpdate(cancellation);
        signal.throwIfAborted();
        return { version: next, ready: true };
      } finally {
        signal.removeEventListener("abort", abort);
        updater.off("download-progress", report);
      }
    },
    install() {
      updater.quitAndInstall(false, true);
    },
  };
}
