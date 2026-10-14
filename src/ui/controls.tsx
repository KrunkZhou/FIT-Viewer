import {
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { LoaderCircle, X } from "lucide-react";
import * as Switch from "@radix-ui/react-switch";
import { ControlTooltip } from "./ControlTooltip";

export function LoadingIndicator({ label }: { label: string }) {
  return (
    <div className="viewer-loading-indicator" role="status" aria-label={label}>
      <LoaderCircle className="spin" size={28} aria-hidden="true" />
    </div>
  );
}

export function IconButton({
  title,
  children,
  tooltip,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  title: string;
  tooltip?: string;
}) {
  const button = (
    <button
      type="button"
      className="viewer-icon-button"
      title={tooltip ? undefined : title}
      aria-label={title}
      {...props}
    >
      {children}
    </button>
  );
  return tooltip ? (
    <ControlTooltip content={tooltip}>{button}</ControlTooltip>
  ) : (
    button
  );
}
export function Toggle({
  label,
  checked,
  onChange,
  descriptionId,
  disabled,
  tooltip,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  descriptionId?: string;
  disabled?: boolean;
  tooltip?: string;
}) {
  const control = (
    <Switch.Root
      className="toggle"
      aria-label={label}
      aria-describedby={descriptionId}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
    >
      <Switch.Thumb />
    </Switch.Root>
  );
  return tooltip ? (
    <ControlTooltip content={tooltip}>{control}</ControlTooltip>
  ) : (
    control
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const invoker = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (invoker instanceof HTMLElement && invoker.isConnected)
        invoker.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="viewer-dialog viewer-csv-dialog"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
    >
      <div className="modal-heading">
        <h2>{title}</h2>
        <IconButton title="Close" onClick={onClose}>
          <X size={18} />
        </IconButton>
      </div>
      {children}
    </dialog>
  );
}
export function readPreference<T>(
  key: string,
  fallback: T,
  check: (value: unknown) => value is T,
): T {
  try {
    const text = localStorage.getItem(key);
    let stored: unknown;
    try {
      stored = JSON.parse(text ?? "null");
    } catch {
      stored = text;
    }
    return check(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Viewing files remains available when storage is disabled. */
  }
}
export function navigateTabs(event: KeyboardEvent<HTMLElement>): void {
  if (
    ![
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ].includes(event.key)
  )
    return;
  const tabs = Array.from(
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  ).filter((tab) => tab.getBoundingClientRect().width > 0);
  const index = tabs.findIndex((tab) => tab === document.activeElement);
  if (index === -1 || !tabs.length) return;
  event.preventDefault();
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index +
            (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
            tabs.length) %
          tabs.length;
  tabs[next].click();
  tabs[next].focus();
}
