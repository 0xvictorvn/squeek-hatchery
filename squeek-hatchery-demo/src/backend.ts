import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress, recoverMessageAddress } from "viem";
import {
  DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
  DEFAULT_GAME_POLICY,
  EXPERIMENTAL_POLICY_V1,
  EXPERIMENTAL_POLICY_V2,
  FAMILIES,
  KNOWN_GAME_POLICIES,
  LATEST_GAME_POLICY,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  PALETTES,
  accessoryByIndex,
  accessoryScheduleAt,
  backgroundByIndex,
  checkWalletEligibility,
  compareLeaderboardCandidates,
  deriveBackgroundRarityModel,
  familyById,
  familyByIndex,
  gameWeekKey,
  paletteByIndex,
  paletteScheduleAt,
  pickRandomBackgroundIndex,
  rarityTierForPoints,
  resolveKnownGamePolicy,
  validateGamePolicy,
  type AccessoryCatalogItem,
  type FamilyId,
  type GamePolicy,
  type PaletteCatalogItem,
  type ScheduleWindowState,
  type SortableLeaderboardCandidate,
  type TraitPoints,
  type WalletEligibilityContext,
} from "./game-policy.ts";
import {
  buildCharacterSnapshot,
  buildLedMetadataJson,
  clearAttemptProgressKeepingEgg,
  createLedSession,
  formatEffectivePlayerName,
  lockSessionTraits,
  sanitizePublicCharacterSnapshot,
  shortWalletAddress,
  stepLedSession,
  validatePlayerDisplayName,
  type CharacterSnapshot,
  type LedSession,
} from "./led-session.ts";
import {
  SignalError,
  clamp,
  distanceDeltaMm,
  isObservationValid,
  measurementDayKey,
  observationValidityLimitMs,
  sameReportingHistory,
  validateStatus,
  workDelta,
  type Reading,
} from "./rules.ts";

export const SESSION_COOKIE_NAME = "squeek_session";
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_CHAIN_ID = 11155111;
export const UPSTREAM_TELEMETRY_URL = "https://api.squeekchain.com/v1/status";
export const MAX_RANKED_STEP_MS = 20_000;

const FORBIDDEN_CLIENT_AUTHORITATIVE_KEYS = new Set([
  "score",
  "totalScore",
  "scores",
  "regionScore",
  "regionsTotal",
  "traitScore",
  "harmonyBonus",
  "fullChargeBonus",
  "elapsed",
  "elapsedSeconds",
  "totalIlluminatedSeconds",
  "level",
  "levels",
  "regionLevels",
  "integerLevels",
  "continuousLevels",
  "dose",
  "doses",
  "regionDoses",
  "regions",
  "rpm",
  "rpmMilli",
  "lastRpmMilli",
  "work",
  "totalWork",
  "cumulativeWorkUnits",
  "distance",
  "distanceMm",
  "totalDistanceMm",
  "dailyDistanceMm",
  "palette",
  "paletteId",
  "paletteIndex",
  "lockedPaletteIndex",
  "accessory",
  "accessoryId",
  "accessoryIndex",
  "lockedAccessoryIndex",
  "background",
  "backgroundId",
  "backgroundIndex",
  "assignedBackgroundIndex",
  "random",
  "seed",
  "completedAt",
  "resultId",
]);

export interface SerializedReading {
  coreStatus: "ACTIVE" | "IDLE";
  rpm: number;
  rpmMilli: number;
  meters: number;
  distanceMm: number;
  work: string;
  counterEpoch: string;
  installationId: string | null;
  observedAt: number;
  observedAtIso: string;
  received: number;
  staleAfterSeconds: number;
  utcDate: string;
}

export interface SerializedScheduleWindow {
  step: string;
  itemIndex: number;
  itemId: string;
  itemName: string;
  points: number;
  tier: string;
  isRareWindow: boolean;
  remainingInStep: string | number;
  nextItemIndex: number;
  nextItemId: string;
  nextItemName: string;
  nextPoints: number;
  dailyRareWindowsOpened: {
    rare4A: number;
    rare4B: number;
    apex8: number;
    totalRare: number;
  };
  dailyRareCaps: {
    rare4A: number;
    rare4B: number;
    apex8: number;
  };
}

export interface HardwareTelemetrySnapshot {
  reading: Reading;
  serializedReading: SerializedReading;
  source: "live" | "fallback" | "simulated";
  measurementDayKey: string;
  dailyDistanceMm: number;
  scheduleDistanceMm: number;
  cumulativeWorkUnits: string;
  dayStartWorkUnits: string;
  paletteSchedule: ScheduleWindowState<PaletteCatalogItem>;
  accessorySchedule: ScheduleWindowState<AccessoryCatalogItem>;
  serializedPaletteSchedule: SerializedScheduleWindow;
  serializedAccessorySchedule: SerializedScheduleWindow;
  updatedAtMs: number;
  signal?: {
    state: "ok" | "speed-unavailable" | "unavailable";
    message: string;
  };
}

export interface DailyAllowanceDto {
  remaining: number;
  total: number;
  completedToday: number;
  resetsAtUtc: string;
}

export interface PlayerProfile {
  walletAddress: string;
  shortWallet: string;
  displayName: string | null;
  effectiveName: string;
  chainId: number;
  sessionExpiresAt?: string;
}

export interface LeaderboardEntryDto {
  rank: number;
  resultId: string;
  sessionId: string;
  shortWallet: string;
  displayName: string | null;
  effectiveName: string;
  weekKey: string;
  measurementDayKey: string;
  policyVersion: string;
  familyId: FamilyId;
  familyName: string;
  levels: [number, number, number];
  palette: { id: string; name: string; index: number; points: number; tier: string };
  accessory: { id: string; name: string; index: number; points: number; tier: string };
  background: { id: string; name: string; index: number; points: number; tier: string };
  scores: {
    head: number;
    middle: number;
    lower: number;
    regionsTotal: number;
    palette: number;
    accessory: number;
    background: number;
    total: number;
  };
  completedAt: string;
}

export interface BackendOptions {
  dbPath?: string;
  policy?: GamePolicy;
  now?: () => number;
  csprngInt?: (maxExclusive: number) => number;
  hardwareTimeoutMs?: number;
  autoStartProducer?: boolean;
  hardwareProvider?: () =>
    | Promise<{
        reading?: Reading;
        statusPayload?: unknown;
        source: "live" | "fallback" | "simulated";
      }>
    | {
        reading?: Reading;
        statusPayload?: unknown;
        source: "live" | "fallback" | "simulated";
      };
  eligibilityContextProvider?: (walletAddress: string) => WalletEligibilityContext;
  allowedOrigins?: string[];
}

export function utcCalendarDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightIso(nowMs: number): string {
  const d = new Date(nowMs);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0));
  return next.toISOString();
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        out[key] = decodeURIComponent(val);
      } catch {
        out[key] = val;
      }
    }
  }
  return out;
}

function serializeScheduleWindow<T extends { id: string; name: string }>(
  win: ScheduleWindowState<T>,
): SerializedScheduleWindow {
  return {
    step: win.step.toString(),
    itemIndex: win.itemIndex,
    itemId: win.item.id,
    itemName: win.item.name,
    points: win.points,
    tier: win.tier,
    isRareWindow: win.isRareWindow,
    remainingInStep:
      typeof win.remainingInStep === "bigint"
        ? win.remainingInStep.toString()
        : win.remainingInStep,
    nextItemIndex: win.nextItemIndex,
    nextItemId: win.nextItem.id,
    nextItemName: win.nextItem.name,
    nextPoints: win.nextPoints,
    dailyRareWindowsOpened: win.dailyRareWindowsOpened,
    dailyRareCaps: win.dailyRareCaps,
  };
}

function serializeReading(reading: Reading): SerializedReading {
  return {
    coreStatus: reading.coreStatus,
    rpm: reading.rpm,
    rpmMilli: Math.round(reading.rpm * 1000),
    meters: reading.meters,
    distanceMm: reading.distanceMm,
    work: reading.work.toString(),
    counterEpoch: reading.counterEpoch,
    installationId: reading.installationId ?? null,
    observedAt: reading.observedAt,
    observedAtIso: new Date(reading.observedAt).toISOString(),
    received: reading.received,
    staleAfterSeconds: reading.staleAfterSeconds,
    utcDate: reading.utcDate,
  };
}

export function buildSiweChallengeMessage(params: {
  domain: string;
  walletAddress: string;
  statement: string;
  origin: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.walletAddress,
    "",
    params.statement,
    "",
    `URI: ${params.origin}`,
    `Version: 1`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
    `Expiration Time: ${params.expiresAt}`,
  ].join("\n");
}

function resolveLampPositionFromInput(body: Record<string, unknown>, fallback = -70): number {
  if (typeof body.lampPosition === "number" && Number.isFinite(body.lampPosition)) {
    return clamp(body.lampPosition, -100, 100);
  }
  if (body.activeRegion === "head" || body.activeRegion === 0) return -70;
  if (body.activeRegion === "middle" || body.activeRegion === "torso" || body.activeRegion === 1) {
    return 0;
  }
  if (body.activeRegion === "lower" || body.activeRegion === "hips" || body.activeRegion === 2) {
    return 70;
  }
  return fallback;
}

function resolveFamilyIndexFromInput(body: Record<string, unknown>): 0 | 1 | 2 {
  if (body.familyIndex === 0 || body.familyIndex === 1 || body.familyIndex === 2) {
    return body.familyIndex;
  }
  if (typeof body.familyId === "string") {
    const found = familyById(body.familyId);
    if (found) return found.index;
  }
  throw new HttpError(400, "familyId must be pulse, relay, or prism (or familyIndex 0..2).");
}

function readingSatisfiesPolicyObservation(
  reading: Reading,
  nowMs: number,
  policy?: { version?: string; observationValidityCapMs?: number } | null,
): boolean {
  if (policy && typeof policy.observationValidityCapMs === "number") {
    return isObservationValid(reading, nowMs, policy);
  }
  return isReadingFresh(reading, nowMs);
}

export function isReadingFresh(reading: Reading, nowMs: number): boolean {
  const freshLimitMs = Math.min(
    15000,
    (reading.staleAfterSeconds > 0 ? reading.staleAfterSeconds : 60) * 1000,
  );
  if (reading.observedAt > nowMs + 5000) return false;
  if (nowMs - reading.received > freshLimitMs) return false;
  if (nowMs - reading.observedAt > freshLimitMs) return false;
  return true;
}

export function coerceToReading(
  raw: unknown,
  nowMs: number,
  previous: Reading | null = null,
  enforceFreshness = true,
  policy?: GamePolicy,
): Reading {
  if (
    raw &&
    typeof raw === "object" &&
    "work" in raw &&
    typeof (raw as Reading).work === "bigint" &&
    "coreStatus" in raw
  ) {
    const r: Reading = { ...(raw as Reading) };
    if (previous && sameReportingHistory(previous, r)) {
      if (r.observedAt < previous.observedAt) {
        throw new HttpError(503, "Hardware telemetry rejected (replay): Older observation.");
      }
      const sameObs =
        r.observedAt === previous.observedAt &&
        r.work === previous.work &&
        r.distanceMm === previous.distanceMm &&
        r.coreStatus === previous.coreStatus &&
        Math.round(r.rpm * 1000) === Math.round(previous.rpm * 1000);
      if (sameObs) {
        r.received = previous.received;
      }
    }
    if (enforceFreshness && !readingSatisfiesPolicyObservation(r, nowMs, policy)) {
      throw new HttpError(
        503,
        "Hardware telemetry rejected (stale): Reading exceeded observation TTL.",
      );
    }
    return r;
  }
  if (raw && typeof raw === "object" && (raw as Record<string, unknown>).schemaVersion === 1) {
    try {
      const validated = validateStatus(raw, nowMs, previous);
      if (enforceFreshness && !readingSatisfiesPolicyObservation(validated, nowMs, policy)) {
        throw new HttpError(
          503,
          "Hardware telemetry rejected (stale): Reading exceeded observation TTL.",
        );
      }
      return validated;
    } catch (err) {
      if (err instanceof SignalError) {
        throw new HttpError(
          503,
          `Hardware telemetry rejected (${err.reason}): ${err.message}`,
        );
      }
      throw err;
    }
  }
  throw new HttpError(
    503,
    "Unrecognized hardware telemetry payload; schemaVersion 1 status payload required.",
  );
}

export interface LeaderboardStrategy {
  selectTopEntries(
    rows: Record<string, unknown>[],
    limit: number,
  ): Record<string, unknown>[];
}

export class BestPerWalletWeeklyLeaderboardStrategy implements LeaderboardStrategy {
  selectTopEntries(
    rows: Record<string, unknown>[],
    limit: number,
  ): Record<string, unknown>[] {
    const bestByWallet = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      const walletKey = String(row.wallet_address);
      const existing = bestByWallet.get(walletKey);
      if (!existing) {
        bestByWallet.set(walletKey, row);
        continue;
      }
      const candA: SortableLeaderboardCandidate = {
        resultId: String(row.result_id),
        totalScore: Number(row.total_score),
        regionScore: Number(row.region_score),
        completedAtMs: Number(row.completed_at_ms),
      };
      const candB: SortableLeaderboardCandidate = {
        resultId: String(existing.result_id),
        totalScore: Number(existing.total_score),
        regionScore: Number(existing.region_score),
        completedAtMs: Number(existing.completed_at_ms),
      };
      if (compareLeaderboardCandidates(candA, candB) < 0) {
        bestByWallet.set(walletKey, row);
      }
    }

    const chosenRows = [...bestByWallet.values()];
    chosenRows.sort((a, b) =>
      compareLeaderboardCandidates(
        {
          resultId: String(a.result_id),
          totalScore: Number(a.total_score),
          regionScore: Number(a.region_score),
          completedAtMs: Number(a.completed_at_ms),
        },
        {
          resultId: String(b.result_id),
          totalScore: Number(b.total_score),
          regionScore: Number(b.region_score),
          completedAtMs: Number(b.completed_at_ms),
        },
      ),
    );

    return chosenRows.slice(0, limit);
  }
}

export class HatcheryBackend {
  readonly db: DatabaseSync;
  readonly policy: GamePolicy;
  private readonly now: () => number;
  private readonly csprngInt: (maxExclusive: number) => number;
  private readonly hardwareTimeoutMs: number;
  private readonly hardwareProvider?: BackendOptions["hardwareProvider"];
  private readonly eligibilityContextProvider?: BackendOptions["eligibilityContextProvider"];
  private readonly allowedOrigins: Set<string>;

  private hardwareState: {
    lastReading: Reading;
    dayKey: string;
    dayAnchorKind: "rollover" | "reanchored";
    dailyDistanceMm: number;
    scheduleDistanceMm: number;
    cumulativeWorkUnits: bigint;
    dayStartWorkUnits: bigint;
  } | null = null;

  private lastHardwareFetchMs = 0;
  private lastHardwareFetchRealMs = 0;
  private cachedTelemetry: HardwareTelemetrySnapshot | null = null;
  private producerTimer: NodeJS.Timeout | null = null;
  private producerInFlight = false;
  private producerPromise: Promise<void> | null = null;
  private autoStartProducer: boolean;
  private lastProducerError: { message: string; statusCode: number; isFault: boolean } | null = null;
  private lastProducerAttemptMs = 0;
  private lastProducerAttemptRealMs = 0;
  private monotonicDistanceMm = 0;

  constructor(options: BackendOptions = {}) {
    const dbPath = options.dbPath ?? ":memory:";
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.policy = options.policy ?? DEFAULT_GAME_POLICY;
    this.now = options.now ?? (() => Date.now());
    this.csprngInt = options.csprngInt ?? ((maxExclusive) => randomInt(0, maxExclusive));
    this.hardwareTimeoutMs = Math.max(50, options.hardwareTimeoutMs ?? 3000);
    this.hardwareProvider = options.hardwareProvider;
    this.eligibilityContextProvider = options.eligibilityContextProvider;
    this.allowedOrigins = new Set(options.allowedOrigins ?? []);
    this.autoStartProducer = options.autoStartProducer ?? false;
    this.initSchema();
    this.loadHardwareStateFromDb();
    if (this.autoStartProducer) {
      this.startProducer();
    }
  }

  private initSchema(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS hardware_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        day_key TEXT NOT NULL,
        day_anchor_kind TEXT NOT NULL,
        installation_id TEXT,
        counter_epoch TEXT NOT NULL,
        daily_distance_mm INTEGER NOT NULL,
        schedule_distance_mm INTEGER NOT NULL,
        cumulative_work_units TEXT NOT NULL,
        day_start_work_units TEXT NOT NULL,
        last_reading_json TEXT NOT NULL,
        source TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS players (
        wallet_address TEXT PRIMARY KEY,
        checksum_address TEXT NOT NULL,
        display_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_challenges (
        challenge_id TEXT PRIMARY KEY,
        nonce TEXT NOT NULL UNIQUE,
        wallet_address TEXT NOT NULL,
        checksum_address TEXT NOT NULL,
        domain TEXT NOT NULL,
        origin TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        message TEXT NOT NULL,
        used_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        checksum_address TEXT NOT NULL,
        chain_id INTEGER NOT NULL,
        origin TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ranked_sessions (
        session_id TEXT PRIMARY KEY,
        wallet_address TEXT NOT NULL,
        checksum_address TEXT NOT NULL,
        family_index INTEGER NOT NULL,
        family_id TEXT NOT NULL,
        lamp_position REAL NOT NULL,
        status TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        policy_snapshot_json TEXT,
        created_at_ms INTEGER NOT NULL,
        last_step_at_ms INTEGER,
        session_json TEXT NOT NULL,
        assigned_background_index INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ranked_sessions_wallet_status
        ON ranked_sessions(wallet_address, status);

      CREATE TABLE IF NOT EXISTS hatched_results (
        result_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL UNIQUE,
        wallet_address TEXT NOT NULL,
        checksum_address TEXT NOT NULL,
        display_name_snapshot TEXT,
        week_key TEXT NOT NULL,
        measurement_day_key TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        family_id TEXT NOT NULL,
        head_level INTEGER NOT NULL,
        middle_level INTEGER NOT NULL,
        lower_level INTEGER NOT NULL,
        palette_id TEXT NOT NULL,
        palette_index INTEGER NOT NULL,
        palette_points INTEGER NOT NULL,
        accessory_id TEXT NOT NULL,
        accessory_index INTEGER NOT NULL,
        accessory_points INTEGER NOT NULL,
        background_id TEXT NOT NULL,
        background_index INTEGER NOT NULL,
        background_points INTEGER NOT NULL,
        region_score INTEGER NOT NULL,
        total_score INTEGER NOT NULL,
        completed_at TEXT NOT NULL,
        completed_at_ms INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hatched_results_week_policy
        ON hatched_results(week_key, policy_version, total_score DESC, region_score DESC, completed_at_ms ASC);

      CREATE TABLE IF NOT EXISTS trait_transition_state (
        category TEXT PRIMARY KEY,
        current_ordinary_index INTEGER NOT NULL,
        next_ordinary_index INTEGER NOT NULL,
        last_transition_threshold INTEGER NOT NULL,
        active_special_event_id INTEGER,
        active_special_index INTEGER
      );

      CREATE TABLE IF NOT EXISTS special_schedule_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        utc_date TEXT NOT NULL,
        stratum_index INTEGER NOT NULL,
        event_time_ms INTEGER NOT NULL,
        special_trait_index INTEGER NOT NULL,
        consumed_by_transition INTEGER DEFAULT 0,
        UNIQUE(category, utc_date, stratum_index)
      );

      CREATE INDEX IF NOT EXISTS idx_special_events_lookup
        ON special_schedule_events(category, event_time_ms, consumed_by_transition);
    `);
    try {
      this.db.exec(`ALTER TABLE ranked_sessions ADD COLUMN policy_snapshot_json TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE trait_transition_state ADD COLUMN accumulated_progress INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE special_schedule_events ADD COLUMN opened_at INTEGER`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE special_schedule_events ADD COLUMN consumed_at INTEGER`);
    } catch {
      // Column already exists
    }
  }

  private serializeGamePolicy(policy: GamePolicy): string {
    return JSON.stringify({
      ...policy,
      accessoryWorkStep: policy.accessoryWorkStep.toString(),
    });
  }

  private deserializeGamePolicy(rawJson: string): GamePolicy | null {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      const restored: GamePolicy = {
        ...(parsed as unknown as GamePolicy),
        accessoryWorkStep: BigInt(String(parsed.accessoryWorkStep ?? "0")),
      };
      return validateGamePolicy(restored);
    } catch {
      return null;
    }
  }

  private resolvePolicyForSessionRow(row: Record<string, unknown>): GamePolicy {
    const version = String(row.policy_version ?? "");
    if (version === this.policy.version) {
      return this.policy;
    }
    const known = resolveKnownGamePolicy(version);
    if (known) {
      return known;
    }
    if (typeof row.policy_snapshot_json === "string" && row.policy_snapshot_json.trim()) {
      const restored = this.deserializeGamePolicy(row.policy_snapshot_json);
      if (restored && restored.version === version) {
        return restored;
      }
    }
    throw new HttpError(
      409,
      `Session policy version "${version}" is no longer supported. Please abandon this egg and claim a new egg.`,
    );
  }

  private loadHardwareStateFromDb(): void {
    const row = this.db
      .prepare(`SELECT * FROM hardware_state WHERE singleton_id = 1`)
      .get() as Record<string, unknown> | undefined;
    if (!row) return;

    try {
      const rawReading = JSON.parse(String(row.last_reading_json)) as SerializedReading;
      const lastReading: Reading = {
        coreStatus: rawReading.coreStatus,
        rpm: Number(rawReading.rpm),
        meters: Number(rawReading.meters),
        distanceMm: Number(rawReading.distanceMm),
        work: BigInt(rawReading.work),
        counterEpoch: String(rawReading.counterEpoch),
        installationId: rawReading.installationId ?? undefined,
        observedAt: Number(rawReading.observedAt),
        received: Number(rawReading.received),
        staleAfterSeconds: Number(rawReading.staleAfterSeconds),
        utcDate: String(rawReading.utcDate),
      };
      const dayKey = String(row.day_key);
      const dayAnchorKind =
        row.day_anchor_kind === "rollover" ? "rollover" : "reanchored";
      const dailyDistanceMm = Number(row.daily_distance_mm);
      const scheduleDistanceMm = Number(row.schedule_distance_mm);
      const cumulativeWorkUnits = BigInt(String(row.cumulative_work_units));
      const dayStartWorkUnits = BigInt(String(row.day_start_work_units));

      this.hardwareState = {
        lastReading,
        dayKey,
        dayAnchorKind,
        dailyDistanceMm,
        scheduleDistanceMm,
        cumulativeWorkUnits,
        dayStartWorkUnits,
      };

      const effectiveReading: Reading = {
        ...lastReading,
        utcDate: dayKey,
        distanceMm: scheduleDistanceMm,
        meters: scheduleDistanceMm / 1000,
        work: cumulativeWorkUnits,
      };

      const pRow = this.db
        .prepare(`SELECT accumulated_progress FROM trait_transition_state WHERE category = 'palette'`)
        .get() as { accumulated_progress?: number } | undefined;
      // Zero-progress fallback restores raw schedule distance; nonzero partials must be restored as-is.
      this.monotonicDistanceMm = pRow?.accumulated_progress
        ? Number(pRow.accumulated_progress)
        : scheduleDistanceMm;

      const restoredAtMs = Number(row.updated_at_ms);
      const { paletteSchedule, accessorySchedule } = this.buildScheduleWindows(
        this.monotonicDistanceMm,
        cumulativeWorkUnits,
        dayStartWorkUnits,
        scheduleDistanceMm,
        restoredAtMs,
      );
      this.cachedTelemetry = {
        reading: effectiveReading,
        serializedReading: serializeReading(effectiveReading),
        source: "live",
        measurementDayKey: dayKey,
        dailyDistanceMm,
        scheduleDistanceMm,
        cumulativeWorkUnits: cumulativeWorkUnits.toString(),
        dayStartWorkUnits: dayStartWorkUnits.toString(),
        paletteSchedule,
        accessorySchedule,
        serializedPaletteSchedule: serializeScheduleWindow(paletteSchedule),
        serializedAccessorySchedule: serializeScheduleWindow(accessorySchedule),
        updatedAtMs: restoredAtMs,
      };
    } catch {
      this.hardwareState = null;
      this.cachedTelemetry = null;
    }
  }

  private cloneHardwareState(
    state: NonNullable<HatcheryBackend["hardwareState"]>,
  ): NonNullable<HatcheryBackend["hardwareState"]> {
    return {
      lastReading: { ...state.lastReading },
      dayKey: state.dayKey,
      dayAnchorKind: state.dayAnchorKind,
      dailyDistanceMm: state.dailyDistanceMm,
      scheduleDistanceMm: state.scheduleDistanceMm,
      cumulativeWorkUnits: state.cumulativeWorkUnits,
      dayStartWorkUnits: state.dayStartWorkUnits,
    };
  }

  private saveHardwareStateToDb(
    state: NonNullable<HatcheryBackend["hardwareState"]>,
    source: string,
    updatedAtMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO hardware_state (
          singleton_id, day_key, day_anchor_kind, installation_id, counter_epoch,
          daily_distance_mm, schedule_distance_mm, cumulative_work_units, day_start_work_units,
          last_reading_json, source, updated_at_ms
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(singleton_id) DO UPDATE SET
          day_key = excluded.day_key,
          day_anchor_kind = excluded.day_anchor_kind,
          installation_id = excluded.installation_id,
          counter_epoch = excluded.counter_epoch,
          daily_distance_mm = excluded.daily_distance_mm,
          schedule_distance_mm = excluded.schedule_distance_mm,
          cumulative_work_units = excluded.cumulative_work_units,
          day_start_work_units = excluded.day_start_work_units,
          last_reading_json = excluded.last_reading_json,
          source = excluded.source,
          updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        state.dayKey,
        state.dayAnchorKind,
        state.lastReading.installationId ?? null,
        state.lastReading.counterEpoch,
        state.dailyDistanceMm,
        state.scheduleDistanceMm,
        state.cumulativeWorkUnits.toString(),
        state.dayStartWorkUnits.toString(),
        JSON.stringify(serializeReading(state.lastReading)),
        source,
        updatedAtMs,
      );
  }

  close(): void {
    this.stopProducer();
    this.db.close();
  }

  startProducer(): void {
    if (this.producerTimer) return;
    void this.pollProducerTick();
    this.producerTimer = setInterval(() => {
      void this.pollProducerTick();
    }, 3000);
    if (this.producerTimer.unref) {
      this.producerTimer.unref();
    }
  }

  stopProducer(): void {
    if (this.producerTimer) {
      clearInterval(this.producerTimer);
      this.producerTimer = null;
    }
  }

  async pollProducerTick(): Promise<void> {
    if (this.producerPromise) return this.producerPromise;
    this.lastProducerAttemptMs = this.now();
    this.lastProducerAttemptRealMs = Date.now();
    this.producerInFlight = true;
    this.producerPromise = (async () => {
      try {
        if (this.hardwareProvider) {
          let timer: ReturnType<typeof setTimeout> | null = null;
          try {
            const provided = await Promise.race([
              Promise.resolve().then(() => this.hardwareProvider!()),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  reject(
                    new HttpError(
                      503,
                      `Hardware telemetry provider timed out after ${this.hardwareTimeoutMs}ms.`,
                    ),
                  );
                }, this.hardwareTimeoutMs);
              }),
            ]);
            const settledNowMs = this.now();
            this.ingestHardwareReading(
              provided.reading ?? provided.statusPayload,
              provided.source,
              settledNowMs,
            );
            this.lastProducerError = null;
          } finally {
            if (timer) clearTimeout(timer);
          }
          return;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        try {
          const res = await fetch(UPSTREAM_TELEMETRY_URL, {
            signal: controller.signal,
            headers: { accept: "application/json" },
          });
          if (!res.ok) {
            throw new HttpError(
              res.status === 404 ? 404 : 503,
              `Upstream ${UPSTREAM_TELEMETRY_URL} returned HTTP ${res.status}.`,
            );
          }
          const raw = await res.json();
          const nowMs = this.now();
          this.ingestHardwareReading(raw, "live", nowMs);
          this.lastProducerError = null;
        } finally {
          clearTimeout(timeout);
        }
      } catch (err) {
        const isExplicitFault =
          (err instanceof SignalError && (err.reason === "fault" || err.reason === "invalid")) ||
          (err instanceof HttpError &&
            (err.message.includes("COUNTER_FAULT") ||
              err.message.includes("invalid") ||
              err.message.includes("replayed") ||
              err.message.includes("rejected"))) ||
          (err instanceof Error &&
            (err.message.includes("COUNTER_FAULT") ||
              err.message.includes("fault") ||
              err.message.includes("Hardware reported fault")));
        const statusCode = err instanceof HttpError ? err.statusCode : 503;
        const message =
          err instanceof Error ? err.message : "Hardware telemetry fetch failed.";
        this.lastProducerError = { message, statusCode, isFault: Boolean(isExplicitFault) };
        // Transport outages keep the last accepted observation until its original deadlines.
        // Explicit invalid/device-fault data invalidates immediately.
        if (isExplicitFault) {
          this.cachedTelemetry = null;
        }
      } finally {
        this.producerInFlight = false;
        this.producerPromise = null;
      }
    })();
    return this.producerPromise;
  }

  private drawNextOrdinary(prev: number): number {
    let candidate = this.csprngInt(7);
    while (candidate === prev) {
      candidate = this.csprngInt(7);
    }
    return candidate;
  }

  ensureStrataEventsForDay(category: "palette" | "accessory", utcDate: string): void {
    const existing = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM special_schedule_events WHERE category = ? AND utc_date = ?`,
      )
      .get(category, utcDate) as { count?: number } | undefined;
    if (Number(existing?.count ?? 0) >= 8) {
      return;
    }

    const [yStr, mStr, dStr] = utcDate.split("-");
    const year = Number(yStr);
    const month = Number(mStr) - 1;
    const day = Number(dStr);

    let bag: number[] = [];
    let validShuffle = false;
    while (!validShuffle) {
      const candidates = [7, 7, 7, 8, 8, 8, 9, 9];
      for (let i = candidates.length - 1; i > 0; i--) {
        const j = this.csprngInt(i + 1);
        const tmp = candidates[i]!;
        candidates[i] = candidates[j]!;
        candidates[j] = tmp;
      }
      validShuffle = true;
      for (let i = 0; i < candidates.length - 1; i++) {
        if (candidates[i] === candidates[i + 1]) {
          validShuffle = false;
          break;
        }
      }
      if (validShuffle) {
        bag = candidates;
      }
    }

    const insertStmt = this.db.prepare(
      `INSERT OR IGNORE INTO special_schedule_events
       (category, utc_date, stratum_index, event_time_ms, special_trait_index, consumed_by_transition)
       VALUES (?, ?, ?, ?, ?, 0)`,
    );

    const stratumMs = 3 * 3600 * 1000;
    for (let stratum = 0; stratum < 8; stratum++) {
      const stratumStartMs = Date.UTC(year, month, day, stratum * 3, 0, 0, 0);
      const offsetMs = this.csprngInt(stratumMs);
      const eventTimeMs = stratumStartMs + offsetMs;
      const specialTraitIndex = bag[stratum]!;
      insertStmt.run(category, utcDate, stratum, eventTimeMs, specialTraitIndex);
    }
  }

  private buildScheduleWindows(
    paletteProgressMm: number,
    cumulativeWorkUnits: bigint,
    dayStartWorkUnits: bigint,
    scheduleDistanceMm: number,
    nowMs: number,
  ): {
    paletteSchedule: ScheduleWindowState<PaletteCatalogItem>;
    accessorySchedule: ScheduleWindowState<AccessoryCatalogItem>;
  } {
    if (this.policy.specialScheduleStrategy === "strata_time_openings") {
      const palTrait = this.resolveCurrentAndNextTraits("palette", paletteProgressMm, nowMs);
      const accTrait = this.resolveCurrentAndNextTraits("accessory", cumulativeWorkUnits, nowMs);

      const palItem = paletteByIndex(palTrait.currentIndex);
      const nextPalItem = paletteByIndex(palTrait.nextIndex);
      const palPts = this.policy.palettePoints[palTrait.currentIndex];
      const nextPalPts = this.policy.palettePoints[palTrait.nextIndex];

      const accItem = accessoryByIndex(accTrait.currentIndex);
      const nextAccItem = accessoryByIndex(accTrait.nextIndex);
      const accPts = this.policy.accessoryPoints[accTrait.currentIndex];
      const nextAccPts = this.policy.accessoryPoints[accTrait.nextIndex];

      const dailyWorkUnits =
        cumulativeWorkUnits > dayStartWorkUnits ? cumulativeWorkUnits - dayStartWorkUnits : 0n;
      const palStep = BigInt(Math.floor(scheduleDistanceMm / this.policy.paletteDistanceStepMm));
      const accStep = dailyWorkUnits / this.policy.accessoryWorkStep;

      return {
        paletteSchedule: {
          step: palStep,
          itemIndex: palTrait.currentIndex,
          item: palItem,
          points: palPts,
          tier: rarityTierForPoints(palPts),
          isRareWindow: palTrait.isSpecial,
          remainingInStep:
            this.policy.paletteDistanceStepMm -
            (scheduleDistanceMm % this.policy.paletteDistanceStepMm),
          nextItemIndex: palTrait.nextIndex,
          nextItem: nextPalItem,
          nextPoints: nextPalPts,
          dailyRareWindowsOpened: {
            rare4A: 0,
            rare4B: 0,
            apex8: 0,
            totalRare: palTrait.isSpecial ? 1 : 0,
          },
          dailyRareCaps: { rare4A: 3, rare4B: 3, apex8: 2 },
        },
        accessorySchedule: {
          step: accStep,
          itemIndex: accTrait.currentIndex,
          item: accItem,
          points: accPts,
          tier: rarityTierForPoints(accPts),
          isRareWindow: accTrait.isSpecial,
          remainingInStep:
            this.policy.accessoryWorkStep - (dailyWorkUnits % this.policy.accessoryWorkStep),
          nextItemIndex: accTrait.nextIndex,
          nextItem: nextAccItem,
          nextPoints: nextAccPts,
          dailyRareWindowsOpened: {
            rare4A: 0,
            rare4B: 0,
            apex8: 0,
            totalRare: accTrait.isSpecial ? 1 : 0,
          },
          dailyRareCaps: { rare4A: 3, rare4B: 3, apex8: 2 },
        },
      };
    }

    return {
      paletteSchedule: paletteScheduleAt(scheduleDistanceMm, this.policy),
      accessorySchedule: accessoryScheduleAt(
        cumulativeWorkUnits,
        dayStartWorkUnits,
        this.policy,
      ),
    };
  }

  resolveCurrentAndNextTraits(
    category: "palette" | "accessory",
    currentProgress: number | bigint,
    nowMs = this.now(),
  ): {
    currentIndex: number;
    nextIndex: number;
    isSpecial: boolean;
  } {
    const utcDate = utcCalendarDayKey(nowMs);
    this.ensureStrataEventsForDay(category, utcDate);

    let row = this.db
      .prepare(`SELECT * FROM trait_transition_state WHERE category = ?`)
      .get(category) as Record<string, unknown> | undefined;

    const thresholdStep = category === "palette" ? 100_000 : 100n;
    const progressNum =
      typeof currentProgress === "bigint"
        ? currentProgress
        : BigInt(Math.max(0, Math.floor(currentProgress)));
    const currentStepCount = Number(progressNum / BigInt(thresholdStep));

    if (!row) {
      const curOrd = this.csprngInt(7);
      const nextOrd = this.drawNextOrdinary(curOrd);
      this.db
        .prepare(
          `INSERT INTO trait_transition_state (
            category, current_ordinary_index, next_ordinary_index, last_transition_threshold, accumulated_progress
          ) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(category, curOrd, nextOrd, currentStepCount, Number(progressNum));
      row = {
        category,
        current_ordinary_index: curOrd,
        next_ordinary_index: nextOrd,
        last_transition_threshold: currentStepCount,
        accumulated_progress: Number(progressNum),
      };
    }

    let curOrd = Number(row.current_ordinary_index);
    let nextOrd = Number(row.next_ordinary_index);
    let lastThresh = Number(row.last_transition_threshold);
    const prevAccumulated = Number(row.accumulated_progress ?? 0);
    const progressAsNumber = Number(progressNum);
    let advanced = false;

    if (currentStepCount > lastThresh) {
      const stepsToAdvance = Math.min(currentStepCount - lastThresh, 50);
      for (let i = 0; i < stepsToAdvance; i++) {
        curOrd = nextOrd;
        nextOrd = this.drawNextOrdinary(curOrd);
      }
      lastThresh = currentStepCount;
      advanced = true;

      this.db
        .prepare(
          `UPDATE special_schedule_events
           SET consumed_at = ?, consumed_by_transition = 1
           WHERE category = ? AND opened_at IS NOT NULL AND opened_at >= event_time_ms AND (consumed_at IS NULL AND consumed_by_transition = 0) AND opened_at < ?`,
        )
        .run(nowMs, category, nowMs);
    }

    // Persist every accepted progress value (including partial 100m / 100-work windows),
    // not only when crossing a full transition boundary.
    if (advanced || progressAsNumber !== prevAccumulated) {
      this.db
        .prepare(
          `UPDATE trait_transition_state SET
           current_ordinary_index = ?,
           next_ordinary_index = ?,
           last_transition_threshold = ?,
           accumulated_progress = ?
           WHERE category = ?`,
        )
        .run(curOrd, nextOrd, lastThresh, progressAsNumber, category);
    }

    const newlyDueSpecials = this.db
      .prepare(
        `SELECT id FROM special_schedule_events
         WHERE category = ? AND event_time_ms <= ? AND (opened_at IS NULL OR opened_at < event_time_ms) AND (consumed_at IS NULL AND consumed_by_transition = 0)
         ORDER BY event_time_ms ASC`,
      )
      .all(category, nowMs) as { id: number }[];

    for (const spec of newlyDueSpecials) {
      this.db
        .prepare(`UPDATE special_schedule_events SET opened_at = ? WHERE id = ?`)
        .run(nowMs, spec.id);
    }

    const activeSpecial = this.db
      .prepare(
        `SELECT * FROM special_schedule_events
         WHERE category = ? AND opened_at IS NOT NULL AND opened_at >= event_time_ms AND (consumed_at IS NULL AND consumed_by_transition = 0)
         ORDER BY event_time_ms DESC LIMIT 1`,
      )
      .get(category) as Record<string, unknown> | undefined;

    if (activeSpecial) {
      return {
        currentIndex: Number(activeSpecial.special_trait_index),
        nextIndex: nextOrd,
        isSpecial: true,
      };
    }

    return {
      currentIndex: curOrd,
      nextIndex: nextOrd,
      isSpecial: false,
    };
  }

  getDailyAllowanceLimit(): number {
    return this.policy.dailySavedPlaysAllowance ?? 3;
  }

  getCompletedPlaysCountForUtcDay(walletAddress: string, utcDayStr: string): number {
    const walletKey = getAddress(walletAddress).toLowerCase();
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM hatched_results
         WHERE wallet_address = ? AND completed_at LIKE ?`,
      )
      .get(walletKey, `${utcDayStr}%`) as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }

  getDailyAllowanceDto(walletAddress: string, nowMs = this.now()): DailyAllowanceDto {
    const todayStr = utcCalendarDayKey(nowMs);
    const completedToday = this.getCompletedPlaysCountForUtcDay(walletAddress, todayStr);
    const total = this.getDailyAllowanceLimit();
    const remaining = Math.max(0, total - completedToday);
    const resetsAtUtc = nextUtcMidnightIso(nowMs);
    return { remaining, total, completedToday, resetsAtUtc };
  }

  async restartRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{ session: LedSession }> {
    this.assertNoClientAuthoritativeFields(body);
    const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
    if (String(row.status) === "completed") {
      throw new HttpError(409, "Completed sessions cannot be restarted.");
    }
    const session = this.rowToSession(row);
    // Current server rules clear locks on restart; older frozen policies may retain locks.
    if (this.policy.clearLocksOnRestart) {
      clearAttemptProgressKeepingEgg(session);
    } else {
      session.status = "egg";
      session.elapsed = 0;
      session.regions = [
        { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
        { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
        { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
      ];
      session.completedAt = null;
      session.backgroundIndex = null;
      session.backgroundId = null;
    }
    this.saveSessionRow(session, null, Number(row.assigned_background_index));
    return { session };
  }

  ingestHardwareReading(
    rawInput: Reading | unknown,
    source: "live" | "fallback" | "simulated" = "live",
    explicitNowMs?: number,
  ): HardwareTelemetrySnapshot {
    if (source !== "live") {
      throw new HttpError(
        503,
        `Non-hardware telemetry source "${source}" is rejected; live hardware telemetry required.`,
      );
    }
    const isDirectReading = Boolean(
      rawInput &&
        typeof rawInput === "object" &&
        "work" in rawInput &&
        typeof (rawInput as Reading).work === "bigint" &&
        "coreStatus" in rawInput,
    );
    const nowMs =
      explicitNowMs ??
      (isDirectReading
        ? ((rawInput as Reading).received ?? (rawInput as Reading).observedAt ?? this.now())
        : this.now());
    const enforceFreshness = explicitNowMs !== undefined || !isDirectReading;

    const reading = coerceToReading(
      rawInput,
      nowMs,
      this.hardwareState?.lastReading ?? null,
      enforceFreshness,
      this.policy,
    );
    const dayKey = measurementDayKey(reading.observedAt);

    // Snapshot prior memory so a mid-ingest trait/event write failure rolls back both DB and RAM (R19).
    const rollbackHardware = this.hardwareState
      ? this.cloneHardwareState(this.hardwareState)
      : null;
    const rollbackMono = this.monotonicDistanceMm;
    const rollbackCached = this.cachedTelemetry;
    const rollbackFetchMs = this.lastHardwareFetchMs;
    const rollbackFetchRealMs = this.lastHardwareFetchRealMs;

    let nextMono = this.monotonicDistanceMm;
    let nextState: NonNullable<HatcheryBackend["hardwareState"]>;

    if (!this.hardwareState) {
      // Cold start without a prior day rollover in SQLite:
      // Re-anchor dayStartWorkUnits to the initial observed work counter so lifetime cumulativeWorkUnits
      // is never falsely treated as single-day work (R5).
      nextState = {
        lastReading: reading,
        dayKey,
        dayAnchorKind: "reanchored",
        dailyDistanceMm: reading.distanceMm,
        scheduleDistanceMm: reading.distanceMm,
        cumulativeWorkUnits: reading.work,
        dayStartWorkUnits: reading.work,
      };
      nextMono = Math.max(this.monotonicDistanceMm, reading.distanceMm);
    } else {
      const prev = this.hardwareState;
      const sameDay = prev.dayKey === dayKey;
      let nextDailyDistanceMm = sameDay ? prev.dailyDistanceMm : 0;
      let nextScheduleDistanceMm = sameDay ? prev.scheduleDistanceMm : 0;
      let nextCumulativeWorkUnits = prev.cumulativeWorkUnits;
      let nextDayStartWorkUnits = sameDay ? prev.dayStartWorkUnits : prev.cumulativeWorkUnits;
      let nextDayAnchorKind: "rollover" | "reanchored" = sameDay
        ? prev.dayAnchorKind
        : "rollover";

      if (sameReportingHistory(prev.lastReading, reading)) {
        // Always apply positive counter deltas between accepted readings even if the latest
        // sample transitioned to IDLE after completing revolutions (R6).
        const dWork = workDelta(prev.lastReading, reading);
        const dDist = sameDay
          ? distanceDeltaMm(prev.lastReading, reading)
          : Math.max(0, reading.distanceMm);
        nextMono = this.monotonicDistanceMm + dDist;
        nextCumulativeWorkUnits += dWork;
        nextDailyDistanceMm += dDist;
        nextScheduleDistanceMm += dDist;

        const mergedReading: Reading = {
          ...reading,
          work:
            reading.work > prev.lastReading.work
              ? reading.work
              : prev.lastReading.work,
          distanceMm:
            sameDay && reading.distanceMm < prev.lastReading.distanceMm
              ? prev.lastReading.distanceMm
              : reading.distanceMm,
        };
        nextState = {
          lastReading: mergedReading,
          dayKey,
          dayAnchorKind: nextDayAnchorKind,
          dailyDistanceMm: nextDailyDistanceMm,
          scheduleDistanceMm: nextScheduleDistanceMm,
          cumulativeWorkUnits: nextCumulativeWorkUnits,
          dayStartWorkUnits: nextDayStartWorkUnits,
        };
      } else {
        // New installationId or counterEpoch: re-anchor baseline without adding phantom deltas
        if (!sameDay) {
          nextDailyDistanceMm = Math.max(0, reading.distanceMm);
          nextScheduleDistanceMm = Math.max(0, reading.distanceMm);
        }
        nextState = {
          lastReading: reading,
          dayKey,
          dayAnchorKind: "reanchored",
          dailyDistanceMm: nextDailyDistanceMm,
          scheduleDistanceMm: nextScheduleDistanceMm,
          cumulativeWorkUnits: nextCumulativeWorkUnits,
          dayStartWorkUnits: nextDayStartWorkUnits,
        };
      }
    }

    let paletteSchedule: ScheduleWindowState<PaletteCatalogItem>;
    let accessorySchedule: ScheduleWindowState<AccessoryCatalogItem>;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.hardwareState = nextState;
      this.monotonicDistanceMm = nextMono;
      this.saveHardwareStateToDb(nextState, source, nowMs);
      // Trait progress / private event openings commit with the replay baseline atomically.
      const schedules = this.buildScheduleWindows(
        nextMono,
        nextState.cumulativeWorkUnits,
        nextState.dayStartWorkUnits,
        nextState.scheduleDistanceMm,
        nowMs,
      );
      paletteSchedule = schedules.paletteSchedule;
      accessorySchedule = schedules.accessorySchedule;
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback errors when no transaction is open
      }
      this.hardwareState = rollbackHardware;
      this.monotonicDistanceMm = rollbackMono;
      this.cachedTelemetry = rollbackCached;
      this.lastHardwareFetchMs = rollbackFetchMs;
      this.lastHardwareFetchRealMs = rollbackFetchRealMs;
      throw err;
    }

    const state = nextState;
    const effectiveReading: Reading = {
      ...state.lastReading,
      utcDate: state.dayKey,
      distanceMm: state.scheduleDistanceMm,
      meters: state.scheduleDistanceMm / 1000,
      work: state.cumulativeWorkUnits,
    };

    const observationAgeMs = nowMs - effectiveReading.observedAt;
    let signalState: "ok" | "speed-unavailable" | "unavailable" = "ok";
    let signalMessage = "Live hardware telemetry active.";
    if (effectiveReading.coreStatus === "ACTIVE" && observationAgeMs > 15_000) {
      signalState = "speed-unavailable";
      signalMessage = "Speed unavailable; running at 40% base power.";
    } else if (effectiveReading.coreStatus === "IDLE") {
      signalState = "ok";
      signalMessage = "Wheel resting; maintaining 40% base power.";
    }

    const snapshot: HardwareTelemetrySnapshot = {
      reading: effectiveReading,
      serializedReading: serializeReading(effectiveReading),
      source,
      measurementDayKey: state.dayKey,
      dailyDistanceMm: state.dailyDistanceMm,
      scheduleDistanceMm: state.scheduleDistanceMm,
      cumulativeWorkUnits: state.cumulativeWorkUnits.toString(),
      dayStartWorkUnits: state.dayStartWorkUnits.toString(),
      paletteSchedule,
      accessorySchedule,
      serializedPaletteSchedule: serializeScheduleWindow(paletteSchedule),
      serializedAccessorySchedule: serializeScheduleWindow(accessorySchedule),
      updatedAtMs: nowMs,
      signal: { state: signalState, message: signalMessage },
    };

    this.cachedTelemetry = snapshot;
    this.lastHardwareFetchMs = nowMs;
    this.lastHardwareFetchRealMs = Date.now();
    return snapshot;
  }

  async getHardwareTelemetry(): Promise<HardwareTelemetrySnapshot> {
    const nowMs = this.now();

    // One server producer (~3s) owns upstream attempts. Visitors may join an in-flight
    // producer tick but must never start extra attempts from request cadence (e.g. 800ms).
    if (this.producerPromise) {
      await this.producerPromise;
    } else if (!this.producerTimer) {
      // Tests / no background producer: allow a bounded direct poll.
      if (
        this.lastProducerAttemptMs === 0 ||
        !this.cachedTelemetry ||
        nowMs > this.lastProducerAttemptMs
      ) {
        await this.pollProducerTick();
      }
    } else if (this.lastProducerAttemptMs === 0) {
      // Bounded bootstrap only when the interval producer has not yet attempted.
      await this.pollProducerTick();
    }

    if (this.cachedTelemetry && this.cachedTelemetry.source === "live") {
      const reading = this.cachedTelemetry.reading;
      // Honor the backend policy's own observation/receipt validity limit (R26).
      if (isObservationValid(reading, nowMs, this.policy)) {
        const ageMs = nowMs - reading.observedAt;
        let signalState: "ok" | "speed-unavailable" | "unavailable" = "ok";
        let signalMessage = "Live hardware telemetry active.";
        if (reading.coreStatus === "ACTIVE" && ageMs > 15_000) {
          signalState = "speed-unavailable";
          signalMessage = "Speed unavailable; running at 40% base power.";
        } else if (reading.coreStatus === "IDLE") {
          signalState = "ok";
          signalMessage = "Wheel resting; maintaining 40% base power.";
        }
        return {
          ...this.cachedTelemetry,
          signal: { state: signalState, message: signalMessage },
        };
      }
    }

    const lastErr = this.lastProducerError as {
      statusCode: number;
      message: string;
      isFault?: boolean;
    } | null;
    if (lastErr) {
      throw new HttpError(lastErr.statusCode, lastErr.message);
    }

    throw new HttpError(503, "Hardware telemetry unavailable or expired.");
  }

  createAuthChallenge(params: {
    walletAddress: string;
    chainId?: number;
    origin: string;
    domain: string;
  }): {
    challengeId: string;
    nonce: string;
    walletAddress: string;
    chainId: number;
    domain: string;
    origin: string;
    issuedAt: string;
    expiresAt: string;
    message: string;
  } {
    if (!params.walletAddress || !isAddress(params.walletAddress)) {
      throw new HttpError(400, "Invalid Ethereum wallet address.");
    }
    const checksumAddress = getAddress(params.walletAddress);
    const walletKey = checksumAddress.toLowerCase();
    const chainId =
      typeof params.chainId === "number" && Number.isInteger(params.chainId) && params.chainId > 0
        ? params.chainId
        : DEFAULT_CHAIN_ID;

    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(params.origin);
    } catch {
      throw new HttpError(400, "Invalid origin URL for SIWE challenge.");
    }
    const normalizedOrigin = parsedOrigin.origin;
    const domain = params.domain || parsedOrigin.host;
    if (parsedOrigin.host !== domain) {
      throw new HttpError(400, "Challenge domain does not match request origin host.");
    }

    const nowMs = this.now();
    const issuedAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + CHALLENGE_TTL_MS).toISOString();
    const challengeId = randomUUID();
    const nonce = randomBytes(16).toString("hex");
    const statement =
      "Sign in to Squeek LED Hatchery to record ranked sessions and manage your wallet display name. No blockchain transaction or gas fee will be sent.";

    const message = buildSiweChallengeMessage({
      domain,
      walletAddress: checksumAddress,
      statement,
      origin: normalizedOrigin,
      chainId,
      nonce,
      issuedAt,
      expiresAt,
    });

    this.db
      .prepare(
        `INSERT INTO auth_challenges (
          challenge_id, nonce, wallet_address, checksum_address, domain, origin, chain_id, issued_at, expires_at, message, used_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        challengeId,
        nonce,
        walletKey,
        checksumAddress,
        domain,
        normalizedOrigin,
        chainId,
        issuedAt,
        expiresAt,
        message,
      );

    return {
      challengeId,
      nonce,
      walletAddress: checksumAddress,
      chainId,
      domain,
      origin: normalizedOrigin,
      issuedAt,
      expiresAt,
      message,
    };
  }

  async verifyAuthChallenge(params: {
    challengeId?: string;
    nonce?: string;
    walletAddress: string;
    signature: string;
    origin: string;
    domain: string;
    chainId?: number;
  }): Promise<{ token: string; player: PlayerProfile; expiresAt: string }> {
    if (!params.walletAddress || !isAddress(params.walletAddress)) {
      throw new HttpError(400, "Invalid wallet address.");
    }
    if (
      typeof params.signature !== "string" ||
      !params.signature.startsWith("0x") ||
      params.signature.length < 130
    ) {
      throw new HttpError(400, "Invalid EOA personal_sign signature format.");
    }
    const checksumAddress = getAddress(params.walletAddress);
    const walletKey = checksumAddress.toLowerCase();

    const row = params.challengeId
      ? (this.db
          .prepare(`SELECT * FROM auth_challenges WHERE challenge_id = ?`)
          .get(params.challengeId) as Record<string, unknown> | undefined)
      : params.nonce
        ? (this.db
            .prepare(`SELECT * FROM auth_challenges WHERE nonce = ?`)
            .get(params.nonce) as Record<string, unknown> | undefined)
        : undefined;

    if (!row) {
      throw new HttpError(401, "Authentication challenge not found.");
    }
    if (row.used_at !== null && row.used_at !== undefined) {
      throw new HttpError(401, "Challenge nonce has already been used.");
    }

    const nowMs = this.now();
    const expiresAtMs = Date.parse(String(row.expires_at));
    if (!Number.isFinite(expiresAtMs) || nowMs > expiresAtMs) {
      throw new HttpError(401, "Authentication challenge has expired.");
    }

    if (String(row.wallet_address) !== walletKey) {
      throw new HttpError(401, "Wallet address does not match challenge wallet.");
    }

    let normalizedOrigin: string;
    try {
      normalizedOrigin = new URL(params.origin).origin;
    } catch {
      throw new HttpError(401, "Invalid request origin.");
    }

    if (String(row.origin) !== normalizedOrigin || String(row.domain) !== params.domain) {
      throw new HttpError(401, "Origin or domain mismatch for authentication challenge.");
    }

    if (params.chainId !== undefined && Number(params.chainId) !== Number(row.chain_id)) {
      throw new HttpError(401, "Chain ID mismatch for authentication challenge.");
    }

    let recoveredAddress: string;
    try {
      recoveredAddress = await recoverMessageAddress({
        message: String(row.message),
        signature: params.signature as `0x${string}`,
      });
    } catch {
      throw new HttpError(
        401,
        "Signature verification failed. Only standard EOA personal_sign signatures are supported.",
      );
    }

    if (recoveredAddress.toLowerCase() !== walletKey) {
      throw new HttpError(401, "Recovered signer does not match wallet address.");
    }

    const eligibilityContext = this.eligibilityContextProvider
      ? this.eligibilityContextProvider(checksumAddress)
      : {};
    const eligibility = checkWalletEligibility(
      checksumAddress,
      this.policy,
      eligibilityContext,
      nowMs,
    );
    if (!eligibility.eligible) {
      throw new HttpError(403, eligibility.reason);
    }

    const token = randomBytes(32).toString("hex");
    const tokenHash = sha256Hex(token);
    const nowIso = new Date(nowMs).toISOString();
    const sessionExpiresIso = new Date(nowMs + SESSION_TTL_MS).toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const consumeResult = this.db
        .prepare(
          `UPDATE auth_challenges SET used_at = ? WHERE challenge_id = ? AND used_at IS NULL`,
        )
        .run(nowMs, String(row.challenge_id));

      if (consumeResult.changes !== 1) {
        throw new HttpError(401, "Challenge nonce has already been used.");
      }

      this.db
        .prepare(
          `INSERT INTO players (wallet_address, checksum_address, display_name, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?)
           ON CONFLICT(wallet_address) DO UPDATE SET checksum_address = excluded.checksum_address, updated_at = excluded.updated_at`,
        )
        .run(walletKey, checksumAddress, nowIso, nowIso);

      this.db
        .prepare(
          `INSERT INTO auth_sessions (token_hash, wallet_address, checksum_address, chain_id, origin, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          tokenHash,
          walletKey,
          checksumAddress,
          Number(row.chain_id),
          normalizedOrigin,
          nowIso,
          sessionExpiresIso,
        );

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore rollback error
      }
      throw err;
    }

    const player = this.getPlayerProfile(checksumAddress, Number(row.chain_id), sessionExpiresIso);
    return { token, player, expiresAt: sessionExpiresIso };
  }

  getSessionFromToken(token: string | undefined): PlayerProfile | null {
    if (!token || typeof token !== "string") return null;
    const tokenHash = sha256Hex(token);
    const row = this.db
      .prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`)
      .get(tokenHash) as Record<string, unknown> | undefined;
    if (!row) return null;

    const nowMs = this.now();
    const expiresMs = Date.parse(String(row.expires_at));
    if (!Number.isFinite(expiresMs) || nowMs > expiresMs) {
      this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash);
      return null;
    }

    return this.getPlayerProfile(
      String(row.checksum_address),
      Number(row.chain_id),
      String(row.expires_at),
    );
  }

  revokeSessionToken(token: string | undefined): void {
    if (!token) return;
    const tokenHash = sha256Hex(token);
    this.db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`).run(tokenHash);
  }

  getPlayerProfile(
    walletAddress: string,
    chainId = DEFAULT_CHAIN_ID,
    sessionExpiresAt?: string,
  ): PlayerProfile {
    const checksumAddress = getAddress(walletAddress);
    const walletKey = checksumAddress.toLowerCase();
    const row = this.db
      .prepare(`SELECT display_name FROM players WHERE wallet_address = ?`)
      .get(walletKey) as { display_name: string | null } | undefined;

    const displayName = row?.display_name || null;
    return {
      walletAddress: checksumAddress,
      shortWallet: shortWalletAddress(checksumAddress),
      displayName,
      effectiveName: formatEffectivePlayerName(checksumAddress, displayName),
      chainId,
      sessionExpiresAt,
    };
  }

  updatePlayerDisplayName(walletAddress: string, rawDisplayName: unknown): PlayerProfile {
    const checksumAddress = getAddress(walletAddress);
    const walletKey = checksumAddress.toLowerCase();
    const validation = validatePlayerDisplayName(rawDisplayName);
    if (!validation.valid) {
      throw new HttpError(400, validation.error ?? "Invalid display name.");
    }
    const storedName = validation.normalized ? validation.normalized : null;
    const nowIso = new Date(this.now()).toISOString();
    this.db
      .prepare(
        `INSERT INTO players (wallet_address, checksum_address, display_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(wallet_address) DO UPDATE SET
           checksum_address = excluded.checksum_address,
           display_name = excluded.display_name,
           updated_at = excluded.updated_at`,
      )
      .run(walletKey, checksumAddress, storedName, nowIso, nowIso);

    return this.getPlayerProfile(checksumAddress);
  }

  assertNoClientAuthoritativeFields(body: Record<string, unknown>): void {
    for (const key of Object.keys(body)) {
      if (FORBIDDEN_CLIENT_AUTHORITATIVE_KEYS.has(key)) {
        throw new HttpError(
          400,
          `Client-supplied authoritative game field "${key}" is forbidden.`,
        );
      }
    }
  }

  private rowToSession(row: Record<string, unknown>): LedSession {
    const parsed = JSON.parse(String(row.session_json)) as LedSession;
    // Hide server-assigned background until session is completed
    if (String(row.status) !== "completed") {
      parsed.backgroundIndex = null;
      parsed.backgroundId = null;
    }
    return parsed;
  }

  private saveSessionRow(
    session: LedSession,
    lastStepAtMs: number | null,
    assignedBackgroundIndex: number,
  ): void {
    this.db
      .prepare(
        `UPDATE ranked_sessions SET
          lamp_position = ?,
          status = ?,
          last_step_at_ms = ?,
          session_json = ?,
          assigned_background_index = ?
        WHERE session_id = ?`,
      )
      .run(
        session.lampPosition,
        session.status,
        lastStepAtMs,
        JSON.stringify(session),
        assignedBackgroundIndex,
        session.id,
      );
  }

  getActiveRankedSessionRow(walletAddress: string): Record<string, unknown> | undefined {
    const walletKey = getAddress(walletAddress).toLowerCase();
    return this.db
      .prepare(
        `SELECT * FROM ranked_sessions
         WHERE wallet_address = ? AND status NOT IN ('completed', 'abandoned')
         ORDER BY created_at_ms DESC LIMIT 1`,
      )
      .get(walletKey) as Record<string, unknown> | undefined;
  }

  private pauseOrResetRunningSessionForWalletOnTelemetryFailure(
    walletAddress: string,
    sessionIdParam: unknown,
  ): void {
    try {
      const row = this.resolveOwnedActiveSessionRow(walletAddress, sessionIdParam);
      const session = this.rowToSession(row);
      if (session.status !== "running") return;
      if (this.policy.activityGapResetsAttempt || this.policy.clearLocksOnRestart) {
        clearAttemptProgressKeepingEgg(session);
      } else {
        session.status = "paused";
        session.completedAt = null;
        session.backgroundIndex = null;
        session.backgroundId = null;
      }
      this.saveSessionRow(session, null, Number(row.assigned_background_index));
    } catch {
      // ignore if no active session
    }
  }

  /** @deprecated Use pauseOrResetRunningSessionForWalletOnTelemetryFailure */
  private pauseRunningSessionForWalletOnTelemetryFailure(
    walletAddress: string,
    sessionIdParam: unknown,
  ): void {
    this.pauseOrResetRunningSessionForWalletOnTelemetryFailure(walletAddress, sessionIdParam);
  }

  private currentPolicyClearsUnfinishedLocks(): boolean {
    return this.policy.activityGapResetsAttempt || this.policy.clearLocksOnRestart;
  }

  private applyAttemptInterruption(session: LedSession): void {
    // Prefer current server anti-hoarding rules over legacy session pause retention.
    if (this.currentPolicyClearsUnfinishedLocks()) {
      clearAttemptProgressKeepingEgg(session);
      return;
    }
    session.status = "paused";
    session.completedAt = null;
    session.backgroundIndex = null;
    session.backgroundId = null;
  }

  /**
   * Current no-pause rules apply at the active-session boundary. A historical
   * paused or lock-holding unfinished attempt cannot be resumed as-is.
   * Completed rows are never passed here.
   */
  private releaseUnfinishedHoardedLocks(session: LedSession): boolean {
    if (!this.currentPolicyClearsUnfinishedLocks()) return false;
    if (session.status === "completed" || session.status === "running") return false;
    const holdsProgress =
      session.status === "paused" ||
      session.lockedTraits !== null ||
      session.elapsed > 0 ||
      session.startedAt !== null ||
      session.regions.some((region) => region.dose > 0 || region.level > 0 || region.exposure > 0);
    if (!holdsProgress) return false;
    clearAttemptProgressKeepingEgg(session);
    return true;
  }

  private relockFreshFirstLight(
    session: LedSession,
    telemetry: HardwareTelemetrySnapshot,
    sessionPolicy: GamePolicy,
    nowIso: string,
  ): void {
    lockSessionTraits(
      session,
      telemetry.reading,
      BigInt(telemetry.dayStartWorkUnits),
      sessionPolicy,
      nowIso,
      {
        paletteIndex: telemetry.paletteSchedule.itemIndex,
        accessoryIndex: telemetry.accessorySchedule.itemIndex,
      },
    );
    session.status = "running";
  }

  private advanceRunningSessionStep(
    row: Record<string, unknown>,
    session: LedSession,
    sessionPolicy: GamePolicy,
    nowMs: number,
    telemetry: HardwareTelemetrySnapshot,
  ): {
    autoPaused: boolean;
    levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
  } {
    if (session.status !== "running") {
      return { autoPaused: false, levelUps: [] };
    }
    const lastStepMs =
      row.last_step_at_ms !== null && row.last_step_at_ms !== undefined
        ? Number(row.last_step_at_ms)
        : null;

    const reading = telemetry.reading;
    const observationTtlMs = observationValidityLimitMs(reading, sessionPolicy);
    const observationAgeMs = nowMs - reading.observedAt;

    if (observationAgeMs > observationTtlMs) {
      this.applyAttemptInterruption(session);
      return { autoPaused: true, levelUps: [] };
    }

    if (lastStepMs === null || nowMs < lastStepMs || nowMs - lastStepMs > MAX_RANKED_STEP_MS) {
      this.applyAttemptInterruption(session);
      return { autoPaused: true, levelUps: [] };
    }

    const dtSeconds = Math.max(0, (nowMs - lastStepMs) / 1000);

    let effectiveRpm = 0;
    if (reading.coreStatus === "ACTIVE") {
      if (observationAgeMs <= 15_000) {
        effectiveRpm = reading.rpm;
      } else {
        effectiveRpm = 0; // Drops to base power (policy.baseLampPower) with speed-unavailable
      }
    } else {
      effectiveRpm = 0; // IDLE supplies base power
    }

    const stepped = stepLedSession(
      session,
      dtSeconds,
      effectiveRpm,
      0n,
      sessionPolicy,
      new Date(nowMs).toISOString(),
    );
    if (stepped.completed) {
      // Keep status at running with elapsed = durationSeconds until explicit /api/session/complete
      session.status = "running";
      session.completedAt = null;
      session.backgroundIndex = null;
      session.backgroundId = null;
    }
    return { autoPaused: false, levelUps: stepped.levelUps };
  }

  async getActiveRankedSession(walletAddress: string): Promise<LedSession | null> {
    const row = this.getActiveRankedSessionRow(walletAddress);
    if (!row) return null;
    const session = this.rowToSession(row);
    let policySupported = true;
    try {
      this.resolvePolicyForSessionRow(row);
    } catch {
      policySupported = false;
    }
    if (session.status === "running") {
      const nowMs = this.now();
      const lastStepMs =
        row.last_step_at_ms !== null && row.last_step_at_ms !== undefined
          ? Number(row.last_step_at_ms)
          : null;
      let shouldPause =
        !policySupported ||
        lastStepMs === null ||
        nowMs < lastStepMs ||
        nowMs - lastStepMs > MAX_RANKED_STEP_MS;

      if (!shouldPause) {
        try {
          await this.getHardwareTelemetry();
        } catch {
          shouldPause = true;
        }
      }

      if (shouldPause) {
        this.applyAttemptInterruption(session);
        this.saveSessionRow(session, null, Number(row.assigned_background_index));
      }
    } else if (this.releaseUnfinishedHoardedLocks(session)) {
      this.saveSessionRow(session, null, Number(row.assigned_background_index));
    }
    return session;
  }

  claimRankedEgg(walletAddress: string, body: Record<string, unknown>): LedSession {
    this.assertNoClientAuthoritativeFields(body);
    const familyIndex = resolveFamilyIndexFromInput(body);
    const lampPosition = resolveLampPositionFromInput(body, -70);

    const checksumAddress = getAddress(walletAddress);
    const walletKey = checksumAddress.toLowerCase();
    const nowMs = this.now();
    const sessionId = `sess-${randomUUID()}`;
    const assignedBackgroundIndex = pickRandomBackgroundIndex(this.policy, this.csprngInt);

    const session = createLedSession({
      id: sessionId,
      mode: "ranked",
      ownerWallet: checksumAddress,
      familyIndex,
      policy: this.policy,
    });
    session.lampPosition = lampPosition;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getActiveRankedSessionRow(checksumAddress);
      if (existing) {
        throw new HttpError(
          409,
          "Wallet already has an active ranked session. Complete or abandon the current session first.",
        );
      }

      const todayStr = utcCalendarDayKey(nowMs);
      const completedToday = this.getCompletedPlaysCountForUtcDay(checksumAddress, todayStr);
      const totalAllowance = this.getDailyAllowanceLimit();
      if (completedToday >= totalAllowance) {
        throw new HttpError(
          403,
          `Daily ranked play allowance reached (${completedToday}/${totalAllowance} plays completed today). Try demo mode or return tomorrow.`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO ranked_sessions (
            session_id, wallet_address, checksum_address, family_index, family_id,
            lamp_position, status, policy_version, policy_snapshot_json, created_at_ms, last_step_at_ms,
            session_json, assigned_background_index
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          session.id,
          walletKey,
          checksumAddress,
          session.familyIndex,
          session.familyId,
          session.lampPosition,
          session.status,
          this.policy.version,
          this.serializeGamePolicy(this.policy),
          nowMs,
          JSON.stringify(session),
          assignedBackgroundIndex,
        );

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    return session;
  }

  async startRankedIllumination(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{ session: LedSession; telemetry: HardwareTelemetrySnapshot }> {
    this.assertNoClientAuthoritativeFields(body);
    let telemetry: HardwareTelemetrySnapshot;
    try {
      telemetry = await this.getHardwareTelemetry();
    } catch (err) {
      this.pauseRunningSessionForWalletOnTelemetryFailure(walletAddress, body.sessionId);
      throw err;
    }
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    let session!: LedSession;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
      const sessionPolicy = this.resolvePolicyForSessionRow(row);
      session = this.rowToSession(row);
      if (session.status !== "running") {
        this.releaseUnfinishedHoardedLocks(session);
      }

      if (session.status === "running") {
        // Accrue preceding step using the previously aimed lampPosition BEFORE applying any new aim (R4).
        // A heartbeat gap clears the attempt; Start is then a new first light, never a lockless run.
        const stepped = this.advanceRunningSessionStep(row, session, sessionPolicy, nowMs, telemetry);
        if (stepped.autoPaused || session.status !== "running" || session.lockedTraits === null) {
          this.relockFreshFirstLight(session, telemetry, sessionPolicy, nowIso);
        }
      } else {
        this.relockFreshFirstLight(session, telemetry, sessionPolicy, nowIso);
      }

      if (body.lampPosition !== undefined || body.activeRegion !== undefined) {
        session.lampPosition = resolveLampPositionFromInput(body, session.lampPosition);
      }

      this.saveSessionRow(session, nowMs, Number(row.assigned_background_index));
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    return { session, telemetry };
  }

  async aimRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{
    session: LedSession;
    levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
  }> {
    this.assertNoClientAuthoritativeFields(body);
    if (body.lampPosition === undefined && body.activeRegion === undefined) {
      throw new HttpError(400, "lampPosition or activeRegion is required.");
    }
    let telemetry: HardwareTelemetrySnapshot;
    try {
      telemetry = await this.getHardwareTelemetry();
    } catch (err) {
      this.pauseRunningSessionForWalletOnTelemetryFailure(walletAddress, body.sessionId);
      throw err;
    }
    const nowMs = this.now();

    const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
    const sessionPolicy = this.resolvePolicyForSessionRow(row);
    const session = this.rowToSession(row);
    let levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[] = [];

    if (session.status === "running") {
      const stepped = this.advanceRunningSessionStep(row, session, sessionPolicy, nowMs, telemetry);
      levelUps = stepped.levelUps;
    }

    session.lampPosition = resolveLampPositionFromInput(body, session.lampPosition);
    this.saveSessionRow(
      session,
      session.status === "running" ? nowMs : null,
      Number(row.assigned_background_index),
    );
    return { session, levelUps };
  }

  async pauseRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{ session: LedSession }> {
    this.assertNoClientAuthoritativeFields(body);
    const nowMs = this.now();

    const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
    const sessionPolicy = this.resolvePolicyForSessionRow(row);
    const session = this.rowToSession(row);

    // Current rules: pause route must not preserve a running attempt for rare-trait farming.
    if (!this.policy.allowsManualPause) {
      if (session.status === "completed") {
        throw new HttpError(409, "Completed sessions cannot be paused or reset.");
      }
      if (session.status === "running") {
        try {
          const telemetry = await this.getHardwareTelemetry();
          this.advanceRunningSessionStep(row, session, sessionPolicy, nowMs, telemetry);
        } catch {
          // Do not accrue an invalid interval before clearing.
        }
      }
      clearAttemptProgressKeepingEgg(session);
      this.saveSessionRow(session, null, Number(row.assigned_background_index));
      return { session };
    }

    if (session.status === "running") {
      try {
        const telemetry = await this.getHardwareTelemetry();
        this.advanceRunningSessionStep(row, session, sessionPolicy, nowMs, telemetry);
      } catch {
        // If telemetry is stale or offline when pausing, do not accrue the invalid interval
      }
      session.status = "paused";
      session.completedAt = null;
      session.backgroundIndex = null;
      session.backgroundId = null;
    }

    this.saveSessionRow(session, null, Number(row.assigned_background_index));
    return { session };
  }

  async tickRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{
    session: LedSession;
    levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
    readyToComplete: boolean;
    telemetry: HardwareTelemetrySnapshot;
  }> {
    this.assertNoClientAuthoritativeFields(body);
    let telemetry: HardwareTelemetrySnapshot;
    try {
      telemetry = await this.getHardwareTelemetry();
    } catch (err) {
      this.pauseRunningSessionForWalletOnTelemetryFailure(walletAddress, body.sessionId);
      throw err;
    }
    const nowMs = this.now();

    const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
    const sessionPolicy = this.resolvePolicyForSessionRow(row);
    const session = this.rowToSession(row);

    let levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[] = [];
    if (session.status === "running") {
      // Accrue preceding step to old lampPosition BEFORE updating lampPosition (R4)
      const stepped = this.advanceRunningSessionStep(row, session, sessionPolicy, nowMs, telemetry);
      levelUps = stepped.levelUps;
    }

    if (body.lampPosition !== undefined || body.activeRegion !== undefined) {
      session.lampPosition = resolveLampPositionFromInput(body, session.lampPosition);
    }

    const readyToComplete = session.elapsed + 1e-6 >= sessionPolicy.durationSeconds;
    this.saveSessionRow(
      session,
      session.status === "running" ? nowMs : null,
      Number(row.assigned_background_index),
    );
    return { session, levelUps, readyToComplete, telemetry };
  }

  abandonRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): { abandonedSessionId: string } {
    this.assertNoClientAuthoritativeFields(body);
    const row = this.resolveOwnedActiveSessionRow(walletAddress, body.sessionId);
    const sessionId = String(row.session_id);
    this.db
      .prepare(`UPDATE ranked_sessions SET status = 'abandoned' WHERE session_id = ?`)
      .run(sessionId);
    return { abandonedSessionId: sessionId };
  }

  private buildCurrentResultResponseFromRow(
    resultRow: Record<string, unknown>,
    checksumAddress: string,
  ): {
    idempotent: boolean;
    resultId: string;
    snapshot: CharacterSnapshot;
    metadata: Record<string, unknown>;
    leaderboardRank: number | null;
    isWeeklyPersonalBest: boolean;
  } {
    const profile = this.getPlayerProfile(checksumAddress);
    const rawSnapshot = JSON.parse(String(resultRow.snapshot_json)) as CharacterSnapshot;
    const snapshot: CharacterSnapshot = {
      ...rawSnapshot,
      displayName: profile.displayName,
      effectivePlayerName: profile.effectiveName,
    };
    const metadata = JSON.parse(buildLedMetadataJson(snapshot)) as Record<string, unknown>;
    const rankInfo = this.getResultRankInfo(
      String(resultRow.result_id),
      snapshot.weekKey,
      snapshot.policyVersion,
    );
    return {
      idempotent: true,
      resultId: String(resultRow.result_id),
      snapshot,
      metadata,
      leaderboardRank: rankInfo.rank,
      isWeeklyPersonalBest: rankInfo.isPersonalBest,
    };
  }

  async completeRankedSession(
    walletAddress: string,
    body: Record<string, unknown>,
  ): Promise<{
    idempotent: boolean;
    resultId: string;
    snapshot: CharacterSnapshot;
    metadata: Record<string, unknown>;
    leaderboardRank: number | null;
    isWeeklyPersonalBest: boolean;
    allowance?: DailyAllowanceDto;
  }> {
    this.assertNoClientAuthoritativeFields(body);
    const checksumAddress = getAddress(walletAddress);
    const walletKey = checksumAddress.toLowerCase();

    const requestedSessionId =
      typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId.trim() : null;

    if (requestedSessionId) {
      const existingResult = this.db
        .prepare(`SELECT * FROM hatched_results WHERE session_id = ?`)
        .get(requestedSessionId) as Record<string, unknown> | undefined;
      if (existingResult) {
        if (String(existingResult.wallet_address) !== walletKey) {
          throw new HttpError(403, "Session belongs to a different wallet.");
        }
        return this.buildCurrentResultResponseFromRow(existingResult, checksumAddress);
      }
    }

    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();

    const preRow = requestedSessionId
      ? (this.db
          .prepare(`SELECT * FROM ranked_sessions WHERE session_id = ?`)
          .get(requestedSessionId) as Record<string, unknown> | undefined)
      : (this.getActiveRankedSessionRow(checksumAddress) ??
        (this.db
          .prepare(
            `SELECT * FROM ranked_sessions
             WHERE wallet_address = ?
             ORDER BY created_at_ms DESC LIMIT 1`,
          )
          .get(walletKey) as Record<string, unknown> | undefined));

    if (!preRow) {
      throw new HttpError(404, "No active ranked session found to complete.");
    }
    if (String(preRow.wallet_address) !== walletKey) {
      throw new HttpError(403, "Session belongs to a different wallet.");
    }

    const preAlreadyHatched = this.db
      .prepare(`SELECT * FROM hatched_results WHERE session_id = ?`)
      .get(String(preRow.session_id)) as Record<string, unknown> | undefined;
    if (preAlreadyHatched) {
      return this.buildCurrentResultResponseFromRow(preAlreadyHatched, checksumAddress);
    }

    const preSessionPolicy = this.resolvePolicyForSessionRow(preRow);

    let telemetry: HardwareTelemetrySnapshot | null = null;
    if (String(preRow.status) === "running") {
      try {
        telemetry = await this.getHardwareTelemetry();
      } catch (err) {
        this.pauseRunningSessionForWalletOnTelemetryFailure(
          walletAddress,
          String(preRow.session_id),
        );
        throw err;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sessionRow = this.db
        .prepare(`SELECT * FROM ranked_sessions WHERE session_id = ?`)
        .get(String(preRow.session_id)) as Record<string, unknown> | undefined;

      if (!sessionRow) {
        throw new HttpError(404, "No active ranked session found to complete.");
      }
      if (String(sessionRow.wallet_address) !== walletKey) {
        throw new HttpError(403, "Session belongs to a different wallet.");
      }

      const sessionId = String(sessionRow.session_id);
      const alreadyHatched = this.db
        .prepare(`SELECT * FROM hatched_results WHERE session_id = ?`)
        .get(sessionId) as Record<string, unknown> | undefined;

      if (alreadyHatched) {
        this.db.exec("COMMIT");
        return this.buildCurrentResultResponseFromRow(alreadyHatched, checksumAddress);
      }

      if (String(sessionRow.status) === "abandoned") {
        throw new HttpError(400, "Cannot complete an abandoned session.");
      }

      const sessionPolicy = this.resolvePolicyForSessionRow(sessionRow) ?? preSessionPolicy;
      const session = this.rowToSession(sessionRow);
      if (!session.lockedTraits) {
        throw new HttpError(
          400,
          "Session must start lamp illumination and lock traits before completing.",
        );
      }

      if (session.status === "running" && telemetry) {
        this.advanceRunningSessionStep(sessionRow, session, sessionPolicy, nowMs, telemetry);
      }

      // R2 + R12: Ranked session must complete the full durationSeconds of its original immutable policy
      if (session.elapsed + 1e-6 < sessionPolicy.durationSeconds) {
        this.saveSessionRow(
          session,
          session.status === "running" ? nowMs : null,
          Number(sessionRow.assigned_background_index),
        );
        this.db.exec("COMMIT");
        throw new HttpError(
          400,
          `Session requires full ${sessionPolicy.durationSeconds}s of verified illumination before completion (current elapsed: ${session.elapsed.toFixed(1)}s).`,
        );
      }

      const assignedBgIndex = Number(sessionRow.assigned_background_index);
      const assignedBg = backgroundByIndex(assignedBgIndex);
      session.status = "completed";
      session.completedAt = nowIso;
      session.backgroundIndex = assignedBg.index;
      session.backgroundId = assignedBg.id;

      this.saveSessionRow(session, nowMs, assignedBg.index);

      const profile = this.getPlayerProfile(checksumAddress);
      const resultId = `res-${sessionId.replace(/^sess-/, "")}`;

      const snapshot = buildCharacterSnapshot(session, {
        resultId,
        displayName: profile.displayName,
        policy: sessionPolicy,
      });
      const metadataJsonStr = buildLedMetadataJson(snapshot);
      const metadata = JSON.parse(metadataJsonStr) as Record<string, unknown>;

      const completionDayStr = utcCalendarDayKey(nowMs);
      const completedOnDay = this.getCompletedPlaysCountForUtcDay(checksumAddress, completionDayStr);
      const totalAllowance = this.getDailyAllowanceLimit();
      if (completedOnDay >= totalAllowance) {
        throw new HttpError(
          403,
          `Daily ranked play allowance reached (${completedOnDay}/${totalAllowance} plays completed today).`,
        );
      }

      this.db
        .prepare(
          `INSERT INTO hatched_results (
            result_id, session_id, wallet_address, checksum_address, display_name_snapshot,
            week_key, measurement_day_key, policy_version, family_id,
            head_level, middle_level, lower_level,
            palette_id, palette_index, palette_points,
            accessory_id, accessory_index, accessory_points,
            background_id, background_index, background_points,
            region_score, total_score,
            completed_at, completed_at_ms, snapshot_json, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          snapshot.resultId,
          snapshot.sessionId,
          walletKey,
          checksumAddress,
          profile.displayName,
          snapshot.weekKey,
          snapshot.locks.measurementDay,
          snapshot.policyVersion,
          snapshot.familyId,
          snapshot.levels[0],
          snapshot.levels[1],
          snapshot.levels[2],
          snapshot.paletteId,
          snapshot.paletteIndex,
          snapshot.scores.palette,
          snapshot.accessoryId,
          snapshot.accessoryIndex,
          snapshot.scores.accessory,
          snapshot.backgroundId,
          snapshot.backgroundIndex,
          snapshot.scores.background,
          snapshot.scores.regionsTotal,
          snapshot.scores.total,
          snapshot.completedAt,
          nowMs,
          JSON.stringify(snapshot),
          metadataJsonStr,
        );

      this.db.exec("COMMIT");

      const rankInfo = this.getResultRankInfo(
        snapshot.resultId,
        snapshot.weekKey,
        snapshot.policyVersion,
      );
      return {
        idempotent: false,
        resultId: snapshot.resultId,
        snapshot,
        metadata,
        leaderboardRank: rankInfo.rank,
        isWeeklyPersonalBest: rankInfo.isPersonalBest,
        allowance: this.getDailyAllowanceDto(checksumAddress, nowMs),
      };
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }
  }

  private resolveOwnedActiveSessionRow(
    walletAddress: string,
    sessionIdParam: unknown,
  ): Record<string, unknown> {
    const checksumAddress = getAddress(walletAddress);
    const walletKey = checksumAddress.toLowerCase();

    if (typeof sessionIdParam === "string" && sessionIdParam.trim()) {
      const row = this.db
        .prepare(`SELECT * FROM ranked_sessions WHERE session_id = ?`)
        .get(sessionIdParam.trim()) as Record<string, unknown> | undefined;
      if (!row) {
        throw new HttpError(404, "Ranked session not found.");
      }
      if (String(row.wallet_address) !== walletKey) {
        throw new HttpError(403, "Session belongs to a different wallet.");
      }
      if (String(row.status) === "completed" || String(row.status) === "abandoned") {
        throw new HttpError(409, `Session is already ${String(row.status)}.`);
      }
      return row;
    }

    const row = this.getActiveRankedSessionRow(checksumAddress);
    if (!row) {
      throw new HttpError(404, "No active ranked session found for this wallet.");
    }
    return row;
  }

  private resolvePlayerDisplayNameFromJoinRow(row: Record<string, unknown>): string | null {
    // R8: If a player profile row exists in `players`, always use its current_display_name
    // (which is NULL when cleared, reverting to shortened wallet address) instead of falling
    // back to the historical display_name_snapshot.
    const hasPlayerRow =
      row.player_wallet_exists !== undefined && row.player_wallet_exists !== null;
    const rawName = hasPlayerRow ? row.current_display_name : row.display_name_snapshot;
    if (typeof rawName === "string" && rawName.trim()) {
      return rawName.trim();
    }
    return null;
  }

  getWeeklyLeaderboard(params?: {
    weekKey?: string;
    policyVersion?: string;
    limit?: number;
  }): {
    weekKey: string;
    policyVersion: string;
    rankingFormula: string;
    totalQualifiedWallets: number;
    entries: LeaderboardEntryDto[];
  } {
    const weekKey = params?.weekKey || gameWeekKey(this.now());
    const policyVersion = params?.policyVersion || this.policy.version;
    const limit = Math.min(this.policy.leaderboardLimit, Math.max(1, params?.limit ?? 100));

    const rows = this.db
      .prepare(
        `SELECT r.*, p.wallet_address AS player_wallet_exists, p.display_name AS current_display_name
         FROM hatched_results r
         LEFT JOIN players p ON p.wallet_address = r.wallet_address
         WHERE r.week_key = ? AND r.policy_version = ?`,
      )
      .all(weekKey, policyVersion) as Record<string, unknown>[];

    const strategy: LeaderboardStrategy = new BestPerWalletWeeklyLeaderboardStrategy();
    const topRows = strategy.selectTopEntries(rows, limit);
    const entries: LeaderboardEntryDto[] = topRows.map((row, index) => {
      const checksumAddress = String(row.checksum_address);
      const displayName = this.resolvePlayerDisplayNameFromJoinRow(row);
      const familyId = String(row.family_id) as FamilyId;
      const fam = familyById(familyId) ?? FAMILIES[0];
      const paletteIndex = Number(row.palette_index);
      const accessoryIndex = Number(row.accessory_index);
      const backgroundIndex = Number(row.background_index);
      const palette = paletteByIndex(paletteIndex);
      const accessory = accessoryByIndex(accessoryIndex);
      const background = backgroundByIndex(backgroundIndex);
      const toTraitPts = (n: number): TraitPoints =>
        n === 8 || n === 4 || n === 2 ? n : 1;
      const palettePts = toTraitPts(Number(row.palette_points));
      const accessoryPts = toTraitPts(Number(row.accessory_points));
      const backgroundPts = toTraitPts(Number(row.background_points));

      const head = Number(row.head_level);
      const middle = Number(row.middle_level);
      const lower = Number(row.lower_level);

      return {
        rank: index + 1,
        resultId: String(row.result_id),
        sessionId: String(row.session_id),
        shortWallet: shortWalletAddress(checksumAddress),
        displayName,
        effectiveName: formatEffectivePlayerName(checksumAddress, displayName),
        weekKey: String(row.week_key),
        measurementDayKey: String(row.measurement_day_key),
        policyVersion: String(row.policy_version),
        familyId,
        familyName: fam.name,
        levels: [head, middle, lower],
        palette: {
          id: palette.id,
          name: palette.name,
          index: paletteIndex,
          points: palettePts,
          tier: rarityTierForPoints(palettePts),
        },
        accessory: {
          id: accessory.id,
          name: accessory.name,
          index: accessoryIndex,
          points: accessoryPts,
          tier: rarityTierForPoints(accessoryPts),
        },
        background: {
          id: background.id,
          name: background.name,
          index: backgroundIndex,
          points: backgroundPts,
          tier: rarityTierForPoints(backgroundPts),
        },
        scores: {
          head,
          middle,
          lower,
          regionsTotal: Number(row.region_score),
          palette: palettePts,
          accessory: accessoryPts,
          background: backgroundPts,
          total: Number(row.total_score),
        },
        completedAt: String(row.completed_at),
      };
    });

    const distinctWallets = new Set(rows.map((r) => String(r.wallet_address).toLowerCase()));

    const boardPolicy =
      policyVersion === this.policy.version
        ? this.policy
        : (resolveKnownGamePolicy(policyVersion) ?? this.policy);

    return {
      weekKey,
      policyVersion,
      rankingFormula: boardPolicy.rankingFormula,
      totalQualifiedWallets: distinctWallets.size,
      entries,
    };
  }

  private getResultRankInfo(
    resultId: string,
    weekKey: string,
    policyVersion?: string,
  ): { rank: number | null; isPersonalBest: boolean } {
    const board = this.getWeeklyLeaderboard({ weekKey, policyVersion, limit: 100 });
    const found = board.entries.find((e) => e.resultId === resultId);
    return {
      rank: found ? found.rank : null,
      isPersonalBest: Boolean(found),
    };
  }

  getPublicResultById(resultId: string): {
    resultId: string;
    snapshot: CharacterSnapshot;
    metadata: Record<string, unknown>;
    player: {
      shortWallet: string;
      displayName: string | null;
      effectiveName: string;
    };
    leaderboardRank: number | null;
  } {
    if (typeof resultId !== "string" || !resultId.trim()) {
      throw new HttpError(404, "Character result record not found.");
    }
    const row = this.db
      .prepare(
        `SELECT r.*, p.wallet_address AS player_wallet_exists, p.display_name AS current_display_name
         FROM hatched_results r
         LEFT JOIN players p ON p.wallet_address = r.wallet_address
         WHERE r.result_id = ?`,
      )
      .get(resultId) as Record<string, unknown> | undefined;

    if (!row) {
      throw new HttpError(404, "Character result record not found.");
    }

    const checksumAddress = String(row.checksum_address);
    const displayName = this.resolvePlayerDisplayNameFromJoinRow(row);
    const effectiveName = formatEffectivePlayerName(checksumAddress, displayName);

    const rawSnapshot = JSON.parse(String(row.snapshot_json)) as CharacterSnapshot;
    const snapshot = sanitizePublicCharacterSnapshot({
      ...rawSnapshot,
      displayName,
      effectivePlayerName: effectiveName,
    });
    const metadata = JSON.parse(buildLedMetadataJson(snapshot)) as Record<string, unknown>;
    const rankInfo = this.getResultRankInfo(
      resultId,
      snapshot.weekKey,
      snapshot.policyVersion,
    );

    return {
      resultId: snapshot.resultId,
      snapshot,
      metadata,
      player: {
        shortWallet: shortWalletAddress(checksumAddress),
        displayName,
        effectiveName,
      },
      leaderboardRank: rankInfo.rank,
    };
  }

  private verifyCsrfOrigin(req: IncomingMessage): { origin: string; domain: string } {
    const method = (req.method ?? "GET").toUpperCase();
    const hostHeader = req.headers.host ?? "localhost";
    const originHeader = req.headers.origin;

    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      if (originHeader) {
        try {
          const u = new URL(originHeader);
          return { origin: u.origin, domain: u.host };
        } catch {
          // ignore
        }
      }
      return { origin: `http://${hostHeader}`, domain: hostHeader };
    }

    if (!originHeader || typeof originHeader !== "string") {
      throw new HttpError(403, "Missing Origin header on state-changing request.");
    }

    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(originHeader);
    } catch {
      throw new HttpError(403, "Malformed Origin header.");
    }

    if (this.allowedOrigins.size > 0 && !this.allowedOrigins.has(parsedOrigin.origin)) {
      throw new HttpError(403, "Origin is not allowed.");
    }

    if (parsedOrigin.host !== hostHeader && !this.allowedOrigins.has(parsedOrigin.origin)) {
      throw new HttpError(403, "Cross-origin state-changing request rejected.");
    }

    return { origin: parsedOrigin.origin, domain: parsedOrigin.host };
  }

  private requireAuth(req: IncomingMessage): PlayerProfile {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    const player = this.getSessionFromToken(token);
    if (!player) {
      throw new HttpError(
        401,
        "Authentication required. Connect your wallet and sign the SIWE challenge first.",
      );
    }
    return player;
  }

  async handleApiRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const urlObj = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (!urlObj.pathname.startsWith("/api/")) {
      return false;
    }

    try {
      const { origin, domain } = this.verifyCsrfOrigin(req);
      const method = (req.method ?? "GET").toUpperCase();
      const pathname = urlObj.pathname;

      if (method === "GET" && pathname === "/api/policy") {
        this.sendJson(res, 200, {
          policy: {
            ...this.policy,
            accessoryWorkStep: this.policy.accessoryWorkStep.toString(),
          },
          knownPolicyVersions: Object.keys(KNOWN_GAME_POLICIES),
          calibrationProfile: DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
          backgroundRarityModel: deriveBackgroundRarityModel(
            this.policy,
            DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
          ),
          currentWeekKey: gameWeekKey(this.now()),
          schedules: {
            paletteStepMm: this.policy.paletteDistanceStepMm,
            accessoryStepWork: this.policy.accessoryWorkStep.toString(),
            dailyResetRule: "12:00 UTC (19:00 Asia/Saigon)",
          },
          catalogs: {
            families: FAMILIES,
            palettes: PALETTES,
            accessories: LED_ACCESSORIES,
            backgrounds: LED_BACKGROUNDS,
          },
        });
        return true;
      }

      if (method === "GET" && pathname === "/api/hardware/status") {
        const telemetry = await this.getHardwareTelemetry();
        this.sendJson(res, 200, {
          source: telemetry.source,
          policyVersion: this.policy.version,
          measurementDayKey: telemetry.measurementDayKey,
          dailyDistanceMm: telemetry.dailyDistanceMm,
          scheduleDistanceMm: telemetry.scheduleDistanceMm,
          cumulativeWorkUnits: telemetry.cumulativeWorkUnits,
          dayStartWorkUnits: telemetry.dayStartWorkUnits,
          reading: telemetry.serializedReading,
          paletteSchedule: telemetry.serializedPaletteSchedule,
          accessorySchedule: telemetry.serializedAccessorySchedule,
          updatedAtMs: telemetry.updatedAtMs,
          signal: telemetry.signal,
        });
        return true;
      }

      if (method === "GET" && pathname === "/api/auth/session") {
        const cookies = parseCookies(req.headers.cookie);
        const player = this.getSessionFromToken(cookies[SESSION_COOKIE_NAME]);
        const allowance = player ? this.getDailyAllowanceDto(player.walletAddress) : null;
        this.sendJson(res, 200, {
          authenticated: Boolean(player),
          player,
          sybilPolicy: this.policy.sybilPolicy,
          allowance,
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/auth/challenge") {
        const body = await this.readJsonBody(req);
        const challenge = this.createAuthChallenge({
          walletAddress: String(body.walletAddress ?? ""),
          chainId: body.chainId !== undefined ? Number(body.chainId) : undefined,
          origin,
          domain,
        });
        this.sendJson(res, 200, challenge);
        return true;
      }

      if (method === "POST" && pathname === "/api/auth/verify") {
        const body = await this.readJsonBody(req);
        const verified = await this.verifyAuthChallenge({
          challengeId: typeof body.challengeId === "string" ? body.challengeId : undefined,
          nonce: typeof body.nonce === "string" ? body.nonce : undefined,
          walletAddress: String(body.walletAddress ?? ""),
          signature: String(body.signature ?? ""),
          chainId: body.chainId !== undefined ? Number(body.chainId) : undefined,
          origin,
          domain,
        });
        const isHttps = origin.startsWith("https://");
        const cookieParts = [
          `${SESSION_COOKIE_NAME}=${encodeURIComponent(verified.token)}`,
          "HttpOnly",
          "SameSite=Lax",
          "Path=/",
          `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        ];
        if (isHttps) cookieParts.push("Secure");
        res.setHeader("Set-Cookie", cookieParts.join("; "));
        this.sendJson(res, 200, {
          authenticated: true,
          player: verified.player,
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/auth/logout") {
        const cookies = parseCookies(req.headers.cookie);
        this.revokeSessionToken(cookies[SESSION_COOKIE_NAME]);
        res.setHeader(
          "Set-Cookie",
          `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
        );
        this.sendJson(res, 200, { authenticated: false, player: null });
        return true;
      }

      if ((method === "PUT" || method === "POST") && pathname === "/api/profile") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        if (
          body.walletAddress !== undefined &&
          String(body.walletAddress).toLowerCase() !== player.walletAddress.toLowerCase()
        ) {
          throw new HttpError(403, "Cannot modify another wallet's profile.");
        }
        const updated = this.updatePlayerDisplayName(player.walletAddress, body.displayName);
        this.sendJson(res, 200, { player: updated });
        return true;
      }

      if (method === "GET" && pathname === "/api/session/active") {
        const player = this.requireAuth(req);
        const session = await this.getActiveRankedSession(player.walletAddress);
        const allowance = this.getDailyAllowanceDto(player.walletAddress);
        this.sendJson(res, 200, { session, allowance });
        return true;
      }

      if (method === "POST" && pathname === "/api/session/egg") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const session = this.claimRankedEgg(player.walletAddress, body);
        const allowance = this.getDailyAllowanceDto(player.walletAddress);
        this.sendJson(res, 201, { session, allowance });
        return true;
      }

      if (method === "POST" && pathname === "/api/session/restart") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.restartRankedSession(player.walletAddress, body);
        const allowance = this.getDailyAllowanceDto(player.walletAddress);
        this.sendJson(res, 200, { session: result.session, allowance });
        return true;
      }

      if (method === "POST" && pathname === "/api/session/start") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.startRankedIllumination(player.walletAddress, body);
        this.sendJson(res, 200, {
          session: result.session,
          reading: result.telemetry.serializedReading,
          paletteSchedule: result.telemetry.serializedPaletteSchedule,
          accessorySchedule: result.telemetry.serializedAccessorySchedule,
          updatedAtMs: result.telemetry.updatedAtMs,
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/session/aim") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.aimRankedSession(player.walletAddress, body);
        this.sendJson(res, 200, result);
        return true;
      }

      if (method === "POST" && pathname === "/api/session/pause") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.pauseRankedSession(player.walletAddress, body);
        this.sendJson(res, 200, result);
        return true;
      }

      if (method === "POST" && pathname === "/api/session/tick") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.tickRankedSession(player.walletAddress, body);
        this.sendJson(res, 200, {
          session: result.session,
          levelUps: result.levelUps,
          readyToComplete: result.readyToComplete,
          reading: result.telemetry.serializedReading,
          paletteSchedule: result.telemetry.serializedPaletteSchedule,
          accessorySchedule: result.telemetry.serializedAccessorySchedule,
          updatedAtMs: result.telemetry.updatedAtMs,
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/session/abandon") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = this.abandonRankedSession(player.walletAddress, body);
        this.sendJson(res, 200, result);
        return true;
      }

      if (method === "POST" && pathname === "/api/session/complete") {
        const player = this.requireAuth(req);
        const body = await this.readJsonBody(req);
        const result = await this.completeRankedSession(player.walletAddress, body);
        this.sendJson(res, 200, result);
        return true;
      }

      if (method === "GET" && pathname === "/api/leaderboard") {
        const weekKey = urlObj.searchParams.get("weekKey") ?? undefined;
        const policyVersion = urlObj.searchParams.get("policyVersion") ?? undefined;
        const limitParam = urlObj.searchParams.get("limit");
        const limit = limitParam ? Number(limitParam) : 100;
        const board = this.getWeeklyLeaderboard({ weekKey, policyVersion, limit });
        this.sendJson(res, 200, board);
        return true;
      }

      if (method === "GET" && pathname.startsWith("/api/results/")) {
        const resultId = decodeURIComponent(pathname.slice("/api/results/".length));
        if (!resultId) {
          throw new HttpError(400, "Missing resultId.");
        }
        const detail = this.getPublicResultById(resultId);
        this.sendJson(res, 200, detail);
        return true;
      }

      this.sendJson(res, 404, { error: `Unknown API endpoint: ${method} ${pathname}` });
      return true;
    } catch (err) {
      if (err instanceof HttpError) {
        this.sendJson(res, err.statusCode, { error: err.message });
        return true;
      }
      const message = err instanceof Error ? err.message : "Internal server error";
      this.sendJson(res, 500, { error: message });
      return true;
    }
  }

  private async readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buf.length;
      if (totalBytes > 65536) {
        throw new HttpError(413, "Request body too large.");
      }
      chunks.push(buf);
    }
    if (chunks.length === 0) return {};
    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {};
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new HttpError(400, "JSON body must be an object.");
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(400, "Malformed JSON request body.");
    }
  }

  private sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.end(body);
  }
}

export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}
