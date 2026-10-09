// Electron executes this serialized function in the isolated renderer.
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
    Object.keys(window.fitDesktop).sort().join(",") !== "onOpen,release,updates"
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
