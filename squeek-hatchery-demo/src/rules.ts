// Incubation rules: real-data validation, light power, palette, accessory schedule and growth.
// Pure functions only, so tests can run them in Node.

export const DURATION = 60; // seconds of valid, visible play
export const MAINTENANCE = 0.12; // lamp power at a valid IDLE reading
export const FULL_POWER_RPM = 120;
export const COLOR_STEP_MM = 5000; // a new ordinary hue every 5 m
export const WORK_STEP = 50n; // every accessory opportunity lasts 50 work units
export const BAND_COUNT = 22;
export const BAND_TOP = 100;
export const BAND_GAP = 12;
export const STAGE = {
  w: 400,
  h: 420,
  cx: 200,
  cy: 215,
  rx: 118,
  ry: 152,
} as const;

export const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));

// ---------- Real input ----------

export type CoreStatus = "ACTIVE" | "IDLE";
export interface Reading {
  coreStatus: CoreStatus;
  rpm: number;
  meters: number;
  distanceMm: number;
  work: bigint;
  counterEpoch: string;
  installationId?: string;
  observedAt: number;
  received: number;
  staleAfterSeconds: number;
  utcDate: string; // API measurement-day label: date of the starting noon UTC.
}

export function sameReportingHistory(
  a: Pick<Reading, "counterEpoch" | "installationId"> | null | undefined,
  b: Pick<Reading, "counterEpoch" | "installationId"> | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.counterEpoch === b.counterEpoch &&
    (a.installationId ?? "") === (b.installationId ?? "")
  );
}

export class SignalError extends Error {
  reason: "missing" | "invalid" | "stale" | "simulated" | "fault" | "replayed";
  constructor(reason: SignalError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const safeUInt = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 0;

/** Device distance days start at 12:00 UTC (19:00 Asia/Saigon), not midnight. */
export function measurementDayKey(observedAt: number): string {
  return new Date(observedAt - 12 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
}

/** Validate GET /v1/status. Throws SignalError for anything that is not fresh hardware data. */
export function validateStatus(
  body: unknown,
  now = Date.now(),
  previous: Reading | null = null,
): Reading {
  if (!isObj(body) || body.schemaVersion !== 1)
    throw new SignalError("invalid", "Unexpected status format");
  if (
    body.installationId !== undefined &&
    (typeof body.installationId !== "string" || !body.installationId.trim())
  ) {
    throw new SignalError("invalid", "Installation ID is malformed");
  }
  const installationId =
    typeof body.installationId === "string"
      ? body.installationId.trim()
      : undefined;
  const m = body.measurement;
  if (!isObj(m))
    throw new SignalError("missing", "No measurement in the status response");
  if (m.provenance !== "hardware")
    throw new SignalError(
      "simulated",
      `Reading is ${String(m.provenance ?? "unlabeled")}, not hardware`,
    );
  if (m.freshness !== "online")
    throw new SignalError("stale", "The wheel reports it is not online");
  if (m.coreStatus === "COUNTER_FAULT")
    throw new SignalError("fault", "The wheel counter reports a fault");
  if (m.coreStatus !== "ACTIVE" && m.coreStatus !== "IDLE")
    throw new SignalError("invalid", "Unknown wheel status");
  if (!safeUInt(m.rpmMilli) || !safeUInt(m.distanceMm))
    throw new SignalError("invalid", "Speed or distance is malformed");
  if (
    typeof m.cumulativeWorkUnits !== "string" ||
    !/^(0|[1-9]\d{0,77})$/.test(m.cumulativeWorkUnits)
  ) {
    throw new SignalError("invalid", "Work counter is malformed");
  }
  if (typeof m.counterEpoch !== "string" || !m.counterEpoch.trim())
    throw new SignalError("invalid", "Counter epoch is missing");
  if (
    typeof m.staleAfterSeconds !== "number" ||
    !Number.isFinite(m.staleAfterSeconds) ||
    m.staleAfterSeconds <= 0 ||
    m.staleAfterSeconds > 3600
  ) {
    throw new SignalError("invalid", "Staleness limit is malformed");
  }
  const received =
    typeof m.receivedAt === "string" ? Date.parse(m.receivedAt) : NaN;
  const observed =
    typeof m.observedAt === "string" ? Date.parse(m.observedAt) : NaN;
  if (!Number.isFinite(received) || !Number.isFinite(observed))
    throw new SignalError("invalid", "Reading timestamp is malformed");
  if (received - now > 30_000 || observed - now > 30_000)
    throw new SignalError("invalid", "Reading is timestamped in the future");
  const observationTtlMs = Math.min(120000, Math.max(1, m.staleAfterSeconds) * 1000);
  if (
    now - received > observationTtlMs ||
    now - observed > observationTtlMs
  )
    throw new SignalError("stale", "The latest wheel reading is stale");
  const work = BigInt(m.cumulativeWorkUnits);
  const rpm = m.coreStatus === "IDLE" ? 0 : m.rpmMilli / 1000;
  const currentHistory = { counterEpoch: m.counterEpoch, installationId };
  if (previous && observed < previous.observedAt)
    throw new SignalError(
      "replayed",
      "An older reading was replayed",
    );
  if (previous && observed === previous.observedAt) {
    if (
      !sameReportingHistory(previous, currentHistory) ||
      work !== previous.work ||
      m.distanceMm !== previous.distanceMm ||
      m.coreStatus !== previous.coreStatus ||
      rpm !== previous.rpm
    )
      throw new SignalError(
        "replayed",
        "The same reading timestamp has conflicting values",
      );
    // Polls can outpace hardware measurements. Preserve the reading, including its
    // original freshness timestamps; an HTTP receipt cannot extend its lifetime.
    return previous;
  }
  if (previous && sameReportingHistory(previous, currentHistory)) {
    // Work is cumulative across days; only daily distance may reset. Derive both
    // day keys from observation times so legacy cache date labels cannot block it.
    if (work < previous.work)
      throw new SignalError("replayed", "Work counter moved backwards");
    if (
      m.distanceMm < previous.distanceMm &&
      measurementDayKey(observed) === measurementDayKey(previous.observedAt)
    )
      throw new SignalError(
        "replayed",
        "Distance moved backwards within the measurement day",
      );
  }
  const reading: Reading = {
    coreStatus: m.coreStatus,
    rpm,
    meters: m.distanceMm / 1000,
    distanceMm: m.distanceMm,
    work,
    counterEpoch: m.counterEpoch,
    observedAt: observed,
    received,
    staleAfterSeconds: m.staleAfterSeconds,
    utcDate: measurementDayKey(observed),
  };
  if (installationId !== undefined) {
    reading.installationId = installationId;
  }
  return reading;
}

export function isSpeedFresh(reading: Reading | null, nowMs = Date.now()): boolean {
  if (!reading) return false;
  if (reading.coreStatus === "IDLE") return true;
  return nowMs - reading.observedAt <= 15000 && nowMs - reading.received <= 15000;
}

/**
 * Observation/receipt validity uses the policy capability `observationValidityCapMs`
 * (V1/V2: 15s; V3+: up to 120s). Avoid exact version string forks so newer presets
 * do not accidentally inherit legacy 15s telemetry behavior (R26/A7).
 */
export function observationValidityLimitMs(
  reading: Reading,
  policy?: { version?: string; observationValidityCapMs?: number } | null,
): number {
  const policyCapMs =
    typeof policy?.observationValidityCapMs === "number"
      ? policy.observationValidityCapMs
      : !policy ||
          policy.version === "exp-v3-2026-11-06" ||
          (typeof policy.version === "string" &&
            /^exp-v([4-9]|\d{2,})-/.test(policy.version))
        ? 120_000
        : 15_000;
  return Math.min(policyCapMs, Math.max(1, reading.staleAfterSeconds) * 1000);
}

export function isObservationValid(
  reading: Reading | null,
  nowMs = Date.now(),
  policy?: { version?: string } | null,
): boolean {
  if (!reading) return false;
  const ttlMs = observationValidityLimitMs(reading, policy);
  if (nowMs - reading.observedAt > ttlMs || nowMs - reading.received > ttlMs) return false;
  if (reading.observedAt - nowMs > 30000 || reading.received - nowMs > 30000) return false;
  return true;
}

/** Exact work gained between two readings of the same installation and epoch. Resets or history changes add nothing. */
export function workDelta(previous: Reading | null, current: Reading): bigint {
  if (!previous || !sameReportingHistory(previous, current)) return 0n;
  const d = current.work - previous.work;
  return d > 0n ? d : 0n;
}

/** Distance gained in mm within the same reporting history and measurement day. */
export function distanceDeltaMm(
  previous: Reading | null,
  current: Reading,
): number {
  if (!previous || !sameReportingHistory(previous, current)) return 0;
  if (
    measurementDayKey(previous.observedAt) !==
    measurementDayKey(current.observedAt)
  ) {
    return 0;
  }
  const d = current.distanceMm - previous.distanceMm;
  return d > 0 ? d : 0;
}

/** Lamp power: 12% maintenance glow at IDLE, linear to 100% at 120 RPM, capped. */
export const lampPower = (rpm: number) =>
  MAINTENANCE + (1 - MAINTENANCE) * clamp(rpm / FULL_POWER_RPM);

// ---------- Color ----------

export type ColorKind = "ordinary" | "pearl" | "rainbow";
export interface LampColor {
  kind: ColorKind;
  hue: number;
  rgb: [number, number, number];
  segment: number;
  date: string;
  startMeters: number;
  remainingMeters: number;
}

export const RAINBOW = [
  "#f07f92",
  "#f4a46a",
  "#f2d46f",
  "#8fcf8f",
  "#79b8e0",
  "#8c8fdc",
  "#c38fd6",
];
export const PEARL_RGB: [number, number, number] = [240, 222, 236];

export function hslToRgb(
  h: number,
  s: number,
  l: number,
): [number, number, number] {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}

function fnv(text: string) {
  let h = 2166136261;
  for (const ch of text) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/** Deterministic lamp color from the measurement-day label and the 5 m segment. */
export function palette(distanceMm: number, date: string): LampColor {
  const segment = Math.floor(distanceMm / COLOR_STEP_MM);
  const hue = fnv(`${date}:${segment}`) % 360;
  // Pearl: 250, 750, 1250 m ... ; rainbow: 500, 1000, 1500 m ... (segment = 5 m).
  const kind: ColorKind =
    segment > 0 && segment % 100 === 0
      ? "rainbow"
      : segment % 100 === 50
        ? "pearl"
        : "ordinary";
  const rgb =
    kind === "pearl"
      ? PEARL_RGB
      : kind === "rainbow"
        ? ([246, 214, 200] as [number, number, number])
        : hslToRgb(hue, 0.62, 0.64);
  return {
    kind,
    hue,
    rgb,
    segment,
    date,
    startMeters: (segment * COLOR_STEP_MM) / 1000,
    remainingMeters: (COLOR_STEP_MM - (distanceMm % COLOR_STEP_MM)) / 1000,
  };
}

/** Meters until the next pearl or rainbow passage begins (0 when one is active). */
export function nextSpecialColor(distanceMm: number): {
  kind: "pearl" | "rainbow";
  meters: number;
} {
  const seg = Math.floor(distanceMm / COLOR_STEP_MM);
  for (let s = seg + 1; ; s++) {
    if (s % 50 === 0)
      return {
        kind: s % 100 === 0 ? "rainbow" : "pearl",
        meters: (s * COLOR_STEP_MM - distanceMm) / 1000,
      };
  }
}

export const rgbCss = (c: readonly number[]) =>
  `rgb(${c.map((v) => Math.round(v)).join(" ")})`;
export function colorCss(c: LampColor) {
  if (c.kind === "rainbow")
    return `linear-gradient(90deg,${RAINBOW.join(",")})`;
  if (c.kind === "pearl")
    return "linear-gradient(120deg,#fff8f2,#f1cfe4 40%,#cfe3f4 70%,#fff8f2)";
  return rgbCss(c.rgb);
}
export function colorName(c: LampColor) {
  if (c.kind === "rainbow") return "Rainbow passage";
  if (c.kind === "pearl") return "Pearl passage";
  return `${hueName(c.hue)} light`;
}
export function hueName(h: number) {
  const names = [
    "Rose",
    "Apricot",
    "Honey",
    "Pistachio",
    "Leaf",
    "Mint",
    "Sea glass",
    "Sky",
    "Cornflower",
    "Lavender",
    "Orchid",
    "Pink",
  ];
  return names[Math.floor(((h + 15) % 360) / 30)];
}

// ---------- Accessory schedule (exact BigInt work units, never revolutions) ----------
export const ACCESSORIES = [
  "Neckerchief",
  "Bow tie",
  "Short open vest",
  "Tiny satchel",
  "Acorn pendant",
  "Daisy ear clip",
  "Leaf lapel pin",
  "Round glasses",
  "Miniature beret",
  "Seed brooch",
  "Stardust Crown",
  "Aurora Wing Brooch",
] as const;
export type AccessoryId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
export function accessoryAt(work: bigint): AccessoryId {
  if (work < 0n) throw new RangeError("Work must be nonnegative");
  const phase = work % 2000n;
  if (work >= 1000n && phase >= 1000n && phase < 1050n) return 10;
  if (work >= 2000n && phase < 50n) return 11;
  return Number((work / WORK_STEP) % 10n) as AccessoryId;
}
export function accessoryPreview(work: bigint) {
  const remaining = WORK_STEP - (work % WORK_STEP);
  const nextStart = (work / 1000n + 1n) * 1000n;
  return {
    id: accessoryAt(work),
    remaining,
    next: accessoryAt(work + remaining),
    nextSpecial: {
      id: (nextStart % 2000n === 1000n ? 10 : 11) as AccessoryId,
      remaining: nextStart - work,
    },
  };
}

// ---------- Session and growth ----------

export interface Band {
  y: number;
  dose: number;
  rgb: [number, number, number];
  rainbow: number;
  pearl: number;
}
export interface Session {
  version: 3;
  id: string;
  startedAt: string | null;
  endedAt: string | null;
  elapsed: number;
  lampPosition: number; // -100 (top) .. 100 (bottom)
  regions: { growth: number; exposure: number }[]; // 0 ears, 1 fluff, 2 lower coat + pom
  bands: Band[];
  accessoryId: AccessoryId;
  accessoryVersion: 1;
  accessorySource: {
    counterEpoch: string;
    cumulativeWorkUnits: string;
    bucket: string;
  } | null;
  workDuring: string;
  colorsSeen: string[];
}

export const BASE_FUR: [number, number, number] = [246, 232, 210];

export function freshSession(
  id: string = globalThis.crypto.randomUUID(),
): Session {
  return {
    version: 3,
    id,
    startedAt: null,
    endedAt: null,
    elapsed: 0,
    lampPosition: -60,
    regions: [0, 1, 2].map(() => ({ growth: 0, exposure: 0 })),
    bands: Array.from({ length: BAND_COUNT }, (_, i) => ({
      y: BAND_TOP + i * BAND_GAP,
      dose: 0,
      rgb: [...BASE_FUR] as [number, number, number],
      rainbow: 0,
      pearl: 0,
    })),
    accessoryId: 0,
    accessoryVersion: 1,
    accessorySource: null,
    workDuring: "0",
    colorsSeen: [],
  };
}

/** Lock once from the accepted reading at the beginning; reload never picks again. */
export function lockAccessory(s: Session, r: Reading) {
  if (s.accessorySource) return;
  s.accessoryId = accessoryAt(r.work);
  s.accessorySource = {
    counterEpoch: r.counterEpoch,
    cumulativeWorkUnits: r.work.toString(),
    bucket: (r.work / WORK_STEP).toString(),
  };
}

export const beamY = (position: number) =>
  STAGE.cy + clamp(position, -100, 100);
export const regionAt = (position: number) =>
  position < -35 ? 0 : position > 35 ? 2 : 1;
export const REGION_NAMES = ["Ears", "Fluff", "Lower coat and pom"];
export const BEAM_SIGMA = 20;

/** One step of lit, valid play. Returns true when the egg is ready to hatch. */
export function develop(
  s: Session,
  dt: number,
  rpm: number,
  color: LampColor,
  work = 0n,
): boolean {
  dt = Math.max(0, Math.min(dt, DURATION - s.elapsed));
  if (dt <= 0) return s.elapsed >= DURATION;
  const power = lampPower(rpm);
  const region = s.regions[regionAt(s.lampPosition)];
  region.exposure += dt;
  region.growth = clamp(region.growth + (dt * power) / 24);
  const y = beamY(s.lampPosition);
  for (const b of s.bands) {
    const footprint = Math.exp(-0.5 * ((b.y - y) / BEAM_SIGMA) ** 2);
    if (footprint < 0.02) continue;
    const dose = dt * power * footprint;
    const k = 1 - Math.exp(-dose / 2.5); // new color gradually replaces the old one locally
    for (let i = 0; i < 3; i++) b.rgb[i] += (color.rgb[i] - b.rgb[i]) * k;
    b.rainbow += ((color.kind === "rainbow" ? 1 : 0) - b.rainbow) * k;
    b.pearl += ((color.kind === "pearl" ? 1 : 0) - b.pearl) * k;
    b.dose = Math.min(40, b.dose + dose);
  }
  const key =
    color.kind === "ordinary"
      ? hueName(color.hue)
      : color.kind === "pearl"
        ? "Pearl"
        : "Rainbow";
  if (!s.colorsSeen.includes(key) && s.colorsSeen.length < 8)
    s.colorsSeen.push(key);
  s.workDuring = (BigInt(s.workDuring) + (work > 0n ? work : 0n)).toString();
  s.elapsed += dt;
  return s.elapsed >= DURATION;
}

/** Local color deepens to a bounded saturation; it never darkens to black. */
export const colorAlpha = (dose: number) => 0.82 * (1 - Math.exp(-dose / 5));

export function bandAt(s: Session, y: number): Band {
  let best = s.bands[0];
  for (const b of s.bands)
    if (Math.abs(b.y - y) < Math.abs(best.y - y)) best = b;
  return best;
}

/** Lamp geometry: target on the egg's right surface; the lamp sits on a vertical rail along the surface normal. */
export function lampGeometry(position: number, railX = 372) {
  const { cx, cy, rx, ry } = STAGE;
  const targetY = beamY(position);
  const dy = targetY - cy;
  const targetX = cx + rx * Math.sqrt(Math.max(0, 1 - (dy / ry) ** 2));
  const nx = (targetX - cx) / (rx * rx),
    ny = dy / (ry * ry);
  const sourceY = targetY + ((railX - targetX) * ny) / nx;
  const angle =
    (Math.atan2(targetY - sourceY, targetX - railX) * 180) / Math.PI; // direction lamp -> egg
  return {
    targetX,
    targetY,
    sourceX: railX,
    sourceY,
    angle,
    normal: [nx, ny] as const,
  };
}

/** Inverse of lampGeometry for direct dragging: the lamp position whose rail height is closest to y. */
export function positionForRailY(y: number) {
  let lo = -100,
    hi = 100;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (lampGeometry(mid).sourceY < y) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 10) / 10;
}
