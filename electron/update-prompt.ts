import type { UpdateState } from "../src/updates";

export interface UpdateOffer {
  kind: "install" | "download";
  version: string;
}

function offerFor(state: UpdateState): UpdateOffer | undefined {
  if (!state.version || !/^\d+\.\d+\.\d+$/.test(state.version)) return;
  if (state.mode === "install" && state.phase === "ready")
    return { kind: "install", version: state.version };
  if (state.mode === "download" && state.phase === "available")
    return { kind: "download", version: state.version };
}

function key(offer?: UpdateOffer): string | undefined {
  return offer && `${offer.kind}:${offer.version}`;
}

export class UpdatePrompter {
  private seen = new Set<string>();
  private active?: {
    offer: UpdateOffer;
    automatic: boolean;
    abort: AbortController;
  };
  private stopped = false;

  constructor(
    private readonly host: {
      state: () => UpdateState;
      canShow: () => boolean;
      show: (offer: UpdateOffer, signal: AbortSignal) => Promise<boolean>;
      install: () => void;
      download: (version: string) => Promise<void>;
      report: (error: unknown) => void;
    },
  ) {}

  notify(): void {
    const state = this.host.state();
    if (
      this.active &&
      (key(offerFor(state)) !== key(this.active.offer) ||
        (this.active.automatic && !state.enabled))
    )
      this.cancel();
    void this.request().catch(this.host.report);
  }

  async request(manual = false): Promise<void> {
    const state = this.host.state();
    const offer = offerFor(state);
    if (
      this.stopped ||
      this.active ||
      !offer ||
      !this.host.canShow() ||
      (!manual && (!state.enabled || this.seen.has(key(offer)!)))
    )
      return;
    const active = {
      offer,
      automatic: !manual,
      abort: new AbortController(),
    };
    this.active = active;
    this.seen.add(key(offer)!);
    try {
      const accepted = await this.host.show(offer, active.abort.signal);
      const current = this.host.state();
      if (
        !accepted ||
        active.abort.signal.aborted ||
        this.stopped ||
        key(offerFor(current)) !== key(offer) ||
        (!manual && !current.enabled)
      )
        return;
      if (offer.kind === "install") this.host.install();
      else await this.host.download(offer.version);
    } finally {
      // Closing the window or disabling updates is not a dismissal of this release.
      if (active.abort.signal.aborted) this.seen.delete(key(offer)!);
      this.active = undefined;
      this.notify();
    }
  }

  cancel(): void {
    this.active?.abort.abort();
  }

  dispose(): void {
    this.stopped = true;
    this.cancel();
  }
}
