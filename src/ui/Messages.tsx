import { useEffect, useRef, useState } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Download,
  ListCollapse,
  Search,
} from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import type {
  DocumentSummary,
  ExportQuery,
  TablePage,
  TableQuery,
} from "../model";
import type { DocumentClient } from "../document/client";
import { displayCell, fieldTooltip } from "./format";
import { FIT_EPOCH } from "../protocol/time";
import { SingleEntryMessages } from "./SingleEntryMessages";
import { TableScroll } from "./TableScroll";
import {
  IconButton,
  navigateTabs,
  readPreference,
  savePreference,
} from "./controls";

export function Messages({
  client,
  summary,
  developer,
  download,
  target,
}: {
  client: DocumentClient;
  summary: DocumentSummary;
  developer: boolean;
  download: (query: ExportQuery) => void;
  target?: { message: number; record: number };
}) {
  const [selected, setSelected] = useState(
    summary.messages.some((m) => m.id === 20)
      ? 20
      : (summary.messages.find((m) => m.known && m.count > 1)?.id ?? -1),
  );
  const [search, setSearch] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState<TableQuery>({
    message: selected,
    developer,
    page: 0,
    size: readPreference(
      "messagePageSize",
      20,
      (v): v is number =>
        typeof v === "number" && [10, 20, 50, 100, 1000].includes(v),
    ),
  });
  const [data, setData] = useState<TablePage>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [time, setTime] = useState("");
  const pendingTarget = useRef<{ message: number; record: number } | undefined>(
    undefined,
  );
  const messages = summary.messages
    .filter((m) => developer || m.known)
    .filter((m) =>
      `${m.name} ${m.id}`.toLowerCase().includes(search.toLowerCase()),
    );
  const singletons = messages.filter((m) => m.count === 1 && m.known);
  const separate = messages.filter((m) => m.count !== 1 || !m.known);
  const active =
    selected === -1
      ? -1
      : (messages.find((m) => m.id === selected)?.id ??
        separate[0]?.id ??
        (singletons.length ? -1 : undefined));
  useEffect(() => {
    setQuery((q) => ({
      ...q,
      message: active ?? 0,
      developer,
      page: 0,
      filters: {},
      timestamp: undefined,
      target:
        pendingTarget.current?.message === active
          ? pendingTarget.current.record
          : undefined,
    }));
    pendingTarget.current = undefined;
  }, [active, developer]);
  useEffect(() => {
    if (target) {
      setExpanded(true);
      pendingTarget.current = target.message === active ? undefined : target;
      setSearch("");
      setSelected(target.message);
      setQuery((q) => ({
        ...q,
        message: target.message,
        target: target.record,
        timestamp: undefined,
      }));
    }
  }, [target]);
  useEffect(() => {
    if (
      active === undefined ||
      active === -1 ||
      query.message !== active ||
      query.developer !== developer
    )
      return;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    client
      .request<TablePage>({ kind: "table", query }, controller.signal)
      .then(setData)
      .catch((error) => {
        if (error.name !== "AbortError") setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, query, active, developer]);
  const changePage = (page: number) =>
    setQuery((q) => ({ ...q, page, timestamp: undefined, target: undefined }));
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / query.size));
  return (
    <div className="viewer-messages message-tabs">
      <aside className="viewer-tab-navigation">
        <div className="viewer-message-search">
          <label>
            <Search size={16} />
            <input
              aria-label="Find a message type"
              placeholder="Find a message..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <span className="viewer-muted">{messages.length} message types</span>
        </div>
        <div
          className="viewer-tab-list"
          role="tablist"
          aria-label="Message types"
          aria-orientation="vertical"
          onKeyDown={navigateTabs}
        >
          {(singletons.length > 0 || selected === -1) && (
            <div
              className="single-entry-navigation"
              data-selected={active === -1}
            >
              <IconButton
                title={
                  expanded
                    ? "Collapse single-entry messages"
                    : "Expand single-entry messages"
                }
                aria-expanded={expanded}
                aria-controls="single-entry-navigation-items"
                onClick={() => {
                  if (expanded && singletons.some((m) => m.id === selected))
                    setSelected(-1);
                  setExpanded((value) => !value);
                }}
              >
                <ListCollapse size={16} />
              </IconButton>
              <button
                className="viewer-tab"
                role="tab"
                id="message-singletons"
                tabIndex={active === -1 ? 0 : -1}
                aria-controls="message-panel"
                aria-selected={active === -1}
                onClick={() => setSelected(-1)}
              >
                <span className="viewer-tab-label">Single-entry messages</span>
                <span
                  className="viewer-tab-count"
                  title={`Message IDs: ${singletons.map((message) => message.id).join(", ")}`}
                >
                  {singletons.length}
                </span>
              </button>
            </div>
          )}
          <div
            className="single-entry-navigation-items"
            id="single-entry-navigation-items"
            hidden={!expanded}
          >
            {singletons.map((message) => (
              <button
                className="viewer-tab"
                role="tab"
                tabIndex={active === message.id ? 0 : -1}
                id={`message-${message.id}`}
                aria-controls="message-panel"
                aria-selected={active === message.id}
                key={message.id}
                onClick={() => setSelected(message.id)}
              >
                <span className="viewer-tab-label">{message.name}</span>
                <span
                  className="viewer-tab-count"
                  title={`Message ID: ${message.id}`}
                >
                  1
                </span>
              </button>
            ))}
          </div>
          {separate.map((message) => (
            <button
              className="viewer-tab"
              role="tab"
              tabIndex={active === message.id ? 0 : -1}
              id={`message-${message.id}`}
              aria-controls="message-panel"
              aria-selected={active === message.id}
              key={message.id}
              onClick={() => setSelected(message.id)}
            >
              <span className="viewer-tab-label">{message.name}</span>
              <span
                className="viewer-tab-count"
                title={`Message ID: ${message.id}`}
              >
                {message.count.toLocaleString()}
              </span>
            </button>
          ))}
        </div>
      </aside>
      <div className="viewer-tab-panels">
        <section
          className="viewer-tab-panel viewer-message-table"
          id="message-panel"
          role="tabpanel"
          aria-labelledby={
            active === undefined
              ? undefined
              : active === -1
                ? "message-singletons"
                : `message-${active}`
          }
        >
          {active === -1 ? (
            <SingleEntryMessages
              client={client}
              summary={summary}
              developer={developer}
              visible={singletons.map((m) => m.id)}
              download={download}
            />
          ) : (
            <>
              <div className="viewer-message-heading">
                <div className="viewer-message-heading-content viewer-message-title">
                  <h3>
                    {messages.find((m) => m.id === active)?.name ?? "Messages"}
                  </h3>
                  <span className="viewer-message-row-count viewer-muted">
                    {data?.total.toLocaleString() ?? 0} rows
                  </span>
                </div>
                <IconButton
                  title="Download CSV"
                  disabled={!data || loading}
                  onClick={() =>
                    download({ format: "csv", message: active, developer })
                  }
                >
                  <Download size={16} />
                </IconButton>
              </div>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              <div className="viewer-message-body" aria-busy={loading}>
                <TableScroll>
                  <table>
                    <thead>
                      <tr>
                        {summary.sources.length > 1 && (
                          <th scope="col">Source file</th>
                        )}
                        {data?.fields.map((field) => (
                          <th key={field.key} title={fieldTooltip(field)}>
                            <span>
                              {field.name}
                              {field.units && (
                                <span className="units"> ({field.units})</span>
                              )}
                            </span>
                            {field.id === 253 && (
                              <Popover.Root>
                                <Popover.Trigger asChild>
                                  <IconButton title="Find timestamp">
                                    <Search size={12} />
                                  </IconButton>
                                </Popover.Trigger>
                                <Popover.Portal>
                                  <Popover.Content
                                    className="filter-popup"
                                    sideOffset={6}
                                  >
                                    <form
                                      onSubmit={(event) => {
                                        event.preventDefault();
                                        const value = new FormData(
                                          event.currentTarget,
                                        ).get("timestamp");
                                        const millis = Date.parse(
                                          String(value ?? ""),
                                        );
                                        if (Number.isFinite(millis))
                                          setQuery((q) => ({
                                            ...q,
                                            timestamp:
                                              (millis - FIT_EPOCH) / 1000,
                                            target: undefined,
                                          }));
                                      }}
                                    >
                                      <input
                                        type="datetime-local"
                                        name="timestamp"
                                        step="any"
                                        aria-label="Timestamp"
                                        value={time}
                                        onChange={(event) =>
                                          setTime(event.target.value)
                                        }
                                        required
                                      />
                                      <button className="primary" type="submit">
                                        Find
                                      </button>
                                    </form>
                                  </Popover.Content>
                                </Popover.Portal>
                              </Popover.Root>
                            )}
                            {data.options[field.key]?.length > 0 && (
                              <Popover.Root>
                                <Popover.Trigger asChild>
                                  <IconButton title={`Filter ${field.name}`}>
                                    <Search size={12} />
                                  </IconButton>
                                </Popover.Trigger>
                                <Popover.Portal>
                                  <Popover.Content
                                    className="filter-popup"
                                    sideOffset={6}
                                  >
                                    <div className="filter-values">
                                      {data.options[field.key].map((value) => (
                                        <label key={value}>
                                          <input
                                            type="checkbox"
                                            checked={
                                              query.filters?.[
                                                field.key
                                              ]?.includes(value) ?? false
                                            }
                                            onChange={(event) =>
                                              setQuery((q) => ({
                                                ...q,
                                                page: 0,
                                                filters: {
                                                  ...q.filters,
                                                  [field.key]: event.target
                                                    .checked
                                                    ? [
                                                        ...(q.filters?.[
                                                          field.key
                                                        ] ?? []),
                                                        value,
                                                      ]
                                                    : (
                                                        q.filters?.[
                                                          field.key
                                                        ] ?? []
                                                      ).filter(
                                                        (v) => v !== value,
                                                      ),
                                                },
                                              }))
                                            }
                                          />
                                          {value}
                                        </label>
                                      ))}
                                    </div>
                                  </Popover.Content>
                                </Popover.Portal>
                              </Popover.Root>
                            )}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data?.rows.map((row) => (
                        <tr
                          key={row.index}
                          className={
                            row.index === data.selected ? "selected-row" : ""
                          }
                        >
                          {summary.sources.length > 1 && (
                            <td
                              className="source-file-cell"
                              title={
                                summary.sources[
                                  summary.subfiles[row.subfile].source ?? 0
                                ].filename
                              }
                            >
                              {
                                summary.sources[
                                  summary.subfiles[row.subfile].source ?? 0
                                ].filename
                              }
                            </td>
                          )}
                          {data.fields.map((field) => (
                            <td
                              key={field.key}
                              title={
                                developer
                                  ? `Record ${row.index}, byte ${row.offset}, file ${row.subfile + 1}`
                                  : undefined
                              }
                            >
                              {displayCell(
                                row.cells[field.key]?.[
                                  developer ? "raw" : "value"
                                ],
                                field,
                                developer,
                              )}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data?.rows.length && (
                    <p className="viewer-muted empty-table">
                      {loading ? "Loading..." : "No matching records."}
                    </p>
                  )}
                </TableScroll>
                <div className="viewer-pagination-controls">
                  <span className="viewer-pagination-range">
                    {data?.total
                      ? `${data.page * data.size + 1}-${Math.min((data.page + 1) * data.size, data.total)}`
                      : "0-0"}
                  </span>
                  <div className="viewer-pagination-navigation">
                    <IconButton
                      title="First page"
                      disabled={!data || data.page === 0}
                      onClick={() => changePage(0)}
                    >
                      <ChevronFirst size={16} />
                    </IconButton>
                    <IconButton
                      title="Previous page"
                      disabled={!data || data.page === 0}
                      onClick={() => changePage(Math.max(0, data!.page - 1))}
                    >
                      <ChevronLeft size={16} />
                    </IconButton>
                    <span className="viewer-pagination-page">
                      Page {(data?.page ?? 0) + 1} / {pages}
                    </span>
                    <IconButton
                      title="Next page"
                      disabled={!data || data.page >= pages - 1}
                      onClick={() => changePage(data!.page + 1)}
                    >
                      <ChevronRight size={16} />
                    </IconButton>
                    <IconButton
                      title="Last page"
                      disabled={!data || data.page >= pages - 1}
                      onClick={() => changePage(pages - 1)}
                    >
                      <ChevronLast size={16} />
                    </IconButton>
                  </div>
                  <label className="viewer-pagination-size">
                    <span>Rows/page</span>
                    <select
                      aria-label="Rows per page"
                      value={query.size}
                      onChange={(event) => {
                        const size = Number(event.target.value);
                        savePreference("messagePageSize", size);
                        setQuery((q) => ({
                          ...q,
                          size,
                          page: 0,
                          timestamp: undefined,
                          target: undefined,
                        }));
                      }}
                    >
                      {[10, 20, 50, 100, 1000].map((size) => (
                        <option key={size}>{size}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
