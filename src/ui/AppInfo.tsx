import * as Popover from "@radix-ui/react-popover";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ExternalLink,
  Github,
  LoaderCircle,
  RefreshCw,
  RotateCw,
  X,
} from "lucide-react";
import { APP_VERSION, GITHUB_URL } from "../app-info";
import type { UpdateState } from "../updates";
import { IconButton, Toggle } from "./controls";

export function UpdateSettings({
  state,
  saving,
  error,
  toggle,
  check,
  install,
}: {
  state?: UpdateState;
  saving: boolean;
  error: string;
  toggle: (enabled: boolean) => void;
  check: () => void;
  install: () => void;
}) {
  const working = state?.phase === "checking" || state?.phase === "downloading";
  const status = !state
    ? "Loading update settings..."
    : state.mode === "unavailable"
      ? "Updates require a packaged app."
      : state.phase === "checking"
        ? "Checking for updates..."
        : state.phase === "downloading"
          ? `Downloading ${state.version}: ${state.percent ?? 0}%`
          : state.phase === "ready"
            ? `Version ${state.version} is ready.`
            : state.phase === "available"
              ? `Version ${state.version} is available.`
              : state.phase === "current"
                ? "You're up to date."
                : state.phase === "error"
                  ? state.message
                  : state.enabled
                    ? "Checks automatically for new releases."
                    : "Automatic updates are off.";
  return (
    <section className="viewer-app-updates" aria-label="Desktop updates">
      <label className="viewer-update-toggle">
        Automatic updates
        <Toggle
          label="Automatic updates"
          checked={state?.enabled ?? false}
          disabled={!state || saving}
          onChange={toggle}
        />
      </label>
      <p className="viewer-update-status" role="status">
        {working && (
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
        )}
        {status}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {state?.phase === "ready" ? (
        <button
          className="viewer-command viewer-update-action"
          onClick={install}
        >
          <RotateCw size={15} /> Restart to update
        </button>
      ) : state?.phase === "available" ? (
        <a
          className="viewer-update-action"
          href={`${GITHUB_URL}/releases/tag/v${state.version}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <ExternalLink size={15} /> Download release
        </a>
      ) : (
        <button
          className="viewer-command viewer-update-action"
          disabled={!state || state.mode === "unavailable" || working || saving}
          onClick={check}
        >
          <RefreshCw size={15} /> Check for updates
        </button>
      )}
      {state?.mode === "download" && (
        <p className="viewer-update-note">
          This build requires manual installation.
        </p>
      )}
    </section>
  );
}

export function AppInfoDetails({ updates }: { updates?: ReactNode } = {}) {
  return (
    <>
      <div className="viewer-app-info-title">
        <strong>FIT Viewer</strong>
        <Popover.Close asChild>
          <IconButton title="Close app information">
            <X size={16} />
          </IconButton>
        </Popover.Close>
      </div>
      <p className="viewer-app-version">Version {APP_VERSION}</p>
      {updates}
      <a
        className="viewer-app-github"
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
      >
        <Github size={16} aria-hidden="true" />
        GitHub
        <ExternalLink size={14} aria-hidden="true" />
      </a>
    </>
  );
}

export function AppInfo() {
  const api =
    typeof window === "undefined" ? undefined : window.fitDesktop?.updates;
  const [state, setState] = useState<UpdateState>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const accept = (next: UpdateState) => {
    if (alive.current)
      setState((previous) =>
        !previous || next.revision >= previous.revision ? next : previous,
      );
  };
  useEffect(() => {
    alive.current = true;
    if (!api) return;
    const unsubscribe = api.onChange(accept);
    void api
      .getState()
      .then(accept)
      .catch(() => {
        if (alive.current) setError("Update settings are unavailable.");
      });
    return () => {
      alive.current = false;
      unsubscribe();
    };
  }, [api]);
  const run = async (
    action: () => Promise<UpdateState | void>,
    preference = false,
  ) => {
    setError("");
    if (preference) setSaving(true);
    try {
      const next = await action();
      if (next) accept(next);
    } catch {
      if (alive.current) setError("Could not complete the update request.");
    } finally {
      if (preference && alive.current) setSaving(false);
    }
  };
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="viewer-app-icon"
          title="App information"
          aria-label="App information"
        >
          <img
            src={`${import.meta.env?.BASE_URL ?? "/"}icons/icon-32.png`}
            width={32}
            height={32}
            alt=""
          />
          {(state?.phase === "available" || state?.phase === "ready") && (
            <span className="viewer-update-badge" title="Update available" />
          )}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          className="viewer-app-info"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="App information"
        >
          <AppInfoDetails
            updates={
              api && (
                <UpdateSettings
                  state={state}
                  saving={saving}
                  error={error}
                  toggle={(enabled) =>
                    void run(() => api.setEnabled(enabled), true)
                  }
                  check={() => void run(() => api.check())}
                  install={() => void run(() => api.install())}
                />
              )
            }
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
