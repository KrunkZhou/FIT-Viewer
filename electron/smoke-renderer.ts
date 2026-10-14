// Electron executes these serialized functions in the isolated renderer.
export async function checkCiqRenderer(
  settingsBytes: number[],
  fitBytes: number[],
) {
  const waitFor = async (predicate: () => boolean, stage: string) => {
    const deadline = performance.now() + 10000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error(`CIQ smoke timed out: ${stage}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  const tab = (id: string) => document.getElementById(`tab-${id}`);
  const open = (files: File[]) => {
    const data = new DataTransfer();
    files.forEach((file) => data.items.add(file));
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    if (!input.accept.split(",").includes(".set"))
      throw new Error("SET picker filter missing");
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const settings = () => new File([new Uint8Array(settingsBytes)], "example.SET");
  const fit = () => new File([new Uint8Array(fitBytes)], "ciq-run.fit");
  open([settings()]);
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent === "example.SET" &&
      !!tab("settings"),
    "standalone settings",
  );
  if (tab("settings")?.getAttribute("aria-selected") !== "true")
    throw new Error("Standalone SET did not select settings");
  await waitFor(
    () => document.querySelectorAll(".viewer-ciq-file tbody tr").length === 6,
    "six settings rows",
  );
  if (tab("messages") || tab("chart") || tab("map"))
    throw new Error("SET exposed FIT-only tabs");
  if (
    !document
      .querySelector(".viewer-ciq-settings")
      ?.textContent?.includes("test-device-01")
  )
    throw new Error("CIQ property values missing");
  open([settings(), fit()]);
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent === "2 files" &&
      !!tab("messages") &&
      !!tab("settings"),
    "mixed settings and FIT",
  );
  if (tab("overview")?.getAttribute("aria-selected") !== "true")
    throw new Error("Mixed import did not select overview");
  const select = document.querySelector<HTMLSelectElement>(
    'select[aria-label="Source file"]',
  )!;
  const sourceValue = (filename: string) => {
    const option = Array.from(select.options).find(
      (option) => option.textContent === filename,
    );
    if (!option) throw new Error(`Source option missing: ${filename}`);
    return option.value;
  };
  select.value = sourceValue("example.SET");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent === "example.SET" &&
      !!tab("settings"),
    "settings source selection",
  );
  select.value = sourceValue("ciq-run.fit");
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent ===
        "ciq-run.fit" &&
      !!tab("messages") &&
      !tab("settings"),
    "FIT source selection",
  );
  select.value = "";
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent === "2 files" &&
      !!tab("settings"),
    "combined source restoration",
  );
  open([fit()]);
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent ===
        "ciq-run.fit" &&
      !!tab("messages") &&
      !tab("settings"),
    "FIT replacement clears settings",
  );
  open([settings()]);
  await waitFor(
    () =>
      document.querySelector(".viewer-file h2")?.textContent === "example.SET" &&
      document.querySelectorAll(".viewer-ciq-file tbody tr").length === 6,
    "settings screenshot",
  );
  return {
    standalone: true,
    rows: 6,
    mixed: true,
    sourceSelection: true,
    replacement: true,
  };
}

export async function checkRenderer(bytes?: number[]) {
  const waitFor = async (predicate: () => boolean, stage: string) => {
    const deadline = performance.now() + 15000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error(`Desktop smoke timed out waiting for ${stage}`);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  };
  await waitFor(
    () => !!document.querySelector('input[type="file"]'),
    "file input",
  );
  const nodeAccess = typeof (window as Window & { require?: unknown }).require;
  if (nodeAccess !== "undefined") throw new Error("Renderer exposes Node.js");
  if (bytes) {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(bytes)], "desktop-smoke.fit"));
    const input =
      document.querySelector<HTMLInputElement>('input[type="file"]')!;
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  await waitFor(
    () => !!document.body.textContent?.includes("File overview"),
    "file overview",
  );
  const tab = (name: string) => {
    const button = Array.from(
      document.querySelectorAll<HTMLElement>('[role="tab"]'),
    ).find((button) => button.textContent?.includes(name));
    if (!button) throw new Error(`Desktop tab not found: ${name}`);
    return button;
  };
  tab("Messages").click();
  await waitFor(
    () =>
      document.querySelectorAll(".viewer-message-table table tbody tr")
        .length === 20,
    "20 populated message rows",
  );
  const rows = document.querySelectorAll(
    ".viewer-message-table table tbody tr",
  ).length;
  tab("Chart").click();
  await waitFor(
    () =>
      !!document
        .querySelector(".recharts-surface path.recharts-curve")
        ?.getAttribute("d"),
    "chart data",
  );
  const removed = await fetch("/develop");
  return {
    title: document.title,
    rows,
    chart: !!document.querySelector(".recharts-surface"),
    removedStatus: removed.status,
    nodeAccess,
  };
}

export async function checkMapTimeline() {
  document.getElementById("tab-map")!.click();
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error("Map timeline smoke timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const button = (label: string) =>
    document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  await waitFor(() => !!button("Hide GPS timeline"));
  const container = document.querySelector<HTMLElement>(".leaflet-container")!;
  const dock = document.querySelector<HTMLElement>(
    ".viewer-map-playback-dock",
  )!;
  const pane = container.querySelector<HTMLElement>(".leaflet-map-pane")!;
  const ancestors: HTMLElement[] = [];
  for (
    let parent = container.parentElement;
    parent;
    parent = parent.parentElement
  )
    ancestors.push(parent);
  const initial = {
    rect: container.getBoundingClientRect(),
    dockHeight: dock.getBoundingClientRect().height,
    transform: pane.style.transform,
    scrolls: ancestors.map((element) => [
      element.scrollLeft,
      element.scrollTop,
    ]),
  };
  const verify = () => {
    const rect = container.getBoundingClientRect();
    if (
      !container.isConnected ||
      rect.x !== initial.rect.x ||
      rect.y !== initial.rect.y ||
      rect.width !== initial.rect.width ||
      rect.height !== initial.rect.height ||
      pane.style.transform !== initial.transform ||
      ancestors.some(
        (element, index) =>
          element.scrollLeft !== initial.scrolls[index][0] ||
          element.scrollTop !== initial.scrolls[index][1],
      )
    )
      throw new Error("Timeline toggle scrolled or moved the map");
  };
  const toggle = async (label: string) => {
    button(label)!.click();
    const deadline = performance.now() + 250;
    do {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      verify();
    } while (performance.now() < deadline);
  };
  await toggle("Hide GPS timeline");
  const show = button("Show GPS timeline")!;
  const rect = show.getBoundingClientRect();
  const anchor = show.parentElement!.getBoundingClientRect();
  if (
    Math.abs(rect.x - anchor.x) > 1 ||
    Math.abs(rect.y - anchor.y) > 1 ||
    Math.abs(rect.width - anchor.width) > 1 ||
    Math.abs(rect.height - anchor.height) > 1 ||
    Math.abs(dock.getBoundingClientRect().height - initial.dockHeight) > 1
  )
    throw new Error(
      "Timeline restore tooltip anchor does not match its button",
    );
  if (document.activeElement !== show)
    throw new Error("Timeline restore button did not receive focus");
  const tooltip = () =>
    Array.from(document.querySelectorAll<HTMLElement>('[role="tooltip"]')).find(
      (element) => element.textContent === "Show the GPS timeline",
    );
  await waitFor(() => !!tooltip());
  const tip = tooltip()!.getBoundingClientRect();
  if (tip.left > rect.right || tip.right < rect.left || tip.bottom > rect.top)
    throw new Error("Timeline restore tooltip is detached from its button");
  await toggle("Show GPS timeline");
  if (document.activeElement !== button("Hide GPS timeline"))
    throw new Error("Timeline hide button did not receive focus");
  if (tooltip()) throw new Error("Timeline restore tooltip remained open");
  await toggle("Hide GPS timeline");
  await toggle("Show GPS timeline");
  return { stableMap: true, tooltipAnchored: true, focusRestored: true };
}

export async function checkDesktopSelection(name: string, sources: number) {
  const deadline = performance.now() + 15000;
  while (!(
    document.querySelector(".viewer-file h2")?.textContent === name &&
    document.body.textContent?.includes("File overview")
  )) {
    if (performance.now() > deadline)
      throw new Error(`Desktop did not open ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (
    !window.fitDesktop ||
    Object.keys(window.fitDesktop).sort().join(",") !==
      "onOpen,prompts,release,updates"
  )
    throw new Error("Desktop preload API is missing or overly broad");
  if (!document.querySelector("input[webkitdirectory]"))
    throw new Error("Desktop folder picker missing");
  const choices = document.querySelectorAll(
    'select[aria-label="Source file"] option',
  ).length;
  if (choices !== (sources > 1 ? sources + 1 : 0))
    throw new Error(`Unexpected source count: ${choices}`);
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon || !(await fetch(icon.href)).ok)
    throw new Error("Desktop icon is unavailable");
  return { name, sources, folderPicker: true, icon: true };
}

export async function checkDesktopNotifications() {
  const waitFor = async (predicate: () => boolean) => {
    const deadline = performance.now() + 5000;
    while (!predicate()) {
      if (performance.now() > deadline)
        throw new Error("Desktop notifications did not respond");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  const api = window.fitDesktop?.prompts;
  if (!api || Object.keys(api).sort().join(",") !== "getState,onChange,respond")
    throw new Error("Notification preload API is missing or overly broad");
  await waitFor(
    () =>
      document.querySelectorAll(
        '.viewer-desktop-notification[aria-modal="false"]',
      ).length === 2,
  );
  if (document.querySelector(':modal, [inert], [aria-modal="true"]'))
    throw new Error("Notifications block the main app");
  const tabs = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
  );
  const messages = tabs.find((tab) => tab.textContent?.includes("Messages"))!;
  messages.click();
  await waitFor(() => messages.getAttribute("aria-selected") === "true");
  if (document.querySelectorAll(".viewer-desktop-notification").length !== 2)
    throw new Error("Navigation dismissed a notification");
  const buttons = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        ".viewer-desktop-notification button",
      ),
    );
  buttons()
    .find((button) => button.textContent === "Not now")!
    .click();
  await waitFor(
    () =>
      document.querySelectorAll(".viewer-desktop-notification").length === 1,
  );
  buttons()
    .find((button) => button.textContent === "Later")!
    .click();
  await waitFor(
    () =>
      document.querySelectorAll(".viewer-desktop-notification").length === 0,
  );
  if ((await api.getState()).prompts.length)
    throw new Error("Dismissed prompts remain in the main process");
  tabs.find((tab) => tab.textContent?.includes("Overview"))!.click();
  await waitFor(() => !!document.body.textContent?.includes("File overview"));
  return { nonmodal: true, navigation: true, dismissed: true };
}

export async function checkAppInformation(version: string) {
  const trigger = document.querySelector<HTMLButtonElement>(
    '[aria-label="App information"]',
  );
  if (!trigger) throw new Error("App icon button missing");
  const icon = trigger.querySelector("img");
  if (!icon?.naturalWidth) throw new Error("App icon did not load");
  trigger.click();
  const deadline = performance.now() + 5000;
  while (
    document.querySelector(".viewer-app-version")?.textContent !==
    `Version ${version}`
  ) {
    if (performance.now() > deadline)
      throw new Error(
        `App information did not show packaged version ${version}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const link = document.querySelector<HTMLAnchorElement>(".viewer-app-github");
  if (
    link?.href !== "https://github.com/KrunkZhou/FIT-Viewer" ||
    link.rel !== "noopener noreferrer"
  )
    throw new Error("App information GitHub link is incorrect");
  const updates = window.fitDesktop?.updates;
  if (
    !updates ||
    Object.keys(updates).sort().join(",") !==
      "check,getState,install,onChange,setEnabled"
  )
    throw new Error("Desktop updater bridge is missing or overly broad");
  const before = await updates.getState();
  if (before.mode !== "unavailable")
    throw new Error("Smoke must not contact the release server");
  const toggle = document.querySelector<HTMLButtonElement>(
    '[role="switch"][aria-label="Automatic updates"]',
  );
  if (!toggle)
    throw new Error("Update preference is missing from the header popup");
  while (toggle.disabled) {
    if (performance.now() > deadline)
      throw new Error("Update preference did not load");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  toggle.click();
  while (
    (await updates.getState()).enabled === before.enabled ||
    toggle.disabled
  ) {
    if (performance.now() > deadline)
      throw new Error("Header update toggle did not persist");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (toggle.getAttribute("aria-checked") !== String(!before.enabled))
    throw new Error(
      "Header update toggle did not reflect the saved preference",
    );
  const after = await updates.setEnabled(before.enabled);
  if (after.enabled !== before.enabled || after.revision <= before.revision)
    throw new Error("Update preference state is inconsistent");
  document
    .querySelector<HTMLButtonElement>('[aria-label="Close app information"]')!
    .click();
  return { version, icon: true, github: link.href, updateToggle: true };
}
