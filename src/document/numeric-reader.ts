import type {
  Cell,
  Definition,
  RawValue,
  RecordRef,
  WireField,
} from "../model";
import { fieldKey, readValue, valid, WIDTHS } from "../protocol/binary";
import type { FitDocument } from "./document";

type ReadField = (record: RecordRef) => Cell;
interface Plan {
  fields: (ReadField | undefined)[];
  fallback: Set<string>;
}

/** Compile fixed numeric layouts once; record-dependent metadata uses the full decoder. */
export class NumericReader {
  private plans = new WeakMap<Definition, Map<boolean, Plan>>();
  private keys: string[];
  constructor(
    private document: FitDocument,
    keys: Iterable<string>,
    private developer: boolean,
  ) {
    this.keys = [...keys];
  }

  read(id: number): (Cell | undefined)[] {
    const record = this.document.index.records[id];
    let modes = this.plans.get(record.definition);
    if (!modes) this.plans.set(record.definition, (modes = new Map()));
    let plan = modes.get(record.compressed);
    if (!plan) {
      const locations = new Map<string, { wire: WireField; offset: number }>();
      let offset = 1;
      for (const wire of record.definition.fields) {
        if (
          record.compressed &&
          wire.id === 253 &&
          wire.developer === undefined
        )
          continue;
        locations.set(fieldKey(wire), { wire, offset });
        offset += wire.size;
      }
      const fallback = new Set<string>();
      const fields = this.keys.map((key): ReadField | undefined => {
        const location = locations.get(key);
        if (!location && !this.developer) {
          const component = this.component(record, key, locations);
          if (component) return component;
        }
        const fixed =
          location && this.document.metadata.staticField(record, location.wire);
        if (
          !location ||
          !fixed ||
          location.wire.type === 7 ||
          location.wire.type >= 14 ||
          fixed.info.bitmask ||
          Object.keys(fixed.info.values ?? {}).length ||
          ["dateTime", "localDateTime"].includes(fixed.info.type) ||
          (!this.developer &&
            key === "3" &&
            record.definition.message === 20 &&
            this.document.mergedHr.size)
        ) {
          fallback.add(key);
          return;
        }
        const { wire, offset } = location;
        const { info, array } = fixed;
        const convert = (value: RawValue): number | null =>
          typeof value === "number" && valid(value, wire.type)
            ? info.semicircles
              ? (value * 180) / 2147483648
              : value / (info.scale || 1) - (info.offset ?? 0)
            : null;
        return (record) => {
          const segment = this.document.index.bytes.segment(record.offset);
          let raw = readValue(
            segment.view,
            record.offset - segment.start + offset,
            wire,
            record.definition.littleEndian,
          );
          if (array && !Array.isArray(raw)) raw = [raw];
          return {
            raw,
            value: Array.isArray(raw) ? raw.map(convert) : convert(raw),
            numeric: true,
          };
        };
      });
      plan = { fields, fallback };
      modes.set(record.compressed, plan);
    }
    if (
      !this.developer &&
      (this.document.memo.has(id) || this.document.components.has(id))
    ) {
      const cells = this.document.cells(id, true, new Set(this.keys));
      return this.keys.map((key) => cells[key]);
    }
    const fallback = plan.fallback.size
      ? this.document.cells(id, !this.developer, plan.fallback)
      : undefined;
    return plan.fields.map((read, i) =>
      read ? read(record) : fallback?.[this.keys[i]],
    );
  }

  private component(
    record: RecordRef,
    key: string,
    locations: Map<string, { wire: WireField; offset: number }>,
  ): ReadField | undefined {
    const profile = Profile.messages[record.definition.message];
    const target = profile?.fields[Number(key)];
    if (!target || target.array || target.isAccumulated) return;
    const type = [
      "enum",
      "sint8",
      "uint8",
      "sint16",
      "uint16",
      "sint32",
      "uint32",
    ].indexOf(target.baseType);
    if (type < 0) return;
    const wire = { id: Number(key), type, size: WIDTHS[type] };
    const fixed = this.document.metadata.staticField(record, wire);
    if (
      !fixed ||
      fixed.info.bitmask ||
      Object.keys(fixed.info.values ?? {}).length ||
      ["dateTime", "localDateTime"].includes(fixed.info.type)
    )
      return;
    const parents = [...locations.values()].filter(
      ({ wire }) =>
        wire.developer === undefined &&
        profile.fields[wire.id]?.components?.some((id) => String(id) === key),
    );
    if (parents.length !== 1) return;
    const parent = parents[0];
    const source = profile.fields[parent.wire.id];
    // Whole-width unsigned scalar aliases (e.g. enhanced altitude/speed) need
    // no bit packing. Packed, accumulated and multi-component fields fall back.
    if (
      !source.hasComponents ||
      source.components.length !== 1 ||
      ![0, 2, 4, 6, 10, 11, 12].includes(parent.wire.type) ||
      parent.wire.size !== WIDTHS[parent.wire.type] ||
      source.bits[0] !== parent.wire.size * 8
    )
      return;
    const scale =
      (Array.isArray(source.scale) ? source.scale[0] : source.scale) || 1;
    const offset =
      (Array.isArray(source.offset) ? source.offset[0] : source.offset) || 0;
    const targetScale =
      (Array.isArray(target.scale) ? target.scale[0] : target.scale) || 1;
    const targetOffset =
      (Array.isArray(target.offset) ? target.offset[0] : target.offset) || 0;
    return (record) => {
      const segment = this.document.index.bytes.segment(record.offset);
      const raw = readValue(
        segment.view,
        record.offset - segment.start + parent.offset,
        parent.wire,
        record.definition.littleEndian,
      ) as number;
      const expanded = (raw / scale - offset + targetOffset) * targetScale;
      return this.document.metadata.cell(record, wire, expanded, fixed.info);
    };
  }
}
import { Profile } from "@garmin/fitsdk";
