import type { ExportQuery, ExportResult, FieldInfo, RawValue } from "../model";
import { FitDocument } from "../document/document";
import { chartPoints, mapPositions, sensors } from "../document/series";
import { timestampIso, HOUR_CYCLE } from "../protocol/time";
import { idleJob } from "../protocol/reader";
import { repair } from "../repair/repair";
import { exportGeoJson } from "./geojson";
import { repairArchive } from "./archive";
import { hasTimeRange, inTimeRange } from "../document/time-range";
import { applyCiqEdits } from "../protocol/ciq-edit";
import { readCiqSettings } from "../protocol/ciq-settings";
import { writeCiqSettings } from "../protocol/ciq-write";
import { ExportOutput } from "./output";
import { CsvRows } from "./csv-rows";
import { exportBase } from "./filename";

export const escapeCsv = (value: string): string =>
  /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
const xml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
const json = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
function scalePrecision(scale = 1): number | undefined {
  if (!Number.isSafeInteger(scale) || scale < 1) return undefined;
  let twos = 0;
  let fives = 0;
  while (scale % 2 === 0) {
    scale /= 2;
    twos++;
  }
  while (scale % 5 === 0) {
    scale /= 5;
    fives++;
  }
  return scale === 1 ? Math.max(twos, fives) : undefined;
}

export async function exportDocument(
  document: FitDocument,
  query: ExportQuery,
  job = idleJob(),
  stream?: WritableStream<Uint8Array>,
): Promise<ExportResult> {
  const output = new ExportOutput(stream);
  try {
    job.signal.throwIfAborted();
    const result = await formatDocument(
      document,
      query,
      output.job(job),
      output,
    );
    return { ...result, streamed: Boolean(stream) };
  } catch (error) {
    await output.abort(error);
    throw error;
  }
}

async function formatDocument(
  document: FitDocument,
  query: ExportQuery,
  job: import("../model").Job,
  parts: ExportOutput,
): Promise<ExportResult> {
  if (query.format === "set") {
    const settings = query.settings;
    const file = document.ciqSettings.find(
      (file) => file.source === settings?.source,
    );
    if (!settings || !file)
      throw new Error("The settings file is unavailable.");
    const source = document.sources[file.source];
    const bytes = settings.edits.length
      ? await writeCiqSettings(
          applyCiqEdits(file.settings, settings.edits),
          job,
        )
      : document.index.bytes.subarray(source.start, source.end);
    await readCiqSettings(bytes, job);
    parts.push(bytes as Uint8Array<ArrayBuffer>);
    return {
      blob: await parts.finish("application/octet-stream"),
      filename: file.filename.split(/[\\/]/).pop()!,
    };
  }
  if (query.format === "geojson")
    return exportGeoJson(document, job, query.dates, parts);
  const base = exportBase(document.filename);
  const encoder = new TextEncoder();
  if (query.format === "fit") {
    if (document.ciqSettings.length && !document.index.subfiles.length)
      throw new Error("CIQ settings files cannot be repaired as FIT files.");
    if (document.sources.length > 1) return repairArchive(document, job, parts);
    const result = await repair(document, job);
    parts.push(result.bytes as Uint8Array<ArrayBuffer>);
    return {
      blob: await parts.finish("application/octet-stream"),
      filename: `${base}-fixed.fit`,
      partial: result.partial,
      generated: result.generated,
      unresolved: result.unresolved,
    };
  }
  if (query.format === "csv") {
    const message = query.message ?? 20;
    const developer = Boolean(query.developer);
    const fields = document.getFields(message, developer);
    const ids = document.index.messages.get(message) ?? [];
    const rows = new CsvRows(document, fields, developer);
    const combined = document.sources.length > 1;
    const dateOptions: Intl.DateTimeFormatOptions = {
      hourCycle: HOUR_CYCLE,
      timeZone: query.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    };
    const dateFormat = new Intl.DateTimeFormat(query.locale, dateOptions);
    const wallClockFormat = new Intl.DateTimeFormat(query.locale, {
      ...dateOptions,
      timeZone: "UTC",
    });
    const formatters = new WeakMap<FieldInfo, (value: RawValue) => string>();
    const formatter = (info: FieldInfo): ((value: RawValue) => string) => {
      const existing = formatters.get(info);
      if (existing) return existing;
      const decimals =
        info.units === "deg" ||
        info.type === "float32" ||
        info.type === "float64"
          ? undefined
          : scalePrecision(info.scale);
      const cast = (value: RawValue): string => {
        if (value === null) return "";
        if (Array.isArray(value)) return `[${value.map(cast).join(", ")}]`;
        if (
          !developer &&
          (info.type === "dateTime" || info.type === "localDateTime") &&
          typeof value === "string" &&
          query.timeFormat === "localized"
        )
          return info.type === "localDateTime"
            ? wallClockFormat.format(new Date(`${value}Z`))
            : dateFormat.format(new Date(value));
        if (!developer && typeof value === "number") {
          if (decimals === undefined || decimals > 20) return String(value);
          const text = value.toFixed(decimals);
          return decimals > 0 && text.includes(".")
            ? text.replace(/0+$/, "").replace(/\.$/, "")
            : text;
        }
        return String(value);
      };
      formatters.set(info, cast);
      return cast;
    };
    parts.push(
      encoder.encode(
        [
          ...(combined ? ["Source file"] : []),
          ...fields.map((f) => escapeCsv(f.name)),
        ].join(","),
      ),
    );
    const batchSize = Math.max(
      1,
      Math.min(256, Math.floor(4096 / Math.max(1, fields.length))),
    );
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      const lines: string[] = [];
      for (const id of ids.slice(offset, offset + batchSize)) {
        const values = rows
          .read(id)
          .map(({ value, info }) => escapeCsv(formatter(info)(value)))
          .join(",");
        const source = document.sourceName(document.index.records[id].subfile);
        lines.push(`${combined ? `${escapeCsv(source)},` : ""}${values}`);
      }
      parts.push(encoder.encode(`\n${lines.join("\n")}`));
      job.progress(
        Math.min(ids.length, offset + batchSize),
        ids.length,
        "Exporting CSV",
      );
      await job.yield();
    }
    return {
      blob: await parts.finish("text/csv;charset=utf-8"),
      filename: `${base}-${message}.csv`,
    };
  }
  if (query.format === "gpx") {
    parts.push(
      `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="FIT Viewer" xmlns="http://www.topografix.com/GPX/1/1">`,
    );
    const point = (
      p: {
        lat: number;
        lon: number;
        time?: number;
        elevation?: number;
        name?: string;
      },
      tag: string,
    ) => {
      const time = p.time === undefined ? null : timestampIso(p.time);
      return `<${tag} lat="${p.lat}" lon="${p.lon}">${p.elevation !== undefined ? `<ele>${p.elevation}</ele>` : ""}${time !== null ? `<time>${time}</time>` : ""}${p.name ? `<name>${xml(p.name)}</name>` : ""}</${tag}>`;
    };
    const waypoints = new Set(
      [...document.index.messages.keys()].filter(
        (message) => message !== 20 && (message !== 19 || query.withLaps),
      ),
    );
    for await (const entry of mapPositions(
      document,
      job,
      query.dates,
      waypoints,
    ))
      if (
        entry.point &&
        entry.message !== 20 &&
        (entry.message !== 19 || query.withLaps)
      )
        parts.push(point(entry.point, "wpt"));
    parts.push(`<trk><name>${xml(base)}</name>`);
    let segment = false;
    let route: number | undefined;
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) {
        parts.push(batch.join(""));
        batch = [];
      }
    };
    for await (const entry of mapPositions(
      document,
      job,
      query.dates,
      new Set([20]),
    )) {
      if (entry.message !== 20) continue;
      const p = entry.point;
      if (!p) continue;
      if (segment && route !== entry.route) {
        flush();
        parts.push("</trkseg>");
        segment = false;
      }
      if (!segment) {
        parts.push("<trkseg>");
        segment = true;
      }
      batch.push(point(p, "trkpt"));
      route = entry.route;
      if (batch.length >= 256) {
        flush();
        await job.yield();
      }
    }
    flush();
    if (segment) parts.push("</trkseg>");
    parts.push("</trk></gpx>");
    return {
      blob: await parts.finish("application/gpx+xml"),
      filename: `${base}.gpx`,
    };
  }
  if (query.format === "hrv") {
    let completed = 0;
    const total = document.index.subfiles.length;
    const groups = Array.from({ length: total }, () => ({
      hrv: [] as number[],
      hr: [] as number[],
    }));
    for (const [message, key] of [
      [78, "hrv"],
      [132, "hr"],
    ] as const) {
      const ids = document.recordIds(message);
      for (let i = 0; i < ids.length; i++) {
        groups[document.index.records[ids[i]].subfile][key].push(ids[i]);
        if (i % 512 === 0) await job.yield();
      }
    }
    for (const group of groups) {
      const ids = group.hrv;
      for (let offset = 0; offset < ids.length; offset += 256) {
        const lines = ids.slice(offset, offset + 256).flatMap((id) => {
          const value = document.cells(id)["0"]?.value;
          return (Array.isArray(value) ? value : [value])
            .filter((v): v is number => typeof v === "number" && v > 0)
            .map((v) => String(v * 1000));
        });
        if (lines.length) parts.push(`${lines.join("\n")}\n`);
        job.progress(
          completed + Math.min(offset + 256, ids.length) / ids.length,
          total,
          "Exporting RR intervals",
        );
        await job.yield();
      }
      if (!ids.length) {
        let previous: number | undefined;
        for (const id of group.hr) {
          const values = document.cells(id)["9"]?.value;
          for (const value of Array.isArray(values) ? values : [values]) {
            if (typeof value !== "number") continue;
            if (previous !== undefined && value > previous)
              parts.push(`${(value - previous) * 1000}\n`);
            previous = value;
          }
          await job.yield();
        }
      }
      job.progress(++completed, total, "Exporting RR intervals");
      await job.yield();
    }
    return {
      blob: await parts.finish("text/plain;charset=utf-8"),
      filename: `${base}-rr.txt`,
    };
  }
  const available = sensors(document, Boolean(query.developer));
  const selected = query.sensors ?? available.map((s) => s.key);
  parts.push(
    '{"sensors":' +
      json(available.filter((s) => selected.includes(s.key))) +
      ',"series":{',
  );
  for (let i = 0; i < selected.length; i++) {
    if (i) parts.push(",");
    parts.push(`${json(selected[i])}:[`);
    const sensor = available.find((sensor) => sensor.key === selected[i]);
    let first = true;
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) {
        if (!first) parts.push(",");
        parts.push(batch.join(","));
        first = false;
        batch = [];
      }
    };
    if (sensor && !(sensor.axis === "sample" && hasTimeRange(query.dates)))
      for await (const point of chartPoints(
        document,
        sensor,
        Boolean(query.developer),
        job,
        query.dates,
      )) {
        if (!inTimeRange(point.time, query.dates)) continue;
        batch.push(json(point));
        if (batch.length >= 256) {
          flush();
          await job.yield();
        }
      }
    flush();
    parts.push("]");
  }
  parts.push("}}");
  return {
    blob: await parts.finish("application/json"),
    filename: `${base}-charts.json`,
  };
}
