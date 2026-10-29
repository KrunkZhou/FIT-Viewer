import type { ChartData, ChartDisplay, ChartPoint, Job } from "../model";
import { groupMotionAxes, groupSensors } from "../chart-groups";

export const chartDisplayKey = (members: readonly string[]) =>
  JSON.stringify([...members].sort());

async function sorted(points: ChartPoint[], job: Job): Promise<ChartPoint[]> {
  const size = 2048;
  let runs: ChartPoint[][] = [];
  for (let i = 0; i < points.length; i += size) {
    runs.push(points.slice(i, i + size).sort((a, b) => a.time - b.time));
    await job.yield();
  }
  while (runs.length > 1) {
    const next: ChartPoint[][] = [];
    for (let i = 0; i < runs.length; i += 2) {
      if (!runs[i + 1]) {
        next.push(runs[i]);
        continue;
      }
      const a = runs[i],
        b = runs[i + 1],
        merged: ChartPoint[] = [];
      let left = 0,
        right = 0;
      while (left < a.length || right < b.length) {
        merged.push(
          right >= b.length ||
            (left < a.length && a[left].time <= b[right].time)
            ? a[left++]
            : b[right++],
        );
        if (merged.length % size === 0) await job.yield();
      }
      next.push(merged);
    }
    runs = next;
  }
  return runs[0] ?? [];
}

/** Prepare source lines and XYZ tooltip domains before crossing into React. */
export async function prepareChartDisplay(
  data: ChartData,
  job: Job,
): Promise<ChartData> {
  if (data.display || !Object.keys(data.series).length) return data;
  const groups = groupSensors(
    data.sensors.filter((sensor) => Object.hasOwn(data.series, sensor.key)),
  );
  const lines = new Map<string, ChartDisplay["lines"][number]>();
  const display: ChartDisplay[] = [];
  for (const group of groups) {
    const points: ChartPoint[] = [];
    for (const member of group.members) {
      const source = data.series[member.key];
      for (let i = 0; i < source.length; i++) {
        const point = source[i];
        if (point.value !== null)
          points.push(
            member.sourceName === undefined
              ? point
              : { ...point, sourceName: member.sourceName },
          );
        if (i % 2048 === 0) await job.yield();
      }
    }
    const members = group.members.map((member) => member.key);
    const line = {
      sensor: group.sensor,
      members,
      points: await sorted(points, job),
    };
    lines.set(chartDisplayKey(members), line);
    display.push({ members, lines: [line], points: line.points });
  }
  for (const group of groupMotionAxes(groups, true)) {
    const members = group.members.map((member) => member.key);
    if (lines.has(chartDisplayKey(members))) continue;
    const memberSet = new Set(members);
    const selected = [...lines.values()].filter((line) =>
      line.members.every((key) => memberSet.has(key)),
    );
    const points: ChartPoint[] = [];
    for (const line of selected)
      for (let i = 0; i < line.points.length; i++) {
        points.push(line.points[i]);
        if (i % 2048 === 0) await job.yield();
      }
    display.push({
      members,
      lines: selected,
      points: await sorted(points, job),
    });
  }
  return { ...data, display };
}
