import type {
  DesktopPrompt,
  DesktopPromptContent,
  DesktopPromptState,
} from "../src/desktop-prompts";

export class PromptQueue {
  private sequence = 0;
  private revision = 0;
  private pending = new Map<
    number,
    { prompt: DesktopPrompt; finish: (answer: boolean | undefined) => void }
  >();

  constructor(private readonly changed: (state: DesktopPromptState) => void) {}

  snapshot(): DesktopPromptState {
    return {
      revision: this.revision,
      prompts: Array.from(this.pending.values(), ({ prompt }) => ({
        ...prompt,
      })),
    };
  }

  show(
    content: DesktopPromptContent,
    signal?: AbortSignal,
  ): Promise<boolean | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const id = ++this.sequence;
      const abort = () => finish(undefined);
      const finish = (answer: boolean | undefined) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener("abort", abort);
        this.publish();
        resolve(answer);
      };
      this.pending.set(id, { prompt: { ...content, id }, finish });
      signal?.addEventListener("abort", abort, { once: true });
      this.publish();
    });
  }

  respond(id: unknown, accepted: unknown): void {
    if (
      typeof id !== "number" ||
      !Number.isSafeInteger(id) ||
      typeof accepted !== "boolean"
    )
      throw new Error("Invalid notification response.");
    // Cancelled, already answered, or superseded prompts cannot execute actions.
    this.pending.get(id)?.finish(accepted);
  }

  cancel(): void {
    for (const { finish } of this.pending.values()) finish(undefined);
  }

  private publish(): void {
    this.revision++;
    this.changed(this.snapshot());
  }
}
