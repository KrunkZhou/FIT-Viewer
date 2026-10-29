import type { Definition, FieldInfo, RawValue, WireField } from "../model";
import type { FitDocument } from "../document/document";
import { NumericReader } from "../document/numeric-reader";
import { componentWire } from "../metadata/official";
import { fieldKey } from "../protocol/binary";

interface Column {
  wire?: WireField;
  fixed?: FieldInfo;
  fallback: FieldInfo;
}

/** Fixed layouts share a read plan; dynamic fields retain per-record metadata. */
export class CsvRows {
  private reader: NumericReader;
  private plans = new WeakMap<Definition, Column[]>();
  constructor(
    private document: FitDocument,
    private fields: FieldInfo[],
    private developer: boolean,
  ) {
    this.reader = new NumericReader(
      document,
      fields.map((field) => field.key),
      developer,
    );
  }

  read(id: number): { value: RawValue; info: FieldInfo }[] {
    const record = this.document.index.records[id];
    let plan = this.plans.get(record.definition);
    if (!plan) {
      const wires = new Map(
        record.definition.fields.map((wire) => [fieldKey(wire), wire]),
      );
      plan = this.fields.map((field) => {
        const wire =
          wires.get(field.key) ??
          (!field.developer
            ? componentWire(record.definition.message, field.id)
            : undefined);
        return {
          wire,
          fixed: wire
            ? this.document.metadata.staticField(record, wire)?.info
            : undefined,
          fallback: field,
        };
      });
      this.plans.set(record.definition, plan);
    }
    const cells = this.reader.read(id);
    let raw: Record<string, RawValue> | undefined;
    return plan.map((column, index) => {
      const info =
        column.fixed ??
        (column.wire
          ? this.document.metadata.field(
              record,
              column.wire,
              (raw ??= this.document.raw(id)),
            )
          : column.fallback);
      return {
        value: cells[index]?.[this.developer ? "raw" : "value"] ?? null,
        info,
      };
    });
  }
}
