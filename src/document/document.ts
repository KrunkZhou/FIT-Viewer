import { Profile } from "@garmin/fitsdk";
import type {
  Cell,
  Definition,
  DocumentSummary,
  FieldInfo,
  Job,
  MessageInfo,
  RawValue,
  RecordRef,
  SingleEntryView,
  TablePage,
  TableQuery,
  WireField,
} from "../model";
import { Metadata, words } from "../metadata/profile";
import { fieldKey, numberValue, valid, WIDTHS } from "../protocol/binary";
import { type FitIndex, idleJob, readFit } from "../protocol/reader";
import { expandComponents } from "./components";
import { positionCoordinates, positionFields } from "./positions";
import hrUtility from "@garmin/fitsdk/src/utils-hr-mesg.js";

export class FitDocument {
  readonly metadata: Metadata;
  readonly fields = new Map<number, FieldInfo[]>();
  readonly messageInfo: MessageInfo[];
  readonly components = new Map<number, Record<string, RawValue>>();
  readonly mergedHr = new Map<number, number>();
  readonly memo = new Map<number, Record<string, string>>();
  private filterCache = new Map<string, number[]>();
  private optionCache = new Map<string, Record<string, string[]>>();
  private gpsPoints = 0;
  private hasMap = false;
  private startTimestamp?: number;
  private endTimestamp?: number;
  private sports = new Set<string>();
  private constructor(
    readonly index: FitIndex,
    readonly filename: string,
  ) {
    this.metadata = new Metadata(index);
    this.messageInfo = Array.from(index.messages, ([id, records]) => ({
      id,
      count: records.length,
      name: this.metadata.messageName(id),
      known:
        Boolean(Profile.messages[id]) ||
        !this.metadata.messageName(id).startsWith("Message "),
    }));
  }
  static async open(
    bytes: Uint8Array,
    filename: string,
    job = idleJob(),
  ): Promise<FitDocument> {
    const document = new FitDocument(await readFit(bytes, job), filename);
    await document.buildDerived(job);
    return document;
  }
  summary(): DocumentSummary {
    return {
      filename: this.filename,
      bytes: this.index.bytes.length,
      records: this.index.records.length,
      gpsPoints: this.gpsPoints,
      startTimestamp: this.startTimestamp,
      endTimestamp: this.endTimestamp,
      sports: [...this.sports],
      fileTypes: [
        ...new Set(
          this.index.subfiles.map((file) =>
            words(
              Profile.types.file[file.type ?? -1] ?? String(file.type ?? "-"),
            ),
          ),
        ),
      ],
      messages: this.messageInfo,
      subfiles: this.index.subfiles,
      diagnostics: this.index.diagnostics.slice(0, 50),
      diagnosticCount: this.index.diagnostics.length,
      hasMap: this.hasMap,
      hasCharts: this.index.records.length > 0,
      hasHrv: this.index.messages.has(78) || this.index.messages.has(132),
      repairable: this.index.diagnostics.some((d) => d.repair !== "none"),
    };
  }
  raw(id: number): Record<string, RawValue> {
    return this.metadata.raw(this.index.records[id]);
  }
  cells(id: number, derived = true): Record<string, Cell> {
    const record = this.index.records[id];
    const raw = this.raw(id);
    const result: Record<string, Cell> = {};
    for (const wire of record.definition.fields) {
      const info = this.metadata.field(record, wire, raw);
      result[fieldKey(wire)] = this.metadata.cell(
        record,
        wire,
        raw[fieldKey(wire)] ?? null,
        info,
      );
    }
    if (derived) {
      for (const [key, value] of Object.entries({
        ...expandComponents(record, raw),
        ...this.components.get(id),
      })) {
        if (result[key]?.value !== null && result[key] !== undefined) continue;
        const profile =
          Profile.messages[record.definition.message]?.fields[Number(key)];
        if (!profile) continue;
        const type = Math.max(
          0,
          [
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
          ].indexOf(profile.baseType),
        );
        const wire = { id: Number(key), type, size: WIDTHS[type] };
        const info = this.metadata.field(record, wire, raw);
        result[key] = this.metadata.cell(record, wire, value, info);
      }
      if (
        record.definition.message === 20 &&
        (result["3"]?.value === null || !result["3"]) &&
        this.mergedHr.has(id)
      )
        result["3"] = {
          raw: result["3"]?.raw ?? null,
          value: this.mergedHr.get(id)!,
          numeric: true,
        };
      for (const [key, value] of Object.entries(this.memo.get(id) ?? {}))
        result[key] = { raw: raw[key] ?? null, value, numeric: false };
    }
    return result;
  }
  getFields(message: number, developer: boolean): FieldInfo[] {
    let fields = this.fields.get(message);
    if (!fields) {
      const found = new Map<string, FieldInfo>();
      const visited = new Set<DefinitionIdentity>();
      for (const id of this.index.messages.get(message) ?? []) {
        const record = this.index.records[id];
        if (visited.has(record.definition)) continue;
        visited.add(record.definition);
        const raw = this.raw(id);
        for (const field of record.definition.fields) {
          const info = this.metadata.field(record, field, raw);
          if (
            !found.has(info.key) ||
            (found.get(info.key)?.unknown && !info.unknown)
          )
            found.set(info.key, info);
        }
        for (const key of Object.keys({
          ...expandComponents(record, raw),
          ...this.components.get(id),
        })) {
          const profile = Profile.messages[message]?.fields[Number(key)];
          if (profile && !found.has(key))
            found.set(
              key,
              this.metadata.field(
                record,
                {
                  id: Number(key),
                  type: Math.max(
                    0,
                    [
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
                    ].indexOf(profile.baseType),
                  ),
                  size: 1,
                },
                raw,
              ),
            );
        }
      }
      if (message === 20 && this.mergedHr.size && !found.has("3"))
        found.set("3", {
          key: "3",
          id: 3,
          name: "Heart rate",
          units: "bpm",
          type: "uint8",
          unknown: false,
          developer: false,
        });
      fields = Array.from(found.values()).sort((a, b) =>
        a.id === 253
          ? -1
          : b.id === 253
            ? 1
            : Number(a.developer) - Number(b.developer) || a.id - b.id,
      );
      this.fields.set(message, fields);
    }
    return developer ? fields : fields.filter((f) => !f.unknown);
  }
  async table(query: TableQuery, job = idleJob()): Promise<TablePage> {
    const fields = this.getFields(query.message, query.developer);
    const source = this.index.messages.get(query.message) ?? [];
    const filters = Object.entries(query.filters ?? {}).filter(
      ([, values]) => values.length,
    );
    const cacheKey = JSON.stringify([query.message, query.developer, filters]);
    let filtered = this.filterCache.get(cacheKey);
    if (!filtered) {
      if (!filters.length) filtered = source;
      else {
        filtered = [];
        for (let i = 0; i < source.length; i++) {
          const cells = this.cells(source[i], !query.developer);
          if (
            filters.every(([key, values]) =>
              values.includes(
                printValue(
                  cells[key]?.[query.developer ? "raw" : "value"] ?? null,
                ),
              ),
            )
          )
            filtered.push(source[i]);
          if (i % 512 === 0) await job.yield();
        }
      }
      if (this.filterCache.size >= 12)
        this.filterCache.delete(this.filterCache.keys().next().value!);
      this.filterCache.set(cacheKey, filtered);
    }
    const size = Math.min(1000, Math.max(1, Math.trunc(query.size) || 20));
    const pages = Math.max(1, Math.ceil(filtered.length / size));
    let page = Math.min(pages - 1, Math.max(0, Math.trunc(query.page) || 0));
    let selected: number | undefined;
    if (query.timestamp !== undefined || query.target !== undefined) {
      let bestDistance = Infinity;
      for (let i = 0; i < filtered.length; i++) {
        const record = this.index.records[filtered[i]];
        const distance =
          query.target !== undefined
            ? Math.abs(filtered[i] - query.target)
            : record.timestamp === undefined
              ? Infinity
              : Math.abs(record.timestamp - query.timestamp!);
        if (distance < bestDistance) {
          bestDistance = distance;
          selected = filtered[i];
          page = Math.floor(i / size);
        }
        if (i % 4096 === 0) await job.yield();
      }
    }
    const optionKey = `${query.message}:${query.developer}`;
    let options = this.optionCache.get(optionKey);
    if (!options) {
      options = {};
      const enums = fields.filter(
        (f) => Object.keys(f.values ?? {}).length && !f.bitmask,
      );
      const sets = new Map(enums.map((f) => [f.key, new Set<string>()]));
      if (enums.length)
        for (let i = 0; i < source.length; i++) {
          const cells = this.cells(source[i], !query.developer);
          for (const f of enums)
            sets
              .get(f.key)!
              .add(
                printValue(
                  cells[f.key]?.[query.developer ? "raw" : "value"] ?? null,
                ),
              );
          if (i % 512 === 0) await job.yield();
        }
      for (const [key, values] of sets)
        options[key] = Array.from(values).sort();
      this.optionCache.set(optionKey, options);
    }
    return {
      message: this.messageInfo.find((m) => m.id === query.message) ?? {
        id: query.message,
        name: `Message ${query.message}`,
        count: 0,
        known: false,
      },
      fields,
      rows: filtered.slice(page * size, (page + 1) * size).map((id) => ({
        index: id,
        offset: this.index.records[id].offset,
        subfile: this.index.records[id].subfile,
        cells: this.cells(id, !query.developer),
      })),
      total: filtered.length,
      page,
      size,
      selected,
      options,
    };
  }
  async singletons(
    developer: boolean,
    job = idleJob(),
  ): Promise<SingleEntryView> {
    const entries: SingleEntryView["entries"] = [];
    for (const message of this.messageInfo) {
      if (message.count !== 1 || !message.known) continue;
      const id = this.index.messages.get(message.id)![0];
      const record = this.index.records[id];
      entries.push({
        message,
        fields: this.getFields(message.id, developer),
        row: {
          index: id,
          offset: record.offset,
          subfile: record.subfile,
          cells: this.cells(id, !developer),
        },
      });
      await job.yield();
    }
    return { entries };
  }
  private async buildDerived(job: Job): Promise<void> {
    const positions = new Map<
      Definition,
      { latitude: WireField; longitude: WireField }
    >();
    for (const definition of this.index.definitions) {
      const fields = positionFields(definition.message);
      if (!fields) continue;
      const latitude = definition.fields.find(
        (field) =>
          field.developer === undefined && field.id === fields.latitude,
      );
      const longitude = definition.fields.find(
        (field) =>
          field.developer === undefined && field.id === fields.longitude,
      );
      if (latitude && longitude)
        positions.set(definition, { latitude, longitude });
    }
    const accumulators = new Map<string, number>();
    let previous: RecordRef | undefined;
    let previousLat: number | undefined;
    let previousLon: number | undefined;
    const hrMessages = new Map<
      number,
      {
        timestamp?: number;
        fractionalTimestamp?: number;
        filteredBpm: number[];
        eventTimestamp: number[];
      }[]
    >();
    for (let id = 0; id < this.index.records.length; id++) {
      const record = this.index.records[id];
      const raw = this.raw(id);
      const position = !this.hasMap && positions.get(record.definition);
      if (position) {
        const coordinate = (wire: WireField) =>
          this.metadata.cell(
            record,
            wire,
            raw[String(wire.id)] ?? null,
            this.metadata.field(record, wire, raw),
          ).value;
        this.hasMap = Boolean(
          positionCoordinates(
            coordinate(position.latitude),
            coordinate(position.longitude),
          ),
        );
      }
      const sportField =
        record.definition.message === 12
          ? "0"
          : record.definition.message === 18
            ? "5"
            : record.definition.message === 19
              ? "25"
              : undefined;
      if (sportField) {
        const sport = this.cells(id, false)[sportField]?.value;
        if (typeof sport === "string" || typeof sport === "number")
          this.sports.add(String(sport));
      }
      const profile = Profile.messages[record.definition.message];
      const extra: Record<string, RawValue> = {};
      for (const field of record.definition.fields) {
        if (field.developer !== undefined) continue;
        const definition = profile?.fields[field.id];
        const value = raw[String(field.id)];
        if (
          definition?.isAccumulated &&
          typeof value === "number" &&
          valid(value, field.type)
        )
          accumulators.set(
            `${record.subfile}:${record.definition.message}:${field.id}`,
            value,
          );
      }
      Object.assign(extra, expandComponents(record, raw, accumulators));
      if (Object.keys(extra).length) this.components.set(id, extra);
      if (record.definition.message === 132) {
        const cells = this.cells(id);
        const bpm = cells["6"]?.value;
        const time = cells["9"]?.value;
        const samples = Array.isArray(bpm) ? bpm : [bpm];
        const events = Array.isArray(time) ? time : [time];
        if (
          samples.length === events.length &&
          samples.every((v) => typeof v === "number") &&
          events.every((v) => typeof v === "number")
        ) {
          const list = hrMessages.get(record.subfile) ?? [];
          list.push({
            timestamp: record.timestamp,
            fractionalTimestamp:
              typeof cells["0"]?.value === "number"
                ? cells["0"].value
                : undefined,
            filteredBpm: samples as number[],
            eventTimestamp: events as number[],
          });
          hrMessages.set(record.subfile, list);
        }
      }
      if (record.definition.message === 20) {
        const speed = numberValue(raw["73"] ?? raw["6"]);
        const speedField = record.definition.fields.find(
          (field) => field.id === (raw["73"] !== undefined ? 73 : 6),
        );
        if (
          speed !== undefined &&
          speedField &&
          valid(speed, speedField.type) &&
          speed > 100000
        )
          this.index.diagnostics.push({
            id: `speed:${id}`,
            severity: "warning",
            code: "speed-range",
            message:
              "Recorded speed exceeds 100 m/s. The original reading is retained.",
            subfile: record.subfile,
            offset: record.offset,
            end: record.end,
            record: id,
            repair: "none",
          });
        const t = record.timestamp;
        if (t !== undefined) {
          this.startTimestamp = Math.min(this.startTimestamp ?? t, t);
          this.endTimestamp = Math.max(this.endTimestamp ?? t, t);
        }
        if (
          previous?.subfile === record.subfile &&
          t !== undefined &&
          previous.timestamp !== undefined &&
          t <= previous.timestamp
        )
          this.index.diagnostics.push({
            id: `time:${id}`,
            severity: "warning",
            code: "timestamp-order",
            message:
              "The record timestamp repeats or moves backwards. The record is retained.",
            subfile: record.subfile,
            offset: record.offset,
            end: record.end,
            record: id,
            repair: "none",
          });
        const lat = numberValue(raw["0"]);
        const lon = numberValue(raw["1"]);
        if (
          lat !== undefined &&
          lon !== undefined &&
          valid(lat, 5) &&
          valid(lon, 5)
        ) {
          this.gpsPoints++;
          if (
            previous?.subfile === record.subfile &&
            previousLat !== undefined &&
            previousLon !== undefined &&
            Math.abs(lat - previousLat) + Math.abs(lon - previousLon) > 12000000
          )
            this.index.diagnostics.push({
              id: `gps:${id}`,
              severity: "warning",
              code: "gps-jump",
              message:
                "The position changes abruptly. The original coordinates are retained.",
              subfile: record.subfile,
              offset: record.offset,
              end: record.end,
              record: id,
              repair: "none",
            });
          previousLat = lat;
          previousLon = lon;
        }
        previous = record;
      }
      if (id % 1024 === 0) {
        job.progress(id, this.index.records.length, "Indexing fields");
        await job.yield();
      }
    }
    for (const [subfile, messages] of hrMessages) {
      try {
        const samples = hrUtility.expandHeartRates(messages);
        let cursor = 0;
        let previousTime: number | undefined;
        for (const id of this.index.messages.get(20) ?? []) {
          const record = this.index.records[id];
          if (record.subfile !== subfile || record.timestamp === undefined)
            continue;
          const before = previousTime ?? record.timestamp - 1;
          let sum = 0;
          let count = 0;
          while (
            cursor < samples.length &&
            samples[cursor].timestamp <= record.timestamp
          ) {
            if (samples[cursor].timestamp > before) {
              sum += samples[cursor].heartRate;
              count++;
            }
            cursor++;
          }
          if (count) this.mergedHr.set(id, Math.round(sum / count));
          previousTime = record.timestamp;
          if (id % 1024 === 0) await job.yield();
        }
      } catch {
        const file = this.index.subfiles[subfile];
        this.index.diagnostics.push({
          id: `hr:${subfile}`,
          severity: "warning",
          code: "hr-timing",
          message:
            "Heart-rate samples could not be anchored reliably. Raw HR messages are retained.",
          subfile,
          offset: file.bodyStart,
          end: file.bodyEnd,
          repair: "none",
        });
      }
    }
    const memoRecords = this.index.messages.get(145) ?? [];
    if (!memoRecords.length) return;
    // Parent indexes are per-message ordinals within each FIT subfile.
    const parents = new Map<string, number[]>();
    for (let id = 0; id < this.index.records.length; id++) {
      const record = this.index.records[id];
      const key = `${record.subfile}:${record.definition.message}`;
      const ids = parents.get(key);
      if (ids) ids.push(id);
      else parents.set(key, [id]);
      if (id % 1024 === 0) await job.yield();
    }
    const parts = new Map<
      string,
      { id: number; key: string; pieces: { order: number; bytes: number[] }[] }
    >();
    for (let memoIndex = 0; memoIndex < memoRecords.length; memoIndex++) {
      if (memoIndex % 1024 === 0) await job.yield();
      const id = memoRecords[memoIndex];
      const record = this.index.records[id];
      const raw = this.raw(id);
      const message = numberValue(raw["1"]);
      const parent = numberValue(raw["2"]);
      const field = numberValue(raw["3"]);
      if (
        message === undefined ||
        parent === undefined ||
        field === undefined ||
        !valid(message, 4) ||
        !valid(parent, 4) ||
        !valid(field, 2)
      )
        continue;
      const target = parents.get(`${record.subfile}:${message}`)?.[
        parent & 0x0fff
      ];
      if (target === undefined) continue;
      const key = `${target}:${field}`;
      const item = parts.get(key) ?? {
        id: target,
        key: String(field),
        pieces: [],
      };
      const data = raw["4"] ?? raw["0"];
      const values = Array.isArray(data) ? data : [data];
      item.pieces.push({
        order: numberValue(raw["250"]) ?? 0,
        bytes: values.filter((v): v is number => typeof v === "number"),
      });
      parts.set(key, item);
    }
    for (const item of parts.values()) {
      let sorted = item.pieces;
      for (let width = 1; width < sorted.length; width *= 2) {
        const next: typeof sorted = [];
        for (let start = 0; start < sorted.length; start += width * 2) {
          const middle = Math.min(start + width, sorted.length);
          const end = Math.min(start + width * 2, sorted.length);
          let left = start;
          let right = middle;
          while (left < middle || right < end) {
            next.push(
              right === end ||
                (left < middle && sorted[left].order <= sorted[right].order)
                ? sorted[left++]
                : sorted[right++],
            );
            if (next.length % 1024 === 0) await job.yield();
          }
        }
        sorted = next;
      }
      const decoder = new TextDecoder();
      const text: string[] = [];
      for (const piece of sorted) {
        text.push(
          decoder.decode(Uint8Array.from(piece.bytes), { stream: true }),
        );
        await job.yield();
      }
      text.push(decoder.decode());
      this.memo.set(item.id, {
        ...this.memo.get(item.id),
        [item.key]: text.join("").replace(/\0+$/, ""),
      });
    }
  }
}
type DefinitionIdentity = RecordRef["definition"];
export function printValue(value: RawValue | undefined): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return `[${value.map(printValue).join(", ")}]`;
  if (typeof value === "number")
    return Number.isFinite(value) ? String(value) : "-";
  return String(value);
}
