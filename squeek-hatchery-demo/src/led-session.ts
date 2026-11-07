import {
  SignalError,
  clamp,
  measurementDayKey,
  observationValidityLimitMs,
  regionAt,
  sameReportingHistory,
  validateStatus,
  type CoreStatus,
  type Reading,
} from "./rules.ts";
import {
  DEFAULT_GAME_POLICY,
  EXPERIMENTAL_POLICY_V1,
  LATEST_GAME_POLICY,
  accessoryByIndex,
  accessoryScheduleAt,
  backgroundByIndex,
  calculateScoreBreakdown,
  continuousRegionLevel,
  familyByIndex,
  gameWeekKey,
  integerRegionLevel,
  ledLampPower,
  paletteByIndex,
  paletteScheduleAt,
  pickRandomBackgroundIndex,
  resolveKnownGamePolicy,
  LED_STAGE_DESCRIPTIONS,
  type FamilyId,
  type GamePolicy,
  type ScoreBreakdown,
} from "./game-policy.ts";

export interface LockedTraitSnapshot {
  lockedAt: string;
  paletteIndex: number;
  paletteId: string;
  paletteName: string;
  accessoryIndex: number;
  accessoryId: string;
  accessoryName: string;
  measurementDay: string;
  counterEpoch: string;
  installationId: string | null;
  cumulativeWorkUnits: string;
  dayStartWorkUnits: string;
  distanceMm: number;
}

export interface LedRegionState {
  exposure: number;
  dose: number;
  continuousLevel: number;
  level: number;
}

/** Server-owned Ranked attempt order. Legacy rows omit it; clients cannot assign the revision. */
export interface RankedIntentOrder {
  attemptId: string;
  aimIntent: number;
  revision: number;
  adopted: boolean;
}

export interface LedSession {
  schemaVersion: "squeek-led-session-v1";
  id: string;
  mode: "guest" | "ranked";
  ownerWallet: string | null;
  policyVersion: string;
  experimental: boolean;
  familyIndex: 0 | 1 | 2;
  familyId: FamilyId;
  status: "egg" | "running" | "paused" | "completed";
  lampPosition: number; // -100..100
  elapsed: number; // 0..durationSeconds
  regions: [LedRegionState, LedRegionState, LedRegionState];
  lockedTraits: LockedTraitSnapshot | null;
  backgroundIndex: number | null;
  backgroundId: string | null;
  workDuring: string;
  startedAt: string | null;
  completedAt: string | null;
  intentOrder?: RankedIntentOrder;
}

export interface CharacterSnapshot {
  schemaVersion: "squeek-led-v1";
  catalogVersion: 1;
  rendererVersion: 5;
  policyVersion: string;
  experimental: boolean;
  sessionId: string;
  resultId: string;
  mode: "guest" | "ranked";
  ownerWallet: string | null;
  displayName: string | null;
  effectivePlayerName: string;
  familyId: FamilyId;
  familyName: string;
  familyIndex: 0 | 1 | 2;
  regionFamilies: [FamilyId, FamilyId, FamilyId];
  levels: [number, number, number];
  doses: [number, number, number];
  paletteId: string;
  paletteName: string;
  paletteIndex: number;
  accessoryId: string;
  accessoryName: string;
  accessoryIndex: number;
  backgroundId: string;
  backgroundName: string;
  backgroundIndex: number;
  scores: ScoreBreakdown;
  locks: LockedTraitSnapshot;
  startedAt: string;
  completedAt: string;
  weekKey: string;
}

export function shortWalletAddress(address: string): string {
  const clean = address.trim();
  if (clean.length < 12) return clean;
  return `${clean.slice(0, 6)}…${clean.slice(-4)}`;
}

export const DISPLAY_NAME_MAX_LENGTH = 30;
// Disallow HTML brackets, quotes, control chars, or script injection characters.
const SAFE_DISPLAY_NAME_RE = /^[^\u0000-\u001F\u007F<>"'`&\\]{1,30}$/;

export function normalizeDisplayName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(/\s+/g, " ");
}

export function validatePlayerDisplayName(raw: unknown): {
  valid: boolean;
  normalized: string;
  error?: string;
} {
  if (raw === null || raw === undefined || raw === "") {
    return { valid: true, normalized: "" };
  }
  if (typeof raw !== "string") {
    return { valid: false, normalized: "", error: "Display name must be a string." };
  }
  const normalized = normalizeDisplayName(raw);
  if (normalized === "") {
    // Empty/whitespace-only display name is allowed and falls back to shortened wallet address
    return { valid: true, normalized: "" };
  }
  if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
    return {
      valid: false,
      normalized,
      error: `Display name must be ${DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  if (!SAFE_DISPLAY_NAME_RE.test(normalized)) {
    return {
      valid: false,
      normalized,
      error: "Display name contains disallowed characters (< > \" ' ` & \\ or control characters).",
    };
  }
  return { valid: true, normalized };
}

export function formatEffectivePlayerName(
  walletAddress: string | null,
  displayName: string | null | undefined,
): string {
  const norm = normalizeDisplayName(displayName ?? "");
  if (norm) return norm;
  if (walletAddress) return shortWalletAddress(walletAddress);
  return "Guest player";
}

export function resolveSessionGamePolicy(
  session: Pick<LedSession, "policyVersion">,
  explicitPolicy?: GamePolicy,
): GamePolicy {
  if (explicitPolicy) {
    if (explicitPolicy.version !== session.policyVersion) {
      throw new Error(
        `Policy version mismatch: session requires "${session.policyVersion}", but received "${explicitPolicy.version}".`,
      );
    }
    return explicitPolicy;
  }
  const known = resolveKnownGamePolicy(session.policyVersion);
  if (!known) {
    throw new Error(`Unsupported session policy version "${session.policyVersion}".`);
  }
  return known;
}

export function createLedSession(options: {
  id?: string;
  mode: "guest" | "ranked";
  ownerWallet?: string | null;
  familyIndex: 0 | 1 | 2;
  policy?: GamePolicy;
}): LedSession {
  const policy = options.policy ?? DEFAULT_GAME_POLICY;
  const fam = familyByIndex(options.familyIndex);
  return {
    schemaVersion: "squeek-led-session-v1",
    id: options.id ?? globalThis.crypto.randomUUID(),
    mode: options.mode,
    ownerWallet: options.ownerWallet ?? null,
    policyVersion: policy.version,
    experimental: policy.experimental,
    familyIndex: fam.index,
    familyId: fam.id,
    status: "egg",
    lampPosition: -70,
    elapsed: 0,
    regions: [
      { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
      { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
      { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
    ],
    lockedTraits: null,
    backgroundIndex: null,
    backgroundId: null,
    workDuring: "0",
    startedAt: null,
    completedAt: null,
  };
}

/**
 * Locks both Palette and Accessory simultaneously when illumination starts for the first time.
 * Subsequent calls on the same session are no-ops so pausing, changing regions, or hardware updates
 * never reroll the locked pair.
 */
export function lockSessionTraits(
  session: LedSession,
  reading: Reading,
  dayStartWork: bigint = 0n,
  policy?: GamePolicy,
  nowIso: string = new Date().toISOString(),
  resolvedTraitsOverride?: { paletteIndex: number; accessoryIndex: number },
): LockedTraitSnapshot {
  if (session.lockedTraits) {
    return session.lockedTraits;
  }
  const effectivePolicy = resolveSessionGamePolicy(session, policy);
  let paletteIndex: number;
  let accessoryIndex: number;
  let palItem: { id: string; name: string };
  let accItem: { id: string; name: string };

  if (resolvedTraitsOverride) {
    paletteIndex = resolvedTraitsOverride.paletteIndex;
    accessoryIndex = resolvedTraitsOverride.accessoryIndex;
    palItem = paletteByIndex(paletteIndex);
    accItem = accessoryByIndex(accessoryIndex);
  } else {
    const palWin = paletteScheduleAt(reading.distanceMm, effectivePolicy);
    const accWin = accessoryScheduleAt(reading.work, dayStartWork, effectivePolicy);
    paletteIndex = palWin.itemIndex;
    accessoryIndex = accWin.itemIndex;
    palItem = palWin.item;
    accItem = accWin.item;
  }

  const locked: LockedTraitSnapshot = {
    lockedAt: nowIso,
    paletteIndex,
    paletteId: palItem.id,
    paletteName: palItem.name,
    accessoryIndex,
    accessoryId: accItem.id,
    accessoryName: accItem.name,
    measurementDay: reading.utcDate,
    counterEpoch: reading.counterEpoch,
    installationId: reading.installationId ?? null,
    cumulativeWorkUnits: reading.work.toString(),
    dayStartWorkUnits: dayStartWork.toString(),
    distanceMm: reading.distanceMm,
  };
  session.lockedTraits = locked;
  session.startedAt ||= nowIso;
  if (session.status === "egg" || session.status === "paused") {
    session.status = "running";
  }
  return locked;
}

export interface StepLedSessionResult {
  completed: boolean;
  readyToComplete: boolean;
  dtApplied: number;
  power: number;
  aimedRegion: 0 | 1 | 2;
  levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
}

export function stepLedSession(
  session: LedSession,
  dtSeconds: number,
  rpm: number,
  workDeltaUnits: bigint = 0n,
  policy?: GamePolicy,
  nowIso: string = new Date().toISOString(),
  options: { autoComplete?: boolean } = {},
): StepLedSessionResult {
  const effectivePolicy = resolveSessionGamePolicy(session, policy);
  const autoComplete = options.autoComplete ?? true;
  const aimedRegion = regionAt(session.lampPosition) as 0 | 1 | 2;
  const power = ledLampPower(rpm, effectivePolicy);
  const remaining = Math.max(0, effectivePolicy.durationSeconds - session.elapsed);
  const dt = Math.max(0, Math.min(dtSeconds, remaining));
  const levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[] = [];

  if (dt <= 0) {
    const ready = session.elapsed + 1e-6 >= effectivePolicy.durationSeconds;
    return {
      completed: session.status === "completed",
      readyToComplete: ready,
      dtApplied: 0,
      power,
      aimedRegion,
      levelUps,
    };
  }

  const reg = session.regions[aimedRegion];
  const prevLevel = reg.level;
  reg.exposure = Number((reg.exposure + dt).toFixed(6));
  reg.dose = Number((reg.dose + dt * power).toFixed(6));
  reg.continuousLevel = Number(continuousRegionLevel(reg.dose, effectivePolicy).toFixed(4));
  reg.level = integerRegionLevel(reg.dose, effectivePolicy);

  if (reg.level > prevLevel) {
    levelUps.push({
      region: aimedRegion,
      previousLevel: prevLevel,
      newLevel: reg.level,
    });
  }

  if (workDeltaUnits > 0n) {
    session.workDuring = (BigInt(session.workDuring) + workDeltaUnits).toString();
  }

  session.elapsed = Number(
    Math.min(effectivePolicy.durationSeconds, session.elapsed + dt).toFixed(6),
  );
  const readyToComplete = session.elapsed + 1e-6 >= effectivePolicy.durationSeconds;
  if (readyToComplete) {
    session.elapsed = effectivePolicy.durationSeconds;
    if (autoComplete) {
      session.status = "completed";
      session.completedAt ||= nowIso;
      if (session.backgroundIndex === null) {
        const bgIdx = pickRandomBackgroundIndex(effectivePolicy);
        session.backgroundIndex = bgIdx;
        session.backgroundId = backgroundByIndex(bgIdx).id;
      }
    } else if (session.status === "running") {
      session.status = "paused";
    }
  }

  return {
    completed: session.status === "completed",
    readyToComplete,
    dtApplied: dt,
    power,
    aimedRegion,
    levelUps,
  };
}

export function buildCharacterSnapshot(
  session: LedSession,
  options: {
    resultId?: string;
    displayName?: string | null;
    policy?: GamePolicy;
  } = {},
): CharacterSnapshot {
  const policy = resolveSessionGamePolicy(session, options.policy);
  if (!session.lockedTraits) {
    throw new Error("Cannot build CharacterSnapshot before traits are locked");
  }
  const fam = familyByIndex(session.familyIndex);
  const pal = paletteByIndex(session.lockedTraits.paletteIndex);
  const acc = accessoryByIndex(session.lockedTraits.accessoryIndex);
  const bgIdx = session.backgroundIndex ?? 0;
  const bg = backgroundByIndex(bgIdx);
  const levels: [number, number, number] = [
    session.regions[0].level,
    session.regions[1].level,
    session.regions[2].level,
  ];
  const doses: [number, number, number] = [
    Number(session.regions[0].dose.toFixed(4)),
    Number(session.regions[1].dose.toFixed(4)),
    Number(session.regions[2].dose.toFixed(4)),
  ];
  const scores = calculateScoreBreakdown(
    levels,
    pal.index,
    acc.index,
    bg.index,
    policy,
  );
  const completedAt = session.completedAt ?? new Date().toISOString();
  const completedMs = Date.parse(completedAt) || Date.now();
  const displayName = normalizeDisplayName(options.displayName ?? "") || null;

  return {
    schemaVersion: "squeek-led-v1",
    catalogVersion: 1,
    rendererVersion: 5,
    policyVersion: policy.version,
    experimental: policy.experimental,
    sessionId: session.id,
    resultId: options.resultId ?? session.id,
    mode: session.mode,
    ownerWallet: session.ownerWallet,
    displayName,
    effectivePlayerName: formatEffectivePlayerName(session.ownerWallet, displayName),
    familyId: fam.id,
    familyName: fam.name,
    familyIndex: fam.index,
    regionFamilies: [fam.id, fam.id, fam.id],
    levels,
    doses,
    paletteId: pal.id,
    paletteName: pal.name,
    paletteIndex: pal.index,
    accessoryId: acc.id,
    accessoryName: acc.name,
    accessoryIndex: acc.index,
    backgroundId: bg.id,
    backgroundName: bg.name,
    backgroundIndex: bg.index,
    scores,
    locks: session.lockedTraits,
    startedAt: session.startedAt ?? completedAt,
    completedAt,
    weekKey: gameWeekKey(completedMs),
  };
}

/**
 * Public/export snapshot: strip full owner wallet. Historical stored rows stay intact;
 * only outbound public DTOs/metadata omit the address.
 */
export function sanitizePublicCharacterSnapshot(
  snapshot: CharacterSnapshot,
): CharacterSnapshot {
  return {
    ...snapshot,
    ownerWallet: null,
    effectivePlayerName: snapshot.effectivePlayerName || "Guest player",
  };
}

export function buildLedMetadataJson(snapshot: CharacterSnapshot): string {
  const publicSnapshot = sanitizePublicCharacterSnapshot(snapshot);
  const attributes = [
    { trait_type: "Species", value: publicSnapshot.familyName },
    { trait_type: "Head Level", value: publicSnapshot.levels[0], max_value: 10 },
    { trait_type: "Head Stage", value: LED_STAGE_DESCRIPTIONS[0][publicSnapshot.levels[0]] },
    { trait_type: "Middle Level", value: publicSnapshot.levels[1], max_value: 10 },
    { trait_type: "Middle Stage", value: LED_STAGE_DESCRIPTIONS[1][publicSnapshot.levels[1]] },
    { trait_type: "Lower Level", value: publicSnapshot.levels[2], max_value: 10 },
    { trait_type: "Lower Stage", value: LED_STAGE_DESCRIPTIONS[2][publicSnapshot.levels[2]] },
    { trait_type: "Coat Palette", value: publicSnapshot.paletteName },
    { trait_type: "Palette Points", value: publicSnapshot.scores.palette },
    { trait_type: "Accessory", value: publicSnapshot.accessoryName },
    { trait_type: "Accessory Points", value: publicSnapshot.scores.accessory },
    { trait_type: "Background", value: publicSnapshot.backgroundName },
    { trait_type: "Background Points", value: publicSnapshot.scores.background },
    { trait_type: "Total Score", value: publicSnapshot.scores.total },
    { trait_type: "Policy Version", value: publicSnapshot.policyVersion },
    { trait_type: "Mode", value: publicSnapshot.mode === "ranked" ? "Ranked (Server Verified)" : "Guest Demo (Ephemeral)" },
    { trait_type: "Player", value: publicSnapshot.effectivePlayerName },
  ];
  return JSON.stringify(
    {
      name: `Squeek ${publicSnapshot.familyName} · ${publicSnapshot.paletteName} (${publicSnapshot.levels.join("/")})`,
      description:
        "Squeek Hatchery 1600x1600 LED portrait generated from real hamster wheel telemetry. Experimental policy preset: " +
        publicSnapshot.policyVersion,
      dimensions: { width: 1600, height: 1600 },
      snapshot: publicSnapshot,
      attributes,
    },
    null,
    2,
  );
}

/** Clear growth/time/locks while keeping chosen egg species (and lamp aim). */
export function clearAttemptProgressKeepingEgg(session: LedSession): LedSession {
  session.status = "egg";
  session.elapsed = 0;
  session.regions = [
    { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
    { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
    { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
  ];
  session.lockedTraits = null;
  session.startedAt = null;
  session.completedAt = null;
  session.backgroundIndex = null;
  session.backgroundId = null;
  session.workDuring = "0";
  return session;
}

/** Recursive scan helper for public DTO privacy regressions. */
export function collectJsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.push(k);
      collectJsonStrings(v, out);
    }
  }
  return out;
}

export interface StageRenderState {
  family: 0 | 1 | 2;
  levels: [number, number, number];
  palette: number;
  accessory: number;
  background: number;
}

/**
 * Confirmed Stage Reveal Rule (R9):
 * During `egg`, `running`, and `paused` states, the stage canvas displays only the
 * hamster (`accessory: -1`, `background: -1` neutral LED studio grid).
 * Only when `session.status === "completed"` does the stage reveal the locked
 * cyber accessory and the assigned LED background from the canonical CharacterSnapshot.
 */
export function getStageRenderStateForSession(
  session: LedSession,
  completedSnapshot: CharacterSnapshot | null,
  fallbackPaletteIndex = 0,
): StageRenderState {
  if (session.status === "completed") {
    if (completedSnapshot) {
      return {
        family: completedSnapshot.familyIndex,
        levels: completedSnapshot.levels,
        palette: completedSnapshot.paletteIndex,
        accessory: completedSnapshot.accessoryIndex,
        background: completedSnapshot.backgroundIndex,
      };
    }
    if (session.lockedTraits && session.backgroundIndex !== null) {
      return {
        family: session.familyIndex,
        levels: [
          session.regions[0].level,
          session.regions[1].level,
          session.regions[2].level,
        ],
        palette: session.lockedTraits.paletteIndex,
        accessory: session.lockedTraits.accessoryIndex,
        background: session.backgroundIndex,
      };
    }
  }

  const paletteIndex = session.lockedTraits
    ? session.lockedTraits.paletteIndex
    : clamp(Math.round(fallbackPaletteIndex), 0, 9);

  return {
    family: session.familyIndex,
    levels: [
      session.regions[0].level,
      session.regions[1].level,
      session.regions[2].level,
    ],
    palette: paletteIndex,
    accessory: -1,
    background: -1,
  };
}

/** Pre-confirmation stage/card preview uses the selected family; after confirm it is immutable. */
export function stageFamilyIndexForSelection(
  eggConfirmed: boolean,
  selectedFamilyIndex: 0 | 1 | 2,
  sessionFamilyIndex: 0 | 1 | 2,
): 0 | 1 | 2 {
  return eggConfirmed ? sessionFamilyIndex : selectedFamilyIndex;
}

/** Ranked mutations (aim/abandon/start) only apply when signed-in Ranked mode is active. */
export function playModeAllowsRankedMutation(
  hasAuthPlayer: boolean,
  activePlayMode: "ranked" | "demo",
): boolean {
  return Boolean(hasAuthPlayer) && activePlayMode === "ranked";
}

/** Demo mode must never aim or abandon a separate ranked session entitlement. */
export function rankedSessionMutationAllowed(
  hasAuthPlayer: boolean,
  activePlayMode: "ranked" | "demo",
  rankedSession: { status: string } | null | undefined,
): boolean {
  return (
    playModeAllowsRankedMutation(hasAuthPlayer, activePlayMode) &&
    Boolean(rankedSession) &&
    rankedSession!.status !== "completed"
  );
}

/** New Egg abandons an unfinished ranked egg only while Ranked mode is active. */
export function rankedAbandonOnNewEggAllowed(
  hasAuthPlayer: boolean,
  activePlayMode: "ranked" | "demo",
  rankedSession: { status: string } | null | undefined,
): boolean {
  return rankedSessionMutationAllowed(hasAuthPlayer, activePlayMode, rankedSession);
}

// ---------- Client Telemetry Freshness & Replay Baseline Tracker (R11) ----------

/**
 * Observation validity follows the policy capability `observationValidityCapMs`
 * (V1/V2: 15s, V3/V4: up to the reading's own staleAfter, capped at 120s).
 * This is not speed freshness: an ACTIVE reading older than 15s can stay valid
 * at base warmth until its original observed/received deadline.
 */
export function isClientReadingFresh(
  reading: Reading | null,
  nowMs: number,
  policy: GamePolicy = LATEST_GAME_POLICY,
): boolean {
  if (!reading) return false;
  const maxAgeMs = observationValidityLimitMs(reading, policy);
  if (nowMs - reading.observedAt > maxAgeMs) return false;
  if (nowMs - reading.received > maxAgeMs) return false;
  if (reading.observedAt - nowMs > 30_000 || reading.received - nowMs > 30_000) return false;
  return true;
}

/** Drop a ranked response that belongs to an older reset/attempt generation or another egg. */
export function shouldApplyRankedSessionResponse(input: {
  requestEpoch: number;
  currentEpoch: number;
  expectedSessionId: string | null;
  responseSessionId: string | null;
}): boolean {
  if (input.requestEpoch !== input.currentEpoch) return false;
  if (
    input.expectedSessionId &&
    input.responseSessionId &&
    input.expectedSessionId !== input.responseSessionId
  ) {
    return false;
  }
  return true;
}

export const STALE_RANKED_INTENT_ERROR = "Stale ranked intent.";

const RANKED_ATTEMPT_ID_RE = /^[A-Za-z0-9-]{8,80}$/;
const RANKED_AIM_INTENT_MAX = 1_000_000_000;

export type RankedOrderCommand =
  | { kind: "legacy" }
  | { kind: "ordered"; attemptId: string; aimIntent: number };

export function readRankedIntentOrder(value: unknown): RankedIntentOrder | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.attemptId !== "string" || !RANKED_ATTEMPT_ID_RE.test(raw.attemptId)) return null;
  if (
    typeof raw.aimIntent !== "number" ||
    !Number.isSafeInteger(raw.aimIntent) ||
    raw.aimIntent < 0 ||
    raw.aimIntent > RANKED_AIM_INTENT_MAX
  ) {
    return null;
  }
  if (typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return null;
  if (typeof raw.adopted !== "boolean") return null;
  return {
    attemptId: raw.attemptId,
    aimIntent: raw.aimIntent,
    revision: raw.revision,
    adopted: raw.adopted,
  };
}

export function rankedAttemptIsStale(order: RankedIntentOrder | null, command: RankedOrderCommand): boolean {
  if (command.kind !== "ordered" || !order) return false;
  return order.attemptId !== command.attemptId;
}

export function rotateRankedIntentOrder(order: RankedIntentOrder | null, nextAttemptId: string): RankedIntentOrder {
  return {
    attemptId: nextAttemptId,
    aimIntent: 0,
    revision: order?.revision ?? 0,
    adopted: order?.adopted ?? false,
  };
}

export interface RankedLampDecision {
  order: RankedIntentOrder;
  lampPosition: number;
  staleAttempt: boolean;
}

/**
 * Accept a newer aim intent, ignore a duplicate or older one, and keep legacy
 * lamp writes only until the session has adopted ordered intents.
 * The caller accrues the preceding interval before applying the returned lamp.
 */
export function decideRankedLampUpdate(input: {
  order: RankedIntentOrder | null;
  command: RankedOrderCommand;
  currentLamp: number;
  requestedLamp: number | null;
  assignAttemptId: () => string;
}): RankedLampDecision {
  const existing = input.order ? { ...input.order } : null;
  if (existing && rankedAttemptIsStale(existing, input.command)) {
    return { order: existing, lampPosition: input.currentLamp, staleAttempt: true };
  }
  const order: RankedIntentOrder = existing ?? {
    attemptId: input.command.kind === "ordered" ? input.command.attemptId : input.assignAttemptId(),
    aimIntent: 0,
    revision: 0,
    adopted: false,
  };
  if (input.requestedLamp === null) {
    return { order, lampPosition: input.currentLamp, staleAttempt: false };
  }
  if (input.command.kind === "legacy") {
    if (order.adopted) return { order, lampPosition: input.currentLamp, staleAttempt: false };
    return { order, lampPosition: input.requestedLamp, staleAttempt: false };
  }
  if (!order.adopted) {
    return {
      order: { ...order, adopted: true, aimIntent: input.command.aimIntent },
      lampPosition: input.requestedLamp,
      staleAttempt: false,
    };
  }
  if (input.command.aimIntent <= order.aimIntent) {
    return { order, lampPosition: input.currentLamp, staleAttempt: false };
  }
  return {
    order: { ...order, aimIntent: input.command.aimIntent },
    lampPosition: input.requestedLamp,
    staleAttempt: false,
  };
}

export interface RankedClientCursor {
  sessionId: string | null;
  attemptId: string | null;
  confirmedIntent: number;
  desiredIntent: number;
  desiredLamp: number | null;
  confirmedRevision: number;
  dragging: boolean;
}

export function createRankedClientCursor(): RankedClientCursor {
  return {
    sessionId: null,
    attemptId: null,
    confirmedIntent: 0,
    desiredIntent: 0,
    desiredLamp: null,
    confirmedRevision: -1,
    dragging: false,
  };
}

export function cursorFromRankedSession(session: LedSession): RankedClientCursor {
  const order = readRankedIntentOrder(session.intentOrder);
  return {
    sessionId: session.id,
    attemptId: order?.attemptId ?? null,
    confirmedIntent: order?.aimIntent ?? 0,
    desiredIntent: order?.aimIntent ?? 0,
    desiredLamp: session.lampPosition,
    confirmedRevision: order?.revision ?? -1,
    dragging: false,
  };
}

export function noteRankedDesiredAim(cursor: RankedClientCursor, lampPosition: number): RankedClientCursor {
  const lamp = clamp(Math.round(lampPosition), -100, 100);
  if (cursor.desiredLamp === lamp) return cursor;
  return { ...cursor, desiredLamp: lamp, desiredIntent: cursor.desiredIntent + 1 };
}

export interface RankedInstallDecision {
  apply: boolean;
  sideEffects: boolean;
  session: LedSession | null;
  cursor: RankedClientCursor;
}

function sessionWithLamp(session: LedSession, lampPosition: number): LedSession {
  if (session.lampPosition === lampPosition) return session;
  return { ...session, lampPosition };
}

/** Reject an older authoritative snapshot before it can roll back a newer or in-progress aim. */
export function decideRankedSessionInstall(input: {
  cursor: RankedClientCursor;
  incoming: LedSession;
  requestEpoch: number;
  currentEpoch: number;
  expectedSessionId: string | null;
}): RankedInstallDecision {
  if (
    !shouldApplyRankedSessionResponse({
      requestEpoch: input.requestEpoch,
      currentEpoch: input.currentEpoch,
      expectedSessionId: input.expectedSessionId,
      responseSessionId: input.incoming.id,
    })
  ) {
    return { apply: false, sideEffects: false, session: null, cursor: input.cursor };
  }
  const cursor = input.cursor;
  const incoming = input.incoming;
  if (cursor.sessionId && incoming.id !== cursor.sessionId) {
    return {
      apply: true,
      sideEffects: true,
      session: incoming,
      cursor: cursorFromRankedSession(incoming),
    };
  }
  const order = readRankedIntentOrder(incoming.intentOrder);
  const incomingRevision = order?.revision ?? null;
  if (
    cursor.sessionId === incoming.id &&
    incomingRevision !== null &&
    cursor.confirmedRevision >= 0 &&
    incomingRevision <= cursor.confirmedRevision
  ) {
    return { apply: false, sideEffects: false, session: null, cursor };
  }
  const incomingAttempt = order?.attemptId ?? null;
  const incomingIntent = order?.aimIntent ?? null;
  const rotated = Boolean(cursor.attemptId && incomingAttempt && cursor.attemptId !== incomingAttempt);
  if (rotated && order) {
    if (cursor.dragging && cursor.desiredLamp !== null) {
      return {
        apply: true,
        sideEffects: true,
        session: sessionWithLamp(incoming, cursor.desiredLamp),
        cursor: {
          sessionId: incoming.id,
          attemptId: order.attemptId,
          confirmedIntent: order.aimIntent,
          desiredIntent: order.aimIntent + 1,
          desiredLamp: cursor.desiredLamp,
          confirmedRevision: order.revision,
          dragging: true,
        },
      };
    }
    return {
      apply: true,
      sideEffects: true,
      session: incoming,
      cursor: cursorFromRankedSession(incoming),
    };
  }
  const desiredAhead =
    cursor.desiredLamp !== null && incomingIntent !== null && cursor.desiredIntent > incomingIntent;
  const confirmedAhead = incomingIntent !== null && incomingIntent < cursor.confirmedIntent;
  const keepDesired = cursor.desiredLamp !== null && (cursor.dragging || desiredAhead || confirmedAhead);
  const session = keepDesired ? sessionWithLamp(incoming, cursor.desiredLamp as number) : incoming;
  return {
    apply: true,
    sideEffects: true,
    session,
    cursor: {
      sessionId: incoming.id,
      attemptId: incomingAttempt ?? cursor.attemptId,
      confirmedIntent: Math.max(cursor.confirmedIntent, incomingIntent ?? cursor.confirmedIntent),
      desiredIntent: keepDesired ? cursor.desiredIntent : (incomingIntent ?? cursor.desiredIntent),
      desiredLamp: keepDesired ? cursor.desiredLamp : session.lampPosition,
      confirmedRevision: incomingRevision ?? cursor.confirmedRevision,
      dragging: cursor.dragging,
    },
  };
}

export function isStaleRankedIntentError(error: unknown): boolean {
  return error === STALE_RANKED_INTENT_ERROR;
}

/** A failed request from an older attempt or revision must not reset the healthy one. */
export function rankedCommandFailureIsCurrent(input: {
  requestEpoch: number;
  currentEpoch: number;
  expectedSessionId: string | null;
  cursor: RankedClientCursor;
  capturedAttemptId: string | null;
  capturedRevision: number;
  capturedSessionId: string | null;
}): boolean {
  if (
    !shouldApplyRankedSessionResponse({
      requestEpoch: input.requestEpoch,
      currentEpoch: input.currentEpoch,
      expectedSessionId: input.expectedSessionId,
      responseSessionId: input.expectedSessionId,
    })
  ) {
    return false;
  }
  if (
    input.capturedAttemptId &&
    input.cursor.attemptId &&
    input.capturedAttemptId !== input.cursor.attemptId
  ) {
    return false;
  }
  if (
    input.capturedSessionId &&
    input.cursor.sessionId &&
    input.capturedSessionId !== input.cursor.sessionId
  ) {
    return false;
  }
  if (
    input.capturedRevision >= 0 &&
    input.cursor.confirmedRevision >= 0 &&
    input.capturedRevision !== input.cursor.confirmedRevision
  ) {
    return false;
  }
  return true;
}

/** One announcement per session, region, and reached level. Replays of the same level do not flash again. */
export function levelUpAnnouncementKey(
  sessionId: string,
  region: 0 | 1 | 2,
  level: number,
): string {
  return `${sessionId}:${region}:${level}`;
}

export interface ClientTelemetrySnapshot {
  healthy: boolean;
  reading: Reading | null;
  error: string | null;
  dayStartWorkUnits: bigint;
  currentDayKey: string;
  isSpeedFresh: boolean;
  effectiveRpm: number;
  effectivePower: number;
  signalState: "ok" | "speed-unavailable" | "unavailable";
}

export interface ClientTelemetryTracker {
  beginRequest: () => number;
  ingestStatusPayload: (raw: unknown, requestSeq?: number) => ClientTelemetrySnapshot;
  ingestBackendReading: (
    serialized: {
      coreStatus: CoreStatus;
      rpm: number;
      meters: number;
      distanceMm: number;
      work: string;
      counterEpoch: string;
      installationId: string | null;
      observedAt: number;
      received: number;
      staleAfterSeconds: number;
      utcDate: string;
    },
    dayStartWorkUnitsStr?: string,
    requestSeq?: number,
  ) => ClientTelemetrySnapshot;
  recordPollFailure: (message: string, requestSeq?: number) => ClientTelemetrySnapshot;
  checkFreshnessForStep: (explicitNowMs?: number) => ClientTelemetrySnapshot;
  getState: () => ClientTelemetrySnapshot;
  setPolicy?: (policy: GamePolicy) => void;
}

export function createClientTelemetryTracker(options: {
  now?: () => number;
  policy?: GamePolicy;
} = {}): ClientTelemetryTracker {
  const nowFn = options.now ?? (() => Date.now());
  let policy = options.policy ?? LATEST_GAME_POLICY;
  let nextSeq = 0;
  let latestCompletedSeq = 0;
  let lastAcceptedReading: Reading | null = null;
  let healthy = false;
  let error: string | null = "Waiting for live hardware telemetry from wheel...";
  let dayStartWorkUnits = 0n;
  let currentDayKey = "";

  function getEffectiveState(nowMs: number): {
    isSpeedFresh: boolean;
    effectiveRpm: number;
    effectivePower: number;
    signalState: "ok" | "speed-unavailable" | "unavailable";
  } {
    if (!lastAcceptedReading || !healthy) {
      return {
        isSpeedFresh: false,
        effectiveRpm: 0,
        effectivePower: 0,
        signalState: "unavailable",
      };
    }
    const ageMs = Math.max(0, nowMs - lastAcceptedReading.observedAt);
    if (lastAcceptedReading.coreStatus === "ACTIVE") {
      if (ageMs <= 15_000) {
        return {
          isSpeedFresh: true,
          effectiveRpm: lastAcceptedReading.rpm,
          effectivePower: ledLampPower(lastAcceptedReading.rpm, policy),
          signalState: "ok",
        };
      } else {
        return {
          isSpeedFresh: false,
          effectiveRpm: 0,
          effectivePower: policy.baseLampPower,
          signalState: "speed-unavailable",
        };
      }
    } else {
      // IDLE
      return {
        isSpeedFresh: true,
        effectiveRpm: 0,
        effectivePower: policy.baseLampPower,
        signalState: "ok",
      };
    }
  }

  function snapshot(explicitNowMs?: number): ClientTelemetrySnapshot {
    const nowMs = explicitNowMs ?? nowFn();
    const eff = getEffectiveState(nowMs);
    return {
      healthy,
      reading: lastAcceptedReading,
      error,
      dayStartWorkUnits,
      currentDayKey,
      isSpeedFresh: eff.isSpeedFresh,
      effectiveRpm: eff.effectiveRpm,
      effectivePower: eff.effectivePower,
      signalState: eff.signalState,
    };
  }

  function applyValidatedReading(next: Reading, serverDayStartWork?: bigint): void {
    const prev = lastAcceptedReading;
    if (!currentDayKey) {
      currentDayKey = next.utcDate;
      dayStartWorkUnits = serverDayStartWork !== undefined ? serverDayStartWork : next.work;
    } else if (next.utcDate !== currentDayKey) {
      currentDayKey = next.utcDate;
      dayStartWorkUnits = serverDayStartWork !== undefined ? serverDayStartWork : (prev ? prev.work : next.work);
    } else if (prev && !sameReportingHistory(prev, next)) {
      dayStartWorkUnits = serverDayStartWork !== undefined ? serverDayStartWork : next.work;
    } else if (serverDayStartWork !== undefined) {
      dayStartWorkUnits = serverDayStartWork;
    }

    lastAcceptedReading = next;
    healthy = true;
    error = null;
  }

  return {
    beginRequest(): number {
      nextSeq += 1;
      return nextSeq;
    },

    ingestStatusPayload(raw: unknown, requestSeq?: number): ClientTelemetrySnapshot {
      if (requestSeq !== undefined) {
        if (requestSeq < latestCompletedSeq) {
          return snapshot();
        }
        latestCompletedSeq = requestSeq;
      }
      const nowMs = nowFn();
      try {
        // Always pass lastAcceptedReading so replay baseline survives transient outages!
        const validated = validateStatus(raw, nowMs, lastAcceptedReading);
        if (lastAcceptedReading && validated.observedAt === lastAcceptedReading.observedAt) {
          // Unchanged observation: do not extend freshness or resurrect an expired/stale reading!
          if (!isClientReadingFresh(validated, nowMs, policy)) {
            healthy = false;
            error = "Hardware telemetry expired; illumination paused.";
            return snapshot(nowMs);
          }
        }
        applyValidatedReading(validated);
      } catch (err) {
        healthy = false;
        error =
          err instanceof SignalError
            ? `Hardware telemetry rejected (${err.reason}): ${err.message}`
            : err instanceof Error
              ? err.message
              : "Hardware telemetry unavailable.";
      }
      return snapshot();
    },

    ingestBackendReading(serialized, dayStartWorkUnitsStr, requestSeq): ClientTelemetrySnapshot {
      if (requestSeq !== undefined) {
        if (requestSeq < latestCompletedSeq) {
          return snapshot();
        }
        latestCompletedSeq = requestSeq;
      }
      // Freshness is always judged against the local clock. Backend `updatedAtMs` is a cache/ingestion
      // timestamp, not the response time, so it must never be used to infer clock skew (R14).
      const nowMs = nowFn();
      try {
        const candidate: Reading = {
          coreStatus: serialized.coreStatus === "ACTIVE" ? "ACTIVE" : "IDLE",
          rpm: Number(serialized.rpm) || 0,
          meters: Number(serialized.meters) || 0,
          distanceMm: Number(serialized.distanceMm) || 0,
          work: BigInt(serialized.work || "0"),
          counterEpoch: String(serialized.counterEpoch || "epoch-0"),
          installationId: serialized.installationId ?? undefined,
          observedAt: Number(serialized.observedAt),
          received: Number(serialized.received),
          staleAfterSeconds: Number(serialized.staleAfterSeconds) || 60,
          utcDate: String(serialized.utcDate || measurementDayKey(nowMs)),
        };

        if (lastAcceptedReading && sameReportingHistory(lastAcceptedReading, candidate)) {
          if (candidate.observedAt < lastAcceptedReading.observedAt) {
            throw new SignalError("replayed", "Telemetry observation is older than the retained baseline.");
          }
          if (candidate.work < lastAcceptedReading.work) {
            throw new SignalError("replayed", "Cumulative work regressed within the same counterEpoch.");
          }
          if (
            candidate.utcDate === lastAcceptedReading.utcDate &&
            candidate.distanceMm < lastAcceptedReading.distanceMm
          ) {
            throw new SignalError("replayed", "Daily distance regressed within the same measurement day.");
          }
          if (candidate.observedAt === lastAcceptedReading.observedAt) {
            if (
              candidate.work !== lastAcceptedReading.work ||
              candidate.distanceMm !== lastAcceptedReading.distanceMm ||
              candidate.coreStatus !== lastAcceptedReading.coreStatus ||
              Math.abs(candidate.rpm - lastAcceptedReading.rpm) > 1e-6
            ) {
              throw new SignalError("replayed", "Conflicting telemetry values at identical observedAt.");
            }
            // Equal observation timestamp must never extend receipt freshness!
            candidate.received = lastAcceptedReading.received;
          }
        }

        if (!isClientReadingFresh(candidate, nowMs, policy)) {
          throw new SignalError("stale", "Hardware reading exceeded validity TTL.");
        }

        const serverDayStart =
          dayStartWorkUnitsStr !== undefined ? BigInt(dayStartWorkUnitsStr) : undefined;
        applyValidatedReading(candidate, serverDayStart);
      } catch (err) {
        healthy = false;
        error =
          err instanceof SignalError
            ? `Hardware telemetry rejected (${err.reason}): ${err.message}`
            : err instanceof Error
              ? err.message
              : "Hardware telemetry unavailable.";
      }
      return snapshot();
    },

    recordPollFailure(message: string, requestSeq?: number): ClientTelemetrySnapshot {
      if (requestSeq !== undefined) {
        if (requestSeq < latestCompletedSeq) {
          return snapshot();
        }
        latestCompletedSeq = requestSeq;
      }
      healthy = false;
      error = message || "Live hardware telemetry unavailable.";
      return snapshot();
    },

    checkFreshnessForStep(explicitNowMs?: number): ClientTelemetrySnapshot {
      const nowMs = explicitNowMs ?? nowFn();
      if (!lastAcceptedReading || !isClientReadingFresh(lastAcceptedReading, nowMs, policy)) {
        healthy = false;
        error ||= "Hardware telemetry expired; illumination paused.";
        if (lastAcceptedReading && !isClientReadingFresh(lastAcceptedReading, nowMs, policy)) {
          error = "Hardware telemetry expired; illumination paused.";
        }
      }
      return snapshot(nowMs);
    },

    getState(): ClientTelemetrySnapshot {
      return snapshot();
    },

    setPolicy(p: GamePolicy): void {
      policy = p;
    },
  };
}


