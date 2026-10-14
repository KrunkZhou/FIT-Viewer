import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, FileCheck2, RotateCw, X } from "lucide-react";
import {
  desktopPromptText,
  type DesktopPrompt,
  type DesktopPromptState,
} from "../desktop-prompts";
import { IconButton } from "./controls";

export function DesktopNotification({
  prompt,
  respond,
}: {
  prompt: DesktopPrompt;
  respond: (id: number, accepted: boolean) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const text = desktopPromptText(prompt);
  const Icon =
    prompt.kind === "association"
      ? FileCheck2
      : prompt.kind === "install"
        ? RotateCw
        : Download;
  const answer = async (accepted: boolean) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      await respond(prompt.id, accepted);
    } catch {
      setError("Could not complete this request. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="viewer-desktop-notification"
      role="dialog"
      aria-modal="false"
      aria-labelledby={`desktop-prompt-${prompt.id}`}
      aria-describedby={`desktop-prompt-detail-${prompt.id}`}
      aria-busy={busy}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        void answer(false);
      }}
    >
      <div className="viewer-notification-heading">
        <Icon size={19} aria-hidden="true" />
        <h3 id={`desktop-prompt-${prompt.id}`}>{text.title}</h3>
        <IconButton
          title={`Dismiss ${prompt.kind === "association" ? "default viewer prompt" : "update notification"}`}
          disabled={busy}
          onClick={() => void answer(false)}
        >
          <X size={16} />
        </IconButton>
      </div>
      <p id={`desktop-prompt-detail-${prompt.id}`}>{text.detail}</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="viewer-notification-actions">
        <button
          className="viewer-command"
          disabled={busy}
          onClick={() => void answer(false)}
        >
          {text.dismiss}
        </button>
        <button
          className="viewer-command viewer-notification-confirm"
          disabled={busy}
          onClick={() => void answer(true)}
        >
          <Icon size={15} aria-hidden="true" />
          {text.action}
        </button>
      </div>
    </section>
  );
}

export function DesktopNotifications() {
  const api =
    typeof window === "undefined" ? undefined : window.fitDesktop?.prompts;
  const [state, setState] = useState<DesktopPromptState>({
    revision: -1,
    prompts: [],
  });
  useEffect(() => {
    if (!api) return;
    let alive = true;
    const accept = (next: DesktopPromptState) => {
      if (alive)
        setState((current) =>
          next.revision >= current.revision ? next : current,
        );
    };
    const unsubscribe = api.onChange(accept);
    void api.getState().then(accept).catch(console.error);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [api]);
  if (!api) return null;
  return createPortal(
    <aside
      className="viewer-desktop-notifications"
      aria-label="Desktop notifications"
      aria-live="polite"
      aria-relevant="additions"
    >
      {state.prompts.map((prompt) => (
        <DesktopNotification
          key={prompt.id}
          prompt={prompt}
          respond={api.respond}
        />
      ))}
    </aside>,
    document.body,
  );
}
