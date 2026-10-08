import type { DisplayValue, FieldInfo } from "../model";
const formats = new Map<number, Intl.NumberFormat>();

export function fieldTooltip(field: FieldInfo): string {
  return [
    `Field ID: ${field.id}${field.developer ? ` (developer ${field.key.split(":")[0].slice(1)})` : ""}`,
    `${field.type}${field.units ? ` (${field.units})` : ""}${field.unknown ? " - undocumented" : ""}`,
    field.description,
  ]
    .filter(Boolean)
    .join("\n");
}

export function displayCell(
  value: DisplayValue | undefined,
  field: FieldInfo,
  raw: boolean,
): string {
  if (value === undefined || value === null) return "-";
  if (Array.isArray(value))
    return `[${value.map((v) => displayCell(v, field, raw)).join(", ")}]`;
  if (raw || typeof value !== "number") return String(value);
  const digits =
    field.units === "deg"
      ? 7
      : field.type.startsWith("float")
        ? 10
        : Math.min(10, Math.max(0, Math.ceil(Math.log10(field.scale ?? 1))));
  let format = formats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat(undefined, {
      useGrouping: false,
      maximumFractionDigits: digits,
    });
    formats.set(digits, format);
  }
  return format.format(value);
}
