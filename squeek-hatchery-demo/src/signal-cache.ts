import { measurementDayKey, type Reading } from "./rules.ts";

// Keep the existing key so old baselines are migrated rather than discarded.
export const SIGNAL_BASELINE_KEY = "squeek-signal-baseline-v3";
const uint = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

/** Restore a replay baseline, including pre-fix caches with a calendar UTC date. */
export function restoreSignalBaseline(raw: string | null): Reading | null {
  try {
    const b = JSON.parse(raw || "null");
    if (
      !b ||
      typeof b !== "object" ||
      Array.isArray(b) ||
      typeof b.work !== "string" ||
      !/^(0|[1-9]\d{0,77})$/.test(b.work) ||
      typeof b.counterEpoch !== "string" ||
      !b.counterEpoch.trim() ||
      (b.installationId !== undefined &&
        (typeof b.installationId !== "string" || !b.installationId.trim())) ||
      !uint(b.observedAt) ||
      !uint(b.received) ||
      !uint(b.distanceMm) ||
      typeof b.rpm !== "number" ||
      !Number.isFinite(b.rpm) ||
      b.rpm < 0 ||
      (b.coreStatus !== "ACTIVE" && b.coreStatus !== "IDLE") ||
      typeof b.staleAfterSeconds !== "number" ||
      !Number.isFinite(b.staleAfterSeconds) ||
      b.staleAfterSeconds <= 0 ||
      b.staleAfterSeconds > 3600
    )
      return null;
    const restored: Reading = {
      coreStatus: b.coreStatus,
      rpm: b.coreStatus === "IDLE" ? 0 : b.rpm,
      meters: b.distanceMm / 1000,
      distanceMm: b.distanceMm,
      work: BigInt(b.work),
      counterEpoch: b.counterEpoch.trim(),
      observedAt: b.observedAt,
      received: b.received,
      staleAfterSeconds: b.staleAfterSeconds,
      utcDate: measurementDayKey(b.observedAt),
    };
    if (typeof b.installationId === "string") {
      restored.installationId = b.installationId.trim();
    }
    return restored;
  } catch {
    return null;
  }
}

export function serializeSignalBaseline(reading: Reading): string {
  const payload: Record<string, unknown> = {
    ...reading,
    utcDate: measurementDayKey(reading.observedAt),
    work: reading.work.toString(),
  };
  if (reading.installationId === undefined) {
    delete payload.installationId;
  }
  return JSON.stringify(payload);
}
