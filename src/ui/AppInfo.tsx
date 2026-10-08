import * as Popover from "@radix-ui/react-popover";
import { ExternalLink, Github, X } from "lucide-react";
import { APP_VERSION, GITHUB_URL } from "../app-info";
import { IconButton } from "./controls";

export function AppInfoDetails() {
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
          <AppInfoDetails />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
