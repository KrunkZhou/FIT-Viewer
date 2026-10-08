// Development-only DOM counters let browser checks measure the real worker lifecycle.
const enabled =
  import.meta.env?.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(location.search).has("validate");
let workers = 0;
let maximum = 0;
export function validationStartDocument(): void {
  maximum = 0;
  validationValue("long-task-max", 0);
}
export function validationValue(key: string, value: number): void {
  if (enabled)
    document.documentElement.setAttribute(
      `data-validation-${key}`,
      String(Math.round(value * 100) / 100),
    );
}
export function validationWorker(change: number): void {
  workers += change;
  validationValue("workers", workers);
}
if (enabled) {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      maximum = Math.max(maximum, entry.duration);
    validationValue("long-task-max", maximum);
  }).observe({ type: "longtask" });
  for (const type of ["click", "keydown"])
    document.addEventListener(
      type,
      () => {
        const start = performance.now();
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            validationValue("interaction-ms", performance.now() - start),
          ),
        );
      },
      { capture: true },
    );
}
