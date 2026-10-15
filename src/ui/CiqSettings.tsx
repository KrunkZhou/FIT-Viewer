import { useId, useState, useSyncExternalStore } from "react";
import { Check, Download, Pencil, RotateCcw } from "lucide-react";
import type { CiqSettingsFile, DocumentSummary, ExportQuery } from "../model";
import type {
  CiqDictionary,
  CiqScalar,
  CiqValue,
} from "../protocol/ciq-settings";
import { ciqScalarText } from "../protocol/ciq-edit";
import { IconButton } from "./controls";
import { CiqDraftStore, type CiqDraft } from "./ciq-drafts";

interface Editor {
  filename: string;
  editing: boolean;
  drafts: ReadonlyMap<string, CiqDraft>;
  change: (value: CiqScalar, path: number[], text: string) => void;
}

export function CiqSettings({
  files,
  download,
  store: suppliedStore,
  source,
}: {
  files: NonNullable<DocumentSummary["ciqSettings"]>;
  download: (query: ExportQuery) => void;
  store?: CiqDraftStore;
  source?: number;
}) {
  const [localStore] = useState(() => new CiqDraftStore());
  const store = suppliedStore ?? localStore;
  return (
    <section className="viewer-ciq-settings">
      {files.map((file) => (
        <SettingsFile
          key={file.source}
          file={file}
          download={download}
          store={store}
          source={source ?? file.source}
        />
      ))}
    </section>
  );
}

function SettingsFile({
  file,
  download,
  store,
  source,
}: {
  file: CiqSettingsFile;
  download: (query: ExportQuery) => void;
  store: CiqDraftStore;
  source: number;
}) {
  const [editing, setEditing] = useState(false);
  const drafts = useSyncExternalStore(
    store.subscribe,
    () => store.get(source),
    () => store.get(source),
  );
  const errors = [...drafts.values()].some((draft) => draft.error);
  const editor: Editor = {
    filename: file.filename,
    editing,
    drafts,
    change: (original, path, text) =>
      store.change(source, original, path, text),
  };
  const changed = [...drafts.values()].filter(
    (draft) => draft.edit || draft.error,
  ).length;
  return (
    <section className="viewer-ciq-file">
      <div className="viewer-section-heading">
        <h3>{file.filename}</h3>
        <div className="viewer-ciq-actions">
          <span className="viewer-muted">
            {file.settings.entries.length.toLocaleString()} propert
            {file.settings.entries.length === 1 ? "y" : "ies"}
          </span>
          {changed > 0 && (
            <span className="viewer-ciq-changes">{changed} changed</span>
          )}
          <IconButton
            title={`${editing ? "Finish editing" : "Edit"} ${file.filename}`}
            tooltip={
              editing ? "Finish editing settings" : "Edit settings values"
            }
            aria-pressed={editing}
            disabled={editing && errors}
            className="viewer-icon-button viewer-ciq-edit-button"
            onClick={() => setEditing(!editing)}
          >
            {editing ? <Check size={16} /> : <Pencil size={16} />}
          </IconButton>
          <IconButton
            title={`Reset changes in ${file.filename}`}
            tooltip="Reset to the uploaded settings"
            disabled={!changed}
            onClick={() => store.reset(source)}
          >
            <RotateCcw size={16} />
          </IconButton>
          <IconButton
            title={`Download ${file.filename}`}
            tooltip="Download the current settings as a SET file"
            disabled={errors}
            onClick={() =>
              download({
                format: "set",
                settings: {
                  source: file.source,
                  edits: [...drafts.values()].flatMap((draft) =>
                    draft.edit ? [draft.edit] : [],
                  ),
                },
              })
            }
          >
            <Download size={16} />
          </IconButton>
        </div>
      </div>
      <div className="viewer-ciq-table-container">
        <table aria-label={`Settings in ${file.filename}`}>
          <thead>
            <tr>
              <th scope="col">Property</th>
              <th scope="col">Type</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {sortedEntries(file.settings.entries).map(({ entry, index }) => (
              <tr key={index}>
                <th scope="row">
                  <CiqKey value={entry.key} />
                </th>
                <td className="viewer-ciq-type">{entry.value.type}</td>
                <td>
                  <CiqValueDisplay
                    value={entry.value}
                    editor={editor}
                    path={[index]}
                    label={keyLabel(entry.key, index)}
                  />
                </td>
              </tr>
            ))}
            {!file.settings.entries.length && (
              <tr>
                <td colSpan={3} className="viewer-muted">
                  No settings properties in this file.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function sortedEntries(entries: CiqDictionary["entries"]) {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      if (a.entry.key.type !== "string")
        return b.entry.key.type === "string" ? 1 : 0;
      if (b.entry.key.type !== "string") return -1;
      return a.entry.key.value.localeCompare(b.entry.key.value, undefined, {
        sensitivity: "base",
        numeric: true,
      });
    });
}

function keyLabel(value: CiqValue, index: number): string {
  return value.type === "array" || value.type === "dictionary"
    ? `Property ${index + 1}`
    : ciqScalarText(value);
}

function CiqKey({ value }: { value: CiqValue }) {
  return value.type === "string" ? (
    <span className="viewer-ciq-key">{value.value}</span>
  ) : (
    <div className="viewer-ciq-typed-value">
      <span className="viewer-ciq-type">{value.type}</span>
      <CiqValueDisplay value={value} />
    </div>
  );
}

function CiqValueDisplay({
  value,
  editor,
  path = [],
  label = "",
}: {
  value: CiqValue;
  editor?: Editor;
  path?: number[];
  label?: string;
}) {
  if (value.type === "array") {
    if (!value.items.length)
      return <code className="viewer-ciq-value">[]</code>;
    return (
      <ol className="viewer-ciq-array" start={0}>
        {value.items.map((item, index) => (
          <li key={index}>
            <div className="viewer-ciq-typed-value">
              <span className="viewer-ciq-type">{item.type}</span>
              <CiqValueDisplay
                value={item}
                editor={editor}
                path={[...path, index]}
                label={`${label}[${index}]`}
              />
            </div>
          </li>
        ))}
      </ol>
    );
  }
  if (value.type === "dictionary") {
    if (!value.entries.length)
      return <code className="viewer-ciq-value">{"{}"}</code>;
    return (
      <dl className="viewer-ciq-dictionary">
        {sortedEntries(value.entries).map(({ entry, index }) => (
          <div key={index}>
            <dt>
              <CiqKey value={entry.key} />
            </dt>
            <dd className="viewer-ciq-typed-value">
              <span className="viewer-ciq-type">{entry.value.type}</span>
              <CiqValueDisplay
                value={entry.value}
                editor={editor}
                path={[...path, index]}
                label={`${label}.${keyLabel(entry.key, index)}`}
              />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (editor?.editing && value.type !== "null")
    return (
      <ValueEditor original={value} editor={editor} path={path} label={label} />
    );
  const current = editor?.drafts.get(path.join("."))?.edit?.value ?? value;
  return <code className="viewer-ciq-value">{ciqScalarText(current)}</code>;
}

function ValueEditor({
  original,
  editor,
  path,
  label,
}: {
  original: CiqScalar;
  editor: Editor;
  path: number[];
  label: string;
}) {
  const id = useId();
  const draft = editor.drafts.get(path.join("."));
  const text = draft?.text ?? ciqScalarText(original);
  const name = `Value for ${label} in ${editor.filename}`;
  return (
    <div className="viewer-ciq-editor">
      {original.type === "boolean" ? (
        <label className="viewer-ciq-boolean">
          <input
            type="checkbox"
            aria-label={name}
            checked={text === "true"}
            onChange={(event) =>
              editor.change(original, path, String(event.target.checked))
            }
          />
          <span>{text}</span>
        </label>
      ) : original.type === "string" ? (
        <textarea
          rows={Math.min(4, Math.max(1, text.split("\n").length))}
          aria-label={name}
          aria-invalid={Boolean(draft?.error)}
          aria-describedby={draft?.error ? id : undefined}
          value={text}
          onChange={(event) =>
            editor.change(original, path, event.target.value)
          }
        />
      ) : (
        <input
          type="text"
          inputMode={
            original.type === "integer" || original.type === "long"
              ? "numeric"
              : "decimal"
          }
          aria-label={name}
          aria-invalid={Boolean(draft?.error)}
          aria-describedby={draft?.error ? id : undefined}
          value={text}
          onChange={(event) =>
            editor.change(original, path, event.target.value)
          }
        />
      )}
      {draft?.error && (
        <span id={id} className="viewer-ciq-error">
          {draft.error}
        </span>
      )}
    </div>
  );
}
