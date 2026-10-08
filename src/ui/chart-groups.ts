import type { Sensor } from "../model";

export interface ChartGroup {
  sensor: Sensor;
  members: Sensor[];
}

export function chartMemberKeys(
  groups: ChartGroup[],
  selected: string[],
): string[] {
  return groups
    .filter((group) => selected.includes(group.sensor.key))
    .flatMap((group) => group.members.map((sensor) => sensor.key));
}

export function groupSensors(sensors: Sensor[]): ChartGroup[] {
  const groups = new Map<string, ChartGroup>();
  for (const sensor of sensors) {
    const base =
      sensor.source === undefined
        ? sensor.key
        : `${sensor.message}:${sensor.field}`;
    const name = sensor.label ?? sensor.name;
    const identity = JSON.stringify([base, sensor.units, sensor.axis, name]);
    let group = groups.get(identity);
    if (!group) {
      const duplicate = [...groups.values()].some(
        (value) => value.sensor.key === base,
      );
      group = {
        sensor: {
          ...sensor,
          key: duplicate
            ? `${base}:${sensor.axis}:${sensor.units}:${name}`
            : base,
          name,
          source: undefined,
        },
        members: [],
      };
      groups.set(identity, group);
    }
    group.members.push(sensor);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    sensor: {
      ...group.sensor,
      pointCount: group.members.every(
        (member) => member.pointCount !== undefined,
      )
        ? group.members.reduce((count, member) => count + member.pointCount!, 0)
        : undefined,
    },
  }));
}
