import { useMemo, useState } from "react";
import {
  ChevronFirst,
  ChevronLast,
  ChevronLeft,
  ChevronRight,
  Search,
} from "lucide-react";
import type { DocumentSummary } from "../model";
import type { OutBinAppEntry, OutBinField } from "../protocol/out-bin";
import { IconButton } from "./controls";
import { PageNumber } from "./PageNumber";
import { TableScroll } from "./TableScroll";

type InventoryFile = NonNullable<DocumentSummary["appInventories"]>[number];
const PAGE_SIZES = [20, 50, 100];
const FIELD_PAGE_SIZE = 20;
const BYTE_PREVIEW_SIZE = 32;

export function inventoryAppType(type: number): string {
  switch (type) {
    case 1:
      return "Watch app";
    case 2:
      return "Widget / glance";
    case 3:
      return "Watch face";
    case 8:
      return "Activity";
    default:
      return "Unknown";
  }
}

export function inventoryPage(
  entries: OutBinAppEntry[],
  query: string,
  requestedPage: number,
  size: number,
) {
  const search = query.trim().toLowerCase();
  const filtered = search
    ? entries.filter((entry) =>
        [
          entry.name,
          entry.appId,
          entry.appIdHex,
          entry.filename ?? "",
          inventoryAppType(entry.appType),
          String(entry.appType),
        ].some((value) => value.toLowerCase().includes(search)),
      )
    : entries;
  const total = filtered.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.max(0, Math.min(requestedPage, pages - 1));
  return {
    rows: filtered.slice(page * size, (page + 1) * size),
    total,
    page,
    pages,
  };
}

export function AppInventory({ files }: { files: InventoryFile[] }) {
  return (
    <section className="viewer-app-inventory">
      <div className="viewer-section-heading">
        <h2 className="viewer-section-title">App Inventory</h2>
        <span className="viewer-muted">
          {files.length} inventory file{files.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="viewer-muted">
        App inventory from parsed OUT.BIN files. Optional values absent from the
        file are shown as &quot;-&quot;.
      </p>
      {files.map((file) => (
        <InventoryFileView file={file} key={file.source} />
      ))}
    </section>
  );
}

function InventoryFileView({ file }: { file: InventoryFile }) {
  const [search, setSearch] = useState("");
  const [requestedPage, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const { inventory } = file;
  const data = useMemo(
    () => inventoryPage(inventory.entries, search, requestedPage, size),
    [inventory.entries, search, requestedPage, size],
  );
  const unknownGroups = Object.entries(inventory.unknownFields).map(
    ([name, fields]) => ({ name, fields }),
  );
  return (
    <section className="viewer-inventory-file">
      <div className="viewer-section-heading">
        <h3>{file.filename}</h3>
        <span className="viewer-muted">
          {inventory.entries.length.toLocaleString()} app
          {inventory.entries.length === 1 ? "" : "s"}
        </span>
      </div>
      <dl className="viewer-inventory-metadata">
        <div>
          <dt>Inventory field 1</dt>
          <dd>{inventory.metadata.toString()}</dd>
        </div>
        <div>
          <dt>Inventory field 2</dt>
          <dd>{inventory.status}</dd>
        </div>
      </dl>
      <label className="viewer-inventory-search">
        <Search size={16} aria-hidden="true" />
        <input
          aria-label={`Search apps in ${file.filename}`}
          placeholder="Search app name, UUID, type or filename"
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </label>
      <div className="viewer-inventory-table">
        <TableScroll label={`Scrollable app inventory in ${file.filename}`}>
          <table aria-label={`Apps in ${file.filename}`}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Type</th>
                <th scope="col">App UUID</th>
                <th scope="col">Enabled</th>
                <th scope="col">Favorite</th>
                <th scope="col">Details</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((entry) => (
                <tr key={`${entry.appIdHex}:${entry.appType}`}>
                  <th scope="row">{entry.name || '""'}</th>
                  <td>
                    {inventoryAppType(entry.appType)} ({entry.appType})
                  </td>
                  <td className="viewer-inventory-uuid">
                    <code>{entry.appId}</code>
                  </td>
                  <td>{entry.disabled ? "No" : "Yes"}</td>
                  <td>
                    {entry.favorite === undefined
                      ? "-"
                      : entry.favorite
                        ? "Yes"
                        : "No"}
                  </td>
                  <td>
                    <AppDetails entry={entry} />
                  </td>
                </tr>
              ))}
              {!data.rows.length && (
                <tr>
                  <td colSpan={6} className="viewer-muted">
                    {inventory.entries.length
                      ? "No matching apps."
                      : "No apps in this inventory."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </TableScroll>
        <InventoryPagination
          page={data.page}
          pages={data.pages}
          total={data.total}
          size={size}
          onChange={setPage}
          onSizeChange={(value) => {
            setSize(value);
            setPage(0);
          }}
        />
      </div>
      <UnknownFields groups={unknownGroups} />
    </section>
  );
}

function AppDetails({ entry }: { entry: OutBinAppEntry }) {
  return (
    <details className="viewer-inventory-details">
      <summary>App details</summary>
      <dl className="viewer-inventory-metadata">
        <div>
          <dt>Version</dt>
          <dd>{entry.version ?? "-"}</dd>
        </div>
        <div>
          <dt>Filename</dt>
          <dd>{entry.filename ?? "-"}</dd>
        </div>
        <div>
          <dt>File size</dt>
          <dd>
            {entry.fileSize === undefined
              ? "-"
              : `${entry.fileSize.toString()} bytes`}
          </dd>
        </div>
        <div>
          <dt>Native ID</dt>
          <dd>{entry.nativeType ?? "-"}</dd>
        </div>
      </dl>
      <UnknownFields groups={[{ name: "app", fields: entry.unknownFields }]} />
    </details>
  );
}

function UnknownFields({
  groups,
}: {
  groups: { name: string; fields: OutBinField[] }[];
}) {
  const [open, setOpen] = useState(false);
  const [requestedPage, setPage] = useState(0);
  const fields = groups.flatMap(({ name, fields }) =>
    fields.map((field) => ({ name, field })),
  );
  const pages = Math.max(1, Math.ceil(fields.length / FIELD_PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  if (!fields.length) return null;
  return (
    <details
      className="viewer-inventory-unknown"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Unknown fields ({fields.length.toLocaleString()})</summary>
      {open && (
        <>
          <p className="viewer-muted">
            Raw field values; byte previews show up to {BYTE_PREVIEW_SIZE} bytes
            in hexadecimal.
          </p>
          <TableScroll label="Scrollable unknown inventory fields">
            <table aria-label="Unknown inventory fields">
              <thead>
                <tr>
                  <th scope="col">Message</th>
                  <th scope="col">Field</th>
                  <th scope="col">Wire type</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                {fields
                  .slice(page * FIELD_PAGE_SIZE, (page + 1) * FIELD_PAGE_SIZE)
                  .map(({ name, field }, index) => (
                    <tr key={index}>
                      <td>{name}</td>
                      <td>{field.number}</td>
                      <td>{field.wireType}</td>
                      <td>
                        <code>{unknownFieldValue(field)}</code>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </TableScroll>
          {pages > 1 && (
            <InventoryPagination
              page={page}
              pages={pages}
              total={fields.length}
              size={FIELD_PAGE_SIZE}
              onChange={setPage}
            />
          )}
        </>
      )}
    </details>
  );
}

export function unknownFieldValue(field: OutBinField): string {
  if (field.wireType === 0) return field.value.toString();
  const preview = Array.from(
    field.bytes.subarray(0, BYTE_PREVIEW_SIZE),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join(" ");
  return `${field.bytes.length.toLocaleString()} bytes: ${preview}${field.bytes.length > BYTE_PREVIEW_SIZE ? " …" : ""}`;
}

function InventoryPagination({
  page,
  pages,
  total,
  size,
  onChange,
  onSizeChange,
}: {
  page: number;
  pages: number;
  total: number;
  size: number;
  onChange: (value: number) => void;
  onSizeChange?: (value: number) => void;
}) {
  return (
    <div className="viewer-pagination-controls">
      <span className="viewer-pagination-range" aria-live="polite">
        {total
          ? `${page * size + 1}-${Math.min((page + 1) * size, total)} of ${total.toLocaleString()}`
          : "0-0 of 0"}
      </span>
      <div className="viewer-pagination-navigation">
        <IconButton
          title="First page"
          disabled={page === 0}
          onClick={() => onChange(0)}
        >
          <ChevronFirst size={16} />
        </IconButton>
        <IconButton
          title="Previous page"
          disabled={page === 0}
          onClick={() => onChange(page - 1)}
        >
          <ChevronLeft size={16} />
        </IconButton>
        <PageNumber
          page={page}
          pages={pages}
          disabled={!total}
          onChange={onChange}
        />
        <IconButton
          title="Next page"
          disabled={page >= pages - 1}
          onClick={() => onChange(page + 1)}
        >
          <ChevronRight size={16} />
        </IconButton>
        <IconButton
          title="Last page"
          disabled={page >= pages - 1}
          onClick={() => onChange(pages - 1)}
        >
          <ChevronLast size={16} />
        </IconButton>
      </div>
      {onSizeChange && (
        <label className="viewer-pagination-size">
          <span>Rows/page</span>
          <select
            aria-label="Apps per page"
            value={size}
            onChange={(event) => onSizeChange(Number(event.target.value))}
          >
            {PAGE_SIZES.map((value) => (
              <option key={value}>{value}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
