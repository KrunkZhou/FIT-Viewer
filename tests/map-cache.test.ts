import assert from "node:assert/strict";
import test from "node:test";
import { FitDocument } from "../src/document/document";
import { MapCache } from "../src/document/map-cache";
import { createJob } from "../src/document/jobs";
import { activity } from "./fixtures";

const job = () => createJob(new AbortController().signal);
test("reopening the same map reuses geometry and the original GPS sample index", async () => {
  const document = await FitDocument.open(activity(100), "map.fit");
  const cache = new MapCache();
  const first = await cache.query(document, job());
  assert.equal(await cache.query(document, job()), first);
  const sample = await first.index.position(document, 1100000037, [0], job());
  assert.equal(sample?.time, 1100000037);
  assert.equal(document.cells(sample!.record)["253"].raw, sample?.time);

  const filtered = await cache.query(document, job(), {
    start: 1100000020,
    end: 1100000040,
  });
  assert.notEqual(filtered, first);
  assert.equal(filtered.index.routes[0].count, 21);
  assert.equal(
    await cache.query(document, job(), { start: 1100000020, end: 1100000040 }),
    filtered,
  );
  assert.notEqual(await cache.query(document, job()), first);
  const empty = await cache.query(document, job(), { intervals: [] });
  assert.deepEqual(empty.data.tracks, []);
});

test("map cache isolates documents, clears retained work and respects cancellation on hits", async () => {
  const first = await FitDocument.open(activity(20), "first.fit");
  const second = await FitDocument.open(activity(10), "second.fit");
  const cache = new MapCache();
  const original = await cache.query(first, job());
  const other = await cache.query(second, job());
  assert.notEqual(original, other);
  assert.equal(other.index.routes[0].count, 10);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(cache.query(first, createJob(controller.signal)), {
    name: "AbortError",
  });
  assert.equal(await cache.query(first, job()), original);
  cache.clear();
  assert.notEqual(await cache.query(first, job()), original);
});
