import { mkdir, writeFile } from "node:fs/promises";
import {
  activity,
  uiActivity,
  file,
  join,
  type Field,
} from "../tests/fixtures";
import { readFit } from "../src/protocol/reader";
import JSZip from "jszip";
await mkdir(".cache", { recursive: true });
for (const count of [180, 100000, 1000000])
  await writeFile(`.cache/benchmark-${count}.fit`, activity(count));
const clean = uiActivity();
const index = await readFit(clean);
const damaged = clean.slice(
  0,
  index.definitions.find((d) => d.message === 18)!.offset,
);
await writeFile(".cache/browser-clean.fit", clean);
const route = (route: number) =>
  file(
    Array.from({ length: 50 }, (_, i) => ({
      message: 20,
      fields: [
        [253, 6, 1100000000 + route * 100 + i],
        [0, 5, Math.round(((51.505 + i * 0.0002) * 2147483648) / 180)],
        [
          1,
          5,
          Math.round(
            ((-0.09 + route * 0.004 + Math.sin(i / 5) * 0.001) * 2147483648) /
              180,
          ),
        ],
        [5, 6, i * 10000],
      ] as Field[],
    })),
  );
await writeFile(".cache/browser-routes.fit", join([route(0), route(1)]));
await writeFile(".cache/browser-damaged.fit", damaged);
const zip = new JSZip().file("clean.fit", clean).file("damaged.fit", damaged);
await writeFile(
  ".cache/browser-selection.zip",
  await zip.generateAsync({ type: "uint8array" }),
);
