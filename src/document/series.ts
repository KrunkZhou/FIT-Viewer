import type {
  ChartData,
  ChartPoint,
  ChartQuery,
  ChartDetail,
  Job,
  MapData,
  Position,
  Sensor,
  RawValue,
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
import { ordinaryChart } from "./ordinary-chart";
import { MapTrack } from "./map-track";
import { Profile } from "@garmin/fitsdk";
import { valid } from "../protocol/binary";

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
          (!developer &&
            !field.developer &&
            Profile.messages[message.id]?.fields[field.id]?.subFields.length) ||
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
    yield* motionPoints(document, sensor, developer, job, range);
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
  bounds?: Map<string, [number, number]>,
): Promise<ChartData> {
  const requestedOrdinary = sensors(document, query.developer).filter(
    (sensor) => query.sensors.includes(sensor.key) && !isMotionSensor(sensor),
  );
  let ordinaryPrepared: Awaited<ReturnType<typeof ordinaryChart>> | undefined;
  if (!full && requestedOrdinary.length) {
    const identities = new Set<string>();
    let sharedBudget = false;
    for (const sensor of requestedOrdinary) {
      const identity = JSON.stringify([
        sensor.message,
        sensor.field,
        sensor.units,
        sensor.axis,
        sensor.label ?? sensor.name,
      ]);
      if (identities.has(identity)) sharedBudget = true;
      identities.add(identity);
    }
    if (
      sharedBudget ||
      query.start !== undefined ||
      query.end !== undefined ||
      hasTimeRange(query.dates)
    )
      await chartSensors(
        document,
        query.developer,
        job,
        requestedOrdinary.map((sensor) => sensor.key),
      );
    const statistics = sampleStatistics(document, query.developer);
    const selected = requestedOrdinary.map((sensor) => ({
      ...sensor,
      pointCount: statistics.get(sensor.key)?.count,
    }));
    ordinaryPrepared = await ordinaryChart(
      document,
      selected,
      await displayWidths(document, selected, query, job),
      query,
      job,
      bounds,
    );
  }
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
  let start = ordinaryPrepared?.start ?? Infinity;
  let end = ordinaryPrepared?.end ?? -Infinity;
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
    start = Math.min(start, data.start);
    end = Math.max(end, data.end);
  }
  if (ordinaryPrepared) Object.assign(series, ordinaryPrepared.series);
  for (const sensor of full ? selected : []) {
    const points: ChartPoint[] = [];
    let accepted = false;
    const add = (point: ChartPoint) => {
      accepted = true;
      points.push(point);
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
    series[sensor.key] = points;
  }
  return {
    sensors: query.sensors.length ? selected : available,
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
        const spans = await recordTimeSpans(
          document,
          ids,
          {
            ...intersectTimeRanges(query, query.dates),
            intervals: query.dates?.intervals,
          },
          job,
        );
        for (const [from, to] of spans)
          for (let i = from; i < to; i++) {
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

interface MapEntry {
  message: number;
  subfile: number;
  route?: number;
  point?: Position & { name?: string };
}
async function positionRecordIds(
  document: FitDocument,
  job: Job,
  dates?: TimeRange,
  messages?: ReadonlySet<number>,
): Promise<{ ids: Generator<number>; gaps: Set<number> }> {
  const gaps = new Set<number>();
  const lists = [...document.index.messages]
    .filter(
      ([message]) =>
        (!messages || messages.has(message)) && positionFields(message),
    )
    .map(([message, ids]) => ({ message, ids }));
  const iterators: Generator<number>[] = [];
  for (const { message, ids } of lists) {
    const spans =
      message === 20
        ? await recordTimeSpans(document, ids, dates, job)
        : [[0, ids.length]];
    function* selected() {
      let previousEnd = 0;
      for (const [from, to] of spans) {
        // A skipped time block must still break the displayed route.
        if (message === 20 && from > previousEnd) gaps.add(ids[from]);
        for (let i = from; i < to; i++) yield ids[i];
        previousEnd = to;
      }
    }
    iterators.push(selected());
  }
  function* merge() {
    if (iterators.length === 1) {
      yield* iterators[0];
      return;
    }
    const heads = iterators.map(
      (iterator) => iterator.next().value ?? Infinity,
    );
    for (;;) {
      let next = Infinity,
        chosen = -1;
      for (let i = 0; i < heads.length; i++)
        if (heads[i] < next) {
          next = heads[i];
          chosen = i;
        }
      if (chosen < 0) return;
      yield next;
      heads[chosen] = iterators[chosen].next().value ?? Infinity;
    }
  }
  return { ids: merge(), gaps };
}
async function* mapPositionBatches(
  document: FitDocument,
  job: Job,
  dates?: TimeRange,
  messages?: ReadonlySet<number>,
): AsyncGenerator<MapEntry[]> {
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
      values: (RawValue | undefined)[];
      latitudeSlot: number;
      longitudeSlot: number;
      elevationSlot: number;
      altitudeSlot: number;
      distanceSlot: number;
      nameSlot: number;
    }
  >();
  for (const definition of document.index.definitions) {
    const info = positionFields(definition.message);
    if (
      info &&
      (!messages || messages.has(definition.message)) &&
      !fields.has(definition.message)
    ) {
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
        values: [],
        latitudeSlot: numericKeys.indexOf(String(info.latitude)),
        longitudeSlot: numericKeys.indexOf(String(info.longitude)),
        elevationSlot: numericKeys.indexOf("78"),
        altitudeSlot: numericKeys.indexOf("2"),
        distanceSlot: numericKeys.indexOf("5"),
        nameSlot: numericKeys.indexOf(String(info.name)),
      });
    }
  }
  let batch: MapEntry[] = [];
  let count = 0;
  const selected = await positionRecordIds(document, job, dates, messages);
  for (const id of selected.ids) {
    if (selected.gaps.has(id)) {
      previous = undefined;
      missingGps = false;
    }
    if (count++ % 512 === 0) {
      if (batch.length) {
        yield batch;
        batch = [];
      }
      job.progress(id, document.index.records.length, "Preparing map data");
      await job.yield();
    }
    const record = document.index.records[id];
    const info = fields.get(record.definition.message);
    if (!info) continue;
    // Most GPS records carry an indexed timestamp; reject offscreen dates
    // before decoding coordinates, elevation or unrelated values.
    if (
      info.timestamp === 253 &&
      record.timestamp !== undefined &&
      !inTimeRange(record.timestamp, dates)
    ) {
      if (record.definition.message === 20) {
        previous = undefined;
        missingGps = false;
      }
      batch.push({
        message: record.definition.message,
        subfile: record.subfile,
      });
      continue;
    }
    const values = info.values;
    let time = info.timestamp === 253 ? record.timestamp : undefined;
    if (time === undefined) {
      const cells = document.cells(id, true, info.keys);
      for (let i = 0; i < info.numericKeys.length; i++)
        values[i] = cells[info.numericKeys[i]]?.value;
      const timestamp =
        info.timestamp === undefined
          ? undefined
          : cells[String(info.timestamp)]?.raw;
      if (
        typeof timestamp === "number" &&
        valid(timestamp, 6) &&
        cells[String(info.timestamp)]?.value !== null
      )
        time = timestamp;
    } else info.reader.values(id, values);
    if (!inTimeRange(time, dates)) {
      if (record.definition.message === 20) {
        previous = undefined;
        missingGps = false;
      }
      batch.push({
        message: record.definition.message,
        subfile: record.subfile,
      });
      continue;
    }
    const coordinates = positionCoordinates(
      values[info.latitudeSlot],
      values[info.longitudeSlot],
    );
    if (!coordinates) {
      if (record.definition.message === 20) missingGps = true;
      batch.push({
        message: record.definition.message,
        subfile: record.subfile,
      });
      continue;
    }
    const elevation =
      record.definition.message === 20
        ? (values[info.elevationSlot] ?? values[info.altitudeSlot])
        : undefined;
    const distance =
      record.definition.message === 20 ? values[info.distanceSlot] : undefined;
    const name = values[info.nameSlot];
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
    batch.push({
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
    });
  }
  if (batch.length) yield batch;
}

export async function* mapPositions(
  document: FitDocument,
  job: Job,
  dates?: TimeRange,
  messages?: ReadonlySet<number>,
): AsyncGenerator<MapEntry> {
  for await (const batch of mapPositionBatches(document, job, dates, messages))
    yield* batch;
}

export async function mapData(
  document: FitDocument,
  job = idleJob(),
  full = false,
  dates?: TimeRange,
  playback?: MapPlaybackIndex,
): Promise<MapData> {
  const data: MapData = { tracks: [], points: [] };
  let track = new MapTrack();
  let route = -1;
  const finish = async () => {
    if (track.length) {
      if (playback) await track.playback(playback, data.tracks.length, job);
      data.tracks.push(await track.display(full, job));
      if (document.sources.length > 1) {
        data.routeNames ??= [];
        data.routeNames.push(
          `${document.sourceName(document.index.records[track.point(0).record].subfile)} · Route ${data.tracks.length}`,
        );
      }
    }
    track = new MapTrack();
  };
  let kilometre = 0;
  for await (const batch of mapPositionBatches(document, job, dates)) {
    for (const { message, route: nextRoute, point } of batch) {
      if (!point) continue;
      if (message === 20) {
        if (route !== nextRoute) {
          await finish();
          kilometre = 0;
        }
        route = nextRoute!;
        track.add(point);
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
        data.points.push({
          ...point,
          message,
          kind: message === 19 ? "lap" : "waypoint",
        });
      }
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
    const subfile = document.index.records[point.record].subfile;
    const route = data.tracks.findIndex((segment) => {
      const start = segment[0];
      const end = segment.at(-1)!;
      if (document.index.records[start.record].subfile !== subfile)
        return false;
      if (point.kind === "lap")
        return (
          point.time !== undefined &&
          start.time !== undefined &&
          end.time !== undefined &&
          point.time >= start.time &&
          point.time <= end.time
        );
      return point.record >= start.record && point.record <= end.record;
    });
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
