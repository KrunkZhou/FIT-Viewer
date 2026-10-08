import { useEffect, useState } from "react";
import { Download, ArrowRight, ChevronLeft, ChevronRight } from "lucide-react";
import type { DiagnosticPage, DocumentSummary, ExportQuery } from "../model";
import type { DocumentClient } from "../document/client";
import { IconButton } from "./controls";
export function Diagnostics({
  client,
  summary,
  download,
  inspect,
}: {
  client: DocumentClient;
  summary: DocumentSummary;
  download: (query: ExportQuery) => void;
  inspect: (message: number, record: number) => void;
}) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<DiagnosticPage>({
    issues: summary.diagnostics,
    total: summary.diagnosticCount,
    page: 0,
    size: 50,
  });
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    client
      .request<DiagnosticPage>(
        { kind: "diagnostics", page, size: 50 },
        controller.signal,
      )
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, [client, page]);
  return (
    <section className="viewer-diagnostics">
      <div className="viewer-section-heading">
        <h2 className="viewer-section-title">Diagnostics</h2>
        {summary.repairable && (
          <button
            className="primary"
            onClick={() => download({ format: "fit" })}
          >
            <Download size={16} />
            Download repaired {summary.sources.length > 1 ? "ZIP" : "FIT"}
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <ul className="issue-list">
        {data.issues.map((issue) => (
          <li key={issue.id} className={`issue ${issue.severity}`}>
            <div>
              <strong>{issue.code.replace(/-/g, " ")}</strong>
              <p>{issue.message}</p>
              <span className="viewer-muted">
                {summary.sources[
                  issue.source ?? summary.subfiles[issue.subfile]?.source ?? 0
                ]?.filename ?? `File ${issue.subfile + 1}`}{" "}
                · Bytes{" "}
                {(
                  issue.offset -
                  (summary.sources[
                    issue.source ?? summary.subfiles[issue.subfile]?.source ?? 0
                  ]?.start ?? 0)
                ).toLocaleString()}
                -
                {(
                  issue.end -
                  (summary.sources[
                    issue.source ?? summary.subfiles[issue.subfile]?.source ?? 0
                  ]?.start ?? 0)
                ).toLocaleString()}{" "}
                ·{" "}
                {issue.repair === "none"
                  ? "Original data retained"
                  : `Repair: ${issue.repair}`}
              </span>
            </div>
            {issue.record !== undefined && (
              <IconButton
                title="View record"
                onClick={() => inspect(issue.messageId ?? 20, issue.record!)}
              >
                <ArrowRight size={16} />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {data.total > data.size && (
        <div className="viewer-pagination-navigation">
          <IconButton
            title="Previous issues"
            disabled={!data.page}
            onClick={() => setPage((p) => p - 1)}
          >
            <ChevronLeft size={16} />
          </IconButton>
          <span>
            Page {data.page + 1} / {Math.ceil(data.total / data.size)}
          </span>
          <IconButton
            title="Next issues"
            disabled={(data.page + 1) * data.size >= data.total}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRight size={16} />
          </IconButton>
        </div>
      )}
      <div className="viewer-file-headers">
        <h3>File headers</h3>
        {summary.subfiles.map((file) => (
          <dl className="viewer-header-details" key={file.index}>
            <dt>File</dt>
            <dd>
              {summary.sources[file.source ?? 0]?.filename} ({file.index + 1})
            </dd>
            <dt>Header bytes</dt>
            <dd>{file.headerSize}</dd>
            <dt>Declared data bytes</dt>
            <dd>{file.declaredEnd - file.bodyStart}</dd>
            <dt>Recovered data bytes</dt>
            <dd>{file.bodyEnd - file.bodyStart}</dd>
          </dl>
        ))}
      </div>
    </section>
  );
}
