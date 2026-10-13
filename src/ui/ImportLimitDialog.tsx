import { Download } from "lucide-react";
import { GITHUB_URL } from "../app-info";
import { DESKTOP_IMPORT_LIMIT_BYTES } from "../document/input";
import { Modal } from "./controls";

export function ImportLimitDialog({
  limit,
  onClose,
}: {
  limit: number;
  onClose: () => void;
}) {
  return (
    <Modal title="File too large for the web viewer" onClose={onClose}>
      <div className="import-limit-message">
        <p>
          This selection exceeds the web import limit of {limit / 1048576} MiB.
          The limit applies to the total selected files and extracted FIT data
          in ZIP archives.
        </p>
        <p>
          {limit < DESKTOP_IMPORT_LIMIT_BYTES
            ? "For larger imports, download FIT Viewer for Windows or macOS. "
            : "FIT Viewer is also available for Windows and macOS. "}
          The desktop app supports up to{" "}
          {DESKTOP_IMPORT_LIMIT_BYTES / 1024 ** 3} GiB per import, subject to
          available memory. Split larger selections into smaller batches.
        </p>
      </div>
      <div className="import-limit-actions">
        <button className="viewer-command" onClick={onClose}>
          Close
        </button>
        <a
          className="primary"
          href={`${GITHUB_URL}/releases/latest`}
          target="_blank"
          rel="noopener noreferrer"
        >
          <Download size={16} aria-hidden="true" />
          Download desktop app
        </a>
      </div>
    </Modal>
  );
}
