import type { Job } from "../model";
import { validateCiqScalar } from "./ciq-edit";
import {
  MAX_CIQ_SETTINGS_BYTES,
  MAX_CIQ_SETTINGS_DEPTH,
  type CiqArray,
  type CiqDictionary,
  type CiqValue,
} from "./ciq-settings";
import { idleJob } from "./reader";

export async function writeCiqSettings(
  settings: CiqDictionary,
  job: Job = idleJob(),
): Promise<Uint8Array<ArrayBuffer>> {
  const aborted = () => {
    if (job.signal.aborted) throw new DOMException("Aborted", "AbortError");
  };
  aborted();
  if (settings.type !== "dictionary")
    throw new Error("Expected a CIQ settings dictionary.");
  const data = new Uint8Array(MAX_CIQ_SETTINGS_BYTES);
  const strings = new Uint8Array(MAX_CIQ_SETTINGS_BYTES);
  const dataView = new DataView(data.buffer);
  const stringView = new DataView(strings.buffer);
  const references = new Map<string, number>();
  const encoder = new TextEncoder();
  let offset = 0;
  let stringOffset = 0;
  let written = 0;
  const reserve = (size: number, string = false) => {
    const headers = string || stringOffset ? 16 : 8;
    if (offset + stringOffset + size + headers > MAX_CIQ_SETTINGS_BYTES)
      throw new Error("The edited CIQ settings exceed the 1 MiB limit.");
    const start = string ? stringOffset : offset;
    if (string) stringOffset += size;
    else offset += size;
    return start;
  };
  const containers: { value: CiqArray | CiqDictionary; depth: number }[] = [];
  const write = (value: CiqValue, depth: number) => {
    written++;
    if (value.type === "array" || value.type === "dictionary") {
      if (depth > MAX_CIQ_SETTINGS_DEPTH)
        throw new Error("Settings nesting exceeds 64 levels.");
      const children = value.type === "array" ? value.items : value.entries;
      if (!Array.isArray(children) || children.length > MAX_CIQ_SETTINGS_BYTES)
        throw new Error("Invalid settings container length.");
      const start = reserve(5);
      data[start] = value.type === "array" ? 5 : 11;
      dataView.setInt32(start + 1, children.length);
      containers.push({ value, depth });
      return;
    }
    validateCiqScalar(value);
    switch (value.type) {
      case "null":
        data[reserve(1)] = 0;
        break;
      case "boolean": {
        const start = reserve(2);
        data[start] = 9;
        data[start + 1] = value.value ? 1 : 0;
        break;
      }
      case "string": {
        let reference = references.get(value.value);
        if (reference === undefined) {
          const bytes = encoder.encode(value.value);
          reference = reserve(bytes.length + 3, true);
          stringView.setInt16(reference, bytes.length + 1);
          strings.set(bytes, reference + 2);
          references.set(value.value, reference);
        }
        const start = reserve(5);
        data[start] = 3;
        dataView.setInt32(start + 1, reference);
        break;
      }
      case "integer":
      case "float": {
        const start = reserve(5);
        data[start] = value.type === "integer" ? 1 : 2;
        if (value.type === "integer") dataView.setInt32(start + 1, value.value);
        else dataView.setFloat32(start + 1, value.value);
        break;
      }
      case "long":
      case "double": {
        const start = reserve(9);
        data[start] = value.type === "long" ? 14 : 15;
        if (value.type === "long") dataView.setBigInt64(start + 1, value.value);
        else dataView.setFloat64(start + 1, value.value);
        break;
      }
    }
  };
  const checkpoint = async () => {
    if (written < 256) return;
    written = 0;
    job.progress(
      offset + stringOffset,
      MAX_CIQ_SETTINGS_BYTES,
      "Encoding CIQ settings",
    );
    await job.yield();
    aborted();
  };
  // Container payloads follow the same breadth-first order as the binary format.
  write(settings, 0);
  for (let index = 0; index < containers.length; index++) {
    const { value, depth } = containers[index];
    if (value.type === "array") {
      for (const item of value.items) {
        write(item, depth + 1);
        if (written >= 256) await checkpoint();
      }
    } else {
      for (const entry of value.entries) {
        if (entry.key.type === "null")
          throw new Error("A dictionary key cannot be null.");
        write(entry.key, depth + 1);
        write(entry.value, depth + 1);
        if (written >= 256) await checkpoint();
      }
    }
  }
  aborted();
  const bytes = new Uint8Array(offset + stringOffset + (stringOffset ? 16 : 8));
  const view = new DataView(bytes.buffer);
  let start = 0;
  if (stringOffset) {
    view.setUint32(0, 0xabcdabcd);
    view.setInt32(4, stringOffset);
    bytes.set(strings.subarray(0, stringOffset), 8);
    start = stringOffset + 8;
  }
  view.setUint32(start, 0xda7ada7a);
  view.setInt32(start + 4, offset);
  bytes.set(data.subarray(0, offset), start + 8);
  job.progress(bytes.length, bytes.length, "CIQ settings encoded");
  return bytes;
}
