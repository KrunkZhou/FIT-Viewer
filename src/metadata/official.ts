import { Profile } from "@garmin/fitsdk";
import type { Definition, RawValue, WireField } from "../model";
import { TYPE_NAMES, WIDTHS } from "../protocol/binary";

export function activeField(
  message: number,
  id: number,
  raw: Record<string, RawValue>,
) {
  const profile = Profile.messages[message];
  const field = profile?.fields[id];
  return (
    field?.subFields.find((sub) =>
      sub.map.some((condition) => {
        const controller = Object.values(profile.fields).find(
          (candidate) => candidate.name === condition.name,
        );
        return controller && raw[String(controller.num)] === condition.value;
      }),
    ) ?? field
  );
}

export function componentKeys(
  definition: Definition,
  raw: Record<string, RawValue> = {},
): Set<string> {
  const keys = new Set<string>();
  for (const wire of definition.fields) {
    if (wire.developer !== undefined) continue;
    const field = activeField(definition.message, wire.id, raw);
    if (!field?.hasComponents) continue;
    let bits = 0;
    field.components.forEach((key, index) => {
      bits += field.bits[index] ?? wire.size * 8 + 1;
      if (bits <= wire.size * 8) keys.add(String(key));
    });
  }
  return keys;
}

export function componentWire(
  message: number,
  id: number,
): WireField | undefined {
  const field = Profile.messages[message]?.fields[id];
  if (!field) return;
  const type = Math.max(0, TYPE_NAMES.indexOf(field.baseType));
  return { id, type, size: WIDTHS[type] };
}
