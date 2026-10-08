import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Asset maintenance only; CI packages the checked-in PNG, ICO and ICNS files.
if (process.platform !== "darwin")
  throw new Error(
    "Regenerate icons on macOS (sips and iconutil are required).",
  );
const root = await mkdtemp(join(tmpdir(), "fitviewer-icons-"));
try {
  const iconset = join(root, "icon.iconset");
  await mkdir(iconset);
  await mkdir("public/icons", { recursive: true });
  const resize = (size, output) =>
    execFileSync(
      "sips",
      [
        "-z",
        String(size),
        String(size),
        "build/icon-source.png",
        "--out",
        output,
      ],
      { stdio: "ignore" },
    );
  for (const size of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024])
    resize(size, join(root, `${size}.png`));
  for (const size of [16, 32, 128, 256, 512]) {
    await copyFile(
      join(root, `${size}.png`),
      join(iconset, `icon_${size}x${size}.png`),
    );
    await copyFile(
      join(root, `${size * 2}.png`),
      join(iconset, `icon_${size}x${size}@2x.png`),
    );
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", "build/icon.icns"]);
  const sizes = [16, 32, 48, 64, 128, 256];
  const images = [];
  for (const size of sizes)
    images.push(await readFile(join(root, `${size}.png`)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  for (const [index, bytes] of images.entries()) {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] % 256;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  }
  await writeFile("build/icon.ico", Buffer.concat([header, ...images]));
  await copyFile("build/icon.ico", "public/icons/favicon.ico");
  for (const size of [32, 180, 192, 512])
    await copyFile(join(root, `${size}.png`), `public/icons/icon-${size}.png`);
  console.log("Generated web, Windows and macOS icons.");
} finally {
  await rm(root, { recursive: true, force: true });
}
