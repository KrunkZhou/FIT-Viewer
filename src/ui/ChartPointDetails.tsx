import { useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import * as Popover from "@radix-ui/react-popover";
import type { TooltipProps } from "recharts";
import type { ChartPoint, RecordTarget, Sensor } from "../model";
import { chartTimeLabel } from "./chart-time";
import { GoToDataButton } from "./controls";
import {
  ChartLineCoverage,
  chartTooltipPosition,
  type PlottedLine,
} from "./chart-tooltip-layout";

export function chartPointTarget(
  sensor: Sensor,
  point?: ChartPoint,
): RecordTarget | undefined {
  const message = sensor.message ?? Number(sensor.key.split(":")[0]);
  if (
    !point ||
    point.value === null ||
    !Number.isFinite(point.value) ||
    !Number.isSafeInteger(point.record) ||
    point.record! < 0 ||
    !Number.isInteger(message) ||
    message < 0 ||
    message > 65535
  )
    return;
  return { message, record: point.record! };
}

export function ChartActivePoint({
  cx,
  cy,
  fill,
  payload,
  sensor,
}: {
  cx?: number;
  cy?: number;
  fill?: string;
  payload?: ChartPoint;
  sensor: Sensor;
}) {
  const target = chartPointTarget(sensor, payload);
  return (
    <circle
      className="viewer-chart-active-point"
      cx={cx}
      cy={cy}
      r={4}
      fill={fill}
      stroke="#fff"
      strokeWidth={2}
      data-record={target?.record}
      data-message={target?.message}
    />
  );
}

type ReadoutProps = TooltipProps<
  number | string | (number | string)[],
  number | string
> & {
  axis: Sensor["axis"];
};

export function ChartReadout({ active, payload, label, axis }: ReadoutProps) {
  const entries = payload?.filter(
    (item) => item.value != null && item.type !== "none",
  );
  if (!active || !entries?.length) return null;
  return (
    <div className="viewer-chart-readout-content" role="tooltip">
      <strong>
        {axis === "sample" ? `Sample ${label}` : chartTimeLabel(Number(label))}
      </strong>
      {entries.map((item, index) => {
        const point = item.payload as ChartPoint | undefined;
        const name = `${item.name}${point?.sourceName ? ` · ${point.sourceName}` : ""}`;
        return (
          <span key={index} style={{ color: item.color }}>
            {name}: <b>{String(item.value)}</b>
          </span>
        );
      })}
    </div>
  );
}

export function ChartTooltipGeometry({
  coverage,
  formattedGraphicalItems,
  offset,
}: {
  coverage: ChartLineCoverage;
  formattedGraphicalItems?: {
    props: { points?: PlottedLine["points"] };
    item: { props: { hide?: boolean; connectNulls?: boolean } };
  }[];
  offset?: { left: number; top: number; width: number; height: number };
}) {
  useLayoutEffect(() => {
    if (!offset) return;
    coverage.update(
      (formattedGraphicalItems ?? []).flatMap(({ props, item }) =>
        props.points && !item.props.hide
          ? [
              {
                points: props.points,
                connectNulls: Boolean(item.props.connectNulls),
              },
            ]
          : [],
      ),
      {
        x: offset.left,
        y: offset.top,
        width: offset.width,
        height: offset.height,
      },
    );
  }, [coverage, formattedGraphicalItems, offset]);
  return null;
}

export function ChartPointTooltip({
  container,
  coverage,
  ...props
}: ReadoutProps & {
  container: HTMLDivElement | null;
  coverage: ChartLineCoverage;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const tooltip = ref.current;
    if (!container || !tooltip) return;
    const bounds = container.getBoundingClientRect();
    const heading = container
      .closest(".viewer-sensor-plot")
      ?.getBoundingClientRect();
    const viewport = container
      .closest(".viewer-chart-plots")
      ?.getBoundingClientRect();
    const headroom = Math.max(
      0,
      bounds.top -
        Math.max(heading?.top ?? bounds.top, viewport?.top ?? 0, 0) -
        8,
    );
    const points = Array.from(
      container.querySelectorAll(".viewer-chart-active-point"),
      (point) => {
        const box = point.getBoundingClientRect();
        return {
          x: box.left + box.width / 2 - bounds.left,
          y: box.top + box.height / 2 - bounds.top,
        };
      },
    );
    const position = chartTooltipPosition(
      bounds,
      { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
      { x: props.coordinate?.x ?? 0, y: props.coordinate?.y ?? 0 },
      points,
      coverage,
      headroom,
    );
    tooltip.style.transform = `translate(${position.x}px, ${position.y}px)`;
    tooltip.style.visibility = "visible";
  });
  return container && props.active && props.payload?.length
    ? createPortal(
        <div className="viewer-chart-tooltip" ref={ref}>
          <ChartReadout {...props} />
        </div>,
        container,
      )
    : null;
}

export interface ChartPointMenuState {
  x: number;
  y: number;
  target: RecordTarget;
}

export function chartPointAt(
  container: HTMLElement,
  x?: number,
  y?: number,
): ChartPointMenuState | undefined {
  let nearest: ChartPointMenuState | undefined;
  let distance = 24 ** 2;
  for (const point of container.querySelectorAll<SVGCircleElement>(
    ".viewer-chart-active-point[data-record][data-message]",
  )) {
    const bounds = point.getBoundingClientRect();
    if (!bounds.width || !bounds.height) continue;
    const px = bounds.left + bounds.width / 2;
    const py = bounds.top + bounds.height / 2;
    const delta =
      x === undefined || y === undefined ? 0 : (px - x) ** 2 + (py - y) ** 2;
    if (delta > distance) continue;
    nearest = {
      x: x ?? px,
      y: y ?? py,
      target: {
        message: Number(point.dataset.message),
        record: Number(point.dataset.record),
      },
    };
    distance = delta;
    if (x === undefined) break;
  }
  return nearest;
}

export function ChartPointMenu({
  menu,
  close,
  onGoToData,
  restoreFocus,
}: {
  menu: ChartPointMenuState | undefined;
  close: () => void;
  onGoToData: (target: RecordTarget) => void;
  restoreFocus: () => void;
}) {
  const anchor = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () =>
          new DOMRect(menu?.x ?? 0, menu?.y ?? 0, 0, 0),
      },
    }),
    [menu?.x, menu?.y],
  );
  return (
    <Popover.Root
      open={Boolean(menu)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Popover.Anchor virtualRef={anchor} />
      <Popover.Portal>
        <Popover.Content
          role="menu"
          aria-label="Chart point actions"
          className="viewer-chart-point-menu"
          align="start"
          sideOffset={4}
          collisionPadding={8}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={restoreFocus}
          onKeyDown={(event) => {
            if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
              event.preventDefault();
              event.currentTarget
                .querySelector<HTMLButtonElement>("button")
                ?.focus();
            }
          }}
        >
          {menu && (
            <GoToDataButton
              role="menuitem"
              target={menu.target}
              onGoToData={(target) => {
                close();
                onGoToData(target);
              }}
            />
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
