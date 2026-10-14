import * as Popover from "@radix-ui/react-popover";
import {
  ChevronDown,
  ChevronUp,
  Download,
  FileJson2,
  MapPin,
  Table2,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ExportQuery, MapPlaybackPosition, TimeRange } from "../model";
import { formatTimestamp } from "../protocol/time";
import { ControlTooltip } from "./ControlTooltip";
import { IconButton } from "./controls";
import {
  mapTimeFromProgress,
  type MapTimeRange,
  type MapTimelineSegment,
} from "./map-playback";

export function MapExportFormats({
  download,
  dates,
  withLaps,
}: {
  download: (query: ExportQuery) => void;
  dates: TimeRange;
  withLaps: boolean;
}) {
  return (
    <div className="viewer-map-export-formats">
      <Popover.Close asChild>
        <button
          type="button"
          className="viewer-command"
          onClick={() => download({ format: "gpx", withLaps, dates })}
        >
          <Download size={17} aria-hidden="true" /> GPX
        </button>
      </Popover.Close>
      <Popover.Close asChild>
        <button
          type="button"
          className="viewer-command"
          onClick={() => download({ format: "geojson", dates })}
        >
          <FileJson2 size={17} aria-hidden="true" /> GeoJSON
        </button>
      </Popover.Close>
    </div>
  );
}

export function MapDownloads({
  disabled,
  ...props
}: Parameters<typeof MapExportFormats>[0] & { disabled: boolean }) {
  return (
    <Popover.Root>
      <ControlTooltip content="Download GPS data for the selected dates">
        <Popover.Trigger asChild>
          <button
            type="button"
            className="viewer-icon-button"
            aria-label="Download GPS data"
            disabled={disabled}
          >
            <Download size={18} aria-hidden="true" />
          </button>
        </Popover.Trigger>
      </ControlTooltip>
      <Popover.Portal>
        <Popover.Content
          className="viewer-map-export-popup"
          aria-label="GPS download format"
          align="end"
          sideOffset={8}
          collisionPadding={12}
        >
          <MapExportFormats {...props} />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function MapTimeline({
  range,
  progress,
  segments,
  position,
  routeName,
  color,
  error,
  onTimeChange,
  onGoToData,
  canGoToData,
}: {
  range: MapTimeRange;
  progress: number;
  segments: MapTimelineSegment[];
  position?: MapPlaybackPosition | null;
  routeName?: string;
  color: string;
  error: string;
  onTimeChange: (time: number | undefined) => void;
  onGoToData: (record: number) => void;
  canGoToData: boolean;
}) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const dock = useRef<HTMLDivElement>(null);
  const focusAfterToggle = useRef(false);
  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    dock.current
      ?.querySelector<HTMLButtonElement>(
        collapsed ? ".viewer-map-playback-show" : ".viewer-map-playback-hide",
      )
      ?.focus({ preventScroll: true });
  }, [collapsed]);
  const toggle = () => {
    focusAfterToggle.current = true;
    setCollapsed((value) => !value);
  };
  const sample = position
    ? `GPS sample: ${formatTimestamp(position.time)} · ${position.lat.toFixed(5)}, ${position.lon.toFixed(5)}`
    : "Locating GPS sample...";
  return (
    <div
      ref={dock}
      className="viewer-map-playback-dock"
      data-collapsed={collapsed}
    >
      <div
        id={id}
        className="viewer-map-playback"
        aria-label="GPS timeline"
        aria-hidden={collapsed}
        inert={collapsed}
      >
        <div className="viewer-map-playback-heading">
          <MapPin size={16} aria-hidden="true" />
          <span className="viewer-map-playback-sample">
            {position ? (
              <>
                GPS sample: <time>{formatTimestamp(position.time)}</time> ·{" "}
                <span className="viewer-map-coordinates">
                  {position.lat.toFixed(5)}, {position.lon.toFixed(5)}
                </span>
              </>
            ) : (
              sample
            )}
          </span>
          {routeName && (
            <span className="viewer-map-current-route" title={routeName}>
              {routeName}
            </span>
          )}
          <div className="viewer-map-playback-actions">
            <IconButton
              title="Go to data"
              tooltip={
                canGoToData
                  ? "Open this GPS sample in the Record message table"
                  : "Waiting for the selected GPS sample"
              }
              disabled={!position || !canGoToData}
              onClick={() => {
                if (position && canGoToData) onGoToData(position.record);
              }}
            >
              <Table2 size={18} />
            </IconButton>
            <IconButton
              className="viewer-icon-button viewer-map-playback-hide"
              title="Hide GPS timeline"
              tooltip="Slide the GPS timeline out of view"
              aria-expanded={!collapsed}
              aria-controls={id}
              onClick={toggle}
            >
              <ChevronDown size={18} />
            </IconButton>
          </div>
        </div>
        <div
          className="viewer-map-time-slider"
          style={{ "--map-time-color": color } as CSSProperties}
        >
          <div className="viewer-map-time-track" aria-hidden="true">
            {segments.map((segment) => (
              <span
                key={segment.start}
                className="viewer-map-time-segment"
                style={{
                  left: `${segment.start}%`,
                  width: `${segment.end - segment.start}%`,
                  background: segment.colors.length
                    ? `linear-gradient(to bottom, ${segment.colors
                        .flatMap((color, index) => [
                          `${color} ${(index * 100) / segment.colors.length}%`,
                          `${color} ${((index + 1) * 100) / segment.colors.length}%`,
                        ])
                        .join(", ")})`
                    : "transparent",
                }}
              />
            ))}
          </div>
          <input
            type="range"
            aria-label="Map time"
            aria-valuetext={`${sample}${routeName ? `, ${routeName}` : ""}`}
            title="Move through visible route time ranges, skipping gaps between routes. Positions use the nearest recorded GPS sample."
            min={0}
            max={range.length}
            step="any"
            value={progress}
            disabled={range.start === range.end}
            onChange={(event) =>
              onTimeChange(
                mapTimeFromProgress(Number(event.target.value), range),
              )
            }
          />
        </div>
        <div className="viewer-map-playback-ends">
          <time>{formatTimestamp(range.start)}</time>
          <time>{formatTimestamp(range.end)}</time>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
      {collapsed && (
        <div className="viewer-map-playback-restore">
          <IconButton
            className="viewer-icon-button viewer-map-playback-show"
            title="Show GPS timeline"
            tooltip="Show the GPS timeline"
            aria-expanded={false}
            aria-controls={id}
            onClick={toggle}
          >
            <ChevronUp size={18} />
          </IconButton>
        </div>
      )}
    </div>
  );
}
