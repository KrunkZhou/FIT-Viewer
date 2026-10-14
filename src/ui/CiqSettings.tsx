import type { DocumentSummary } from "../model";
import type { CiqValue } from "../protocol/ciq-settings";

export function CiqSettings({
  files,
}: {
  files: NonNullable<DocumentSummary["ciqSettings"]>;
}) {
  return (
    <section className="viewer-ciq-settings">
      <div className="viewer-section-heading">
        <h2 className="viewer-section-title">CIQ Settings</h2>
        <span className="viewer-muted">
          {files.length} settings file{files.length === 1 ? "" : "s"}
        </span>
      </div>
      <p className="viewer-muted">
        Connect IQ app settings from parsed .SET files.
      </p>
      {files.map((file) => (
        <section className="viewer-ciq-file" key={file.source}>
          <div className="viewer-section-heading">
            <h3>{file.filename}</h3>
            <span className="viewer-muted">
              {file.settings.entries.length.toLocaleString()} propert
              {file.settings.entries.length === 1 ? "y" : "ies"}
            </span>
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
                {file.settings.entries.map((entry, index) => (
                  <tr key={index}>
                    <th scope="row">
                      <CiqKey value={entry.key} />
                    </th>
                    <td className="viewer-ciq-type">{entry.value.type}</td>
                    <td>
                      <CiqValueDisplay value={entry.value} />
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
      ))}
    </section>
  );
}

function CiqKey({ value }: { value: CiqValue }) {
  return value.type === "string" ? (
    <span className="viewer-ciq-key">{value.value || '""'}</span>
  ) : (
    <div className="viewer-ciq-typed-value">
      <span className="viewer-ciq-type">{value.type}</span>
      <CiqValueDisplay value={value} />
    </div>
  );
}

function CiqValueDisplay({ value }: { value: CiqValue }) {
  if (value.type === "array") {
    if (!value.items.length)
      return <code className="viewer-ciq-value">[]</code>;
    return (
      <ol className="viewer-ciq-array" start={0}>
        {value.items.map((item, index) => (
          <li key={index}>
            <div className="viewer-ciq-typed-value">
              <span className="viewer-ciq-type">{item.type}</span>
              <CiqValueDisplay value={item} />
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
        {value.entries.map((entry, index) => (
          <div key={index}>
            <dt>
              <CiqKey value={entry.key} />
            </dt>
            <dd className="viewer-ciq-typed-value">
              <span className="viewer-ciq-type">{entry.value.type}</span>
              <CiqValueDisplay value={entry.value} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return (
    <code className="viewer-ciq-value">
      {value.type === "string"
        ? JSON.stringify(value.value)
        : String(value.value)}
    </code>
  );
}
