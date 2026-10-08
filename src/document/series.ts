import { Profile } from "@garmin/fitsdk";
import type {
  ChartData,
  ChartPoint,
  ChartQuery,
  Job,
  MapData,
  Position,
  Sensor,
} from "../model";
import { FitDocument } from "./document";
import { idleJob } from "../protocol/reader";
import { isMotionSensor, motionChart, motionPoints } from "./motion";

export function sensors(document: FitDocument, developer: boolean): Sensor[] {
  const output: Sensor[] = [];
  for (const message of document.messageInfo) {
    if (!message.known && !developer) continue;
    const hasTime = (document.index.messages.get(message.id) ?? []).some(
      (id) => document.index.records[id].timestamp !== undefined,
    );
    if (message.id !== 20 && !hasTime && !developer) continue;
    for (const field of document.getFields(message.id, developer)) {
      if (
        field.id === 253 ||
        field.type === "string" ||
        field.type === "dateTime" ||
        field.type === "localDateTime" ||
        field.bitmask ||
        ((message.id === 164 || message.id === 165) &&
          (field.id === 0 || field.id === 1)) ||
        Object.keys(field.values ?? {}).length
      )
        continue;
      output.push({
        key: `${message.id}:${field.key}`,
        name: message.id === 20 ? field.name : `${message.name}: ${field.name}`,
        units: field.units,
        axis: hasTime ? "time" : "sample",
      });
    }
  }
  return output;
}

const sensorInventories = new WeakMap<FitDocument, Map<boolean, Sensor[]>>();

export async function chartSensors(
  document: FitDocument,
  developer: boolean,
  job = idleJob(),
): Promise<Sensor[]> {
  const cached = sensorInventories.get(document)?.get(developer);
  if (cached) return cached;
  const candidates = sensors(document, developer);
  const usable = new Set<string>();
  const groups = new Map<number, Sensor[]>();
  for (const sensor of candidates) {
    if (isMotionSensor(sensor)) {
      let count = 0;
      for await (const point of motionPoints(
        document,
        sensor,
        developer,
        job,
      )) {
        if (point.value !== null && ++count >= 2) {
          usable.add(sensor.key);
          break;
        }
      }
    } else {
      const id = Number(sensor.key.split(":")[0]);
      const fields = groups.get(id) ?? [];
      fields.push(sensor);
      groups.set(id, fields);
    }
    await job.yield();
  }
  // Count only enough finite source samples to establish a useful series.
  for (const [message, fields] of groups) {
    const counts = new Map<string, number>();
    const pending = new Set(fields);
    let index = 0;
    for (const id of document.index.messages.get(message) ?? []) {
      const record = document.index.records[id];
      const cells = document.cells(id, !developer);
      for (const sensor of pending) {
        if (sensor.axis === "time" && record.timestamp === undefined) continue;
        const key = sensor.key.slice(sensor.key.indexOf(":") + 1);
        const value = cells[key]?.[developer ? "raw" : "value"];
        for (const sample of Array.isArray(value) ? value : [value]) {
          if (typeof sample !== "number" || !Number.isFinite(sample)) continue;
          const count = (counts.get(sensor.key) ?? 0) + 1;
          counts.set(sensor.key, count);
          if (count >= 2) {
            usable.add(sensor.key);
            pending.delete(sensor);
            break;
          }
        }
      }
      if (!pending.size) break;
      if (++index % 128 === 0) await job.yield();
    }
    await job.yield();
  }
  const output = candidates.filter((sensor) => usable.has(sensor.key));
  let modes = sensorInventories.get(document);
  if (!modes) sensorInventories.set(document, (modes = new Map()));
  modes.set(developer, output);
  return output;
}

function* sampledPoints(
  points: ChartPoint[],
  width: number,
): Generator<ChartPoint | undefined> {
  const capacity = Math.max(8, Math.min(8192, Math.round(width) * 2));
  if (points.length <= capacity) {
    yield* points;
    return;
  }
  const size = Math.max(
    1,
    Math.ceil(points.length / Math.max(1, Math.floor(capacity / 8))),
  );
  let previous = -1;
  for (let start = 0; start < points.length; start += size) {
    const end = Math.min(points.length, start + size);
    let min = -1;
    let max = -1;
    for (let i = start; i < end; i++) {
      if (i % 8192 === 0) yield undefined;
      if (points[i].value === null) {
        continue;
      }
      if (min === -1 || points[i].value! < points[min].value!) min = i;
      if (max === -1 || points[i].value! > points[max].value!) max = i;
    }
    const candidates = new Set(
      [start, end - 1, min, max].filter((i) => i >= 0),
    );
    for (const i of Array.from(candidates).sort((a, b) => a - b)) {
      // Never join retained extrema across a gap discarded by a bucket.
      if (
        previous >= 0 &&
        points[previous].value !== null &&
        points[i].value !== null
      ) {
        for (let cursor = previous + 1; cursor < i; cursor++) {
          if (cursor % 8192 === 0) yield undefined;
          if (points[cursor].value === null) {
            yield points[cursor];
            break;
          }
        }
      }
      yield points[i];
      previous = i;
    }
  }
}

export function downsample(points: ChartPoint[], width: number): ChartPoint[] {
  return Array.from(sampledPoints(points, width)).filter(
    (point): point is ChartPoint => point !== undefined,
  );
}

async function scheduledDownsample(
  points: ChartPoint[],
  width: number,
  job: Job,
): Promise<ChartPoint[]> {
  const output: ChartPoint[] = [];
  for (const point of sampledPoints(points, width)) {
    if (point === undefined) await job.yield();
    else output.push(point);
  }
  return output;
}

export async function* chartPoints(
  document: FitDocument,
  sensor: Sensor,
  developer: boolean,
  job: Job,
): AsyncGenerator<ChartPoint> {
  if (isMotionSensor(sensor)) {
    yield* motionPoints(document, sensor, developer, job);
    return;
  }
  const [message, ...parts] = sensor.key.split(":");
  const field = parts.join(":");
  const ids = document.index.messages.get(Number(message)) ?? [];
  let sample = 0;
  let file = -1;
  let previous: number | undefined;
  for (let i = 0; i < ids.length; i++) {
    const record = document.index.records[ids[i]];
    const cell = document.cells(ids[i], !developer)[field];
    const value = cell?.[developer ? "raw" : "value"] ?? null;
    const values = Array.isArray(value) ? value : [value];
    const t = sensor.axis === "sample" ? sample : record.timestamp;
    if (
      t !== undefined &&
      previous !== undefined &&
      (file !== record.subfile ||
        (sensor.axis !== "sample" && t - previous > 10))
    )
      yield { time: t, value: null };
    for (const v of values) {
      const time = sensor.axis === "sample" ? sample++ : record.timestamp;
      if (time !== undefined)
        yield {
          time,
          value: typeof v === "number" && Number.isFinite(v) ? v : null,
        };
    }
    file = record.subfile;
    previous = t;
    if (i % 512 === 0) {
      job.progress(i, ids.length, "Preparing chart data");
      await job.yield();
    }
  }
}

export async function chart(
  document: FitDocument,
  query: ChartQuery,
  job = idleJob(),
  full = false,
): Promise<ChartData> {
  const available = await chartSensors(document, query.developer, job);
  const selected = available.filter((s) => query.sensors.includes(s.key));
  const series: ChartData["series"] = {};
  let start = Infinity;
  let end = -Infinity;
  const motion = selected.filter(isMotionSensor);
  if (motion.length && !full) {
    const data = await motionChart(document, motion, query, job);
    Object.assign(series, data.series);
    start = data.start;
    end = data.end;
  }
  for (const sensor of selected.filter((s) => full || !isMotionSensor(s))) {
    const points: ChartPoint[] = [];
    for await (const point of chartPoints(
      document,
      sensor,
      query.developer,
      job,
    )) {
      const { time } = point;
      if (
        (query.start !== undefined && time < query.start) ||
        (query.end !== undefined && time > query.end)
      )
        continue;
      let numeric = point.value;
      if (
        numeric !== null &&
        ((query.filter?.min !== undefined && numeric < query.filter.min) ||
          (query.filter?.max !== undefined && numeric > query.filter.max))
      )
        numeric = null;
      points.push({ time, value: numeric });
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
    series[sensor.key] = full
      ? points
      : await scheduledDownsample(points, query.width, job);
  }
  return {
    sensors: available,
    series,
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
  };
}

async function simplify(
  track: Position[],
  tolerance: number,
  job: Job,
): Promise<Position[]> {
  if (track.length < 3) return track;
  const keep = new Uint8Array(track.length);
  keep[0] = keep[track.length - 1] = 1;
  const stack: [number, number][] = [[0, track.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop()!;
    const a = track[first];
    const b = track[last];
    let farthest = -1;
    let maximum = tolerance * tolerance;
    const dx = b.lon - a.lon;
    const dy = b.lat - a.lat;
    const length = dx * dx + dy * dy;
    for (let i = first + 1; i < last; i++) {
      const point = track[i];
      const fraction = length
        ? Math.max(
            0,
            Math.min(
              1,
              ((point.lon - a.lon) * dx + (point.lat - a.lat) * dy) / length,
            ),
          )
        : 0;
      const distance =
        (point.lon - a.lon - fraction * dx) ** 2 +
        (point.lat - a.lat - fraction * dy) ** 2;
      if (distance > maximum) {
        maximum = distance;
        farthest = i;
      }
      if (i % 4096 === 0) await job.yield();
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  return track.filter((_, i) => keep[i]);
}

export async function* mapPositions(
  document: FitDocument,
  job: Job,
): AsyncGenerator<{
  message: number;
  subfile: number;
  point?: Position & { name?: string };
}> {
  const fields = new Map<
    number,
    { latitude: number; longitude: number; name?: number; timestamp?: number }
  >();
  for (const definition of document.index.definitions) {
    const all = Object.values(
      Profile.messages[definition.message]?.fields ?? {},
    );
    const latitude = all.find(
      (f) => f.name === "positionLat" || f.name === "startPositionLat",
    );
    const longitude = all.find(
      (f) => f.name === "positionLong" || f.name === "startPositionLong",
    );
    if (latitude && longitude)
      fields.set(definition.message, {
        latitude: latitude.num,
        longitude: longitude.num,
        name: all.find((f) => f.name === "name")?.num,
        timestamp: all.find((f) => f.name === "timestamp")?.num,
      });
  }
  for (let id = 0; id < document.index.records.length; id++) {
    if (id % 512 === 0) {
      job.progress(id, document.index.records.length, "Preparing map data");
      await job.yield();
    }
    const record = document.index.records[id];
    const info = fields.get(record.definition.message);
    if (!info) continue;
    const cells = document.cells(id);
    const lat = cells[String(info.latitude)]?.value;
    const lon = cells[String(info.longitude)]?.value;
    if (
      typeof lat !== "number" ||
      typeof lon !== "number" ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180
    ) {
      yield { message: record.definition.message, subfile: record.subfile };
      continue;
    }
    const elevation =
      record.definition.message === 20
        ? (cells["78"]?.value ?? cells["2"]?.value)
        : undefined;
    const distance =
      record.definition.message === 20 ? cells["5"]?.value : undefined;
    const name =
      info.name === undefined ? undefined : cells[String(info.name)]?.value;
    const timestamp =
      info.timestamp === undefined
        ? undefined
        : cells[String(info.timestamp)]?.raw;
    yield {
      message: record.definition.message,
      subfile: record.subfile,
      point: {
        lat,
        lon,
        time:
          record.timestamp ??
          (typeof timestamp === "number" && Number.isFinite(timestamp)
            ? timestamp
            : undefined),
        record: id,
        ...(typeof elevation === "number" ? { elevation } : {}),
        ...(typeof distance === "number" ? { distance } : {}),
        ...(typeof name === "string" ? { name } : {}),
      },
    };
  }
}

export async function mapData(
  document: FitDocument,
  job = idleJob(),
  full = false,
): Promise<MapData> {
  const data: MapData = { tracks: [], points: [] };
  let track: Position[] = [];
  let subfile = -1;
  const finish = async () => {
    if (track.length)
      data.tracks.push(full ? track : await simplify(track, 0.00002, job));
    track = [];
  };
  let kilometre = 0;
  for await (const { message, subfile: file, point } of mapPositions(
    document,
    job,
  )) {
    if (!point) {
      if (message === 20) await finish();
      continue;
    }
    if (message === 20) {
      if (
        subfile !== file ||
        (track.at(-1)?.time !== undefined &&
          point.time !== undefined &&
          point.time < track.at(-1)!.time!)
      ) {
        await finish();
        kilometre = 0;
      }
      subfile = file;
      track.push(point);
      if (
        !full &&
        point.distance !== undefined &&
        Math.floor(point.distance / 1000) > kilometre &&
        data.points.length < 512
      ) {
        kilometre = Math.floor(point.distance / 1000);
        data.points.push({
          ...point,
          kind: "distance",
          name: `${kilometre} km`,
          route: data.tracks.length,
        });
      }
    } else {
      data.points.push({ ...point, kind: message === 19 ? "lap" : "waypoint" });
    }
  }
  await finish();
  for (const [route, segment] of data.tracks.entries()) {
    if (segment[0]) data.points.push({ ...segment[0], kind: "start", route });
    if (segment.at(-1))
      data.points.push({ ...segment.at(-1)!, kind: "finish", route });
  }
  for (const point of data.points) {
    if (point.route !== undefined) continue;
    const route = data.tracks.findIndex(
      (segment) =>
        point.record >= segment[0].record &&
        point.record <= segment.at(-1)!.record,
    );
    if (route >= 0) point.route = route;
  }
  return data;
}

export function interpolate(
  samples: ChartPoint[],
  time: number,
): number | null {
  if (!samples.length) return null;
  if (samples.length === 1)
    return samples[0].time === time ? samples[0].value : null;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (time < a.time || time > b.time || a.value === null || b.value === null)
      continue;
    if (a.time === b.time) return b.value;
    return (
      a.value + ((b.value - a.value) * (time - a.time)) / (b.time - a.time)
    );
  }
  return null;
}
