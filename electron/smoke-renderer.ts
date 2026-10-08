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
    Object.keys(window.fitDesktop).sort().join(",") !== "onOpen,release"
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
