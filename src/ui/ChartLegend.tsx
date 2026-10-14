import * as Popover from "@radix-ui/react-popover";
import { ChevronDown, Files, X } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { Sensor } from "../model";
import { motionAxis } from "./chart-groups";
import { DAY_PERIODS, dayPeriodRange } from "./chart-time";
import { IconButton } from "./controls";

export interface LegendTrace {
  sensor: Sensor;
  color: string;
}

export function chartLegend(traces: LegendTrace[]) {
  const axes = new Map<string, { name: string; color: string }>();
  const files = new Map<
    number,
    { id: number; name: string; traces: { name: string; color: string }[] }
  >();
  for (const { sensor, color } of traces) {
    const axis = motionAxis(sensor);
    if (axis) axes.set(axis, { name: axis, color });
    if (sensor.source === undefined) continue;
    let file = files.get(sensor.source);
    if (!file) {
      file = {
        id: sensor.source,
        name: sensor.sourceName ?? `File ${sensor.source + 1}`,
        traces: [],
      };
      files.set(sensor.source, file);
    }
    file.traces.push({ name: axis ?? sensor.label ?? sensor.name, color });
  }
  return {
    entries: axes.size
      ? [...axes.values()]
      : files.size > 1
        ? []
        : traces.map(({ sensor, color }) => ({
            name: sensor.label ?? sensor.name,
            color,
          })),
    files: [...files.values()],
  };
}

function Swatch({ color }: { color: string }) {
  return (
    <span
      className="viewer-sensor-swatch"
      style={{ background: color }}
      aria-hidden="true"
    />
  );
}

export function ChartTraceLegend({ traces }: { traces: LegendTrace[] }) {
  const legend = useMemo(() => chartLegend(traces), [traces]);
  if (traces.length < 2) return null;
  return (
    <div className="viewer-chart-traces" aria-label="Chart series">
      {legend.entries.map((entry) => (
        <span key={entry.name}>
          <Swatch color={entry.color} />
          {entry.name}
        </span>
      ))}
      {legend.files.length > 1 && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="viewer-chart-files-button"
              type="button"
              aria-label={`Show ${legend.files.length} source files`}
            >
              <Files size={14} aria-hidden="true" />
              {legend.files.length} files
              <ChevronDown size={13} aria-hidden="true" />
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              className="viewer-chart-file-popover"
              sideOffset={6}
              collisionPadding={12}
              align="start"
              aria-label="Chart source files"
            >
              <div className="viewer-app-info-title">
                <strong>Source files ({legend.files.length})</strong>
                <Popover.Close asChild>
                  <IconButton title="Close source files">
                    <X size={16} />
                  </IconButton>
                </Popover.Close>
              </div>
              <ul>
                {legend.files.map((file) => (
                  <li key={file.id}>
                    <span className="viewer-chart-source-name">
                      {file.name}
                    </span>
                    <span className="viewer-chart-source-series">
                      {file.traces.map((trace, index) => (
                        <span key={index} title={trace.name}>
                          <Swatch color={trace.color} />
                          {trace.name}
                        </span>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}

export function ChartPeriodLegend() {
  const id = useId();
  const [active, setActive] = useState<string>();
  const hide = (name: string) =>
    setActive((current) => (current === name ? undefined : current));
  return (
    <div className="viewer-chart-period-key" aria-label="Local time of day">
      {DAY_PERIODS.slice(1).map((period) => (
        <span
          className="viewer-chart-period-item"
          key={period.name}
          data-open={active === period.name}
          onPointerEnter={() => setActive(period.name)}
          onPointerLeave={() => hide(period.name)}
        >
          <button
            type="button"
            aria-describedby={`${id}-${period.name}`}
            onFocus={() => setActive(period.name)}
            onBlur={() => hide(period.name)}
            onClick={() => setActive(period.name)}
            onKeyDown={(event) => {
              if (event.key === "Escape") setActive(undefined);
            }}
          >
            <Swatch color={period.color} />
            {period.name}
          </button>
          <span
            role="tooltip"
            className="viewer-chart-period-tooltip"
            id={`${id}-${period.name}`}
          >
            {dayPeriodRange(period.name)}
            <br />
            Local time
          </span>
        </span>
      ))}
    </div>
  );
}
