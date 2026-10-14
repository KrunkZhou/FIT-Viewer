import type {
  ChartPoint,
  ChartQuery,
  Definition,
  FieldInfo,
  Job,
  RecordRef,
  Sensor,
  WireField,
} from "../model";
import { readValue, valid, WIDTHS } from "../protocol/binary";
import type { FitDocument } from "./document";
import { SampleStatistics } from "./sample-statistics";
import { hasTimeRange, inTimeRange } from "./time-range";

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
type Location = { wire: WireField; offset: number };
const layouts = new WeakMap<Definition, Map<boolean, Map<number, Location>>>();
function layout(record: RecordRef): Map<number, Location> {
  let cached = layouts.get(record.definition);
  if (!cached) layouts.set(record.definition, (cached = new Map()));
  let fields = cached.get(record.compressed);
  if (!fields) {
    fields = new Map();
    let offset = 1;
    for (const wire of record.definition.fields) {
      if (record.compressed && wire.id === 253 && wire.developer === undefined)
        continue;
      if (wire.developer === undefined) fields.set(wire.id, { wire, offset });
      offset += wire.size;
    }
    cached.set(record.compressed, fields);
  }
  return fields;
}
function values(
  document: FitDocument,
  record: RecordRef,
  location?: Location,
): (number | null)[] {
  if (!location) return [];
  const raw = readValue(
    document.index.view,
    record.offset + location.offset,
    location.wire,
    record.definition.littleEndian,
  );
  return (Array.isArray(raw) ? raw : [raw]).map((value) =>
    typeof value === "number" && valid(value, location.wire.type)
      ? value
      : null,
  );
}
interface Packet {
  times: (number | undefined)[];
  axes: (number | null)[][];
  subfile: number;
}
function* packets(
  document: FitDocument,
  message: number,
  fields: FieldInfo[],
  developer: boolean,
  source?: number,
): Generator<Packet> {
  for (const id of document.recordIds(message, source)) {
    const record = document.index.records[id];
    const locations = layout(record);
    const ms = values(document, record, locations.get(0))[0];
    const offsets = values(document, record, locations.get(1));
    const axes = fields.map((field) =>
      values(document, record, locations.get(field.id)).map((value) =>
        value === null || developer
          ? value
          : value / (field.scale ?? 1) - (field.offset ?? 0),
      ),
    );
    const count = Math.max(offsets.length, ...axes.map((axis) => axis.length));
    const anchored =
      record.timestamp !== undefined && ms !== null && ms !== undefined;
    yield {
      times: Array.from({ length: count }, (_, i) =>
        anchored && typeof offsets[i] === "number"
          ? record.timestamp! + (ms! + offsets[i]!) / 1000
          : undefined,
      ),
      axes,
      subfile: record.subfile,
    };
  }
}
class Timeline {
  private previous?: number;
  private subfile = -1;
  private missing = false;
  next(time: number | undefined, subfile: number): boolean | undefined {
    if (time === undefined) {
      this.missing = true;
      return;
    }
    const gap =
      this.previous !== undefined &&
      (this.missing ||
        subfile !== this.subfile ||
        time < this.previous ||
        time - this.previous > 10);
    this.previous = time;
    this.subfile = subfile;
    this.missing = false;
    return gap;
  }
}
export async function motionStatistics(
  document: FitDocument,
  sensors: Sensor[],
  developer: boolean,
  job: Job,
): Promise<SampleStatistics[]> {
  const first = sensors[0];
  const message = first.message ?? Number(first.key.split(":")[0]);
  const inventory = document.getFields(message, developer, first.source);
  const fields = sensors.map((sensor) =>
    inventory.find((field) => field.key === sensor.field)!,
  );
  const statistics = sensors.map(() => new SampleStatistics());
  let index = 0;
  const count = document.recordIds(message, first.source).length;
  // Decode all axes in a packet together, without retaining expanded samples.
  for (const packet of packets(
    document,
    message,
    fields,
    developer,
    first.source,
  )) {
    for (let axis = 0; axis < fields.length; axis++)
      for (let i = 0; i < packet.axes[axis].length; i++)
        if (packet.times[i] !== undefined)
          statistics[axis].add(packet.axes[axis][i]);
    if (++index % 64 === 0) {
      job.progress(index, count, "Counting motion samples");
      await job.yield();
    }
  }
  await job.yield();
  return statistics;
}
export async function* motionPoints(
  document: FitDocument,
  sensor: Sensor,
  developer: boolean,
  job: Job,
): AsyncGenerator<ChartPoint> {
  const [keyMessage, keyField] = sensor.key.split(":");
  const message = sensor.message ?? Number(keyMessage);
  const field = Number(sensor.field ?? keyField);
  const info = document
    .getFields(message, developer, sensor.source)
    .find((f) => f.id === field)!;
  const timeline = new Timeline();
  let index = 0;
  const count = document.recordIds(message, sensor.source).length;
  for (const packet of packets(
    document,
    message,
    [info],
    developer,
    sensor.source,
  )) {
    for (let i = 0; i < packet.times.length; i++) {
      const time = packet.times[i];
      const gap = timeline.next(time, packet.subfile);
      if (time === undefined) continue;
      if (gap) yield { time, value: null };
      yield { time, value: packet.axes[0][i] ?? null };
    }
    if (++index % 64 === 0) {
      job.progress(index, count, "Preparing motion samples");
      await job.yield();
    }
  }
}
interface MotionPoint {
  time: number;
  values: (number | null)[];
  index: number;
}
interface MotionSample extends MotionPoint {
  gaps: (MotionPoint | undefined)[];
}
interface EnvelopePoint extends ChartPoint {
  sample: MotionSample;
}
interface Candidate {
  point: EnvelopePoint;
  index: number;
  segment: number;
  gap?: EnvelopePoint;
}
class Envelope {
  readonly points: EnvelopePoint[] = [];
  private index = 0;
  private segment = 0;
  private gap?: EnvelopePoint;
  private previous?: Candidate;
  private first?: Candidate;
  private last?: Candidate;
  private minimum?: Candidate;
  private maximum?: Candidate;
  constructor(private readonly size: number) {}
  add(sample: MotionSample, axis: number): void {
    if (this.index && this.index % this.size === 0) this.flush();
    const value = sample.values[axis] ?? null;
    const point = { time: sample.time, value, sample };
    if (value === null) {
      this.segment++;
      this.gap = point;
    }
    const candidate = {
      point,
      index: this.index++,
      segment: this.segment,
      gap: this.gap,
    };
    this.first ??= candidate;
    this.last = candidate;
    if (value !== null) {
      if (!this.minimum || value < this.minimum.point.value!)
        this.minimum = candidate;
      if (!this.maximum || value > this.maximum.point.value!)
        this.maximum = candidate;
    }
  }
  private flush(): void {
    const keep = new Map<number, Candidate>();
    for (const candidate of [this.first, this.minimum, this.maximum, this.last])
      if (candidate) keep.set(candidate.index, candidate);
    for (const candidate of [...keep.values()].sort(
      (a, b) => a.index - b.index,
    )) {
      if (
        this.previous?.point.value !== null &&
        this.previous !== undefined &&
        candidate.point.value !== null &&
        candidate.segment !== this.previous.segment &&
        candidate.gap
      )
        this.points.push(candidate.gap);
      this.points.push(candidate.point);
      this.previous = candidate;
    }
    this.first = this.last = this.minimum = this.maximum = undefined;
  }
  finish(): EnvelopePoint[] {
    this.flush();
    return this.points;
  }
}
export async function motionChart(
  document: FitDocument,
  selected: Sensor[],
  query: ChartQuery,
  job: Job,
): Promise<{
  series: Record<string, ChartPoint[]>;
  start: number;
  end: number;
}> {
  const capacity = Math.max(8, Math.min(8192, Math.round(query.width) * 2));
  const series: Record<string, ChartPoint[]> = {};
  let start = Infinity;
  let end = -Infinity;
  const groups = new Map<string, Sensor[]>();
  for (const sensor of selected) {
    const message = sensor.message ?? Number(sensor.key.split(":")[0]);
    const key = `${message}:${sensor.source ?? "all"}`;
    const group = groups.get(key) ?? [];
    group.push(sensor);
    groups.set(key, group);
  }
  for (const chosen of groups.values()) {
    const message = chosen[0].message ?? Number(chosen[0].key.split(":")[0]);
    const source = chosen[0].source;
    const fields = chosen.map((sensor) =>
      document
        .getFields(message, query.developer, source)
        .find(
          (field) => field.key === (sensor.field ?? sensor.key.split(":")[1]),
        )!,
    );
    const ids = document.recordIds(message, source);
    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      const record = document.index.records[ids[i]];
      const locations = layout(record);
      if (
        query.start !== undefined ||
        query.end !== undefined ||
        hasTimeRange(query.dates)
      ) {
        const ms = values(document, record, locations.get(0))[0];
        if (record.timestamp !== undefined && ms !== null && ms !== undefined) {
          const visible = values(document, record, locations.get(1)).filter(
            (offset) => {
              if (offset === null) return false;
              const time = record.timestamp! + (ms + offset) / 1000;
              return (
                (query.start === undefined || time >= query.start) &&
                (query.end === undefined || time <= query.end) &&
                inTimeRange(time, query.dates)
              );
            },
          ).length;
          if (visible) count += visible + 1;
        }
      } else {
        const samples = [
          locations.get(1)?.wire,
          ...fields.map((field) => locations.get(field.id)?.wire),
        ].map((wire) => (wire ? Math.floor(wire.size / WIDTHS[wire.type]) : 0));
        count += Math.max(...samples) + 1;
      }
      if (i % 1024 === 0) await job.yield();
    }
    const bucketCapacity = 2 * (fields.length + 1) ** 2;
    const sharedCapacity = Math.max(capacity, bucketCapacity);
    const buckets = Math.max(1, Math.floor(sharedCapacity / bucketCapacity));
    const size =
      count <= sharedCapacity ? 1 : Math.max(1, Math.ceil(count / buckets));
    const envelopes = fields.map(() => new Envelope(size));
    const timeline = new Timeline();
    let excluded = false;
    let sampleIndex = 0;
    const gaps: (MotionPoint | undefined)[] = fields.map(() => undefined);
    const sampleAt = (
      time: number,
      values: (number | null)[],
    ): MotionSample => {
      const point = { time, values, index: sampleIndex++ };
      values.forEach((value, axis) => {
        if (value === null) gaps[axis] = point;
      });
      return { ...point, gaps: [...gaps] };
    };
    let index = 0;
    for (const packet of packets(
      document,
      message,
      fields,
      query.developer,
      source,
    )) {
      for (let sample = 0; sample < packet.times.length; sample++) {
        const time = packet.times[sample];
        const gap = timeline.next(time, packet.subfile);
        if (
          time === undefined ||
          (query.start !== undefined && time < query.start) ||
          (query.end !== undefined && time > query.end) ||
          !inTimeRange(time, query.dates)
        ) {
          excluded = true;
          continue;
        }
        start = Math.min(start, time);
        end = Math.max(end, time);
        if (gap || excluded) {
          const marker = sampleAt(
            time,
            fields.map(() => null),
          );
          envelopes.forEach((envelope, axis) => envelope.add(marker, axis));
        }
        const values: (number | null)[] = [];
        for (let axis = 0; axis < fields.length; axis++) {
          let value = packet.axes[axis][sample] ?? null;
          if (
            value !== null &&
            ((query.filter?.min !== undefined && value < query.filter.min) ||
              (query.filter?.max !== undefined && value > query.filter.max))
          )
            value = null;
          values.push(value);
        }
        const point = sampleAt(time, values);
        envelopes.forEach((envelope, axis) => envelope.add(point, axis));
        excluded = false;
      }
      if (++index % 64 === 0) {
        job.progress(index, ids.length, "Preparing motion samples");
        await job.yield();
      }
    }
    // Keep the union of every axis's extrema, with exact companion values from
    // the same source sample. Independent timestamps leave XYZ tooltips sparse.
    const samples = new Map<number, MotionPoint>();
    for (const envelope of envelopes)
      for (const point of envelope.finish()) {
        samples.set(point.sample.index, point.sample);
        for (const gap of point.sample.gaps)
          if (gap) samples.set(gap.index, gap);
      }
    const retained = [...samples.values()].sort((a, b) => a.index - b.index);
    chosen.forEach((sensor, axis) => {
      series[sensor.key] = retained.map((sample) => ({
        time: sample.time,
        value: sample.values[axis] ?? null,
      }));
    });
  }
  return { series, start, end };
}
