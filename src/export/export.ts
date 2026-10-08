import type { ExportQuery, ExportResult, FieldInfo, RawValue } from "../model";
import { FitDocument } from "../document/document";
import { chartPoints, mapPositions, sensors } from "../document/series";
import { FIT_EPOCH } from "../protocol/time";
import { idleJob } from "../protocol/reader";
import { repair } from "../repair/repair";
import { exportGeoJson } from "./geojson";
import { repairArchive } from "./archive";

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
): Promise<ExportResult> {
  if (query.format === "geojson") return exportGeoJson(document, job);
  const base = document.filename.replace(/\.[^.]+$/, "");
  const parts: BlobPart[] = [];
  const encoder = new TextEncoder();
  if (query.format === "fit") {
    if (document.sources.length > 1) return repairArchive(document, job);
    const result = await repair(document, job);
    return {
      blob: new Blob([result.bytes as Uint8Array<ArrayBuffer>], {
        type: "application/octet-stream",
      }),
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
    const infos = new Map(fields.map((field) => [field.key, field]));
    const combined = document.sources.length > 1;
    const sourceInfos = new Map(
      combined
        ? document.sources.map(
            (source) =>
              [
                source.id,
                new Map(
                  document
                    .getFields(message, developer, source.id)
                    .map((field) => [field.key, field]),
                ),
              ] as const,
          )
        : [],
    );
    const dateFormat = new Intl.DateTimeFormat(query.locale, {
      timeZone: query.timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const cast = (value: RawValue, info: FieldInfo): string => {
      if (value === null) return "";
      if (Array.isArray(value))
        return `[${value.map((v) => cast(v, info)).join(", ")}]`;
      if (
        !developer &&
        (info.type === "dateTime" || info.type === "localDateTime") &&
        typeof value === "string" &&
        query.timeFormat === "localized"
      )
        return dateFormat.format(new Date(value));
      if (!developer && typeof value === "number") {
        const decimals =
          info.units === "deg" ||
          info.type === "float32" ||
          info.type === "float64"
            ? undefined
            : scalePrecision(info.scale);
        if (decimals === undefined || decimals > 20) return String(value);
        const text = value.toFixed(decimals);
        return decimals > 0 && text.includes(".")
          ? text.replace(/0+$/, "").replace(/\.$/, "")
          : text;
      }
      return String(value);
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
        const cells = document.cells(id, !developer);
        const file =
          document.index.subfiles[document.index.records[id].subfile];
        const rowInfos = sourceInfos.get(file.source ?? 0) ?? infos;
        const values = fields
          .map((f) =>
            escapeCsv(
              cast(
                cells[f.key]?.[developer ? "raw" : "value"] ?? null,
                rowInfos.get(f.key) ?? f,
              ),
            ),
          )
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
      blob: new Blob(parts, { type: "text/csv;charset=utf-8" }),
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
    ) =>
      `<${tag} lat="${p.lat}" lon="${p.lon}">${p.elevation !== undefined ? `<ele>${p.elevation}</ele>` : ""}${p.time !== undefined ? `<time>${new Date(FIT_EPOCH + p.time * 1000).toISOString()}</time>` : ""}${p.name ? `<name>${xml(p.name)}</name>` : ""}</${tag}>`;
    for await (const entry of mapPositions(document, job))
      if (
        entry.point &&
        entry.message !== 20 &&
        (entry.message !== 19 || query.withLaps)
      )
        parts.push(point(entry.point, "wpt"));
    parts.push(`<trk><name>${xml(base)}</name>`);
    let segment = false;
    let subfile = -1;
    let previous: number | undefined;
    let batch: string[] = [];
    const flush = () => {
      if (batch.length) {
        parts.push(batch.join(""));
        batch = [];
      }
    };
    for await (const entry of mapPositions(document, job)) {
      if (entry.message !== 20) continue;
      const p = entry.point;
      if (
        segment &&
        (!p ||
          subfile !== entry.subfile ||
          (previous !== undefined && p.time !== undefined && p.time < previous))
      ) {
        flush();
        parts.push("</trkseg>");
        segment = false;
      }
      if (!p) continue;
      if (!segment) {
        parts.push("<trkseg>");
        segment = true;
      }
      batch.push(point(p, "trkpt"));
      subfile = entry.subfile;
      previous = p.time;
      if (batch.length >= 256) {
        flush();
        await job.yield();
      }
    }
    flush();
    if (segment) parts.push("</trkseg>");
    parts.push("</trk></gpx>");
    return {
      blob: new Blob(parts, { type: "application/gpx+xml" }),
      filename: `${base}.gpx`,
    };
  }
  if (query.format === "hrv") {
    let completed = 0;
    const total = document.sources.length;
    for (const source of document.sources) {
      const filter = total > 1 ? source.id : undefined;
      const ids = document.recordIds(78, filter);
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
        let file = -1;
        for (const id of document.recordIds(132, filter)) {
          const record = document.index.records[id];
          const values = document.cells(id)["9"]?.value;
          if (file !== record.subfile) previous = undefined;
          file = record.subfile;
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
      blob: new Blob(parts, { type: "text/plain;charset=utf-8" }),
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
    if (sensor)
      for await (const point of chartPoints(
        document,
        sensor,
        Boolean(query.developer),
        job,
      )) {
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
    blob: new Blob(parts, { type: "application/json" }),
    filename: `${base}-charts.json`,
  };
}
