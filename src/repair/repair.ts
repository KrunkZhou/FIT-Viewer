import { FitDocument } from "../document/document";
import { numberValue } from "../protocol/binary";
import { idleJob, readFit } from "../protocol/reader";
import { encodeMessage, wrapBodyCooperative } from "../protocol/writer";
import { Profile } from "@garmin/fitsdk";
import { summaryIndex } from "./summary-index";
import { Metadata } from "../metadata/profile";

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
const candidateCache = new WeakMap<FitDocument, Map<number, Candidate[]>>();

export async function summaryCandidates(
  document: FitDocument,
  subfile: number,
  job = idleJob(),
): Promise<Candidate[]> {
  const { index } = document;
  const file = index.subfiles[subfile];
  if (file.type !== 4) return [];
  job.signal.throwIfAborted();
  const cached = candidateCache.get(document)?.get(subfile);
  if (cached) return cached;
  const evidence = (await summaryIndex(document, job))[subfile];
  const { start, end, last, count, messages } = evidence;
  const has = (message: number) => messages.has(message);
  if (has(18) && has(34)) return [];
  if (
    !evidence.ordered ||
    count < 2 ||
    start === undefined ||
    end === undefined
  )
    return [];
  const sports = new Set<number>();
  let checked = 0;
  for (const [message, field] of [
    [12, "0"],
    [18, "5"],
    [19, "25"],
  ] as const) {
    for (const id of messages.get(message) ?? []) {
      const value = numberValue(document.raw(id)[field]);
      if (value !== undefined && value !== 255) sports.add(value);
      if (++checked % 512 === 0) await job.yield();
    }
  }
  if (sports.size !== 1) return [];
  const sport = [...sports][0];
  const elapsed = (end - start) * 1000;
  // The all-ones value is FIT's invalid sentinel, not a representable duration.
  if (!has(18) && (!Number.isSafeInteger(elapsed) || elapsed > 0xfffffffe))
    return [];
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
    const lapIds = messages.get(19) ?? [];
    if (lapIds.length >= 65535) return output;
    let firstLapIndex = 0;
    if (lapIds.length) {
      const laps = [];
      for (const id of lapIds) {
        laps.push(document.raw(id));
        if (laps.length % 512 === 0) await job.yield();
      }
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
  const numSessions = messages.get(18)?.length || 1;
  if (!has(34) && numSessions < 65535)
    output.push({
      message: 34,
      label: "Activity",
      values: {
        timestamp: end,
        numSessions,
        type: 0,
        event: 26,
        eventType: 1,
      },
    });
  const cache = candidateCache.get(document) ?? new Map<number, Candidate[]>();
  cache.set(subfile, output);
  candidateCache.set(document, cache);
  return output;
}

export async function addSummaryDiagnostics(
  document: FitDocument,
  job = idleJob(),
): Promise<void> {
  const evidence = await summaryIndex(document, job);
  const diagnosticIds = new Set(document.index.diagnostics.map((d) => d.id));
  let diagnosticCount = document.index.diagnostics.length;
  for (const file of document.index.subfiles) {
    if (file.index % 128 === 0) await job.yield();
    if (file.type !== 4) continue;
    const { messages, start, end } = evidence[file.index];
    if (messages.has(18) && messages.has(34)) continue;
    const candidates = await summaryCandidates(document, file.index, job);
    // Another cooperative job may have added diagnostics while this one yielded.
    while (diagnosticCount < document.index.diagnostics.length)
      diagnosticIds.add(document.index.diagnostics[diagnosticCount++].id);
    for (const [message, label] of [
      [19, "Lap"],
      [18, "Session"],
      [34, "Activity"],
    ] as const) {
      const diagnosticId = `summary:${file.index}:${message}`;
      if (
        diagnosticIds.has(diagnosticId) ||
        messages.has(message) ||
        (message === 19 && messages.has(18))
      )
        continue;
      const recoverable = candidates.some(
        (candidate) => candidate.message === message,
      );
      const reason =
        !messages.has(18) &&
        start !== undefined &&
        end !== undefined &&
        (end - start) * 1000 > 0xfffffffe
          ? "Elapsed time exceeds the FIT summary field range; this omission cannot be repaired automatically."
          : "Required source evidence is incomplete or ambiguous; this omission cannot be repaired automatically.";
      diagnosticIds.add(diagnosticId);
      document.index.diagnostics.push({
        id: diagnosticId,
        severity: "warning",
        code: "missing-summary",
        message: `${label} summary is missing. ${recoverable ? "A summary can be derived from retained activity records; timer time will remain unknown." : reason}`,
        subfile: file.index,
        offset: file.bodyEnd,
        end: file.bodyEnd,
        repair: recoverable ? "summary" : "none",
      });
      diagnosticCount++;
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
  const evidence = await summaryIndex(document, job);
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
        evidence[file.index].recordCount + candidates.length
    )
      throw new Error("The repaired file failed structural validation.");
    const decoded = new Metadata(verified);
    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i];
      const record = verified.records[evidence[file.index].recordCount + i];
      const values = decoded.raw(record);
      if (
        record.definition.message !== candidate.message ||
        Object.entries(candidate.values).some(([name, value]) => {
          const field = Object.values(
            Profile.messages[candidate.message].fields,
          ).find((field) => field.name === name)!;
          return values[String(field.num)] !== value;
        })
      )
        throw new Error("The repaired file failed generated-value validation.");
    }
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
