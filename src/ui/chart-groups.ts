import type { Sensor } from "../model";

export interface ChartGroup {
  sensor: Sensor;
  members: Sensor[];
}

export function motionAxis(sensor: Sensor): "X" | "Y" | "Z" | undefined {
  const [messageKey, fieldKey] = sensor.key.split(":");
  const message = sensor.message ?? Number(messageKey);
  const field = Number(sensor.field ?? fieldKey);
  if (
    (message !== 164 && message !== 165) ||
    !Number.isInteger(field) ||
    field < 2 ||
    field > (message === 164 ? 7 : 10)
  )
    return;
  return (["X", "Y", "Z"] as const)[(field - 2) % 3];
}

export function groupMotionAxes(
  groups: ChartGroup[],
  combine: boolean,
): ChartGroup[] {
  if (!combine) return groups;
  const plots = new Map<string, ChartGroup[]>();
  for (const group of groups) {
    const sensor = group.sensor;
    const axis = motionAxis(sensor);
    const [message, field] = sensor.key.split(":");
    const name = sensor.name;
    // Keep raw, calibrated and compressed axes separate, even if units match.
    const identity =
      axis && name.endsWith(` ${axis}`)
        ? JSON.stringify([
            sensor.message ?? Number(message),
            Math.floor((Number(sensor.field ?? field) - 2) / 3),
            sensor.units,
            sensor.axis,
            name.slice(0, -2),
          ])
        : sensor.key;
    const siblings = plots.get(identity) ?? [];
    siblings.push(group);
    plots.set(identity, siblings);
  }
  return [...plots.entries()].map(([identity, siblings]) => {
    if (siblings.length === 1) return siblings[0];
    const sensor = siblings[0].sensor;
    const members = siblings.flatMap((group) => group.members);
    return {
      sensor: {
        ...sensor,
        key: `xyz:${identity}`,
        name: `${sensor.name.slice(0, -2)} XYZ`,
        pointCount: members.every((member) => member.pointCount !== undefined)
          ? members.reduce((total, member) => total + member.pointCount!, 0)
          : undefined,
      },
      members,
    };
  });
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
