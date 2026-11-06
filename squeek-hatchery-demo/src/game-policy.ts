import { clamp } from "./rules.ts";

function defaultCsprngInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 1) return 0;
  const maxUint32 = 0x1_0000_0000;
  const limit = maxUint32 - (maxUint32 % maxExclusive);
  const buf = new Uint32Array(1);
  while (true) {
    globalThis.crypto.getRandomValues(buf);
    const val = buf[0]!;
    if (val < limit) {
      return val % maxExclusive;
    }
  }
}

export type FamilyId = "pulse" | "relay" | "prism";
export type RarityTier = "common-1" | "uncommon-2" | "rare-4" | "apex-8";
export type TraitPoints = 1 | 2 | 4 | 8;

export interface FamilyCatalogItem {
  index: 0 | 1 | 2;
  id: FamilyId;
  name: "Pulse" | "Relay" | "Prism";
  tagline: string;
  description: string;
  atlasFile: string;
}

export interface PaletteCatalogItem {
  index: number;
  id: string;
  name: string;
  labGroup: "basic" | "special";
  coat: string;
  cream: string;
  accent: string;
}

export interface AccessoryCatalogItem {
  index: number;
  id: string;
  name: string;
  labGroup: "basic" | "special";
  description: string;
}

export interface BackgroundCatalogItem {
  index: number;
  id: string;
  name: string;
  labGroup: "basic" | "special" | "apex";
  color: string;
  description: string;
  file: string;
}

export const FAMILIES: readonly FamilyCatalogItem[] = [
  {
    index: 0,
    id: "pulse",
    name: "Pulse",
    tagline: "Round · radar ears",
    description: "Balanced receiver chambers with circular harmonic ear dishes and a round tail tuft.",
    atlasFile: "pulse-evolution-v1.png",
  },
  {
    index: 1,
    id: "relay",
    name: "Relay",
    tagline: "Pear · folded ears",
    description: "Plush pear silhouette with folded signal ears and chevron chest markings.",
    atlasFile: "relay-evolution-v1.png",
  },
  {
    index: 2,
    id: "prism",
    name: "Prism",
    tagline: "Petal · fan ears",
    description: "Petal-crested receiver ears with a low crystal fan tail and diamond motifs.",
    atlasFile: "prism-evolution-v1.png",
  },
] as const;

export const PALETTES: readonly PaletteCatalogItem[] = [
  { index: 0, id: "apricot", name: "Apricot", labGroup: "basic", coat: "#f6b45f", cream: "#fff1ca", accent: "#81e9e6" },
  { index: 1, id: "cocoa", name: "Cocoa", labGroup: "basic", coat: "#a77864", cream: "#f5ddc7", accent: "#eebc80" },
  { index: 2, id: "cloud", name: "Cloud", labGroup: "basic", coat: "#b8c5dc", cream: "#f4f7ff", accent: "#7ddcff" },
  { index: 3, id: "rose", name: "Rose", labGroup: "basic", coat: "#e69bad", cream: "#ffe4dc", accent: "#abdfe8" },
  { index: 4, id: "sage", name: "Sage", labGroup: "basic", coat: "#9fc6a0", cream: "#eef1ce", accent: "#ebcc89" },
  { index: 5, id: "lilac", name: "Lilac", labGroup: "basic", coat: "#b29cde", cream: "#eee3ff", accent: "#7ae8ed" },
  { index: 6, id: "midnight", name: "Midnight", labGroup: "basic", coat: "#667baa", cream: "#c3d7f7", accent: "#b2a7ff" },
  { index: 7, id: "pearl", name: "Pearl", labGroup: "special", coat: "#e3e6f8", cream: "#ffffff", accent: "#9af5df" },
  { index: 8, id: "aurora", name: "Aurora", labGroup: "special", coat: "#8adcca", cream: "#f2e2ff", accent: "#f4a6e9" },
  { index: 9, id: "spectrum", name: "Spectrum", labGroup: "special", coat: "#c0a0ff", cream: "#f8eaff", accent: "#8ff6ff" },
] as const;

export const LED_ACCESSORIES: readonly AccessoryCatalogItem[] = [
  {
    index: 0,
    id: "lumen-clasp",
    name: "Lumen clasp",
    labGroup: "basic",
    description: "A softly curved pearl blossom nestled between the front paws.",
  },
  {
    index: 1,
    id: "aether-visor",
    name: "Aether visor",
    labGroup: "basic",
    description: "A panoramic iridescent shield with recessed optics and a light ribbon.",
  },
  {
    index: 2,
    id: "petal-mitts",
    name: "Petal mitts",
    labGroup: "basic",
    description: "Soft pearl fingerless mitts fitted to the actual paw contours.",
  },
  {
    index: 3,
    id: "auricle-clip",
    name: "Auricle clip",
    labGroup: "basic",
    description: "A bold titanium receiver clasp following the outer ear.",
  },
  {
    index: 4,
    id: "holo-lenses",
    name: "Holo lenses",
    labGroup: "basic",
    description: "Rimless smoke lenses, floating HUD corners and slim temple links.",
  },
  {
    index: 5,
    id: "bio-link-wraps",
    name: "Bio-link wraps",
    labGroup: "basic",
    description: "Light satin wrist wraps with a fine luminous seam.",
  },
  {
    index: 6,
    id: "companion-orbs",
    name: "Companion orbs",
    labGroup: "basic",
    description: "Two pearl sensor companions hovering beside the creature.",
  },
  {
    index: 7,
    id: "eclipse-mask",
    name: "Eclipse mask",
    labGroup: "special",
    description: "A sculpted prism masquerade with open eyes and sweeping ceramic crests.",
  },
  {
    index: 8,
    id: "prism-sanctuary",
    name: "Prism sanctuary",
    labGroup: "special",
    description: "A floating pearl orbit with six delicate luminous crystals.",
  },
  {
    index: 9,
    id: "aurora-bloom",
    name: "Aurora bloom",
    labGroup: "special",
    description: "An eleven-petal luminous lotus unfolding behind the creature.",
  },
] as const;

export const LED_BACKGROUNDS: readonly BackgroundCatalogItem[] = [
  {
    index: 0,
    id: "mosslight-grove",
    name: "Mosslight Grove",
    labGroup: "basic",
    color: "#6bc4a2",
    description: "A quiet fern grove with mint bioluminescent moss.",
    file: "backgrounds/led/mosslight-grove.png",
  },
  {
    index: 1,
    id: "tidalglass-cove",
    name: "Tidalglass Cove",
    labGroup: "basic",
    color: "#63bde1",
    description: "Turquoise water and sea-glass rocks in a secluded cove.",
    file: "backgrounds/led/tidalglass-cove.png",
  },
  {
    index: 2,
    id: "lavender-conservatory",
    name: "Lavender Conservatory",
    labGroup: "basic",
    color: "#b29adf",
    description: "A violet glasshouse sheltering luminous biotech flowers.",
    file: "backgrounds/led/lavender-conservatory.png",
  },
  {
    index: 3,
    id: "peach-cloud-terrace",
    name: "Peach Cloud Terrace",
    labGroup: "basic",
    color: "#efa88b",
    description: "A warm garden terrace drifting above peach dusk clouds.",
    file: "backgrounds/led/peach-cloud-terrace.png",
  },
  {
    index: 4,
    id: "moonseed-orchard",
    name: "Moonseed Orchard",
    labGroup: "basic",
    color: "#8c9dd7",
    description: "Silver seed lanterns in a moonlit indigo orchard.",
    file: "backgrounds/led/moonseed-orchard.png",
  },
  {
    index: 5,
    id: "amber-mycelium",
    name: "Amber Mycelium",
    labGroup: "basic",
    color: "#d9ae63",
    description: "Golden mushroom lanterns beneath a bronze forest canopy.",
    file: "backgrounds/led/amber-mycelium.png",
  },
  {
    index: 6,
    id: "rainlit-canopy",
    name: "Rainlit Canopy",
    labGroup: "basic",
    color: "#6aaeb4",
    description: "A rain-washed canopy with cyan droplets and blue foliage.",
    file: "backgrounds/led/rainlit-canopy.png",
  },
  {
    index: 7,
    id: "aurora-nexus",
    name: "Aurora Nexus",
    labGroup: "special",
    color: "#80edd7",
    description: "Special I · Sweeping auroras above a floating biosphere.",
    file: "backgrounds/led/aurora-nexus.png",
  },
  {
    index: 8,
    id: "prism-cathedral",
    name: "Prism Cathedral",
    labGroup: "special",
    color: "#c6b1ff",
    description: "Special II · An iridescent cathedral grown from living crystal.",
    file: "backgrounds/led/prism-cathedral.png",
  },
  {
    index: 9,
    id: "celestial-bloom",
    name: "Celestial Bloom",
    labGroup: "apex",
    color: "#f7d6a3",
    description: "Special III · Apex · A celestial lotus opening across a star-born garden.",
    file: "backgrounds/led/celestial-bloom.png",
  },
] as const;

export const LED_REGION_LABELS = [
  "Head · ears, cheeks & face",
  "Middle · chest, shoulders & forepaws",
  "Lower · belly, hips, rear coat & feet",
] as const;

export const LED_STAGE_DESCRIPTIONS: readonly (readonly string[])[] = [
  [
    "Soft receiver ears",
    "Receiver ridges emerging",
    "First receiver chambers",
    "Inner ear layers",
    "Split receiver lobes",
    "Layered mature ears",
    "Cheek ruff developing",
    "Receiver light channels",
    "Full sensory ruff",
    "Pearl ear edging",
    "Complete receiver structure",
  ],
  [
    "Soft chest & shoulders",
    "Chest tuft emerging",
    "First collar layers",
    "Chest markings emerging",
    "Layered chest markings",
    "Sculpted shoulder coat",
    "Layered chest ruff",
    "Pearl shoulder accents",
    "Mature shoulder ruff",
    "Chest light crest",
    "Complete chest & shoulders",
  ],
  [
    "Rounded belly & hips",
    "Pearl paw edging",
    "Rear coat layers",
    "Belly markings emerging",
    "Layered belly markings",
    "Belly coat & luminous pads",
    "Pearl hip layers",
    "Short mature tail",
    "Full belly & rear coat",
    "Belly crest & paw lights",
    "Complete belly, rear coat & paws",
  ],
] as const;

export interface RareWindowScheduleConfig {
  /** Step indices (0-based within the day) where the first 4-point item opens (max 3/day). */
  rare4A: { itemIndex: number; dailySteps: readonly number[] };
  /** Step indices (0-based within the day) where the second 4-point item opens (max 3/day). */
  rare4B: { itemIndex: number; dailySteps: readonly number[] };
  /** Step indices (0-based within the day) where the 8-point item opens (max 2/day). */
  apex8: { itemIndex: number; dailySteps: readonly number[] };
  /** Ordered list of the 7 ordinary item indices (4x1pt + 3x2pt) rotated on non-rare steps. */
  ordinaryCycle: readonly number[];
}

export interface SybilEligibilityPolicy {
  enabled: boolean;
  network: "ethereum-mainnet" | "sepolia" | "unconfigured";
  minTxCount: number;
  minWalletAgeDays: number;
  ageAnchor: "undecided";
  note: string;
}

export interface WalletEligibilityContext {
  txCount?: number;
  walletAgeDays?: number;
}

export interface WalletEligibilityResult {
  eligible: boolean;
  policyEnabled: boolean;
  code: "ELIGIBILITY_DISABLED_ALLOW_ALL" | "ELIGIBLE" | "INELIGIBLE_TX_COUNT" | "INELIGIBLE_WALLET_AGE";
  reason: string;
  checkedAt: string;
}

export interface BackgroundCalibrationProfile {
  readonly id: string;
  readonly isExperimental: true;
  readonly referenceDistanceMm: number;
  readonly referenceWorkUnits: number;
}

export const DEFAULT_BACKGROUND_CALIBRATION_PROFILE: BackgroundCalibrationProfile = {
  id: "codex-calibration-5km-5694w",
  isExperimental: true,
  referenceDistanceMm: 5_000_000,
  referenceWorkUnits: 5_694,
};

export interface DerivedBackgroundRarityModel {
  readonly calibrationProfile: BackgroundCalibrationProfile;
  readonly paletteTotalWindows: number;
  readonly accessoryTotalWindows: number;
  readonly paletteTierCounts: Record<TraitPoints, number>;
  readonly accessoryTierCounts: Record<TraitPoints, number>;
  readonly tierProbabilities: Record<TraitPoints, number>;
  readonly backgroundWeights: number[];
  readonly totalWeight: number;
}

export interface GamePolicy {
  version: string;
  experimental: boolean;
  releaseBlocked: boolean;
  label: string;
  durationSeconds: number;
  baseLampPower: number;
  fullPowerRpm: number;
  fullDoseSecondsPerRegion: number;
  maxRegionLevel: number;
  accessoryWorkStep: bigint;
  paletteDistanceStepMm: number;
  maxRare4WindowsPerDayEach: number;
  maxApex8WindowsPerDay: number;
  palettePoints: readonly TraitPoints[];
  accessoryPoints: readonly TraitPoints[];
  backgroundPoints: readonly TraitPoints[];
  paletteSchedule: RareWindowScheduleConfig;
  accessorySchedule: RareWindowScheduleConfig;
  backgroundWeights: readonly number[];
  calibrationProfile?: BackgroundCalibrationProfile;
  leaderboardLimit: number;
  rankingFormula: "best_character_weekly";
  tieBreakOrder: readonly ["totalScore_desc", "regionScore_desc", "completedAt_asc", "resultId_asc"];
  sybilPolicy: SybilEligibilityPolicy;
  experimentalAssumptions: readonly string[];
  specialScheduleStrategy?: "fixed_step" | "strata_time_openings";
  dailySavedPlaysAllowance?: number;
  /** Cap on observation/receipt validity (ms). V1/V2: 15s; V3+: honor declared TTL up to 120s. */
  observationValidityCapMs: number;
  /** Manual Pause/Resume allowed (legacy). Current rules disallow pause-farming. */
  allowsManualPause: boolean;
  /** Restart/disconnect clears locked palette/accessory (current rules). */
  clearLocksOnRestart: boolean;
  /** Heartbeat/activity gap resets the attempt instead of pausing with locks retained. */
  activityGapResetsAttempt: boolean;
}

/**
 * Validates that a 10-item point array follows the confirmed 4-3-2-1 rarity distribution:
 * 4 items x 1 point, 3 items x 2 points, 2 items x 4 points, 1 item x 8 points.
 */
export function assertValid4321Points(points: readonly number[], categoryName: string): void {
  if (points.length !== 10) {
    throw new Error(`${categoryName} must have exactly 10 items (got ${points.length})`);
  }
  const counts = { 1: 0, 2: 0, 4: 0, 8: 0 };
  for (const p of points) {
    if (p !== 1 && p !== 2 && p !== 4 && p !== 8) {
      throw new Error(`${categoryName} contains invalid point value ${p}; allowed: 1, 2, 4, 8`);
    }
    counts[p]++;
  }
  if (counts[1] !== 4 || counts[2] !== 3 || counts[4] !== 2 || counts[8] !== 1) {
    throw new Error(
      `${categoryName} must follow 4x1pt, 3x2pt, 2x4pt, 1x8pt distribution; got ${JSON.stringify(counts)}`,
    );
  }
}

export function assertValidRareSchedule(
  schedule: RareWindowScheduleConfig,
  points: readonly TraitPoints[],
  categoryName: string,
): void {
  if (schedule.rare4A.dailySteps.length > 3) {
    throw new Error(`${categoryName} rare4A exceeds max 3 windows/day`);
  }
  if (schedule.rare4B.dailySteps.length > 3) {
    throw new Error(`${categoryName} rare4B exceeds max 3 windows/day`);
  }
  if (schedule.apex8.dailySteps.length > 2) {
    throw new Error(`${categoryName} apex8 exceeds max 2 windows/day`);
  }
  if (points[schedule.rare4A.itemIndex] !== 4 || points[schedule.rare4B.itemIndex] !== 4) {
    throw new Error(`${categoryName} 4-point schedule items must have 4 points in tier mapping`);
  }
  if (points[schedule.apex8.itemIndex] !== 8) {
    throw new Error(`${categoryName} 8-point schedule item must have 8 points in tier mapping`);
  }
  const seenSteps = new Set<number>();
  for (const step of [
    ...schedule.rare4A.dailySteps,
    ...schedule.rare4B.dailySteps,
    ...schedule.apex8.dailySteps,
  ]) {
    if (!Number.isInteger(step) || step < 0) {
      throw new Error(`${categoryName} rare window step must be a non-negative integer`);
    }
    if (seenSteps.has(step)) {
      throw new Error(`${categoryName} has overlapping rare window at step ${step}`);
    }
    seenSteps.add(step);
  }
}

export const EXPERIMENTAL_POLICY_V1: GamePolicy = {
  version: "exp-v1-2026-11-06",
  experimental: true,
  releaseBlocked: true,
  label: "Experimental Preset v1 (2026-11-06) — Open parameters pending product sign-off",
  durationSeconds: 60,
  baseLampPower: 0.4,
  fullPowerRpm: 65,
  fullDoseSecondsPerRegion: 19,
  maxRegionLevel: 10,
  accessoryWorkStep: 100n,
  paletteDistanceStepMm: 100_000, // 100 m
  maxRare4WindowsPerDayEach: 3,
  maxApex8WindowsPerDay: 2,
  // 4 x 1pt (indices 0..3), 3 x 2pt (indices 4..6), 2 x 4pt (indices 7..8), 1 x 8pt (index 9)
  palettePoints: [1, 1, 1, 1, 2, 2, 2, 4, 4, 8],
  accessoryPoints: [1, 1, 1, 1, 2, 2, 2, 4, 4, 8],
  backgroundPoints: [1, 1, 1, 1, 2, 2, 2, 4, 4, 8],
  paletteSchedule: {
    // 100m steps per measurement day:
    // Pearl (4pt): steps 3, 10, 17 (300m, 1000m, 1700m) -> max 3 windows/day
    // Aurora (4pt): steps 6, 13, 20 (600m, 1300m, 2000m) -> max 3 windows/day
    // Spectrum (8pt): steps 8, 22 (800m, 2200m) -> max 2 windows/day
    rare4A: { itemIndex: 7, dailySteps: [3, 10, 17] },
    rare4B: { itemIndex: 8, dailySteps: [6, 13, 20] },
    apex8: { itemIndex: 9, dailySteps: [8, 22] },
    ordinaryCycle: [0, 1, 2, 3, 4, 5, 6],
  },
  accessorySchedule: {
    // 100-work-unit steps per measurement day:
    // Eclipse mask (4pt): buckets 4, 11, 18 (400, 1100, 1800 units) -> max 3 windows/day
    // Prism sanctuary (4pt): buckets 7, 14, 21 (700, 1400, 2100 units) -> max 3 windows/day
    // Aurora bloom (8pt): buckets 9, 23 (900, 2300 units) -> max 2 windows/day
    rare4A: { itemIndex: 7, dailySteps: [4, 11, 18] },
    rare4B: { itemIndex: 8, dailySteps: [7, 14, 21] },
    apex8: { itemIndex: 9, dailySteps: [9, 23] },
    ordinaryCycle: [0, 1, 2, 3, 4, 5, 6],
  },
  // Experimental background random weights (sum = 1000):
  // 4 x 1pt (150 each = 60%), 3 x 2pt (90 each = 27%), 2 x 4pt (50 each = 10%), 1 x 8pt (30 = 3%)
  backgroundWeights: [150, 150, 150, 150, 90, 90, 90, 50, 50, 30],
  leaderboardLimit: 100,
  rankingFormula: "best_character_weekly",
  tieBreakOrder: ["totalScore_desc", "regionScore_desc", "completedAt_asc", "resultId_asc"],
  sybilPolicy: {
    enabled: false,
    network: "unconfigured",
    minTxCount: 0,
    minWalletAgeDays: 0,
    ageAnchor: "undecided",
    note: "Sybil filtering by Ethereum transaction history and wallet age is deferred and disabled by default.",
  },
  observationValidityCapMs: 15_000,
  allowsManualPause: true,
  clearLocksOnRestart: false,
  activityGapResetsAttempt: false,
  experimentalAssumptions: [
    "Incubation duration (60s), base lamp power (40% at 0 RPM), full lamp power threshold (65 RPM), and full regional dose (19s at 100% power for Lv10) are working preset values pending final sign-off.",
    "Specific item-to-point-tier assignments within the confirmed 4x1pt, 3x2pt, 2x4pt, 1x8pt distribution are experimental.",
    "Daily rare window step thresholds (Pearl at 300/1000/1700m, Aurora at 600/1300/2000m, Spectrum at 800/2200m; Eclipse mask at 400/1100/1800 work units, Prism sanctuary at 700/1400/2100, Aurora bloom at 900/2300) and 1-step rare window length are experimental while enforcing the confirmed daily caps (max 3/day each for 4pt, max 2/day for 8pt).",
    "Background random probability weights (60% 1pt / 27% 2pt / 10% 4pt / 3% 8pt) are experimental.",
    "Weekly leaderboard aggregation (best character per wallet per ISO UTC week) and tie-breaking (higher total score, higher region score, earlier completion time) are experimental.",
    "Daily baseline persistence & mid-day cold-start policy: daily distance and dayStartWorkUnits are persisted in SQLite across server restarts; if a fresh database boots mid-day without having observed the preceding 12:00 UTC rollover (or if installationId/counterEpoch changes mid-day), dayStartWorkUnits re-anchors to preserve accrued daily work (starting at 0 daily work units on cold boot rather than treating lifetime cumulativeWorkUnits as single-day work).",
    "Ranked illumination heartbeat bound (20s max step) and independent telemetry freshness cap (min(15s, staleAfterSeconds)): ranked sessions advance only across verified server steps (<= 20,000 ms) while hardware telemetry is fresh (<= 15,000 ms) and auto-pause without backfilling if a tab is hidden, disconnected, or telemetry expires.",
  ],
};

function gcdInt(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y !== 0) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x || 1;
}

/**
 * Derives background tier probabilities P_background(t) = (P_palette(t) + P_accessory(t)) / 2
 * and uniform within-tier exact integer weights from opened appearance windows (steps 0..endStep)
 * under the supplied policy schedules and experimental calibration profile.
 */
export function deriveBackgroundRarityModel(
  policy: Pick<
    GamePolicy,
    | "paletteDistanceStepMm"
    | "accessoryWorkStep"
    | "palettePoints"
    | "accessoryPoints"
    | "backgroundPoints"
    | "paletteSchedule"
    | "accessorySchedule"
    | "calibrationProfile"
  > & {
    version?: string;
    specialScheduleStrategy?: "fixed_step" | "strata_time_openings";
  },
  profileOverride?: Pick<BackgroundCalibrationProfile, "referenceDistanceMm" | "referenceWorkUnits"> & {
    id?: string;
  },
): DerivedBackgroundRarityModel {
  const baseProfile = policy.calibrationProfile ?? DEFAULT_BACKGROUND_CALIBRATION_PROFILE;
  const calibrationProfile: BackgroundCalibrationProfile = profileOverride
    ? {
        id: profileOverride.id ?? "custom-calibration-profile",
        isExperimental: true,
        referenceDistanceMm: profileOverride.referenceDistanceMm,
        referenceWorkUnits: profileOverride.referenceWorkUnits,
      }
    : baseProfile;

  if (
    !Number.isSafeInteger(calibrationProfile.referenceDistanceMm) ||
    calibrationProfile.referenceDistanceMm < 0
  ) {
    throw new Error(
      `Invalid referenceDistanceMm (${calibrationProfile.referenceDistanceMm}); must be a non-negative safe integer.`,
    );
  }
  if (
    !Number.isSafeInteger(calibrationProfile.referenceWorkUnits) ||
    calibrationProfile.referenceWorkUnits < 0
  ) {
    throw new Error(
      `Invalid referenceWorkUnits (${calibrationProfile.referenceWorkUnits}); must be a non-negative safe integer.`,
    );
  }
  if (!Number.isFinite(policy.paletteDistanceStepMm) || policy.paletteDistanceStepMm <= 0) {
    throw new Error("paletteDistanceStepMm must be positive");
  }
  if (policy.accessoryWorkStep <= 0n) {
    throw new Error("accessoryWorkStep must be positive");
  }

  assertValid4321Points(policy.palettePoints, "palettePoints");
  assertValid4321Points(policy.accessoryPoints, "accessoryPoints");
  assertValid4321Points(policy.backgroundPoints, "backgroundPoints");

  const maxPaletteStep = Math.floor(
    calibrationProfile.referenceDistanceMm / policy.paletteDistanceStepMm,
  );
  const maxAccessoryStep = Number(
    BigInt(calibrationProfile.referenceWorkUnits) / policy.accessoryWorkStep,
  );

  const paletteTotalWindows = maxPaletteStep + 1;
  const accessoryTotalWindows = maxAccessoryStep + 1;
  if (paletteTotalWindows <= 0 || accessoryTotalWindows <= 0) {
    throw new Error("Calibration window count must be positive");
  }

  const isV3CountModel =
    policy.version === "exp-v3-2026-11-06" ||
    policy.specialScheduleStrategy === "strata_time_openings";

  if (isV3CountModel) {
    const R_pal = paletteTotalWindows; // 51 ordinary windows
    const R_acc = accessoryTotalWindows; // 57 ordinary windows
    const specialsCount = 8;
    const palDenom = R_pal + specialsCount; // 59
    const accDenom = R_acc + specialsCount; // 65
    const paletteTierCounts: Record<TraitPoints, number> = {
      1: (4 * R_pal) / 7,
      2: (3 * R_pal) / 7,
      4: 6,
      8: 2,
    };
    const accessoryTierCounts: Record<TraitPoints, number> = {
      1: (4 * R_acc) / 7,
      2: (3 * R_acc) / 7,
      4: 6,
      8: 2,
    };
    const tiers: readonly TraitPoints[] = [1, 2, 4, 8];
    const tierProbabilities: Record<TraitPoints, number> = { 1: 0, 2: 0, 4: 0, 8: 0 };
    for (const t of tiers) {
      const pPal = paletteTierCounts[t] / palDenom;
      const pAcc = accessoryTierCounts[t] / accDenom;
      tierProbabilities[t] = (pPal + pAcc) / 2;
    }
    const tierWeightsPerItem: Record<TraitPoints, number> = {
      1: 3339,
      2: 3339,
      4: 1302,
      8: 868,
    };
    const backgroundWeights = policy.backgroundPoints.map((pts) => tierWeightsPerItem[pts]);
    const totalWeight = backgroundWeights.reduce((acc, w) => acc + w, 0);
    return {
      calibrationProfile,
      paletteTotalWindows: palDenom,
      accessoryTotalWindows: accDenom,
      paletteTierCounts,
      accessoryTierCounts,
      tierProbabilities,
      backgroundWeights,
      totalWeight,
    };
  }

  const paletteTierCounts: Record<TraitPoints, number> = { 1: 0, 2: 0, 4: 0, 8: 0 };
  for (let s = 0; s <= maxPaletteStep; s++) {
    const { itemIndex } = itemIndexAtDailyStep(BigInt(s), policy.paletteSchedule);
    const pts = policy.palettePoints[itemIndex];
    paletteTierCounts[pts]++;
  }

  const accessoryTierCounts: Record<TraitPoints, number> = { 1: 0, 2: 0, 4: 0, 8: 0 };
  for (let s = 0; s <= maxAccessoryStep; s++) {
    const { itemIndex } = itemIndexAtDailyStep(BigInt(s), policy.accessorySchedule);
    const pts = policy.accessoryPoints[itemIndex];
    accessoryTierCounts[pts]++;
  }

  const tiers: readonly TraitPoints[] = [1, 2, 4, 8];
  const tierProbabilities: Record<TraitPoints, number> = { 1: 0, 2: 0, 4: 0, 8: 0 };
  let probSum = 0;
  for (const t of tiers) {
    const pPal = paletteTierCounts[t] / paletteTotalWindows;
    const pAcc = accessoryTierCounts[t] / accessoryTotalWindows;
    const pBg = (pPal + pAcc) / 2;
    tierProbabilities[t] = pBg;
    probSum += pBg;
  }
  if (Math.abs(probSum - 1) > 1e-9) {
    throw new Error(`Derived background tier probabilities do not sum to 1 (got ${probSum})`);
  }

  // Canonical integer denominator = 2 * lcm(paletteTotalWindows, accessoryTotalWindows) * lcm(4,3,2,1)
  const bgTierItemCounts: Record<TraitPoints, number> = { 1: 4, 2: 3, 4: 2, 8: 1 };
  const windowGcd = gcdInt(paletteTotalWindows, accessoryTotalWindows);
  const palScale = accessoryTotalWindows / windowGcd;
  const accScale = paletteTotalWindows / windowGcd;
  const backgroundWeights = policy.backgroundPoints.map((pts) => {
    const tierNumerator =
      paletteTierCounts[pts] * palScale + accessoryTierCounts[pts] * accScale;
    const itemMultiplier = 12 / bgTierItemCounts[pts];
    return Math.round(tierNumerator * itemMultiplier);
  });
  const totalWeight = backgroundWeights.reduce((acc, w) => acc + w, 0);
  if (totalWeight <= 0) {
    throw new Error("Total derived background weight must be positive");
  }

  return {
    calibrationProfile,
    paletteTotalWindows,
    accessoryTotalWindows,
    paletteTierCounts,
    accessoryTierCounts,
    tierProbabilities,
    backgroundWeights,
    totalWeight,
  };
}

const V2_BASE_CONFIG = {
  ...EXPERIMENTAL_POLICY_V1,
  version: "exp-v2-2026-11-06",
  label:
    "Experimental Preset v2 (2026-11-06) — Midpoint background rarity & aesthetic tier mapping",
  // Confirmed aesthetic 4-3-2-1 background point mapping by existing index:
  // 8pt: Celestial Bloom (9)
  // 4pt: Aurora Nexus (7), Prism Cathedral (8)
  // 2pt: Tidalglass Cove (1), Lavender Conservatory (2), Moonseed Orchard (4)
  // 1pt: Mosslight Grove (0), Peach Cloud Terrace (3), Amber Mycelium (5), Rainlit Canopy (6)
  backgroundPoints: [1, 2, 2, 1, 2, 1, 1, 4, 4, 8] as const,
  calibrationProfile: DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
};

const V2_DERIVED_MODEL = deriveBackgroundRarityModel(
  V2_BASE_CONFIG,
  DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
);

export const EXPERIMENTAL_POLICY_V2: GamePolicy = {
  ...V2_BASE_CONFIG,
  backgroundWeights: V2_DERIVED_MODEL.backgroundWeights,
  experimentalAssumptions: [
    "Incubation duration (60s), base lamp power (40% at 0 RPM), full lamp power threshold (65 RPM), and full regional dose (19s at 100% power for Lv10) are working preset values pending final sign-off.",
    "Background point mapping [1, 2, 2, 1, 2, 1, 1, 4, 4, 8] (Celestial Bloom = 8pt; Aurora Nexus & Prism Cathedral = 4pt; Tidalglass Cove, Lavender Conservatory & Moonseed Orchard = 2pt; Mosslight Grove, Peach Cloud Terrace, Amber Mycelium & Rainlit Canopy = 1pt) is an aesthetic rarity ordering within the 4-3-2-1 distribution.",
    "Background tier probabilities P_background(t) = (P_palette(t) + P_accessory(t)) / 2 (~49.0712% 1pt, ~36.0681% 2pt, ~11.1455% 4pt, ~3.7152% 8pt; uniform within each tier; exact integer weights [2853, 2796, 2796, 2853, 2796, 2853, 2853, 1296, 1296, 864] / 23,256) are derived from opened appearance windows under an experimental calibration profile (referenceDistanceMm = 5,000,000 / 51 windows, referenceWorkUnits = 5,694 / 57 windows). These reference numbers are a calibration profile, not a claim about actual daily hamster distance, work, or rest.",
    "Daily rare window step thresholds (Pearl at 300/1000/1700m, Aurora at 600/1300/2000m, Spectrum at 800/2200m; Eclipse mask at 400/1100/1800 work units, Prism sanctuary at 700/1400/2100, Aurora bloom at 900/2300) and 1-step rare window length are experimental while enforcing the confirmed daily caps (max 3/day each for 4pt, max 2/day for 8pt).",
    "Weekly leaderboard aggregation (best character per wallet per ISO UTC week) and tie-breaking (higher total score, higher region score, earlier completion time) are experimental.",
    "Daily baseline persistence & mid-day cold-start policy: daily distance and dayStartWorkUnits are persisted in SQLite across server restarts; if a fresh database boots mid-day without having observed the preceding 12:00 UTC rollover (or if installationId/counterEpoch changes mid-day), dayStartWorkUnits re-anchors to preserve accrued daily work (starting at 0 daily work units on cold boot rather than treating lifetime cumulativeWorkUnits as single-day work).",
    "Ranked illumination heartbeat bound (20s max step) and independent telemetry freshness cap (min(15s, staleAfterSeconds)): ranked sessions advance only across verified server steps (<= 20,000 ms) while hardware telemetry is fresh (<= 15,000 ms) and auto-pause without backfilling if a tab is hidden, disconnected, or telemetry expires.",
  ],
};

const V3_BASE_CONFIG: GamePolicy = {
  ...EXPERIMENTAL_POLICY_V2,
  version: "exp-v3-2026-11-06",
  label:
    "Experimental Preset v3 (2026-11-06) — Stratified time rare openings, appearance-count background rarity & 3 plays/day allowance",
  specialScheduleStrategy: "strata_time_openings",
  dailySavedPlaysAllowance: 3,
  calibrationProfile: DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
};

const V3_DERIVED_MODEL = deriveBackgroundRarityModel(
  V3_BASE_CONFIG,
  DEFAULT_BACKGROUND_CALIBRATION_PROFILE,
);

export const EXPERIMENTAL_POLICY_V3: GamePolicy = {
  ...V3_BASE_CONFIG,
  observationValidityCapMs: 120_000,
  allowsManualPause: true,
  clearLocksOnRestart: false,
  activityGapResetsAttempt: false,
  backgroundWeights: V3_DERIVED_MODEL.backgroundWeights,
  experimentalAssumptions: [
    "Incubation duration (60s), base lamp power (40% at 0 RPM), full lamp power threshold (65 RPM), and full regional dose (19s at 100% power for Lv10) are working preset values pending final sign-off.",
    "Background point mapping [1, 2, 2, 1, 2, 1, 1, 4, 4, 8] is an aesthetic rarity ordering within the 4-3-2-1 distribution.",
    "Background tier probabilities P_background(t) = (P_palette(t) + P_accessory(t)) / 2 (~49.7523% 1pt, ~37.3142% 2pt, ~9.7001% 4pt, ~3.2334% 8pt; uniform within each tier; exact integer weights [3339, 3339, 3339, 3339, 3339, 3339, 3339, 1302, 1302, 868] / 26,845) are derived from appearance counts under the experimental calibration profile (5,000,000 mm / 51 ordinary windows + 8 specials; 5,694 work units / 57 ordinary windows + 8 specials).",
    "Trait transitions: ordinary candidates advance per 100m accepted progress / 100 accepted work units, sampled from 0..6 without adjacent repeats; specials appear via 8 private time openings per category per UTC day distributed across eight 3-hour strata with a 2/3/3 bag without adjacent identical specials.",
    "Allowance: 3 saved ranked plays per wallet per UTC calendar day (00:00 UTC). Unfinished plays may restart from zero on the same egg without consuming allowance or rerolling traits.",
    "Single background producer per server (~3s interval) with shared cache; observation TTL honored up to 120s; ACTIVE > 15s drops high power with speed-unavailable state.",
  ],
};

const V4_BASE_CONFIG: GamePolicy = {
  ...EXPERIMENTAL_POLICY_V3,
  version: "exp-v4-2026-11-06",
  label:
    "Experimental Preset v4 (2026-11-06) — No manual pause; reset/disconnect clears trait locks; activity-gap resets attempt",
  observationValidityCapMs: 120_000,
  allowsManualPause: false,
  clearLocksOnRestart: true,
  activityGapResetsAttempt: true,
};

export const EXPERIMENTAL_POLICY_V4: GamePolicy = {
  ...V4_BASE_CONFIG,
  experimentalAssumptions: [
    ...EXPERIMENTAL_POLICY_V3.experimentalAssumptions.filter(
      (line) => !line.startsWith("Allowance:"),
    ),
    "Allowance: 3 saved ranked plays per wallet per UTC calendar day (00:00 UTC). Restarting an unfinished attempt keeps the same egg/species, clears elapsed growth and palette/accessory locks, and relocks the current server-approved pair on the next first light.",
    "No manual Pause/Resume. Activity/heartbeat gaps and disconnects reset the unfinished attempt (clearing rare locks) rather than preserving a paused farm. Completed results remain terminal.",
  ],
};

export const DEFAULT_GAME_POLICY: GamePolicy = EXPERIMENTAL_POLICY_V4;
export const LATEST_GAME_POLICY: GamePolicy = EXPERIMENTAL_POLICY_V4;

export function validateGamePolicy(policy: GamePolicy): GamePolicy {
  assertValid4321Points(policy.palettePoints, "palettePoints");
  assertValid4321Points(policy.accessoryPoints, "accessoryPoints");
  assertValid4321Points(policy.backgroundPoints, "backgroundPoints");
  assertValidRareSchedule(policy.paletteSchedule, policy.palettePoints, "paletteSchedule");
  assertValidRareSchedule(policy.accessorySchedule, policy.accessoryPoints, "accessorySchedule");
  if (policy.accessoryWorkStep <= 0n) {
    throw new Error("accessoryWorkStep must be positive");
  }
  if (policy.paletteDistanceStepMm <= 0) {
    throw new Error("paletteDistanceStepMm must be positive");
  }
  if (policy.backgroundWeights.length !== 10) {
    throw new Error("backgroundWeights must have 10 entries");
  }
  const weightSum = policy.backgroundWeights.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(weightSum) || weightSum <= 0) {
    throw new Error("backgroundWeights must sum to a positive finite number");
  }
  if (policy.calibrationProfile) {
    const derived = deriveBackgroundRarityModel(policy, policy.calibrationProfile);
    if (
      derived.backgroundWeights.length !== policy.backgroundWeights.length ||
      derived.backgroundWeights.some((w, idx) => w !== policy.backgroundWeights[idx])
    ) {
      throw new Error(
        `Policy ${policy.version} backgroundWeights do not match calibrationProfile ${policy.calibrationProfile.id}`,
      );
    }
  }
  return policy;
}

validateGamePolicy(EXPERIMENTAL_POLICY_V1);
validateGamePolicy(EXPERIMENTAL_POLICY_V2);
validateGamePolicy(EXPERIMENTAL_POLICY_V3);
validateGamePolicy(EXPERIMENTAL_POLICY_V4);

export const KNOWN_GAME_POLICIES: Readonly<Record<string, GamePolicy>> = Object.freeze({
  [EXPERIMENTAL_POLICY_V1.version]: EXPERIMENTAL_POLICY_V1,
  [EXPERIMENTAL_POLICY_V2.version]: EXPERIMENTAL_POLICY_V2,
  [EXPERIMENTAL_POLICY_V3.version]: EXPERIMENTAL_POLICY_V3,
  [EXPERIMENTAL_POLICY_V4.version]: EXPERIMENTAL_POLICY_V4,
});

export function resolveKnownGamePolicy(version: string): GamePolicy | null {
  return KNOWN_GAME_POLICIES[version] ?? null;
}

export function createCalibratedPolicyRevision(
  basePolicy: GamePolicy,
  newVersion: string,
  calibrationProfile: BackgroundCalibrationProfile,
): GamePolicy {
  if (!newVersion || !newVersion.trim() || newVersion === basePolicy.version) {
    throw new Error("Calibrated policy revision requires a distinct non-empty version string");
  }
  const derived = deriveBackgroundRarityModel(basePolicy, calibrationProfile);
  const nextPolicy: GamePolicy = {
    ...basePolicy,
    version: newVersion.trim(),
    calibrationProfile: derived.calibrationProfile,
    backgroundWeights: derived.backgroundWeights,
  };
  return validateGamePolicy(nextPolicy);
}

export function rarityTierForPoints(points: TraitPoints): RarityTier {
  if (points === 8) return "apex-8";
  if (points === 4) return "rare-4";
  if (points === 2) return "uncommon-2";
  return "common-1";
}

export function familyByIndex(index: number): FamilyCatalogItem {
  return FAMILIES[index] ?? FAMILIES[0];
}

export function familyById(id: string): FamilyCatalogItem | null {
  return FAMILIES.find((f) => f.id === id.toLowerCase()) ?? null;
}

export function paletteByIndex(index: number): PaletteCatalogItem {
  return PALETTES[index] ?? PALETTES[0];
}

export function accessoryByIndex(index: number): AccessoryCatalogItem {
  return LED_ACCESSORIES[index] ?? LED_ACCESSORIES[0];
}

export function backgroundByIndex(index: number): BackgroundCatalogItem {
  return LED_BACKGROUNDS[index] ?? LED_BACKGROUNDS[0];
}

// ---------- Trait Schedule Evaluation (100 work units / 100 m) ----------

export interface ScheduleWindowState<T> {
  step: bigint;
  itemIndex: number;
  item: T;
  points: TraitPoints;
  tier: RarityTier;
  isRareWindow: boolean;
  remainingInStep: number | bigint;
  nextItemIndex: number;
  nextItem: T;
  nextPoints: TraitPoints;
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

function itemIndexAtDailyStep(
  dailyStep: bigint,
  schedule: RareWindowScheduleConfig,
): { itemIndex: number; isRare: boolean } {
  if (dailyStep < 0n) {
    throw new RangeError("dailyStep must be non-negative");
  }
  // Rare windows only occur at relatively small non-negative integer steps within a day.
  if (dailyStep <= BigInt(Number.MAX_SAFE_INTEGER)) {
    const stepNum = Number(dailyStep);
    if (schedule.rare4A.dailySteps.includes(stepNum)) {
      return { itemIndex: schedule.rare4A.itemIndex, isRare: true };
    }
    if (schedule.rare4B.dailySteps.includes(stepNum)) {
      return { itemIndex: schedule.rare4B.itemIndex, isRare: true };
    }
    if (schedule.apex8.dailySteps.includes(stepNum)) {
      return { itemIndex: schedule.apex8.itemIndex, isRare: true };
    }
  }
  // Count how many rare windows have already occurred strictly before `dailyStep`
  // so the 7 ordinary items cycle in exact order without skipping an ordinary item when a rare window appears!
  let rareBefore = 0n;
  for (const s of schedule.rare4A.dailySteps) {
    if (BigInt(s) < dailyStep) rareBefore++;
  }
  for (const s of schedule.rare4B.dailySteps) {
    if (BigInt(s) < dailyStep) rareBefore++;
  }
  for (const s of schedule.apex8.dailySteps) {
    if (BigInt(s) < dailyStep) rareBefore++;
  }
  const ordinaryStep = dailyStep - rareBefore;
  const cycleLen = BigInt(schedule.ordinaryCycle.length);
  const idx = Number(((ordinaryStep % cycleLen) + cycleLen) % cycleLen);
  return { itemIndex: schedule.ordinaryCycle[idx], isRare: false };
}

function countRareWindowsOpenedThroughStep(
  dailyStep: bigint,
  schedule: RareWindowScheduleConfig,
) {
  const countUpTo = (steps: readonly number[]) =>
    steps.filter((s) => BigInt(s) <= dailyStep).length;
  const rare4A = countUpTo(schedule.rare4A.dailySteps);
  const rare4B = countUpTo(schedule.rare4B.dailySteps);
  const apex8 = countUpTo(schedule.apex8.dailySteps);
  return {
    rare4A,
    rare4B,
    apex8,
    totalRare: rare4A + rare4B + apex8,
  };
}

/**
 * Palette schedule driven by hardware distanceMm (100 m = 100,000 mm steps).
 * Resets daily with distanceMm at 12:00 UTC (19:00 Asia/Saigon).
 */
export function paletteScheduleAt(
  distanceMm: number,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): ScheduleWindowState<PaletteCatalogItem> {
  if (!Number.isFinite(distanceMm) || distanceMm < 0) {
    throw new RangeError("distanceMm must be a non-negative finite number");
  }
  const stepMm = policy.paletteDistanceStepMm;
  const step = BigInt(Math.floor(distanceMm / stepMm));
  const current = itemIndexAtDailyStep(step, policy.paletteSchedule);
  const next = itemIndexAtDailyStep(step + 1n, policy.paletteSchedule);
  const points = policy.palettePoints[current.itemIndex];
  const nextPoints = policy.palettePoints[next.itemIndex];
  const remainingMm = stepMm - (distanceMm % stepMm);
  return {
    step,
    itemIndex: current.itemIndex,
    item: paletteByIndex(current.itemIndex),
    points,
    tier: rarityTierForPoints(points),
    isRareWindow: current.isRare,
    remainingInStep: Number((remainingMm / 1000).toFixed(3)), // meters remaining
    nextItemIndex: next.itemIndex,
    nextItem: paletteByIndex(next.itemIndex),
    nextPoints,
    dailyRareWindowsOpened: countRareWindowsOpenedThroughStep(step, policy.paletteSchedule),
    dailyRareCaps: {
      rare4A: policy.paletteSchedule.rare4A.dailySteps.length,
      rare4B: policy.paletteSchedule.rare4B.dailySteps.length,
      apex8: policy.paletteSchedule.apex8.dailySteps.length,
    },
  };
}

/**
 * Accessory schedule driven by hardware cumulativeWorkUnits (100 work unit steps).
 * `dayStartWork` is the work baseline at the start of the current measurement day (defaults to 0n).
 */
export function accessoryScheduleAt(
  work: bigint,
  dayStartWork: bigint = 0n,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): ScheduleWindowState<AccessoryCatalogItem> {
  if (work < 0n) {
    throw new RangeError("work must be non-negative");
  }
  const effectiveDayStart = dayStartWork >= 0n && dayStartWork <= work ? dayStartWork : 0n;
  const dailyWork = work - effectiveDayStart;
  const stepSize = policy.accessoryWorkStep;
  const step = dailyWork / stepSize;
  const current = itemIndexAtDailyStep(step, policy.accessorySchedule);
  const next = itemIndexAtDailyStep(step + 1n, policy.accessorySchedule);
  const points = policy.accessoryPoints[current.itemIndex];
  const nextPoints = policy.accessoryPoints[next.itemIndex];
  const remainingUnits = stepSize - (dailyWork % stepSize);
  return {
    step,
    itemIndex: current.itemIndex,
    item: accessoryByIndex(current.itemIndex),
    points,
    tier: rarityTierForPoints(points),
    isRareWindow: current.isRare,
    remainingInStep: remainingUnits,
    nextItemIndex: next.itemIndex,
    nextItem: accessoryByIndex(next.itemIndex),
    nextPoints,
    dailyRareWindowsOpened: countRareWindowsOpenedThroughStep(step, policy.accessorySchedule),
    dailyRareCaps: {
      rare4A: policy.accessorySchedule.rare4A.dailySteps.length,
      rare4B: policy.accessorySchedule.rare4B.dailySteps.length,
      apex8: policy.accessorySchedule.apex8.dailySteps.length,
    },
  };
}

// ---------- Lamp Power, Regional Dose & Levels 0-10 ----------

export function ledLampPower(
  rpm: number,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): number {
  const safeRpm = Number.isFinite(rpm) && rpm > 0 ? rpm : 0;
  return (
    policy.baseLampPower +
    (1 - policy.baseLampPower) * clamp(safeRpm / policy.fullPowerRpm, 0, 1)
  );
}

export function continuousRegionLevel(
  dose: number,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): number {
  if (!Number.isFinite(dose) || dose <= 0) return 0;
  return clamp(
    (dose / policy.fullDoseSecondsPerRegion) * policy.maxRegionLevel,
    0,
    policy.maxRegionLevel,
  );
}

export function integerRegionLevel(
  dose: number,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): number {
  const raw = continuousRegionLevel(dose, policy);
  return Math.min(policy.maxRegionLevel, Math.floor(raw + 1e-9));
}

// ---------- Server-Authoritative Random Background ----------

export function pickRandomBackgroundIndex(
  policy: GamePolicy = DEFAULT_GAME_POLICY,
  randomInt: (max: number) => number = defaultCsprngInt,
): number {
  const weights = policy.backgroundWeights;
  const totalWeight = weights.reduce((acc, w) => acc + Math.max(0, w), 0);
  if (totalWeight <= 0) return 0;
  const roll = clamp(randomInt(totalWeight), 0, totalWeight - 1);
  let cumulative = 0;
  for (let i = 0; i < weights.length; i++) {
    cumulative += Math.max(0, weights[i]);
    if (roll < cumulative) return i;
  }
  return weights.length - 1;
}

// ---------- Scoring ----------

export interface ScoreBreakdown {
  head: number;
  middle: number;
  lower: number;
  regionsTotal: number;
  palette: TraitPoints;
  accessory: TraitPoints;
  background: TraitPoints;
  total: number;
}

export function calculateScoreBreakdown(
  levels: readonly [number, number, number],
  paletteIndex: number,
  accessoryIndex: number,
  backgroundIndex: number,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
): ScoreBreakdown {
  const head = clamp(Math.floor(levels[0]), 0, policy.maxRegionLevel);
  const middle = clamp(Math.floor(levels[1]), 0, policy.maxRegionLevel);
  const lower = clamp(Math.floor(levels[2]), 0, policy.maxRegionLevel);
  const regionsTotal = head + middle + lower;
  const palette = policy.palettePoints[paletteIndex] ?? 1;
  const accessory = policy.accessoryPoints[accessoryIndex] ?? 1;
  const background = policy.backgroundPoints[backgroundIndex] ?? 1;
  return {
    head,
    middle,
    lower,
    regionsTotal,
    palette,
    accessory,
    background,
    total: regionsTotal + palette + accessory + background,
  };
}

/** Concise Docs rows: named items grouped by the active policy point arrays (not invented names). */
export function catalogPointRowsFromPolicy(
  items: readonly { name: string }[],
  points: readonly number[],
): { points: number; label: string; names: string[] }[] {
  const buckets = new Map<number, string[]>();
  for (let i = 0; i < items.length; i++) {
    const pts = Number(points[i] ?? 1);
    const list = buckets.get(pts) ?? [];
    list.push(items[i]!.name);
    buckets.set(pts, list);
  }
  return [1, 2, 4, 8]
    .filter((pts) => (buckets.get(pts)?.length ?? 0) > 0)
    .map((pts) => ({
      points: pts,
      label: pts === 1 ? "1 pt" : `${pts} pts`,
      names: buckets.get(pts) ?? [],
    }));
}

// ---------- Game Week Key (Separate from 12:00 UTC Measurement Day) ----------

/**
 * Computes ISO-8601 UTC week key (e.g. "2026-W45").
 * Kept distinct from `measurementDayKey(observedAt)` which tracks 12:00 UTC hardware daily distance resets.
 */
export function gameWeekKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

export interface SortableLeaderboardCandidate {
  resultId: string;
  totalScore: number;
  regionScore: number;
  completedAtMs: number;
}

export function compareLeaderboardCandidates(
  a: SortableLeaderboardCandidate,
  b: SortableLeaderboardCandidate,
): number {
  if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
  if (b.regionScore !== a.regionScore) return b.regionScore - a.regionScore;
  if (a.completedAtMs !== b.completedAtMs) return a.completedAtMs - b.completedAtMs;
  return a.resultId.localeCompare(b.resultId);
}

// ---------- Sybil Eligibility Boundary (Default Disabled) ----------

export function checkWalletEligibility(
  _walletAddress: string,
  policy: GamePolicy = DEFAULT_GAME_POLICY,
  context: WalletEligibilityContext = {},
  nowMs = Date.now(),
): WalletEligibilityResult {
  const checkedAt = new Date(nowMs).toISOString();
  if (!policy.sybilPolicy.enabled) {
    return {
      eligible: true,
      policyEnabled: false,
      code: "ELIGIBILITY_DISABLED_ALLOW_ALL",
      reason: policy.sybilPolicy.note,
      checkedAt,
    };
  }
  if (
    policy.sybilPolicy.minTxCount > 0 &&
    (context.txCount ?? 0) < policy.sybilPolicy.minTxCount
  ) {
    return {
      eligible: false,
      policyEnabled: true,
      code: "INELIGIBLE_TX_COUNT",
      reason: `Wallet requires at least ${policy.sybilPolicy.minTxCount} qualifying transactions on ${policy.sybilPolicy.network}.`,
      checkedAt,
    };
  }
  if (
    policy.sybilPolicy.minWalletAgeDays > 0 &&
    (context.walletAgeDays ?? 0) < policy.sybilPolicy.minWalletAgeDays
  ) {
    return {
      eligible: false,
      policyEnabled: true,
      code: "INELIGIBLE_WALLET_AGE",
      reason: `Wallet requires at least ${policy.sybilPolicy.minWalletAgeDays} days of age.`,
      checkedAt,
    };
  }
  return {
    eligible: true,
    policyEnabled: true,
    code: "ELIGIBLE",
    reason: "Wallet satisfies configured eligibility criteria.",
    checkedAt,
  };
}
