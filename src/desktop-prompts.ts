export type DesktopPromptContent =
  { kind: "association" } | { kind: "install" | "download"; version: string };

export type DesktopPrompt = DesktopPromptContent & { id: number };

export interface DesktopPromptState {
  revision: number;
  prompts: DesktopPrompt[];
}

export interface DesktopPromptsApi {
  getState(): Promise<DesktopPromptState>;
  respond(id: number, accepted: boolean): Promise<void>;
  onChange(callback: (state: DesktopPromptState) => void): () => void;
}

export function desktopPromptText(prompt: DesktopPromptContent) {
  if (prompt.kind === "association")
    return {
      title: "Open FIT files with FIT Viewer?",
      detail:
        "Choose FIT Viewer for .fit files in Windows Settings. Your current default stays unchanged until you confirm it there.",
      action: "Choose default app",
      dismiss: "Not now",
    };
  const install = prompt.kind === "install";
  return {
    title: `FIT Viewer ${prompt.version} is ${install ? "ready to install" : "available"}.`,
    detail: install
      ? "Restart to finish updating. Open files and current view selections will be closed."
      : "Download the new version from GitHub and install it manually. Your current files will stay open.",
    action: install ? "Restart to update" : "Download update",
    dismiss: "Later",
  };
}
