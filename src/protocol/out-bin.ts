import type { Job } from "../model";
import { idleJob } from "./reader";

export const MAX_OUT_BIN_BYTES = 16 * 1024 * 1024;
export const MAX_OUT_BIN_FIELDS = 100_000;
export const MAX_OUT_BIN_ENTRIES = 10_000;

export type OutBinField =
  | { number: number; wireType: 0; value: bigint }
  | { number: number; wireType: 1 | 2 | 5; bytes: Uint8Array };

export interface OutBinAppEntry {
  appId: string;
  appIdHex: string;
  appType: number;
  name: string;
  disabled: boolean;
  favorite?: boolean;
  version?: number;
  filename?: string;
  fileSize?: bigint;
  nativeType?: number;
  unknownFields: OutBinField[];
}

export interface OutBinInventory {
  /** Output inventory field 1; retained without interpreting its meaning. */
  metadata: bigint;
  /** Output inventory field 2; retained without interpreting its meaning. */
  status: number;
  entries: OutBinAppEntry[];
  unknownFields: {
    root: OutBinField[];
    service: OutBinField[];
    inventory: OutBinField[];
  };
}

/**
 * Read Garmin's IQAppsConfiguration output inventory (OUT.BIN).
 * This is a protobuf message, distinct from both FIT and Connect IQ .SET
 * serialization. The root's field 3 wraps service field 2, whose repeated
 * field 3 contains apps. IN.BIN uses service field 5 and a different schema.
 * Known fields follow Clover's GarminGlanceConfigurationFile parser; unknown
 * fields and app types remain available for inspecting newer inventories.
 */
export async function readOutBin(
  bytes: Uint8Array,
  job: Job = idleJob(),
): Promise<OutBinInventory> {
  const aborted = () => {
    if (job.signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  aborted();
  if (!bytes.length || bytes.length > MAX_OUT_BIN_BYTES)
    throw new Error("The OUT.BIN file is empty or exceeds the 16 MiB limit.");

  let fieldCount = 0;
  let progressOffset = 0;
  const invalid = (message: string): never => {
    throw new Error(`Invalid OUT.BIN: ${message}`);
  };
  const readFields = async (
    source: Uint8Array,
    sourceOffset: number,
  ): Promise<OutBinField[]> => {
    const fields: OutBinField[] = [];
    let offset = 0;
    const varint = (): bigint => {
      let value = 0n;
      for (let index = 0; index < 10; index++) {
        if (offset === source.length) invalid("Truncated protobuf varint.");
        const part = source[offset++];
        if (index === 9 && part > 1) invalid("Overflowing protobuf varint.");
        value |= BigInt(part & 127) << BigInt(index * 7);
        if (!(part & 128)) return value;
      }
      return invalid("Overflowing protobuf varint.");
    };
    while (offset < source.length) {
      if (++fieldCount > MAX_OUT_BIN_FIELDS)
        invalid("The inventory contains more than 100,000 protobuf fields.");
      const tag = varint();
      const number = tag >> 3n;
      const wireType = Number(tag & 7n);
      if (number === 0n || number > 536_870_911n)
        invalid("Invalid protobuf field number.");
      if (wireType === 0) {
        fields.push({ number: Number(number), wireType, value: varint() });
      } else if (wireType === 1 || wireType === 2 || wireType === 5) {
        const length =
          wireType === 2 ? varint() : BigInt(wireType === 1 ? 8 : 4);
        if (length > BigInt(source.length - offset))
          invalid("Truncated protobuf value.");
        const size = Number(length);
        fields.push({
          number: Number(number),
          wireType,
          bytes: source.subarray(offset, offset + size),
        });
        offset += size;
      } else {
        invalid(`Unsupported protobuf wire type ${wireType}.`);
      }
      // The wrappers cover the entire input before their child messages are
      // decoded. Count only the current message position for byte progress.
      progressOffset = Math.max(progressOffset, sourceOffset + offset);
      if (fieldCount % 256 === 0) {
        job.progress(progressOffset, bytes.length, "Reading OUT.BIN inventory");
        await job.yield();
        aborted();
      }
    }
    return fields;
  };
  const single = (
    fields: OutBinField[],
    number: number,
    wireType: number,
    required: boolean,
  ): OutBinField | undefined => {
    const matching = fields.filter((field) => field.number === number);
    if (
      matching.length > 1 ||
      (matching.length === 1 && matching[0].wireType !== wireType) ||
      (required && matching.length === 0)
    )
      invalid(`Missing, duplicate or mistyped protobuf field ${number}.`);
    return matching[0];
  };
  const numberValue = (field: OutBinField | undefined): bigint => {
    if (!field || field.wireType !== 0)
      return invalid("Expected a protobuf varint.");
    return field.value;
  };
  const payload = (field: OutBinField | undefined): Uint8Array => {
    if (!field || field.wireType !== 2)
      return invalid("Expected a length-delimited protobuf field.");
    return field.bytes;
  };
  const uint32 = (field: OutBinField | undefined): number => {
    const value = numberValue(field);
    if (value > 0xffff_ffffn) invalid("A value exceeds uint32.");
    return Number(value);
  };
  const boolean = (field: OutBinField | undefined): boolean => {
    const value = numberValue(field);
    if (value !== 0n && value !== 1n) invalid("A boolean must be zero or one.");
    return value === 1n;
  };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const string = (field: OutBinField | undefined): string => {
    try {
      return decoder.decode(payload(field));
    } catch {
      return invalid("A string contains invalid UTF-8.");
    }
  };
  const unknown = (fields: OutBinField[], known: number[]): OutBinField[] =>
    fields
      .filter((field) => !known.includes(field.number))
      .map((field) =>
        field.wireType === 0
          ? { ...field }
          : { ...field, bytes: field.bytes.slice() },
      );
  const child = async (
    field: OutBinField | undefined,
  ): Promise<OutBinField[]> => {
    const source = payload(field);
    return readFields(source, source.byteOffset - bytes.byteOffset);
  };

  const root = await readFields(bytes, 0);
  const service = await child(single(root, 3, 2, true));
  if (
    service.some(
      (field) => field.number >= 1 && field.number <= 10 && field.number !== 2,
    )
  )
    invalid(
      "Unexpected service message; expected an OUT.BIN output inventory.",
    );
  const inventory = await child(single(service, 2, 2, true));
  const metadata = numberValue(single(inventory, 1, 0, true));
  const status = uint32(single(inventory, 2, 0, true));
  const entries: OutBinAppEntry[] = [];
  const identities = new Set<string>();
  for (const encoded of inventory.filter((field) => field.number === 3)) {
    if (encoded.wireType !== 2)
      invalid("An app entry must be length-delimited.");
    if (entries.length >= MAX_OUT_BIN_ENTRIES)
      invalid("The inventory contains more than 10,000 app entries.");
    const fields = await child(encoded);
    const id = payload(single(fields, 1, 2, true));
    if (id.length !== 16) invalid("An app UUID must contain exactly 16 bytes.");
    const appIdHex = Array.from(id, (part) =>
      part.toString(16).padStart(2, "0"),
    ).join("");
    const appId = `${appIdHex.slice(0, 8)}-${appIdHex.slice(8, 12)}-${appIdHex.slice(12, 16)}-${appIdHex.slice(16, 20)}-${appIdHex.slice(20)}`;
    const appType = uint32(single(fields, 2, 0, true));
    const identity = `${appIdHex}:${appType}`;
    if (identities.has(identity)) invalid("Duplicate app UUID and app type.");
    identities.add(identity);
    const entry: OutBinAppEntry = {
      appId,
      appIdHex,
      appType,
      name: string(single(fields, 3, 2, true)),
      disabled: boolean(single(fields, 4, 0, true)),
      unknownFields: unknown(fields, [1, 2, 3, 4, 5, 6, 7, 8, 9]),
    };
    const version = single(fields, 5, 0, false);
    if (version) entry.version = uint32(version);
    const filename = single(fields, 6, 2, false);
    if (filename) entry.filename = string(filename);
    const fileSize = single(fields, 7, 0, false);
    if (fileSize) entry.fileSize = numberValue(fileSize);
    const nativeType = single(fields, 8, 0, false);
    if (nativeType) entry.nativeType = uint32(nativeType);
    const favorite = single(fields, 9, 0, false);
    if (favorite) entry.favorite = boolean(favorite);
    entries.push(entry);
  }
  aborted();
  job.progress(bytes.length, bytes.length, "OUT.BIN inventory parsed");
  return {
    metadata,
    status,
    entries,
    unknownFields: {
      root: unknown(root, [3]),
      service: unknown(service, [2]),
      inventory: unknown(inventory, [1, 2, 3]),
    },
  };
}
