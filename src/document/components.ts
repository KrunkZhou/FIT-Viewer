import { Profile } from "@garmin/fitsdk";
import type { RawValue, RecordRef } from "../model";
import { WIDTHS } from "../protocol/binary";

export function expandComponents(
  record: RecordRef,
  raw: Record<string, RawValue>,
  accumulated?: Map<string, number>,
): Record<string, RawValue> {
  const profile = Profile.messages[record.definition.message];
  const output: Record<string, RawValue> = {};
  for (const wire of record.definition.fields) {
    if (wire.developer !== undefined) continue;
    const definition = profile?.fields[wire.id];
    const value = raw[String(wire.id)];
    if (
      !definition?.hasComponents ||
      value === undefined ||
      value === null ||
      typeof value === "string"
    )
      continue;
    if (
      accumulated &&
      !definition.components.some(
        (key) => profile.fields[Number(key)]?.isAccumulated,
      )
    )
      continue;
    const values = Array.isArray(value) ? value : [value];
    if (
      values.some(
        (v) =>
          (typeof v !== "number" && typeof v !== "bigint") ||
          (typeof v === "number" && !Number.isFinite(v)),
      ) ||
      (wire.type === 13 && values.every((v) => v === 255))
    )
      continue;
    let packed = 0n;
    values.forEach((v, i) => {
      packed |=
        BigInt(v as number | bigint) << BigInt(i * WIDTHS[wire.type] * 8);
    });
    let bit = 0;
    for (let c = 0; c < definition.components.length; c++) {
      const key = definition.components[c];
      const width = definition.bits[c];
      if (!width || bit + width > wire.size * 8) break;
      let component = Number(
        (packed >> BigInt(bit)) & ((1n << BigInt(width)) - 1n),
      );
      bit += width;
      const target = profile.fields[Number(key)];
      if (!target || (target.isAccumulated && !accumulated)) continue;
      if (target.isAccumulated) {
        const accumulatorKey = `${record.subfile}:${record.definition.message}:${key}`;
        const before = accumulated!.get(accumulatorKey) ?? 0;
        component += Math.floor(before / 2 ** width) * 2 ** width;
        if (component < before) component += 2 ** width;
        accumulated!.set(accumulatorKey, component);
      }
      const scale = Array.isArray(definition.scale)
        ? definition.scale[c]
        : definition.scale;
      const offset = Array.isArray(definition.offset)
        ? definition.offset[c]
        : definition.offset;
      const targetScale = Array.isArray(target.scale)
        ? target.scale[0]
        : target.scale;
      const targetOffset = Array.isArray(target.offset)
        ? target.offset[0]
        : target.offset;
      const expanded =
        (component / (scale || 1) - (offset || 0) + (targetOffset || 0)) *
        (targetScale || 1);
      if (raw[key] === undefined && (!accumulated || target.isAccumulated)) {
        if (target.array) {
          const list = output[key];
          output[key] = Array.isArray(list) ? [...list, expanded] : [expanded];
        } else output[key] = expanded;
      }
    }
  }
  return output;
}
