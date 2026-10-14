import { AlertTriangle, ArrowRight, ChevronDown } from "lucide-react";
import type { DocumentSummary } from "../model";
import { FIT_EPOCH, formatTimestamp } from "../protocol/time";
export function Overview({
  summary,
  diagnostics,
}: {
  summary: DocumentSummary;
  diagnostics: () => void;
}) {
  const issues = summary.diagnosticCount;
  const hasFit = summary.subfiles.length > 0;
  const settings = summary.ciqSettings ?? [];
  const settingsBySource = new Map(
    settings.map((file) => [file.source, file.settings]),
  );
  const settingsProperties = settings.reduce(
    (count, file) => count + file.settings.entries.length,
    0,
  );
  const start = summary.startTimestamp;
  const end = summary.endTimestamp;
  const elapsed =
    summary.durationSeconds ??
    (start !== undefined && end !== undefined ? end - start : undefined);
  const duration =
    elapsed !== undefined && Number.isFinite(elapsed) && elapsed >= 0
      ? elapsed
      : undefined;
  const sizePerHour =
    duration && duration > 0 ? (summary.bytes * 3600) / duration : undefined;
  const durationText =
    duration === undefined ? undefined : formatDuration(duration);
  return (
    <section className="overview-content">
      <h2 className="viewer-section-title">File overview</h2>
      <dl
        className={`viewer-metrics${hasFit ? "" : " viewer-metrics-settings"}`}
      >
        {hasFit && (
          <>
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
                      {formatTimestamp(timestamp)}
                    </time>
                  ),
                )}
              </dd>
            </div>
            <div className="viewer-metric-duration">
              <dt
                title={
                  summary.sources.length > 1
                    ? "Sum of each file's elapsed activity time, including pauses within each file"
                    : "Elapsed time between the first and last activity records, including pauses"
                }
              >
                Duration
              </dt>
              <dd>
                {durationText ? (
                  <>
                    <span className="viewer-duration-clock">
                      {durationText.clock}
                    </span>
                    {durationText.days && (
                      <>
                        {" "}
                        <span className="viewer-duration-days">
                          {durationText.days}
                        </span>
                      </>
                    )}
                  </>
                ) : (
                  "-"
                )}
              </dd>
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
          </>
        )}
        {!hasFit && settings.length > 0 && (
          <>
            <div>
              <dt>Settings files</dt>
              <dd>{settings.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Settings properties</dt>
              <dd>{settingsProperties.toLocaleString()}</dd>
            </div>
          </>
        )}
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
          <dd>{formatFileSize(summary.bytes)}</dd>
        </div>
        {hasFit && (
          <div>
            <dt>Size per hour</dt>
            <dd>
              {sizePerHour === undefined
                ? "-"
                : formatFileSize(sizePerHour, true)}
            </dd>
          </div>
        )}
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
        {hasFit && (
          <>
            <div>
              <dt>FIT files</dt>
              <dd>{summary.subfiles.length}</dd>
            </div>
            <div>
              <dt>Profile version</dt>
              <dd>
                {[
                  ...new Set(
                    summary.subfiles.map(
                      (f) =>
                        `${Math.floor(f.profileVersion / 1000)}.${f.profileVersion % 1000}`,
                    ),
                  ),
                ].join(", ")}
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
          </>
        )}
        {hasFit && settings.length > 0 && (
          <>
            <div>
              <dt>Settings files</dt>
              <dd>{settings.length.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Settings properties</dt>
              <dd>{settingsProperties.toLocaleString()}</dd>
            </div>
          </>
        )}
      </dl>
      {summary.sources.length > 1 && (
        <details className="viewer-source-files">
          <summary>
            <h3>Source files</h3>
            <span className="viewer-muted">{summary.sources.length}</span>
            <ChevronDown size={16} aria-hidden="true" />
          </summary>
          <div className="viewer-source-files-scroll">
            <table>
              <thead>
                <tr>
                  <th>Filename</th>
                  <th>Size</th>
                  <th>Records</th>
                  {settings.length > 0 && <th>Settings properties</th>}
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {summary.sources.map((source) => (
                  <tr key={source.id}>
                    <td title={source.filename}>{source.filename}</td>
                    <td>{source.bytes.toLocaleString()} bytes</td>
                    <td>
                      {settingsBySource.has(source.id)
                        ? "-"
                        : source.records.toLocaleString()}
                    </td>
                    {settings.length > 0 && (
                      <td>
                        {settingsBySource
                          .get(source.id)
                          ?.entries.length.toLocaleString() ?? "-"}
                      </td>
                    )}
                    <td
                      className={source.error ? "error" : undefined}
                      title={source.error}
                    >
                      {source.error ? "Unavailable" : "Loaded"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}

function formatFileSize(bytes: number, perHour = false): string {
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const formatted = size.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const suffix = perHour ? "/hour" : "";
  return `${formatted} ${units[unit]}${suffix} (${bytes.toLocaleString(undefined, { maximumFractionDigits: 0 })} bytes${suffix})`;
}

function formatDuration(seconds: number): { clock: string; days?: string } {
  const total = Math.floor(seconds);
  const clock = [
    Math.floor(total / 3600),
    Math.floor(total / 60) % 60,
    total % 60,
  ]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  return {
    clock,
    days:
      seconds > 86400
        ? `(${(seconds / 86400).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} days)`
        : undefined,
  };
}
