import { AlertTriangle, ArrowRight, Download, FileJson2 } from "lucide-react";
import type { DocumentSummary, ExportQuery } from "../model";
import { FIT_EPOCH } from "../protocol/time";
export function Overview({
  summary,
  diagnostics,
  download,
}: {
  summary: DocumentSummary;
  diagnostics: () => void;
  download: (query: ExportQuery) => void;
}) {
  const issues = summary.diagnosticCount;
  const start = summary.startTimestamp;
  const end = summary.endTimestamp;
  const elapsed =
    start !== undefined && end !== undefined ? end - start : undefined;
  const duration =
    elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
      ? elapsed
      : undefined;
  const sizePerHour =
    duration && duration > 0 ? (summary.bytes * 3600) / duration : undefined;
  return (
    <section className="overview-content">
      <div className="viewer-overview-toolbar">
        <h2 className="viewer-section-title">File overview</h2>
        {summary.hasMap && (
          <div className="viewer-overview-exports">
            <button
              className="viewer-command"
              onClick={() => download({ format: "gpx" })}
            >
              <Download size={16} /> Export GPX
            </button>
            <button
              className="viewer-command"
              title="Download QGIS GeoJSON"
              onClick={() => download({ format: "geojson" })}
            >
              <FileJson2 size={16} /> QGIS GeoJSON
            </button>
          </div>
        )}
      </div>
      <dl className="viewer-metrics">
        <div className="viewer-metric-time">
          <dt>Start - end time</dt>
          <dd>
            {[start, end].map((timestamp, index) =>
              timestamp === undefined ? (
                <span key={index}>-</span>
              ) : (
                <time
                  key={index}
                  dateTime={new Date(
                    FIT_EPOCH + timestamp * 1000,
                  ).toISOString()}
                >
                  {new Date(FIT_EPOCH + timestamp * 1000).toLocaleString()}
                </time>
              ),
            )}
          </dd>
        </div>
        <div className="viewer-metric-duration">
          <dt title="Elapsed time between the first and last activity records, including pauses">
            Duration
          </dt>
          <dd>{duration === undefined ? "-" : formatDuration(duration)}</dd>
        </div>
        <div>
          <dt>Messages</dt>
          <dd>{summary.records.toLocaleString()}</dd>
        </div>
        <div>
          <dt>GPS points</dt>
          <dd>{summary.gpsPoints.toLocaleString()}</dd>
        </div>
        <div>
          <dt>Sessions</dt>
          <dd>
            {summary.messages
              .find((message) => message.id === 18)
              ?.count.toLocaleString() ?? "0"}
          </dd>
        </div>
      </dl>
      {issues > 0 && (
        <button
          className="viewer-status viewer-status-warning"
          onClick={diagnostics}
        >
          <AlertTriangle size={20} />
          <span>
            {issues} issue{issues === 1 ? "" : "s"} detected
          </span>
          <ArrowRight size={16} />
        </button>
      )}
      <dl className="viewer-file-details">
        <div>
          <dt>File type</dt>
          <dd>{summary.fileTypes.join(", ")}</dd>
        </div>
        <div>
          <dt>File size</dt>
          <dd>{summary.bytes.toLocaleString()} bytes</dd>
        </div>
        <div>
          <dt>Size per hour</dt>
          <dd>
            {sizePerHour === undefined
              ? "-"
              : `${sizePerHour.toLocaleString(undefined, { maximumFractionDigits: 0 })} bytes/hour`}
          </dd>
        </div>
        {summary.sports.length > 0 && (
          <div>
            <dt>Sport</dt>
            <dd>{summary.sports.join(", ")}</dd>
          </div>
        )}
        <div>
          <dt>Filename</dt>
          <dd>{summary.filename}</dd>
        </div>
        <div>
          <dt>FIT files</dt>
          <dd>{summary.subfiles.length}</dd>
        </div>
        <div>
          <dt>Profile version</dt>
          <dd>
            {summary.subfiles
              .map(
                (f) =>
                  `${Math.floor(f.profileVersion / 1000)}.${f.profileVersion % 1000}`,
              )
              .join(", ")}
          </dd>
        </div>
        <div>
          <dt>Activity records</dt>
          <dd>
            {summary.messages
              .find((m) => m.id === 20)
              ?.count.toLocaleString() ?? "0"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatDuration(seconds: number): string {
  const total = Math.floor(seconds);
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
