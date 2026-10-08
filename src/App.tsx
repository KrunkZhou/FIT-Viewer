import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ClipboardList,
  Download,
  File,
  LayoutDashboard,
  LoaderCircle,
  Map,
  Moon,
  Sun,
  Upload,
  X,
} from "lucide-react";
import { DocumentClient } from "./document/client";
import { Downloads } from "./ui/download";
import type { DocumentSummary, ExportQuery } from "./model";
import { Overview } from "./ui/Overview";
import { Messages } from "./ui/Messages";
import { Diagnostics } from "./ui/Diagnostics";
import {
  IconButton,
  Modal,
  navigateTabs,
  readPreference,
  savePreference,
  Toggle,
} from "./ui/controls";
const Charts = lazy(() => import("./ui/Charts"));
const ActivityMap = lazy(() => import("./ui/Map"));
type Tab = "overview" | "messages" | "map" | "chart" | "diagnostics";

export default function App() {
  const client = useMemo(() => new DocumentClient(), []);
  const [summary, setSummary] = useState<DocumentSummary>();
  const [selectedFile, setSelectedFile] = useState<File>();
  const [entries, setEntries] = useState<string[]>();
  const [entry, setEntry] = useState("");
  const [developer, setDeveloper] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [visited, setVisited] = useState<Tab[]>(["overview"]);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    readPreference(
      "fitviewer-theme",
      readPreference(
        "theme",
        typeof matchMedia !== "undefined" &&
          matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light",
        (v): v is "light" | "dark" => v === "light" || v === "dark",
      ),
      (v): v is "light" | "dark" => v === "light" || v === "dark",
    ),
  );
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [progress, setProgress] = useState<{ value: number; phase: string }>();
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [csvQuery, setCsvQuery] = useState<ExportQuery>();
  const [csvFormat, setCsvFormat] = useState<"iso" | "localized">("iso");
  const [remember, setRemember] = useState(false);
  const [target, setTarget] = useState<{ message: number; record: number }>();
  const fileInput = useRef<HTMLInputElement>(null);
  const downloads = useRef(new Downloads());
  const job = useRef<AbortController | undefined>(undefined);
  const generation = useRef(0);
  const exportGuard = useRef(false);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    savePreference("fitviewer-theme", theme);
  }, [theme]);
  useEffect(
    () => () => {
      job.current?.abort();
      client.destroy();
      downloads.current.clear();
    },
    [client],
  );
  useEffect(() => {
    setVisited((previous) =>
      previous.includes(tab) ? previous : [...previous, tab],
    );
  }, [tab]);
  const updateProgress = (completed: number, total: number, phase: string) =>
    setProgress({ value: total ? completed / total : 0, phase });
  async function open(file: File, selectedEntry?: string) {
    const id = ++generation.current;
    job.current?.abort();
    downloads.current.clear();
    const controller = new AbortController();
    job.current = controller;
    exportGuard.current = false;
    setExporting(false);
    setBusy(true);
    setError("");
    setNotice("");
    setSummary(undefined);
    setCsvQuery(undefined);
    setSelectedFile(file);
    setProgress({ value: 0, phase: "Opening file" });
    if (!selectedEntry) {
      setEntries(undefined);
      setEntry("");
    }
    try {
      const config = Number(import.meta.env.VITE_MAX_FILE_MIB) || 512;
      const result = await client.open(file, {
        entry: selectedEntry,
        limit: config * 1048576,
        signal: controller.signal,
        progress: updateProgress,
      });
      if (id !== generation.current || controller.signal.aborted) return;
      if ("entries" in result) {
        setEntries(result.entries);
        setEntry("");
      } else {
        setSummary(result);
        setTab("overview");
        setVisited(["overview"]);
        setTarget(undefined);
      }
    } catch (error) {
      if (id === generation.current && (error as Error).name !== "AbortError")
        setError((error as Error).message);
    } finally {
      if (id === generation.current) {
        setBusy(false);
        setProgress(undefined);
      }
    }
  }
  async function runExport(query: ExportQuery) {
    if (exportGuard.current || !summary) return;
    exportGuard.current = true;
    const id = generation.current;
    const controller = new AbortController();
    job.current = controller;
    setExporting(true);
    setError("");
    setNotice("");
    setProgress({ value: 0, phase: "Preparing download" });
    try {
      const result = await client.export(
        {
          ...query,
          locale: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        controller.signal,
        updateProgress,
      );
      if (id !== generation.current || controller.signal.aborted) return;
      downloads.current.save(result);
      if (query.format === "fit")
        setNotice(
          `${result.partial ? "Partial recovery validated; missing or undecodable source data could not be recovered." : "Repaired file structure validated."}${result.generated?.length ? ` Generated: ${result.generated.join(", ")}.` : ""}${result.unresolved?.length ? ` ${result.unresolved.length} warnings or unresolved omissions remain; inspect the repaired file in Diagnostics.` : ""}`,
        );
    } catch (error) {
      if (id === generation.current && (error as Error).name !== "AbortError")
        setError((error as Error).message);
    } finally {
      if (id === generation.current) {
        exportGuard.current = false;
        setExporting(false);
        setProgress(undefined);
      }
    }
  }
  function download(query: ExportQuery) {
    if (exportGuard.current) return;
    if (query.format === "csv" && !query.developer) {
      const stored = readPreference<"iso" | "localized" | "local" | null>(
        "csvTimeFormat",
        null,
        (v): v is "iso" | "localized" | "local" =>
          v === "iso" || v === "localized" || v === "local",
      );
      if (!stored) {
        setCsvQuery(query);
        return;
      }
      void runExport({
        ...query,
        timeFormat: stored === "local" ? "localized" : stored,
      });
    } else void runExport(query);
  }
  const tabs = [
    { id: "overview" as const, title: "Overview", icon: LayoutDashboard },
    { id: "messages" as const, title: "Messages", icon: ClipboardList },
    ...(summary?.hasMap
      ? [{ id: "map" as const, title: "Map", icon: Map }]
      : []),
    ...(summary?.hasCharts
      ? [{ id: "chart" as const, title: "Chart", icon: Activity }]
      : []),
    ...(summary?.diagnosticCount
      ? [
          {
            id: "diagnostics" as const,
            title: "Diagnostics",
            icon: AlertTriangle,
          },
        ]
      : []),
  ];
  const content = summary ? (
    <>
      <div className="section-view" hidden={tab !== "overview"}>
        <Overview
          summary={summary}
          diagnostics={() => setTab("diagnostics")}
          download={download}
        />
      </div>
      {visited.includes("messages") && (
        <div className="section-view" hidden={tab !== "messages"}>
          <Messages
            client={client}
            summary={summary}
            developer={developer}
            download={download}
            target={target}
          />
        </div>
      )}
      {summary.hasMap && visited.includes("map") && (
        <div className="section-view" hidden={tab !== "map"}>
          <ActivityMap client={client} download={download} />
        </div>
      )}
      {visited.includes("chart") && (
        <div className="section-view" hidden={tab !== "chart"}>
          <Charts
            client={client}
            developer={developer}
            download={download}
            active={tab === "chart"}
          />
        </div>
      )}
      {visited.includes("diagnostics") && (
        <div className="section-view" hidden={tab !== "diagnostics"}>
          <Diagnostics
            client={client}
            summary={summary}
            download={download}
            inspect={(message, record) => {
              setDeveloper(true);
              setTarget({ message, record });
              setTab("messages");
            }}
          />
        </div>
      )}
    </>
  ) : (
    <div className="viewer-empty">
      {busy ? (
        <LoaderCircle className="spin" size={24} />
      ) : (
        <Upload size={28} />
      )}
      <h2>
        {busy
          ? "Opening FIT file..."
          : entries
            ? "Select a FIT file"
            : "Open a FIT file"}
      </h2>
      {entries ? (
        <select
          aria-label="FIT file in ZIP"
          value={entry}
          onChange={(event) => {
            setEntry(event.target.value);
            if (event.target.value && selectedFile)
              void open(selectedFile, event.target.value);
          }}
        >
          <option value="" disabled>
            Select a file
          </option>
          {entries.map((name) => (
            <option key={name}>{name}</option>
          ))}
        </select>
      ) : (
        !busy && (
          <button
            className="viewer-open-button"
            onClick={() => fileInput.current?.click()}
          >
            <Upload size={16} />
            Open FIT file
          </button>
        )
      )}
    </div>
  );
  return (
    <div
      className="viewer-app"
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (event.dataTransfer.files[0]) void open(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={fileInput}
        type="file"
        accept=".fit,.zip"
        className="file-input"
        aria-label="Open FIT file"
        onChange={(event) => {
          if (event.target.files?.[0]) void open(event.target.files[0]);
          event.target.value = "";
        }}
      />
      <main className="viewer-main">
        <header className="viewer-file-bar">
          <div className="viewer-file">
            <File size={18} />
            <h2>
              {summary?.filename ?? selectedFile?.name ?? "No file selected"}
            </h2>
            {summary && entries && (
              <select
                aria-label="FIT file in ZIP"
                value={entry}
                onChange={(event) => {
                  setEntry(event.target.value);
                  if (selectedFile) void open(selectedFile, event.target.value);
                }}
              >
                {entries.map((name) => (
                  <option key={name}>{name}</option>
                ))}
              </select>
            )}
          </div>
          <div className="viewer-file-actions">
            <label className="viewer-mode-toggle">
              Developer
              <Toggle
                label="Developer Mode"
                checked={developer}
                onChange={setDeveloper}
                descriptionId="developer-mode-help"
              />
              <span
                id="developer-mode-help"
                role="tooltip"
                className="viewer-mode-tooltip"
              >
                Shows raw recorded values and undocumented message types and
                fields. Does not modify the FIT file.
              </span>
            </label>
            <IconButton
              title={
                theme === "dark"
                  ? "Switch to light mode"
                  : "Switch to dark mode"
              }
              onClick={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
            >
              {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
            </IconButton>
            {summary?.hasHrv && (
              <IconButton
                title="Download RR intervals"
                onClick={() => download({ format: "hrv" })}
              >
                <Download size={18} />
              </IconButton>
            )}
            <button
              className="open-file"
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={15} />
              <span>Open FIT file</span>
            </button>
          </div>
        </header>
        {progress && (
          <div className="viewer-progress">
            <progress value={progress.value} max={1} />
            <span>
              {progress.phase} {Math.round(progress.value * 100)}%
            </span>
            <IconButton
              title="Cancel operation"
              onClick={() => job.current?.abort()}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
        {error && (
          <p className="banner error" role="alert">
            {error}
            <IconButton title="Dismiss error" onClick={() => setError("")}>
              <X size={16} />
            </IconButton>
          </p>
        )}
        {notice && (
          <p className="banner" role="status">
            {notice}
            <IconButton
              title="Dismiss notification"
              onClick={() => setNotice("")}
            >
              <X size={16} />
            </IconButton>
          </p>
        )}
        <div className="section-tabs">
          <nav className="viewer-tab-navigation">
            <div
              className="viewer-tab-list"
              role="tablist"
              aria-label="File sections"
              onKeyDown={navigateTabs}
            >
              {tabs.map(({ id, title, icon: Icon }) => (
                <button
                  id={`tab-${id}`}
                  aria-controls="section-panel"
                  role="tab"
                  tabIndex={tab === id ? 0 : -1}
                  aria-selected={tab === id}
                  className="viewer-tab"
                  key={id}
                  onClick={() => setTab(id)}
                >
                  <Icon size={17} />
                  {title}
                  {id === "messages" && summary && (
                    <span className="viewer-tab-count">
                      {
                        summary.messages.filter((m) => developer || m.known)
                          .length
                      }
                    </span>
                  )}
                  {id === "diagnostics" && (
                    <span className="viewer-tab-count">
                      {summary?.diagnosticCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </nav>
          <div className="viewer-tab-panels">
            <section
              id="section-panel"
              role="tabpanel"
              aria-labelledby={`tab-${tab}`}
              data-tab-id={tab}
              className="viewer-tab-panel"
            >
              <Suspense fallback={<p className="viewer-loading">Loading...</p>}>
                {content}
              </Suspense>
            </section>
          </div>
        </div>
        {exporting && (
          <div className="export-busy" role="status">
            <LoaderCircle className="spin" size={16} />
            Exporting...
            <IconButton
              title="Cancel export"
              onClick={() => job.current?.abort()}
            >
              <X size={16} />
            </IconButton>
          </div>
        )}
      </main>
      {csvQuery && (
        <Modal
          title="Format for timestamps in CSV"
          onClose={() => setCsvQuery(undefined)}
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const query = csvQuery;
              setCsvQuery(undefined);
              if (remember) savePreference("csvTimeFormat", csvFormat);
              void runExport({ ...query, timeFormat: csvFormat });
            }}
          >
            <div className="csv-options">
              <label>
                <input
                  type="radio"
                  name="csv-format"
                  checked={csvFormat === "iso"}
                  onChange={() => setCsvFormat("iso")}
                />
                ISO format
              </label>
              <label>
                <input
                  type="radio"
                  name="csv-format"
                  checked={csvFormat === "localized"}
                  onChange={() => setCsvFormat("localized")}
                />
                Localized format
              </label>
            </div>
            <div className="viewer-csv-actions">
              <label>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(event) => setRemember(event.target.checked)}
                />
                Remember my choice
              </label>
              <button className="primary" type="submit">
                Download
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
