import { useEffect, useMemo, useState, type HTMLAttributes } from "react";
import {
  Download,
  FileJson2,
  PanelRightClose,
  PanelRightOpen,
} from "lucide-react";
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
import type { MapData, MapPoint, ExportQuery, Position } from "../model";
import type { DocumentClient } from "../document/client";
import { IconButton, Toggle } from "./controls";
import { FIT_EPOCH } from "../protocol/time";
import { pointDetails, routeDetails } from "./map-details";
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

function Bounds({ data }: { data: MapData }) {
  const map = useMap();
  useEffect(() => {
    const positions: [number, number][] = [
      ...data.tracks.flat(),
      ...data.points,
    ].map((p) => [p.lat, p.lon]);
    if (positions.length)
      map.fitBounds(positions, { padding: [24, 24], maxZoom: 16 });
    const observer = new ResizeObserver(() => {
      const size = map.getContainer().getBoundingClientRect();
      if (size.width && size.height) map.invalidateSize();
    });
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map, data]);
  return null;
}

export default function ActivityMap({
  client,
  download,
}: {
  client: DocumentClient;
  download: (query: ExportQuery) => void;
}) {
  const [data, setData] = useState<MapData>();
  const [error, setError] = useState("");
  const [legend, setLegend] = useState(false);
  const [satellite, setSatellite] = useState(false);
  const [selected, setSelected] = useState<Position>();
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
  const [pointTypes, setPointTypes] = useState<MapPoint["kind"][]>([
    "start",
    "finish",
    "distance",
    "waypoint",
  ]);
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
    client
      .request<MapData>({ kind: "map" }, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setData(next);
      })
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, [client]);
  const routeVisible = (route?: number) =>
    route === undefined || !hiddenRoutes.includes(route);
  const routeName = (route: number) =>
    data?.routeNames?.[route] ?? `Route ${route + 1}`;
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
        <div className="viewer-map-canvas">
          <div className="viewer-map-tools">
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
            <IconButton
              title="Download GPX"
              onClick={() =>
                download({
                  format: "gpx",
                  withLaps: pointTypes.includes("lap"),
                })
              }
            >
              <Download size={17} />
            </IconButton>
            <IconButton
              title="Download QGIS GeoJSON"
              onClick={() => download({ format: "geojson" })}
            >
              <FileJson2 size={17} />
            </IconButton>
            <IconButton
              title={legend ? "Hide map legend" : "Show map legend"}
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
              />
              <Bounds data={visible} />
              {data.tracks.map(
                (track, route) =>
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
                          setSelected(closest);
                        },
                      }}
                    />
                  ),
              )}
              {selected && (
                <Popup
                  position={[selected.lat, selected.lon]}
                  eventHandlers={{ remove: () => setSelected(undefined) }}
                >
                  <div>
                    {selected.lat.toFixed(7)}, {selected.lon.toFixed(7)}
                  </div>
                  {selected.time !== undefined && (
                    <div>
                      {new Date(
                        FIT_EPOCH + selected.time * 1000,
                      ).toLocaleString()}
                    </div>
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
                      <Popup>
                        {pointName(point)}
                        {point.time !== undefined && (
                          <div>
                            {new Date(
                              FIT_EPOCH + point.time * 1000,
                            ).toLocaleString()}
                          </div>
                        )}
                      </Popup>
                    </CircleMarker>
                  ),
              )}
              {highlighted?.kind === "route" &&
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
