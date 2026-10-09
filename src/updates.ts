export type UpdateMode = "install" | "download" | "unavailable";
export interface UpdateState {
  revision: number;
  enabled: boolean;
  mode: UpdateMode;
  phase:
    | "idle"
    | "checking"
    | "downloading"
    | "available"
    | "ready"
    | "current"
    | "error";
  version?: string;
  percent?: number;
  message?: string;
}
export interface DesktopUpdates {
  getState(): Promise<UpdateState>;
  setEnabled(enabled: boolean): Promise<UpdateState>;
  check(): Promise<UpdateState>;
  install(): Promise<void>;
  onChange(callback: (state: UpdateState) => void): () => void;
}
