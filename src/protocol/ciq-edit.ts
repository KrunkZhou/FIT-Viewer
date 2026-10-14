import type { CiqSettingsEdit } from "../model";
import {
  MAX_CIQ_SETTINGS_BYTES,
  MAX_CIQ_SETTINGS_DEPTH,
  type CiqDictionary,
  type CiqScalar,
  type CiqValue,
} from "./ciq-settings";

const MIN_LONG = -(1n << 63n);
const MAX_LONG = (1n << 63n) - 1n;

export function validateCiqScalar(value: CiqScalar): void {
  switch (value.type) {
    case "string": {
      if (typeof value.value !== "string" || value.value.includes("\0"))
        throw new Error("Strings cannot contain null characters.");
      const bytes = new TextEncoder().encode(value.value);
      if (bytes.length > 32766)
        throw new Error("Strings cannot exceed 32,766 UTF-8 bytes.");
      if (
        new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) !==
        value.value
      )
        throw new Error("The string contains an invalid Unicode character.");
      break;
    }
    case "integer":
      if (
        !Number.isInteger(value.value) ||
        value.value < -2147483648 ||
        value.value > 2147483647
      )
        throw new Error("Enter an integer between -2147483648 and 2147483647.");
      break;
    case "long":
      if (
        typeof value.value !== "bigint" ||
        value.value < MIN_LONG ||
        value.value > MAX_LONG
      )
        throw new Error("Enter a signed 64-bit integer.");
      break;
    case "float":
    case "double":
      if (typeof value.value !== "number") throw new Error("Enter a number.");
      if (
        value.type === "float" &&
        Number.isFinite(value.value) &&
        !Number.isFinite(Math.fround(value.value))
      )
        throw new Error("The number is outside the 32-bit float range.");
      break;
    case "boolean":
      if (typeof value.value !== "boolean")
        throw new Error("Enter true or false.");
      break;
    case "null":
      if (value.value !== null) throw new Error("Expected a null value.");
      break;
    default:
      throw new Error("Unsupported settings value type.");
  }
}

export function ciqScalarText(value: CiqScalar): string {
  return Object.is(value.value, -0) ? "-0" : String(value.value);
}

export function parseCiqInput(original: CiqScalar, text: string): CiqScalar {
  let value: CiqScalar;
  if (original.type === "string") value = { type: "string", value: text };
  else if (original.type === "null") {
    if (text !== "null") throw new Error("Expected a null value.");
    value = { type: "null", value: null };
  } else if (original.type === "boolean") {
    if (text !== "true" && text !== "false")
      throw new Error("Enter true or false.");
    value = { type: "boolean", value: text === "true" };
  } else {
    const number = text.trim();
    if (original.type === "integer" || original.type === "long") {
      if (!/^[+-]?\d+$/.test(number)) throw new Error("Enter a whole number.");
      if (original.type === "long") {
        if (number.length > 21)
          throw new Error("Enter a signed 64-bit integer.");
        value = { type: "long", value: BigInt(number) };
      } else value = { type: "integer", value: Number(number) };
    } else {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(number))
        throw new Error("Enter a decimal number.");
      const parsed = Number(number);
      if (!Number.isFinite(parsed)) throw new Error("Enter a finite number.");
      value = { type: original.type, value: parsed };
    }
  }
  validateCiqScalar(value);
  return value.type === "float"
    ? { type: "float", value: Math.fround(value.value) }
    : value;
}

export function applyCiqEdits(
  settings: CiqDictionary,
  edits: CiqSettingsEdit[],
): CiqDictionary {
  if (!Array.isArray(edits) || edits.length > MAX_CIQ_SETTINGS_BYTES)
    throw new Error("Invalid settings edits.");
  if (!edits.length) return settings;
  const result: CiqDictionary = {
    type: "dictionary",
    entries: [...settings.entries],
  };
  const copied = new WeakSet<CiqValue>([result]);
  for (const edit of edits) {
    if (
      !Array.isArray(edit.path) ||
      !edit.path.length ||
      edit.path.length > MAX_CIQ_SETTINGS_DEPTH + 1 ||
      !edit.path.every((index) => Number.isSafeInteger(index) && index >= 0)
    )
      throw new Error("Invalid settings value path.");
    validateCiqScalar(edit.value);
    let node: CiqValue = result;
    for (const [depth, index] of edit.path.entries()) {
      const child: CiqValue | undefined =
        node.type === "dictionary"
          ? node.entries[index]?.value
          : node.type === "array"
            ? node.items[index]
            : undefined;
      if (!child) throw new Error("The settings value does not exist.");
      let next: CiqValue;
      if (depth === edit.path.length - 1) {
        if (
          child.type === "array" ||
          child.type === "dictionary" ||
          child.type !== edit.value.type
        )
          throw new Error(
            "Settings edits must preserve the original value type.",
          );
        next = { ...edit.value };
      } else if (copied.has(child)) next = child;
      else if (child.type === "dictionary") {
        next = { type: "dictionary", entries: [...child.entries] };
        copied.add(next);
      } else if (child.type === "array") {
        next = { type: "array", items: [...child.items] };
        copied.add(next);
      } else throw new Error("The settings value does not exist.");
      if (node.type === "dictionary") {
        node.entries[index] = { ...node.entries[index], value: next };
      } else if (node.type === "array") {
        node.items[index] = next;
      }
      node = next;
    }
  }
  return result;
}
