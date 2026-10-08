import type { ExportResult, Job } from "../model";
import type { FitDocument } from "../document/document";
import { mapPositions } from "../document/series";
import { FIT_EPOCH } from "../protocol/time";

export async function exportGeoJson(
  document: FitDocument,
  job: Job,
): Promise<ExportResult> {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = ['{"type":"FeatureCollection","features":['];
  let batch: string[] = [];
  let first = true;
  let route = 0;
  let segment = false;
  let subfile = -1;
  let previous: number | undefined;
  const flush = () => {
    if (!batch.length) return;
    parts.push(encoder.encode(`${first ? "" : ","}${batch.join(",")}`));
    first = false;
    batch = [];
  };
  for await (const entry of mapPositions(document, {
    ...job,
    progress: (completed, total) =>
      job.progress(completed, total, "Exporting GeoJSON"),
  })) {
    const point = entry.point;
    if (entry.message === 20) {
      if (
        segment &&
        (!point ||
          subfile !== entry.subfile ||
          (previous !== undefined &&
            point.time !== undefined &&
            point.time < previous))
      )
        segment = false;
      if (!point) continue;
      if (!segment) {
        route++;
        segment = true;
      }
      subfile = entry.subfile;
      previous = point.time;
    }
    if (!point) continue;
    const kind =
      entry.message === 20
        ? "record"
        : entry.message === 19
          ? "lap"
          : "waypoint";
    batch.push(
      JSON.stringify({
        type: "Feature",
        id: point.record,
        geometry: { type: "Point", coordinates: [point.lon, point.lat] },
        properties: {
          ...(document.sources.length > 1
            ? { source_file: document.sourceName(entry.subfile) }
            : {}),
          kind,
          record_index: point.record,
          message_id: entry.message,
          subfile: entry.subfile + 1,
          route_id: entry.message === 20 ? route : null,
          timestamp:
            point.time === undefined
              ? null
              : new Date(FIT_EPOCH + point.time * 1000).toISOString(),
          // FIT does not establish an ellipsoidal height datum for GeoJSON Z.
          elevation_m: point.elevation ?? null,
          distance_m: point.distance ?? null,
          name: point.name ?? null,
        },
      }),
    );
    if (batch.length >= 256) {
      flush();
      await job.yield();
    }
  }
  flush();
  parts.push("]}");
  job.progress(
    document.index.records.length,
    document.index.records.length,
    "Exporting GeoJSON",
  );
  await job.yield();
  return {
    blob: new Blob(parts, { type: "application/geo+json" }),
    filename: `${document.filename.replace(/\.[^.]+$/, "")}-gps.geojson`,
  };
}
