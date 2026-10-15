// Development-only DOM counters let browser checks measure the real worker lifecycle.
const enabled =
  import.meta.env?.DEV &&
  typeof window !== "undefined" &&
  new URLSearchParams(location.search).has("validate");
let workers = 0;
let maximum = 0;
let chartRequests = 0;
let mapRequests = 0;
const chartRenders = new Map<string, number>();
export function validationStartDocument(): void {
  maximum = 0;
  chartRequests = 0;
  mapRequests = 0;
  chartRenders.clear();
  if (enabled)
    document.documentElement.setAttribute(
      "data-validation-chart-renders",
      "{}",
    );
  validationValue("chart-requests", 0);
  validationValue("map-requests", 0);
  validationValue("long-task-max", 0);
}
export function validationChartRequest(): void {
  if (enabled) validationValue("chart-requests", ++chartRequests);
}
export function validationMapRequest(): void {
  if (enabled) validationValue("map-requests", ++mapRequests);
}
export function validationChartRender(key: string): void {
  if (!enabled) return;
  chartRenders.set(key, (chartRenders.get(key) ?? 0) + 1);
  document.documentElement.setAttribute(
    "data-validation-chart-renders",
    JSON.stringify(Object.fromEntries(chartRenders)),
  );
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
