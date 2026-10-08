import type { Job } from "../model";

export function createJob(
  signal: AbortSignal,
  progress: Job["progress"] = () => {},
): Job {
  let reported = 0;
  let yielded = performance.now();
  return {
    signal,
    progress: (completed, total, phase) => {
      const now = performance.now();
      if (completed === total || now - reported > 80) {
        reported = now;
        progress(completed, total, phase);
      }
    },
    yield: async () => {
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (performance.now() - yielded < 4) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      yielded = performance.now();
      if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    },
  };
}
