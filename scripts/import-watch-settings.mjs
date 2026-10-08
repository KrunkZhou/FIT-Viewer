import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Profile } from "@garmin/fitsdk";

const sourcePath = process.argv[2];
if (!sourcePath) {
  throw new Error(
    "Usage: node scripts/import-watch-settings.mjs /path/to/WatchSettings.006-B4586-00.json",
  );
}

const source = await readFile(sourcePath);
const settings = JSON.parse(source);
if (
  settings.schemaVersion !== 2 ||
  settings.deviceModel?.manufacturer !== 1 ||
  settings.deviceModel?.product !== 4586
) {
  throw new Error("Expected schema 2 watch settings for Garmin product 4586.");
}

function snakeCase(value) {
  return value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s-]+/g, "_")
    .toLowerCase();
}

const messages = {};
for (const setting of settings.fields) {
  const { metadata, options, recordGuard } = setting;
  const { messageNumber, fieldNumber } = metadata;
  // Older entries encode the profile names in their description, not metadata.
  const names = setting.description.match(/^([A-Za-z0-9]+)\.([A-Za-z0-9]+)/);
  const messageName = snakeCase(
    Profile.messages[messageNumber]?.name ??
      metadata.messageName ??
      names?.[1] ??
      "",
  );
  const fieldName = snakeCase(metadata.fieldName ?? names?.[2] ?? setting.name);
  const units =
    metadata.units ?? setting.description.match(/Units: ([^.;]+)[.;]/)?.[1];
  if (!messageName || !fieldName) {
    throw new Error(`Missing names for ${messageNumber}:${fieldNumber}`);
  }
  const field = {
    fieldName,
    description: setting.description
      .replace(/Weekly schedule index \d+;/, "Weekly schedule slot;")
      .replace(/; Array element \d+ of \d+\./, "."),
    ...(units && { units }),
    ...(metadata.baseType !== undefined && {
      baseType: metadata.baseType & 0x1f,
    }),
    ...(metadata.fieldSize !== undefined && { fieldSize: metadata.fieldSize }),
    ...(metadata.valueType === "bitmask" && { bitmask: true }),
    ...(options.length && {
      values: Object.fromEntries(
        options.map((option) => [option.rawValue, snakeCase(option.name)]),
      ),
    }),
    ...(recordGuard && { recordGuard }),
  };
  const message = (messages[messageNumber] ??= { messageName, fields: {} });
  const existing = message.fields[fieldNumber];
  if (existing && JSON.stringify(existing) !== JSON.stringify(field)) {
    throw new Error(`Conflicting metadata for ${messageNumber}:${fieldNumber}`);
  }
  message.fields[fieldNumber] = field;
}

const result = {
  source: basename(sourcePath),
  sha256: createHash("sha256").update(source).digest("hex"),
  deviceModel: settings.deviceModel,
  messages,
};
const output =
  process.argv[3] ??
  fileURLToPath(
    new URL("../src/metadata/watch-settings.json", import.meta.url),
  );
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(
  `Imported ${Object.values(messages).reduce((n, m) => n + Object.keys(m.fields).length, 0)} fields across ${Object.keys(messages).length} messages.`,
);
