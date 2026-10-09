import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function readUpdatePreference(path: string): Promise<boolean> {
  try {
    return JSON.parse(await readFile(path, "utf8")).enabled === true;
  } catch (error) {
    // An unreadable preference must not silently re-enable background traffic.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
export async function writeUpdatePreference(
  path: string,
  enabled: boolean,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, JSON.stringify({ enabled }) + "\n", {
    mode: 0o600,
  });
  await rename(temporary, path);
}
