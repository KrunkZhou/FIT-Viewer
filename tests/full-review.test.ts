import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { NumericReader } from "../src/document/numeric-reader";
import { Metadata } from "../src/metadata/profile";
import { chartPoints, mapPositions, sensors } from "../src/document/series";
import { MapPlaybackIndex } from "../src/document/map-playback";
import { loadFile } from "../src/document/files";
import { exportDocument } from "../src/export/export";
import { exportFilename } from "../src/ui/save-destination";
import { readFit, idleJob } from "../src/protocol/reader";
import { wrapBody } from "../src/protocol/writer";
import { repair } from "../src/repair/repair";
import { activity, file, join, type Field } from "./fixtures";
import type { ExportQuery } from "../src/model";

test("damaged sizes cannot turn checksums into records before another FIT header", async () => {
  const first = file(
    [
      { message: 50000, fields: [[0, 4, 27]] },
      { message: 20, fields: [[3, 2, 123]] },
    ],
    false,
  );
  // This trailer is also a valid two-byte local-message-zero data record.
  assert.equal(first.at(-2), 0);
  const next = file([{ message: 20, fields: [[3, 2, 124]] }], false);
  for (const delta of [-1, 1, 100]) {
    const damaged = first.slice();
    const view = new DataView(damaged.buffer);
    view.setUint32(4, view.getUint32(4, true) + delta, true);
    const document = await FitDocument.open(
      join([damaged, next]),
      "boundary.fit",
    );
    assert.equal(document.index.records.length, 3);
    assert.equal(document.index.subfiles[0].bodyEnd, first.length - 2);
    assert.equal(document.index.subfiles.length, 2);
    assert.equal(
      new Set(document.index.diagnostics.map((d) => d.id)).size,
      document.index.diagnostics.length,
    );
    const fixed = await repair(document);
    assert.deepEqual(fixed.bytes, join([first, next]));
    assert.deepEqual(fixed.generated, []);
  }
});

test("boundary recovery supports 12-byte headers and does not drop a final real record", async () => {
  const source = file([{ message: 20, fields: [[3, 2, 123]] }], false);
  const header = source.slice(0, 12);
  header[0] = 12;
  const original = wrapBody(source.subarray(14, source.length - 2), header);
  const damaged = original.slice();
  const view = new DataView(damaged.buffer);
  view.setUint32(4, view.getUint32(4, true) - 1, true);
  const next = file([{ message: 20, fields: [[3, 2, 124]] }], false);
  const recovered = await FitDocument.open(join([damaged, next]), "twelve.fit");
  assert.equal(recovered.index.records.length, 2);
  assert.deepEqual((await repair(recovered)).bytes, join([original, next]));
  const noTrailer = await readFit(
    join([source.subarray(0, source.length - 2), next]),
  );
  assert.equal(noTrailer.records.length, 2);
  assert.equal(noTrailer.raw(noTrailer.records[0])["3"], 123);
});

test("RR export chooses its source per subfile, in order, without duplicate HR fallback", async () => {
  const hr = (values: number[]) => ({
    message: 132,
    fields: [[9, 6, values]] as Field[],
  });
  const hrv = { message: 78, fields: [[0, 4, [800, 900]]] as Field[] };
  const sources = [
    file([hr([1024, 2048, 3072])], false),
    file([hr([1024, 2560]), hrv], false),
    file([hr([1024, 1536])], false),
  ];
  for (const document of [
    await FitDocument.open(join(sources), "concatenated.fit"),
    await FitDocument.openSources(
      sources.map((bytes, i) => ({ filename: `${i}.fit`, bytes })),
      "folder",
    ),
  ]) {
    const result = await exportDocument(document, { format: "hrv" });
    assert.equal(await result.blob.text(), "1000\n1000\n800\n900\n500\n");
  }
});

test("out-of-range timestamp values stay raw without crashing interpretation or export", async () => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 9, 1e20],
            [0, 5, 100],
            [1, 5, 100],
            [3, 2, 120],
          ],
        },
      ],
      false,
    ),
    "dates.fit",
  );
  assert.equal(document.cells(0)["253"].raw, 1e20);
  assert.equal(document.cells(0)["253"].value, null);
  assert.equal(
    new NumericReader(document, ["253"], false).read(0)[0]?.value,
    null,
  );
  for await (const entry of mapPositions(document, idleJob()))
    assert.equal(entry.point?.time, undefined);
  for (const format of ["csv", "gpx", "geojson"] as const) {
    const result = await exportDocument(document, { format });
    const text = await result.blob.text();
    assert.ok(!text.includes("Invalid Date"));
    assert.ok(!text.includes("<time>null</time>"));
  }
});

test("map slider decodes only position fields, not unrelated record arrays", async (t) => {
  const document = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 100],
            [0, 5, 100],
            [1, 5, 100],
            [2, 4, 3000],
            [5, 6, 250],
            [200, 2, Array(200).fill(10)],
          ],
        },
      ],
      false,
    ),
    "slider.fit",
  );
  const index = new MapPlaybackIndex();
  await index.addColumns(Float64Array.of(100), Uint32Array.of(0), 0, idleJob());
  const cell = document.metadata.cell.bind(document.metadata);
  const fields: number[] = [];
  t.mock.method(
    document.metadata,
    "cell",
    (...args: Parameters<typeof cell>) => {
      fields.push(args[1].id);
      return cell(...args);
    },
  );
  const position = await index.position(document, 100, [0], idleJob());
  assert.equal(position?.time, 100);
  assert.equal(position?.elevation, 100);
  assert.equal(position?.distance, 2.5);
  assert.deepEqual(
    fields.sort((a, b) => a - b),
    [0, 1, 2, 5, 78],
  );
});

test("unknown message naming does not scan unrelated records", async () => {
  const index = await readFit(activity(1000));
  let reads = 0;
  index.records = new Proxy(index.records, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const metadata = new Metadata(index);
  reads = 0;
  for (let message = 60000; message < 60100; message++)
    assert.equal(metadata.messageName(message), `Message ${message}`);
  assert.equal(reads, 0);
});

test("map-to-table jumps use indexed IDs and preserve nearest filtered-row behavior", async () => {
  const document = await FitDocument.open(activity(20000), "table.fit");
  const query = { message: 20, developer: false, page: 0, size: 20 };
  await document.table(query);
  let reads = 0;
  document.index.records = new Proxy(document.index.records, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const ids = document.recordIds(20);
  const page = await document.table({ ...query, target: ids[18001] });
  assert.equal(page.selected, ids[18001]);
  assert.equal(page.page, 900);
  assert.ok(reads < 200, `Unexpected full-table scan: ${reads}`);
  const small = await FitDocument.open(
    file(
      Array.from({ length: 6 }, (_, i) => ({
        message: 20,
        fields: [
          [253, 6, 100 + i],
          [3, 2, 100 + (i % 2)],
        ] as Field[],
      })),
    ),
    "filtered.fit",
  );
  const filtered = { ...query, filters: { "3": ["100"] } };
  const available = (await small.table(filtered)).rows.map((row) => row.index);
  for (const target of [-1, 2, 3, 4, 100]) {
    const nearest = available.reduce((best, id) =>
      Math.abs(id - target) < Math.abs(best - target) ? id : best,
    );
    assert.equal(
      (await small.table({ ...filtered, target })).selected,
      nearest,
    );
  }
  assert.equal(
    (await small.table({ ...query, target: 3, filters: { "3": ["999"] } }))
      .selected,
    undefined,
  );
});

test("GPX decodes GPS tracks only once while retaining waypoint order", async (t) => {
  const document = await FitDocument.open(activity(1000), "track.fit");
  const values = NumericReader.prototype.values;
  let reads = 0;
  t.mock.method(
    NumericReader.prototype,
    "values",
    function (this: NumericReader, ...args: Parameters<typeof values>) {
      reads++;
      return values.apply(this, args);
    },
  );
  const text = await (
    await exportDocument(document, { format: "gpx" })
  ).blob.text();
  assert.equal(reads, 1000);
  assert.equal((text.match(/<trkpt /g) ?? []).length, 1000);
  const mixed = await FitDocument.open(
    file(
      [
        {
          message: 20,
          fields: [
            [253, 6, 100],
            [0, 5, 100],
            [1, 5, 100],
          ],
        },
        {
          message: 19,
          fields: [
            [2, 6, 100],
            [3, 5, 100],
            [4, 5, 100],
          ],
        },
        {
          message: 20,
          fields: [
            [253, 6, 101],
            [0, 5, 200],
            [1, 5, 200],
          ],
        },
      ],
      false,
    ),
    "laps.fit",
  );
  const withLaps = await (
    await exportDocument(mixed, { format: "gpx", withLaps: true })
  ).blob.text();
  assert.ok(withLaps.indexOf("<wpt ") < withLaps.indexOf("<trk>"));
  assert.equal((withLaps.match(/<trkseg>/g) ?? []).length, 1);
  assert.ok(
    !(
      await (await exportDocument(mixed, { format: "gpx" })).blob.text()
    ).includes("<wpt "),
  );
});

test("download names are basenames for nested Windows and ZIP sources in all formats", async () => {
  for (const path of [
    "folder/".repeat(50) + "activity.fit",
    "C:\\folder\\activity.fit",
  ]) {
    const document = await FitDocument.open(activity(12), path);
    for (const format of [
      "csv",
      "gpx",
      "geojson",
      "fit",
      "json",
      "hrv",
    ] as const) {
      const query: ExportQuery = { format };
      const result = await exportDocument(document, query);
      assert.equal(result.filename, exportFilename(document.summary(), query));
      assert.match(result.filename, /^activity[.-]/);
      assert.ok(!/[\\/]/.test(result.filename));
    }
  }
});

test("desktop reads propagate cancellation into fetch before bytes arrive", async (t) => {
  const controller = new AbortController();
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, options: RequestInit) => {
      assert.equal(options.signal, controller.signal);
      started();
      return new Promise((_resolve, reject) => {
        options.signal!.addEventListener(
          "abort",
          () => reject(options.signal!.reason),
          { once: true },
        );
      });
    },
  );
  const pending = loadFile(
    {
      name: "folder",
      files: [
        {
          name: "activity.fit",
          size: 100,
          url: "fitviewer://app/import/00000000-0000-0000-0000-000000000000",
        },
      ],
    },
    1024,
    { ...idleJob(), signal: controller.signal },
  );
  await reading;
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("filtered JSON keeps full-resolution ordinary and motion values on warm indexes", async () => {
  const bytes = file(
    Array.from({ length: 1024 }, (_, i) => ({
      message: 165,
      fields: [
        [253, 6, 100 + i],
        [0, 4, 500],
        [1, 4, [0, 20, 40]],
        [5, 8, [i, i + 0.25, i + 0.5]],
      ] as Field[],
    })),
    false,
  );
  for (const [document, key, start] of [
    [
      await FitDocument.open(activity(2048), "ordinary.fit"),
      "20:3",
      1100001000,
    ],
    [await FitDocument.open(bytes, "motion.fit"), "165:5", 600.5],
  ] as const) {
    const sensor = sensors(document, false).find((s) => s.key === key)!;
    const full = [];
    for await (const point of chartPoints(document, sensor, false, idleJob()))
      full.push(point);
    const dates = { start, end: start + 3 };
    const expected = full.filter(
      (p) => p.time >= dates.start && p.time <= dates.end && p.value !== null,
    );
    for (let i = 0; i < 2; i++) {
      const exported = JSON.parse(
        await (
          await exportDocument(document, {
            format: "json",
            sensors: [key],
            dates,
          })
        ).blob.text(),
      );
      assert.deepEqual(
        exported.series[key].filter(
          (p: { value: unknown }) => p.value !== null,
        ),
        expected,
      );
    }
  }
});
