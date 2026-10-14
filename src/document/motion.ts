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
import { chartPointBudget } from "./chart-sampling";

export { isMotionSensor } from "./chart-query";
type Location = { wire: WireField; offset: number };
function sampleCount(wire?: WireField): number {
  if (!wire) return 0;
  const type = wire.type & 31;
  if (type === 7) return 1;
  const width = WIDTHS[type];
  return width && wire.size % width === 0 ? wire.size / width : wire.size;
}
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
  interpretation?: { scale?: number; offset?: number },
): (number | null)[] {
  if (!location) return [];
  const raw = readValue(
    document.index.view,
    record.offset + location.offset,
    location.wire,
    record.definition.littleEndian,
  );
  // readValue owns this fresh array; interpreting it in place avoids a copy per axis packet.
  const samples = Array.isArray(raw) ? raw : [raw];
  const scale = interpretation?.scale ?? 1;
  const offset = interpretation?.offset ?? 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    samples[i] =
      typeof value === "number" && valid(value, location.wire.type)
        ? interpretation
          ? value / scale - offset
          : value
        : null;
  }
  return samples as (number | null)[];
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
  range?: ChartQuery,
): Generator<Packet> {
  for (const id of document.recordIds(message, source)) {
    const record = document.index.records[id];
    const locations = layout(record);
    const ms = values(document, record, locations.get(0))[0];
    const offsets = values(document, record, locations.get(1));
    const count = Math.max(
      offsets.length,
      ...fields.map((field) => sampleCount(locations.get(field.id)?.wire)),
    );
    const anchored =
      record.timestamp !== undefined && ms !== null && ms !== undefined;
    const times = Array.from({ length: count }, (_, i) =>
      anchored && typeof offsets[i] === "number"
        ? record.timestamp! + (ms! + offsets[i]!) / 1000
        : undefined,
    );
    const visible =
      !range ||
      times.some(
        (time) =>
          time !== undefined &&
          (range.start === undefined || time >= range.start) &&
          (range.end === undefined || time <= range.end) &&
          inTimeRange(time, range.dates),
      );
    yield {
      times,
      axes: visible
        ? fields.map((field) =>
            values(
              document,
              record,
              locations.get(field.id),
              developer ? undefined : field,
            ),
          )
        : [],
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
class Envelope {
  private points = new Map<number, MotionPoint>();
  private index = 0;
  private currentIndex = 0;
  private time = 0;
  private current?: MotionSample;
  private gapPoint?: MotionPoint;
  private first?: MotionSample;
  private minimum: (MotionSample | undefined)[];
  private maximum: (MotionSample | undefined)[];
  private gaps: (MotionPoint | undefined)[];
  private values: (number | null)[];
  constructor(
    private readonly size: number,
    private readonly axes: number,
    private readonly filter: ChartQuery["filter"],
  ) {
    this.minimum = Array(axes);
    this.maximum = Array(axes);
    this.gaps = Array(axes);
    this.values = Array(axes);
  }
  add(time: number, axes?: (number | null)[][], sample = 0): void {
    if (this.index && this.index % this.size === 0) this.flush();
    this.currentIndex = this.index;
    this.time = time;
    this.current = undefined;
    this.gapPoint = undefined;
    let missing = false;
    for (let axis = 0; axis < this.axes; axis++) {
      let value = axes?.[axis]?.[sample] ?? null;
      if (
        value !== null &&
        ((this.filter?.min !== undefined && value < this.filter.min) ||
          (this.filter?.max !== undefined && value > this.filter.max))
      )
        value = null;
      this.values[axis] = value;
      missing ||= value === null;
    }
    if (missing) {
      this.gapPoint = { time, index: this.index, values: [...this.values] };
      for (let axis = 0; axis < this.axes; axis++)
        if (this.values[axis] === null) this.gaps[axis] = this.gapPoint;
    }
    this.first ??= this.capture();
    for (let axis = 0; axis < this.axes; axis++) {
      const value = this.values[axis];
      if (value === null) continue;
      if (!this.minimum[axis] || value < this.minimum[axis]!.values[axis]!)
        this.minimum[axis] = this.capture();
      if (!this.maximum[axis] || value > this.maximum[axis]!.values[axis]!)
        this.maximum[axis] = this.capture();
    }
    this.index++;
  }
  private capture(): MotionSample {
    return (this.current ??= {
      ...(this.gapPoint ?? {
        time: this.time,
        index: this.currentIndex,
        values: [...this.values],
      }),
      gaps: [...this.gaps],
    });
  }
  private flush(): void {
    if (!this.first) return;
    // Snapshot only bucket endpoints and extrema, with exact values for every axis.
    for (const point of [
      this.first,
      ...this.minimum,
      ...this.maximum,
      this.capture(),
    ]) {
      if (!point) continue;
      this.points.set(point.index, point);
      for (const gap of point.gaps) if (gap) this.points.set(gap.index, gap);
    }
    this.first = undefined;
    this.minimum.fill(undefined);
    this.maximum.fill(undefined);
  }
  finish(): MotionPoint[] {
    this.flush();
    return [...this.points.values()].sort((a, b) => a.index - b.index);
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
  const capacity = chartPointBudget(query.width, query.detail);
  const series: Record<string, ChartPoint[]> = {};
  let start = Infinity;
  let end = -Infinity;
  const groups = new Map<string, Sensor[]>();
  for (const sensor of selected) {
    const message = sensor.message ?? Number(sensor.key.split(":")[0]);
    const family = Math.floor(
      (Number(sensor.field ?? sensor.key.split(":")[1]) - 2) / 3,
    );
    const key = `${message}:${family}:${sensor.source ?? "all"}`;
    const group = groups.get(key) ?? [];
    group.push(sensor);
    groups.set(key, group);
  }
  const plans: {
    chosen: Sensor[];
    message: number;
    source?: number;
    fields: FieldInfo[];
    ids: number[];
    count: number;
    family: string;
  }[] = [];
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
        ].map(sampleCount);
        count += Math.max(...samples) + 1;
      }
      if (i % 1024 === 0) await job.yield();
    }
    const family = `${message}:${Math.floor((fields[0].id - 2) / 3)}`;
    plans.push({ chosen, message, source, fields, ids, count, family });
  }
  const totals = new Map<string, number>();
  for (const plan of plans)
    totals.set(plan.family, (totals.get(plan.family) ?? 0) + plan.count);
  for (const { chosen, message, source, fields, ids, count, family } of plans) {
    if (!count) {
      chosen.forEach((sensor) => {
        series[sensor.key] = [];
      });
      continue;
    }
    const bucketCapacity = 2 * (fields.length + 1) ** 2;
    const share = Math.floor((capacity * count) / totals.get(family)!);
    const sharedCapacity = Math.max(share, bucketCapacity);
    const buckets = Math.max(1, Math.floor(sharedCapacity / bucketCapacity));
    const size =
      count <= sharedCapacity ? 1 : Math.max(1, Math.ceil(count / buckets));
    const envelope = new Envelope(size, fields.length, query.filter);
    const timeline = new Timeline();
    let excluded = false;
    let index = 0;
    for (const packet of packets(
      document,
      message,
      fields,
      query.developer,
      source,
      query,
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
          envelope.add(time);
        }
        envelope.add(time, packet.axes, sample);
        excluded = false;
      }
      if (++index % 64 === 0) {
        job.progress(index, ids.length, "Preparing motion samples");
        await job.yield();
      }
    }
    // Keep the union of every axis's extrema, with exact companion values from
    // the same source sample. Independent timestamps leave XYZ tooltips sparse.
    const retained = envelope.finish();
    chosen.forEach((sensor, axis) => {
      series[sensor.key] = retained.map((sample) => ({
        time: sample.time,
        value: sample.values[axis] ?? null,
      }));
    });
  }
  return { series, start, end };
}
