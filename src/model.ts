export type Scalar = number | bigint | string | null;
export type RawValue = Scalar | Scalar[];
export type DisplayValue = Scalar | Scalar[];

export interface WireField {
  id: number;
  size: number;
  type: number;
  developer?: number;
}
export interface Definition {
  message: number;
  local: number;
  littleEndian: boolean;
  fields: WireField[];
  offset: number;
  end: number;
  subfile: number;
}
export interface RecordRef {
  definition: Definition;
  offset: number;
  end: number;
  subfile: number;
  timestamp?: number;
  compressed: boolean;
}
export interface Subfile {
  index: number;
  source?: number;
  start: number;
  headerSize: number;
  bodyStart: number;
  declaredEnd: number;
  bodyEnd: number;
  end: number;
  profileVersion: number;
  manufacturer?: number;
  product?: number;
  type?: number;
  safePrefix: boolean;
}
export interface Diagnostic {
  id: string;
  severity: "warning" | "error";
  code: string;
  message: string;
  subfile: number;
  source?: number;
  offset: number;
  end: number;
  record?: number;
  messageId?: number;
  repair: "header" | "crc" | "tail" | "summary" | "none";
}
export interface FieldInfo {
  key: string;
  id: number;
  name: string;
  type: string;
  units: string;
  unknown: boolean;
  developer: boolean;
  description?: string;
  scale?: number;
  offset?: number;
  values?: Record<string, string>;
  bitmask?: boolean;
}
export interface MessageInfo {
  id: number;
  name: string;
  count: number;
  known: boolean;
}
export interface DocumentSummary {
  filename: string;
  sources: SourceInfo[];
  bytes: number;
  records: number;
  gpsPoints: number;
  startTimestamp?: number;
  endTimestamp?: number;
  durationSeconds?: number;
  sports: string[];
  fileTypes: string[];
  messages: MessageInfo[];
  subfiles: Subfile[];
  diagnostics: Diagnostic[];
  diagnosticCount: number;
  hasMap: boolean;
  hasCharts: boolean;
  hasHrv: boolean;
  repairable: boolean;
}
export interface SourceInfo {
  id: number;
  filename: string;
  bytes: number;
  start: number;
  end: number;
  records: number;
  startTimestamp?: number;
  endTimestamp?: number;
  error?: string;
}
export interface Cell {
  raw: RawValue;
  value: DisplayValue;
  numeric: boolean;
}
export interface TableRow {
  index: number;
  offset: number;
  subfile: number;
  cells: Record<string, Cell>;
}
export interface TableQuery {
  message: number;
  developer: boolean;
  page: number;
  size: number;
  filters?: Record<string, string[]>;
  timestamp?: number;
  target?: number;
}
export interface TablePage {
  message: MessageInfo;
  fields: FieldInfo[];
  rows: TableRow[];
  total: number;
  page: number;
  size: number;
  selected?: number;
  options: Record<string, string[]>;
}
export interface SingleEntryView {
  entries: { message: MessageInfo; fields: FieldInfo[]; row: TableRow }[];
}
export interface DiagnosticPage {
  issues: Diagnostic[];
  total: number;
  page: number;
  size: number;
}
export interface Sensor {
  key: string;
  name: string;
  label?: string;
  units: string;
  axis?: "time" | "sample";
  source?: number;
  message?: number;
  field?: string;
}
export interface ChartPoint {
  time: number;
  value: number | null;
}
export interface ChartQuery {
  sensors: string[];
  width: number;
  start?: number;
  end?: number;
  developer: boolean;
  filter?: { min?: number; max?: number };
}
export interface ChartData {
  sensors: Sensor[];
  series: Record<string, ChartPoint[]>;
  start: number;
  end: number;
}
export interface Position {
  lat: number;
  lon: number;
  time?: number;
  elevation?: number;
  distance?: number;
  record: number;
}
export interface MapPoint extends Position {
  name?: string;
  route?: number;
  kind: "waypoint" | "lap" | "distance" | "start" | "finish";
}
export interface MapData {
  tracks: Position[][];
  points: MapPoint[];
  routeNames?: string[];
}
export interface ExportQuery {
  format: "csv" | "gpx" | "geojson" | "hrv" | "json" | "fit";
  message?: number;
  developer?: boolean;
  timeFormat?: "iso" | "localized";
  locale?: string;
  timezone?: string;
  sensors?: string[];
  withLaps?: boolean;
}
export interface ExportResult {
  blob: Blob;
  filename: string;
  partial?: boolean;
  generated?: string[];
  unresolved?: string[];
}
export type RequestPayload = (
  | {
      kind: "open";
      file: File;
      filename?: string;
      limit: number;
    }
  | { kind: "summary" }
  | { kind: "table"; query: TableQuery }
  | { kind: "singletons"; developer: boolean }
  | { kind: "chart"; query: ChartQuery }
  | { kind: "map" }
  | { kind: "diagnostics"; page: number; size: number }
  | { kind: "export"; query: ExportQuery }
  | { kind: "cancel"; target: number }
  | { kind: "dispose" }
) & { source?: number };
export type WorkerRequest = RequestPayload & {
  requestId: number;
  documentId: number;
};
export type WorkerResponsePayload =
  | {
      kind: "result";
      result:
        | DocumentSummary
        | TablePage
        | SingleEntryView
        | DiagnosticPage
        | ChartData
        | MapData
        | ExportResult
        | null;
    }
  | { kind: "progress"; completed: number; total: number; phase: string }
  | { kind: "error"; message: string; aborted?: boolean };
export type WorkerResponse = WorkerResponsePayload & {
  requestId: number;
  documentId: number;
};
export interface Job {
  signal: AbortSignal;
  progress: (completed: number, total: number, phase: string) => void;
  yield: () => Promise<void>;
}
