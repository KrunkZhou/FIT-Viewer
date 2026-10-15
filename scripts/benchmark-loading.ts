import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { FitDocument } from "../src/document/document";
import { loadFile } from "../src/document/files";
import { createJob } from "../src/document/jobs";
import { ChartCache } from "../src/document/chart-cache";
import { MapCache } from "../src/document/map-cache";
import { addSummaryDiagnostics } from "../src/repair/repair";
import { activity } from "../tests/fixtures";
import { sensors as sensorCandidates } from "../src/document/series";

const stage = process.argv[2] ?? "current";
if (!/^[a-z0-9-]+$/i.test(stage)) throw new Error("Invalid benchmark label");
const selectedFirst = process.argv.includes("--selected-first");
const path = process.argv.slice(3).find((value) => !value.startsWith("--"));
const inputs = path ? [0] : [100_000, 1_000_000];
const reports = [];
for (const count of inputs) {
  const bytes = path ? new Uint8Array(await readFile(path)) : activity(count);
  const input = new File(
    [bytes.slice()],
    path ? basename(path) : "synthetic.fit",
  );
  const times: Record<string, number> = {};
  let peakHeap = 0;
  let peakRss = 0;
  let maximumSlice = 0;
  async function measure<T>(
    name: string,
    work: (job: ReturnType<typeof createJob>) => Promise<T>,
  ) {
    const job = createJob(new AbortController().signal);
    const start = performance.now();
    let last = start;
    const result = await work({
      ...job,
      yield: async () => {
        maximumSlice = Math.max(maximumSlice, performance.now() - last);
        const memory = process.memoryUsage();
        peakHeap = Math.max(peakHeap, memory.heapUsed);
        peakRss = Math.max(peakRss, memory.rss);
        await job.yield();
        last = performance.now();
      },
    });
    times[name] = performance.now() - start;
    return result;
  }
  const loaded = await measure("readMs", (job) =>
    loadFile(input, 2 ** 30, job),
  );
  const document = await measure("openMs", async (job) => {
    const document = await FitDocument.openSources(
      loaded.sources,
      loaded.filename,
      job,
    );
    await addSummaryDiagnostics(document, job);
    return document;
  });
  const table = await measure("tableMs", (job) =>
    document.table({ message: 20, developer: false, page: 0, size: 20 }, job),
  );
  const charts = new ChartCache();
  const inventory = selectedFirst
    ? { sensors: sensorCandidates(document, false) }
    : await measure("sensorsMs", (job) =>
        charts.query(
          document,
          { sensors: [], developer: false, width: 1366 },
          job,
        ),
      );
  const sensors = inventory.sensors
    .filter(
      (sensor) =>
        (sensor.message === 20 && ["3", "6", "73"].includes(sensor.field!)) ||
        ([164, 165].includes(sensor.message!) &&
          ["5", "6", "7"].includes(sensor.field!)),
    )
    .map((sensor) => sensor.key);
  const query = {
    sensors,
    developer: false,
    width: 1366,
    detail: "high" as const,
  };
  const chart = await measure("chartMs", (job) =>
    charts.query(document, query, job),
  );
  await measure("cachedChartMs", (job) => charts.query(document, query, job));
  if (selectedFirst)
    await measure("remainingSensorsMs", (job) =>
      charts.query(
        document,
        { sensors: [], developer: false, width: 1366 },
        job,
      ),
    );
  const maps = new MapCache();
  const { data: map } = await measure("mapMs", (job) =>
    maps.query(document, job),
  );
  await measure("cachedMapMs", (job) => maps.query(document, job));
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        { summary: document.summary(), table, chart, map },
        (_, v) => (typeof v === "bigint" ? v.toString() : v),
      ),
    )
    .digest("hex");
  const report = {
    input: path ? "external" : "synthetic",
    records: document.index.records.length,
    bytes: document.index.bytes.length,
    selectedFirst,
    ...times,
    // Checkpoint spacing includes awaited I/O and GC; it is not a main-thread task duration.
    maximumCheckpointIntervalMs: maximumSlice,
    peakHeapMiB: peakHeap / 2 ** 20,
    peakRssMiB: peakRss / 2 ** 20,
    outputHash: hash,
  };
  reports.push(report);
  console.log(JSON.stringify(report));
}
await mkdir(".cache", { recursive: true });
await writeFile(
  `.cache/loading-${stage}.json`,
  JSON.stringify(reports, null, 2) + "\n",
);
