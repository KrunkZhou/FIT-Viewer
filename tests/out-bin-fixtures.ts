/**
 * Independently encoded counterpart of Clover's generated OUT.BIN regression
 * fixture in CloverGarmin.RegressionTests/GarminGlanceTests.cs (OutputBody,
 * WrapOutput and OutEntry). This is synthetic test data, not a device export.
 */
export const OUT_BIN_APP_ID = "00112233445566778899aabbccddeeff";
export const OUT_BIN_WIDGET_ID = "c0ffee15600d0000000000000002002e";
export const OUT_BIN_OTHER_WIDGET_ID = "c0ffee15600d00000000000000020033";
export const OUT_BIN_ADDED_ID = "ffeeddccbbaa99887766554433221100";

export const concatBytes = (...parts: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
};

export const encodeVarint = (value: bigint | number): Uint8Array => {
  let remaining = BigInt(value);
  if (remaining < 0n) throw new Error("Fixture varints must be unsigned.");
  const bytes: number[] = [];
  do {
    const part = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(part | (remaining ? 128 : 0));
  } while (remaining);
  return Uint8Array.from(bytes);
};

export const numberField = (
  number: number,
  value: bigint | number,
): Uint8Array =>
  concatBytes(encodeVarint(BigInt(number) << 3n), encodeVarint(value));

export const bytesField = (number: number, value: Uint8Array): Uint8Array =>
  concatBytes(
    encodeVarint((BigInt(number) << 3n) | 2n),
    encodeVarint(value.length),
    value,
  );

export const textField = (number: number, value: string): Uint8Array =>
  bytesField(number, new TextEncoder().encode(value));

export const fixtureId = (hex: string): Uint8Array =>
  Uint8Array.from(Buffer.from(hex, "hex"));

export const appFields = (
  id = OUT_BIN_APP_ID,
  appType = 1,
  name = "Regression recorder",
  disabled = false,
): Uint8Array =>
  concatBytes(
    bytesField(1, fixtureId(id)),
    numberField(2, appType),
    textField(3, name),
    numberField(4, disabled ? 1 : 0),
  );

export const appField = (
  id = OUT_BIN_APP_ID,
  appType = 1,
  name = "Regression recorder",
  disabled = false,
  favorite?: boolean,
  nativeType?: number,
): Uint8Array =>
  bytesField(
    3,
    concatBytes(
      appFields(id, appType, name, disabled),
      numberField(5, 42),
      textField(6, appType === 1 ? "REGRESSION.PRG" : ""),
      numberField(7, 1_234_567_890_123n),
      ...(nativeType === undefined ? [] : [numberField(8, nativeType)]),
      ...(favorite === undefined ? [] : [numberField(9, favorite ? 1 : 0)]),
    ),
  );

export const wrapInventory = (
  entries: Uint8Array,
  metadata: bigint = 9_876_543_210n,
  status = 17,
): Uint8Array =>
  bytesField(
    3,
    bytesField(
      2,
      concatBytes(numberField(1, metadata), numberField(2, status), entries),
    ),
  );

export const outBinFixture = (): Uint8Array =>
  wrapInventory(
    concatBytes(
      appField(OUT_BIN_APP_ID, 1, "Regression recorder", false, true),
      appField(OUT_BIN_WIDGET_ID, 2, "Heart Rate", false, false, 46),
      appField(OUT_BIN_OTHER_WIDGET_ID, 2, "Sleep Score", true, undefined, 51),
      appField(OUT_BIN_WIDGET_ID, 3, "Shared UUID watch face", false, true),
      appField(OUT_BIN_ADDED_ID, 99, "Unknown future type", false),
    ),
  );
