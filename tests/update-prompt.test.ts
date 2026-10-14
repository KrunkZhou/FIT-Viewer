import assert from "node:assert/strict";
import test from "node:test";
import { UpdatePrompter, type UpdateOffer } from "../electron/update-prompt";
import { desktopPromptText } from "../src/desktop-prompts";
import {
  UpdateController,
  type UpdateBackend,
} from "../electron/update-controller";
import type { UpdateState } from "../src/updates";

const ready: UpdateState = {
  revision: 1,
  enabled: true,
  mode: "install",
  phase: "ready",
  version: "1.2.3",
};
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function harness(initial: UpdateState = ready) {
  let state = { ...initial };
  let focused = true;
  let installations = 0;
  const downloads: string[] = [];
  const errors: unknown[] = [];
  const shown: {
    offer: UpdateOffer;
    signal: AbortSignal;
    resolve: (accepted: boolean) => void;
    reject: (error: Error) => void;
  }[] = [];
  const host = {
    state: () => state,
    canShow: () => focused,
    show: (offer: UpdateOffer, signal: AbortSignal) =>
      new Promise<boolean>((resolve, reject) => {
        shown.push({ offer, signal, resolve, reject });
      }),
    install: () => {
      installations++;
    },
    download: async (version: string) => {
      downloads.push(version);
    },
    report: (error: unknown) => {
      errors.push(error);
    },
  };
  const prompts = new UpdatePrompter(host);
  return {
    host,
    prompts,
    shown,
    downloads,
    errors,
    installations: () => installations,
    update(patch: Partial<UpdateState>) {
      state = { ...state, ...patch, revision: state.revision + 1 };
      prompts.notify();
    },
    focus(value: boolean) {
      focused = value;
      if (value) prompts.notify();
    },
    async answer(index: number, accepted: boolean) {
      shown[index].resolve(accepted);
      await flush();
    },
  };
}

test("update popups show the version and safe platform-specific actions", () => {
  const install = desktopPromptText({ kind: "install", version: "1.2.3" });
  assert.match(install.title, /1\.2\.3 is ready to install/);
  assert.match(install.detail!, /Open files.*will be closed/);
  assert.equal(install.action, "Restart to update");
  const download = desktopPromptText({ kind: "download", version: "1.2.4" });
  assert.match(download.title, /1\.2\.4 is available/);
  assert.match(download.detail!, /install it manually/);
  assert.equal(download.action, "Download update");
  for (const options of [install, download]) {
    assert.equal(options.dismiss, "Later");
  }
});

test("automatic popups require an enabled, actionable update and a focused window", () => {
  for (const patch of [
    { enabled: false },
    { mode: "unavailable" },
    { mode: "download" },
    ...["idle", "checking", "downloading", "available", "current", "error"].map(
      (phase) => ({ phase }),
    ),
    { version: undefined },
    { version: "1.2.3-beta" },
    { version: "../../other" },
  ] as Partial<UpdateState>[]) {
    const h = harness({ ...ready, ...patch });
    h.prompts.notify();
    assert.equal(h.shown.length, 0, JSON.stringify(patch));
    h.prompts.dispose();
  }
  const h = harness();
  h.focus(false);
  h.prompts.notify();
  assert.equal(h.shown.length, 0);
  h.focus(true);
  assert.equal(h.shown.length, 1);
  h.prompts.dispose();
});

test("automatic popup follows the completed update check without a header click", async () => {
  const h = harness();
  const backend: UpdateBackend = {
    mode: "install",
    check: async (_signal, progress) => {
      progress("1.2.3", 50);
      assert.equal(h.shown.length, 0);
      return { version: "1.2.3", ready: true };
    },
    install: h.host.install,
  };
  const controller = new UpdateController(backend, true, async () => {});
  controller.subscribe((state) => h.update(state));
  await controller.check();
  assert.equal(h.shown.length, 1);
  assert.deepEqual(h.shown[0].offer, { kind: "install", version: "1.2.3" });
  assert.equal(h.installations(), 0);
  await h.answer(0, true);
  assert.equal(h.installations(), 1);
  h.prompts.dispose();
  controller.dispose();
});

test("Later suppresses repeated prompts for a version but permits a newer release", async () => {
  const h = harness();
  h.prompts.notify();
  h.prompts.notify();
  await h.prompts.request(true);
  assert.equal(h.shown.length, 1);
  await h.answer(0, false);
  h.focus(true);
  h.update({ phase: "checking", version: undefined });
  h.update({ phase: "ready", version: "1.2.3" });
  assert.equal(h.shown.length, 1);
  assert.equal(h.installations(), 0);
  h.update({ version: "1.2.4" });
  assert.equal(h.shown.length, 2);
  await h.answer(1, true);
  assert.equal(h.installations(), 1);
  assert.deepEqual(h.downloads, []);
  h.prompts.dispose();
});

test("manual installation can reopen a dismissed popup without enabling automatic checks", async () => {
  const h = harness({ ...ready, enabled: false });
  h.prompts.notify();
  const first = h.prompts.request(true);
  await h.answer(0, false);
  await first;
  assert.equal(h.shown.length, 1);
  const second = h.prompts.request(true);
  await h.answer(1, true);
  await second;
  assert.equal(h.installations(), 1);
  assert.equal(h.host.state().enabled, false);
  h.prompts.dispose();
});

test("manual-install builds offer downloads only after explicit confirmation", async () => {
  const h = harness({ ...ready, mode: "download", phase: "available" });
  h.prompts.notify();
  assert.equal(h.shown[0].offer.kind, "download");
  assert.deepEqual(h.downloads, []);
  await h.answer(0, false);
  assert.deepEqual(h.downloads, []);
  h.update({ version: "1.2.4" });
  await h.answer(1, true);
  assert.deepEqual(h.downloads, ["1.2.4"]);
  assert.equal(h.installations(), 0);
  h.prompts.dispose();
});

test("disabling updates cancels the popup and ignores its stale confirmation", async () => {
  const h = harness();
  h.prompts.notify();
  h.update({ enabled: false });
  assert.equal(h.shown[0].signal.aborted, true);
  await h.answer(0, true);
  assert.equal(h.installations(), 0);
  assert.equal(h.shown.length, 1);
  h.update({ enabled: true });
  assert.equal(h.shown.length, 2);
  await h.answer(1, false);
  h.prompts.dispose();
});

test("newer releases replace stale prompts without overlapping dialogs or installing the wrong version", async () => {
  const h = harness();
  h.prompts.notify();
  h.update({ version: "1.2.4" });
  assert.equal(h.shown[0].signal.aborted, true);
  assert.equal(h.shown.length, 1);
  await h.answer(0, true);
  assert.equal(h.installations(), 0);
  assert.equal(h.shown.length, 2);
  assert.equal(h.shown[1].offer.version, "1.2.4");
  await h.answer(1, true);
  assert.equal(h.installations(), 1);
  h.prompts.dispose();
});

test("window closure defers the offer and shutdown prevents all subsequent actions", async () => {
  const h = harness();
  h.prompts.notify();
  h.focus(false);
  h.prompts.cancel();
  await h.answer(0, true);
  assert.equal(h.installations(), 0);
  h.focus(true);
  assert.equal(h.shown.length, 2);
  h.prompts.dispose();
  await h.answer(1, true);
  h.prompts.notify();
  await h.prompts.request(true);
  assert.equal(h.installations(), 0);
  assert.equal(h.shown.length, 2);
});

test("dialog failures are handled without a prompt loop and manual retry remains available", async () => {
  const h = harness();
  h.prompts.notify();
  const error = new Error("Dialog unavailable");
  h.shown[0].reject(error);
  await flush();
  assert.deepEqual(h.errors, [error]);
  h.prompts.notify();
  assert.equal(h.shown.length, 1);
  const retry = h.prompts.request(true);
  await h.answer(1, true);
  await retry;
  assert.equal(h.installations(), 1);
  h.prompts.dispose();
});
