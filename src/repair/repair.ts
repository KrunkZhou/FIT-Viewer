import { FitDocument } from "../document/document";
import { numberValue } from "../protocol/binary";
import { idleJob, readFit } from "../protocol/reader";
import { encodeMessage, wrapBodyCooperative } from "../protocol/writer";

export interface RepairOutput {
  bytes: Uint8Array;
  partial: boolean;
  generated: string[];
  unresolved: string[];
}

interface Candidate {
  message: number;
  label: string;
  values: Record<string, number>;
}
export async function summaryCandidates(
  document: FitDocument,
  subfile: number,
  job = idleJob(),
): Promise<Candidate[]> {
  const { index } = document;
  const file = index.subfiles[subfile];
  if (file.type !== 4) return [];
  let start: number | undefined;
  let end: number | undefined;
  let last = -1;
  let count = 0;
  const ids = index.messages.get(20) ?? [];
  for (let i = 0; i < ids.length; i++) {
    const record = index.records[ids[i]];
    if (record.subfile === subfile) {
      if (
        record.timestamp === undefined ||
        (end !== undefined && record.timestamp < end)
      )
        return [];
      start ??= record.timestamp;
      end = record.timestamp;
      last = ids[i];
      count++;
    }
    if (i % 4096 === 0) await job.yield();
  }
  if (count < 2 || start === undefined || end === undefined) return [];
  const sports = new Set<number>();
  for (const [message, field] of [
    [12, "0"],
    [18, "5"],
    [19, "25"],
  ] as const) {
    for (const id of index.messages.get(message) ?? []) {
      if (index.records[id].subfile !== subfile) continue;
      const value = numberValue(document.raw(id)[field]);
      if (value !== undefined && value !== 255) sports.add(value);
    }
  }
  if (sports.size !== 1) return [];
  const sport = [...sports][0];
  const has = (message: number) =>
    (index.messages.get(message) ?? []).some(
      (id) => index.records[id].subfile === subfile,
    );
  const elapsed = (end - start) * 1000;
  const distance = numberValue(document.raw(last)["5"]);
  const summary = {
    timestamp: end,
    startTime: start,
    totalElapsedTime: elapsed,
    sport,
    ...(distance !== undefined && distance !== 0xffffffff
      ? { totalDistance: distance }
      : {}),
  };
  const output: Candidate[] = [];
  if (!has(19) && !has(18))
    output.push({
      message: 19,
      label: "Lap",
      values: { ...summary, messageIndex: 0, event: 9, eventType: 1 },
    });
  if (!has(18)) {
    const lapIds = (index.messages.get(19) ?? []).filter(
      (id) => index.records[id].subfile === subfile,
    );
    let firstLapIndex = 0;
    if (lapIds.length) {
      const laps = lapIds.map((id) => document.raw(id));
      const indexes = laps.map((lap) => numberValue(lap["254"]));
      if (
        indexes.some((value) => value === undefined || value === 65535) ||
        indexes.some(
          (value, i) =>
            i > 0 && (value! & 4095) !== (indexes[i - 1]! & 4095) + 1,
        )
      )
        return output;
      if (
        laps.some(
          (lap) =>
            typeof lap["2"] !== "number" ||
            typeof lap["253"] !== "number" ||
            lap["2"] < start ||
            lap["253"] > end ||
            lap["253"] < lap["2"],
        )
      )
        return output;
      firstLapIndex = indexes[0]! & 4095;
    }
    output.push({
      message: 18,
      label: "Session",
      values: {
        ...summary,
        messageIndex: 0,
        event: 8,
        eventType: 1,
        firstLapIndex,
        numLaps: lapIds.length || 1,
      },
    });
  }
  if (!has(34))
    output.push({
      message: 34,
      label: "Activity",
      values: {
        timestamp: end,
        numSessions:
          (index.messages.get(18) ?? []).filter(
            (id) => index.records[id].subfile === subfile,
          ).length || 1,
        type: 0,
        event: 26,
        eventType: 1,
      },
    });
  return output;
}

export async function addSummaryDiagnostics(
  document: FitDocument,
  job = idleJob(),
): Promise<void> {
  for (const file of document.index.subfiles) {
    if (file.type !== 4) continue;
    const candidates = await summaryCandidates(document, file.index, job);
    for (const [message, label] of [
      [19, "Lap"],
      [18, "Session"],
      [34, "Activity"],
    ] as const) {
      const diagnosticId = `summary:${file.index}:${message}`;
      if (
        document.index.diagnostics.some((d) => d.id === diagnosticId) ||
        (document.index.messages.get(message) ?? []).some(
          (id) => document.index.records[id].subfile === file.index,
        ) ||
        (message === 19 &&
          (document.index.messages.get(18) ?? []).some(
            (id) => document.index.records[id].subfile === file.index,
          ))
      )
        continue;
      const recoverable = candidates.some(
        (candidate) => candidate.message === message,
      );
      document.index.diagnostics.push({
        id: diagnosticId,
        severity: "warning",
        code: "missing-summary",
        message: `${label} summary is missing. ${recoverable ? "A summary can be derived from retained activity records; timer time will remain unknown." : "Required source evidence is incomplete or ambiguous; this omission cannot be repaired automatically."}`,
        subfile: file.index,
        offset: file.bodyEnd,
        end: file.bodyEnd,
        repair: recoverable ? "summary" : "none",
      });
    }
  }
}

export async function repair(
  document: FitDocument,
  job = idleJob(),
): Promise<RepairOutput> {
  const pieces: Uint8Array[] = [];
  const generated: string[] = [];
  await addSummaryDiagnostics(document, job);
  for (const file of document.index.subfiles) {
    await job.yield();
    const prefix = document.index.bytes.subarray(file.bodyStart, file.bodyEnd);
    const candidates = await summaryCandidates(document, file.index, job);
    const additions = candidates.map((candidate) => {
      generated.push(
        `File ${file.index + 1}: ${candidate.label} (elapsed time derived; timer time unknown)`,
      );
      return encodeMessage(candidate.message, candidate.values);
    });
    const body = new Uint8Array(
      prefix.length + additions.reduce((n, a) => n + a.length, 0),
    );
    body.set(prefix);
    let offset = prefix.length;
    for (const addition of additions) {
      body.set(addition, offset);
      offset += addition.length;
    }
    const output = await wrapBodyCooperative(
      body,
      document.index.bytes.subarray(file.start, file.bodyStart),
      job,
    );
    const verified = await readFit(output, job);
    if (
      verified.diagnostics.some((d) => d.severity === "error") ||
      verified.records.length !==
        document.index.records.filter((r) => r.subfile === file.index).length +
          candidates.length
    )
      throw new Error("The repaired file failed structural validation.");
    const retained = output.subarray(
      file.headerSize,
      file.headerSize + prefix.length,
    );
    for (let i = 0; i < prefix.length; i++) {
      if (prefix[i] !== retained[i])
        throw new Error("Repair changed retained record bytes.");
      if (i % 65536 === 0) await job.yield();
    }
    pieces.push(output);
    job.progress(
      file.index + 1,
      document.index.subfiles.length,
      "Validating repair",
    );
  }
  const bytes = new Uint8Array(pieces.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    bytes.set(piece, offset);
    offset += piece.length;
  }
  const verified = await readFit(bytes, job);
  if (verified.diagnostics.some((d) => d.severity === "error"))
    throw new Error("The combined repaired file failed validation.");
  return {
    bytes,
    generated,
    unresolved: document.index.diagnostics
      .filter((d) => d.repair === "none")
      .map((d) => d.message),
    partial: document.index.diagnostics.some(
      (d) =>
        d.code === "undecodable-tail" ||
        d.code === "trailing-data" ||
        (d.code === "file-short" &&
          document.index.subfiles[d.subfile].bodyEnd <
            document.index.subfiles[d.subfile].declaredEnd),
    ),
  };
}
