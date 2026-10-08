import { CrcCalculator } from "@garmin/fitsdk";
import type {
  Definition,
  Diagnostic,
  Job,
  RawValue,
  RecordRef,
  Subfile,
  WireField,
} from "../model";
import { fieldKey, numberValue, readValue, WIDTHS } from "./binary";

export interface FitIndex {
  bytes: Uint8Array;
  view: DataView;
  records: RecordRef[];
  definitions: Definition[];
  messages: Map<number, number[]>;
  subfiles: Subfile[];
  diagnostics: Diagnostic[];
  raw: (record: RecordRef) => Record<string, RawValue>;
}
export const idleJob = (): Job => ({
  signal: new AbortController().signal,
  progress: () => {},
  yield: async () => {},
});

export function rawRecord(
  index: Pick<FitIndex, "view">,
  record: RecordRef,
): Record<string, RawValue> {
  const result: Record<string, RawValue> = {};
  let offset = record.offset + 1;
  for (const field of record.definition.fields) {
    if (record.compressed && field.id === 253 && field.developer === undefined)
      continue;
    result[fieldKey(field)] = readValue(
      index.view,
      offset,
      field,
      record.definition.littleEndian,
    );
    offset += field.size;
  }
  if (record.timestamp !== undefined) result["253"] = record.timestamp;
  return result;
}

export async function readFit(
  input: Uint8Array,
  job = idleJob(),
): Promise<FitIndex> {
  const bytes = input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const index: FitIndex = {
    bytes,
    view,
    records: [],
    definitions: [],
    messages: new Map(),
    subfiles: [],
    diagnostics: [],
    raw: (record) => rawRecord(index, record),
  };
  const issue = (
    subfile: number,
    offset: number,
    end: number,
    code: string,
    message: string,
    repair: Diagnostic["repair"],
    severity: Diagnostic["severity"] = "error",
  ) => {
    index.diagnostics.push({
      id: `${subfile}:${offset}:${code}`,
      subfile,
      offset,
      end,
      code,
      message,
      repair,
      severity,
    });
  };
  const headerAt = (offset: number) =>
    offset + 12 <= bytes.length &&
    bytes[offset] >= 12 &&
    bytes[offset] <= 64 &&
    bytes[offset + 8] === 46 &&
    bytes[offset + 9] === 70 &&
    bytes[offset + 10] === 73 &&
    bytes[offset + 11] === 84;
  let start = 0;
  let lastYield = performance.now();
  const checkpoint = async (position: number) => {
    if (job.signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (performance.now() - lastYield > 8) {
      job.progress(position, bytes.length, "Reading FIT");
      await job.yield();
      lastYield = performance.now();
    }
  };
  const verifiedHeader = async (offset: number) => {
    if (!headerAt(offset)) return false;
    const end = offset + bytes[offset] + view.getUint32(offset + 4, true) + 2;
    if (end > bytes.length) return false;
    const crc = new CrcCalculator();
    for (let p = offset; p < end; p += 65536) {
      crc.addBytes(bytes, p, Math.min(p + 65536, end));
      await checkpoint(p);
    }
    return crc.crc === 0;
  };
  while (start < bytes.length) {
    if (!headerAt(start)) {
      if (start === 0)
        throw new Error("The file does not contain a FIT header.");
      issue(
        index.subfiles.length - 1,
        start,
        bytes.length,
        "trailing-data",
        "Unrecognized trailing bytes were retained in the original file.",
        "tail",
      );
      break;
    }
    const id = index.subfiles.length;
    const headerSize = bytes[start];
    if (start + headerSize > bytes.length)
      throw new Error("The FIT header is incomplete.");
    const bodyStart = start + headerSize;
    const declaredEnd = bodyStart + view.getUint32(start + 4, true);
    const physicalEnd = Math.min(declaredEnd + 2, bytes.length);
    const file: Subfile = {
      index: id,
      start,
      headerSize,
      bodyStart,
      declaredEnd,
      bodyEnd: bodyStart,
      end: physicalEnd,
      profileVersion: view.getUint16(start + 2, true),
      safePrefix: true,
    };
    index.subfiles.push(file);
    if (
      headerSize >= 14 &&
      CrcCalculator.calculateCRC(bytes, start, start + headerSize) !== 0 &&
      view.getUint16(start + headerSize - 2, true) !== 0
    ) {
      issue(
        id,
        start,
        bodyStart,
        "header-crc",
        "The header checksum is incorrect.",
        "header",
      );
    }
    if (declaredEnd + 2 > bytes.length)
      issue(
        id,
        start + 4,
        start + 8,
        "file-short",
        `The header expects ${declaredEnd + 2 - start} bytes; only ${bytes.length - start} are available.`,
        "header",
      );
    let limit = declaredEnd <= bytes.length - 2 ? declaredEnd : bytes.length;
    const crc = new CrcCalculator();
    const crcEnd = Math.min(declaredEnd + 2, bytes.length);
    for (let p = start; p < crcEnd; p += 65536) {
      crc.addBytes(bytes, p, Math.min(p + 65536, crcEnd));
      await checkpoint(p);
    }
    const crcValid = declaredEnd + 2 <= bytes.length && crc.crc === 0;
    if (!crcValid)
      issue(
        id,
        Math.min(declaredEnd, bytes.length),
        physicalEnd,
        "file-crc",
        "The file checksum is missing or incorrect.",
        "crc",
      );
    // A trustworthy following header provides the boundary when a size field is damaged.
    if (
      !crcValid &&
      declaredEnd + 2 < bytes.length &&
      !headerAt(declaredEnd + 2)
    )
      limit = bytes.length - 2;
    const locals = new Map<number, Definition>();
    let timestamp: number | undefined;
    let cursor = bodyStart;
    let lastRecordEnd = bodyStart;
    while (cursor < limit) {
      await checkpoint(cursor);
      if (cursor > bodyStart && headerAt(cursor)) {
        if (await verifiedHeader(cursor)) {
          issue(
            id,
            start + 4,
            start + 8,
            "data-size",
            "The data size crosses into a following FIT file.",
            "header",
          );
          limit = cursor;
          file.end = cursor;
          break;
        }
      }
      const offset = cursor;
      const header = bytes[cursor++];
      const compressed = Boolean(header & 128);
      const local = compressed ? (header >> 5) & 3 : header & 15;
      try {
        if (!compressed && header & 64) {
          if (
            header & 16 ||
            cursor + 5 > limit ||
            bytes[cursor] !== 0 ||
            bytes[cursor + 1] > 1
          )
            throw new Error("Invalid or incomplete definition message.");
          const littleEndian = bytes[cursor + 1] === 0;
          const message = view.getUint16(cursor + 2, littleEndian);
          const count = bytes[cursor + 4];
          cursor += 5;
          if (cursor + count * 3 > limit)
            throw new Error("Incomplete field definitions.");
          const fields: WireField[] = [];
          const ids = new Set<number>();
          for (let i = 0; i < count; i++, cursor += 3) {
            const field = {
              id: bytes[cursor],
              size: bytes[cursor + 1],
              type: bytes[cursor + 2] & 31,
            };
            if (!field.size || !WIDTHS[field.type] || ids.has(field.id))
              throw new Error(
                "Invalid field type, size, or repeated field identifier.",
              );
            ids.add(field.id);
            fields.push(field);
          }
          if (header & 32) {
            if (cursor >= limit)
              throw new Error("Missing developer definition count.");
            const count = bytes[cursor++];
            if (cursor + count * 3 > limit)
              throw new Error("Incomplete developer definitions.");
            for (let i = 0; i < count; i++, cursor += 3) {
              if (!bytes[cursor + 1]) throw new Error("Empty developer field.");
              fields.push({
                id: bytes[cursor],
                size: bytes[cursor + 1],
                developer: bytes[cursor + 2],
                type: 13,
              });
            }
          }
          const definition: Definition = {
            message,
            local,
            littleEndian,
            fields,
            offset,
            end: cursor,
            subfile: id,
          };
          locals.set(local, definition);
          index.definitions.push(definition);
        } else {
          if (!compressed && header & 48)
            throw new Error("Reserved data header bits are set.");
          const definition = locals.get(local);
          if (!definition)
            throw new Error(
              `Data references undefined local message ${local}.`,
            );
          if (
            compressed &&
            (timestamp === undefined ||
              !definition.fields.some(
                (f) =>
                  f.id === 253 &&
                  f.developer === undefined &&
                  f.type === 6 &&
                  f.size === 4,
              ))
          )
            throw new Error(
              "Compressed timestamp has no valid timestamp base or definition.",
            );
          const size = definition.fields.reduce(
            (n, f) =>
              n +
              (compressed && f.id === 253 && f.developer === undefined
                ? 0
                : f.size),
            0,
          );
          if (cursor + size > limit)
            throw new Error("The last data message is incomplete.");
          const record: RecordRef = {
            definition,
            offset,
            end: cursor + size,
            subfile: id,
            compressed,
          };
          if (compressed) {
            const delta = header & 31;
            const previous = timestamp!;
            timestamp =
              Math.floor(previous / 32) * 32 +
              delta +
              (delta < previous % 32 ? 32 : 0);
            record.timestamp = timestamp;
          } else {
            let fieldOffset = cursor;
            for (const f of definition.fields) {
              if (
                f.id === 253 &&
                f.developer === undefined &&
                f.type === 6 &&
                f.size === 4
              ) {
                const t = view.getUint32(fieldOffset, definition.littleEndian);
                if (t !== 0xffffffff) {
                  timestamp = t;
                  record.timestamp = t;
                }
              }
              fieldOffset += f.size;
            }
          }
          const recordId = index.records.length;
          index.records.push(record);
          const group = index.messages.get(definition.message) ?? [];
          if (!index.messages.has(definition.message))
            index.messages.set(definition.message, group);
          group.push(recordId);
          if (definition.message === 0) {
            const data = rawRecord(index, record);
            file.manufacturer = numberValue(data["1"]);
            file.product = numberValue(data["2"]);
            file.type = numberValue(data["0"]);
          }
          cursor += size;
        }
        lastRecordEnd = cursor;
      } catch (error) {
        issue(
          id,
          offset,
          limit,
          "undecodable-tail",
          `${(error as Error).message} Recovery stopped at the last verified record.`,
          "tail",
        );
        for (
          let candidate = offset + 1;
          candidate + 12 <= bytes.length;
          candidate++
        ) {
          if (headerAt(candidate) && (await verifiedHeader(candidate))) {
            file.end = candidate;
            limit = candidate;
            break;
          }
          if (candidate % 65536 === 0) await checkpoint(candidate);
        }
        cursor = offset;
        break;
      }
    }
    file.bodyEnd = lastRecordEnd;
    if (file.bodyEnd !== declaredEnd)
      issue(
        id,
        start + 4,
        start + 8,
        "data-size",
        `Recovered ${file.bodyEnd - bodyStart} data bytes; the header declares ${declaredEnd - bodyStart}.`,
        "header",
      );
    if (file.end === limit && headerAt(limit)) start = limit;
    else if (declaredEnd + 2 <= bytes.length && headerAt(declaredEnd + 2))
      start = declaredEnd + 2;
    else {
      if (declaredEnd + 2 < bytes.length && crcValid)
        issue(
          id,
          declaredEnd + 2,
          bytes.length,
          "trailing-data",
          "Trailing bytes are outside the declared FIT file.",
          "tail",
        );
      break;
    }
  }
  job.progress(bytes.length, bytes.length, "Reading FIT");
  return index;
}
