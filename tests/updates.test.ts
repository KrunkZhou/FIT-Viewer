import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createUpdateBackend,
  stableUpdate,
  updateMode,
} from "../electron/update-backend";
import {
  UpdateController,
  type UpdateBackend,
} from "../electron/update-controller";
import {
  readUpdatePreference,
  writeUpdatePreference,
} from "../electron/update-preference";
import { UpdateSettings } from "../src/ui/AppInfo";
import type { UpdateState } from "../src/updates";

function backend(overrides: Partial<UpdateBackend> = {}): UpdateBackend {
  return {
    mode: "install",
    check: async () => ({}),
    install() {},
    ...overrides,
  };
}

test("updates accept only newer stable release versions", () => {
  const release = (tag: string, draft = false, prerelease = false) => ({
    tag_name: tag,
    draft,
    prerelease,
  });
  assert.equal(stableUpdate(release("v1.2.4"), "1.2.3"), "1.2.4");
  assert.equal(stableUpdate(release("v0.0.100"), "0.0.99"), "0.0.100");
  for (const tag of [
    "v1.2.3",
    "v1.0.0",
    "v2.0.0-beta.1",
    "2.0.0",
    "v02.0.0",
    "v2.0.0+meta",
    "../../other",
  ])
    assert.equal(stableUpdate(release(tag), "1.2.3"), undefined, tag);
  assert.equal(stableUpdate(release("v2.0.0", true), "1.2.3"), undefined);
  assert.equal(
    stableUpdate(release("v2.0.0", false, true), "1.2.3"),
    undefined,
  );
  assert.equal(stableUpdate({}, "1.2.3"), undefined);
  assert.throws(() => stableUpdate(null, "1.2.3"));
});

test("only installed packaged Windows apps offer native installation", () => {
  assert.equal(updateMode("win32", true, false), "install");
  assert.equal(updateMode("win32", true, true), "download");
  assert.equal(updateMode("darwin", true, false), "download");
  assert.equal(updateMode("linux", true, false), "download");
  for (const platform of ["win32", "darwin", "linux"])
    assert.equal(updateMode(platform, false, false), "unavailable");
});

test("portable release checks use the fixed public endpoint, stable versions and cancellation", async (t) => {
  const abort = new AbortController();
  let outcome = new Response(
    JSON.stringify({ draft: false, prerelease: false, tag_name: "v1.2.4" }),
  );
  let requestSignal: AbortSignal | null | undefined;
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      assert.equal(
        url,
        "https://api.github.com/repos/KrunkZhou/FIT-Viewer/releases/latest",
      );
      assert.equal(options.body, undefined);
      assert.equal(new Headers(options.headers).get("Authorization"), null);
      requestSignal = options.signal;
      return outcome;
    },
  );
  const portable = createUpdateBackend("win32", true, true, "1.2.3");
  assert.deepEqual(await portable.check(abort.signal, () => {}), {
    version: "1.2.4",
  });
  abort.abort();
  assert.equal(requestSignal?.aborted, true);
  outcome = new Response("", { status: 404 });
  assert.deepEqual(
    await portable.check(new AbortController().signal, () => {}),
    {},
  );
  outcome = new Response("rate limited", { status: 403 });
  await assert.rejects(portable.check(new AbortController().signal, () => {}));
});

test("automatic checks run after startup and periodically, and stop when disabled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let checks = 0;
  const controller = new UpdateController(
    backend({
      check: async () => {
        checks++;
        return {};
      },
    }),
    true,
    async () => {},
  );
  t.after(() => controller.dispose());
  controller.start();
  t.mock.timers.tick(9999);
  await Promise.resolve();
  assert.equal(checks, 0);
  t.mock.timers.tick(1);
  await controller.check();
  assert.equal(checks, 1);
  t.mock.timers.tick(6 * 60 * 60 * 1000);
  await controller.check();
  assert.equal(checks, 2);
  await controller.setEnabled(false);
  t.mock.timers.tick(12 * 60 * 60 * 1000);
  await controller.check();
  assert.equal(checks, 2);
  await controller.check(true);
  assert.equal(checks, 3);
  assert.equal(controller.snapshot().enabled, false);
});

test("disabled or development apps never schedule background traffic", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let checks = 0;
  for (const [mode, enabled] of [
    ["install", false],
    ["unavailable", true],
  ] as const) {
    const controller = new UpdateController(
      backend({
        mode,
        check: async () => {
          checks++;
          return {};
        },
      }),
      enabled,
      async () => {},
    );
    controller.start();
    t.mock.timers.tick(24 * 60 * 60 * 1000);
    await controller.check();
    controller.dispose();
  }
  assert.equal(checks, 0);
});

test("disabling updates cancels a single-flight download and ignores late results", async () => {
  let resolve!: (result: { version: string; ready: boolean }) => void;
  let signal!: AbortSignal;
  let report!: (version: string, percent: number) => void;
  let installations = 0;
  const saved: boolean[] = [];
  const controller = new UpdateController(
    backend({
      check: async (abort, progress) => {
        signal = abort;
        report = progress;
        return new Promise((done) => {
          resolve = done;
        });
      },
      install() {
        installations++;
      },
    }),
    true,
    async (enabled) => {
      saved.push(enabled);
    },
  );
  const task = controller.check();
  assert.equal(controller.check(), task);
  await Promise.resolve();
  report("1.2.3", 25.6);
  assert.equal(controller.snapshot().phase, "downloading");
  assert.equal(controller.snapshot().percent, 26);
  await controller.setEnabled(false);
  assert.equal(signal.aborted, true);
  assert.deepEqual(saved, [false]);
  const stopped = controller.snapshot();
  report("1.2.3", 100);
  resolve({ version: "1.2.3", ready: true });
  await task;
  assert.deepEqual(controller.snapshot(), stopped);
  assert.throws(() => controller.install());
  controller.dispose();
  assert.equal(installations, 0);
});

test("installation is explicit, only permitted for a ready native update", async () => {
  let installations = 0;
  const controller = new UpdateController(
    backend({
      check: async () => ({ version: "1.2.3", ready: true }),
      install() {
        installations++;
      },
    }),
    true,
    async () => {},
  );
  assert.throws(() => controller.install());
  await controller.check();
  assert.equal(controller.snapshot().phase, "ready");
  assert.equal(installations, 0);
  controller.install();
  assert.equal(installations, 1);
  controller.dispose();
  assert.throws(() => controller.install());
  const portable = new UpdateController(
    backend({ mode: "download", check: async () => ({ version: "1.2.3" }) }),
    true,
    async () => {},
  );
  await portable.check();
  assert.equal(portable.snapshot().phase, "available");
  assert.throws(() => portable.install());
  portable.dispose();
});

test("failed checks can retry, including synchronously thrown errors", async () => {
  let calls = 0;
  const controller = new UpdateController(
    backend({
      check() {
        calls++;
        if (calls === 1) throw new Error("unavailable");
        return Promise.resolve({});
      },
    }),
    true,
    async () => {},
  );
  await controller.check();
  assert.equal(controller.snapshot().phase, "error");
  await controller.check();
  assert.equal(controller.snapshot().phase, "current");
  assert.equal(calls, 2);
  controller.dispose();
});

test("preferences serialize and a failed write never silently enables updates", async () => {
  const writes: boolean[] = [];
  const controller = new UpdateController(backend(), false, async (enabled) => {
    writes.push(enabled);
    if (enabled) throw new Error("disk full");
  });
  await Promise.all([
    controller.setEnabled(true),
    controller.setEnabled(false),
  ]);
  assert.deepEqual(writes, [true, false]);
  assert.equal(controller.snapshot().enabled, false);
  await controller.setEnabled(true);
  assert.equal(controller.snapshot().enabled, false);
  assert.equal(controller.snapshot().phase, "error");
  controller.dispose();
});

test("shutdown aborts work, clears timers and stops observer notifications", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  let finish!: () => void;
  let signal!: AbortSignal;
  let calls = 0;
  const controller = new UpdateController(
    backend({
      check: async (abort) => {
        signal = abort;
        calls++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { version: "1.2.3", ready: true };
      },
    }),
    true,
    async () => {},
  );
  let notifications = 0;
  controller.subscribe(() => {
    notifications++;
  });
  controller.start();
  const task = controller.check();
  await Promise.resolve();
  controller.dispose();
  assert.equal(signal.aborted, true);
  finish();
  await task;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await controller.check(true);
  assert.equal(calls, 1);
  assert.equal(notifications, 1);
});

test("update preference persists and malformed settings fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "fitviewer-updates-"));
  const path = join(directory, "updates.json");
  try {
    assert.equal(await readUpdatePreference(path), true);
    await writeUpdatePreference(path, false);
    assert.equal(await readUpdatePreference(path), false);
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      enabled: false,
    });
    await writeUpdatePreference(path, true);
    assert.equal(await readUpdatePreference(path), true);
    for (const invalid of ["{", "{}", '{"enabled":"true"}']) {
      await writeFile(path, invalid);
      assert.equal(await readUpdatePreference(path), false);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("header update controls show progress, persistent opt-out and platform actions", () => {
  const render = (state: UpdateState) =>
    renderToStaticMarkup(
      createElement(UpdateSettings, {
        state,
        saving: false,
        error: "",
        toggle() {},
        check() {},
        install() {},
      }),
    );
  const state: UpdateState = {
    revision: 0,
    enabled: false,
    mode: "install",
    phase: "idle",
  };
  const off = render(state);
  assert.match(off, /Automatic updates are off/);
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.match(off, /Check for updates/);
  const downloading = render({
    ...state,
    enabled: true,
    phase: "downloading",
    version: "1.2.3",
    percent: 42,
  });
  assert.match(downloading, /Downloading 1.2.3: 42%/);
  assert.doesNotMatch(downloading, /role="switch"[^>]*disabled/);
  assert.match(
    render({ ...state, phase: "ready", version: "1.2.3" }),
    /Restart to update/,
  );
  const portable = render({
    ...state,
    mode: "download",
    phase: "available",
    version: "1.2.3",
  });
  assert.match(
    portable,
    /href="https:\/\/github.com\/KrunkZhou\/FIT-Viewer\/releases\/tag\/v1.2.3"/,
  );
  assert.match(portable, /Download release/);
  assert.doesNotMatch(portable, /Restart to update/);
});
