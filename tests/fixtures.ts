import { CrcCalculator } from "@garmin/fitsdk";
import { writeScalar, WIDTHS } from "../src/protocol/binary";
import { wrapBody } from "../src/protocol/writer";
export type Field = [
  id: number,
  type: number,
  value: number | bigint | string | (number | bigint)[],
  size?: number,
];
export function definition(
  message: number,
  fields: Field[],
  local = 0,
  little = true,
  developers: [number, number, number][] = [],
): Uint8Array {
  const output = new Uint8Array(
    6 + fields.length * 3 + (developers.length ? 1 + developers.length * 3 : 0),
  );
  output[0] = 64 | local | (developers.length ? 32 : 0);
  output[2] = little ? 0 : 1;
  new DataView(output.buffer).setUint16(3, message, little);
  output[5] = fields.length;
  fields.forEach(([id, type, value, size], i) =>
    output.set(
      [
        id,
        size ??
          (type === 7
            ? new TextEncoder().encode(String(value)).length + 1
            : WIDTHS[type] * (Array.isArray(value) ? value.length : 1)),
        type | (WIDTHS[type] > 1 ? 128 : 0),
      ],
      6 + i * 3,
    ),
  );
  if (developers.length) {
    const offset = 6 + fields.length * 3;
    output[offset] = developers.length;
    developers.forEach((f, i) => output.set(f, offset + 1 + i * 3));
  }
  return output;
}
export function data(
  fields: Field[],
  local = 0,
  little = true,
  compressed?: number,
  developerBytes?: Uint8Array,
): Uint8Array {
  const selected =
    compressed === undefined ? fields : fields.filter(([id]) => id !== 253);
  const chunks: Uint8Array[] = [
    Uint8Array.of(
      compressed === undefined ? local : 128 | (local << 5) | (compressed & 31),
    ),
  ];
  for (const [, type, value, specified] of selected) {
    const values = Array.isArray(value) ? value : [value];
    const size =
      specified ??
      (type === 7
        ? new TextEncoder().encode(String(value)).length + 1
        : WIDTHS[type] * values.length);
    const bytes = new Uint8Array(size);
    const view = new DataView(bytes.buffer);
    if (type === 7)
      bytes.set(new TextEncoder().encode(String(value)).subarray(0, size));
    else
      values.forEach((v, i) => {
        writeScalar(view, i * WIDTHS[type], type, v as number | bigint);
        if (!little && WIDTHS[type] > 1)
          bytes.subarray(i * WIDTHS[type], (i + 1) * WIDTHS[type]).reverse();
      });
    chunks.push(bytes);
  }
  if (developerBytes) chunks.push(developerBytes);
  return join(chunks);
}
export function join(chunks: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}
export function file(
  messages: { message: number; fields: Field[]; little?: boolean }[],
  identity = true,
  product = 4586,
): Uint8Array {
  const all = identity
    ? [
        {
          message: 0,
          fields: [
            [0, 0, 2],
            [1, 4, 1],
            [2, 4, product],
          ] as Field[],
        },
        ...messages,
      ]
    : messages;
  return wrapBody(
    join(
      all.flatMap((m) => [
        definition(m.message, m.fields, 0, m.little),
        data(m.fields, 0, m.little),
      ]),
    ),
  );
}
export function activity(count = 180): Uint8Array {
  const timestamp = 1100000000;
  const identity: Field[] = [
    [0, 0, 4],
    [1, 4, 1],
    [2, 4, 4586],
  ];
  const sport: Field[] = [[0, 0, 1]];
  const fields: Field[] = [
    [253, 6, timestamp],
    [0, 5, 600000000],
    [1, 5, -900000000],
    [3, 2, 120],
    [6, 4, 2500],
    [5, 6, 0],
    [2, 4, 3000],
  ];
  const header = join([
    definition(0, identity, 1),
    data(identity, 1),
    definition(12, sport, 2),
    data(sport, 2),
    definition(20, fields),
  ]);
  const recordSize = data(fields).length;
  const body = new Uint8Array(header.length + count * recordSize);
  body.set(header);
  const view = new DataView(body.buffer);
  for (let i = 0, p = header.length; i < count; i++, p += recordSize) {
    body[p] = 0;
    view.setUint32(p + 1, timestamp + i, true);
    view.setInt32(p + 5, 600000000 + i * 25, true);
    view.setInt32(p + 9, -900000000 + i * 15, true);
    body[p + 13] = 120 + (i % 30);
    view.setUint16(p + 14, 2500 + (i % 200), true);
    view.setUint32(p + 16, i * 250, true);
    view.setUint16(p + 20, 3000 + (i % 100), true);
  }
  return wrapBody(body);
}
export function checksum(bytes: Uint8Array): void {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(
    bytes.length - 2,
    CrcCalculator.calculateCRC(bytes, 0, bytes.length - 2),
    true,
  );
}

export function uiActivity(): Uint8Array {
  const timestamp = Date.parse("2026-01-01T12:00:00Z") / 1000 - 631065600;
  const all: { message: number; fields: Field[] }[] = [
    {
      message: 0,
      fields: [
        [0, 0, 4],
        [1, 4, 255],
        [2, 4, 1],
      ],
    },
    { message: 12, fields: [[0, 0, 1]] },
  ];
  for (let i = 0; i < 180; i++) {
    const angle = (i * Math.PI * 2) / 180;
    const lat = Math.round(
      ((51.505 + Math.sin(angle) * 0.001) * 2147483648) / 180,
    );
    const lon = Math.round(
      ((-0.09 + Math.cos(angle) * 0.0015) * 2147483648) / 180,
    );
    all.push({
      message: 20,
      fields: [
        [253, 6, timestamp + i],
        [0, 5, lat],
        [1, 5, lon],
        [3, 2, 120 + (i % 30)],
        [4, 2, 80 + (i % 10)],
        [5, 6, i * 350],
        [6, 4, 3500 + (i % 200)],
        [2, 4, 3000 + (i % 50)],
      ],
    });
  }
  all.push(
    {
      message: 19,
      fields: [
        [254, 4, 0],
        [2, 6, timestamp],
        [253, 6, timestamp + 89],
        [25, 0, 1],
      ],
    },
    {
      message: 19,
      fields: [
        [254, 4, 1],
        [2, 6, timestamp + 90],
        [253, 6, timestamp + 179],
        [25, 0, 1],
      ],
    },
    {
      message: 18,
      fields: [
        [254, 4, 0],
        [2, 6, timestamp],
        [253, 6, timestamp + 179],
        [5, 0, 1],
        [25, 4, 0],
        [26, 4, 2],
      ],
    },
    {
      message: 34,
      fields: [
        [253, 6, timestamp + 179],
        [1, 4, 1],
      ],
    },
    { message: 78, fields: [[0, 8, [0.8, 0.9, 1]]] },
    { message: 64000, fields: [[7, 6, 42]] },
  );
  return file(all, false);
}
