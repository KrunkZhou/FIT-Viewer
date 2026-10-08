import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckSquare2,
  Download,
  RotateCcw,
  Search,
  Square,
  ZoomOut,
} from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ChartData, ChartPoint, ExportQuery, Sensor } from "../model";
import type { DocumentClient } from "../document/client";
import { IconButton, readPreference, savePreference } from "./controls";
import { chartMemberKeys, groupSensors } from "./chart-groups";

const COLORS = [
  "#176856",
  "#397ad1",
  "#c74662",
  "#9765b8",
  "#b57b0b",
  "#258b93",
  "#817164",
];
function sensorColor(key: string): string {
  let hash = 0;
  for (const character of key)
    hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}
function Plot({
  sensor,
  points,
  traces,
  color,
  references,
  onZoom,
  active,
}: {
  sensor: Sensor;
  points: ChartPoint[];
  traces: { sensor: Sensor; points: ChartPoint[]; color: string }[];
  color: string;
  references: number[];
  onZoom: (start: number, end: number) => void;
  active: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [drag, setDrag] = useState<[number, number]>();
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
      {traces.length > 1 && (
        <div className="viewer-chart-traces">
          {traces.map((trace) => (
            <span key={trace.sensor.key} title={trace.sensor.name}>
              <span
                className="viewer-sensor-swatch"
                style={{ background: trace.color }}
              />
              {trace.sensor.name}
            </span>
          ))}
        </div>
      )}
      <div className="viewer-chart-canvas" ref={ref}>
        {visible && active && (
          <ResponsiveContainer>
            <LineChart
              data={points}
              margin={{ top: 5, right: 15, bottom: 5, left: 5 }}
              onMouseDown={(event) => {
                const label = event?.activeLabel;
                if (label !== undefined && Number.isFinite(Number(label)))
                  setDrag([Number(label), Number(label)]);
              }}
              onMouseMove={(event) => {
                if (drag && event?.activeLabel !== undefined)
                  setDrag([drag[0], Number(event.activeLabel)]);
              }}
              onMouseUp={() => {
                if (drag && drag[0] !== drag[1])
                  onZoom(Math.min(...drag), Math.max(...drag));
                setDrag(undefined);
              }}
            >
              <CartesianGrid
                stroke="var(--viewer-border)"
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="time"
                type="number"
                allowDuplicatedCategory={false}
                domain={["dataMin", "dataMax"]}
                tickFormatter={(value) =>
                  sensor.axis === "sample"
                    ? String(value)
                    : new Date(
                        631065600000 + Number(value) * 1000,
                      ).toLocaleTimeString()
                }
                tick={{ fill: "var(--viewer-muted)", fontSize: 11 }}
              />
              <YAxis
                domain={["auto", "auto"]}
                tick={{ fill: "var(--viewer-muted)", fontSize: 11 }}
                width={52}
              />
              <Tooltip
                contentStyle={{
                  background: "var(--viewer-popup)",
                  borderColor: "var(--viewer-border)",
                }}
                labelFormatter={(value) =>
                  sensor.axis === "sample"
                    ? `Sample ${value}`
                    : new Date(
                        631065600000 + Number(value) * 1000,
                      ).toLocaleString()
                }
              />
              {traces.map((trace) => (
                <Line
                  key={trace.sensor.key}
                  data={trace.points}
                  type="linear"
                  dataKey="value"
                  name={trace.sensor.name}
                  stroke={trace.color}
                  strokeWidth={1.5}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ))}
              {references.map((value, i) => (
                <ReferenceLine
                  key={i}
                  y={value}
                  stroke="var(--viewer-muted)"
                  strokeDasharray="4 4"
                />
              ))}
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
}: {
  client: DocumentClient;
  developer: boolean;
  download: (query: ExportQuery) => void;
  active: boolean;
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
  const [range, setRange] = useState<{ start?: number; end?: number }>({});
  const [filter, setFilter] = useState<{ min?: number; max?: number }>({});
  const [reference, setReference] = useState("");
  const [width, setWidth] = useState(640);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);
  const groups = useMemo(
    () => groupSensors(data?.sensors ?? []),
    [data?.sensors],
  );
  const groupRef = useRef(groups);
  groupRef.current = groups;
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(1, Math.round(entry.contentRect.width))),
    );
    observer.observe(content.current!);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    const chosen = groupRef.current.filter((group) =>
      selected.includes(group.sensor.key),
    );
    const members = chartMemberKeys(groupRef.current, selected);
    client
      .request<ChartData>(
        {
          kind: "chart",
          query: {
            sensors: members.length ? members : selected,
            width:
              width /
              Math.max(1, ...chosen.map((group) => group.members.length)),
            developer,
            ...range,
            filter,
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
          setSelected(
            keep.length
              ? keep
              : defaults.length
                ? defaults
                : nextGroups.slice(0, 2).map((group) => group.sensor.key),
          );
        } else if (
          keep.length !== selected.length ||
          keep.some((key, index) => key !== selected[index])
        )
          setSelected(keep);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, selected, width, developer, range, filter, active]);
  const change = (values: string[]) => {
    initialized.current = true;
    setSelected(values);
    savePreference("chartSensors", values);
  };
  const available = groups
    .map((group) => group.sensor)
    .filter((s) => s.name.toLowerCase().includes(search.toLowerCase()));
  const references = reference
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number)
    .filter(Number.isFinite);
  return (
    <div className="viewer-chart-workspace">
      <aside className="viewer-sensor-sidebar">
        <div className="viewer-sensor-heading">
          <h2>
            Sensors <span className="viewer-muted">{selected.length}</span>
          </h2>
          <IconButton
            title="Select visible sensors"
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
          <IconButton title="Clear sensors" onClick={() => change([])}>
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
                style={{ background: sensorColor(sensor.key) }}
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
          <IconButton
            title="Reset zoom"
            onClick={() => setRange({})}
            disabled={range.start === undefined && range.end === undefined}
          >
            <ZoomOut size={17} />
          </IconButton>
          <IconButton
            title="Download chart JSON"
            onClick={() =>
              download({
                format: "json",
                developer,
                sensors: chartMemberKeys(groups, selected),
              })
            }
            disabled={!selected.length || !groups.length}
          >
            <Download size={17} />
          </IconButton>
          <div className="viewer-chart-filter">
            <label>
              Min{" "}
              <input
                type="number"
                aria-label="Minimum chart value"
                value={filter.min ?? ""}
                onChange={(event) =>
                  setFilter((f) => ({
                    ...f,
                    min:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                  }))
                }
              />
            </label>
            <label>
              Max{" "}
              <input
                type="number"
                aria-label="Maximum chart value"
                value={filter.max ?? ""}
                onChange={(event) =>
                  setFilter((f) => ({
                    ...f,
                    max:
                      event.target.value === ""
                        ? undefined
                        : Number(event.target.value),
                  }))
                }
              />
            </label>
            <IconButton
              title="Clear value filter"
              onClick={() => setFilter({})}
            >
              <RotateCcw size={15} />
            </IconButton>
          </div>
          <label className="viewer-chart-references">
            Reference values{" "}
            <input
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              aria-label="Reference values"
            />
          </label>
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <div className="viewer-chart-plots">
          {groups
            .filter((group) => selected.includes(group.sensor.key))
            .map((group) => {
              const sensor = group.sensor;
              const traces = group.members.map((member) => ({
                sensor: member,
                points: data?.series[member.key] ?? [],
                color: sensorColor(member.key),
              }));
              const points =
                traces.length > 1
                  ? traces
                      .flatMap((trace) => trace.points)
                      .sort((a, b) => a.time - b.time)
                  : traces[0].points;
              return (
                <Plot
                  active={active}
                  sensor={sensor}
                  points={points}
                  traces={traces}
                  color={sensorColor(sensor.key)}
                  references={references}
                  onZoom={(start, end) => setRange({ start, end })}
                  key={sensor.key}
                />
              );
            })}
          {!selected.length && (
            <p className="viewer-muted empty-table">No sensors selected.</p>
          )}
        </div>
      </div>
    </div>
  );
}
