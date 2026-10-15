import type { ChartData, ChartQuery, Sensor } from "../model";
import type { DocumentClient } from "../document/client";
import { groupSensors } from "./chart-groups";

export function chartSelection(
  sensors: Sensor[],
  selected: string[],
  initialize: boolean,
): string[] {
  const groups = groupSensors(sensors);
  const keep = groups
    .filter(
      (group) =>
        selected.includes(group.sensor.key) ||
        group.members.some((sensor) => selected.includes(sensor.key)),
    )
    .map((group) => group.sensor.key);
  if (!initialize || keep.length) return keep;
  const defaults = groups.filter(({ sensor }) =>
    ["20:3", "20:6", "20:2"].includes(
      `${sensor.message ?? sensor.key.split(":")[0]}:${sensor.field ?? sensor.key.split(":")[1]}`,
    ),
  );
  return (defaults.length ? defaults : groups.slice(0, 2)).map(
    (group) => group.sensor.key,
  );
}

export async function initialCharts(
  client: Pick<DocumentClient, "request">,
  selected: string[],
  initialize: boolean,
  query: Omit<ChartQuery, "sensors">,
  signal: AbortSignal,
): Promise<ChartData> {
  const candidates = await client.request<Sensor[]>(
    { kind: "sensor-candidates", developer: query.developer },
    signal,
  );
  signal.throwIfAborted();
  const keys = chartSelection(candidates, selected, initialize);
  const sensors = groupSensors(candidates)
    .filter((group) => keys.includes(group.sensor.key))
    .flatMap((group) => group.members.map((sensor) => sensor.key));
  // The selected plots are cached before discovery of unrelated sensor values.
  if (!sensors.length) return { sensors: [], series: {}, start: 0, end: 0 };
  return client.request<ChartData>(
    { kind: "chart", query: { ...query, sensors } },
    signal,
  );
}
