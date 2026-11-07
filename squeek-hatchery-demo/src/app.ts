import "./style.css";
import { readApiJson } from "./api-response.ts";
import { restoreRankedAttempt } from "./ranked-recovery.ts";
import {
  DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
  DEFAULT_GAME_POLICY,
  EXPERIMENTAL_POLICY_V1,
  EXPERIMENTAL_POLICY_V2,
  FAMILIES,
  LATEST_GAME_POLICY,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  LED_REGION_LABELS,
  LED_STAGE_DESCRIPTIONS,
  PALETTES,
  accessoryByIndex,
  accessoryScheduleAt,
  backgroundByIndex,
  calculateScoreBreakdown,
  deriveBackgroundRarityModel,
  familyByIndex,
  ledLampPower,
  paletteByIndex,
  paletteScheduleAt,
  pickRandomBackgroundIndex,
  rarityTierForPoints,
  resolveKnownGamePolicy,
  type FamilyId,
  type GamePolicy,
} from "./game-policy.ts";
import { LedPortraitAdapter, type LedRenderState } from "./led-renderer.ts";
import {
  browserPreviewScheduler,
  createScheduledPreviewGallery,
  leaderboardResponseIsCurrent,
  planLeaderboardPortraits,
  portraitVisualKey,
  shouldDrawPortrait,
  shouldResumeAccessoryAnimation,
  syncStableControlHost,
  type StableControlSpec,
} from "./ui-render-cache.ts";
import {
  buildCharacterSnapshot,
  buildLedMetadataJson,
  clearAttemptProgressKeepingEgg,
  createClientTelemetryTracker,
  createLedSession,
  createRankedClientCursor,
  decideRankedSessionInstall,
  formatEffectivePlayerName,
  getStageRenderStateForSession,
  isStaleRankedIntentError,
  levelUpAnnouncementKey,
  lockSessionTraits,
  noteRankedDesiredAim,
  playModeAllowsRankedMutation,
  rankedAbandonOnNewEggAllowed,
  rankedCommandFailureIsCurrent,
  rankedSessionMutationAllowed,
  shouldApplyRankedSessionResponse,
  shortWalletAddress,
  stageFamilyIndexForSelection,
  stepLedSession,
  validatePlayerDisplayName,
  type CharacterSnapshot,
  type LedSession,
  type RankedClientCursor,
} from "./led-session.ts";
import {
  accountPopoverStyle,
  computeLampMountLayout,
  eggArtDestination,
  forEachSceneLed,
  incubationControlsVisible,
  INCUBATION_SCENE,
  interiorPixelsOpen,
  interiorVisibleAt,
  lampArtSampleBounds,
  paintLedDots,
  pointInFamilyEgg,
  positionForRegionAim,
  positionForSceneRailY,
  presentationForStage,
  sampleLedBeamDots,
  SCENE_LED_GRID,
  sceneRailGeometry,
  sceneRailSpan,
  shellDotVisibleAt,
  stageCanvasClipPath,
  stagePointToLampImage,
  stageRegionAnchor,
  stageToMaster,
  type RgbaImage,
} from "./led-scene.ts";
import {
  clamp,
  measurementDayKey,
  regionAt,
  type Reading,
} from "./rules.ts";
import {
  SEPOLIA_ID,
  connectWith,
  connection,
  disconnectWallet,
  errorMessage,
  initWallet,
  onConnection,
  onConnectors,
  signChallengeMessage,
  switchToSepolia,
  walletRows,
} from "./wallet.ts";
import type {
  DailyAllowanceDto,
  LeaderboardEntryDto,
  PlayerProfile,
  SerializedReading,
  SerializedScheduleWindow,
} from "./backend.ts";

type RouteView =
  | { kind: "play" }
  | { kind: "leaderboard" }
  | { kind: "docs" }
  | { kind: "result"; resultId: string };

const LAB_ASSETS_BASE_URL = "/lab-assets/";
const CLIENT_POLL_TIMEOUT_MS = 3000;

function parseCurrentRoute(): RouteView {
  const hash = window.location.hash.trim();
  const pathname = window.location.pathname.trim();

  if (hash.startsWith("#result/")) {
    const resultId = decodeURIComponent(hash.slice("#result/".length).trim());
    if (resultId) return { kind: "result", resultId };
  }
  if (hash.startsWith("#nft/")) {
    const resultId = decodeURIComponent(hash.slice("#nft/".length).trim());
    if (resultId) return { kind: "result", resultId };
  }
  if (pathname.startsWith("/result/")) {
    const resultId = decodeURIComponent(pathname.slice("/result/".length).trim());
    if (resultId) return { kind: "result", resultId };
  }
  if (pathname.startsWith("/nft/")) {
    const resultId = decodeURIComponent(pathname.slice("/nft/".length).trim());
    if (resultId) return { kind: "result", resultId };
  }
  if (
    hash === "#docs" ||
    hash.startsWith("#docs/") ||
    pathname === "/docs" ||
    pathname.startsWith("/docs/")
  ) {
    return { kind: "docs" };
  }
  if (hash === "#leaderboard" || pathname === "/leaderboard") {
    return { kind: "leaderboard" };
  }
  return { kind: "play" };
}

function navigateToHash(hash: string): void {
  if (
    (window.location.pathname === "/docs" ||
      window.location.pathname.startsWith("/result/") ||
      window.location.pathname.startsWith("/nft/") ||
      window.location.pathname === "/leaderboard") &&
    hash !== window.location.hash
  ) {
    window.history.pushState(null, "", "/" + hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return;
  }
  if (window.location.hash === hash) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    window.location.hash = hash;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function tierBadgeLabel(points: number): string {
  if (points === 8) return "Apex · 8 pts";
  if (points === 4) return "Rare · 4 pts";
  if (points === 2) return "Uncommon · 2 pts";
  return "Common · 1 pt";
}

function policyForSession(session: Pick<LedSession, "policyVersion">): GamePolicy {
  return resolveKnownGamePolicy(session.policyVersion) ?? DEFAULT_GAME_POLICY;
}

/* RANKED_DISPLAY_CLOCK_START */
// Presentation-only Ranked timer. acceptedElapsed stores the server sample.
// anchorElapsed plus anchorMonoMs is the carried presentation origin, so a lower
// late sample does not freeze the readout. Local steps do not move that origin.
export const RANKED_DISPLAY_MAX_SECONDS = 60;

export type RankedDisplayFreeze =
  | "egg"
  | "reset"
  | "completed"
  | "interrupted"
  | "recovery"
  | "stale-telemetry"
  | "non-play"
  | "hidden";

export interface RankedDisplayClock {
  sessionId: string | null;
  generation: number | null;
  /** Last accepted server elapsed. Local steps do not change this. */
  acceptedElapsed: number;
  /** Presentation origin. Independent of a lower acceptedElapsed. */
  anchorElapsed: number;
  /** performance.now() when anchorElapsed was set. */
  anchorMonoMs: number;
  /** Highest seconds already shown for this attempt. */
  presented: number;
  advancing: boolean;
  hold: RankedDisplayFreeze | null;
}

export interface RankedDisplayAnchorInput {
  clock: RankedDisplayClock;
  responseGeneration: number;
  liveGeneration: number;
  sessionId: string;
  serverElapsed: number;
  nowMonoMs: number;
  durationSeconds: number;
  advancing: boolean;
  hold?: RankedDisplayFreeze | null;
}

export interface RankedDisplayLiveState {
  nowMonoMs: number;
  durationSeconds: number;
  liveGeneration: number;
  sessionId: string | null;
  serverElapsed: number;
  status: "egg" | "running" | "paused" | "completed";
  telemetryHealthy: boolean;
  recovering: boolean;
  route: "play" | "other";
  hidden: boolean;
}

const RANKED_DISPLAY_RESET_REASONS: readonly RankedDisplayFreeze[] = [
  "egg",
  "reset",
  "interrupted",
];

export function createRankedDisplayClock(): RankedDisplayClock {
  return {
    sessionId: null,
    generation: null,
    acceptedElapsed: 0,
    anchorElapsed: 0,
    anchorMonoMs: 0,
    presented: 0,
    advancing: false,
    hold: null,
  };
}

function rankedDisplayCap(durationSeconds: number): { label: number; cap: number } {
  const label =
    Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : RANKED_DISPLAY_MAX_SECONDS;
  return { label, cap: Math.min(RANKED_DISPLAY_MAX_SECONDS, label) };
}

function clampRankedDisplaySeconds(value: number, cap: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (value >= cap) return cap;
  return value;
}

export function projectRankedDisplay(
  clock: RankedDisplayClock,
  nowMonoMs: number,
  durationSeconds: number,
): number {
  const { cap } = rankedDisplayCap(durationSeconds);
  const presented = clampRankedDisplaySeconds(clock.presented, cap);
  if (!clock.advancing || clock.generation === null || clock.sessionId === null) {
    return presented;
  }
  const delta = nowMonoMs - clock.anchorMonoMs;
  const extra = Number.isFinite(delta) && delta > 0 ? delta / 1000 : 0;
  const origin = clampRankedDisplaySeconds(
    Number.isFinite(clock.anchorElapsed) ? clock.anchorElapsed : presented,
    cap,
  );
  return clampRankedDisplaySeconds(Math.max(presented, origin + extra), cap);
}

export function anchorRankedDisplayClock(input: RankedDisplayAnchorInput): RankedDisplayClock {
  if (
    !Number.isFinite(input.responseGeneration) ||
    !Number.isFinite(input.liveGeneration) ||
    input.responseGeneration !== input.liveGeneration ||
    input.sessionId.length === 0
  ) {
    return input.clock;
  }
  const { cap } = rankedDisplayCap(input.durationSeconds);
  const accepted = clampRankedDisplaySeconds(input.serverElapsed, cap);
  const now = Number.isFinite(input.nowMonoMs) ? input.nowMonoMs : 0;
  const sameAttempt =
    input.clock.sessionId === input.sessionId &&
    input.clock.generation === input.liveGeneration;
  const carried = sameAttempt
    ? projectRankedDisplay(input.clock, now, input.durationSeconds)
    : 0;
  const presented = clampRankedDisplaySeconds(Math.max(carried, accepted), cap);
  const advancing = Boolean(input.advancing) && presented + 1e-9 < cap;
  return {
    sessionId: input.sessionId,
    generation: input.liveGeneration,
    acceptedElapsed: accepted,
    anchorElapsed: presented,
    anchorMonoMs: now,
    presented,
    advancing,
    hold: advancing ? null : input.hold ?? null,
  };
}

export function freezeRankedDisplayClock(
  clock: RankedDisplayClock,
  nowMonoMs: number,
  durationSeconds: number,
  reason: RankedDisplayFreeze,
): RankedDisplayClock {
  if (RANKED_DISPLAY_RESET_REASONS.includes(reason)) return createRankedDisplayClock();
  const now = Number.isFinite(nowMonoMs) ? nowMonoMs : 0;
  const presented = projectRankedDisplay(clock, now, durationSeconds);
  return {
    sessionId: clock.sessionId,
    generation: clock.generation,
    acceptedElapsed: clock.acceptedElapsed,
    anchorElapsed: presented,
    anchorMonoMs: now,
    presented,
    advancing: false,
    hold: reason,
  };
}

export function reconcileRankedDisplayClock(
  clock: RankedDisplayClock,
  live: RankedDisplayLiveState,
): RankedDisplayClock {
  const now = Number.isFinite(live.nowMonoMs) ? live.nowMonoMs : 0;
  if (live.hidden) {
    if (!clock.advancing) return clock;
    return freezeRankedDisplayClock(clock, now, live.durationSeconds, "hidden");
  }
  if (live.route !== "play") {
    if (!clock.advancing) return clock;
    return freezeRankedDisplayClock(clock, now, live.durationSeconds, "non-play");
  }
  if (live.status === "egg") return createRankedDisplayClock();
  if (live.status === "paused" || live.status === "completed") {
    if (!live.sessionId) return createRankedDisplayClock();
    const foreign =
      clock.generation !== null &&
      (clock.generation !== live.liveGeneration || clock.sessionId !== live.sessionId);
    if (foreign) return clock.advancing ? { ...clock, advancing: false } : clock;
    return anchorRankedDisplayClock({
      clock,
      responseGeneration: live.liveGeneration,
      liveGeneration: live.liveGeneration,
      sessionId: live.sessionId,
      serverElapsed: live.serverElapsed,
      nowMonoMs: now,
      durationSeconds: live.durationSeconds,
      advancing: false,
      hold: "completed",
    });
  }
  if (!live.telemetryHealthy) {
    if (!clock.advancing) {
      return clock.hold === "stale-telemetry" ? clock : { ...clock, hold: "stale-telemetry" };
    }
    return freezeRankedDisplayClock(clock, now, live.durationSeconds, "stale-telemetry");
  }
  if (live.recovering) {
    if (!clock.advancing) {
      return clock.hold === "recovery" ? clock : { ...clock, hold: "recovery" };
    }
    return freezeRankedDisplayClock(clock, now, live.durationSeconds, "recovery");
  }
  if (
    !live.sessionId ||
    clock.generation === null ||
    clock.sessionId !== live.sessionId ||
    clock.generation !== live.liveGeneration
  ) {
    if (!clock.advancing) return clock;
    return { ...clock, advancing: false };
  }
  if (!clock.advancing && (clock.hold === "hidden" || clock.hold === "non-play")) {
    const { cap } = rankedDisplayCap(live.durationSeconds);
    const accepted = clampRankedDisplaySeconds(live.serverElapsed, cap);
    const base = clampRankedDisplaySeconds(Math.max(clock.presented, accepted), cap);
    return {
      sessionId: clock.sessionId,
      generation: clock.generation,
      acceptedElapsed: accepted,
      anchorElapsed: base,
      anchorMonoMs: now,
      presented: base,
      advancing: base + 1e-9 < cap,
      hold: null,
    };
  }
  if (!clock.advancing) return clock;
  const seconds = projectRankedDisplay(clock, now, live.durationSeconds);
  const { cap } = rankedDisplayCap(live.durationSeconds);
  const atCap = seconds + 1e-9 >= cap;
  return {
    ...clock,
    presented: seconds,
    advancing: !atCap,
    hold: null,
  };
}

export function formatRankedTimerReadout(seconds: number, durationSeconds: number): string {
  const { label, cap } = rankedDisplayCap(durationSeconds);
  let value = clampRankedDisplaySeconds(seconds, cap);
  if (value + 1e-9 < cap) {
    const tenth = Number(value.toFixed(1));
    if (tenth + 1e-9 >= cap) value = Math.max(0, cap - 0.1);
  }
  return `${value.toFixed(1)}s / ${label}s`;
}
/* RANKED_DISPLAY_CLOCK_END */

export async function mountApp(): Promise<void> {
  const appRoot = document.getElementById("app");
  if (!appRoot) return;

  // Initialize wallet config with storage: null (in-memory only for guest mode)
  await initWallet();

  // ---------- Ephemeral In-Memory State ----------
  let currentRoute: RouteView = parseCurrentRoute();
  let authPlayer: PlayerProfile | null = null;
  let walletSheetOpen = false;
  let accountMenuOpen = false;
  let userAllowance: DailyAllowanceDto | null = null;
  let activePlayMode: "ranked" | "demo" = "ranked";
  let selectedFamilyIndex: 0 | 1 | 2 = 0;
  let eggConfirmed = false;
  let statusBanner: { tone: "info" | "ok" | "warn" | "err"; text: string } | null = null;

  // Guest session lives in browser memory (never written to localStorage/sessionStorage/IndexedDB/cookies/DB)
  let guestSession: LedSession = createLedSession({
    mode: "guest",
    familyIndex: 0,
    policy: LATEST_GAME_POLICY,
  });
  let guestSnapshot: CharacterSnapshot | null = null;

  // Ranked session mirrored from authoritative backend
  let rankedSession: LedSession | null = null;
  let rankedWriteEpoch = 0;
  let rankedAimCursor: RankedClientCursor = createRankedClientCursor();
  let rankedDisplayClock = createRankedDisplayClock();
  // Every new document must clear any unfinished attempt before Ranked first light.
  let rankedRecoveryNeeded = true;
  let authRefreshInFlight: Promise<void> | null = null;
  const announcedLevelUps = new Set<string>();
  let rankedSnapshot: CharacterSnapshot | null = null;
  let rankedLeaderboardRank: number | null = null;

  // Client telemetry tracker enforces freshness before first light and each growth step,
  // retains replay baseline across transient outages, and ignores stale late responses (R11).
  const telemetryTracker = createClientTelemetryTracker({
    now: () => Date.now(),
  });
  let hardwarePollInFlight = false;

  let latestReading: Reading = {
    coreStatus: "IDLE",
    rpm: 0,
    meters: 0,
    distanceMm: 0,
    work: 0n,
    counterEpoch: "0",
    installationId: undefined,
    observedAt: 0,
    received: 0,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(Date.now()),
  };
  let hardwareHealthy = false;
  let hardwareError: string | null = "Signal unavailable — waiting for fresh hardware telemetry.";
  let telemetrySource: "live" | "fallback" | "simulated" = "live";
  let dayStartWorkUnits = 0n;
  let currentPaletteSchedule: SerializedScheduleWindow | null = null;
  let currentAccessorySchedule: SerializedScheduleWindow | null = null;
  let clientEffectivePower = 0;
  let clientEffectiveRpm = 0;
  let clientSignalState: "ok" | "speed-unavailable" | "unavailable" = "unavailable";

  function syncTelemetryFreshness(nowMs = Date.now()): boolean {
    const check = telemetryTracker.checkFreshnessForStep(nowMs);
    hardwareHealthy = check.healthy;
    hardwareError = check.error;
    dayStartWorkUnits = check.dayStartWorkUnits;
    clientEffectivePower = check.effectivePower;
    clientEffectiveRpm = check.effectiveRpm;
    clientSignalState = check.signalState;
    if (check.reading) {
      latestReading = check.reading;
    }
    return check.healthy;
  }

  // Leaderboard & Public Result state
  let leaderboardWeekKey = "";
  let leaderboardEntries: LeaderboardEntryDto[] = [];
  let leaderboardLoading = false;
  let leaderboardFetchGen = 0;
  let leaderboardViewSignature = "";
  let leaderboardPlaceholderReady = false;
  let stagePortraitKey: string | null = null;
  let nftPortraitKey: string | null = null;
  let nftDrawToken = 0;
  let nftDetailRequestGen = 0;
  const leaderboardPortraits = new Map<
    string,
    { adapter: LedPortraitAdapter; canvas: HTMLCanvasElement; visualKey: string }
  >();
  let nftDetailLoading = false;
  let nftDetailError: string | null = null;
  let nftDetailData: {
    resultId: string;
    snapshot: CharacterSnapshot;
    metadata: Record<string, unknown>;
    player: {
      shortWallet: string;
      displayName: string | null;
      effectiveName: string;
    };
    leaderboardRank: number | null;
  } | null = null;

  // Level-up visual indicator state
  let levelUpBanner: { region: 0 | 1 | 2; level: number; expiresAt: number } | null = null;
  let levelUpTimer: number | null = null;
  const v2RarityModel = deriveBackgroundRarityModel(
    EXPERIMENTAL_POLICY_V2,
    DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
  );

  const initialRail = sceneRailSpan();

  // ---------- DOM Skeleton ----------
  appRoot.innerHTML = `
    <div class="led-shell">
      <header class="led-topbar">
        <div class="led-brand-group">
          <a href="#play" class="led-brand" id="nav-brand">
            <span class="led-brand-dot" aria-hidden="true"></span>
            <span>Squeek Hatchery</span>
          </a>
        </div>

        <nav class="led-nav" aria-label="Primary navigation">
          <a href="#play" class="led-nav-link" data-nav="play">Play</a>
          <a href="#leaderboard" class="led-nav-link" data-nav="leaderboard">Weekly Top 100</a>
          <a href="#docs" class="led-nav-link" data-nav="docs">Docs</a>
        </nav>

        <div class="led-auth-bar" id="auth-bar"></div>
      </header>

      <div id="status-toast" class="led-toast" hidden role="status" aria-live="polite"></div>

      <!-- Wallet Connector Modal Sheet -->
      <div id="wallet-sheet" class="led-modal-backdrop" hidden>
        <div class="led-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-sheet-title">
          <div class="led-modal-head">
            <h2 id="wallet-sheet-title">Wallet & Ranked Sign-In (SIWE)</h2>
            <button type="button" class="led-btn-ghost" id="wallet-sheet-close" aria-label="Close wallet dialog">✕</button>
          </div>
          <p class="led-modal-sub">
            Guest mode works immediately without a wallet (progress disappears when you refresh). To save your Squeek character and compete on the Weekly Top 100 Leaderboard, connect an Ethereum wallet and sign a one-time SIWE login message (<code>personal_sign</code>, no gas or transaction).
          </p>
          <div id="wallet-connector-list" class="led-connector-list"></div>
        </div>
      </div>

      <!-- VIEW 1: PLAY -->
      <main id="view-play" class="led-view">
        <p class="led-play-intro">Hatch and raise your own hamster. <a href="#docs" id="play-to-docs-link" style="display:none;" aria-hidden="true">Docs</a></p>

        <!-- Mode Selector (Signed-In) -->
        <div id="mode-selector-container" style="display:none; margin-bottom: 0.85rem;"></div>

        <!-- Species/Egg Selector -->
        <div id="species-selector-container" class="led-card led-egg-selector-card" role="region" aria-labelledby="egg-select-heading">
          <div class="led-card-head">
            <div>
              <span class="led-kicker">SELECT YOUR EGG</span>
              <h2 id="egg-select-heading" class="led-card-title">Choose Hamster Species</h2>
            </div>
          </div>
          <div class="led-egg-cards-grid" role="radiogroup" aria-label="Choose hamster species">
            <button type="button" class="led-egg-card-btn led-species-btn selected" data-family-index="0" id="species-btn-pulse" role="radio" aria-checked="true">
              <img src="./art/egg-pulse-v2.png" alt="Pulse Egg" class="led-egg-preview-img" />
              <span class="led-egg-card-name">Pulse</span>
              <span class="led-egg-card-tag">Round radar-ear egg</span>
            </button>
            <button type="button" class="led-egg-card-btn led-species-btn" data-family-index="1" id="species-btn-relay" role="radio" aria-checked="false">
              <img src="./art/egg-relay-v2.png" alt="Relay Egg" class="led-egg-preview-img" />
              <span class="led-egg-card-name">Relay</span>
              <span class="led-egg-card-tag">Pear-shaped signal egg</span>
            </button>
            <button type="button" class="led-egg-card-btn led-species-btn" data-family-index="2" id="species-btn-prism" role="radio" aria-checked="false">
              <img src="./art/egg-prism-v2.png" alt="Prism Egg" class="led-egg-preview-img" />
              <span class="led-egg-card-name">Prism</span>
              <span class="led-egg-card-tag">Diamond crystal egg</span>
            </button>
          </div>
          <div style="margin-top: 0.85rem; text-align: center;">
            <button type="button" class="led-btn-primary" id="btn-confirm-egg">Confirm & Claim Egg</button>
          </div>
        </div>

        <div class="led-play-grid">
          <!-- Left Column: Interactive LED Stage & Lamp Rail -->
          <section class="led-card led-stage-card" aria-labelledby="stage-heading">
            <div class="led-card-head">
              <div>
                <span class="led-kicker" id="session-mode-badge">GUEST MODE · PROGRESS DISAPPEARS WHEN YOU REFRESH</span>
                <h1 id="stage-heading" class="led-card-title">Incubation Chamber</h1>
              </div>
              <div class="led-timer-readout" id="timer-readout">0.0s / 60s</div>
            </div>

            <!-- Square 1600x1600 Portrait Stage + Lamp Aiming Rail -->
            <div class="led-stage-Interactive">
              <div class="led-canvas-wrap" id="stage-canvas-wrap">
                <canvas id="led-stage-canvas" width="1600" height="1600" aria-label="1600 by 1600 LED Hamster Portrait"></canvas>
                <canvas id="led-scene-fx" width="${INCUBATION_SCENE.width}" height="${INCUBATION_SCENE.height}" aria-hidden="true"></canvas>
                <svg id="stage-svg" viewBox="0 0 ${INCUBATION_SCENE.width} ${INCUBATION_SCENE.height}" class="led-stage-svg" aria-hidden="true">
                  <defs>
                    <clipPath id="eggInterior">
                      <ellipse cx="200" cy="215" rx="118" ry="152" />
                    </clipPath>
                  </defs>
                  <g id="shell"></g>
                  <g id="beam-layer" class="led-beam-layer" style="opacity: 0;"></g>
                  <line id="lamp-rail" x1="${initialRail.x}" y1="${initialRail.y1}" x2="${initialRail.x}" y2="${initialRail.y2}" stroke="#8a7360" stroke-width="5" stroke-linecap="round"/>
                  <g id="lamp-art"></g>
                </svg>
                <div id="lamp-handle-elem" class="lamp-handle" role="slider" tabindex="0" aria-label="Aim heat lamp height. Arrow keys move across Head, Body and Chest, and Belly and Tail." aria-orientation="vertical" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="-70"></div>
                <div id="rail-hit" class="rail-hit" aria-hidden="true"></div>
                <p class="visually-hidden" id="lamp-aim-instructions">
                  Drag or touch the heat lamp on the rail to aim illumination. Use arrow keys, Page Up, Page Down, Home, and End while the lamp handle is focused.
                </p>
                <div id="beam-overlay" class="led-beam-overlay" data-region="0" hidden aria-hidden="true"></div>
                <div id="region-led-pulse" class="region-led-pulse" hidden></div>
                <div id="levelup-badge" class="led-levelup-badge" hidden aria-live="polite"></div>
                <input type="range" id="lamp" min="-100" max="100" value="-70" class="visually-hidden" tabindex="-1" aria-hidden="true" />
              </div>
            </div>

            <!-- Primary Session Controls -->
            <div class="led-controls-row" id="session-controls"></div>
          </section>

          <!-- Right Column: Regional Growth, Live Hardware & Trait Schedules -->
          <div class="led-side-stack">
            <!-- Regional Growth Lv0-10 -->
            <section class="led-card" aria-labelledby="regions-heading">
              <div class="led-card-head">
                <h2 id="regions-heading" class="led-card-title">Regional Growth</h2>
                <span class="led-score-pill" id="region-score-pill" style="display: none;">Regions: 0 / 30 pts</span>
              </div>
              <div class="led-regions-list" id="regions-list"></div>
            </section>

            <!-- Trait Lock & Live Schedules -->
            <section class="led-card" aria-labelledby="schedules-heading">
              <div class="led-card-head">
                <h2 id="schedules-heading" class="led-card-title">Trait Schedules</h2>
                <span class="led-telemetry-badge" id="telemetry-badge">WHEEL ACTIVE</span>
              </div>
              <div class="led-telemetry-metrics" id="telemetry-metrics" style="display: none;"></div>
              <div class="led-schedules-grid" id="schedules-grid"></div>
              <div class="led-locked-box" id="locked-traits-box"></div>
            </section>

            <!-- Hidden Profile Card Container (retaining elements for backwards-compatibility) -->
            <section class="led-card" id="profile-card" style="display: none;" aria-labelledby="profile-heading">
              <div class="led-card-head">
                <h2 id="profile-heading" class="led-card-title">Player Identity</h2>
                <span class="led-subtle-tag" id="profile-auth-tag">Guest Mode</span>
              </div>
              <div id="profile-body"></div>
            </section>
          </div>
        </div>

        <!-- Completed Character Result & Export Panel -->
        <section id="result-panel" class="led-card led-result-card" hidden aria-labelledby="result-heading">
          <div class="led-card-head">
            <div>
              <span class="led-kicker" id="result-kicker">COMPLETED PORTRAIT · 1600×1600</span>
              <h2 id="result-heading" class="led-card-title">Completed Character Snapshot</h2>
            </div>
            <div class="led-result-actions">
              <button type="button" class="led-btn-primary" id="btn-export-png">Download 1600×1600 PNG</button>
              <button type="button" class="led-btn-secondary" id="btn-export-json">Download Metadata JSON</button>
            </div>
          </div>
          <div id="result-summary-body" class="led-result-summary"></div>
        </section>
      </main>

      <!-- VIEW 2: DEDICATED LEADERBOARD VIEW -->
      <main id="view-leaderboard" class="led-view" hidden>
        <section class="led-card">
          <div class="led-card-head">
            <div>
              <span class="led-kicker">WEEKLY RANKINGS · CLICK ANY ENTRY TO INSPECT 1600×1600 PORTRAIT</span>
              <h1 class="led-card-title">Weekly Top 100 Leaderboard</h1>
            </div>
            <div class="led-lb-head-actions">
              <a href="#play" class="led-btn-secondary">← Back to Play</a>
              <button type="button" class="led-btn-ghost" id="btn-refresh-lb-full">Refresh</button>
            </div>
          </div>
          <p class="led-section-note">
            Top 3 characters show full uncropped canonical portraits. Ranked sessions require wallet SIWE verification; each wallet's best individual character for the current week is ranked by Total Score.
          </p>
          <div id="full-leaderboard-container"></div>
        </section>
      </main>

      <!-- VIEW 3: PUBLIC CHARACTER RESULT DETAIL VIEW (#result/<resultId>) -->
      <main id="view-nft" class="led-view" hidden>
        <section class="led-card">
          <div class="led-card-head">
            <div>
              <span class="led-kicker">PUBLIC VERIFIED SNAPSHOT · 1600×1600 LED PORTRAIT</span>
              <h1 class="led-card-title" id="nft-view-title">Squeek Character Portrait</h1>
            </div>
            <div class="led-lb-head-actions">
              <a href="#play" class="led-btn-secondary">← Play</a>
              <a href="#leaderboard" class="led-btn-ghost">Weekly Top 100</a>
            </div>
          </div>
          <div id="nft-detail-status"></div>
          <div id="nft-detail-grid" class="led-nft-detail-grid" hidden>
            <div class="led-nft-canvas-col">
              <div class="led-canvas-wrap led-portrait-square">
                <canvas id="nft-detail-canvas" width="1600" height="1600" aria-label="Public 1600 by 1600 Squeek Character Portrait"></canvas>
              </div>
              <div class="led-result-actions">
                <button type="button" class="led-btn-primary" id="btn-nft-export-png">Download 1600×1600 PNG</button>
                <button type="button" class="led-btn-secondary" id="btn-nft-export-json">Download Metadata JSON</button>
              </div>
            </div>
            <div id="nft-detail-meta" class="led-nft-meta-col"></div>
          </div>
        </section>
      </main>

      <!-- VIEW 4: SEPARATE DOCUMENTATION PAGE (#docs) -->
      <main id="view-docs" class="led-view" hidden>
        <article class="led-card led-docs-article">
          <div class="led-card-head">
            <div>
              <h1 class="led-card-title">How Squeek Hatchery Works</h1>
            </div>
            <a href="#play" class="led-btn-primary">← Return to Chamber</a>
          </div>

          <div class="led-docs-grid">
            <section class="led-docs-block">
              <h2>1. Basic Play</h2>
              <p>
                Choose <strong>Pulse</strong>, <strong>Relay</strong>, or <strong>Prism</strong>, then drag or touch the heat lamp
                (keyboard supported) to warm <strong>Head</strong>, <strong>Body &amp; Chest</strong>, and <strong>Belly &amp; Tail</strong>.
                First light locks Coat Palette and Cyber Accessory together. The opaque shell reveals the hamster only in the lit spot.
                A finished incubation removes the shell for the full portrait. There is no manual pause; restart or disconnect
                keeps the chosen egg and clears growth plus trait locks until the next first light.
              </p>
              <div class="led-docs-mechanics">
                <p>Coat palettes shift with wheel distance; accessories shift with wheel effort. Both lock together at first illumination.</p>
                <p>Background is randomly assigned on completion. Rarer traits appear less often.</p>
                <p>Wheel speed controls lamp intensity; stronger light grows the aimed region faster. A resting wheel still provides gentle base warmth.</p>
              </div>
            </section>

            <section class="led-docs-block">
              <h2>2. Regional Growth</h2>
              <p>Each region advances from <code>Lv0</code> to <code>Lv10</code>:</p>
              <ul>
                <li><strong>Head:</strong> ears, cheeks, and head coat (<code>0–10</code>).</li>
                <li><strong>Body &amp; Chest:</strong> shoulders, chest, and front paws (<code>0–10</code>).</li>
                <li><strong>Belly &amp; Tail:</strong> abdomen, hind coat, feet, and tail (<code>0–10</code>).</li>
              </ul>
              <p>Regions contribute up to <strong>30 points</strong>. The Regional Growth cards also aim the lamp.</p>
            </section>

            <section class="led-docs-block">
              <h2>3. Trait Catalogs &amp; Points</h2>
              <p>Named items and points come from the active policy catalogs:</p>
              <div class="led-docs-catalogs" id="docs-catalog-tables"></div>
              <p class="led-docs-rarity-note">
                Higher-point traits appear less often than lower-point traits.
              </p>
            </section>

            <section class="led-docs-block">
              <h2>4. Total Score</h2>
              <p>Completed characters score from <strong>3 to 54</strong>:</p>
              <p class="led-docs-formula">
                Total = Regions (0–30) + Palette (1–8) + Accessory (1–8) + Background (1–8)
              </p>
              <p>
                Guest and Demo play stay in browser memory. Ranked play needs SIWE wallet sign-in; the Weekly Top 100 lives on its own page.
              </p>
            </section>
          </div>
        </article>
      </main>
    </div>
  `;

  // ---------- Canvas Adapters ----------
  const stageCanvas = document.getElementById("led-stage-canvas") as HTMLCanvasElement;
  const nftDetailCanvas = document.getElementById("nft-detail-canvas") as HTMLCanvasElement;

  const stageAdapter = new LedPortraitAdapter(stageCanvas, {
    basePath: LAB_ASSETS_BASE_URL,
  });
  const nftAdapter = new LedPortraitAdapter(nftDetailCanvas, {
    basePath: LAB_ASSETS_BASE_URL,
  });
  type DocsPreviewRecord = {
    state: LedRenderState;
    canvas: HTMLCanvasElement;
    adapter: LedPortraitAdapter | null;
  };
  const docsRecords = new Map<string, DocsPreviewRecord>();
  let docsCatalogReady = false;
  const docsGallery = createScheduledPreviewGallery(browserPreviewScheduler, {
    prepare(preview) {
      const record = docsRecords.get(preview.id);
      if (!record) return;
      if (!record.adapter) {
        record.adapter = new LedPortraitAdapter(record.canvas, {
          basePath: LAB_ASSETS_BASE_URL,
          size: 140,
        });
      }
      return record.adapter.load().then(() => undefined);
    },
    paint(preview) {
      const record = docsRecords.get(preview.id);
      if (!record?.adapter) return;
      record.adapter.draw(record.state, { staticOnly: true });
    },
    stop(preview) {
      docsRecords.get(preview.id)?.adapter?.stopAnimation();
    },
  });

  await stageAdapter.load().catch(() => {
    // Adapter handles missing asset recovery gracefully
  });

  // ---------- Helper Functions ----------
  function showToast(tone: "info" | "ok" | "warn" | "err", text: string): void {
    statusBanner = { tone, text };
    const el = document.getElementById("status-toast");
    if (!el) return;
    el.hidden = false;
    el.className = `led-toast led-toast-${tone}`;
    el.textContent = text;
  }

  function clearToast(): void {
    statusBanner = null;
    const el = document.getElementById("status-toast");
    if (el) el.hidden = true;
  }

  function triggerLevelUpEffect(region: 0 | 1 | 2, newLevel: number): void {
    const names = ["Head", "Body & Chest", "Belly & Tail"];
    levelUpBanner = {
      region,
      level: newLevel,
      expiresAt: Date.now() + 900,
    };
    const badge = document.getElementById("levelup-badge");
    const pulse = document.getElementById("region-led-pulse");
    if (badge) {
      badge.hidden = false;
      badge.textContent = `${names[region]} reached Lv${newLevel}!`;
      badge.className = prefersReducedMotion()
        ? "led-levelup-badge led-levelup-static"
        : "led-levelup-badge led-levelup-pulse";
    }
    if (pulse) {
      const anchor = stageRegionAnchor(region);
      pulse.hidden = false;
      pulse.className = prefersReducedMotion() ? "region-led-pulse" : "region-led-pulse is-live";
      pulse.style.left = `${(anchor.cx / INCUBATION_SCENE.width) * 100}%`;
      pulse.style.top = `${(anchor.cy / INCUBATION_SCENE.height) * 100}%`;
      pulse.style.width = `${((anchor.rx * 2) / INCUBATION_SCENE.width) * 100}%`;
      pulse.style.height = `${((anchor.ry * 2) / INCUBATION_SCENE.height) * 100}%`;
      if (!prefersReducedMotion()) {
        pulse.classList.remove("is-live");
        void pulse.offsetWidth;
        pulse.classList.add("is-live");
      }
    }
    if (levelUpTimer !== null) {
      window.clearTimeout(levelUpTimer);
    }
    levelUpTimer = window.setTimeout(() => {
      if (badge) badge.hidden = true;
      if (pulse) pulse.hidden = true;
    }, 900);
  }

  function announceLevelUps(
    sessionId: string,
    levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[] | undefined,
  ): void {
    for (const levelUp of levelUps ?? []) {
      if (!(levelUp.newLevel > levelUp.previousLevel)) continue;
      const key = levelUpAnnouncementKey(sessionId, levelUp.region, levelUp.newLevel);
      if (announcedLevelUps.has(key)) continue;
      announcedLevelUps.add(key);
      triggerLevelUpEffect(levelUp.region, levelUp.newLevel);
    }
  }

  function captureRankedWrite(): {
    epoch: number;
    sessionId: string | null;
    attemptId: string | null;
    revision: number;
  } {
    return {
      epoch: rankedWriteEpoch,
      sessionId: rankedSession?.id ?? null,
      attemptId: rankedAimCursor.attemptId,
      revision: rankedAimCursor.confirmedRevision,
    };
  }

  function forgetLevelUps(sessionId: string): void {
    for (const key of [...announcedLevelUps]) {
      if (key.startsWith(`${sessionId}:`)) announcedLevelUps.delete(key);
    }
  }

  function invalidateRankedWrites(): number {
    rankedWriteEpoch += 1;
    announcedLevelUps.clear();
    rankedDisplayClock = createRankedDisplayClock();
    rankedAimCursor = createRankedClientCursor();
    return rankedWriteEpoch;
  }

  function rankedOrderBody(): { attemptId?: string; aimIntent?: number } {
    if (!rankedAimCursor.attemptId) return {};
    return { attemptId: rankedAimCursor.attemptId, aimIntent: rankedAimCursor.desiredIntent };
  }

  function ignoreRankedFailure(
    captured: { epoch: number; sessionId: string | null; attemptId: string | null; revision: number },
    errorText: string | undefined,
  ): boolean {
    if (isStaleRankedIntentError(errorText)) return true;
    return !rankedCommandFailureIsCurrent({
      requestEpoch: captured.epoch,
      currentEpoch: rankedWriteEpoch,
      expectedSessionId: captured.sessionId,
      cursor: rankedAimCursor,
      capturedAttemptId: captured.attemptId,
      capturedRevision: captured.revision,
      capturedSessionId: captured.sessionId,
    });
  }

  function installRankedSession(
    incoming: LedSession,
    captured: { epoch: number },
    expectedSessionId: string | null,
  ): LedSession | null {
    if (
      rankedSession &&
      rankedSession.status === "completed" &&
      rankedSession.id === incoming.id &&
      incoming.status !== "completed"
    ) {
      return null;
    }
    const decision = decideRankedSessionInstall({
      cursor: rankedAimCursor,
      incoming,
      requestEpoch: captured.epoch,
      currentEpoch: rankedWriteEpoch,
      expectedSessionId,
    });
    if (!decision.apply || !decision.session || !decision.sideEffects) return null;
    rankedAimCursor = decision.cursor;
    rankedSession = decision.session;
    return rankedSession;
  }

  function acceptRankedWrite(
    captured: { epoch: number; sessionId: string | null },
    responseSessionId: string | null,
  ): boolean {
    return shouldApplyRankedSessionResponse({
      requestEpoch: captured.epoch,
      currentEpoch: rankedWriteEpoch,
      expectedSessionId: captured.sessionId,
      responseSessionId,
    });
  }

  function activeSession(): LedSession {
    return authPlayer && activePlayMode === "ranked" && rankedSession ? rankedSession : guestSession;
  }

  function activeCompletedSnapshot(): CharacterSnapshot | null {
    return authPlayer && activePlayMode === "ranked" && rankedSnapshot ? rankedSnapshot : guestSnapshot;
  }

  function getPortraitStateForActiveSession(): LedRenderState {
    const snap = activeCompletedSnapshot();
    const sess = activeSession();
    const sessPolicy = policyForSession(sess);
    const fallbackPalIdx =
      currentPaletteSchedule?.itemIndex ??
      paletteScheduleAt(latestReading.distanceMm, sessPolicy).itemIndex;
    const state = getStageRenderStateForSession(sess, snap, fallbackPalIdx);
    const family = stageFamilyIndexForSelection(
      eggConfirmed,
      selectedFamilyIndex,
      state.family as 0 | 1 | 2,
    );
    return { ...state, family };
  }

  function syncDocsCatalog(active: boolean): void {
    if (!active) {
      docsGallery.hide();
      return;
    }
    const host = document.getElementById("docs-catalog-tables");
    if (!host) return;
    if (!docsCatalogReady) {
      const policy = LATEST_GAME_POLICY;
      const paletteCards = PALETTES.map((item, index) => {
        const pts = policy.palettePoints[index] ?? 1;
        return `<article class="led-docs-preview-card">
        <canvas class="led-docs-palette-preview" data-palette-index="${index}" width="140" height="140" role="img" aria-label="${escapeAttr(item.name)} coat palette, ${pts} point${pts === 1 ? "" : "s"}"></canvas>
        <div class="led-docs-preview-name">${escapeText(item.name)}</div>
        <div class="led-docs-preview-pts">${pts} pt${pts === 1 ? "" : "s"}</div>
      </article>`;
      }).join("");
      const accessoryCards = LED_ACCESSORIES.map((item, index) => {
        const pts = policy.accessoryPoints[index] ?? 1;
        return `<article class="led-docs-preview-card">
        <canvas class="led-docs-acc-preview" data-acc-index="${index}" width="140" height="140" role="img" aria-label="${escapeAttr(item.name)} cyber accessory, ${pts} point${pts === 1 ? "" : "s"}"></canvas>
        <div class="led-docs-preview-name">${escapeText(item.name)}</div>
        <div class="led-docs-preview-pts">${pts} pt${pts === 1 ? "" : "s"}</div>
      </article>`;
      }).join("");
      const backgroundCards = LED_BACKGROUNDS.map((item, index) => {
        const pts = policy.backgroundPoints[index] ?? 1;
        const src = `${LAB_ASSETS_BASE_URL}${item.file}`;
        return `<article class="led-docs-preview-card">
        <img src="${escapeAttr(src)}" alt="${escapeAttr(item.name)} LED background, ${pts} point${pts === 1 ? "" : "s"}" width="140" height="140" loading="lazy" decoding="async" />
        <div class="led-docs-preview-name">${escapeText(item.name)}</div>
        <div class="led-docs-preview-pts">${pts} pt${pts === 1 ? "" : "s"}</div>
      </article>`;
      }).join("");

      host.innerHTML = `
      <section class="led-docs-section">
        <h3>Coat Palettes</h3>
        <div class="led-docs-preview-grid">${paletteCards}</div>
      </section>
      <section class="led-docs-section">
        <h3>Cyber Accessories</h3>
        <div class="led-docs-preview-grid">${accessoryCards}</div>
      </section>
      <section class="led-docs-section">
        <h3>Backgrounds</h3>
        <div class="led-docs-preview-grid">${backgroundCards}</div>
      </section>
    `;

      const previews: { id: string; visualKey: string }[] = [];
      host.querySelectorAll<HTMLCanvasElement>("canvas.led-docs-palette-preview").forEach((canvas) => {
        const idx = Number(canvas.dataset.paletteIndex ?? 0);
        const id = `palette:${idx}`;
        const state: LedRenderState = {
          family: 0,
          levels: [8, 8, 8],
          palette: idx,
          accessory: -1,
          background: -1,
        };
        docsRecords.set(id, { state, canvas, adapter: null });
        previews.push({ id, visualKey: portraitVisualKey({ ...state, staticOnly: true }) });
      });
      host.querySelectorAll<HTMLCanvasElement>("canvas.led-docs-acc-preview").forEach((canvas) => {
        const idx = Number(canvas.dataset.accIndex ?? 0);
        const id = `accessory:${idx}`;
        const state: LedRenderState = {
          family: 0,
          levels: [6, 6, 6],
          palette: 0,
          accessory: idx,
          background: -1,
        };
        docsRecords.set(id, { state, canvas, adapter: null });
        previews.push({ id, visualKey: portraitVisualKey({ ...state, staticOnly: true }) });
      });
      if (!docsGallery.install(previews)) return;
      docsCatalogReady = true;
    }
    docsGallery.open();
  }

  const sceneFxCanvas = document.getElementById("led-scene-fx") as HTMLCanvasElement | null;
  const sceneFxCtx = sceneFxCanvas?.getContext("2d") ?? null;
  const EGG_ART_URLS = ["./art/egg-pulse-v2.png", "./art/egg-relay-v2.png", "./art/egg-prism-v2.png"] as const;
  const LAMP_ART_URL = "./art/heat-lamp-v2.png";
  const sceneArtImages = new Map<string, HTMLImageElement>();
  const sceneArtPixels = new Map<string, RgbaImage>();
  let sceneArtLoadStarted = false;

  function rememberImagePixels(key: string, image: HTMLImageElement): void {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx || canvas.width <= 0 || canvas.height <= 0) return;
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
    sceneArtPixels.set(key, { width: canvas.width, height: canvas.height, data: pixels.data });
  }

  function loadSceneArt(url: string): void {
    if (sceneArtImages.has(url)) return;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      sceneArtImages.set(url, image);
      rememberImagePixels(url, image);
      if (currentRoute.kind === "play") redrawStageCanvas();
    };
    image.src = url;
  }

  function ensureSceneArt(): void {
    if (sceneArtLoadStarted) return;
    sceneArtLoadStarted = true;
    for (const url of EGG_ART_URLS) loadSceneArt(url);
    loadSceneArt(LAMP_ART_URL);
  }

  function sampleImagePixel(
    image: RgbaImage,
    x: number,
    y: number,
  ): { r: number; g: number; b: number; a: number } | null {
    const sx = Math.round(x);
    const sy = Math.round(y);
    if (sx < 0 || sy < 0 || sx >= image.width || sy >= image.height) return null;
    const index = (sy * image.width + sx) * 4;
    const a = image.data[index + 3]! / 255;
    if (a < 0.35) return null;
    return {
      r: image.data[index]!,
      g: image.data[index + 1]!,
      b: image.data[index + 2]!,
      a,
    };
  }

  function updateLampAndShellVisuals(): void {
    if (currentRoute.kind !== "play") return;
    ensureSceneArt();
    const sess = activeSession();
    const layout = computeLampMountLayout(sess.lampPosition);
    const stageFamily = stageFamilyIndexForSelection(
      eggConfirmed,
      selectedFamilyIndex,
      sess.familyIndex as 0 | 1 | 2,
    ) as 0 | 1 | 2;
    const controlsOn = incubationControlsVisible(sess.status);
    const isLit = interiorPixelsOpen({
      status: sess.status,
      hardwareHealthy,
      effectivePower: clientEffectivePower,
    });
    const presentation = presentationForStage(sess.status);

    const railGeom = sceneRailGeometry(layout);
    const stageSvg = document.getElementById("stage-svg");
    if (stageSvg) {
      stageSvg.setAttribute("data-controls", controlsOn ? "on" : "off");
      const rail = document.getElementById("lamp-rail");
      if (rail) {
        rail.setAttribute("x1", String(railGeom.x1));
        rail.setAttribute("x2", String(railGeom.x2));
        rail.setAttribute("y1", String(railGeom.y1));
        rail.setAttribute("y2", String(railGeom.y2));
      }
    }

    const lampHandle = document.getElementById("lamp-handle-elem");
    const railHit = document.getElementById("rail-hit");
    if (lampHandle) {
      if (!controlsOn) {
        lampHandle.hidden = true;
        lampHandle.tabIndex = -1;
        lampHandle.setAttribute("aria-hidden", "true");
      } else {
        lampHandle.hidden = false;
        lampHandle.tabIndex = 0;
        lampHandle.removeAttribute("aria-hidden");
        lampHandle.style.left = `${(layout.handleX / INCUBATION_SCENE.width) * 100}%`;
        lampHandle.style.top = `${(layout.handleY / INCUBATION_SCENE.height) * 100}%`;
        lampHandle.style.right = "auto";
        lampHandle.style.width = `${layout.handleSize}px`;
        lampHandle.style.height = `${layout.handleSize}px`;
        lampHandle.setAttribute("aria-valuenow", String(Math.round(sess.lampPosition)));
        const reg = regionAt(sess.lampPosition);
        const regName = ["Head", "Body & Chest", "Belly & Tail"][reg] ?? "Head";
        lampHandle.setAttribute("aria-valuetext", `Lighting the ${regName}`);
      }
    }
    if (railHit) {
      const hit = railHit as HTMLElement;
      hit.hidden = !controlsOn;
      hit.style.pointerEvents = controlsOn ? "auto" : "none";
      hit.style.left = `${(railGeom.hitX / INCUBATION_SCENE.width) * 100}%`;
      hit.style.top = `${(railGeom.hitY / INCUBATION_SCENE.height) * 100}%`;
      hit.style.width = `${(railGeom.hitW / INCUBATION_SCENE.width) * 100}%`;
      hit.style.height = `${(railGeom.hitH / INCUBATION_SCENE.height) * 100}%`;
      hit.style.right = "auto";
      hit.style.bottom = "auto";
    }

    if (sceneFxCtx && sceneFxCanvas) {
      sceneFxCtx.clearRect(0, 0, sceneFxCanvas.width, sceneFxCanvas.height);
      if (sess.status !== "completed") {
        const eggKey = EGG_ART_URLS[stageFamily]!;
        const eggImage = sceneArtPixels.get(eggKey);
        const eggDest = eggArtDestination(stageFamily);
        const dots: { x: number; y: number; r: number; g: number; b: number; a: number }[] = [];
        if (eggImage) {
          forEachSceneLed({ minX: 0, minY: 0, maxX: 400, maxY: 420 }, (x, y) => {
            if (!shellDotVisibleAt(stageFamily, x, y, isLit, sess.lampPosition)) return;
            const u = (x - eggDest.x) / eggDest.size;
            const v = (y - eggDest.y) / eggDest.size;
            if (u < 0 || v < 0 || u > 1 || v > 1) return;
            const sample = sampleImagePixel(eggImage, u * eggImage.width, v * eggImage.height);
            if (!sample) return;
            dots.push({ x, y, ...sample });
          });
        }
        if (isLit) {
          const body = stageAdapter.captureBodyImageData();
          if (body && presentation.scale > 0) {
            forEachSceneLed({ minX: 40, minY: 20, maxX: 360, maxY: 400 }, (x, y) => {
              if (!interiorVisibleAt(stageFamily, x, y, true, sess.lampPosition)) return;
              if (!pointInFamilyEgg(stageFamily, x, y)) return;
              const master = stageToMaster(x, y);
              const sample = sampleImagePixel(
                { width: body.width, height: body.height, data: body.data },
                master.x,
                master.y,
              );
              if (!sample) return;
              dots.push({ x, y, ...sample, a: Math.min(1, sample.a) });
            });
          }
          dots.push(
            ...sampleLedBeamDots(layout, sess.lampPosition, true, clientEffectivePower, stageFamily),
          );
        }
        if (controlsOn) {
          const lampImage = sceneArtPixels.get(LAMP_ART_URL);
          if (lampImage) {
            forEachSceneLed(lampArtSampleBounds(layout), (x, y) => {
              const imagePoint = stagePointToLampImage(
                x,
                y,
                layout,
                lampImage.width,
                lampImage.height,
              );
              if (!imagePoint) return;
              const sample = sampleImagePixel(lampImage, imagePoint.x, imagePoint.y);
              if (!sample) return;
              dots.push({ x, y, ...sample });
            });
          }
        }
        paintLedDots(sceneFxCtx, dots, SCENE_LED_GRID.radius);
      }
    }

    const shellEl = document.getElementById("shell");
    if (shellEl) shellEl.innerHTML = "";
  }

  function redrawStageCanvas(): void {
    const sess = activeSession();
    const isCompleted = sess.status === "completed";
    const isLit = interiorPixelsOpen({
      status: sess.status,
      hardwareHealthy,
      effectivePower: clientEffectivePower,
    });
    const scenePresentation = presentationForStage(sess.status);
    const clip = stageCanvasClipPath(sess.status, isLit, sess.lampPosition);
    stageCanvas.style.clipPath = clip.clipPath;
    stageCanvas.style.visibility = clip.visibility;
    stageCanvas.style.opacity = clip.opacity;
    stageCanvas.dataset.sceneScale = scenePresentation.scale.toFixed(4);

    const wrap = document.getElementById("stage-canvas-wrap");
    if (wrap) {
      wrap.classList.toggle("led-portrait-square", isCompleted);
      wrap.style.aspectRatio = isCompleted
        ? ""
        : `${INCUBATION_SCENE.width} / ${INCUBATION_SCENE.height}`;
    }

    const state = getPortraitStateForActiveSession();
    stageCanvas.dataset.stageFamily = String(state.family);
    stageCanvas.dataset.stagePalette = String(state.palette);
    stageCanvas.dataset.stageAccessory = String(state.accessory);
    stageCanvas.dataset.stageBackground = String(state.background);
    stageCanvas.dataset.stageLevels = state.levels.join(",");
    stageCanvas.dataset.sessionStatus = sess.status;

    const routeVisible = currentRoute.kind === "play";
    const canvasFullyHidden = clip.visibility !== "visible" || clip.opacity === "0";
    const nextKey = portraitVisualKey({
      family: state.family,
      regionFamilies: state.regionFamilies,
      levels: state.levels,
      palette: state.palette,
      accessory: state.accessory,
      background: state.background,
      staticOnly: false,
    });
    const drawPortrait = shouldDrawPortrait({
      previousKey: stagePortraitKey,
      nextKey,
      routeVisible,
      canvasFullyHidden,
      pixelsSampledWhileHidden: canvasFullyHidden && isLit && sess.status !== "completed",
    });

    if (!routeVisible) {
      stageAdapter.stopAnimation();
      return;
    }

    if (drawPortrait) {
      stageAdapter.draw(state);
      stagePortraitKey = nextKey;
    } else if (
      shouldResumeAccessoryAnimation({
        previousKey: stagePortraitKey,
        nextKey,
        routeVisible,
        canvasFullyHidden,
        animating: stageAdapter.status.animating,
        accessoryAnimates: state.accessory >= 7 && !prefersReducedMotion(),
      })
    ) {
      stageAdapter.resumeAccessoryAnimation();
    }
    updateLampAndShellVisuals();
  }

  // ---------- Backend API Calls ----------
  async function apiFetch<T>(
    path: string,
    init?: RequestInit,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    const headers = new Headers(init?.headers);
    if (init?.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const res = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(15_000),
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    const data = await readApiJson<T>(res);
    return { ok: res.ok, status: res.status, data };
  }

  function rankedRecoveryBlocked(): boolean {
    return Boolean(authPlayer) && activePlayMode === "ranked" && rankedRecoveryNeeded;
  }

  function interruptRankedAttempt(): void {
    if (!playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) ||
        !rankedSession || rankedSession.status === "completed") return;
    if (!rankedRecoveryNeeded) invalidateRankedWrites();
    rankedRecoveryNeeded = true;
    clearAttemptProgressKeepingEgg(rankedSession);
    rankedSnapshot = null;
    rankedDisplayClock = createRankedDisplayClock();
  }

  async function refreshAuthSession(): Promise<void> {
    if (authRefreshInFlight) return authRefreshInFlight;
    const epoch = rankedWriteEpoch;
    const current = () => epoch === rankedWriteEpoch;
    authRefreshInFlight = (async () => { try {
      const res = await apiFetch<{
        authenticated: boolean;
        player: PlayerProfile | null;
        allowance?: DailyAllowanceDto | null;
      }>("/api/auth/session");
      if (!current()) return;
      if (!res.ok) throw new Error("Authentication service unavailable.");
      if (res.ok && res.data.authenticated && res.data.player) {
        authPlayer = res.data.player;
        if (res.data.allowance) {
          userAllowance = res.data.allowance;
        }
        // A signed-in Demo stays independent of the player's Ranked entitlement.
        if (activePlayMode !== "ranked") return;
        const restored = await restoreRankedAttempt<DailyAllowanceDto>({
          readActive: async () => {
            const active = await apiFetch<{ session: LedSession | null; allowance?: DailyAllowanceDto }>("/api/session/active");
            if (!active.ok) throw new Error("Could not load the active Ranked egg.");
            return active.data;
          },
          restart: async sessionId => {
            const reset = await apiFetch<{ session: LedSession; allowance?: DailyAllowanceDto; error?: string }>("/api/session/restart", {
              method: "POST", body: JSON.stringify({ sessionId }),
            });
            if (!reset.ok) throw new Error(reset.data.error || "Could not reset the interrupted attempt.");
            return reset.data;
          },
          resetUnfinished: rankedRecoveryNeeded,
          isCurrent: () => current() && activePlayMode === "ranked",
        });
        if (!restored) return;
        rankedRecoveryNeeded = false;
        if (restored.allowance) userAllowance = restored.allowance;
        if (restored.session) {
          const installed = installRankedSession(restored.session, { epoch }, null);
          if (installed) {
            selectedFamilyIndex = installed.familyIndex;
            applyAcceptedRankedDisplay(installed, epoch);
          }
        } else {
          rankedSession = null;
          rankedAimCursor = createRankedClientCursor();
          rankedDisplayClock = createRankedDisplayClock();
        }
        eggConfirmed = Boolean(rankedSession && rankedSession.status !== "completed");
      } else {
        authPlayer = null;
        rankedSession = null;
        userAllowance = null;
        rankedRecoveryNeeded = false;
        rankedDisplayClock = createRankedDisplayClock();
      }
    } catch {
      // Retain identity and the cleared egg while offline; first light remains gated.
      if (current()) interruptRankedAttempt();
    } })();
    try { await authRefreshInFlight; } finally { authRefreshInFlight = null; }
  }

  async function pollHardwareStatus(): Promise<void> {
    // R11: Avoid overlapping polls and bound requests with an AbortController timeout
    if (hardwarePollInFlight) {
      return;
    }
    hardwarePollInFlight = true;
    const seq = telemetryTracker.beginRequest();

    try {
      let backendReachable = false;
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), CLIENT_POLL_TIMEOUT_MS);
        let res: {
          ok: boolean;
          status: number;
          data: {
            source: "live" | "fallback" | "simulated";
            policyVersion?: string;
            measurementDayKey: string;
            dailyDistanceMm: number;
            scheduleDistanceMm: number;
            cumulativeWorkUnits: string;
            dayStartWorkUnits: string;
            reading: SerializedReading;
            paletteSchedule: SerializedScheduleWindow;
            accessorySchedule: SerializedScheduleWindow;
            updatedAtMs?: number;
            error?: string;
          };
        };
        try {
          res = await apiFetch("/api/hardware/status", {
            signal: controller.signal,
          });
        } finally {
          window.clearTimeout(timer);
        }

        if (res.status !== 404) {
          backendReachable = true;
        }

        if (res.ok && res.data.reading) {
          if (res.data.policyVersion) {
            const resolvedPolicy = resolveKnownGamePolicy(res.data.policyVersion);
            if (resolvedPolicy) {
              telemetryTracker.setPolicy?.(resolvedPolicy);
              if (guestSession.status === "egg") {
                guestSession.policyVersion = resolvedPolicy.version;
              }
            }
          }
          telemetryTracker.ingestBackendReading(
            res.data.reading,
            res.data.dayStartWorkUnits || "0",
            seq,
          );
          telemetrySource = res.data.source;
          currentPaletteSchedule = res.data.paletteSchedule;
          currentAccessorySchedule = res.data.accessorySchedule;
          syncTelemetryFreshness(Date.now());
          if (!hardwareHealthy) interruptRankedAttempt();
          else if (rankedRecoveryNeeded && activePlayMode === "ranked") await refreshAuthSession();
          if (!hardwareHealthy && guestSession.status === "running") {
            forgetLevelUps(guestSession.id);
            clearAttemptProgressKeepingEgg(guestSession);
            guestSnapshot = null;
            showToast(
              "warn",
              `Guest attempt reset: ${hardwareError || "Hardware telemetry expired."}`,
            );
          }
          renderPlayDynamicSections();
          return;
        }

        const errMsg =
          res.data?.error || `Hardware status unavailable (HTTP ${res.status}).`;
        telemetryTracker.recordPollFailure(errMsg, seq);
        syncTelemetryFreshness(Date.now());
        interruptRankedAttempt();
        if (!hardwareHealthy && guestSession.status === "running") {
          forgetLevelUps(guestSession.id);
          clearAttemptProgressKeepingEgg(guestSession);
          guestSnapshot = null;
          showToast("warn", `Guest attempt reset: ${hardwareError}`);
          redrawStageCanvas();
        }
        renderPlayDynamicSections();
      } catch (err) {
        const msg =
          err instanceof Error
            ? err.message
            : "Signal unavailable — waiting for fresh hardware telemetry.";
        telemetryTracker.recordPollFailure(msg, seq);
        syncTelemetryFreshness(Date.now());
        interruptRankedAttempt();
        if (!hardwareHealthy && guestSession.status === "running") {
          forgetLevelUps(guestSession.id);
          clearAttemptProgressKeepingEgg(guestSession);
          guestSnapshot = null;
          showToast("warn", `Guest attempt reset: ${hardwareError}`);
          redrawStageCanvas();
        }
        renderPlayDynamicSections();
      } finally {
        hardwarePollInFlight = false;
      }
  }

  async function refreshLeaderboard(): Promise<void> {
    if (currentRoute.kind !== "leaderboard") return;
    const gen = ++leaderboardFetchGen;
    leaderboardLoading = true;
    renderLeaderboardTables();
    try {
      const res = await apiFetch<{
        weekKey: string;
        policyVersion: string;
        entries: LeaderboardEntryDto[];
      }>("/api/leaderboard?limit=100");
      if (!leaderboardResponseIsCurrent(gen, leaderboardFetchGen, currentRoute.kind === "leaderboard")) return;
      if (res.ok) {
        leaderboardWeekKey = res.data.weekKey;
        leaderboardEntries = res.data.entries ?? [];
      }
    } catch {
      // ignore
    } finally {
      if (gen !== leaderboardFetchGen) return;
      leaderboardLoading = false;
      if (currentRoute.kind === "leaderboard") renderLeaderboardTables();
    }
  }

  async function loadPublicNftDetail(resultId: string): Promise<void> {
    const gen = ++nftDetailRequestGen;
    const stillViewing = () =>
      gen === nftDetailRequestGen &&
      currentRoute.kind === "result" &&
      currentRoute.resultId === resultId;
    nftDetailLoading = true;
    nftDetailError = null;
    nftDetailData = null;
    if (stillViewing()) renderNftView();
    try {
      const res = await apiFetch<{
        resultId: string;
        snapshot: CharacterSnapshot;
        metadata: Record<string, unknown>;
        player: {
          shortWallet: string;
          displayName: string | null;
          effectiveName: string;
        };
        leaderboardRank: number | null;
        error?: string;
      }>(`/api/results/${encodeURIComponent(resultId)}`);
      if (!stillViewing()) return;
      if (!res.ok) {
        nftDetailError = res.data?.error || `Result ${resultId} not found (${res.status}).`;
      } else {
        nftDetailData = res.data;
      }
    } catch (err) {
      if (!stillViewing()) return;
      nftDetailError = err instanceof Error ? err.message : "Failed to load character result.";
    } finally {
      if (gen !== nftDetailRequestGen) return;
      nftDetailLoading = false;
      if (currentRoute.kind === "result" && currentRoute.resultId === resultId) renderNftView();
    }
  }

  // ---------- SIWE Wallet Login Flow ----------
  async function handleSiweSignIn(explicitAddress?: string): Promise<void> {
    try {
      const conn = connection();
      let walletAddress = explicitAddress || conn.address;
      const chainId = conn.chainId || SEPOLIA_ID;

      if (!walletAddress) {
        const eth = (
          window as unknown as {
            ethereum?: {
              request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
            };
          }
        ).ethereum;
        if (eth) {
          const accounts = (await eth.request({
            method: "eth_requestAccounts",
          })) as string[];
          walletAddress = accounts?.[0];
        }
      }

      if (!walletAddress) {
        walletSheetOpen = true;
        renderWalletSheet();
        return;
      }

      showToast("info", "Requesting one-time SIWE challenge from server...");
      const chalRes = await apiFetch<{
        challengeId: string;
        nonce: string;
        message: string;
        walletAddress: string;
        chainId: number;
        error?: string;
      }>("/api/auth/challenge", {
        method: "POST",
        body: JSON.stringify({ walletAddress, chainId }),
      });

      if (!chalRes.ok) {
        showToast("err", chalRes.data.error || "Failed to create SIWE challenge.");
        return;
      }

      showToast("info", "Please sign the SIWE authentication message in your wallet (no gas fee)...");
      const signature = await signChallengeMessage(walletAddress, chalRes.data.message);

      const verifyRes = await apiFetch<{
        authenticated: boolean;
        player: PlayerProfile;
        error?: string;
      }>("/api/auth/verify", {
        method: "POST",
        body: JSON.stringify({
          challengeId: chalRes.data.challengeId,
          walletAddress,
          signature,
          chainId: chalRes.data.chainId,
        }),
      });

      if (!verifyRes.ok || !verifyRes.data.authenticated) {
        showToast("err", verifyRes.data.error || "SIWE signature verification failed.");
        return;
      }

      authPlayer = verifyRes.data.player;
      walletSheetOpen = false;
      rankedSnapshot = null;
      invalidateRankedWrites();
      rankedRecoveryNeeded = true;
      // Drain an obsolete auth read before restoring this identity.
      if (authRefreshInFlight) await authRefreshInFlight;
      await refreshAuthSession();

      showToast(
        "ok",
        `Signed in as ${authPlayer.effectiveName} (${authPlayer.shortWallet}). Ranked mode unlocked!`,
      );
      renderAll();
    } catch (err) {
      showToast("warn", errorMessage(err));
      renderAll();
    }
  }

  async function handleLogout(): Promise<void> {
    invalidateRankedWrites();
    rankedRecoveryNeeded = true;
    authPlayer = null;
    rankedSession = null;
    rankedSnapshot = null;
    rankedLeaderboardRank = null;
    try {
      await apiFetch("/api/auth/logout", { method: "POST", body: JSON.stringify({}) });
    } catch {
      // ignore
    }
    invalidateRankedWrites();
    authPlayer = null;
    rankedSession = null;
    rankedSnapshot = null;
    rankedLeaderboardRank = null;
    showToast("info", "Signed out of Ranked session. Switched to Guest Mode.");
    renderAll();
  }

  // Watch wallet connection changes: if connected wallet changes or disconnects, invalidate mismatched auth session
  onConnection(() => {
    const conn = connection();
    if (
      authPlayer &&
      conn.address &&
      conn.address.toLowerCase() !== authPlayer.walletAddress.toLowerCase()
    ) {
      void handleLogout().then(() => {
        showToast(
          "warn",
          "Connected wallet changed. Sign the SIWE challenge with the new wallet to play Ranked.",
        );
      });
      return;
    }
    renderAuthBar();
    renderWalletSheet();
    renderProfileSection();
  });

  onConnectors(() => {
    renderWalletSheet();
  });

  // ---------- Gameplay Actions ----------
  function handleSelectFamily(familyIndex: 0 | 1 | 2): void {
    if (eggConfirmed) return;
    selectedFamilyIndex = familyIndex;
    document.querySelectorAll<HTMLButtonElement>(".led-species-btn").forEach((btn) => {
      const idx = Number(btn.dataset.familyIndex);
      const isMatch = idx === familyIndex;
      btn.classList.toggle("selected", isMatch);
      btn.classList.toggle("active", isMatch);
      btn.setAttribute("aria-checked", String(isMatch));
    });
    redrawStageCanvas();
  }

  async function handleConfirmClaimEgg(): Promise<void> {
    if (rankedRecoveryBlocked()) return;
    if (authPlayer && activePlayMode === "ranked") {
      const capturedWrite = captureRankedWrite();
      const claimRes = await apiFetch<{ session: LedSession; allowance?: DailyAllowanceDto; error?: string }>(
        "/api/session/egg",
        {
          method: "POST",
          body: JSON.stringify({
            familyIndex: selectedFamilyIndex,
            lampPosition: -70,
          }),
        },
      );
      if (capturedWrite.epoch !== rankedWriteEpoch || activePlayMode !== "ranked") return;
      if (!claimRes.ok) {
        showToast("err", claimRes.data.error || "Could not claim ranked egg.");
        return;
      }
      const claimed = installRankedSession(claimRes.data.session, capturedWrite, null);
      if (!claimed) return;
      applyAcceptedRankedDisplay(claimed, capturedWrite.epoch);
      if (claimRes.data.allowance) {
        userAllowance = claimRes.data.allowance;
        renderAuthBar();
      }
      rankedSnapshot = null;
      rankedLeaderboardRank = null;
      eggConfirmed = true;
      showToast("ok", `Claimed ${FAMILIES[selectedFamilyIndex].name} Ranked Egg. Ready to illuminate!`);
    } else {
      const gPolicy = resolveKnownGamePolicy(guestSession.policyVersion) ?? LATEST_GAME_POLICY;
      guestSession = createLedSession({
        mode: "guest",
        familyIndex: selectedFamilyIndex,
        policy: gPolicy,
      });
      guestSnapshot = null;
      eggConfirmed = true;
      showToast("ok", `Created ${FAMILIES[selectedFamilyIndex].name} Demo Egg. Ready to illuminate!`);
    }
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handleStartIllumination(): Promise<void> {
    if (rankedRecoveryBlocked()) return;
    if (!eggConfirmed) {
      await handleConfirmClaimEgg();
      if (!eggConfirmed) return;
    }
    if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession
    ) {
      const capturedWrite = captureRankedWrite();
      const startRes = await apiFetch<{
        session: LedSession;
        reading?: SerializedReading;
        paletteSchedule: SerializedScheduleWindow;
        accessorySchedule: SerializedScheduleWindow;
        updatedAtMs?: number;
        error?: string;
      }>("/api/session/start", {
        method: "POST",
        body: JSON.stringify({
          sessionId: rankedSession.id,
          lampPosition: rankedSession.lampPosition,
          ...rankedOrderBody(),
        }),
      }).catch(() => {
        if (ignoreRankedFailure(capturedWrite, undefined)) return null;
        interruptRankedAttempt();
        void refreshAuthSession().then(() => { renderPlayDynamicSections(); redrawStageCanvas(); });
        return null;
      });
      if (!startRes) return;
      if (!startRes.ok) {
        if (ignoreRankedFailure(capturedWrite, startRes.data.error)) return;
        interruptRankedAttempt();
        if (startRes.status === 503) {
          telemetryTracker.recordPollFailure(
            startRes.data.error || "Hardware telemetry unavailable.",
          );
          syncTelemetryFreshness(Date.now());
        }
        showToast("err", startRes.data.error || "Failed to start ranked illumination.");
        renderPlayDynamicSections();
        redrawStageCanvas();
        return;
      }
      const wasLocked = Boolean(rankedSession.lockedTraits);
      const started = installRankedSession(startRes.data.session, capturedWrite, capturedWrite.sessionId);
      if (!started) return;
      if (startRes.data.reading) {
        telemetryTracker.ingestBackendReading(
          startRes.data.reading,
          dayStartWorkUnits.toString(),
        );
        syncTelemetryFreshness(Date.now());
      }
      currentPaletteSchedule = startRes.data.paletteSchedule;
      currentAccessorySchedule = startRes.data.accessorySchedule;
      applyAcceptedRankedDisplay(started, capturedWrite.epoch);
      if (!wasLocked && started.lockedTraits) {
        showToast(
          "ok",
          `Locked Coat Palette (${started.lockedTraits.paletteName}) & Accessory (${started.lockedTraits.accessoryName}) simultaneously!`,
        );
      }
    } else {
      // Demo / Guest Flow
      const isFresh = syncTelemetryFreshness(Date.now());
      if (!isFresh) {
        showToast(
          "err",
          hardwareError || "Live hardware telemetry is unavailable or expired; cannot start illumination.",
        );
        renderPlayDynamicSections();
        return;
      }
      if (guestSession.status === "completed") {
        guestSession = createLedSession({
          mode: "guest",
          familyIndex: selectedFamilyIndex,
          policy: LATEST_GAME_POLICY,
        });
        guestSnapshot = null;
      }
      const wasLocked = Boolean(guestSession.lockedTraits);
      if (!wasLocked) {
        const sessPolicy = policyForSession(guestSession);
        const palWin =
          currentPaletteSchedule ??
          paletteScheduleAt(latestReading.distanceMm, sessPolicy);
        const accWin =
          currentAccessorySchedule ??
          accessoryScheduleAt(
            latestReading.work,
            dayStartWorkUnits,
            sessPolicy,
          );
        const locked = lockSessionTraits(
          guestSession,
          latestReading,
          dayStartWorkUnits,
          sessPolicy,
          new Date().toISOString(),
          {
            paletteIndex: palWin.itemIndex,
            accessoryIndex: accWin.itemIndex,
          },
        );
        showToast(
          "ok",
          `Locked Coat Palette (${locked.paletteName}) & Cyber Accessory (${locked.accessoryName})!`,
        );
      }
      guestSession.status = "running";
      lastLocalTickMs = Date.now();
    }
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handlePauseIllumination(): Promise<void> {
    // Manual pause removed under current rules; treat as attempt reset that keeps the egg.
    if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession && rankedSession.status !== "completed"
    ) {
      interruptRankedAttempt();
      renderPlayDynamicSections();
      redrawStageCanvas();
      await refreshAuthSession();
    } else if (!playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) && guestSession.status !== "completed") {
      forgetLevelUps(guestSession.id);
      clearAttemptProgressKeepingEgg(guestSession);
      guestSnapshot = null;
    }
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handleCompleteSession(): Promise<void> {
    if (rankedRecoveryBlocked()) return;
    const sess = activeSession();
    const sessPolicy = policyForSession(sess);
    if (sess.elapsed + 1e-6 < sessPolicy.durationSeconds) {
      showToast(
        "warn",
        `Complete the full ${sessPolicy.durationSeconds}s illumination (${sess.elapsed.toFixed(1)}s elapsed) before revealing your character.`,
      );
      return;
    }
    if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession
    ) {
      const capturedWrite = captureRankedWrite();
      const res = await apiFetch<{
        idempotent: boolean;
        resultId: string;
        snapshot: CharacterSnapshot;
        leaderboardRank: number | null;
        allowance?: DailyAllowanceDto;
        error?: string;
      }>("/api/session/complete", {
        method: "POST",
        body: JSON.stringify({ sessionId: rankedSession.id, ...rankedOrderBody() }),
      });
      if (!res.ok) {
        if (ignoreRankedFailure(capturedWrite, res.data.error)) return;
        showToast("err", res.data.error || "Could not complete ranked session.");
        return;
      }
      if (!acceptRankedWrite(capturedWrite, capturedWrite.sessionId)) return;
      const completing = rankedSession;
      if (!completing || completing.id !== capturedWrite.sessionId) return;
      rankedSnapshot = res.data.snapshot;
      rankedLeaderboardRank = res.data.leaderboardRank;
      completing.status = "completed";
      completing.backgroundIndex = res.data.snapshot.backgroundIndex;
      completing.backgroundId = res.data.snapshot.backgroundId;
      applyAcceptedRankedDisplay(completing, capturedWrite.epoch);
      if (res.data.allowance) {
        userAllowance = res.data.allowance;
        renderAuthBar();
      }
      showToast(
        "ok",
        `Completed ${res.data.snapshot.familyName} with ${res.data.snapshot.backgroundName} background! Total Score: ${res.data.snapshot.scores.total} pts.`,
      );
      await refreshLeaderboard();
    } else {
      if (!guestSession.lockedTraits) {
        showToast("warn", "Start lamp illumination first to lock traits before completing.");
        return;
      }
      guestSession.status = "completed";
      guestSession.completedAt ||= new Date().toISOString();
      if (guestSession.backgroundIndex === null) {
        const bgIdx = pickRandomBackgroundIndex(sessPolicy);
        guestSession.backgroundIndex = bgIdx;
        guestSession.backgroundId = backgroundByIndex(bgIdx).id;
      }
      guestSnapshot = buildCharacterSnapshot(guestSession, {
        resultId: `guest-${guestSession.id.slice(0, 8)}`,
        displayName: null,
        policy: sessPolicy,
      });
      showToast(
        "ok",
        `Guest character completed! Assigned background: ${guestSnapshot.backgroundName}. Export your 1600×1600 PNG below.`,
      );
    }
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handleResetOrNewEgg(): Promise<void> {
    if (rankedRecoveryBlocked()) return;
    // Demo must never abandon a separate ranked entitlement (R25).
    if (rankedAbandonOnNewEggAllowed(Boolean(authPlayer), activePlayMode, rankedSession)) {
      invalidateRankedWrites();
      await apiFetch("/api/session/abandon", {
        method: "POST",
        body: JSON.stringify({ sessionId: rankedSession!.id }),
      });
      rankedSession = null;
      rankedSnapshot = null;
      rankedLeaderboardRank = null;
    } else if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession &&
      rankedSession.status === "completed"
    ) {
      rankedSession = null;
      rankedSnapshot = null;
      rankedLeaderboardRank = null;
      rankedDisplayClock = createRankedDisplayClock();
    }
    guestSession = createLedSession({
      mode: "guest",
      familyIndex: 0,
      policy: LATEST_GAME_POLICY,
    });
    guestSnapshot = null;
    eggConfirmed = false;
    selectedFamilyIndex = 0;
    showToast("info", "Returned to egg selection. Choose a species for your new egg.");
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handleRestartAttempt(): Promise<void> {
    const sess = activeSession();
    if (sess.status === "completed" || rankedRecoveryBlocked()) return;
    if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession
    ) {
      interruptRankedAttempt();
      renderPlayDynamicSections();
      redrawStageCanvas();
      await refreshAuthSession();
      if (rankedRecoveryNeeded) return;
      lastLocalTickMs = Date.now();
      showToast(
        "info",
        "Attempt reset on the same egg. Growth and trait locks cleared; next first light locks the current pair.",
      );
    } else {
      forgetLevelUps(guestSession.id);
      clearAttemptProgressKeepingEgg(guestSession);
      guestSnapshot = null;
      lastLocalTickMs = Date.now();
      showToast(
        "info",
        "Demo attempt reset on the same egg. Growth and trait locks cleared.",
      );
    }
    renderPlayDynamicSections();
    redrawStageCanvas();
  }

  async function handleAimLamp(newPosition: number, commitToServer = false): Promise<void> {
    const clampedPos = clamp(Math.round(newPosition), -100, 100);
    const sess = activeSession();
    if (authPlayer && activePlayMode === "ranked" && rankedSession && sess.id === rankedSession.id) {
      rankedAimCursor = noteRankedDesiredAim(rankedAimCursor, clampedPos);
      rankedAimCursor = { ...rankedAimCursor, dragging: !commitToServer };
    }
    sess.lampPosition = clampedPos;

    const slider = document.getElementById("lamp") as HTMLInputElement | null;
    if (slider && Number(slider.value) !== clampedPos) {
      slider.value = String(clampedPos);
    }

    const regionIdx = regionAt(clampedPos);
    const beamOverlay = document.getElementById("beam-overlay");
    if (beamOverlay) {
      beamOverlay.setAttribute("data-region", String(regionIdx));
    }

    // Ranked aim commits only from Ranked mode; Demo never mutates another ranked session.
    if (
      commitToServer &&
      !rankedRecoveryBlocked() &&
      rankedSessionMutationAllowed(Boolean(authPlayer), activePlayMode, rankedSession)
    ) {
      const capturedWrite = captureRankedWrite();
      const res = await apiFetch<{
        session: LedSession;
        levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
        error?: string;
      }>("/api/session/aim", {
        method: "POST",
        body: JSON.stringify({
          sessionId: rankedSession!.id,
          lampPosition: clampedPos,
          ...rankedOrderBody(),
        }),
      }).catch(() => {
        if (ignoreRankedFailure(capturedWrite, undefined)) return null;
        interruptRankedAttempt();
        void refreshAuthSession().then(() => { renderPlayDynamicSections(); redrawStageCanvas(); });
        return null;
      });
      if (!res) return;
      if (!res.ok) {
        if (ignoreRankedFailure(capturedWrite, res.data.error)) return;
      }
      if (res.ok) {
        const aimed = installRankedSession(res.data.session, capturedWrite, capturedWrite.sessionId);
        if (!aimed) return;
        applyAcceptedRankedDisplay(aimed, capturedWrite.epoch);
        announceLevelUps(aimed.id, res.data.levelUps);
        renderPlayDynamicSections();
        redrawStageCanvas();
      } else if (rankedSession) {
        interruptRankedAttempt();
        void refreshAuthSession().then(() => { renderPlayDynamicSections(); redrawStageCanvas(); });
        showToast("warn", res.data?.error || "Failed to update ranked lamp aim.");
        renderPlayDynamicSections();
        redrawStageCanvas();
      }
      return;
    }
    redrawStageCanvas();
  }

  function applyAcceptedRankedDisplay(session: LedSession, responseGeneration: number): void {
    if (responseGeneration !== rankedWriteEpoch) return;
    const durationSeconds = policyForSession(session).durationSeconds;
    const nowMonoMs = performance.now();
    if (session.status === "egg" || session.status === "paused") {
      rankedDisplayClock = createRankedDisplayClock();
      return;
    }
    const hidden = document.visibilityState === "hidden";
    const onPlay = currentRoute.kind === "play";
    let advancing = false;
    let hold: RankedDisplayFreeze | null = "completed";
    if (session.status === "running") {
      advancing = onPlay && !hidden && hardwareHealthy && !rankedRecoveryBlocked();
      hold = advancing
        ? null
        : hidden
          ? "hidden"
          : !onPlay
            ? "non-play"
            : !hardwareHealthy
              ? "stale-telemetry"
              : "recovery";
    }
    rankedDisplayClock = anchorRankedDisplayClock({
      clock: rankedDisplayClock,
      responseGeneration,
      liveGeneration: rankedWriteEpoch,
      sessionId: session.id,
      serverElapsed: session.elapsed,
      nowMonoMs,
      durationSeconds,
      advancing,
      hold,
    });
  }

  function syncRankedDisplayClock(): void {
    if (!authPlayer || activePlayMode !== "ranked" || !rankedSession) return;
    rankedDisplayClock = reconcileRankedDisplayClock(rankedDisplayClock, {
      nowMonoMs: performance.now(),
      durationSeconds: policyForSession(rankedSession).durationSeconds,
      liveGeneration: rankedWriteEpoch,
      sessionId: rankedSession.id,
      serverElapsed: rankedSession.elapsed,
      status: rankedSession.status,
      telemetryHealthy: hardwareHealthy,
      recovering: rankedRecoveryBlocked(),
      route: currentRoute.kind === "play" ? "play" : "other",
      hidden: document.visibilityState === "hidden",
    });
  }

  function readoutForTimer(sess: LedSession, durationSeconds: number): string {
    if (
      authPlayer &&
      activePlayMode === "ranked" &&
      rankedSession &&
      sess.id === rankedSession.id &&
      rankedDisplayClock.generation === rankedWriteEpoch &&
      rankedDisplayClock.sessionId === sess.id
    ) {
      return formatRankedTimerReadout(
        projectRankedDisplay(rankedDisplayClock, performance.now(), durationSeconds),
        durationSeconds,
      );
    }
    return `${sess.elapsed.toFixed(1)}s / ${durationSeconds}s`;
  }

  function paintRankedDisplayTimer(): void {
    if (!authPlayer || activePlayMode !== "ranked" || !rankedSession) return;
    syncRankedDisplayClock();
    if (currentRoute.kind !== "play") return;
    const timerEl = document.getElementById("timer-readout");
    if (!timerEl) return;
    const durationSeconds = policyForSession(rankedSession).durationSeconds;
    const next = readoutForTimer(rankedSession, durationSeconds);
    if (timerEl.textContent !== next) timerEl.textContent = next;
  }

  // ---------- Simulation / Illumination Loop ----------
  let lastLocalTickMs = Date.now();
  let lastServerTickMs = 0;
  let serverTickInFlight = false;

  setInterval(() => {
    const nowMs = Date.now();
    const rawDeltaSec = (nowMs - lastLocalTickMs) / 1000;
    const dt = Math.min(0.5, Math.max(0, rawDeltaSec));
    lastLocalTickMs = nowMs;

    // R11: Always re-evaluate client telemetry freshness on every tick even when network polls stall
    const wasHealthy = hardwareHealthy;
    const isFreshNow = syncTelemetryFreshness(nowMs);

    if (currentRoute.kind !== "play") {
      syncRankedDisplayClock();
      return;
    }

    if (!isFreshNow && wasHealthy) {
      interruptRankedAttempt();
      redrawStageCanvas();
      if (guestSession.status === "running") {
        forgetLevelUps(guestSession.id);
        clearAttemptProgressKeepingEgg(guestSession);
        guestSnapshot = null;
        showToast(
          "warn",
          `Guest attempt reset: ${hardwareError || "Hardware telemetry expired."}`,
        );
        redrawStageCanvas();
      }
      renderPlayDynamicSections();
    }

    if (
      playModeAllowsRankedMutation(Boolean(authPlayer), activePlayMode) &&
      rankedSession
    ) {
      if (
        rankedSession.status === "running" &&
        !rankedRecoveryBlocked() &&
        !serverTickInFlight
      ) {
        serverTickInFlight = true;
        lastServerTickMs = nowMs;
        const capturedWrite = captureRankedWrite();
        void apiFetch<{
          session: LedSession;
          levelUps: { region: 0 | 1 | 2; previousLevel: number; newLevel: number }[];
          readyToComplete: boolean;
          reading: SerializedReading;
          paletteSchedule: SerializedScheduleWindow;
          accessorySchedule: SerializedScheduleWindow;
          updatedAtMs?: number;
          error?: string;
        }>("/api/session/tick", {
          method: "POST",
          body: JSON.stringify({
            sessionId: rankedSession.id,
            lampPosition: rankedSession.lampPosition,
            ...rankedOrderBody(),
          }),
        })
          .then(async (res) => {
            if (!res.ok) {
              if (ignoreRankedFailure(capturedWrite, res.data?.error)) return;
              interruptRankedAttempt();
              void refreshAuthSession().then(() => { renderPlayDynamicSections(); redrawStageCanvas(); });
              if (res.status === 503) {
                telemetryTracker.recordPollFailure(
                  res.data?.error || "Hardware telemetry unavailable.",
                );
                syncTelemetryFreshness(Date.now());
              }
              showToast(
                "warn",
                res.data?.error || `Ranked illumination interrupted (HTTP ${res.status}).`,
              );
              renderPlayDynamicSections();
              redrawStageCanvas();
              return;
            }
            const prevLevels = rankedSession
              ? rankedSession.regions.map((r) => r.level)
              : [0, 0, 0];
            const installed = installRankedSession(res.data.session, capturedWrite, capturedWrite.sessionId);
            if (!installed) return;
            if (res.data.reading) {
              telemetryTracker.ingestBackendReading(
                res.data.reading,
                dayStartWorkUnits.toString(),
              );
              syncTelemetryFreshness(Date.now());
            }
            currentPaletteSchedule = res.data.paletteSchedule;
            currentAccessorySchedule = res.data.accessorySchedule;
            applyAcceptedRankedDisplay(installed, capturedWrite.epoch);
            announceLevelUps(installed.id, res.data.levelUps);
            if (
              prevLevels[0] !== installed.regions[0].level ||
              prevLevels[1] !== installed.regions[1].level ||
              prevLevels[2] !== installed.regions[2].level
            ) {
              redrawStageCanvas();
            }
            if (res.data.readyToComplete && !rankedSnapshot) {
              await handleCompleteSession();
            } else {
              renderPlayDynamicSections();
            }
          })
          .catch((err) => {
            if (ignoreRankedFailure(capturedWrite, undefined)) return;
            interruptRankedAttempt();
            void refreshAuthSession().then(() => {
              renderPlayDynamicSections();
              redrawStageCanvas();
            });
            const msg =
              err instanceof Error ? err.message : "Network error during ranked session tick.";
            showToast("warn", `Ranked illumination interrupted: ${msg}`);
          })
          .finally(() => {
            serverTickInFlight = false;
          });
      }
    } else if (guestSession.status === "running") {
      if (!isFreshNow) {
        forgetLevelUps(guestSession.id);
        clearAttemptProgressKeepingEgg(guestSession);
        guestSnapshot = null;
        showToast(
          "warn",
          `Guest attempt reset: ${hardwareError || "Hardware telemetry expired."}`,
        );
        renderPlayDynamicSections();
        redrawStageCanvas();
        return;
      }
      if (rawDeltaSec < 0 || rawDeltaSec > 5) {
        forgetLevelUps(guestSession.id);
        clearAttemptProgressKeepingEgg(guestSession);
        guestSnapshot = null;
        showToast("warn", "Guest attempt reset due to timer interruption.");
        renderPlayDynamicSections();
        redrawStageCanvas();
        return;
      }
      const gPolicy = policyForSession(guestSession);
      const stepped = stepLedSession(
        guestSession,
        dt,
        clientEffectiveRpm,
        0n,
        gPolicy,
        new Date(nowMs).toISOString(),
        { autoComplete: false },
      );
      if (stepped.levelUps.length > 0) {
        announceLevelUps(guestSession.id, stepped.levelUps);
        redrawStageCanvas();
      }
      if (guestSession.elapsed + 1e-6 >= gPolicy.durationSeconds) {
        guestSession.elapsed = gPolicy.durationSeconds;
        // Ready to complete: hold locks at full duration (not a mid-run pause farm).
        guestSession.status = "paused";
        showToast(
          "ok",
          `Guest illumination reached ${gPolicy.durationSeconds}s! Click 'Complete Character & Reveal Portrait' to finish.`,
        );
      }
      renderPlayDynamicSections();
    }
    // Ranked readout only. Heartbeat cadence, session fields, and control DOM stay put.
    paintRankedDisplayTimer();
  }, 200);

  // Poll hardware status every 2.5s
  setInterval(() => {
    void pollHardwareStatus();
  }, 2500);

  // ---------- Render Functions ----------
  function renderAuthBar(): void {
    const bar = document.getElementById("auth-bar");
    if (!bar) return;

    const conn = connection();
    if (authPlayer) {
      const remaining = userAllowance ? userAllowance.remaining : 3;
      const total = userAllowance ? userAllowance.total : 3;
      bar.innerHTML = `
        <div class="led-account-wrap led-account-menu">
          <button type="button" class="led-account-btn" id="btn-account-toggle" aria-expanded="${accountMenuOpen}" aria-haspopup="dialog" aria-label="Account menu">
            <span class="led-account-icon" aria-hidden="true">🐹</span>
            <span class="led-account-name">Ranked: ${escapeText(authPlayer.effectiveName)}</span>
          </button>
          <div class="led-account-popover" id="account-popover" ${accountMenuOpen ? "" : "hidden"} role="dialog" aria-label="Account menu">
            <div class="led-account-allowance">
              Plays left today: <strong>${remaining} / ${total}</strong>
            </div>
            <form id="display-name-form" class="led-name-form">
              <label for="display-name-input" class="led-subtle">
                Edit display name (max 30 chars):
              </label>
              <div class="led-name-input-row" style="margin-top: 0.35rem; display: flex; gap: 0.35rem;">
                <input
                  id="display-name-input"
                  type="text"
                  maxlength="30"
                  placeholder="${authPlayer.shortWallet}"
                  value="${escapeAttr(authPlayer.displayName ?? "")}"
                  class="led-input"
                  style="flex: 1;"
                />
                <button type="submit" class="led-btn-primary" id="btn-save-name">Save</button>
                <button type="button" class="led-btn-ghost" id="btn-clear-name">Clear</button>
              </div>
            </form>
            <div style="margin-top: 0.75rem; text-align: right;">
              <button type="button" class="led-btn-ghost" id="btn-top-logout">Sign Out</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById("btn-account-toggle")?.addEventListener("click", () => {
        accountMenuOpen = !accountMenuOpen;
        renderAuthBar();
      });
      const popover = document.getElementById("account-popover");
      const toggleBtn = document.getElementById("btn-account-toggle");
      if (popover && toggleBtn && accountMenuOpen) {
        const btnRect = toggleBtn.getBoundingClientRect();
        const style = accountPopoverStyle(window.innerWidth, btnRect.right);
        popover.style.left = style.left;
        popover.style.right = style.right;
        popover.style.width = style.width;
        popover.style.maxWidth = style.maxWidth;
        popover.style.position = "fixed";
        popover.style.top = `${Math.round(btnRect.bottom + 8)}px`;
      }
      document.getElementById("btn-top-logout")?.addEventListener("click", () => {
        void handleLogout();
      });
      const form = document.getElementById("display-name-form") as HTMLFormElement | null;
      const input = document.getElementById("display-name-input") as HTMLInputElement | null;
      form?.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!input) return;
        const check = validatePlayerDisplayName(input.value);
        if (!check.valid) {
          showToast("err", check.error || "Invalid display name.");
          return;
        }
        const res = await apiFetch<{ player: PlayerProfile; error?: string }>("/api/profile", {
          method: "PUT",
          body: JSON.stringify({ displayName: check.normalized }),
        });
        if (!res.ok) {
          showToast("err", res.data.error || "Failed to update display name.");
          return;
        }
        authPlayer = res.data.player;
        showToast("ok", `Display name updated: ${authPlayer.effectiveName}`);
        accountMenuOpen = false;
        renderAuthBar();
        renderProfileSection();
        void refreshLeaderboard();
      });
      document.getElementById("btn-clear-name")?.addEventListener("click", async () => {
        const res = await apiFetch<{ player: PlayerProfile; error?: string }>("/api/profile", {
          method: "PUT",
          body: JSON.stringify({ displayName: "" }),
        });
        if (res.ok) {
          authPlayer = res.data.player;
          showToast("ok", `Cleared custom name; using ${authPlayer.effectiveName}.`);
          accountMenuOpen = false;
          renderAuthBar();
          renderProfileSection();
          void refreshLeaderboard();
        }
      });
      return;
    }

    if (conn.address) {
      bar.innerHTML = `
        <span class="led-auth-status led-auth-unverified" title="Connected wallet is not signed in yet">
          Wallet ${shortWalletAddress(conn.address)} · Not Signed In
        </span>
        <button type="button" class="led-btn-primary" id="btn-top-siwe">Sign In (SIWE)</button>
        <button type="button" class="led-btn-ghost" id="btn-top-disconnect">Disconnect</button>
      `;
      document.getElementById("btn-top-siwe")?.addEventListener("click", () => {
        void handleSiweSignIn(conn.address);
      });
      document.getElementById("btn-top-disconnect")?.addEventListener("click", () => {
        void disconnectWallet();
      });
      return;
    }

    bar.innerHTML = `
      <span class="led-auth-status led-auth-guest">Guest Mode · Progress resets on refresh</span>
      <button type="button" class="led-btn-secondary" id="btn-open-wallet-sheet">Connect & Sign In</button>
    `;
    document.getElementById("btn-open-wallet-sheet")?.addEventListener("click", () => {
      walletSheetOpen = true;
      renderWalletSheet();
    });
  }

  function renderWalletSheet(): void {
    const backdrop = document.getElementById("wallet-sheet");
    const list = document.getElementById("wallet-connector-list");
    if (!backdrop || !list) return;
    backdrop.hidden = !walletSheetOpen;
    if (!walletSheetOpen) return;

    const conn = connection();
    const rows = walletRows();
    const hasInjectedWindow = Boolean(
      (window as unknown as { ethereum?: unknown }).ethereum,
    );

    list.innerHTML = `
      ${
        conn.address
          ? `
        <div class="led-connected-box">
          <div>Connected wallet: <code>${conn.address}</code></div>
          <p class="led-subtle">Connecting a wallet address does not log you in. Sign the SIWE challenge below to verify ownership.</p>
          <div class="led-controls-row">
            ${
              conn.chainId && conn.chainId !== SEPOLIA_ID
                ? `<button type="button" class="led-btn-secondary" id="sheet-switch-chain">Switch to Sepolia</button>`
                : ""
            }
            <button type="button" class="led-btn-primary" id="sheet-sign-siwe">Sign SIWE Challenge (personal_sign)</button>
          </div>
        </div>
      `
          : ""
      }
      <div class="led-connector-buttons">
        ${rows
          .map(
            (r, idx) => `
          <button type="button" class="led-connector-btn" data-conn-idx="${idx}">
            <span>${escapeText(r.label)}</span>
            <span class="led-subtle">Connect →</span>
          </button>
        `,
          )
          .join("")}
        ${
          hasInjectedWindow
            ? `
          <button type="button" class="led-connector-btn led-connector-direct" id="sheet-direct-siwe">
            <span>Direct Injected Wallet (EIP-1193 + SIWE)</span>
            <span class="led-subtle">Sign In →</span>
          </button>
        `
            : ""
        }
      </div>
    `;

    list.querySelectorAll<HTMLButtonElement>("[data-conn-idx]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const idx = Number(btn.dataset.connIdx);
        const row = rows[idx];
        if (!row) return;
        try {
          await connectWith(row.connector);
          renderWalletSheet();
          renderAuthBar();
        } catch (err) {
          showToast("warn", errorMessage(err));
        }
      });
    });

    document.getElementById("sheet-switch-chain")?.addEventListener("click", async () => {
      try {
        await switchToSepolia();
        renderWalletSheet();
      } catch (err) {
        showToast("warn", errorMessage(err));
      }
    });

    document.getElementById("sheet-sign-siwe")?.addEventListener("click", () => {
      void handleSiweSignIn(conn.address);
    });

    document.getElementById("sheet-direct-siwe")?.addEventListener("click", () => {
      void handleSiweSignIn();
    });
  }

  function applyStableControl(el: HTMLElement, spec: StableControlSpec): void {
    if (el.className !== spec.className) el.className = spec.className;
    if (spec.tag === "button") {
      const button = el as HTMLButtonElement;
      if (button.disabled !== spec.disabled) button.disabled = spec.disabled;
    }
    if (spec.html !== undefined) {
      if (el.innerHTML !== spec.html) el.innerHTML = spec.html;
    } else if (el.textContent !== spec.text) {
      el.textContent = spec.text;
    }
    if (spec.attrs) {
      for (const [name, value] of Object.entries(spec.attrs)) {
        if (el.getAttribute(name) !== value) el.setAttribute(name, value);
      }
    }
  }

  function sessionControlHandler(id: string): (() => void) | null {
    if (id === "btn-start-lamp") return () => { void handleStartIllumination(); };
    if (id === "btn-restart-attempt") return () => { void handleRestartAttempt(); };
    if (id === "btn-complete-session") return () => { void handleCompleteSession(); };
    if (id === "btn-reset-egg") return () => { void handleResetOrNewEgg(); };
    return null;
  }

  function syncStableControls(parent: HTMLElement, specs: readonly StableControlSpec[]): void {
    const created = new Map<string, HTMLElement>();
    syncStableControlHost(
      {
        ids() {
          return [...parent.children]
            .map((node) => (node instanceof HTMLElement ? node.id : ""))
            .filter((id) => id.length > 0);
        },
        create(spec) {
          const el = document.createElement(spec.tag);
          el.id = spec.id;
          if (spec.tag === "button") {
            const button = el as HTMLButtonElement;
            button.type = "button";
            const handler = sessionControlHandler(spec.id);
            if (handler) button.addEventListener("click", handler);
          }
          applyStableControl(el, spec);
          created.set(spec.id, el);
        },
        update(id, spec) {
          const existing = parent.querySelector<HTMLElement>(`#${id}`);
          if (existing && existing.parentElement === parent) applyStableControl(existing, spec);
        },
        remove(id) {
          const existing = parent.querySelector<HTMLElement>(`#${id}`);
          if (existing && existing.parentElement === parent) existing.remove();
        },
        placeNew(id, beforeId) {
          const el = created.get(id);
          if (!el || el.isConnected) return;
          const before = beforeId ? parent.querySelector<HTMLElement>(`#${beforeId}`) : null;
          if (before && before.parentElement === parent) parent.insertBefore(el, before);
          else parent.appendChild(el);
        },
      },
      specs,
    );
  }

  function mountModeSelector(modeContainer: HTMLElement): void {
    if (modeContainer.dataset.modeBound === "1") return;
    modeContainer.dataset.modeBound = "1";
    modeContainer.innerHTML = `
      <div class="led-mode-selector" role="radiogroup" aria-label="Game Play Mode">
        <span style="font-size:0.85rem; font-weight:600; color:var(--text-subtle); margin-right:0.5rem;">Mode:</span>
        <button type="button" class="led-mode-btn" id="btn-mode-ranked"></button>
        <button type="button" class="led-mode-btn" id="btn-mode-demo"></button>
      </div>
      <div class="led-mode-notice" id="mode-allowance-notice" hidden></div>
    `;
    document.getElementById("btn-mode-ranked")?.addEventListener("click", () => {
      if (eggConfirmed) return;
      invalidateRankedWrites();
      activePlayMode = "ranked";
      void refreshAuthSession().then(() => { renderPlayDynamicSections(); redrawStageCanvas(); });
      renderPlayDynamicSections();
    });
    document.getElementById("btn-mode-demo")?.addEventListener("click", () => {
      if (eggConfirmed) return;
      invalidateRankedWrites();
      activePlayMode = "demo";
      renderPlayDynamicSections();
    });
  }

  function mountRegionAimCards(regionsList: HTMLElement): void {
    if (regionsList.dataset.aimBound === "1") return;
    regionsList.dataset.aimBound = "1";
    const regionNames = ["Head", "Body & Chest", "Belly & Tail"];
    regionsList.innerHTML = [0, 1, 2]
      .map((idx) => `
        <button type="button" class="led-region-item" data-region-card="${idx}" aria-pressed="false" aria-label="Aim lamp at ${regionNames[idx]}">
          <div class="led-region-row">
            <span class="led-region-title" data-region-title>${regionNames[idx]}</span>
            <strong class="led-region-lv" data-region-level>Lv0 / 10</strong>
          </div>
          <div class="led-progress-track" role="progressbar" data-region-progress aria-valuenow="0" aria-valuemin="0" aria-valuemax="10">
            <div class="led-progress-fill" data-region-fill style="width: 0%"></div>
          </div>
          <div class="led-maturity-text" data-region-maturity>0% maturity</div>
        </button>
      `)
      .join("");
    regionsList.querySelectorAll<HTMLElement>("[data-region-card]").forEach((card) => {
      card.addEventListener("click", () => {
        const region = Number(card.getAttribute("data-region-card")) as 0 | 1 | 2;
        void handleAimLamp(positionForRegionAim(region), true);
      });
    });
  }

  function patchRegionAimCards(
    regionsList: HTMLElement,
    sess: LedSession,
    aimedReg: number,
    levelUpRegion: number | null,
  ): void {
    const regionNames = ["Head", "Body & Chest", "Belly & Tail"];
    for (const idx of [0, 1, 2]) {
      const card = regionsList.querySelector<HTMLElement>(`[data-region-card="${idx}"]`);
      if (!card) continue;
      const region = sess.regions[idx as 0 | 1 | 2]!;
      const isAimed = aimedReg === idx;
      card.classList.toggle("aimed", isAimed);
      card.classList.toggle("led-region-levelup", levelUpRegion === idx);
      card.setAttribute("aria-pressed", String(isAimed));
      card.setAttribute("aria-label", `Aim lamp at ${regionNames[idx]}`);
      const title = card.querySelector<HTMLElement>("[data-region-title]");
      if (title) title.textContent = `${regionNames[idx]}${isAimed ? " · aimed" : ""}`;
      const level = card.querySelector<HTMLElement>("[data-region-level]");
      if (level) level.textContent = `Lv${region.level} / 10`;
      const pct = clamp((region.continuousLevel / 10) * 100, 0, 100);
      const maturityPct = Math.min(100, Math.round((region.dose / 19) * 100));
      const progress = card.querySelector<HTMLElement>("[data-region-progress]");
      if (progress) progress.setAttribute("aria-valuenow", String(region.level));
      const fill = card.querySelector<HTMLElement>("[data-region-fill]");
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      const maturity = card.querySelector<HTMLElement>("[data-region-maturity]");
      if (maturity) maturity.textContent = `${maturityPct}% maturity`;
    }
  }

  function renderPlayDynamicSections(): void {
    const sess = activeSession();
    const snap = activeCompletedSnapshot();
    const sessPolicy = policyForSession(sess);
    const stageState = getPortraitStateForActiveSession();
    stageCanvas.dataset.stageFamily = String(stageState.family);
    stageCanvas.dataset.stagePalette = String(stageState.palette);
    stageCanvas.dataset.stageAccessory = String(stageState.accessory);
    stageCanvas.dataset.stageBackground = String(stageState.background);
    stageCanvas.dataset.stageLevels = stageState.levels.join(",");
    stageCanvas.dataset.sessionStatus = sess.status;
    stageCanvas.dataset.lockedAccessory =
      sess.lockedTraits !== null ? String(sess.lockedTraits.accessoryIndex) : "-1";
    stageCanvas.dataset.lockedPalette =
      sess.lockedTraits !== null ? String(sess.lockedTraits.paletteIndex) : "-1";

    // 0. Mode Selector (Signed-In)
    const modeContainer = document.getElementById("mode-selector-container");
    if (modeContainer) {
      if (authPlayer) {
        modeContainer.style.display = "block";
        const remaining = userAllowance ? userAllowance.remaining : 3;
        const total = userAllowance ? userAllowance.total : 3;
        const isExhausted = remaining === 0;
        mountModeSelector(modeContainer);
        const rankedBtn = document.getElementById("btn-mode-ranked") as HTMLButtonElement | null;
        const demoBtn = document.getElementById("btn-mode-demo") as HTMLButtonElement | null;
        const notice = document.getElementById("mode-allowance-notice");
        if (rankedBtn) {
          rankedBtn.className = `led-mode-btn${activePlayMode === "ranked" ? " active" : ""}`;
          rankedBtn.disabled = eggConfirmed;
          const label = `🏆 Ranked (${remaining}/${total} left today)`;
          if (rankedBtn.textContent !== label) rankedBtn.textContent = label;
        }
        if (demoBtn) {
          demoBtn.className = `led-mode-btn${activePlayMode === "demo" ? " active" : ""}`;
          demoBtn.disabled = eggConfirmed;
          const label = "🧪 Play Demo (Unlimited)";
          if (demoBtn.textContent !== label) demoBtn.textContent = label;
        }
        if (notice) {
          const showNotice = isExhausted && activePlayMode === "ranked";
          notice.hidden = !showNotice;
          if (showNotice) {
            notice.textContent = `Daily ranked allowance exhausted (0/${total}). You can continue playing unlimited unranked Demo games!`;
          }
        }
      } else {
        modeContainer.style.display = "none";
      }
    }

    // 1. Mode badge & timer
    const modeBadge = document.getElementById("session-mode-badge");
    if (modeBadge) {
      if (authPlayer) {
        if (activePlayMode === "ranked") {
          modeBadge.textContent = `RANKED MODE · VERIFIED WALLET (${authPlayer.shortWallet})`;
          modeBadge.className = "led-kicker led-kicker-ranked";
        } else {
          modeBadge.textContent = `DEMO MODE (SIGNED IN: ${authPlayer.shortWallet}) · UNRANKED · RAM ONLY`;
          modeBadge.className = "led-kicker";
        }
      } else {
        modeBadge.textContent = "GUEST MODE · PROGRESS DISAPPEARS WHEN YOU REFRESH";
        modeBadge.className = "led-kicker";
      }
    }

    const timerEl = document.getElementById("timer-readout");
    if (timerEl) {
      timerEl.textContent = readoutForTimer(sess, sessPolicy.durationSeconds);
    }

    // 2. Species buttons & Egg selector visibility
    FAMILIES.forEach((f) => {
      const btn = document.getElementById(`species-btn-${f.id}`) as HTMLButtonElement | null;
      if (!btn) return;
      const isSelected = selectedFamilyIndex === f.index;
      btn.classList.toggle("selected", isSelected);
      btn.classList.toggle("active", isSelected);
      btn.setAttribute("aria-checked", String(isSelected));
      btn.disabled = eggConfirmed;
    });

    const selectorContainer = document.getElementById("species-selector-container");
    if (selectorContainer) {
      selectorContainer.hidden = eggConfirmed || sess.status !== "egg" || Boolean(sess.lockedTraits);
    }

    // 3. Lamp region marker (no visible Aim shortcuts panel)
    const aimedReg = regionAt(sess.lampPosition);
    const beamOverlay = document.getElementById("beam-overlay");
    if (beamOverlay) {
      beamOverlay.setAttribute("data-region", String(aimedReg));
      beamOverlay.hidden = true;
    }

    // 4. Primary Session Controls
    const controlsEl = document.getElementById("session-controls");
    if (controlsEl) {
      const isRunning = sess.status === "running";
      const isCompleted = sess.status === "completed";
      const hasLocked = Boolean(sess.lockedTraits);
      const readyToHatch = sess.elapsed + 1e-6 >= sessPolicy.durationSeconds;
      const canRestart = hasLocked && !isCompleted && sess.elapsed > 0;
      const remainingPlays = userAllowance ? userAllowance.remaining : 3;
      const totalPlays = userAllowance ? userAllowance.total : 3;
      const showAllowance = Boolean(authPlayer && activePlayMode === "ranked");
      const resetLabel = authPlayer && activePlayMode === "ranked"
        ? (isCompleted ? "Claim New Ranked Egg" : "Abandon & New Egg")
        : (isCompleted ? "New Demo Egg" : "New Egg Selection");
      syncStableControls(controlsEl, [
        {
          id: "btn-start-lamp",
          tag: "button",
          present: !isRunning && !isCompleted && !readyToHatch,
          text: authPlayer && activePlayMode === "ranked"
            ? "Start Ranked Lamp (Lock Traits)"
            : "Illuminate Demo Egg (Lock Traits)",
          className: "led-btn-primary",
          disabled: rankedRecoveryBlocked(),
        },
        {
          id: "btn-restart-attempt",
          tag: "button",
          present: canRestart || (hasLocked && !isCompleted),
          text: "Restart Attempt",
          className: "led-btn-ghost",
          disabled: false,
        },
        {
          id: "btn-complete-session",
          tag: "button",
          present: hasLocked && !isCompleted && readyToHatch,
          text: "Complete Character & Reveal Portrait",
          className: "led-btn-primary",
          disabled: false,
        },
        {
          id: "ranked-reconnect-status",
          tag: "span",
          present: rankedRecoveryBlocked(),
          text: "Reconnecting Ranked egg…",
          className: "",
          disabled: false,
          attrs: { role: "status" },
        },
        {
          id: "btn-reset-egg",
          tag: "button",
          present: true,
          text: resetLabel,
          className: "led-btn-ghost",
          disabled: rankedRecoveryBlocked(),
        },
        {
          id: "session-allowance-badge",
          tag: "span",
          present: showAllowance,
          text: "",
          html: `Plays left today: <strong>${remainingPlays} / ${totalPlays}</strong>`,
          className: "led-account-allowance",
          disabled: false,
          attrs: { style: "display:inline-block; margin-left:0.5rem; vertical-align:middle;" },
        },
      ]);
    }

    // 5. Regional Growth Lv0-10
    const regionScorePill = document.getElementById("region-score-pill");
    if (regionScorePill) {
      regionScorePill.style.display = "none";
    }

    const regionsList = document.getElementById("regions-list");
    if (regionsList) {
      const levelUpRegion =
        levelUpBanner && levelUpBanner.expiresAt > Date.now() ? levelUpBanner.region : null;
      mountRegionAimCards(regionsList);
      patchRegionAimCards(regionsList, sess, aimedReg, levelUpRegion);
    }

    // 6. Telemetry & Schedules (100 work units / 100m)
    const telemetryBadge = document.getElementById("telemetry-badge");
    const powerPct = Math.round(clientEffectivePower * 100);
    if (telemetryBadge) {
      if (!hardwareHealthy) {
        telemetryBadge.textContent = "SIGNAL UNAVAILABLE · PAUSED";
        telemetryBadge.className = "led-telemetry-badge idle";
      } else if (clientSignalState === "speed-unavailable") {
        telemetryBadge.textContent = `Speed unavailable · Lamp ${powerPct}% (Base power)`;
        telemetryBadge.className = "led-telemetry-badge idle";
      } else {
        telemetryBadge.textContent = `${latestReading.coreStatus} · ${clientEffectiveRpm.toFixed(1)} RPM · Lamp ${powerPct}%`;
        telemetryBadge.className =
          latestReading.coreStatus === "ACTIVE"
            ? "led-telemetry-badge active"
            : "led-telemetry-badge idle";
      }
    }

    const telemetryMetrics = document.getElementById("telemetry-metrics");
    if (telemetryMetrics) {
      telemetryMetrics.style.display = "none";
    }

    const palWin =
      currentPaletteSchedule ??
      (() => {
        const w = paletteScheduleAt(latestReading.distanceMm, sessPolicy);
        return {
          step: w.step.toString(),
          itemIndex: w.itemIndex,
          itemId: w.item.id,
          itemName: w.item.name,
          points: w.points,
          tier: w.tier,
          isRareWindow: w.isRareWindow,
          remainingInStep: w.remainingInStep,
          nextItemIndex: w.nextItemIndex,
          nextItemId: w.nextItem.id,
          nextItemName: w.nextItem.name,
          nextPoints: w.nextPoints,
          dailyRareWindowsOpened: w.dailyRareWindowsOpened,
          dailyRareCaps: w.dailyRareCaps,
        };
      })();

    const accWin =
      currentAccessorySchedule ??
      (() => {
        const w = accessoryScheduleAt(
          latestReading.work,
          dayStartWorkUnits,
          sessPolicy,
        );
        return {
          step: w.step.toString(),
          itemIndex: w.itemIndex,
          itemId: w.item.id,
          itemName: w.item.name,
          points: w.points,
          tier: w.tier,
          isRareWindow: w.isRareWindow,
          remainingInStep: w.remainingInStep.toString(),
          nextItemIndex: w.nextItemIndex,
          nextItemId: w.nextItem.id,
          nextItemName: w.nextItem.name,
          nextPoints: w.nextPoints,
          dailyRareWindowsOpened: w.dailyRareWindowsOpened,
          dailyRareCaps: w.dailyRareCaps,
        };
      })();

    const schedulesGrid = document.getElementById("schedules-grid");
    if (schedulesGrid) {
      schedulesGrid.innerHTML = `
        <div class="led-schedule-card">
          <div class="led-schedule-top">
            <span class="led-schedule-kind">Coat Palette</span>
          </div>
          <div class="led-schedule-current">${escapeText(palWin.itemName)}</div>
          <div class="led-schedule-sub">
            Next: ${escapeText(palWin.nextItemName)}
          </div>
        </div>

        <div class="led-schedule-card">
          <div class="led-schedule-top">
            <span class="led-schedule-kind">Cyber Accessory</span>
          </div>
          <div class="led-schedule-current">${escapeText(accWin.itemName)}</div>
          <div class="led-schedule-sub">
            Next: ${escapeText(accWin.nextItemName)}
          </div>
        </div>
      `;
    }

    const lockedBox = document.getElementById("locked-traits-box");
    if (lockedBox) {
      if (sess.lockedTraits) {
        const lPalPts = sessPolicy.palettePoints[sess.lockedTraits.paletteIndex] ?? 1;
        const lAccPts = sessPolicy.accessoryPoints[sess.lockedTraits.accessoryIndex] ?? 1;
        const bgItem =
          sess.backgroundIndex !== null && sess.status === "completed"
            ? backgroundByIndex(sess.backgroundIndex)
            : null;
        const bgPts =
          sess.backgroundIndex !== null && sess.status === "completed"
            ? (sessPolicy.backgroundPoints[sess.backgroundIndex] ?? 1)
            : null;
        lockedBox.innerHTML = `
          <div class="led-locked-active">
            <strong>🔒 Locked Traits:</strong>
            <div class="led-locked-pills">
              <span>Palette: <strong>${escapeText(sess.lockedTraits.paletteName)}</strong> (${lPalPts} pt)</span>
              <span>Accessory: <strong>${escapeText(sess.lockedTraits.accessoryName)}</strong> (${lAccPts} pt)</span>
              ${bgItem ? `<span>Background: <strong>${escapeText(bgItem.name)}</strong> (${bgPts} pt)</span>` : ""}
            </div>
          </div>
        `;
      } else {
        lockedBox.innerHTML = `
          <div class="led-locked-pending">
            First light locks <strong>${escapeText(palWin.itemName)}</strong> &amp; <strong>${escapeText(accWin.itemName)}</strong>.
          </div>
        `;
      }
    }

    // 7. Completed Result Panel
    const resultPanel = document.getElementById("result-panel");
    const resultSummary = document.getElementById("result-summary-body");
    if (resultPanel && resultSummary) {
      if (snap && sess.status === "completed") {
        resultPanel.hidden = false;
        resultSummary.innerHTML = `
          <div class="led-result-grid">
            <div class="led-result-stat">
              <span>Species</span>
              <strong>${escapeText(snap.familyName)}</strong>
            </div>
            <div class="led-result-stat">
              <span>Regions (H / M / L)</span>
              <strong>Lv${snap.levels[0]} / Lv${snap.levels[1]} / Lv${snap.levels[2]} (${snap.scores.regionsTotal} pts)</strong>
            </div>
            <div class="led-result-stat">
              <span>Coat Palette</span>
              <strong>${escapeText(snap.paletteName)} (+${snap.scores.palette} pts)</strong>
            </div>
            <div class="led-result-stat">
              <span>Cyber Accessory</span>
              <strong>${escapeText(snap.accessoryName)} (+${snap.scores.accessory} pts)</strong>
            </div>
            <div class="led-result-stat">
              <span>LED Background</span>
              <strong>${escapeText(snap.backgroundName)} (+${snap.scores.background} pts)</strong>
            </div>
            <div class="led-result-stat highlight">
              <span>Total Score</span>
              <strong>${snap.scores.total} pts</strong>
            </div>
          </div>
          <div class="led-result-footer">
            ${
              snap.mode === "ranked"
                ? `<span>✓ Recorded on Server (${escapeText(snap.weekKey)})${rankedLeaderboardRank ? ` · Current Weekly Rank #${rankedLeaderboardRank}` : ""}</span>
                   <a href="#result/${encodeURIComponent(snap.resultId)}" class="led-btn-secondary">Open Public Character Result (#result/${escapeText(snap.resultId)}) →</a>`
                : `<span>Guest Mode: Progress disappears when you refresh. Sign in with your wallet to save characters and enter the Weekly Top 100 Leaderboard.</span>`
            }
          </div>
        `;
      } else {
        resultPanel.hidden = true;
      }
    }
    redrawStageCanvas();
  }

  function renderProfileSection(): void {
    const tag = document.getElementById("profile-auth-tag");
    const body = document.getElementById("profile-body");
    if (!tag || !body) return;

    const conn = connection();
    if (!authPlayer) {
      tag.textContent = conn.address ? "Wallet Connected · Sign In Required" : "Guest Mode";
      body.innerHTML = `
        <p class="led-subtle">
          ${
            conn.address
              ? `Connected wallet <code>${shortWalletAddress(conn.address)}</code> is not signed in yet. Sign the one-time SIWE login message to set an optional display name and record Ranked scores.`
              : `Playing in Guest Mode (progress disappears when you refresh). Connect a wallet and sign a SIWE login message to set a display name and enter the Weekly Top 100 Leaderboard.`
          }
        </p>
        <div class="led-controls-row">
          <button type="button" class="led-btn-secondary" id="profile-btn-signin">
            ${conn.address ? "Sign SIWE Challenge" : "Connect Wallet & Sign In"}
          </button>
        </div>
      `;
      document.getElementById("profile-btn-signin")?.addEventListener("click", () => {
        if (conn.address) {
          void handleSiweSignIn(conn.address);
        } else {
          walletSheetOpen = true;
          renderWalletSheet();
        }
      });
      return;
    }

    tag.textContent = `Verified · ${authPlayer.shortWallet}`;
    body.innerHTML = `
      <div class="led-profile-info">
        <div>Primary Wallet Key: <code>${authPlayer.walletAddress}</code></div>
        <div>Effective Leaderboard Name: <strong>${escapeText(authPlayer.effectiveName)}</strong></div>
      </div>
      <form id="display-name-form" class="led-name-form">
        <label for="display-name-input" class="led-subtle">
          Optional Display Name (max 30 chars; leave blank to use ${authPlayer.shortWallet}):
        </label>
        <div class="led-name-input-row">
          <input
            id="display-name-input"
            type="text"
            maxlength="30"
            placeholder="${authPlayer.shortWallet}"
            value="${escapeAttr(authPlayer.displayName ?? "")}"
            class="led-input"
          />
          <button type="submit" class="led-btn-primary" id="btn-save-name">Save Name</button>
          <button type="button" class="led-btn-ghost" id="btn-clear-name">Use Wallet Short</button>
        </div>
      </form>
    `;

    const form = document.getElementById("display-name-form") as HTMLFormElement | null;
    const input = document.getElementById("display-name-input") as HTMLInputElement | null;
    form?.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!input) return;
      const check = validatePlayerDisplayName(input.value);
      if (!check.valid) {
        showToast("err", check.error || "Invalid display name.");
        return;
      }
      const res = await apiFetch<{ player: PlayerProfile; error?: string }>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ displayName: check.normalized }),
      });
      if (!res.ok) {
        showToast("err", res.data.error || "Failed to update display name.");
        return;
      }
      authPlayer = res.data.player;
      showToast("ok", `Display name updated: ${authPlayer.effectiveName}`);
      renderAuthBar();
      renderProfileSection();
      void refreshLeaderboard();
    });

    document.getElementById("btn-clear-name")?.addEventListener("click", async () => {
      const res = await apiFetch<{ player: PlayerProfile; error?: string }>("/api/profile", {
        method: "PUT",
        body: JSON.stringify({ displayName: "" }),
      });
      if (res.ok) {
        authPlayer = res.data.player;
        showToast("ok", `Cleared custom name; using ${authPlayer.effectiveName}.`);
        renderAuthBar();
        renderProfileSection();
        void refreshLeaderboard();
      }
    });
  }

  function buildFullLeaderboardHtml(entries: LeaderboardEntryDto[]): string {
    if (leaderboardLoading && entries.length === 0) {
      return `<div class="led-empty-state">Loading Weekly Top 100 Leaderboard...</div>`;
    }
    if (entries.length === 0) {
      return `
        <div class="led-empty-state" data-testid="leaderboard-empty">
          <strong>0 Ranked Characters Recorded This Week (${escapeText(leaderboardWeekKey || "Current Week")})</strong>
          <p>Sign in with your wallet and complete a 60-second ranked incubation to claim Rank #1!</p>
        </div>
      `;
    }

    const top3 = entries.slice(0, 3);
    const rest = entries.slice(3);

    const top3Html = `
      <div class="led-lb-top3-grid">
        ${top3
          .map(
            (entry) => `
          <div class="led-card led-top3-card led-lb-row" data-result-id="${escapeAttr(entry.resultId)}" tabindex="0" role="link" aria-label="Inspect rank #${entry.rank} portrait for ${escapeAttr(entry.effectiveName)}">
            <div class="led-top3-portrait-wrap" data-portrait-for="${escapeAttr(entry.resultId)}">
              <span class="led-top3-rank-badge led-top3-rank-${entry.rank}">#${entry.rank}</span>
            </div>
            <div class="led-top3-info">
              <div class="led-top3-name">${escapeText(entry.effectiveName)}</div>
              <div class="led-top3-score">${entry.scores.total} pts</div>
              <a href="#result/${encodeURIComponent(entry.resultId)}" class="led-lb-view-link" style="display:inline-block; margin-top:0.35rem; font-size:0.8rem;">View 1600×1600 →</a>
            </div>
          </div>
        `,
          )
          .join("")}
      </div>
    `;

    const restHtml =
      rest.length > 0
        ? `
      <div class="led-table-scroll" style="margin-top: 1.5rem;">
        <table class="led-lb-table" aria-label="Weekly Top 100 Leaderboard Ranks 4-100">
          <thead>
            <tr>
              <th>Rank</th>
              <th>Player (Wallet Key)</th>
              <th>Species</th>
              <th>Regions (H/M/L)</th>
              <th>Palette</th>
              <th>Accessory</th>
              <th>Background</th>
              <th>Total Score</th>
              <th>Portrait</th>
            </tr>
          </thead>
          <tbody>
            ${rest
              .map(
                (entry) => `
              <tr class="led-lb-row" data-result-id="${escapeAttr(entry.resultId)}" tabindex="0" role="link" aria-label="Inspect character portrait for ${escapeAttr(entry.effectiveName)} Rank ${entry.rank}">
                <td><strong>#${entry.rank}</strong></td>
                <td>
                  <div class="led-lb-player">
                    <span class="led-lb-name">${escapeText(entry.effectiveName)}</span>
                  </div>
                </td>
                <td>${escapeText(entry.familyName)}</td>
                <td><code>${entry.levels.join("/")}</code> <small>(${entry.scores.regionsTotal}p)</small></td>
                <td>${escapeText(entry.palette.name)} <small>(+${entry.palette.points})</small></td>
                <td>${escapeText(entry.accessory.name)} <small>(+${entry.accessory.points})</small></td>
                <td>${escapeText(entry.background.name)} <small>(+${entry.background.points})</small></td>
                <td><strong class="led-lb-total">${entry.scores.total} pts</strong></td>
                <td><a href="#result/${encodeURIComponent(entry.resultId)}" class="led-lb-view-link">View 1600×1600 →</a></td>
              </tr>
            `,
              )
              .join("")}
          </tbody>
        </table>
      </div>
    `
        : "";

    return `${top3Html}${restHtml}`;
  }

  function bindLeaderboardRowClicks(container: HTMLElement | null): void {
    if (!container) return;
    container.querySelectorAll<HTMLElement>(".led-lb-row").forEach((row) => {
      const resultId = row.dataset.resultId;
      if (!resultId) return;
      row.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).tagName === "A") return;
        navigateToHash(`#result/${encodeURIComponent(resultId)}`);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigateToHash(`#result/${encodeURIComponent(resultId)}`);
        }
      });
    });
  }

  function familyIndexForLeaderboard(familyId: string): 0 | 1 | 2 {
    if (familyId === "relay") return 1;
    if (familyId === "prism") return 2;
    return 0;
  }

  function leaderboardPortraitKey(entry: LeaderboardEntryDto): string {
    return portraitVisualKey({
      family: familyIndexForLeaderboard(entry.familyId),
      levels: entry.levels,
      palette: entry.palette.index,
      accessory: entry.accessory.index,
      background: entry.background.index,
      staticOnly: true,
    });
  }

  function leaderboardMarkupSignature(
    entries: readonly LeaderboardEntryDto[],
    loading: boolean,
    weekKey: string,
  ): string {
    if (entries.length === 0) return `${loading ? "loading" : "empty"}|${weekKey}`;
    return `${weekKey}|${entries
      .map((entry) =>
        [
          entry.rank,
          entry.resultId,
          entry.effectiveName,
          entry.familyId,
          entry.familyName,
          entry.levels.join(","),
          entry.palette.index,
          entry.palette.name,
          entry.palette.points,
          entry.accessory.index,
          entry.accessory.name,
          entry.accessory.points,
          entry.background.index,
          entry.background.name,
          entry.background.points,
          entry.scores.regionsTotal,
          entry.scores.total,
        ].join("~"),
      )
      .join("|")}`;
  }

  function findLeaderboardPortraitWrap(container: HTMLElement, resultId: string): HTMLElement | null {
    for (const wrap of container.querySelectorAll<HTMLElement>("[data-portrait-for]")) {
      if (wrap.dataset.portraitFor === resultId) return wrap;
    }
    return null;
  }

  function releaseLeaderboardPortrait(resultId: string): void {
    const rec = leaderboardPortraits.get(resultId);
    if (!rec) return;
    rec.adapter.stopAnimation();
    rec.adapter.dispose();
    rec.canvas.remove();
    leaderboardPortraits.delete(resultId);
  }

  function renderLeaderboardTables(): void {
    const badge = document.getElementById("lb-week-badge");
    if (badge) {
      badge.textContent = leaderboardWeekKey
        ? `${leaderboardWeekKey} · Top ${leaderboardEntries.length} / 100`
        : "Weekly Top 100";
    }
    const fullContainer = document.getElementById("full-leaderboard-container");
    if (!fullContainer) return;

    if (currentRoute.kind !== "leaderboard") {
      if (!leaderboardPlaceholderReady && leaderboardEntries.length === 0 && fullContainer.childElementCount === 0) {
        fullContainer.innerHTML = buildFullLeaderboardHtml(leaderboardEntries);
        leaderboardPlaceholderReady = true;
        leaderboardViewSignature = leaderboardMarkupSignature(leaderboardEntries, false, leaderboardWeekKey);
      }
      return;
    }

    const top3 = leaderboardEntries.slice(0, 3);
    const nextPortraits = top3.map((entry) => ({
      resultId: entry.resultId,
      visualKey: leaderboardPortraitKey(entry),
    }));
    const previousPortraits = [...leaderboardPortraits.entries()].map(([resultId, rec]) => ({
      resultId,
      visualKey: rec.visualKey,
    }));
    const plan = planLeaderboardPortraits(previousPortraits, nextPortraits);
    const signature = leaderboardMarkupSignature(leaderboardEntries, leaderboardLoading, leaderboardWeekKey);
    if (signature === leaderboardViewSignature && plan.dispose.length === 0 && plan.redraw.length === 0) {
      return;
    }

    for (const resultId of plan.dispose) releaseLeaderboardPortrait(resultId);
    for (const rec of leaderboardPortraits.values()) rec.canvas.remove();
    fullContainer.innerHTML = buildFullLeaderboardHtml(leaderboardEntries);
    bindLeaderboardRowClicks(fullContainer);

    const redraw = new Set(plan.redraw);
    for (const entry of top3) {
      const wrap = findLeaderboardPortraitWrap(fullContainer, entry.resultId);
      if (!wrap) continue;
      const visualKey = leaderboardPortraitKey(entry);
      let rec = leaderboardPortraits.get(entry.resultId);
      if (!rec) {
        const canvas = document.createElement("canvas");
        canvas.className = "led-top3-portrait-img";
        const adapter = new LedPortraitAdapter(canvas, { size: 400 });
        rec = { adapter, canvas, visualKey: "" };
        leaderboardPortraits.set(entry.resultId, rec);
      }
      rec.canvas.id = `full-top3-canvas-${entry.rank}`;
      rec.canvas.className = "led-top3-portrait-img";
      wrap.appendChild(rec.canvas);
      if (redraw.has(entry.resultId) || rec.visualKey !== visualKey) {
        rec.adapter.draw(
          {
            family: familyIndexForLeaderboard(entry.familyId),
            palette: entry.palette.index,
            accessory: entry.accessory.index,
            background: entry.background.index,
            levels: entry.levels,
          },
          { staticOnly: true },
        );
        rec.adapter.stopAnimation();
        rec.visualKey = visualKey;
      }
    }
    leaderboardViewSignature = signature;
    leaderboardPlaceholderReady = true;
  }

  function renderNftView(): void {
    const statusEl = document.getElementById("nft-detail-status");
    const gridEl = document.getElementById("nft-detail-grid");
    const metaEl = document.getElementById("nft-detail-meta");
    const titleEl = document.getElementById("nft-view-title");
    if (!statusEl || !gridEl || !metaEl || !titleEl) return;

    if (nftDetailLoading) {
      statusEl.innerHTML = `<div class="led-empty-state">Loading public 1600×1600 LED portrait...</div>`;
      gridEl.hidden = true;
      return;
    }

    if (nftDetailError || !nftDetailData) {
      statusEl.innerHTML = `<div id="nft-not-found" class="led-empty-state led-err-text">${escapeText(nftDetailError || "Character result not found.")}</div>`;
      gridEl.hidden = true;
      return;
    }

    statusEl.innerHTML = "";
    gridEl.hidden = false;
    const { snapshot, player, leaderboardRank } = nftDetailData;
    titleEl.textContent = `Squeek ${snapshot.familyName} · ${player.effectiveName}`;

    const nextKey = portraitVisualKey({
      family: snapshot.familyIndex,
      levels: snapshot.levels,
      palette: snapshot.paletteIndex,
      accessory: snapshot.accessoryIndex,
      background: snapshot.backgroundIndex,
      staticOnly: false,
    });
    const drawPortrait = shouldDrawPortrait({
      previousKey: nftPortraitKey,
      nextKey,
      routeVisible: currentRoute.kind === "result",
      canvasFullyHidden: false,
      pixelsSampledWhileHidden: false,
    });
    if (drawPortrait) {
      const token = ++nftDrawToken;
      nftPortraitKey = nextKey;
      void nftAdapter.drawAsync({
        family: snapshot.familyIndex,
        levels: snapshot.levels,
        palette: snapshot.paletteIndex,
        accessory: snapshot.accessoryIndex,
        background: snapshot.backgroundIndex,
      }).then(() => {
        if (token !== nftDrawToken) return;
        if (currentRoute.kind !== "result") nftAdapter.stopAnimation();
      });
    } else if (
      shouldResumeAccessoryAnimation({
        previousKey: nftPortraitKey,
        nextKey,
        routeVisible: currentRoute.kind === "result",
        canvasFullyHidden: false,
        animating: nftAdapter.status.animating,
        accessoryAnimates: snapshot.accessoryIndex >= 7 && !prefersReducedMotion(),
      })
    ) {
      nftAdapter.resumeAccessoryAnimation();
    }

    metaEl.innerHTML = `
      <div class="led-nft-meta-card">
        <div class="led-nft-owner-box">
          <div><span>Player Name:</span> <strong>${escapeText(player.effectiveName)}</strong></div>
          <div><span>Weekly Rank (${escapeText(snapshot.weekKey)}):</span> <strong>${leaderboardRank ? `#${leaderboardRank}` : "Unranked / Historical"}</strong></div>
          <div><span>Policy Preset:</span> <code>${escapeText(snapshot.policyVersion)} (Experimental)</code></div>
        </div>

        <h3>Regional Levels (${snapshot.scores.regionsTotal} / 30 pts)</h3>
        <ul class="led-nft-trait-list">
          <li><strong>Head:</strong> Lv${snapshot.levels[0]} / 10 — ${escapeText(LED_STAGE_DESCRIPTIONS[0][snapshot.levels[0]] ?? "")}</li>
          <li><strong>Middle:</strong> Lv${snapshot.levels[1]} / 10 — ${escapeText(LED_STAGE_DESCRIPTIONS[1][snapshot.levels[1]] ?? "")}</li>
          <li><strong>Lower:</strong> Lv${snapshot.levels[2]} / 10 — ${escapeText(LED_STAGE_DESCRIPTIONS[2][snapshot.levels[2]] ?? "")}</li>
        </ul>

        <h3>Locked & Assigned Traits</h3>
        <ul class="led-nft-trait-list">
          <li><strong>Species:</strong> ${escapeText(snapshot.familyName)}</li>
          <li><strong>Coat Palette (100m lock):</strong> ${escapeText(snapshot.paletteName)} (+${snapshot.scores.palette} pts)</li>
          <li><strong>Cyber Accessory (100-unit lock):</strong> ${escapeText(snapshot.accessoryName)} (+${snapshot.scores.accessory} pts)</li>
          <li><strong>LED Background (Assigned on completion):</strong> ${escapeText(snapshot.backgroundName)} (+${snapshot.scores.background} pts)</li>
        </ul>

        <div class="led-nft-total-banner">
          <span>Verified Total Score</span>
          <strong>${snapshot.scores.total} pts</strong>
        </div>
      </div>
    `;
  }

  function renderRouteVisibility(): void {
    syncRankedDisplayClock();
    const viewPlay = document.getElementById("view-play");
    const viewLb = document.getElementById("view-leaderboard");
    const viewNft = document.getElementById("view-nft");
    const viewDocs = document.getElementById("view-docs");

    if (viewPlay) viewPlay.hidden = currentRoute.kind !== "play";
    if (viewLb) viewLb.hidden = currentRoute.kind !== "leaderboard";
    if (viewNft) viewNft.hidden = currentRoute.kind !== "result";
    if (viewDocs) viewDocs.hidden = currentRoute.kind !== "docs";

    document.querySelectorAll<HTMLAnchorElement>(".led-nav-link").forEach((link) => {
      const target = link.dataset.nav;
      link.classList.toggle("active", target === currentRoute.kind);
    });

    if (currentRoute.kind === "play") {
      nftAdapter.stopAnimation();
      syncDocsCatalog(false);
      redrawStageCanvas();
      paintRankedDisplayTimer();
    } else if (currentRoute.kind === "result") {
      stageAdapter.stopAnimation();
      syncDocsCatalog(false);
      void loadPublicNftDetail(currentRoute.resultId);
    } else if (currentRoute.kind === "leaderboard") {
      stageAdapter.stopAnimation();
      nftAdapter.stopAnimation();
      syncDocsCatalog(false);
      void refreshLeaderboard();
    } else {
      stageAdapter.stopAnimation();
      nftAdapter.stopAnimation();
      syncDocsCatalog(true);
    }
  }

  function renderAll(): void {
    renderAuthBar();
    renderWalletSheet();
    renderPlayDynamicSections();
    renderProfileSection();
    renderLeaderboardTables();
    renderRouteVisibility();
  }

  // ---------- Event Listeners ----------
  window.addEventListener("hashchange", () => {
    currentRoute = parseCurrentRoute();
    renderRouteVisibility();
  });
  window.addEventListener("popstate", () => {
    currentRoute = parseCurrentRoute();
    renderRouteVisibility();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      syncRankedDisplayClock();
      void handlePauseIllumination();
    }
  });

  document.getElementById("wallet-sheet-close")?.addEventListener("click", () => {
    walletSheetOpen = false;
    renderWalletSheet();
  });

  document.querySelectorAll<HTMLButtonElement>(".led-species-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.familyIndex) as 0 | 1 | 2;
      void handleSelectFamily(idx);
    });
  });

  document.getElementById("btn-confirm-egg")?.addEventListener("click", () => {
    void handleConfirmClaimEgg();
  });

  const lampSlider = document.getElementById("lamp") as HTMLInputElement | null;
  lampSlider?.addEventListener("input", () => {
    void handleAimLamp(Number(lampSlider.value), false);
  });
  lampSlider?.addEventListener("change", () => {
    void handleAimLamp(Number(lampSlider.value), true);
  });

  // Lamp handle & rail dragging with runtime geometry and keyboard navigation
  const stageWrap = document.getElementById("stage-canvas-wrap");
  const lampHandleElem = document.getElementById("lamp-handle-elem");
  const railHit = document.getElementById("rail-hit");

  function sceneYFromClientY(clientY: number): number {
    const span = sceneRailSpan();
    const fallback = (span.y1 + span.y2) / 2;
    if (!stageWrap) return fallback;
    const rect = stageWrap.getBoundingClientRect();
    if (rect.height <= 0) return fallback;
    return ((clientY - rect.top) / rect.height) * INCUBATION_SCENE.height;
  }

  function railYFromEvent(e: PointerEvent): number {
    return sceneYFromClientY(e.clientY);
  }

  let draggingRail = false;
  let railPointerId = -1;
  let railDragAim = 0;
  for (const el of [lampHandleElem, railHit]) {
    if (!el) continue;
    el.addEventListener("pointerdown", (e) => {
      if (activeSession().status === "completed") return;
      if (draggingRail) return;
      e.preventDefault();
      draggingRail = true;
      railPointerId = e.pointerId;
      if (e.isTrusted) (el as HTMLElement).setPointerCapture(e.pointerId);
      railDragAim = positionForSceneRailY(railYFromEvent(e));
      void handleAimLamp(railDragAim, false);
      lampHandleElem?.focus({ preventScroll: true });
    });
    el.addEventListener("pointermove", (e) => {
      if (!draggingRail || e.pointerId !== railPointerId) return;
      railDragAim = positionForSceneRailY(railYFromEvent(e));
      void handleAimLamp(railDragAim, false);
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
      el.addEventListener(ev, (e) => {
        const pointer = e as PointerEvent;
        if (!draggingRail || pointer.pointerId !== railPointerId) return;
        draggingRail = false;
        railPointerId = -1;
        if (ev === "pointerup") {
          void handleAimLamp(positionForSceneRailY(railYFromEvent(pointer)), true);
          return;
        }
        // Cancel and lost capture often report clientY 0. Keep the last drag aim.
        void handleAimLamp(railDragAim, true);
      });
    }
  }

  lampHandleElem?.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 20 : 5;
    const map: Record<string, number> = {
      ArrowUp: -step,
      ArrowLeft: -step,
      ArrowDown: step,
      ArrowRight: step,
      PageUp: -25,
      PageDown: 25,
    };
    const sess = activeSession();
    if (e.key in map) {
      e.preventDefault();
      void handleAimLamp(sess.lampPosition + map[e.key], true);
    } else if (e.key === "Home") {
      e.preventDefault();
      void handleAimLamp(-100, true);
    } else if (e.key === "End") {
      e.preventDefault();
      void handleAimLamp(100, true);
    }
  });

  // Pointer drag on stage canvas wrap to aim lamp height smoothly
  let draggingStage = false;
  let stagePointerId = -1;
  let stageDragAim = 0;
  const aimFromStagePointer = (clientY: number, commit: boolean) => {
    const aim = positionForSceneRailY(sceneYFromClientY(clientY));
    void handleAimLamp(aim, commit);
    return aim;
  };
  stageWrap?.addEventListener("pointerdown", (e) => {
    if (e.target === lampHandleElem || e.target === railHit) return;
    if (draggingStage) return;
    draggingStage = true;
    stagePointerId = e.pointerId;
    stageDragAim = aimFromStagePointer(e.clientY, false);
  });
  window.addEventListener("pointermove", (e) => {
    if (!draggingStage || e.pointerId !== stagePointerId) return;
    stageDragAim = aimFromStagePointer(e.clientY, false);
  });
  window.addEventListener("pointerup", (e) => {
    if (!draggingStage || e.pointerId !== stagePointerId) return;
    draggingStage = false;
    stagePointerId = -1;
    aimFromStagePointer(e.clientY, true);
  });
  window.addEventListener("pointercancel", (e) => {
    if (!draggingStage || e.pointerId !== stagePointerId) return;
    draggingStage = false;
    stagePointerId = -1;
    // A native cancel can arrive at client 0,0. That is not a new aim.
    void handleAimLamp(stageDragAim, true);
  });

  document.getElementById("btn-refresh-lb")?.addEventListener("click", () => {
    void refreshLeaderboard();
  });
  document.getElementById("btn-refresh-lb-full")?.addEventListener("click", () => {
    void refreshLeaderboard();
  });

  document.getElementById("btn-export-png")?.addEventListener("click", async () => {
    const snap = activeCompletedSnapshot();
    if (!snap) return;
    try {
      const blob = await stageAdapter.exportPngBlob({
        family: snap.familyIndex,
        levels: snap.levels,
        palette: snap.paletteIndex,
        accessory: snap.accessoryIndex,
        background: snap.backgroundIndex,
      });
      downloadBlob(blob, `${snap.resultId}-1600x1600.png`);
    } catch (err) {
      showToast("err", errorMessage(err));
    }
  });

  document.getElementById("btn-export-json")?.addEventListener("click", () => {
    const snap = activeCompletedSnapshot();
    if (!snap) return;
    const jsonStr = buildLedMetadataJson(snap);
    downloadBlob(
      new Blob([jsonStr], { type: "application/json;charset=utf-8" }),
      `${snap.resultId}-metadata.json`,
    );
  });

  document.getElementById("btn-nft-export-png")?.addEventListener("click", async () => {
    if (!nftDetailData) return;
    const s = nftDetailData.snapshot;
    try {
      const blob = await nftAdapter.exportPngBlob({
        family: s.familyIndex,
        levels: s.levels,
        palette: s.paletteIndex,
        accessory: s.accessoryIndex,
        background: s.backgroundIndex,
      });
      downloadBlob(blob, `${s.resultId}-1600x1600.png`);
    } catch (err) {
      showToast("err", errorMessage(err));
    }
  });

  document.getElementById("btn-nft-export-json")?.addEventListener("click", () => {
    if (!nftDetailData) return;
    const s = nftDetailData.snapshot;
    const jsonStr = buildLedMetadataJson(s);
    downloadBlob(
      new Blob([jsonStr], { type: "application/json;charset=utf-8" }),
      `${s.resultId}-metadata.json`,
    );
  });

  // Initial boot sequence
  await Promise.all([
    refreshAuthSession(),
    pollHardwareStatus(),
  ]);
  renderAll();
  (window as unknown as Record<string, unknown>).__squeekAppMounted = true;
}

function escapeText(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(str: string): string {
  return escapeText(str);
}

void mountApp();
