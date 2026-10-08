import { Profile } from "@garmin/fitsdk";
import reference from "./garmin-reference.json";
import { TYPE_NAMES, WIDTHS } from "../protocol/binary";

interface ReferenceField {
  name: string;
  type: string;
  units?: string;
  scale?: number;
  offset?: number;
  array?: boolean;
  variants?: (ReferenceField & { when: { field: string; value: string }[] })[];
}
interface ReferenceMessage {
  id?: number;
  fields: Record<string, ReferenceField>;
}
export interface GarminField {
  fieldName: string;
  baseType: number;
  fieldSize: number;
  type: string;
  units?: string;
  scale?: number;
  offset?: number;
  array?: boolean;
  values?: Record<string, string>;
  bitmask?: boolean;
  description: string;
  variants?: { field: GarminField; when: { id: number; value: number }[] }[];
}

const camel = (name: string) =>
  name.replace(/[_-]([a-z])/g, (_, c: string) => c.toUpperCase());
const label = (name: string) =>
  camel(name)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
const types = new Map(
  Object.entries(reference.types).map(([name, data]) => [
    camel(name),
    {
      ...data,
      values: Object.fromEntries(
        Object.entries(data.values).map(([id, value]) => [id, camel(value)]),
      ),
    },
  ]),
);
const baseTypes = new Map<string, string>(
  TYPE_NAMES.map((name) => [name, name]),
);
for (const message of Object.values(Profile.messages))
  for (const field of Object.values(message.fields)) {
    baseTypes.set(field.type, field.baseType);
    for (const subfield of field.subFields)
      baseTypes.set(subfield.type, subfield.baseType);
  }
for (const [name, type] of types) baseTypes.set(name, type.base);
baseTypes.set("antChannelId", "uint32z");
baseTypes.set("dateTime", "uint32");
baseTypes.set("localDateTime", "uint32");
baseTypes.set("deviceIndex", "uint8");

const messageIds = new Map(
  Object.entries(Profile.messages).map(([id, message]) => [
    message.name,
    Number(id),
  ]),
);
for (const [id, name] of Object.entries(reference.types.mesg_num.values))
  messageIds.set(camel(name), Number(id));

const flags = new Set(["alarmRepeat", "avoidances", "gpsMode"]);
export function garminValues(type: string): Record<string, string> | undefined {
  return types.get(type)?.values;
}

const fieldLabels: Record<string, string> = {
  vo2Max: "VO2 Max",
  firstVo2Max: "First VO2 Max",
  maxHr: "Max Heart Rate",
  lthr: "Lactate Threshold Heart Rate",
  ltpower: "Lactate Threshold Power",
  ltspeed: "Lactate Threshold Speed",
  ecgTimestamp: "ECG Timestamp",
};
function compileField(source: ReferenceField): GarminField {
  const type = camel(source.type);
  const baseType = TYPE_NAMES.indexOf(baseTypes.get(type) ?? "");
  if (baseType < 0)
    throw new Error(`Unsupported supplemental FIT type: ${source.type}`);
  return {
    fieldName: fieldLabels[camel(source.name)] ?? label(source.name),
    baseType,
    fieldSize: WIDTHS[baseType],
    type,
    units:
      source.name === "elevation" && source.units === "m/s"
        ? "m"
        : source.units,
    scale: source.scale,
    offset: source.offset,
    array: source.array,
    values: { ...garminValues(type), ...Profile.types[type] },
    bitmask: flags.has(type),
    description:
      "Community-documented Garmin field; not in the public FIT SDK profile. Interpretation requires a matching Garmin wire layout.",
  };
}

export const garminExtensions: Partial<
  Record<number, { name: string; fields: Partial<Record<number, GarminField>> }>
> = {};
for (const [name, source] of Object.entries(reference.messages) as [
  string,
  ReferenceMessage,
][]) {
  const id = source.id ?? messageIds.get(camel(name));
  if (id === undefined)
    throw new Error(`Missing supplemental FIT message number: ${name}`);
  const fields: Partial<Record<number, GarminField>> = {};
  for (const [number, info] of Object.entries(source.fields)) {
    if (Profile.messages[id]?.fields[Number(number)]) continue;
    const field = compileField(info);
    if (id === 22) field.fieldName += " Device";
    field.variants = info.variants?.flatMap((variant) => {
      const when = variant.when.flatMap((condition) => {
        const controller = Object.entries(source.fields).find(
          ([, f]) => f.name === condition.field,
        );
        const official = Object.values(Profile.messages[id]?.fields ?? {}).find(
          (f) => f.name === camel(condition.field),
        );
        const controllerId = controller ? Number(controller[0]) : official?.num;
        const type = controller
          ? camel(controller[1].type)
          : (official?.type ?? "");
        const values: Record<string, string> = {
          ...garminValues(type),
          ...Profile.types[type],
        };
        const value = Object.entries(values).find(
          ([, v]) => camel(v) === camel(condition.value),
        )?.[0];
        if (controllerId === undefined || value === undefined) return [];
        return [{ id: controllerId, value: Number(value) }];
      });
      // Some community variants refer to a controller with no documented field ID.
      return when.length === variant.when.length
        ? [{ field: compileField(variant), when }]
        : [];
    });
    fields[Number(number)] = field;
  }
  if (!Object.keys(fields).length) continue;
  if (!Profile.messages[id])
    fields[253] ??= compileField({ name: "timestamp", type: "date_time" });
  const names: Record<number, string> = {
    141: "EPO Status",
    394: "CPE Status",
    326: "GPS Event",
    336: "ECG Summary",
    337: "ECG Raw Sample",
    338: "ECG Smooth Sample",
    170: "Connect IQ Field",
    309: "MTB CX",
  };
  garminExtensions[id] = { name: names[id] ?? label(name), fields };
}
