import type { CiqSettingsEdit } from "../model";
import type { CiqScalar } from "../protocol/ciq-settings";
import { parseCiqInput } from "../protocol/ciq-edit";

export interface CiqDraft {
  text: string;
  edit?: CiqSettingsEdit;
  error?: string;
}
const EMPTY: ReadonlyMap<string, CiqDraft> = new Map();

// Workspace source IDs remain stable when a filtered document rebases its IDs.
export class CiqDraftStore {
  private files = new Map<number, ReadonlyMap<string, CiqDraft>>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  hasChanges = (): boolean => this.files.size > 0;
  get(source: number): ReadonlyMap<string, CiqDraft> {
    return this.files.get(source) ?? EMPTY;
  }
  change(
    source: number,
    original: CiqScalar,
    path: number[],
    text: string,
  ): void {
    const key = path.join(".");
    const drafts = new Map(this.get(source));
    try {
      const value = parseCiqInput(original, text);
      if (Object.is(value.value, original.value)) drafts.delete(key);
      else drafts.set(key, { text, edit: { path: [...path], value } });
    } catch (error) {
      drafts.set(key, { text, error: (error as Error).message });
    }
    if (drafts.size) this.files.set(source, drafts);
    else this.files.delete(source);
    this.notify();
  }
  reset(source: number): void {
    this.files.delete(source);
    this.notify();
  }
  clear(): void {
    this.files.clear();
    this.notify();
  }
  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
