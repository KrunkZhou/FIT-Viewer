import { Profile } from "@garmin/fitsdk";
import watchReference from "./watch-settings.json";
import type {
  Cell,
  Definition,
  FieldInfo,
  RawValue,
  RecordRef,
  Scalar,
  WireField,
} from "../model";
import type { FitIndex } from "../protocol/reader";
import {
  fieldKey,
  numberValue,
  readValue,
  TYPE_NAMES,
  valid,
} from "../protocol/binary";

import { FIT_EPOCH } from "../protocol/time";
export const words = (value: string): string =>
  value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
interface WatchField {
  fieldName: string;
  units?: string;
  description: string;
  values?: Record<string, string>;
  bitmask?: boolean;
  baseType?: number;
  fieldSize?: number;
  recordGuard?: {
    fields: { number: number; baseType: number; size: number }[];
    exactLayout: boolean;
    messageIndexRequired: boolean;
    messageIndexMinimum?: number;
    messageIndexMaximum?: number;
  };
}
const watch = watchReference as {
  deviceModel: { manufacturer: number; product: number };
  messages: Record<
    string,
    { messageName: string; fields: Record<string, WatchField> }
  >;
};
interface DeveloperInfo {
  type: number;
  name: string;
  units: string;
  scale: number;
  offset: number;
  position: number;
  array: boolean;
}
const first = <T>(value: T | T[] | undefined, fallback: T): T =>
  Array.isArray(value) ? (value[0] ?? fallback) : (value ?? fallback);

function fixedBigInt(value: bigint, scale: number, offset: number): string {
  if (
    !Number.isSafeInteger(scale) ||
    scale < 1 ||
    !Number.isSafeInteger(offset)
  )
    return value.toString();
  const denominator = BigInt(scale);
  const numerator = value - BigInt(offset) * denominator;
  const sign = numerator < 0n ? "-" : "";
  const magnitude = numerator < 0n ? -numerator : numerator;
  const remainder = magnitude % denominator;
  if (!remainder) return `${sign}${magnitude / denominator}`;
  let reduced = scale;
  let twos = 0;
  let fives = 0;
  while (reduced % 2 === 0) {
    reduced /= 2;
    twos++;
  }
  while (reduced % 5 === 0) {
    reduced /= 5;
    fives++;
  }
  if (reduced !== 1) return `${numerator}/${denominator}`;
  const decimals = Math.max(twos, fives);
  const fraction = ((remainder * 10n ** BigInt(decimals)) / denominator)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${sign}${magnitude / denominator}.${fraction}`;
}

export class Metadata {
  private developers = new Map<string, DeveloperInfo[]>();
  private fieldCache = new WeakMap<Definition, Map<string, FieldInfo>>();
  constructor(readonly index: FitIndex) {
    for (const id of index.messages.get(206) ?? []) {
      const record = index.records[id];
      const data = index.raw(record);
      const developer = numberValue(data["0"]);
      const field = numberValue(data["1"]);
      const type = numberValue(data["2"]);
      if (developer === undefined || field === undefined || type === undefined)
        continue;
      const key = `${record.subfile}:${developer}:${field}`;
      const descriptions = this.developers.get(key) ?? [];
      descriptions.push({
        type: type & 31,
        name:
          typeof data["3"] === "string"
            ? data["3"]
            : `Developer ${developer}:${field}`,
        units: typeof data["8"] === "string" ? data["8"] : "",
        scale: numberValue(data["6"]) || 1,
        offset: numberValue(data["7"]) ?? 0,
        position: record.offset,
        array: (numberValue(data["4"]) ?? 0) > 0,
      });
      this.developers.set(key, descriptions);
    }
  }
  developer(record: RecordRef, field: WireField): DeveloperInfo | undefined {
    const descriptions = this.developers.get(
      `${record.subfile}:${field.developer}:${field.id}`,
    );
    return (
      descriptions?.findLast((d) => d.position <= record.offset) ??
      descriptions?.[0]
    );
  }
  raw(record: RecordRef): Record<string, RawValue> {
    const result: Record<string, RawValue> = {};
    let offset = record.offset + 1;
    for (const field of record.definition.fields) {
      if (
        record.compressed &&
        field.id === 253 &&
        field.developer === undefined
      )
        continue;
      const type =
        field.developer === undefined
          ? field.type
          : (this.developer(record, field)?.type ?? field.type);
      const value = readValue(
        this.index.view,
        offset,
        { ...field, type },
        record.definition.littleEndian,
      );
      const array =
        field.developer === undefined
          ? Profile.messages[record.definition.message]?.fields[field.id]?.array
          : this.developer(record, field)?.array;
      result[fieldKey(field)] =
        array && !Array.isArray(value) && typeof value !== "string"
          ? [value]
          : value;
      offset += field.size;
    }
    if (record.timestamp !== undefined) result["253"] = record.timestamp;
    return result;
  }
  watchField(
    record: RecordRef,
    field: WireField,
    raw: Record<string, RawValue>,
  ): WatchField | undefined {
    const file = this.index.subfiles[record.subfile];
    if (
      file.manufacturer !== watch.deviceModel.manufacturer ||
      file.product !== watch.deviceModel.product ||
      field.developer !== undefined
    )
      return;
    const info = watch.messages[record.definition.message]?.fields[field.id];
    if (
      !info ||
      (info.baseType !== undefined && (info.baseType & 31) !== field.type) ||
      (info.fieldSize !== undefined && info.fieldSize !== field.size)
    )
      return;
    const guard = info.recordGuard;
    if (guard) {
      const fields = record.definition.fields.filter(
        (f) => f.developer === undefined,
      );
      if (
        (guard.exactLayout && fields.length !== guard.fields.length) ||
        guard.fields.some(
          (g) =>
            !fields.some(
              (f) =>
                f.id === g.number &&
                f.type === (g.baseType & 31) &&
                f.size === g.size,
            ),
        )
      )
        return;
      if (guard.messageIndexRequired) {
        const slot = numberValue(raw["254"]);
        if (
          slot === undefined ||
          slot < (guard.messageIndexMinimum ?? 0) ||
          slot > (guard.messageIndexMaximum ?? Infinity)
        )
          return;
      }
    }
    return info;
  }
  messageName(message: number): string {
    const official = Profile.messages[message];
    if (official) return words(official.name);
    const match = this.index.records.find(
      (r) =>
        r.definition.message === message &&
        this.index.subfiles[r.subfile].manufacturer ===
          watch.deviceModel.manufacturer &&
        this.index.subfiles[r.subfile].product === watch.deviceModel.product &&
        r.definition.fields.some((f) => this.watchField(r, f, this.raw(r))),
    );
    return match && watch.messages[message]
      ? words(watch.messages[message].messageName)
      : `Message ${message}`;
  }
  field(
    record: RecordRef,
    wire: WireField,
    raw: Record<string, RawValue>,
  ): FieldInfo {
    const key = fieldKey(wire);
    const cache =
      this.fieldCache.get(record.definition) ?? new Map<string, FieldInfo>();
    this.fieldCache.set(record.definition, cache);
    if (wire.developer !== undefined) {
      const info = this.developer(record, wire);
      const cacheKey = `${key}:${info?.position}`;
      const existing = cache.get(cacheKey);
      if (existing) return existing;
      const result = {
        key,
        id: wire.id,
        name: info?.name ?? `Developer ${wire.developer}:${wire.id}`,
        type: TYPE_NAMES[info?.type ?? wire.type] ?? "byte",
        units: info?.units ?? "",
        scale: info?.scale ?? 1,
        offset: info?.offset ?? 0,
        unknown: !info,
        developer: true,
      };
      cache.set(cacheKey, result);
      return result;
    }
    const profile = Profile.messages[record.definition.message];
    const official = profile?.fields[wire.id];
    const extra = this.watchField(record, wire, raw);
    const active = official?.subFields.find((sub) =>
      sub.map.some((condition) => {
        const controller = Object.values(profile.fields).find(
          (f) => f.name === condition.name,
        );
        return controller && raw[String(controller.num)] === condition.value;
      }),
    );
    const definition = active ?? official;
    const type = definition?.type ?? TYPE_NAMES[wire.type] ?? "byte";
    const cacheKey = `${key}:${definition?.name}:${Boolean(extra)}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;
    const result = {
      key,
      id: wire.id,
      name: words(definition?.name ?? extra?.fieldName ?? `Field ${wire.id}`),
      type,
      units:
        first(definition?.units, extra?.units ?? "") === "semicircles"
          ? "deg"
          : first(definition?.units, extra?.units ?? ""),
      scale: first(definition?.scale, 1),
      offset: first(definition?.offset, 0),
      values: {
        ...extra?.values,
        ...(type === "dateTime" || type === "localDateTime"
          ? {}
          : Profile.types[type]),
      },
      bitmask: extra?.bitmask,
      description: extra?.description,
      unknown: !official && !extra,
      developer: false,
    };
    cache.set(cacheKey, result);
    return result;
  }
  cell(
    record: RecordRef,
    wire: WireField,
    raw: RawValue,
    info: FieldInfo,
  ): Cell {
    const type =
      wire.developer === undefined
        ? wire.type
        : (this.developer(record, wire)?.type ?? wire.type);
    const convert = (value: Scalar): Scalar => {
      if (!valid(value, type)) return null;
      if (typeof value === "string") return value;
      if (typeof value === "bigint")
        return info.scale === 1 && info.offset === 0
          ? value
          : fixedBigInt(value, info.scale ?? 1, info.offset ?? 0);
      if (value === null) return null;
      if (info.type === "dateTime" || info.type === "localDateTime")
        return new Date(FIT_EPOCH + value * 1000).toISOString();
      if (info.bitmask) {
        let remaining = BigInt(Math.trunc(value));
        const labels: string[] = [];
        for (const [code, label] of Object.entries(info.values ?? {})) {
          const bits = BigInt(code);
          if (bits !== 0n && (remaining & bits) === bits) {
            labels.push(words(label));
            remaining &= ~bits;
          }
        }
        if (remaining || !labels.length)
          labels.push(
            remaining === 0n
              ? words(info.values?.["0"] ?? "0")
              : `0x${remaining.toString(16)}`,
          );
        return labels.join(" | ");
      }
      const label = info.values?.[String(value)];
      if (label) return words(label);
      if (
        info.units === "deg" &&
        Profile.messages[record.definition.message]?.fields[wire.id]?.units ===
          "semicircles"
      )
        return (value * 180) / 2147483648;
      return value / (info.scale || 1) - (info.offset ?? 0);
    };
    const value = Array.isArray(raw) ? raw.map(convert) : convert(raw);
    return {
      raw,
      value,
      numeric:
        info.type !== "dateTime" &&
        info.type !== "localDateTime" &&
        !info.bitmask &&
        !Object.keys(info.values ?? {}).length &&
        type !== 7,
    };
  }
}
