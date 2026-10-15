import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FitDocument } from "../src/document/document";
import { exportDocument } from "../src/export/export";
import { FIT_EPOCH } from "../src/protocol/time";
import { CiqDraftStore } from "../src/ui/ciq-drafts";
import { CiqSettings } from "../src/ui/CiqSettings";
import { ChartGroupLoader } from "../src/ui/chart-loader";
import { file, type Field } from "./fixtures";

test("local FIT wall-clock timestamps do not gain a UTC suffix or a second timezone shift", async () => {
  for (const [utc, local] of [
    ["2026-10-05T16:00:00Z", "2026-10-05T12:00:00"],
    ["2026-01-05T05:00:00Z", "2026-01-05T00:00:00"],
  ]) {
    const document = await FitDocument.open(
      file(
        [
          {
            message: 34,
            fields: [
              [253, 6, (Date.parse(utc) - FIT_EPOCH) / 1000],
              [5, 6, (Date.parse(`${local}Z`) - FIT_EPOCH) / 1000],
            ] as Field[],
          },
        ],
        false,
      ),
      "time.fit",
    );
    const cells = document.cells(0);
    assert.equal(cells["253"].value, utc.replace("Z", ".000Z"));
    assert.equal(cells["5"].value, `${local}.000`);
    const iso = await (
      await exportDocument(document, {
        format: "csv",
        message: 34,
        timeFormat: "iso",
      })
    ).blob.text();
    assert.ok(iso.includes(`${local}.000`));
    assert.ok(!iso.includes(`${local}.000Z`));
    for (const timezone of ["America/Toronto", "Asia/Tokyo", "UTC"]) {
      const csv = await (
        await exportDocument(document, {
          format: "csv",
          message: 34,
          timeFormat: "localized",
          locale: "en-CA",
          timezone,
        })
      ).blob.text();
      assert.ok(csv.endsWith(`,\"${local.replace("T", ", ")}\"`), csv);
    }
  }
});

test("SET drafts survive source rebasing and remounts without leaking into other source files", () => {
  const store = new CiqDraftStore();
  const original = { type: "long" as const, value: 1n };
  const settings = {
    type: "dictionary" as const,
    entries: [
      { key: { type: "string" as const, value: "Count" }, value: original },
    ],
  };
  store.change(1, original, [0], "9223372036854775807");
  const snapshot = store.get(1);
  const render = (source: number, selected?: number) =>
    renderToStaticMarkup(
      createElement(CiqSettings, {
        files: [{ source, filename: "settings.SET", settings }],
        source: selected,
        store,
        download: () => {},
      }),
    );
  assert.match(render(1), /9223372036854775807/);
  assert.match(render(0, 1), /9223372036854775807/);
  assert.doesNotMatch(render(0), /9223372036854775807/);
  assert.equal(store.get(1), snapshot);
  assert.equal(store.hasChanges(), true);
  store.change(0, original, [0], "bad");
  assert.ok(store.get(0).get("0")?.error);
  store.reset(0);
  assert.equal(store.hasChanges(), true);
  store.change(1, original, [0], "1");
  assert.equal(store.hasChanges(), false);
  store.change(1, original, [0], "2");
  store.clear();
  assert.equal(store.hasChanges(), false);
  assert.equal(settings.entries[0].value.value, 1n);
});

test("chart retry reloads errors only and reselecting a failed chart retries it", async () => {
  const calls = new Map<string, number>();
  const loader = new ChartGroupLoader(async (query) => {
    const key = query.sensors[0];
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (key !== "good" && count === 1) throw new Error("Temporary failure");
    return {
      sensors: [],
      series: { [key]: [{ time: 1, value: 2 }] },
      start: 1,
      end: 1,
    };
  });
  const query = (key: string) => ({
    sensors: [key],
    developer: false,
    width: 128,
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  loader.select([query("good"), query("retry")]);
  await settle();
  const good = loader.getSnapshot().series.good;
  assert.equal(loader.getSnapshot().error, "Temporary failure");
  loader.retry();
  loader.retry();
  await settle();
  assert.equal(calls.get("good"), 1);
  assert.equal(calls.get("retry"), 2);
  assert.equal(loader.getSnapshot().series.good, good);
  assert.equal(loader.getSnapshot().error, "");
  loader.select([query("reselect")]);
  await settle();
  loader.select([]);
  loader.select([query("reselect")]);
  await settle();
  assert.equal(calls.get("reselect"), 2);
  assert.equal(loader.getSnapshot().error, "");
  loader.dispose();
});
