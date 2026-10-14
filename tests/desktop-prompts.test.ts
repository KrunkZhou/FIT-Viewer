import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PromptQueue } from "../electron/prompt-queue";
import { UpdatePrompter } from "../electron/update-prompt";
import { DesktopNotification } from "../src/ui/DesktopNotifications";
import type { DesktopPromptState } from "../src/desktop-prompts";
import type { UpdateState } from "../src/updates";

test("notifications coexist and resolve only the explicitly answered request", async () => {
  const states: DesktopPromptState[] = [];
  const queue = new PromptQueue((state) => states.push(state));
  const update = queue.show({ kind: "install", version: "1.2.3" });
  const association = queue.show({ kind: "association" });
  const [first, second] = queue.snapshot().prompts;
  queue.respond(second.id, false);
  assert.equal(await association, false);
  assert.deepEqual(queue.snapshot().prompts, [first]);
  queue.respond(first.id, true);
  queue.respond(first.id, false);
  assert.equal(await update, true);
  assert.deepEqual(queue.snapshot().prompts, []);
  assert.deepEqual(
    states.map((state) => state.revision),
    [1, 2, 3, 4],
  );
  assert.equal(states[1].prompts.length, 2);
});

test("cancellation withdraws notifications, ignores stale replies, and is not a user dismissal", async () => {
  const queue = new PromptQueue(() => {});
  const abort = new AbortController();
  const result = queue.show(
    { kind: "install", version: "1.2.3" },
    abort.signal,
  );
  const id = queue.snapshot().prompts[0].id;
  abort.abort();
  queue.respond(id, true);
  assert.equal(await result, undefined);
  assert.deepEqual(queue.snapshot().prompts, []);
  assert.equal(
    await queue.show({ kind: "association" }, abort.signal),
    undefined,
  );
  const pending = queue.show({ kind: "association" });
  const latest = queue.show({ kind: "download", version: "1.2.4" });
  queue.cancel();
  assert.equal(await pending, undefined);
  assert.equal(await latest, undefined);
  assert.deepEqual(queue.snapshot().prompts, []);
});

test("notification replies accept only a numeric request ID and a boolean choice", async () => {
  const queue = new PromptQueue(() => {});
  const result = queue.show({ kind: "association" });
  const id = queue.snapshot().prompts[0].id;
  for (const [key, answer] of [
    [String(id), true],
    [id, "true"],
    [id, 0],
    [NaN, true],
    [1.5, true],
    [id, null],
  ])
    assert.throws(() => queue.respond(key, answer), /Invalid notification/);
  assert.equal(queue.snapshot().prompts.length, 1);
  queue.respond(id + 100, true);
  assert.equal(queue.snapshot().prompts.length, 1);
  queue.respond(id, false);
  assert.equal(await result, false);
});

test("turning off updates removes the actual pending notification without installing", async () => {
  const queue = new PromptQueue(() => {});
  const state: UpdateState = {
    revision: 1,
    enabled: true,
    mode: "install",
    phase: "ready",
    version: "1.2.3",
  };
  let installed = false;
  const prompter = new UpdatePrompter({
    state: () => state,
    canShow: () => true,
    show: async (offer, signal) => (await queue.show(offer, signal)) === true,
    install: () => {
      installed = true;
    },
    download: async () => assert.fail("Unexpected download"),
    report: (error) => assert.fail(String(error)),
  });
  prompter.notify();
  const oldId = queue.snapshot().prompts[0].id;
  state.enabled = false;
  prompter.notify();
  queue.respond(oldId, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installed, false);
  assert.equal(queue.snapshot().prompts.length, 0);
  state.enabled = true;
  prompter.notify();
  queue.respond(queue.snapshot().prompts[0].id, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(installed, true);
  prompter.dispose();
});

test("in-app prompts are nonmodal, have explicit dismiss actions, and do not autofocus", () => {
  for (const kind of ["association", "install", "download"] as const) {
    const html = renderToStaticMarkup(
      createElement(DesktopNotification, {
        prompt:
          kind === "association"
            ? { id: 1, kind }
            : { id: 1, kind, version: "1.2.3" },
        respond: async () => {},
      }),
    );
    assert.match(html, /role="dialog" aria-modal="false"/);
    assert.match(html, /aria-labelledby="desktop-prompt-1"/);
    assert.doesNotMatch(html, /auto[fF]ocus|<dialog|backdrop/);
    assert.match(
      html,
      new RegExp(kind === "association" ? ">Not now<" : ">Later<"),
    );
    if (kind === "association")
      assert.match(html, /current default stays unchanged/);
  }
});

test("updater and default association no longer open native message boxes", async () => {
  for (const file of [
    "updates.ts",
    "update-prompt.ts",
    "windows-association.ts",
  ])
    assert.doesNotMatch(
      await readFile(new URL(`../electron/${file}`, import.meta.url), "utf8"),
      /showMessageBox|MessageBoxOptions/,
    );
});
