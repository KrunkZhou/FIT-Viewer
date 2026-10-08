import { useEffect, useRef, useState, type ReactNode } from "react";

export function TableScroll({
  children,
  compact = false,
}: {
  children: ReactNode;
  compact?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const element = ref.current!;
    const update = () => {
      const left = element.scrollLeft > 1;
      const right =
        element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
      setEdges((previous) =>
        previous.left === left && previous.right === right
          ? previous
          : { left, right },
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    const table = element.querySelector("table");
    if (table) observer.observe(table);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [children]);
  return (
    <div
      className={`table-scroll-frame${compact ? " table-scroll-compact" : ""}`}
      data-left={edges.left}
      data-right={edges.right}
    >
      <div
        ref={ref}
        data-slot={compact ? undefined : "table-container"}
        className={compact ? "single-entry-table-scroll" : "table-scroll"}
        tabIndex={0}
        aria-label="Scrollable message table"
      >
        {children}
      </div>
    </div>
  );
}
