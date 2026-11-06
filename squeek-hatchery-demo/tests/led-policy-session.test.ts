import assert from "node:assert/strict";
import test from "node:test";
import {
  EXPERIMENTAL_POLICY_V1,
  FAMILIES,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  PALETTES,
  accessoryScheduleAt,
  assertValid4321Points,
  assertValidRareSchedule,
  calculateScoreBreakdown,
  checkWalletEligibility,
  compareLeaderboardCandidates,
  continuousRegionLevel,
  gameWeekKey,
  integerRegionLevel,
  ledLampPower,
  paletteScheduleAt,
  pickRandomBackgroundIndex,
  validateGamePolicy,
  type GamePolicy,
} from "../src/game-policy.ts";
import {
  buildCharacterSnapshot,
  buildLedMetadataJson,
  createLedSession,
  formatEffectivePlayerName,
  lockSessionTraits,
  shortWalletAddress,
  stepLedSession,
  validatePlayerDisplayName,
} from "../src/led-session.ts";
import {
  distanceDeltaMm,
  measurementDayKey,
  sameReportingHistory,
  validateStatus,
  workDelta,
  type Reading,
} from "../src/rules.ts";
import {
  restoreSignalBaseline,
  serializeSignalBaseline,
} from "../src/signal-cache.ts";

function makeReading(overrides: Partial<Reading> = {}): Reading {
  const observedAt = overrides.observedAt ?? Date.parse("2026-11-06T13:00:00.000Z");
  return {
    coreStatus: "ACTIVE",
    rpm: 65,
    meters: 300,
    distanceMm: 300_000,
    work: 400n,
    counterEpoch: "epoch-1",
    installationId: "inst-alpha",
    observedAt,
    received: observedAt,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(observedAt),
    ...overrides,
  };
}

test("4-3-2-1 point distribution and catalog invariants hold for Palette, Accessory, and Background", () => {
  assert.equal(FAMILIES.length, 3);
  assert.deepEqual(
    FAMILIES.map((f) => f.name),
    ["Pulse", "Relay", "Prism"],
  );
  assert.equal(PALETTES.length, 10);
  assert.equal(LED_ACCESSORIES.length, 10);
  assert.equal(LED_BACKGROUNDS.length, 10);

  validateGamePolicy(EXPERIMENTAL_POLICY_V1);

  // Rejects invalid distributions
  assert.throws(
    () => assertValid4321Points([1, 1, 1, 1, 1, 2, 2, 4, 4, 8], "badPoints"),
    /must follow 4x1pt, 3x2pt, 2x4pt, 1x8pt/,
  );
  assert.throws(
    () => assertValid4321Points([1, 1, 1, 1, 2, 2, 2, 4, 4], "shortPoints"),
    /must have exactly 10 items/,
  );
});

test("100 work units accessory schedule and 100m palette schedule boundaries and daily rare caps", () => {
  // Accessory boundaries at 0, 99, 100, 199, 200 work units
  const acc0 = accessoryScheduleAt(0n, 0n, EXPERIMENTAL_POLICY_V1);
  const acc99 = accessoryScheduleAt(99n, 0n, EXPERIMENTAL_POLICY_V1);
  const acc100 = accessoryScheduleAt(100n, 0n, EXPERIMENTAL_POLICY_V1);
  const acc199 = accessoryScheduleAt(199n, 0n, EXPERIMENTAL_POLICY_V1);
  const acc200 = accessoryScheduleAt(200n, 0n, EXPERIMENTAL_POLICY_V1);

  assert.equal(acc0.step, 0n);
  assert.equal(acc99.step, 0n);
  assert.equal(acc0.itemIndex, acc99.itemIndex);
  assert.equal(acc99.remainingInStep, 1n);

  assert.equal(acc100.step, 1n);
  assert.equal(acc199.step, 1n);
  assert.notEqual(acc99.itemIndex, acc100.itemIndex);
  assert.equal(acc100.itemIndex, acc199.itemIndex);
  assert.equal(acc200.step, 2n);
  assert.notEqual(acc199.itemIndex, acc200.itemIndex);

  // Palette boundaries at 0, 99_999, 100_000, 199_999, 200_000 mm
  const pal0 = paletteScheduleAt(0, EXPERIMENTAL_POLICY_V1);
  const pal99999 = paletteScheduleAt(99_999, EXPERIMENTAL_POLICY_V1);
  const pal100000 = paletteScheduleAt(100_000, EXPERIMENTAL_POLICY_V1);
  const pal199999 = paletteScheduleAt(199_999, EXPERIMENTAL_POLICY_V1);
  const pal200000 = paletteScheduleAt(200_000, EXPERIMENTAL_POLICY_V1);

  assert.equal(pal0.step, 0n);
  assert.equal(pal99999.step, 0n);
  assert.equal(pal0.itemIndex, pal99999.itemIndex);

  assert.equal(pal100000.step, 1n);
  assert.equal(pal199999.step, 1n);
  assert.notEqual(pal99999.itemIndex, pal100000.itemIndex);
  assert.equal(pal100000.itemIndex, pal199999.itemIndex);
  assert.equal(pal200000.step, 2n);
  assert.notEqual(pal199999.itemIndex, pal200000.itemIndex);

  // Daily rare window caps across an entire active day (steps 0..60)
  const palCounts = new Map<number, number>();
  const accCounts = new Map<number, number>();
  for (let step = 0; step <= 60; step++) {
    const p = paletteScheduleAt(step * 100_000, EXPERIMENTAL_POLICY_V1);
    palCounts.set(p.itemIndex, (palCounts.get(p.itemIndex) ?? 0) + 1);

    const a = accessoryScheduleAt(BigInt(step) * 100n, 0n, EXPERIMENTAL_POLICY_V1);
    accCounts.set(a.itemIndex, (accCounts.get(a.itemIndex) ?? 0) + 1);
  }

  // 4-point items (indices 7 and 8) open at most 3 times/day each; 8-point item (index 9) opens at most 2 times/day
  assert.equal(palCounts.get(7), 3);
  assert.equal(palCounts.get(8), 3);
  assert.equal(palCounts.get(9), 2);
  assert.equal(accCounts.get(7), 3);
  assert.equal(accCounts.get(8), 3);
  assert.equal(accCounts.get(9), 2);

  // Low wheel activity on a day (e.g. only 200m and 200 work units) opens 0 rare windows
  const lowPal = paletteScheduleAt(200_000, EXPERIMENTAL_POLICY_V1);
  const lowAcc = accessoryScheduleAt(200n, 0n, EXPERIMENTAL_POLICY_V1);
  assert.equal(lowPal.dailyRareWindowsOpened.totalRare, 0);
  assert.equal(lowAcc.dailyRareWindowsOpened.totalRare, 0);

  // Tick where both work units (+100) and distance (+100m) cross thresholds simultaneously
  const beforeBoth = {
    pal: paletteScheduleAt(99_999, EXPERIMENTAL_POLICY_V1),
    acc: accessoryScheduleAt(99n, 0n, EXPERIMENTAL_POLICY_V1),
  };
  const afterBoth = {
    pal: paletteScheduleAt(100_000, EXPERIMENTAL_POLICY_V1),
    acc: accessoryScheduleAt(100n, 0n, EXPERIMENTAL_POLICY_V1),
  };
  assert.notEqual(beforeBoth.pal.itemIndex, afterBoth.pal.itemIndex);
  assert.notEqual(beforeBoth.acc.itemIndex, afterBoth.acc.itemIndex);

  // Rejects schedule config that exceeds daily rare caps
  assert.throws(
    () =>
      assertValidRareSchedule(
        {
          rare4A: { itemIndex: 7, dailySteps: [1, 2, 3, 4] },
          rare4B: { itemIndex: 8, dailySteps: [5, 6] },
          apex8: { itemIndex: 9, dailySteps: [7, 8] },
          ordinaryCycle: [0, 1, 2, 3, 4, 5, 6],
        },
        EXPERIMENTAL_POLICY_V1.palettePoints,
        "overCapSchedule",
      ),
    /exceeds max 3 windows\/day/,
  );
});

test("simultaneous trait lock on first illumination never rerolls on pause, region aim, or wheel updates", () => {
  const session = createLedSession({
    mode: "guest",
    familyIndex: 1, // Relay
    policy: EXPERIMENTAL_POLICY_V1,
  });
  assert.equal(session.lockedTraits, null);

  // At 300m (step 3 -> Pearl, index 7) and 400 work units (step 4 -> Eclipse mask, index 7)
  const reading1 = makeReading({ distanceMm: 300_000, work: 400n });
  const locked1 = lockSessionTraits(
    session,
    reading1,
    0n,
    EXPERIMENTAL_POLICY_V1,
    "2026-11-06T13:00:00.000Z",
  );

  assert.equal(locked1.paletteIndex, 7);
  assert.equal(locked1.paletteId, "pearl");
  assert.equal(locked1.accessoryIndex, 7);
  assert.equal(locked1.accessoryId, "eclipse-mask");
  assert.equal(session.status, "running");

  // Pause, aim lamp to another region, and advance wheel counters to 900m and 900 work units
  session.status = "paused";
  session.lampPosition = 75; // Lower
  const reading2 = makeReading({
    distanceMm: 900_000,
    work: 900n,
    observedAt: Date.parse("2026-11-06T13:05:00.000Z"),
  });

  const locked2 = lockSessionTraits(
    session,
    reading2,
    0n,
    EXPERIMENTAL_POLICY_V1,
    "2026-11-06T13:05:00.000Z",
  );
  assert.deepEqual(locked2, locked1);
  assert.equal(locked2.paletteIndex, 7);
  assert.equal(locked2.accessoryIndex, 7);
});

test("regional growth Lv0-10, integer level-up detection, and canonical CharacterSnapshot export", () => {
  const session = createLedSession({
    mode: "guest",
    familyIndex: 2, // Prism
    policy: EXPERIMENTAL_POLICY_V1,
  });
  lockSessionTraits(session, makeReading({ distanceMm: 800_000, work: 900n }), 0n);

  // At 65 RPM, ledLampPower is 1.0 (100%). Full dose for Lv10 is 19s -> 1.9s per integer level.
  assert.equal(ledLampPower(65, EXPERIMENTAL_POLICY_V1), 1);
  assert.equal(ledLampPower(0, EXPERIMENTAL_POLICY_V1), EXPERIMENTAL_POLICY_V1.baseLampPower);

  // Aim at Head (-70): 1.0s at 65 RPM -> dose 1.0s -> continuous ~0.526 -> integer level 0 (no level-up yet)
  session.lampPosition = -70;
  const step1 = stepLedSession(session, 1.0, 65, 10n, EXPERIMENTAL_POLICY_V1);
  assert.equal(step1.levelUps.length, 0);
  assert.equal(session.regions[0].level, 0);

  // Another 1.0s at 65 RPM -> total dose 2.0s -> crosses Lv1!
  const step2 = stepLedSession(session, 1.0, 65, 10n, EXPERIMENTAL_POLICY_V1);
  assert.equal(step2.levelUps.length, 1);
  assert.deepEqual(step2.levelUps[0], {
    region: 0,
    previousLevel: 0,
    newLevel: 1,
  });
  assert.equal(session.regions[0].level, 1);

  // Drive Head to Lv10 (17 more seconds = 19s total)
  const step3 = stepLedSession(session, 17.0, 65, 50n, EXPERIMENTAL_POLICY_V1);
  assert.equal(session.regions[0].level, 10);
  assert.equal(step3.levelUps[0]?.newLevel, 10);

  // Aim at Middle (0) for 19s -> Lv10
  session.lampPosition = 0;
  stepLedSession(session, 19.0, 65, 50n, EXPERIMENTAL_POLICY_V1);
  assert.equal(session.regions[1].level, 10);

  // Aim at Lower (70) for remaining 22s -> Lv10 (capped at 10) and session completes at 60s
  session.lampPosition = 70;
  const finalStep = stepLedSession(session, 22.0, 65, 50n, EXPERIMENTAL_POLICY_V1);
  assert.equal(finalStep.completed, true);
  assert.equal(session.status, "completed");
  assert.equal(session.regions[2].level, 10);
  assert.ok(session.backgroundIndex !== null);

  const snapshot = buildCharacterSnapshot(session, {
    resultId: "res-prism-max",
    displayName: "Vanguard",
  });
  assert.deepEqual(snapshot.levels, [10, 10, 10]);
  assert.deepEqual(snapshot.regionFamilies, ["prism", "prism", "prism"]);
  assert.equal(snapshot.scores.regionsTotal, 30);
  assert.equal(snapshot.scores.palette, 8); // Spectrum at 800m
  assert.equal(snapshot.scores.accessory, 8); // Aurora bloom at 900 work units
  assert.equal(
    snapshot.scores.total,
    30 + 8 + 8 + snapshot.scores.background,
  );

  const metadata = JSON.parse(buildLedMetadataJson(snapshot));
  assert.deepEqual(metadata.dimensions, { width: 1600, height: 1600 });
  assert.equal(metadata.snapshot.resultId, "res-prism-max");
});

test("12:00 UTC daily reset vs UTC midnight and installationId + counterEpoch isolation", () => {
  // 11:59:59 UTC (18:59:59 Asia/Saigon) vs 12:00:00 UTC (19:00:00 Asia/Saigon)
  const beforeNoonUtc = Date.parse("2026-11-06T11:59:59.000Z");
  const atNoonUtc = Date.parse("2026-11-06T12:00:00.000Z");
  const atMidnightUtc = Date.parse("2026-11-07T00:00:00.000Z");

  assert.equal(measurementDayKey(beforeNoonUtc), "2026-11-05");
  assert.equal(measurementDayKey(atNoonUtc), "2026-11-06");
  assert.equal(measurementDayKey(atMidnightUtc), "2026-11-06");

  // Keep gameWeekKey distinct from measurementDayKey
  assert.match(gameWeekKey(atNoonUtc), /^\d{4}-W\d{2}$/);

  // installationId isolation even when counterEpoch is identical
  const rInstA = makeReading({
    installationId: "inst-A",
    counterEpoch: "epoch-1",
    work: 1000n,
    distanceMm: 50_000,
    observedAt: atNoonUtc,
  });
  const rInstB = makeReading({
    installationId: "inst-B",
    counterEpoch: "epoch-1",
    work: 5000n,
    distanceMm: 10_000,
    observedAt: atNoonUtc + 5000,
  });

  assert.equal(sameReportingHistory(rInstA, rInstB), false);
  // No phantom work or distance when installationId changes
  assert.equal(workDelta(rInstA, rInstB), 0n);
  assert.equal(distanceDeltaMm(rInstA, rInstB), 0);

  // Signal cache preserves installationId
  const rawCache = serializeSignalBaseline(rInstA);
  const restored = restoreSignalBaseline(rawCache);
  assert.ok(restored);
  assert.equal(restored.installationId, "inst-A");
  assert.equal(sameReportingHistory(restored, rInstA), true);
  assert.equal(sameReportingHistory(restored, rInstB), false);
});

test("display name validation and Sybil eligibility boundary (disabled by default)", () => {
  assert.deepEqual(validatePlayerDisplayName(""), { valid: true, normalized: "" });
  assert.deepEqual(validatePlayerDisplayName("   "), { valid: true, normalized: "" });
  assert.deepEqual(validatePlayerDisplayName("  Hamster   Pilot "), {
    valid: true,
    normalized: "Hamster Pilot",
  });
  assert.equal(
    formatEffectivePlayerName("0x1234567890abcdef1234567890abcdef12345678", ""),
    "0x1234…5678",
  );
  assert.equal(
    shortWalletAddress("0x1234567890abcdef1234567890abcdef12345678"),
    "0x1234…5678",
  );

  // Rejects > 30 chars and XSS characters
  assert.equal(validatePlayerDisplayName("a".repeat(31)).valid, false);
  assert.equal(validatePlayerDisplayName("<script>alert(1)</script>").valid, false);
  assert.equal(validatePlayerDisplayName('Alice" onerror="alert(1)').valid, false);

  // Sybil boundary is disabled by default
  const defaultRes = checkWalletEligibility(
    "0x1234567890abcdef1234567890abcdef12345678",
    EXPERIMENTAL_POLICY_V1,
    { txCount: 0, walletAgeDays: 0 },
  );
  assert.equal(defaultRes.eligible, true);
  assert.equal(defaultRes.policyEnabled, false);
  assert.equal(defaultRes.code, "ELIGIBILITY_DISABLED_ALLOW_ALL");

  // When enabled in a custom policy, enforces tx count and wallet age
  const enabledPolicy: GamePolicy = {
    ...EXPERIMENTAL_POLICY_V1,
    sybilPolicy: {
      enabled: true,
      network: "ethereum-mainnet",
      minTxCount: 3,
      minWalletAgeDays: 30,
      ageAnchor: "undecided",
      note: "Enabled for unit test",
    },
  };
  const blockedTx = checkWalletEligibility(
    "0x1234567890abcdef1234567890abcdef12345678",
    enabledPolicy,
    { txCount: 1, walletAgeDays: 100 },
  );
  assert.equal(blockedTx.eligible, false);
  assert.equal(blockedTx.code, "INELIGIBLE_TX_COUNT");

  const blockedAge = checkWalletEligibility(
    "0x1234567890abcdef1234567890abcdef12345678",
    enabledPolicy,
    { txCount: 5, walletAgeDays: 7 },
  );
  assert.equal(blockedAge.eligible, false);
  assert.equal(blockedAge.code, "INELIGIBLE_WALLET_AGE");

  const passed = checkWalletEligibility(
    "0x1234567890abcdef1234567890abcdef12345678",
    enabledPolicy,
    { txCount: 5, walletAgeDays: 45 },
  );
  assert.equal(passed.eligible, true);
  assert.equal(passed.code, "ELIGIBLE");
});
