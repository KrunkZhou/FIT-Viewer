import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import type { DocumentSummary, ExportQuery, SingleEntryView } from "../model";
import type { DocumentClient } from "../document/client";
import { displayCell } from "./format";
import { IconButton } from "./controls";
import { TableScroll } from "./TableScroll";

export function SingleEntryMessages({
  client,
  summary,
  developer,
  visible,
  download,
}: {
  client: DocumentClient;
  summary: DocumentSummary;
  developer: boolean;
  visible: number[];
  download: (query: ExportQuery) => void;
}) {
  const [data, setData] = useState<SingleEntryView>();
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError("");
    client
      .request<SingleEntryView>(
        { kind: "singletons", developer },
        controller.signal,
      )
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      });
    return () => controller.abort();
  }, [client, developer]);
  return (
    <div className="single-entry-view" aria-busy={!data && !error}>
      <div className="viewer-message-heading">
        <h3>Single-entry messages</h3>
        <span className="viewer-muted">{visible.length} messages</span>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="single-entry-scroll">
        {!data && !error && (
          <p className="viewer-loading">Loading messages...</p>
        )}
        {data && !visible.length && (
          <p className="viewer-muted empty-table">No matching messages.</p>
        )}
        {data?.entries
          .filter((entry) => visible.includes(entry.message.id))
          .map((entry) => (
            <section className="single-entry-section" key={entry.message.id}>
              <div className="single-entry-heading">
                <h3>{entry.message.name}</h3>
                <span className="viewer-muted">#{entry.message.id}</span>
                <IconButton
                  title={`Download ${entry.message.name} CSV`}
                  onClick={() =>
                    download({
                      format: "csv",
                      message: entry.message.id,
                      developer,
                    })
                  }
                >
                  <Download size={16} />
                </IconButton>
              </div>
              <TableScroll compact>
                <table aria-label={entry.message.name}>
                  <thead>
                    <tr>
                      {summary.sources.length > 1 && (
                        <th scope="col">Source file</th>
                      )}
                      {entry.fields.map((field) => (
                        <th
                          key={field.key}
                          scope="col"
                          title={`Field ${field.key}${field.description ? `: ${field.description}` : ""}`}
                        >
                          {field.name}
                          {field.units && (
                            <span className="units"> ({field.units})</span>
                          )}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      {summary.sources.length > 1 && (
                        <td className="source-file-cell">
                          {
                            summary.sources[
                              summary.subfiles[entry.row.subfile].source ?? 0
                            ].filename
                          }
                        </td>
                      )}
                      {entry.fields.map((field) => (
                        <td key={field.key}>
                          {displayCell(
                            entry.row.cells[field.key]?.[
                              developer ? "raw" : "value"
                            ],
                            field,
                            developer,
                          )}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </TableScroll>
            </section>
          ))}
      </div>
    </div>
  );
}
