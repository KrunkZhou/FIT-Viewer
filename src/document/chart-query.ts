import type { ChartQuery, Sensor } from "../model";

export function isMotionSensor(sensor: Sensor): boolean {
  const [keyMessage, keyField] = sensor.key.split(":");
  const message = sensor.message ?? Number(keyMessage);
  const field = Number(sensor.field ?? keyField);
  return (
    (message === 164 || message === 165) &&
    Number.isInteger(field) &&
    field >= 2 &&
    field <= (message === 164 ? 7 : 10)
  );
}

export function chartQueryKey(query: ChartQuery): string {
  return JSON.stringify([
    [...new Set(query.sensors)].sort(),
    query.width,
    query.detail ?? "standard",
    query.developer,
    query.start,
    query.end,
    query.filter?.min,
    query.filter?.max,
    query.dates?.start,
    query.dates?.end,
    query.dates?.intervals,
  ]);
}

export function chartQueryGroups(
  sensors: Sensor[],
  query: ChartQuery,
): ChartQuery[] {
  const selected = new Set(query.sensors);
  const groups = new Map<string, string[]>();
  for (const sensor of sensors) {
    if (!selected.has(sensor.key)) continue;
    const [messageKey, ...parts] = sensor.key.split(":");
    const message = sensor.message ?? Number(messageKey);
    const field = sensor.field ?? parts.join(":");
    // Keep shared source budgets and aligned motion families in the same job.
    const key = isMotionSensor(sensor)
      ? JSON.stringify(["motion", message, Math.floor((Number(field) - 2) / 3)])
      : JSON.stringify([
          "ordinary",
          message,
          field,
          sensor.units,
          sensor.axis,
          sensor.label ?? sensor.name,
        ]);
    const members = groups.get(key) ?? [];
    members.push(sensor.key);
    groups.set(key, members);
  }
  return [...groups.values()].map((members) => ({
    ...query,
    sensors: members,
  }));
}
