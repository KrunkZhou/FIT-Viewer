import type {
  ChartData,
  ChartPoint,
  ChartQuery,
  ChartDetail,
  Job,
  MapData,
  Position,
  Sensor,
  TimeRange,
} from "../model";
import { hasTimeRange, inTimeRange, intersectTimeRanges } from "./time-range";
import { FitDocument } from "./document";
import { idleJob } from "../protocol/reader";
import {
  isMotionSensor,
  motionChart,
  motionPoints,
  motionStatistics,
} from "./motion";
import { SampleStatistics, sampleStatistics } from "./sample-statistics";
import { positionCoordinates, positionFields } from "./positions";
import type { MapPlaybackIndex } from "./map-playback";
import { chartPointBudget } from "./chart-sampling";
import { NumericReader } from "./numeric-reader";
import { PointSampler } from "./point-sampler";
import { recordTimeSpans } from "./record-time-index";

const candidatesByDocument = new WeakMap<FitDocument, Map<boolean, Sensor[]>>();
export function sensors(document: FitDocument, developer: boolean): Sensor[] {
  const cached = candidatesByDocument.get(document)?.get(developer);
  if (cached) return cached;
  const output: Sensor[] = [];
  for (const message of document.messageInfo) {
    if (!message.known && !developer) continue;
    for (const source of document.sources.length > 1
      ? document.sources.map((s) => s.id)
      : [undefined]) {
      const ids = document.recordIds(message.id, source);
      if (!ids.length) continue;
      const hasTime = ids.some(
        (id) => document.index.records[id].timestamp !== undefined,
      );
      if (message.id !== 20 && !hasTime && !developer) continue;
      for (const field of document.getFields(message.id, developer, source)) {
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
          key: `${message.id}:${field.key}${source === undefined ? "" : `:file:${source}`}`,
          name: `${message.id === 20 ? field.name : `${message.name}: ${field.name}`}${source === undefined ? "" : ` · ${document.sources[source].filename}`}`,
          label:
            message.id === 20 ? field.name : `${message.name}: ${field.name}`,
          units: field.units,
          axis: hasTime ? "time" : "sample",
          message: message.id,
          field: field.key,
          source,
          sourceName:
            source === undefined
              ? undefined
              : document.sources[source].filename,
        });
      }
    }
  }
  let modes = candidatesByDocument.get(document);
  if (!modes) candidatesByDocument.set(document, (modes = new Map()));
  modes.set(developer, output);
  return output;
}

const sensorInventories = new WeakMap<FitDocument, Map<boolean, Sensor[]>>();
const MIN_CHART_POINTS = 10;

export async function chartSensors(
  document: FitDocument,
  developer: boolean,
  job = idleJob(),
  keys?: readonly string[],
): Promise<Sensor[]> {
  const cached = sensorInventories.get(document)?.get(developer);
  if (cached) return cached;
  const requested = keys && new Set(keys);
  const candidates = sensors(document, developer).filter(
    (sensor) => !requested || requested.has(sensor.key),
  );
  const statistics = sampleStatistics(document, developer);
  const groups = new Map<
    string,
    { message: number; source?: number; fields: Sensor[] }
  >();
  for (const sensor of candidates) {
    if (statistics.has(sensor.key)) continue;
    const message = sensor.message!;
    const key = `${message}:${sensor.source ?? "all"}:${isMotionSensor(sensor)}`;
    const group = groups.get(key) ?? {
      message,
      source: sensor.source,
      fields: [],
    };
    group.fields.push(sensor);
    groups.set(key, group);
  }
  for (const { message, source, fields } of groups.values()) {
    if (isMotionSensor(fields[0])) {
      const counts = await motionStatistics(document, fields, developer, job);
      fields.forEach((field, i) => statistics.set(field.key, counts[i]));
      continue;
    }
    const counts = fields.map(() => new SampleStatistics());
    const reader = new NumericReader(
      document,
      fields.map((field) => field.field!),
      developer,
    );
    let index = 0;
    const ids = document.recordIds(message, source);
    for (const id of ids) {
      const record = document.index.records[id];
      const cells = reader.read(id);
      for (let field = 0; field < fields.length; field++) {
        const sensor = fields[field];
        if (sensor.axis === "time" && record.timestamp === undefined) continue;
        const cell = cells[field];
        if (!cell) continue;
        const value = cell[developer ? "raw" : "value"];
        const samples = Array.isArray(value) ? value : [value];
        const interpreted = Array.isArray(cell.value)
          ? cell.value
          : [cell.value];
        for (let i = 0; i < samples.length; i++)
          if (interpreted[i] !== null && interpreted[i] !== undefined)
            counts[field].add(samples[i]);
      }
      if (++index % 128 === 0) {
        job.progress(index, ids.length, "Counting chart samples");
        await job.yield();
      }
    }
    await job.yield();
    fields.forEach((field, i) => statistics.set(field.key, counts[i]));
  }
  const output = candidates.flatMap((sensor) => {
    const stats = statistics.get(sensor.key)!;
    return stats.count >= MIN_CHART_POINTS && stats.minimum < stats.maximum
      ? [{ ...sensor, pointCount: stats.count }]
      : [];
  });
  await job.yield();
  let modes = sensorInventories.get(document);
  if (!modes) sensorInventories.set(document, (modes = new Map()));
  if (!keys) modes.set(developer, output);
  return output;
}

export function downsample(
  points: ChartPoint[],
  width: number,
  detail?: ChartDetail,
): ChartPoint[] {
  const sampler = new PointSampler(chartPointBudget(width, detail));
  for (const point of points) sampler.add(point);
  return sampler.finish();
}

export async function* chartPoints(
  document: FitDocument,
  sensor: Sensor,
  developer: boolean,
  job: Job,
  range?: TimeRange,
): AsyncGenerator<ChartPoint> {
  if (isMotionSensor(sensor)) {
    yield* motionPoints(document, sensor, developer, job);
    return;
  }
  const [message, ...parts] = sensor.key.split(":");
  const field = sensor.field ?? parts.join(":");
  const reader = new NumericReader(document, [field], developer);
  const ids = document.recordIds(
    sensor.message ?? Number(message),
    sensor.source,
  );
  let sample = 0;
  let file = -1;
  let previous: number | undefined;
  let excluded = false;
  let emitted = false;
  const spans =
    sensor.axis === "time"
      ? await recordTimeSpans(document, ids, range, job)
      : [[0, ids.length]];
  for (const [from, to] of spans) {
    if (from > 0) excluded = true;
    for (let i = from; i < to; i++) {
      if (i % 512 === 0) {
        job.progress(i, ids.length, "Preparing chart data");
        await job.yield();
      }
      const record = document.index.records[ids[i]];
      if (sensor.axis === "time") {
        previous = i ? document.index.records[ids[i - 1]].timestamp : undefined;
        file = i ? document.index.records[ids[i - 1]].subfile : -1;
        if (!inTimeRange(record.timestamp, range)) {
          excluded = true;
          continue;
        }
      }
      const cell = reader.read(ids[i])[0];
      const value = cell?.[developer ? "raw" : "value"] ?? null;
      const values = Array.isArray(value) ? value : [value];
      const t = sensor.axis === "sample" ? sample : record.timestamp;
      if (excluded && emitted && t !== undefined)
        yield { time: t, value: null };
      excluded = false;
      if (
        t !== undefined &&
        previous !== undefined &&
        (file !== record.subfile ||
          (sensor.axis !== "sample" && t - previous > 10))
      )
        yield { time: t, value: null };
      for (const v of values) {
        const time = sensor.axis === "sample" ? sample++ : record.timestamp;
        if (time !== undefined) {
          yield {
            time,
            value: typeof v === "number" && Number.isFinite(v) ? v : null,
          };
          emitted = true;
        }
      }
      file = record.subfile;
      previous = t;
    }
  }
}

export async function chart(
  document: FitDocument,
  query: ChartQuery,
  job = idleJob(),
  full = false,
): Promise<ChartData> {
  const requestedMotion = sensors(document, query.developer).filter(
    (sensor) => query.sensors.includes(sensor.key) && isMotionSensor(sensor),
  );
  const statistics = sampleStatistics(document, query.developer);
  // A first unfiltered motion chart can collect its full-resolution statistics
  // in the same pass as the display envelope. Later inventory scans reuse them.
  const prepared =
    !full &&
    query.start === undefined &&
    query.end === undefined &&
    !hasTimeRange(query.dates) &&
    requestedMotion.some((sensor) => !statistics.has(sensor.key))
      ? await motionChart(document, requestedMotion, query, job)
      : undefined;
  const available = await chartSensors(
    document,
    query.developer,
    job,
    query.sensors.length ? query.sensors : undefined,
  );
  const selected = available.filter((s) => query.sensors.includes(s.key));
  const series: ChartData["series"] = {};
  let start = Infinity;
  let end = -Infinity;
  const motion = selected.filter(isMotionSensor);
  if (motion.length && !full) {
    const data =
      prepared && motion.length === requestedMotion.length
        ? prepared
        : await motionChart(
            document,
            motion,
            { ...query, ...intersectTimeRanges(query, query.dates) },
            job,
          );
    Object.assign(series, data.series);
    start = data.start;
    end = data.end;
  }
  const ordinary = selected.filter((s) => full || !isMotionSensor(s));
  const widths = full
    ? new Map<string, number>()
    : await displayWidths(document, ordinary, query, job);
  for (const sensor of ordinary) {
    const points: ChartPoint[] = [];
    const sampler = full
      ? undefined
      : new PointSampler(
          chartPointBudget(widths.get(sensor.key) ?? query.width, query.detail),
        );
    let accepted = false;
    const add = (point: ChartPoint) => {
      accepted = true;
      if (sampler) sampler.add(point);
      else points.push(point);
    };
    let excluded = false;
    if (sensor.axis === "sample" && hasTimeRange(query.dates)) {
      series[sensor.key] = points;
      continue;
    }
    for await (const point of chartPoints(
      document,
      sensor,
      query.developer,
      job,
      {
        ...intersectTimeRanges(query, query.dates),
        intervals: query.dates?.intervals,
      },
    )) {
      const { time } = point;
      if (
        !inTimeRange(time, query.dates) ||
        (query.start !== undefined && time < query.start) ||
        (query.end !== undefined && time > query.end)
      ) {
        excluded = true;
        continue;
      }
      if (excluded && accepted) add({ time, value: null });
      excluded = false;
      let numeric = point.value;
      if (
        numeric !== null &&
        ((query.filter?.min !== undefined && numeric < query.filter.min) ||
          (query.filter?.max !== undefined && numeric > query.filter.max))
      )
        numeric = null;
      add({ time, value: numeric });
      start = Math.min(start, time);
      end = Math.max(end, time);
    }
    series[sensor.key] = sampler ? sampler.finish() : points;
  }
  return {
    sensors: available,
    series,
    start: Number.isFinite(start) ? start : 0,
    end: Number.isFinite(end) ? end : 0,
  };
}

async function displayWidths(
  document: FitDocument,
  sensors: Sensor[],
  query: ChartQuery,
  job: Job,
): Promise<Map<string, number>> {
  const groups = new Map<string, { sensor: Sensor; weight: number }[]>();
  const visibility = new Map<string, number>();
  for (const sensor of sensors) {
    const message = sensor.message ?? Number(sensor.key.split(":")[0]);
    let weight = sensor.pointCount ?? 1;
    if (
      sensor.axis === "time" &&
      (query.start !== undefined ||
        query.end !== undefined ||
        hasTimeRange(query.dates))
    ) {
      const key = `${message}:${sensor.source ?? "all"}`;
      let fraction = visibility.get(key);
      if (fraction === undefined) {
        const ids = document.recordIds(message, sensor.source);
        let visible = 0;
        for (let i = 0; i < ids.length; i++) {
          const time = document.index.records[ids[i]].timestamp;
          if (
            time !== undefined &&
            (query.start === undefined || time >= query.start) &&
            (query.end === undefined || time <= query.end) &&
            inTimeRange(time, query.dates)
          )
            visible++;
          if (i % 1024 === 0) await job.yield();
        }
        fraction = visible / Math.max(1, ids.length);
        visibility.set(key, fraction);
      }
      weight *= fraction;
    }
    const identity = JSON.stringify([
      message,
      sensor.field,
      sensor.units,
      sensor.axis,
      sensor.label ?? sensor.name,
    ]);
    const group = groups.get(identity) ?? [];
    group.push({ sensor, weight });
    groups.set(identity, group);
  }
  const widths = new Map<string, number>();
  for (const group of groups.values()) {
    const total = group.reduce((sum, entry) => sum + entry.weight, 0);
    for (const { sensor, weight } of group)
      widths.set(
        sensor.key,
        total ? (query.width * weight) / total : query.width,
      );
  }
  return widths;
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
  dates?: TimeRange,
): AsyncGenerator<{
  message: number;
  subfile: number;
  route?: number;
  point?: Position & { name?: string };
}> {
  const maxGpsGapSeconds = 30;
  let route = -1;
  let previous: { subfile: number; time?: number } | undefined;
  let missingGps = false;
  const fields = new Map<
    number,
    {
      latitude: number;
      longitude: number;
      name?: number;
      timestamp?: number;
      keys: Set<string>;
      numericKeys: string[];
      reader: NumericReader;
    }
  >();
  for (const definition of document.index.definitions) {
    const info = positionFields(definition.message);
    if (info && !fields.has(definition.message)) {
      const keys = new Set(
        [
          info.latitude,
          info.longitude,
          info.timestamp,
          info.name,
          ...(definition.message === 20 ? [78, 2, 5] : []),
        ]
          .filter((id) => id !== undefined)
          .map(String),
      );
      const numericKeys = [...keys].filter(
        (key) => key !== String(info.timestamp),
      );
      fields.set(definition.message, {
        ...info,
        keys,
        numericKeys,
        reader: new NumericReader(document, numericKeys, false),
      });
    }
  }
  for (let id = 0; id < document.index.records.length; id++) {
    if (id % 512 === 0) {
      job.progress(id, document.index.records.length, "Preparing map data");
      await job.yield();
    }
    const record = document.index.records[id];
    const info = fields.get(record.definition.message);
    if (!info) continue;
    // Most GPS records carry an indexed timestamp; reject offscreen dates
    // before decoding coordinates, elevation or unrelated values.
    if (
      record.timestamp !== undefined &&
      !inTimeRange(record.timestamp, dates)
    ) {
      if (record.definition.message === 20) {
        previous = undefined;
        missingGps = false;
      }
      yield { message: record.definition.message, subfile: record.subfile };
      continue;
    }
    const cells =
      record.timestamp === undefined
        ? document.cells(id, true, info.keys)
        : Object.fromEntries(
            info.reader.read(id).map((cell, i) => [info.numericKeys[i], cell]),
          );
    const timestamp =
      info.timestamp === undefined
        ? undefined
        : cells[String(info.timestamp)]?.raw;
    const time =
      record.timestamp ??
      (typeof timestamp === "number" && Number.isFinite(timestamp)
        ? timestamp
        : undefined);
    if (!inTimeRange(time, dates)) {
      if (record.definition.message === 20) {
        previous = undefined;
        missingGps = false;
      }
      yield { message: record.definition.message, subfile: record.subfile };
      continue;
    }
    const coordinates = positionCoordinates(
      cells[String(info.latitude)]?.value,
      cells[String(info.longitude)]?.value,
    );
    if (!coordinates) {
      if (record.definition.message === 20) missingGps = true;
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
    if (record.definition.message === 20) {
      // Only bridge GPS dropouts whose valid endpoints prove a short gap.
      if (
        !previous ||
        previous.subfile !== record.subfile ||
        (previous.time !== undefined &&
          time !== undefined &&
          time < previous.time) ||
        (missingGps &&
          (previous.time === undefined ||
            time === undefined ||
            time - previous.time > maxGpsGapSeconds))
      )
        route++;
      previous = { subfile: record.subfile, time };
      missingGps = false;
    }
    yield {
      message: record.definition.message,
      subfile: record.subfile,
      ...(record.definition.message === 20 ? { route } : {}),
      point: {
        ...coordinates,
        time,
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
  dates?: TimeRange,
  playback?: MapPlaybackIndex,
): Promise<MapData> {
  const data: MapData = { tracks: [], points: [] };
  let track: Position[] = [];
  let route = -1;
  const finish = async () => {
    if (track.length) {
      await playback?.addTrack(track, data.tracks.length, job);
      data.tracks.push(full ? track : await simplify(track, 0.00002, job));
      if (document.sources.length > 1) {
        data.routeNames ??= [];
        data.routeNames.push(
          `${document.sourceName(document.index.records[track[0].record].subfile)} · Route ${data.tracks.length}`,
        );
      }
    }
    track = [];
  };
  let kilometre = 0;
  for await (const { message, route: nextRoute, point } of mapPositions(
    document,
    job,
    dates,
  )) {
    if (!point) continue;
    if (message === 20) {
      if (route !== nextRoute) {
        await finish();
        kilometre = 0;
      }
      route = nextRoute!;
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
