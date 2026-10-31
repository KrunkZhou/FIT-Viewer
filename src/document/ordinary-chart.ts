import type { ChartData, ChartQuery, Job, Sensor } from "../model";
import type { FitDocument } from "./document";
import { NumericReader } from "./numeric-reader";
import { PointSampler } from "./point-sampler";
import { chartPointBudget } from "./chart-sampling";
import { recordTimeSpans } from "./record-time-index";
import { SampleStatistics, sampleStatistics } from "./sample-statistics";
import { hasTimeRange, inTimeRange, intersectTimeRanges } from "./time-range";

/** Read sibling fields together and yield per batch rather than per sample. */
export async function ordinaryChart(
  document: FitDocument,
  selected: Sensor[],
  widths: Map<string, number>,
  query: ChartQuery,
  job: Job,
  bounds?: Map<string, [number, number]>,
): Promise<Pick<ChartData, "series" | "start" | "end">> {
  const groups = new Map<string, Sensor[]>();
  for (const sensor of selected) {
    const key = `${sensor.message}:${sensor.source ?? "all"}:${sensor.axis}`;
    const fields = groups.get(key) ?? [];
    fields.push(sensor);
    groups.set(key, fields);
  }
  const statistics = sampleStatistics(document, query.developer);
  const unfiltered =
    query.start === undefined &&
    query.end === undefined &&
    !hasTimeRange(query.dates);
  const range = {
    ...intersectTimeRanges(query, query.dates),
    intervals: query.dates?.intervals,
  };
  const series: ChartData["series"] = {};
  let start = Infinity;
  let end = -Infinity;
  for (const fields of groups.values()) {
    const first = fields[0];
    const timed = first.axis !== "sample";
    const ids = document.recordIds(first.message!, first.source);
    const reader = new NumericReader(
      document,
      fields.map((field) => field.field!),
      query.developer,
    );
    const states = fields.map((sensor) => ({
      sensor,
      sampler: new PointSampler(
        chartPointBudget(widths.get(sensor.key) ?? query.width, query.detail),
      ),
      stats:
        unfiltered && !statistics.has(sensor.key)
          ? new SampleStatistics()
          : undefined,
      sample: 0,
      previous: undefined as number | undefined,
      file: -1,
      emitted: false,
      excluded: false,
      start: Infinity,
      end: -Infinity,
    }));
    const spans =
      !timed && hasTimeRange(query.dates)
        ? []
        : timed
          ? await recordTimeSpans(document, ids, range, job)
          : [[0, ids.length]];
    for (const [from, to] of spans) {
      if (from > 0)
        states.forEach((state) => {
          state.excluded = true;
        });
      for (let i = from; i < to; i++) {
        if (i % 256 === 0) {
          job.progress(i, ids.length, "Preparing chart data");
          await job.yield();
        }
        const record = document.index.records[ids[i]];
        if (timed && !inTimeRange(record.timestamp, range)) {
          states.forEach((state) => {
            state.excluded = true;
          });
          continue;
        }
        const cells = reader.read(ids[i]);
        for (let field = 0; field < states.length; field++) {
          const state = states[field];
          const cell = cells[field];
          const raw = cell?.[query.developer ? "raw" : "value"] ?? null;
          const values = Array.isArray(raw) ? raw : [raw];
          const interpreted = Array.isArray(cell?.value)
            ? cell.value
            : [cell?.value];
          const t = timed ? record.timestamp : state.sample;
          const previous =
            timed && i
              ? document.index.records[ids[i - 1]].timestamp
              : state.previous;
          const file =
            timed && i
              ? document.index.records[ids[i - 1]].subfile
              : state.file;
          if (t !== undefined && inTimeRange(t, range)) {
            if (
              (state.excluded && state.emitted) ||
              (previous !== undefined &&
                (file !== record.subfile || (timed && t - previous > 10)))
            )
              state.sampler.add({ time: t, value: null });
            state.excluded = false;
          }
          for (let slot = 0; slot < values.length; slot++) {
            const time = timed ? record.timestamp : state.sample++;
            if (time === undefined) continue;
            if (interpreted[slot] !== null && interpreted[slot] !== undefined)
              state.stats?.add(values[slot]);
            if (!inTimeRange(time, range)) {
              state.excluded = true;
              continue;
            }
            if (state.excluded && state.emitted)
              state.sampler.add({ time, value: null });
            state.excluded = false;
            const value = values[slot];
            const numeric =
              typeof value === "number" &&
              Number.isFinite(value) &&
              (query.filter?.min === undefined || value >= query.filter.min) &&
              (query.filter?.max === undefined || value <= query.filter.max)
                ? value
                : null;
            state.sampler.add({ time, value: numeric, record: ids[i] });
            state.emitted = true;
            state.start = Math.min(state.start, time);
            state.end = Math.max(state.end, time);
          }
          state.previous = t;
          state.file = record.subfile;
        }
      }
    }
    await job.yield();
    for (const state of states) {
      if (state.stats) statistics.set(state.sensor.key, state.stats);
      const stats = statistics.get(state.sensor.key);
      if (!stats || stats.count < 10 || stats.minimum >= stats.maximum)
        continue;
      series[state.sensor.key] = state.sampler.finish();
      bounds?.set(state.sensor.key, [state.start, state.end]);
      start = Math.min(start, state.start);
      end = Math.max(end, state.end);
    }
  }
  return { series, start, end };
}
