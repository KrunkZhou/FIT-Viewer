// Electron executes this serialized function in the isolated renderer.
export async function checkRenderer(bytes: number[]) {
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
  const data = new DataTransfer();
  data.items.add(new File([new Uint8Array(bytes)], "desktop-smoke.fit"));
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  input.files = data.files;
  input.dispatchEvent(new Event("change", { bubbles: true }));
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
    () => document.querySelectorAll("table tbody tr").length === 20,
    "20 populated message rows",
  );
  const rows = document.querySelectorAll("table tbody tr").length;
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
