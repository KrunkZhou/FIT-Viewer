import type { UpdateMode, UpdateState } from "../src/updates";

export interface UpdateBackend {
  mode: UpdateMode;
  check(
    signal: AbortSignal,
    progress: (version: string, percent: number) => void,
  ): Promise<{ version?: string; ready?: boolean }>;
  install(): void;
}

export class UpdateController {
  private state: UpdateState;
  private job?: AbortController;
  private pending?: Promise<UpdateState>;
  private preferences = Promise.resolve();
  private startup?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private stopped = false;
  private listeners = new Set<(state: UpdateState) => void>();
  constructor(
    private readonly backend: UpdateBackend,
    enabled: boolean,
    private readonly save: (enabled: boolean) => Promise<void>,
  ) {
    this.state = { revision: 0, enabled, mode: backend.mode, phase: "idle" };
  }
  snapshot(): UpdateState {
    return { ...this.state };
  }
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private publish(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch, revision: this.state.revision + 1 };
    for (const listener of this.listeners) listener(this.snapshot());
  }
  start(): void {
    clearTimeout(this.startup);
    clearInterval(this.interval);
    if (
      this.stopped ||
      !this.state.enabled ||
      this.backend.mode === "unavailable"
    )
      return;
    this.startup = setTimeout(() => void this.check(), 10_000);
    this.interval = setInterval(() => void this.check(), 6 * 60 * 60 * 1000);
    this.startup.unref?.();
    this.interval.unref?.();
  }
  setEnabled(enabled: boolean): Promise<UpdateState> {
    const operation = this.preferences.then(async () => {
      if (this.stopped) return;
      if (!enabled) {
        this.job?.abort();
        this.publish({
          enabled: false,
          phase: "idle",
          version: undefined,
          percent: undefined,
          message: undefined,
        });
        this.start();
      }
      try {
        await this.save(enabled);
        if (this.stopped) return;
        this.publish({ enabled, message: undefined });
        this.start();
      } catch {
        if (!this.stopped)
          this.publish({
            phase: "error",
            message: "Could not save the update setting. Please try again.",
          });
      }
    });
    this.preferences = operation.catch(() => {});
    return operation.then(() => this.snapshot());
  }
  check(manual = false): Promise<UpdateState> {
    if (this.pending) return this.pending;
    if (
      this.stopped ||
      this.backend.mode === "unavailable" ||
      (!manual && !this.state.enabled) ||
      this.state.phase === "ready"
    )
      return Promise.resolve(this.snapshot());
    const controller = new AbortController();
    this.job = controller;
    this.publish({
      phase: "checking",
      version: undefined,
      percent: undefined,
      message: undefined,
    });
    const task = async () => {
      try {
        const result = await this.backend.check(
          controller.signal,
          (version, percent) => {
            if (!controller.signal.aborted)
              this.publish({
                phase: "downloading",
                version,
                percent: Math.max(0, Math.min(100, Math.round(percent))),
              });
          },
        );
        if (!controller.signal.aborted)
          this.publish({
            phase: result.version
              ? result.ready
                ? "ready"
                : "available"
              : "current",
            version: result.version,
            percent: undefined,
          });
      } catch {
        if (!controller.signal.aborted)
          this.publish({
            phase: "error",
            percent: undefined,
            message:
              "Could not check or download updates. Please try again later.",
          });
      } finally {
        this.job = undefined;
        this.pending = undefined;
      }
      return this.snapshot();
    };
    this.pending = Promise.resolve().then(task);
    return this.pending;
  }
  install(): void {
    if (
      this.state.phase !== "ready" ||
      this.backend.mode !== "install" ||
      this.stopped
    )
      throw new Error("No verified update is ready to install.");
    this.backend.install();
  }
  dispose(): void {
    this.stopped = true;
    this.job?.abort();
    clearTimeout(this.startup);
    clearInterval(this.interval);
    this.listeners.clear();
  }
}
