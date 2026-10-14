import {
  cloneElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
} from "react";
import { createPortal } from "react-dom";

export function ControlTooltip({
  content,
  children,
}: {
  content: string;
  children: ReactElement<{ "aria-describedby"?: string }>;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const close = () => {
    clearTimeout(timer.current);
    setOpen(false);
  };
  const show = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(true), 350);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const rect = anchor.current!.getBoundingClientRect();
    const bounds = tip.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min(innerWidth - bounds.width - 8, rect.right - bounds.width),
      ),
      top:
        rect.bottom + bounds.height + 8 < innerHeight
          ? rect.bottom + 6
          : Math.max(8, rect.top - bounds.height - 6),
    });
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open, content]);
  return (
    <span
      ref={anchor}
      className="viewer-control-tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={close}
      onFocus={show}
      onBlur={close}
      onClick={close}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          close();
        }
      }}
    >
      {cloneElement(children, {
        "aria-describedby": [children.props["aria-describedby"], id]
          .filter(Boolean)
          .join(" "),
      })}
      {open ? (
        createPortal(
          <span
            ref={tip}
            id={id}
            role="tooltip"
            className="viewer-control-tooltip"
            style={position}
          >
            {content}
          </span>,
          document.body,
        )
      ) : (
        <span id={id} hidden>
          {content}
        </span>
      )}
    </span>
  );
}
