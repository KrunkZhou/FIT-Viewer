import type { RawValue, Scalar, WireField } from "../model";

export const WIDTHS = [1, 1, 1, 2, 2, 4, 4, 1, 4, 8, 1, 2, 4, 1, 8, 8, 8];
export const TYPE_NAMES = [
  "enum",
  "sint8",
  "uint8",
  "sint16",
  "uint16",
  "sint32",
  "uint32",
  "string",
  "float32",
  "float64",
  "uint8z",
  "uint16z",
  "uint32z",
  "byte",
  "sint64",
  "uint64",
  "uint64z",
];
const INVALID: (number | bigint | undefined)[] = [
  255,
  127,
  255,
  32767,
  65535,
  2147483647,
  4294967295,
  undefined,
  undefined,
  undefined,
  0,
  0,
  0,
  255,
  0x7fffffffffffffffn,
  0xffffffffffffffffn,
  0n,
];
const decoder = new TextDecoder();

export function valid(value: Scalar, type: number): boolean {
  return (
    value !== null &&
    value !== INVALID[type] &&
    (typeof value !== "number" || Number.isFinite(value))
  );
}

export function readValue(
  view: DataView,
  offset: number,
  field: WireField,
  little: boolean,
): RawValue {
  const type = field.type & 31;
  if (type === 7) {
    const data = new Uint8Array(
      view.buffer,
      view.byteOffset + offset,
      field.size,
    );
    const zero = data.indexOf(0);
    return decoder.decode(zero === -1 ? data : data.subarray(0, zero));
  }
  const width = WIDTHS[type];
  if (!width || field.size % width)
    return Array.from(
      new Uint8Array(view.buffer, view.byteOffset + offset, field.size),
    );
  const values: Scalar[] = [];
  for (let p = offset; p < offset + field.size; p += width) {
    let value: Scalar;
    switch (type) {
      case 1:
        value = view.getInt8(p);
        break;
      case 3:
        value = view.getInt16(p, little);
        break;
      case 4:
      case 11:
        value = view.getUint16(p, little);
        break;
      case 5:
        value = view.getInt32(p, little);
        break;
      case 6:
      case 12:
        value = view.getUint32(p, little);
        break;
      case 8:
        value = view.getFloat32(p, little);
        break;
      case 9:
        value = view.getFloat64(p, little);
        break;
      case 14:
        value = view.getBigInt64(p, little);
        break;
      case 15:
      case 16:
        value = view.getBigUint64(p, little);
        break;
      default:
        value = view.getUint8(p);
    }
    values.push(value);
  }
  return values.length === 1 ? values[0] : values;
}

export function fieldKey(field: WireField): string {
  return field.developer === undefined
    ? String(field.id)
    : `d${field.developer}:${field.id}`;
}

export function numberValue(value: RawValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

export function writeScalar(
  view: DataView,
  offset: number,
  type: number,
  value: number | bigint,
): void {
  switch (type) {
    case 1:
      view.setInt8(offset, Number(value));
      break;
    case 3:
      view.setInt16(offset, Number(value), true);
      break;
    case 4:
    case 11:
      view.setUint16(offset, Number(value), true);
      break;
    case 5:
      view.setInt32(offset, Number(value), true);
      break;
    case 6:
    case 12:
      view.setUint32(offset, Number(value), true);
      break;
    case 8:
      view.setFloat32(offset, Number(value), true);
      break;
    case 9:
      view.setFloat64(offset, Number(value), true);
      break;
    case 14:
      view.setBigInt64(offset, BigInt(value), true);
      break;
    case 15:
    case 16:
      view.setBigUint64(offset, BigInt(value), true);
      break;
    default:
      view.setUint8(offset, Number(value));
  }
}
