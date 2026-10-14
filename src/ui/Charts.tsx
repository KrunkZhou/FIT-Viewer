import { useEffect, useMemo, useRef, useState } from "react";
import { CheckSquare2, Download, Search, Square, ZoomOut } from "lucide-react";
import {
  CartesianGrid,
  Customized,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ChartData,
  ChartDetail,
  ChartPoint,
  ExportQuery,
  Sensor,
  TimeRange,
} from "../model";
import { DateRangeFilter } from "./DateRangeFilter";
import type { DocumentClient } from "../document/client";
import {
  IconButton,
  LoadingIndicator,
  Toggle,
  readPreference,
  savePreference,
} from "./controls";
import {
  chartMemberKeys,
  chartLines,
  groupMotionAxes,
  groupSensors,
  motionAxis,
} from "./chart-groups";
import {
  chartTick,
  chartTimeDomain,
  chartTimeTicks,
  chartTimeline,
  chartTimeLabel,
  dayPeriodRange,
  dividerDate,
  type ChartTimeDomain,
  type ChartTimeline,
} from "./chart-time";
import { ChartPeriodLegend, ChartTraceLegend } from "./ChartLegend";
import { ChartHoverStore } from "./chart-hover";
import { ChartHoverCursor } from "./ChartHoverCursor";
import {
  ChartDetailButton,
  ReferenceValuesButton,
  ValueFilterButton,
  parseReferenceValues,
} from "./ChartControls";

const COLORS = [
  "#176856",
  "#397ad1",
  "#c74662",
  "#9765b8",
  "#b57b0b",
  "#258b93",
  "#817164",
];
function sensorColor(sensor: Sensor): string {
  const axis = motionAxis(sensor);
  if (axis) return { X: COLORS[2], Y: COLORS[0], Z: COLORS[1] }[axis];
  let hash = 0;
  for (const character of sensor.key)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}
function Plot({
  sensor,
  points,
  traces,
  lines,
  color,
  references,
  onZoom,
  active,
  width,
  timeScale,
  hoverStore,
}: {
  sensor: Sensor;
  points: ChartPoint[];
  traces: { sensor: Sensor; points: ChartPoint[]; color: string }[];
  lines: ReturnType<typeof chartLines>;
  color: string;
  references: number[];
  onZoom: (start: number, end: number) => void;
  active: boolean;
  width: number;
  hoverStore: ChartHoverStore;
  timeScale?: {
    domain: ChartTimeDomain;
    ticks: number[];
    timeline: ChartTimeline;
  };
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<[number, number]>();
  const timeline = useMemo(
    () => timeScale?.timeline ?? chartTimeline(points, sensor.axis),
    [points, sensor.axis, timeScale],
  );
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  return (
    <section className="viewer-sensor-plot">
      <h3>
        <span className="viewer-sensor-swatch" style={{ background: color }} />
        {sensor.name}
        <span className="viewer-muted">{sensor.units}</span>
      </h3>
      <ChartTraceLegend traces={traces} />
      {timeline.periods.length > 0 && <ChartPeriodLegend />}
      <div className="viewer-chart-canvas" ref={ref}>
        {visible && active && (
          <ResponsiveContainer>
            <LineChart
              data={points}
              margin={{
                top: timeline.midnights.length
                  ? 44
                  : timeline.periods.length
                    ? 24
                    : 5,
                right: 15,
                bottom: 5,
                left: 5,
              }}
              onMouseDown={(event) => {
                const label = event?.activeLabel;
                if (label !== undefined && Number.isFinite(Number(label)))
                  setDrag([Number(label), Number(label)]);
              }}
              onMouseMove={(event) => {
                if (drag && event?.activeLabel !== undefined)
                  setDrag([drag[0], Number(event.activeLabel)]);
                if (timeScale)
                  hoverStore.update(
                    event?.activeLabel,
                    Boolean(event?.isTooltipActive),
                    timeScale.domain,
                  );
              }}
              onMouseEnter={(event) => {
                if (timeScale)
                  hoverStore.update(
                    event?.activeLabel,
                    Boolean(event?.isTooltipActive),
                    timeScale.domain,
                  );
              }}
              onMouseLeave={() => {
                if (timeScale) hoverStore.clear();
              }}
              onMouseUp={() => {
                if (drag && drag[0] !== drag[1])
                  onZoom(Math.min(...drag), Math.max(...drag));
                setDrag(undefined);
              }}
            >
              {timeline.periods.map((period) => (
                <ReferenceArea
                  key={`period-${period.start}`}
                  x1={period.start}
                  x2={period.end}
                  fill={period.color}
                  fillOpacity={0.08}
                  stroke="none"
                  label={({ viewBox }) => {
                    if (
                      !viewBox ||
                      !("width" in viewBox) ||
                      (viewBox.width ?? 0) < 68
                    )
                      return <g />;
                    return (
                      <text
                        className="viewer-chart-period"
                        x={(viewBox.x ?? 0) + (viewBox.width ?? 0) / 2}
                        y={(viewBox.y ?? 0) - 8}
                        textAnchor="middle"
                        fill="var(--viewer-muted)"
                        fontSize={11}
                      >
                        <title>{`${period.name}: ${dayPeriodRange(period.name)} (local time)`}</title>
                        {period.name}
                      </text>
                    );
                  }}
                />
              ))}
              <CartesianGrid
                stroke="var(--viewer-border)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="time"
                type="number"
                allowDuplicatedCategory={false}
                domain={timeScale?.domain ?? ["dataMin", "dataMax"]}
                ticks={timeScale?.ticks}
                allowDataOverflow={Boolean(timeScale)}
                height={timeline.multipleDates ? 46 : 30}
                minTickGap={24}
                tick={({ x, y, payload }) => {
                  const label =
                    sensor.axis === "sample"
                      ? { time: String(payload.value), date: undefined }
                      : chartTick(Number(payload.value), timeline);
                  return (
                    <text
                      x={x}
                      y={y}
                      textAnchor="middle"
                      fill="var(--viewer-muted)"
                      fontSize={11}
                    >
                      <tspan x={x} dy={12}>
                        {label.time}
                      </tspan>
                      {label.date && (
                        <tspan className="viewer-chart-date" x={x} dy={15}>
                          {label.date}
                        </tspan>
                      )}
                    </text>
                  );
                }}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "var(--viewer-muted)", fontSize: 11 }}
                width={52}
              />
              <Tooltip
                cursor={!timeScale}
                contentStyle={{
                  background: "var(--viewer-popup)",
                  borderColor: "var(--viewer-border)",
                }}
                labelFormatter={(value) =>
                  sensor.axis === "sample"
                    ? `Sample ${value}`
                    : chartTimeLabel(Number(value))
                }
                formatter={(value, name, item) => [
                  value,
                  item.payload?.sourceName
                    ? `${name} · ${item.payload.sourceName}`
                    : name,
                ]}
              />
              {timeline.midnights.map((time, index) => (
                <ReferenceLine
                  key={`midnight-${time}`}
                  className="viewer-chart-midnight"
                  x={time}
                  stroke="var(--viewer-muted)"
                  strokeWidth={1.5}
                  strokeDasharray="6 3"
                  label={({ viewBox }) => {
                    const stride = Math.max(
                      1,
                      Math.ceil(
                        (timeline.midnights.length * 84) /
                          Math.max(1, width - 72),
                      ),
                    );
                    if (!viewBox || !("x" in viewBox) || index % stride !== 0)
                      return <g />;
                    const x = viewBox.x ?? 0;
                    const date = dividerDate(time, timeline.multipleYears);
                    return (
                      <text
                        className="viewer-chart-divider-date"
                        x={x < 96 ? x + 4 : x - 4}
                        y={(viewBox.y ?? 0) - 28}
                        textAnchor={x < 96 ? "start" : "end"}
                        fontSize={11}
                        fontWeight={600}
                        fill="var(--viewer-foreground)"
                      >
                        {date}
                      </text>
                    );
                  }}
                />
              ))}
              {lines.map((trace) => (
                <Line
                  key={trace.sensor.key}
                  data={trace.points}
                  type="linear"
                  dataKey="value"
                  name={trace.sensor.name}
                  stroke={trace.color}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
              ))}
              {references.map((value, i) => (
                <ReferenceLine
                  key={`reference-${i}`}
                  y={value}
                  stroke="var(--viewer-muted)"
                  strokeDasharray="4 4"
                />
              ))}
              {timeScale && (
                <Customized
                  component={
                    <ChartHoverCursor
                      store={hoverStore}
                      domain={timeScale.domain}
                    />
                  }
                />
              )}
              {drag && (
                <ReferenceArea
                  x1={Math.min(...drag)}
                  x2={Math.max(...drag)}
                  strokeOpacity={0.3}
                  fill={color}
                  fillOpacity={0.15}
                />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </section>
  );
}
export default function Charts({
  client,
  developer,
  download,
  active,
  dates,
  onDatesChange,
  availableDates,
}: {
  client: DocumentClient;
  developer: boolean;
  download: (query: ExportQuery) => void;
  active: boolean;
  dates: TimeRange;
  onDatesChange: (dates: TimeRange) => void;
  availableDates?: string[];
}) {
  const [data, setData] = useState<ChartData>();
  const [selected, setSelected] = useState<string[]>(
    readPreference(
      "chartSensors",
      [],
      (v): v is string[] =>
        Array.isArray(v) && v.every((x) => typeof x === "string"),
    ),
  );
  const [search, setSearch] = useState("");
  const [combineXYZ, setCombineXYZ] = useState(
    readPreference(
      "chartCombineXYZ",
      true,
      (v): v is boolean => typeof v === "boolean",
    ),
  );
  const [syncTime, setSyncTime] = useState(
    readPreference(
      "chartSyncTime",
      true,
      (v): v is boolean => typeof v === "boolean",
    ),
  );
  const hoverStore = useMemo(() => new ChartHoverStore(), []);
  const [detail, setDetail] = useState(
    readPreference(
      "chartDetail",
      "high" as ChartDetail,
      (v): v is ChartDetail =>
        v === "standard" || v === "high" || v === "maximum",
    ),
  );
  const [range, setRange] = useState<{ start?: number; end?: number }>({});
  const [filter, setFilter] = useState<{ min?: number; max?: number }>({});
  const [reference, setReference] = useState("");
  const [width, setWidth] = useState<number>();
  const queryWidth =
    width === undefined ? undefined : Math.ceil(width / 128) * 128;
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const groups = useMemo(
    () => groupSensors(data?.sensors ?? []),
    [data?.sensors],
  );
  const members = chartMemberKeys(groups, selected);
  const memberSelection = JSON.stringify(members.length ? members : selected);
  const plots = useMemo(
    () =>
      groupMotionAxes(
        groups.filter((group) => selected.includes(group.sensor.key)),
        combineXYZ,
      )
        .map((group) => {
          const traces = group.members.map((member) => ({
            sensor: member,
            points: data?.series[member.key] ?? [],
            color: sensorColor({ ...member, key: group.sensor.key }),
          }));
          const lines = chartLines(traces);
          return {
            sensor: group.sensor,
            traces,
            lines,
            points:
              lines.length > 1
                ? lines
                    .flatMap((trace) => trace.points)
                    .sort((a, b) => a.time - b.time)
                : lines[0].points,
          };
        })
        .filter((plot) => plot.points.some((point) => point.value !== null)),
    [groups, selected, combineXYZ, data?.series],
  );
  const timeScale = useMemo(() => {
    if (!syncTime) return undefined;
    const domain = chartTimeDomain(plots, range);
    if (!domain) return undefined;
    return {
      domain,
      ticks: chartTimeTicks(domain, width ?? 640),
      timeline: chartTimeline([], "time", domain),
    };
  }, [syncTime, plots, range, width]);
  useEffect(() => {
    hoverStore.clear();
  }, [hoverStore, timeScale, active, client]);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width > 0)
        setWidth(Math.max(1, Math.round(entry.contentRect.width)));
    });
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setRange({});
  }, [dates]);
  useEffect(() => {
    if (!active || queryWidth === undefined) return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    client
      .request<ChartData>(
        {
          kind: "chart",
          query: {
            sensors: JSON.parse(memberSelection) as string[],
            width: queryWidth,
            detail,
            developer,
            ...range,
            filter,
            dates,
          },
        },
        controller.signal,
      )
      .then((next) => {
        if (controller.signal.aborted) return;
        setData(next);
        setError("");
        const nextGroups = groupSensors(next.sensors);
        const keep = nextGroups
          .filter(
            (group) =>
              selected.includes(group.sensor.key) ||
              group.members.some((sensor) => selected.includes(sensor.key)),
          )
          .map((group) => group.sensor.key);
        if (!initialized.current) {
          initialized.current = true;
          const defaults = nextGroups
            .map((group) => group.sensor)
            .filter((s) =>
              ["20:3", "20:6", "20:2"].includes(
                `${s.message ?? s.key.split(":")[0]}:${s.field ?? s.key.split(":")[1]}`,
              ),
            )
            .map((s) => s.key);
          const initial = keep.length
            ? keep
            : defaults.length
              ? defaults
              : nextGroups.slice(0, 2).map((group) => group.sensor.key);
          if (
            initial.length !== selected.length ||
            initial.some((key, index) => key !== selected[index])
          )
            setSelected(initial);
        } else if (
          keep.length !== selected.length ||
          keep.some((key, index) => key !== selected[index])
        )
          setSelected(keep);
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== "AbortError")
          setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [
    client,
    selected,
    memberSelection,
    queryWidth,
    detail,
    developer,
    range,
    filter,
    active,
    dates,
  ]);
  const change = (values: string[]) => {
    initialized.current = true;
    setSelected(values);
    savePreference("chartSensors", values);
  };
  const available = groups
    .map((group) => group.sensor)
    .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const references = useMemo(
    () => parseReferenceValues(reference),
    [reference],
  );
  return (
    <div className="viewer-chart-workspace">
      <aside className="viewer-sensor-sidebar">
        <div className="viewer-sensor-heading">
          <h2>
            Sensors <span className="viewer-muted">{selected.length}</span>
          </h2>
          <IconButton
            title="Select visible sensors"
            tooltip="Select all sensors matching the sidebar search"
            onClick={() =>
              change(
                Array.from(
                  new Set([...selected, ...available.map((s) => s.key)]),
                ),
              )
            }
          >
            <CheckSquare2 size={16} />
          </IconButton>
          <IconButton
            title="Clear sensors"
            tooltip="Deselect all chart sensors"
            onClick={() => change([])}
          >
            <Square size={16} />
          </IconButton>
        </div>
        <label className="viewer-sensor-search">
          <Search size={15} />
          <input
            aria-label="Find sensors"
            placeholder="Find sensors..."
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <div className="viewer-sensor-list">
          {available.map((sensor) => (
            <label
              className="viewer-sensor-option"
              title={`${sensor.name}\n${sensor.pointCount?.toLocaleString() ?? "0"} valid data points (before downsampling)`}
              data-selected={selected.includes(sensor.key)}
              key={sensor.key}
            >
              <input
                type="checkbox"
                checked={selected.includes(sensor.key)}
                onChange={(event) =>
                  change(
                    event.target.checked
                      ? [...selected, sensor.key]
                      : selected.filter((key) => key !== sensor.key),
                  )
                }
              />
              <span
                className="viewer-sensor-swatch"
                style={{ background: sensorColor(sensor) }}
              />
              <span className="viewer-sensor-name">{sensor.name}</span>
              <span className="viewer-muted">{sensor.units}</span>
            </label>
          ))}
        </div>
      </aside>
      <div className="viewer-chart-content" ref={content} aria-busy={loading}>
        <div className="viewer-chart-toolbar">
          <h2 className="viewer-section-title">Activity charts</h2>
          <label className="viewer-chart-combine">
            Combine XYZ
            <Toggle
              label="Combine XYZ"
              tooltip="Overlay matching accelerometer or gyroscope X, Y and Z axes on one chart. Different units stay separate."
              checked={combineXYZ}
              onChange={(checked) => {
                setCombineXYZ(checked);
                savePreference("chartCombineXYZ", checked);
              }}
            />
          </label>
          <label className="viewer-chart-combine">
            Sync time
            <Toggle
              label="Sync time"
              tooltip="Align time ranges, ticks, date dividers and hover cursors across all charts. Sample-index charts stay independent."
              checked={syncTime}
              onChange={(checked) => {
                setSyncTime(checked);
                savePreference("chartSyncTime", checked);
              }}
            />
          </label>
          <ReferenceValuesButton value={reference} onChange={setReference} />
          <ValueFilterButton value={filter} onChange={setFilter} />
          <ChartDetailButton
            value={detail}
            onChange={(next) => {
              setDetail(next);
              savePreference("chartDetail", next);
            }}
          />
          <DateRangeFilter
            value={dates}
            onChange={onDatesChange}
            availableDates={availableDates}
          />
          <IconButton
            title="Reset zoom"
            tooltip="Reset chart zoom within the selected dates"
            onClick={() => setRange({})}
            disabled={range.start === undefined && range.end === undefined}
          >
            <ZoomOut size={17} />
          </IconButton>
          <IconButton
            title="Download chart JSON"
            tooltip="Download selected sensors at full resolution for the selected dates"
            onClick={() =>
              download({
                format: "json",
                developer,
                sensors: chartMemberKeys(groups, selected),
                dates,
              })
            }
            disabled={!selected.length || !groups.length}
          >
            <Download size={17} />
          </IconButton>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="viewer-loading-region">
          {loading && <LoadingIndicator label="Loading chart data" />}
          <div className="viewer-chart-plots">
            {plots.map(({ sensor, traces, lines, points }) => {
              return (
                <Plot
                  width={width ?? 640}
                  active={active}
                  sensor={sensor}
                  points={points}
                  timeScale={sensor.axis === "sample" ? undefined : timeScale}
                  hoverStore={hoverStore}
                  traces={traces}
                  lines={lines}
                  color={sensorColor(sensor)}
                  references={references}
                  onZoom={(start, end) => setRange({ start, end })}
                  key={sensor.key}
                />
              );
            })}
            {!loading && !error && !selected.length && (
              <p className="viewer-muted empty-table">No sensors selected.</p>
            )}
            {!loading && !error && selected.length > 0 && !plots.length && (
              <p className="viewer-muted empty-table">
                No data matches the selected dates and filters.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
