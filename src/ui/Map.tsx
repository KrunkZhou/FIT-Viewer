import { useEffect, useMemo, useState, type HTMLAttributes } from "react";
import { PanelRightClose, PanelRightOpen, Route, Scan } from "lucide-react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  Popup,
  ScaleControl,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import type {
  MapData,
  MapPoint,
  MapPlaybackPosition,
  ExportQuery,
  Position,
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
import { formatTimestamp } from "../protocol/time";
import { pointDetails, routeDetails } from "./map-details";
import {
  mapCursorTime,
  mapProgressFromTime,
  mapTimeRange,
  mapTimelineSegments,
  type MapTimeRange,
} from "./map-playback";
import { MapTrackPoints } from "./MapTrackPoints";
import { MapDownloads, MapTimeline } from "./MapControls";
import "leaflet/dist/leaflet.css";

const COLORS = ["#176856", "#397ad1", "#c74662", "#9765b8", "#b57b0b"];
const POINT_TYPES: { kind: MapPoint["kind"]; name: string }[] = [
  { kind: "start", name: "Start" },
  { kind: "finish", name: "Finish" },
  { kind: "distance", name: "Kilometres" },
  { kind: "lap", name: "Laps" },
  { kind: "waypoint", name: "Waypoints" },
];
const pointName = (point: MapPoint) =>
  point.name ?? POINT_TYPES.find((type) => type.kind === point.kind)!.name;
type Highlight =
  | { kind: "route"; index: number }
  | { kind: "point"; index: number }
  | { kind: "type"; type: MapPoint["kind"] };

function Bounds({ data, recenter }: { data: MapData; recenter: number }) {
  const map = useMap();
  useEffect(() => {
    const positions: [number, number][] = [
      ...data.tracks.flat(),
      ...data.points,
    ].map((p) => [p.lat, p.lon]);
    if (positions.length)
      map.fitBounds(positions, { padding: [24, 24], maxZoom: 16 });
  }, [map, data, recenter]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const size = map.getContainer().getBoundingClientRect();
      if (size.width && size.height) map.invalidateSize();
    });
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

export default function ActivityMap({
  client,
  download,
  dates,
  onDatesChange,
  availableDates,
  onGoToData,
}: {
  client: DocumentClient;
  download: (query: ExportQuery) => void;
  dates: TimeRange;
  onDatesChange: (dates: TimeRange) => void;
  availableDates?: string[];
  onGoToData: (record: number) => void;
}) {
  const [data, setData] = useState<MapData>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadingTiles, setLoadingTiles] = useState(false);
  const tileEvents = useMemo(
    () => ({
      loading: () => setLoadingTiles(true),
      load: () => setLoadingTiles(false),
    }),
    [],
  );
  const [legend, setLegend] = useState(false);
  const [recenter, setRecenter] = useState(0);
  const [satellite, setSatellite] = useState(false);
  const [connectPoints, setConnectPoints] = useState(
    readPreference(
      "mapConnectPoints",
      true,
      (value): value is boolean => typeof value === "boolean",
    ),
  );
  const [time, setTime] = useState<number>();
  const [currentPosition, setCurrentPosition] =
    useState<MapPlaybackPosition | null>();
  const [positionQuery, setPositionQuery] = useState<{
    time: number;
    range: MapTimeRange;
  }>();
  const [playbackError, setPlaybackError] = useState("");
  const [selected, setSelected] = useState<Position & { route: number }>();
  const selectedPosition = useMemo<[number, number] | undefined>(
    () => (selected ? [selected.lat, selected.lon] : undefined),
    [selected],
  );
  const [hiddenRoutes, setHiddenRoutes] = useState<number[]>([]);
  const [hiddenPoints, setHiddenPoints] = useState<number[]>([]);
  const [hovered, setHovered] = useState<Highlight>();
  const [focused, setFocused] = useState<Highlight>();
  const highlighted = legend ? (hovered ?? focused) : undefined;
  const legendEvents = (item: Highlight): HTMLAttributes<HTMLLabelElement> => ({
    onMouseEnter: () => setHovered(item),
    onMouseLeave: () => setHovered(undefined),
    onFocus: () => setFocused(item),
    onBlur: (event) => {
      if (!event.currentTarget.contains(event.relatedTarget))
        setFocused(undefined);
    },
  });
  const [pointTypes, setPointTypes] = useState<MapPoint["kind"][]>([]);
  const satelliteUrl = import.meta.env.VITE_MAP_SATELLITE_URL as
    string | undefined;
  const streetUrl =
    (import.meta.env.VITE_MAP_STREET_URL as string | undefined) ||
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const attribution =
    satellite && satelliteUrl
      ? (import.meta.env.VITE_MAP_SATELLITE_ATTRIBUTION as
          string | undefined) || ""
      : (import.meta.env.VITE_MAP_STREET_ATTRIBUTION as string | undefined) ||
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setData(undefined);
    setSelected(undefined);
    setTime(undefined);
    setCurrentPosition(undefined);
    setPositionQuery(undefined);
    setPlaybackError("");
    setHiddenRoutes([]);
    setHiddenPoints([]);
    setHovered(undefined);
    setFocused(undefined);
    client
      .request<MapData>({ kind: "map", dates }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== "AbortError")
          setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, dates]);
  const routeVisible = (route?: number) =>
    route === undefined || !hiddenRoutes.includes(route);
  const routeName = (route: number) =>
    data?.routeNames?.[route] ?? `Route ${route + 1}`;
  const timeRange = useMemo(
    () => mapTimeRange(data?.playback?.routes ?? [], hiddenRoutes),
    [data?.playback, hiddenRoutes],
  );
  const cursorTime = mapCursorTime(time, timeRange);
  const cursorProgress = mapProgressFromTime(cursorTime, timeRange);
  const timeline = useMemo(
    () =>
      mapTimelineSegments(
        data?.playback?.routes ?? [],
        hiddenRoutes,
        COLORS,
        timeRange,
      ),
    [data?.playback, hiddenRoutes, timeRange],
  );
  const currentRouteColor =
    currentPosition && routeVisible(currentPosition.route)
      ? COLORS[currentPosition.route % COLORS.length]
      : "var(--viewer-muted)";
  useEffect(() => {
    if (!data?.playback || cursorTime === undefined || !timeRange) {
      setCurrentPosition(undefined);
      return;
    }
    const controller = new AbortController();
    const mapId = data.playback.id;
    const frame = requestAnimationFrame(() => {
      setPlaybackError("");
      client
        .request<MapPlaybackPosition | null>(
          {
            kind: "map-position",
            mapId,
            time: cursorTime,
            routes: timeRange.routes,
          },
          controller.signal,
        )
        .then((position) => {
          if (!controller.signal.aborted) {
            setCurrentPosition(position);
            setPositionQuery({ time: cursorTime, range: timeRange });
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted && error.name !== "AbortError")
            setPlaybackError(error.message);
        });
    });
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  }, [client, data?.playback, cursorTime, timeRange]);
  const trackPositions = useMemo(
    () =>
      data?.tracks.map((track) =>
        track.map((point) => [point.lat, point.lon] as [number, number]),
      ) ?? [],
    [data],
  );
  const routeDescriptions = useMemo(
    () =>
      data?.tracks.map((track, route) =>
        routeDetails(track, routeName(route)),
      ) ?? [],
    [data],
  );
  const pointVisible = (point: MapPoint, index: number) =>
    routeVisible(point.route) &&
    pointTypes.includes(point.kind) &&
    !hiddenPoints.includes(index);
  const visible = useMemo(
    () =>
      data && {
        tracks: data.tracks.filter((_, route) => !hiddenRoutes.includes(route)),
        points: data.points.filter(
          (point, i) =>
            (point.route === undefined ||
              !hiddenRoutes.includes(point.route)) &&
            pointTypes.includes(point.kind) &&
            !hiddenPoints.includes(i),
        ),
      },
    [data, hiddenRoutes, hiddenPoints, pointTypes],
  );
  const flipRoute = (route: number) => {
    setSelected(undefined);
    setHiddenRoutes((previous) =>
      previous.includes(route)
        ? previous.filter((id) => id !== route)
        : [...previous, route],
    );
  };
  return (
    <div className="viewer-map" data-legend={legend}>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="viewer-map-workspace">
        <div className="viewer-map-canvas" aria-busy={loading || loadingTiles}>
          {(loading || loadingTiles) && (
            <LoadingIndicator
              label={loading ? "Loading map data" : "Loading map tiles"}
            />
          )}
          <div className="viewer-map-tools">
            <IconButton
              title="Recenter map"
              tooltip="Recenter on visible routes and points"
              disabled={
                loading ||
                !visible ||
                (!visible.tracks.length && !visible.points.length)
              }
              onClick={() => setRecenter((value) => value + 1)}
            >
              <Scan size={18} />
            </IconButton>
            <IconButton
              title="Route lines"
              tooltip={
                connectPoints
                  ? "Hide route lines and show GPS points only"
                  : "Connect GPS points with route lines"
              }
              aria-pressed={connectPoints}
              onClick={() => {
                setConnectPoints(!connectPoints);
                savePreference("mapConnectPoints", !connectPoints);
              }}
            >
              <Route size={18} />
            </IconButton>
            <DateRangeFilter
              value={dates}
              onChange={onDatesChange}
              availableDates={availableDates}
            />
            {satelliteUrl && (
              <label>
                Satellite{" "}
                <Toggle
                  label="Satellite map"
                  checked={satellite}
                  onChange={setSatellite}
                />
              </label>
            )}
            <MapDownloads
              download={download}
              dates={dates}
              withLaps={pointTypes.includes("lap")}
              disabled={
                loading || !data || (!data.tracks.length && !data.points.length)
              }
            />
            <IconButton
              title={legend ? "Hide map legend" : "Show map legend"}
              tooltip={
                legend
                  ? "Hide map routes and points"
                  : "Show map routes and points"
              }
              aria-expanded={legend}
              aria-controls="map-legend"
              onClick={() => setLegend((value) => !value)}
            >
              {legend ? (
                <PanelRightClose size={18} />
              ) : (
                <PanelRightOpen size={18} />
              )}
            </IconButton>
          </div>
          {data && visible && (
            <MapContainer
              className={
                satellite ? "viewer-map-satellite" : "viewer-map-street"
              }
              center={[0, 0]}
              zoom={2}
              scrollWheelZoom
            >
              <TileLayer
                url={satellite && satelliteUrl ? satelliteUrl : streetUrl}
                attribution={attribution}
                maxZoom={19}
                eventHandlers={tileEvents}
              />
              <Bounds data={visible} recenter={recenter} />
              {data.tracks.map(
                (track, route) =>
                  connectPoints &&
                  routeVisible(route) && (
                    <Polyline
                      key={route}
                      positions={trackPositions[route]}
                      pathOptions={{
                        color: COLORS[route % COLORS.length],
                        weight: 3,
                      }}
                      eventHandlers={{
                        click: (event) => {
                          let closest: Position | undefined;
                          let distance = Infinity;
                          for (const point of track) {
                            const next =
                              (point.lat - event.latlng.lat) ** 2 +
                              (point.lon - event.latlng.lng) ** 2;
                            if (next < distance) {
                              closest = point;
                              distance = next;
                            }
                          }
                          setSelected(
                            closest ? { ...closest, route } : undefined,
                          );
                        },
                      }}
                    />
                  ),
              )}
              {!connectPoints && (
                <MapTrackPoints
                  tracks={data.tracks}
                  hidden={hiddenRoutes}
                  colors={COLORS}
                  highlighted={
                    highlighted?.kind === "route"
                      ? highlighted.index
                      : undefined
                  }
                  onSelect={setSelected}
                />
              )}
              {currentPosition && routeVisible(currentPosition.route) && (
                <CircleMarker
                  className="map-time-position"
                  center={[currentPosition.lat, currentPosition.lon]}
                  radius={8}
                  pathOptions={{
                    color: "#fff",
                    fillColor: "#f59e0b",
                    fillOpacity: 1,
                    weight: 3,
                  }}
                >
                  <Tooltip direction="top">
                    <strong>Current position</strong>
                    <div>{routeName(currentPosition.route)}</div>
                    <div>{formatTimestamp(currentPosition.time)}</div>
                    <div>
                      {currentPosition.lat.toFixed(7)},{" "}
                      {currentPosition.lon.toFixed(7)}
                    </div>
                  </Tooltip>
                </CircleMarker>
              )}
              {selected && (
                <Popup
                  position={selectedPosition}
                  autoPan={false}
                  keepInView={false}
                  eventHandlers={{ remove: () => setSelected(undefined) }}
                >
                  <div>{routeName(selected.route)}</div>
                  <div>
                    {selected.lat.toFixed(7)}, {selected.lon.toFixed(7)}
                  </div>
                  {selected.time !== undefined && (
                    <div>{formatTimestamp(selected.time)}</div>
                  )}
                  {selected.distance !== undefined && (
                    <div>{(selected.distance / 1000).toFixed(2)} km</div>
                  )}
                </Popup>
              )}
              {data.points.map(
                (point, i) =>
                  pointVisible(point, i) && (
                    <CircleMarker
                      key={i}
                      center={[point.lat, point.lon]}
                      radius={
                        point.kind === "distance"
                          ? 12
                          : point.kind === "start" || point.kind === "finish"
                            ? 6
                            : 4
                      }
                      pathOptions={{
                        color:
                          point.kind === "finish"
                            ? "#c74662"
                            : COLORS[(point.route ?? 0) % COLORS.length],
                        fillColor:
                          point.kind === "distance" ? "#fff" : undefined,
                        fillOpacity: 1,
                        weight: 2,
                      }}
                    >
                      {point.kind === "distance" && (
                        <Tooltip
                          permanent
                          direction="center"
                          opacity={1}
                          className="distance-marker-label"
                        >
                          {point.name?.split(" ")[0]}
                        </Tooltip>
                      )}
                      <Popup autoPan={false} keepInView={false}>
                        {pointName(point)}
                        {point.route !== undefined && (
                          <div>{routeName(point.route)}</div>
                        )}
                        {point.time !== undefined && (
                          <div>{formatTimestamp(point.time)}</div>
                        )}
                      </Popup>
                    </CircleMarker>
                  ),
              )}
              {connectPoints &&
                highlighted?.kind === "route" &&
                routeVisible(highlighted.index) && (
                  <Polyline
                    className="map-highlight-route"
                    positions={trackPositions[highlighted.index]}
                    interactive={false}
                    pathOptions={{
                      color: "#f59e0b",
                      weight: 7,
                      opacity: 0.95,
                    }}
                  />
                )}
              {data.points.map(
                (point, i) =>
                  pointVisible(point, i) &&
                  ((highlighted?.kind === "point" && highlighted.index === i) ||
                    (highlighted?.kind === "type" &&
                      highlighted.type === point.kind)) && (
                    <CircleMarker
                      key={`highlight-${i}`}
                      className="map-highlight-point"
                      center={[point.lat, point.lon]}
                      radius={point.kind === "distance" ? 17 : 11}
                      interactive={false}
                      pathOptions={{
                        color: "#f59e0b",
                        weight: 4,
                        fill: false,
                      }}
                    />
                  ),
              )}
              <ScaleControl />
            </MapContainer>
          )}
          {timeRange && cursorTime !== undefined && (
            <MapTimeline
              range={timeRange}
              progress={cursorProgress ?? 0}
              segments={timeline}
              position={
                currentPosition && routeVisible(currentPosition.route)
                  ? currentPosition
                  : undefined
              }
              routeName={
                currentPosition && routeVisible(currentPosition.route)
                  ? routeName(currentPosition.route)
                  : undefined
              }
              color={currentRouteColor}
              error={playbackError}
              onTimeChange={setTime}
              onGoToData={onGoToData}
              canGoToData={
                positionQuery?.time === cursorTime &&
                positionQuery?.range === timeRange
              }
            />
          )}
          {!loading && data && !data.tracks.length && !data.points.length && (
            <p className="viewer-map-empty" role="status">
              No GPS data in the selected date range.
            </p>
          )}
        </div>
        <aside
          className="viewer-map-legend"
          id="map-legend"
          aria-label="Map legend"
          hidden={!legend}
        >
          <div className="viewer-map-legend-heading">
            <h3>Map legend</h3>
            <IconButton
              title="Close map legend"
              onClick={() => setLegend(false)}
            >
              <PanelRightClose size={18} />
            </IconButton>
          </div>
          <div className="viewer-map-legend-scroll">
            <section>
              <h3>Points</h3>
              {POINT_TYPES.filter((type) =>
                data?.points.some((p) => p.kind === type.kind),
              ).map((type) => (
                <label
                  key={type.kind}
                  title={`${type.name}\n${data?.points.filter((point) => point.kind === type.kind).length ?? 0} points`}
                  {...legendEvents({ kind: "type", type: type.kind })}
                >
                  <input
                    type="checkbox"
                    checked={pointTypes.includes(type.kind)}
                    onChange={(event) =>
                      setPointTypes((previous) =>
                        event.target.checked
                          ? [...previous, type.kind]
                          : previous.filter((kind) => kind !== type.kind),
                      )
                    }
                  />
                  {type.name}
                </label>
              ))}
            </section>
            {data && data.tracks.length > 0 && (
              <section>
                <h3>Routes</h3>
                {data.tracks.map((_, route) => (
                  <label
                    key={route}
                    title={routeDescriptions[route]}
                    {...legendEvents({ kind: "route", index: route })}
                  >
                    <input
                      type="checkbox"
                      checked={routeVisible(route)}
                      onChange={() => flipRoute(route)}
                      aria-label={`Show ${routeName(route)}`}
                    />
                    <span
                      className="map-route-swatch"
                      style={{ background: COLORS[route % COLORS.length] }}
                    />
                    <span className="map-route-name">{routeName(route)}</span>
                  </label>
                ))}
              </section>
            )}
            <section className="map-point-list">
              {data?.points.map(
                (point, i) =>
                  routeVisible(point.route) &&
                  pointTypes.includes(point.kind) && (
                    <label
                      key={i}
                      title={pointDetails(
                        point,
                        pointName(point),
                        point.route === undefined
                          ? undefined
                          : routeName(point.route),
                      )}
                      {...legendEvents({ kind: "point", index: i })}
                    >
                      <input
                        type="checkbox"
                        checked={!hiddenPoints.includes(i)}
                        onChange={(event) =>
                          setHiddenPoints((previous) =>
                            event.target.checked
                              ? previous.filter((id) => id !== i)
                              : [...previous, i],
                          )
                        }
                        aria-label={`Show ${pointName(point)}${point.route === undefined ? "" : ` on Route ${point.route + 1}`}`}
                      />
                      <span
                        className={`map-point-symbol map-point-${point.kind}`}
                      >
                        {point.kind === "distance"
                          ? point.name?.split(" ")[0]
                          : ""}
                      </span>
                      <span>
                        {pointName(point)}
                        {data.tracks.length > 1 &&
                          point.route !== undefined && (
                            <small className="viewer-muted">
                              {routeName(point.route)}
                            </small>
                          )}
                      </span>
                    </label>
                  ),
              )}
            </section>
          </div>
        </aside>
      </div>
    </div>
  );
}
