import type { Job } from "../model";
import { idleJob } from "./reader";

export const MAX_CIQ_SETTINGS_BYTES = 1024 * 1024;
export const MAX_CIQ_SETTINGS_DEPTH = 64;
const STRING_BLOCK_MAGIC = 0xabcdabcd;
const DATA_BLOCK_MAGIC = 0xda7ada7a;

export type CiqScalar =
  | { type: "null"; value: null }
  | { type: "string"; value: string }
  | { type: "integer" | "float" | "double"; value: number }
  | { type: "long"; value: bigint }
  | { type: "boolean"; value: boolean };

export interface CiqArray {
  type: "array";
  items: CiqValue[];
}

export interface CiqEntry {
  key: CiqValue;
  value: CiqValue;
}

export interface CiqDictionary {
  type: "dictionary";
  entries: CiqEntry[];
}

export type CiqValue = CiqScalar | CiqArray | CiqDictionary;

/**
 * Decode the Connect IQ app settings serialization.
 * Blocks, lengths and numeric values are big endian. Strings have signed
 * two-byte lengths including their terminating null. Container children are
 * queued in breadth-first order by the SDK, rather than stored recursively.
 */
export async function readCiqSettings(
  bytes: Uint8Array,
  job: Job = idleJob(),
): Promise<CiqDictionary> {
  const aborted = () => {
    if (job.signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  aborted();
  if (!bytes.length || bytes.length > MAX_CIQ_SETTINGS_BYTES)
    throw new Error(
      "The CIQ settings file is empty or exceeds the 1 MiB limit.",
    );
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let end = bytes.length;
  const invalid = (message: string): never => {
    throw new Error(`Invalid CIQ settings at byte ${offset}: ${message}`);
  };
  const requireBytes = (size: number) => {
    if (size > end - offset) invalid("Truncated data.");
  };
  const int32 = () => {
    requireBytes(4);
    const value = view.getInt32(offset);
    offset += 4;
    return value;
  };
  const magic = () => {
    requireBytes(4);
    const value = view.getUint32(offset);
    offset += 4;
    return value;
  };
  const strings = new Map<number, string>();
  let block = magic();
  if (block === STRING_BLOCK_MAGIC) {
    const size = int32();
    if (size < 0 || size > bytes.length - offset)
      invalid("Invalid string block length.");
    end = offset + size;
    const start = offset;
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let count = 0;
    while (offset < end) {
      const stringOffset = offset - start;
      requireBytes(2);
      const length = view.getInt16(offset);
      offset += 2;
      if (length <= 0) invalid("Invalid string length.");
      requireBytes(length);
      if (bytes[offset + length - 1] !== 0)
        invalid("A string is missing its null terminator.");
      let value: string;
      try {
        value = decoder.decode(bytes.subarray(offset, offset + length - 1));
      } catch {
        invalid("A string contains invalid UTF-8.");
      }
      if (value!.includes("\0")) invalid("A string contains an embedded null.");
      strings.set(stringOffset, value!);
      offset += length;
      if (++count % 256 === 0) {
        job.progress(offset, bytes.length, "Reading CIQ settings");
        await job.yield();
        aborted();
      }
    }
    end = bytes.length;
    block = magic();
  }
  if (block !== DATA_BLOCK_MAGIC) invalid("Missing Connect IQ data block.");
  const dataSize = int32();
  if (dataSize <= 0 || dataSize !== bytes.length - offset)
    invalid("The data block length does not match the file.");
  end = offset + dataSize;

  const containers: {
    value: CiqArray | CiqDictionary;
    count: number;
    depth: number;
  }[] = [];
  let remainingValues = 1;
  let valuesRead = 0;
  const read = (depth: number): CiqValue => {
    requireBytes(1);
    const type = bytes[offset++];
    remainingValues--;
    valuesRead++;
    switch (type) {
      case 0:
        return { type: "null", value: null };
      case 1:
        return { type: "integer", value: int32() };
      case 2: {
        requireBytes(4);
        const value = view.getFloat32(offset);
        offset += 4;
        return { type: "float", value };
      }
      case 3: {
        const reference = int32();
        const value = strings.get(reference);
        if (value === undefined) invalid("Invalid string table reference.");
        return { type: "string", value: value! };
      }
      case 5:
      case 11: {
        if (depth > MAX_CIQ_SETTINGS_DEPTH)
          invalid("Settings nesting exceeds 64 levels.");
        const count = int32();
        const children = count * (type === 11 ? 2 : 1);
        if (count < 0 || children > end - offset - remainingValues)
          invalid("Invalid container length.");
        remainingValues += children;
        const value: CiqArray | CiqDictionary =
          type === 5
            ? { type: "array", items: [] }
            : { type: "dictionary", entries: [] };
        containers.push({ value, count, depth });
        return value;
      }
      case 9:
        requireBytes(1);
        return { type: "boolean", value: bytes[offset++] !== 0 };
      case 14: {
        requireBytes(8);
        const value = view.getBigInt64(offset);
        offset += 8;
        return { type: "long", value };
      }
      case 15: {
        requireBytes(8);
        const value = view.getFloat64(offset);
        offset += 8;
        return { type: "double", value };
      }
      default:
        return invalid(`Unsupported Connect IQ value type ${type}.`);
    }
  };
  const root = read(0);
  if (root.type !== "dictionary")
    invalid("Expected one Connect IQ settings dictionary.");
  // Entries are kept as typed pairs: app-controlled keys are never assigned
  // to a JavaScript object, and 64-bit Long values retain their full precision.
  for (let index = 0; index < containers.length; index++) {
    const container = containers[index];
    for (let child = 0; child < container.count; child++) {
      if (container.value.type === "array")
        container.value.items.push(read(container.depth + 1));
      else {
        const key = read(container.depth + 1);
        if (key.type === "null") invalid("A dictionary key cannot be null.");
        const value = read(container.depth + 1);
        container.value.entries.push({ key, value });
      }
      if (valuesRead >= 1024) {
        valuesRead = 0;
        job.progress(offset, bytes.length, "Reading CIQ settings");
        await job.yield();
        aborted();
      }
    }
  }
  if (remainingValues !== 0 || offset !== end)
    invalid(
      "Expected one Connect IQ settings dictionary with no trailing values.",
    );
  aborted();
  job.progress(bytes.length, bytes.length, "CIQ settings parsed");
  return root as CiqDictionary;
}
