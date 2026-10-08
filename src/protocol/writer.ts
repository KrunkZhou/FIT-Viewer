import { CrcCalculator, Profile } from "@garmin/fitsdk";
import { TYPE_NAMES, WIDTHS, writeScalar } from "./binary";
import type { Job } from "../model";

export function encodeMessage(
  message: number,
  values: Record<string, number | bigint>,
): Uint8Array {
  const fields = Object.entries(values).map(([name, value]) => {
    const profile = Object.values(Profile.messages[message]?.fields ?? {}).find(
      (f) => f.name === name,
    );
    if (!profile) throw new Error(`Unknown official field ${message}:${name}`);
    const type = TYPE_NAMES.indexOf(profile.baseType);
    return { id: profile.num, type, size: WIDTHS[type], value };
  });
  const definitionSize = 6 + fields.length * 3;
  const result = new Uint8Array(
    definitionSize + 1 + fields.reduce((n, f) => n + f.size, 0),
  );
  const view = new DataView(result.buffer);
  result[0] = 0x4f;
  view.setUint16(3, message, true);
  result[5] = fields.length;
  let cursor = definitionSize + 1;
  result[definitionSize] = 15;
  fields.forEach((field, i) => {
    result.set(
      [field.id, field.size, field.type | (field.size > 1 ? 128 : 0)],
      6 + i * 3,
    );
    writeScalar(view, cursor, field.type, field.value);
    cursor += field.size;
  });
  return result;
}

export function wrapBody(
  body: Uint8Array,
  originalHeader?: Uint8Array,
): Uint8Array {
  const header = originalHeader ? originalHeader.slice() : new Uint8Array(14);
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  if (!originalHeader) {
    header[0] = 14;
    header[1] = 0x20;
    view.setUint16(
      2,
      Profile.version.major * 1000 + Profile.version.minor,
      true,
    );
    header.set([46, 70, 73, 84], 8);
  }
  view.setUint32(4, body.length, true);
  if (header.length >= 14)
    view.setUint16(
      header.length - 2,
      CrcCalculator.calculateCRC(header, 0, header.length - 2),
      true,
    );
  const output = new Uint8Array(header.length + body.length + 2);
  output.set(header);
  output.set(body, header.length);
  new DataView(output.buffer).setUint16(
    output.length - 2,
    CrcCalculator.calculateCRC(output, 0, output.length - 2),
    true,
  );
  return output;
}

export async function wrapBodyCooperative(
  body: Uint8Array,
  originalHeader: Uint8Array,
  job: Job,
): Promise<Uint8Array> {
  const header = originalHeader.slice();
  const view = new DataView(
    header.buffer,
    header.byteOffset,
    header.byteLength,
  );
  view.setUint32(4, body.length, true);
  if (header.length >= 14)
    view.setUint16(
      header.length - 2,
      CrcCalculator.calculateCRC(header, 0, header.length - 2),
      true,
    );
  const output = new Uint8Array(header.length + body.length + 2);
  output.set(header);
  output.set(body, header.length);
  const crc = new CrcCalculator();
  for (let offset = 0; offset < output.length - 2; offset += 65536) {
    crc.addBytes(output, offset, Math.min(offset + 65536, output.length - 2));
    await job.yield();
  }
  new DataView(output.buffer).setUint16(output.length - 2, crc.crc, true);
  return output;
}
