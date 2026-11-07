import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { HatcheryBackend, UPSTREAM_TELEMETRY_URL } from "../src/backend.ts";
import {
  EXPERIMENTAL_POLICY_V3,
  EXPERIMENTAL_POLICY_V2,
  EXPERIMENTAL_POLICY_V1,
  EXPERIMENTAL_POLICY_V4,
  DEFAULT_GAME_POLICY,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  PALETTES,
  calculateScoreBreakdown,
  catalogPointRowsFromPolicy,
  resolveKnownGamePolicy,
  ledLampPower,
} from "../src/game-policy.ts";
import {
  createLedSession,
  lockSessionTraits,
  playModeAllowsRankedMutation,
  rankedAbandonOnNewEggAllowed,
  rankedSessionMutationAllowed,
  stageFamilyIndexForSelection,
  stepLedSession,
} from "../src/led-session.ts";
import {
  isObservationValid,
  isSpeedFresh,
  measurementDayKey,
  observationValidityLimitMs,
  regionAt,
  type Reading,
} from "../src/rules.ts";
import { createHatcheryHttpServer } from "../src/server.ts";

describe("Round 5 Regressions: Section A — Shared Telemetry & Honest Power", () => {
  test("A1: Concurrent clients share a single upstream producer in flight without duplicate requests", async () => {
    let upstreamInvocations = 0;
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");

    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareTimeoutMs: 1000,
      hardwareProvider: async () => {
        upstreamInvocations++;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return {
          source: "live",
          reading: {
            coreStatus: "ACTIVE",
            rpm: 65,
            meters: 100,
            distanceMm: 100_000,
            work: 500n,
            counterEpoch: "epoch-shared",
            installationId: "wheel-shared",
            observedAt: nowMs,
            received: nowMs,
            staleAfterSeconds: 60,
            utcDate: measurementDayKey(nowMs),
          },
        };
      },
    });

    try {
      // 10 concurrent requests to getHardwareTelemetry
      const promises = Array.from({ length: 10 }, () => backend.getHardwareTelemetry());
      const snapshots = await Promise.all(promises);

      assert.equal(upstreamInvocations, 1, "Only 1 upstream provider call for 10 concurrent requests");
      for (const snap of snapshots) {
        assert.equal(snap.dailyDistanceMm, 100_000);
        assert.equal(snap.cumulativeWorkUnits, "500");
      }
    } finally {
      backend.close();
    }
  });

  test("A2: Valid IDLE at ages 16s, 59s, 119s supplies base power; expires at declared TTL (120s)", () => {
    const baseMs = Date.parse("2026-11-06T13:00:00.000Z");
    const idleReading: Reading = {
      coreStatus: "IDLE",
      rpm: 0,
      meters: 200,
      distanceMm: 200_000,
      work: 1000n,
      counterEpoch: "epoch-idle",
      installationId: "wheel-idle",
      observedAt: baseMs,
      received: baseMs,
      staleAfterSeconds: 120,
      utcDate: measurementDayKey(baseMs),
    };

    // Age 16s
    assert.equal(isObservationValid(idleReading, baseMs + 16_000), true);
    assert.equal(isSpeedFresh(idleReading, baseMs + 16_000), true, "IDLE speed freshness is preserved");
    assert.equal(ledLampPower(idleReading.rpm, EXPERIMENTAL_POLICY_V3), 0.4, "40% base power");

    // Age 59s
    assert.equal(isObservationValid(idleReading, baseMs + 59_000), true);
    assert.equal(isSpeedFresh(idleReading, baseMs + 59_000), true);
    assert.equal(ledLampPower(idleReading.rpm, EXPERIMENTAL_POLICY_V3), 0.4);

    // Age 119s
    assert.equal(isObservationValid(idleReading, baseMs + 119_000), true);
    assert.equal(isSpeedFresh(idleReading, baseMs + 119_000), true);
    assert.equal(ledLampPower(idleReading.rpm, EXPERIMENTAL_POLICY_V3), 0.4);

    // Age 121s -> declared expiry
    assert.equal(isObservationValid(idleReading, baseMs + 121_000), false, "Expires past 120s TTL");
  });

  test("A3: Stale ACTIVE (>15s) drops from dynamic power to 40% base power with speed-unavailable state", async () => {
    const baseMs = Date.parse("2026-11-06T13:00:00.000Z");
    let nowMs = baseMs;

    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 100,
          distanceMm: 100_000,
          work: 500n,
          counterEpoch: "epoch-stale-act",
          installationId: "wheel-stale-act",
          observedAt: baseMs,
          received: baseMs,
          staleAfterSeconds: 120,
          utcDate: measurementDayKey(baseMs),
        },
      }),
    });

    try {
      // 1. Fresh ACTIVE at 5s
      nowMs = baseMs + 5_000;
      const freshSnap = await backend.getHardwareTelemetry();
      assert.ok(freshSnap.signal);
      assert.equal(freshSnap.signal.state, "ok");
      assert.match(freshSnap.signal.message, /Live hardware telemetry active/i);

      // 2. Stale ACTIVE at 16s (>15s, but <=120s)
      nowMs = baseMs + 16_000;
      const staleSnap = await backend.getHardwareTelemetry();
      assert.ok(staleSnap.signal);
      assert.equal(staleSnap.signal.state, "speed-unavailable");
      assert.match(staleSnap.signal.message, /Speed unavailable; running at 40% base power/i);
    } finally {
      backend.close();
    }
  });

  test("A4: Device hard fault (COUNTER_FAULT) immediately invalidates cache and rejects", async () => {
    const baseMs = Date.parse("2026-11-06T13:00:00.000Z");
    let nowMs = baseMs;
    let returnFault = false;

    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => {
        if (returnFault) {
          return {
            source: "live",
            statusPayload: {
              schemaVersion: 1,
              installationId: "wheel-fault",
              measurement: {
                provenance: "hardware",
                freshness: "online",
                coreStatus: "COUNTER_FAULT",
                rpmMilli: 0,
                cumulativeWorkUnits: "0",
                distanceMm: 0,
                counterEpoch: "fault-epoch",
                observedAt: new Date(nowMs).toISOString(),
                receivedAt: new Date(nowMs).toISOString(),
                staleAfterSeconds: 60,
              },
            },
          };
        }
        return {
          source: "live",
          reading: {
            coreStatus: "ACTIVE",
            rpm: 65,
            meters: 100,
            distanceMm: 100_000,
            work: 500n,
            counterEpoch: "epoch-fault-test",
            installationId: "wheel-fault",
            observedAt: nowMs,
            received: nowMs,
            staleAfterSeconds: 60,
            utcDate: measurementDayKey(nowMs),
          },
        };
      },
    });

    try {
      const snap = await backend.getHardwareTelemetry();
      assert.equal(snap.reading.coreStatus, "ACTIVE");

      // Switch to hard fault
      returnFault = true;
      nowMs += 2_000;
      await assert.rejects(
        () => backend.getHardwareTelemetry(),
        /(COUNTER_FAULT|fault)/i,
        "COUNTER_FAULT must be rejected immediately and never masked as cached data",
      );
    } finally {
      backend.close();
    }
  });

  test("A5: Bounded real-provider smoke check reports upstream status honestly", async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      const res = await fetch(UPSTREAM_TELEMETRY_URL, {
        signal: controller.signal,
        headers: { accept: "application/json" },
      });
      assert.ok(res.status === 200 || res.status === 404 || res.status >= 500);
    } catch (err: unknown) {
      // Expected if network is unreachable or offline in test environment
      const msg = err instanceof Error ? err.message : String(err);
      assert.ok(msg.length > 0, "Outage or timeout reported honestly");
    } finally {
      clearTimeout(timer);
    }
  });
});

describe("Round 5 Regressions: Section B — Versioned Traits, Allowance & Ranking", () => {
  test("B1: Background count-derived appearance model matches exact integer weights [3339...1302...868] (total 26,845)", () => {
    const policy = EXPERIMENTAL_POLICY_V3;
    assert.equal(policy.version, "exp-v3-2026-11-06");

    const expectedWeights = [3339, 3339, 3339, 3339, 3339, 3339, 3339, 1302, 1302, 868];
    const total = expectedWeights.reduce((a, b) => a + b, 0);
    assert.equal(total, 26845, "Total appearance count weight sum must be 26,845");

    assert.deepEqual(policy.backgroundWeights, expectedWeights);

    // Aesthetic points remain unchanged
    const expectedPoints = [1, 2, 2, 1, 2, 1, 1, 4, 4, 8];
    assert.deepEqual(policy.backgroundPoints, expectedPoints);
    assert.equal(LED_BACKGROUNDS.length, 10);
  });

  test("B2: Eight strata private event openings (2/3/3 bag) per category per day without adjacent identical specials", () => {
    const backend = new HatcheryBackend({ dbPath: ":memory:" });
    try {
      const utcDate = "2026-11-06";
      backend.ensureStrataEventsForDay("palette", utcDate);
      backend.ensureStrataEventsForDay("accessory", utcDate);

      // Verify DB rows
      const pRows = backend["db"]
        .prepare("SELECT * FROM special_schedule_events WHERE category = 'palette' AND utc_date = ? ORDER BY stratum_index ASC")
        .all(utcDate) as { special_trait_index: number; stratum_index: number; event_time_ms: number }[];
      const aRows = backend["db"]
        .prepare("SELECT * FROM special_schedule_events WHERE category = 'accessory' AND utc_date = ? ORDER BY stratum_index ASC")
        .all(utcDate) as { special_trait_index: number; stratum_index: number; event_time_ms: number }[];

      assert.equal(pRows.length, 8, "8 strata events for palette");
      assert.equal(aRows.length, 8, "8 strata events for accessory");

      // Count occurrences of apex (rare index 9) and two 4-point traits (indices 7, 8)
      const pCounts: Record<number, number> = {};
      for (const r of pRows) {
        pCounts[r.special_trait_index] = (pCounts[r.special_trait_index] ?? 0) + 1;
      }
      assert.equal(pCounts[9], 2, "Apex rare 9 appears exactly twice");
      assert.equal(pCounts[7], 3, "4-point rare 7 appears exactly three times");
      assert.equal(pCounts[8], 3, "4-point rare 8 appears exactly three times");

      // Verify no adjacent identical rare IDs
      for (let i = 1; i < pRows.length; i++) {
        assert.notEqual(pRows[i].special_trait_index, pRows[i - 1].special_trait_index, "No adjacent identical special IDs");
      }
      for (let i = 1; i < aRows.length; i++) {
        assert.notEqual(aRows[i].special_trait_index, aRows[i - 1].special_trait_index, "No adjacent identical special IDs");
      }
    } finally {
      backend.close();
    }
  });

  test("B3: Interrupted ranked session allows restart from zero on SAME egg without rerolling background or policy", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const backend = new HatcheryBackend({
      policy: DEFAULT_GAME_POLICY,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 50,
          distanceMm: 50_000,
          work: 200n,
          counterEpoch: "epoch-restart",
          installationId: "wheel-restart",
          observedAt: nowMs,
          received: nowMs,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(nowMs),
        },
      }),
    });

    try {
      const wallet = "0x1111111111111111111111111111111111111111";
      // 1. Claim ranked egg
      const egg = backend.claimRankedEgg(wallet, { familyIndex: 1 });
      const eggId = egg.id;

      // 2. Start and grow for 20 seconds (partial progress)
      await backend.startRankedIllumination(wallet, { sessionId: eggId });
      nowMs += 20_000;
      const ticked = await backend.tickRankedSession(wallet, { sessionId: eggId });
      assert.ok(ticked.session.elapsed > 0);
      assert.ok(ticked.session.lockedTraits !== null);
      const originalLockedPalette = ticked.session.lockedTraits.paletteIndex;
      const originalLockedAccessory = ticked.session.lockedTraits.accessoryIndex;

      // Inspect DB to see assigned background
      const preRow = backend["db"]
        .prepare("SELECT * FROM ranked_sessions WHERE session_id = ?")
        .get(eggId) as Record<string, unknown>;
      const assignedBg = Number(preRow.assigned_background_index);
      assert.ok(assignedBg >= 0 && assignedBg < 10);

      // 3. Restart interrupted session (current rules clear locks; same egg/species retained)
      const restarted = await backend.restartRankedSession(wallet, { sessionId: eggId });
      assert.equal(restarted.session.id, eggId, "Keeps same session ID");
      assert.equal(restarted.session.elapsed, 0, "Elapsed reset to zero");
      assert.equal(restarted.session.regions[0].level, 0, "Regions reset to 0");
      assert.equal(restarted.session.regions[1].level, 0);
      assert.equal(restarted.session.regions[2].level, 0);
      assert.equal(restarted.session.lockedTraits, null, "Trait locks cleared on restart");
      assert.equal(restarted.session.familyIndex, 1, "Chosen species preserved");
      void originalLockedPalette;
      void originalLockedAccessory;

      // Verify assigned background did NOT reroll (hidden until completion)
      const postRow = backend["db"]
        .prepare("SELECT * FROM ranked_sessions WHERE session_id = ?")
        .get(eggId) as Record<string, unknown>;
      assert.equal(Number(postRow.assigned_background_index), assignedBg, "Assigned background retained");
    } finally {
      backend.close();
    }
  });

  test("B4: Daily allowance enforces 3 completed ranked plays per UTC calendar day (00:00 UTC)", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 50,
          distanceMm: 50_000,
          work: 200n,
          counterEpoch: "epoch-allowance",
          installationId: "wheel-allowance",
          observedAt: nowMs,
          received: nowMs,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(nowMs),
        },
      }),
    });

    try {
      const wallet = "0x2222222222222222222222222222222222222222";

      // Initial allowance: 3 remaining
      let allowance = backend.getDailyAllowanceDto(wallet);
      assert.equal(allowance.completedToday, 0);
      assert.equal(allowance.remaining, 3);

      // Play 1: Complete session
      for (let i = 1; i <= 3; i++) {
        const egg = backend.claimRankedEgg(wallet, { familyIndex: 0 });
        await backend.startRankedIllumination(wallet, { sessionId: egg.id });

        // Simulate 60s illumination across regions
        for (let step = 0; step < 3; step++) {
          nowMs += 20_000;
          await backend.aimRankedSession(wallet, { sessionId: egg.id, lampPosition: step === 0 ? -70 : step === 1 ? 0 : 70 });
        }

        const comp = await backend.completeRankedSession(wallet, { sessionId: egg.id });
        assert.ok(comp.snapshot.scores.total > 0);
        allowance = backend.getDailyAllowanceDto(wallet);
        assert.equal(allowance.completedToday, i);
        assert.equal(allowance.remaining, 3 - i);
      }

      // 4th ranked claim attempt must be rejected with 429
      assert.throws(
        () => backend.claimRankedEgg(wallet, { familyIndex: 0 }),
        (err: unknown) => {
          return err instanceof Error && err.message.includes("allowance reached");
        },
      );

      // Cross UTC midnight (00:00 UTC) -> allowance resets to 3
      nowMs = Date.parse("2026-11-07T00:00:01.000Z");
      const nextDayAllowance = backend.getDailyAllowanceDto(wallet, nowMs);
      assert.equal(nextDayAllowance.completedToday, 0, "Resets on new UTC calendar day");
      assert.equal(nextDayAllowance.remaining, 3);
    } finally {
      backend.close();
    }
  });

  test("B5: Terminal completion is idempotent on lost response and blocks concurrent completion/restart", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 50,
          distanceMm: 50_000,
          work: 200n,
          counterEpoch: "epoch-lost-resp",
          installationId: "wheel-lost-resp",
          observedAt: nowMs,
          received: nowMs,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(nowMs),
        },
      }),
    });

    try {
      const wallet = "0x3333333333333333333333333333333333333333";
      const egg = backend.claimRankedEgg(wallet, { familyIndex: 2 });
      await backend.startRankedIllumination(wallet, { sessionId: egg.id });

      for (let step = 0; step < 3; step++) {
        nowMs += 20_000;
        await backend.aimRankedSession(wallet, { sessionId: egg.id, lampPosition: step === 0 ? -70 : step === 1 ? 0 : 70 });
      }

      // First complete call
      const res1 = await backend.completeRankedSession(wallet, { sessionId: egg.id });
      assert.ok(res1.resultId);

      // Lost response / reconnect: second complete call returns identical result
      const res2 = await backend.completeRankedSession(wallet, { sessionId: egg.id });
      assert.equal(res2.resultId, res1.resultId, "Returns identical committed result");
      assert.equal(res2.snapshot.scores.total, res1.snapshot.scores.total);

      // Restarting completed session must be rejected with 409
      await assert.rejects(
        () => backend.restartRankedSession(wallet, { sessionId: egg.id }),
        /completed/i,
      );
    } finally {
      backend.close();
    }
  });

  test("B6: Replaceable best-play strategy: lower score never replaces higher score on leaderboard", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const backend = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 50,
          distanceMm: 50_000,
          work: 200n,
          counterEpoch: "epoch-best",
          installationId: "wheel-best",
          observedAt: nowMs,
          received: nowMs,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(nowMs),
        },
      }),
    });

    try {
      const wallet = "0x4444444444444444444444444444444444444444";

      // Session 1: Aim all 3 regions evenly -> 10, 10, 10 (high score)
      const egg1 = backend.claimRankedEgg(wallet, { familyIndex: 0 });
      await backend.startRankedIllumination(wallet, { sessionId: egg1.id });
      for (const pos of [-70, 0, 70]) {
        nowMs += 20_000;
        await backend.aimRankedSession(wallet, { sessionId: egg1.id, lampPosition: pos });
      }
      const res1 = await backend.completeRankedSession(wallet, { sessionId: egg1.id });
      const score1 = res1.snapshot.scores.total;

      // Session 2: Aim only 1 region -> 10, 0, 0 (lower score)
      const egg2 = backend.claimRankedEgg(wallet, { familyIndex: 1 });
      await backend.startRankedIllumination(wallet, { sessionId: egg2.id });
      for (let i = 0; i < 3; i++) {
        nowMs += 20_000;
        await backend.aimRankedSession(wallet, { sessionId: egg2.id, lampPosition: -70 });
      }
      const res2 = await backend.completeRankedSession(wallet, { sessionId: egg2.id });
      const score2 = res2.snapshot.scores.total;
      assert.ok(score1 > score2, `Session 1 score (${score1}) should exceed Session 2 score (${score2})`);

      // Verify leaderboard keeps best score
      const lb = backend.getWeeklyLeaderboard({ policyVersion: EXPERIMENTAL_POLICY_V3.version });
      const entry = lb.entries.find((e) => e.resultId === res1.resultId);
      assert.ok(entry, "Winning result exists on leaderboard");
      assert.equal(entry.scores.total, score1, "Leaderboard reflects highest-scoring play");
      assert.equal(entry.effectiveName.length > 0, true);
      assert.equal(
        Object.prototype.hasOwnProperty.call(entry, "walletAddress"),
        false,
        "Public leaderboard DTO must not include full walletAddress",
      );
    } finally {
      backend.close();
    }
  });

  test("B7: Frozen policies: legacy sessions keep V1/V2/V3 rules; new eggs get latest V4", () => {
    const v1Session = createLedSession({ mode: "guest", familyIndex: 0, policy: EXPERIMENTAL_POLICY_V1 });
    const v2Session = createLedSession({ mode: "guest", familyIndex: 0, policy: EXPERIMENTAL_POLICY_V2 });
    const v3Session = createLedSession({ mode: "guest", familyIndex: 0, policy: EXPERIMENTAL_POLICY_V3 });
    const latestSession = createLedSession({
      mode: "guest",
      familyIndex: 0,
      policy: DEFAULT_GAME_POLICY,
    });

    assert.equal(v1Session.policyVersion, "exp-v1-2026-11-06");
    assert.equal(v2Session.policyVersion, "exp-v2-2026-11-06");
    assert.equal(v3Session.policyVersion, "exp-v3-2026-11-06");
    assert.equal(latestSession.policyVersion, DEFAULT_GAME_POLICY.version);
    assert.equal(resolveKnownGamePolicy(v1Session.policyVersion)?.version, "exp-v1-2026-11-06");
    assert.equal(resolveKnownGamePolicy(v2Session.policyVersion)?.version, "exp-v2-2026-11-06");
    assert.equal(resolveKnownGamePolicy(v3Session.policyVersion)?.version, "exp-v3-2026-11-06");
    assert.equal(DEFAULT_GAME_POLICY.allowsManualPause, false);
    assert.equal(DEFAULT_GAME_POLICY.clearLocksOnRestart, true);
    assert.equal(DEFAULT_GAME_POLICY.activityGapResetsAttempt, true);
  });
});

describe("Round 5 / Cursor repair: R19 atomic persistence, R26 legacy freshness, R24/R25", () => {
  test("R19: fault between hardware baseline and trait progress rolls back; 100→160 fail→200 advances once", () => {
    const dbPath = path.join(os.tmpdir(), `squeek-r19-atomic-${Date.now()}.sqlite`);
    let now = Date.parse("2026-11-06T11:00:00.000Z");
    const reading = (distanceMm: number): Reading => ({
      coreStatus: "ACTIVE",
      rpm: 65,
      meters: distanceMm / 1000,
      distanceMm,
      work: 500n,
      counterEpoch: "atomic-r19",
      installationId: "wheel-atomic-r19",
      observedAt: now,
      received: now,
      staleAfterSeconds: 120,
      utcDate: measurementDayKey(now),
    });

    let backend = new HatcheryBackend({
      dbPath,
      policy: EXPERIMENTAL_POLICY_V3,
      now: () => now,
    });
    try {
      backend.ingestHardwareReading(reading(100_000), "live", now);
      const after100 = backend.db
        .prepare(
          `SELECT last_transition_threshold, accumulated_progress FROM trait_transition_state WHERE category = 'palette'`,
        )
        .get() as { last_transition_threshold: number; accumulated_progress: number };
      assert.equal(after100.last_transition_threshold, 1);
      assert.equal(after100.accumulated_progress, 100_000);

      backend.db.exec(`CREATE TEMP TRIGGER qa_fail_partial BEFORE UPDATE ON trait_transition_state
        WHEN NEW.category = 'palette' BEGIN
          SELECT RAISE(FAIL, 'QA injected trait persistence failure');
        END;`);

      now += 1000;
      assert.throws(
        () => backend.ingestHardwareReading(reading(160_000), "live", now),
        /QA injected/,
      );

      // In-memory + DB must still reflect the pre-fault baseline (not a half-committed 160m).
      const hwAfterFault = backend.db
        .prepare(`SELECT schedule_distance_mm FROM hardware_state WHERE singleton_id = 1`)
        .get() as { schedule_distance_mm: number };
      assert.equal(hwAfterFault.schedule_distance_mm, 100_000);
      const traitAfterFault = backend.db
        .prepare(
          `SELECT last_transition_threshold, accumulated_progress FROM trait_transition_state WHERE category = 'palette'`,
        )
        .get() as { last_transition_threshold: number; accumulated_progress: number };
      assert.equal(traitAfterFault.last_transition_threshold, 1);
      assert.equal(traitAfterFault.accumulated_progress, 100_000);

      backend.close();
      backend = new HatcheryBackend({
        dbPath,
        policy: EXPERIMENTAL_POLICY_V3,
        now: () => now,
      });
      now += 1000;
      backend.ingestHardwareReading(reading(200_000), "live", now);
      const threshold = backend.db
        .prepare(
          `SELECT last_transition_threshold, accumulated_progress FROM trait_transition_state WHERE category = 'palette'`,
        )
        .get() as { last_transition_threshold: number; accumulated_progress: number };
      assert.equal(threshold.last_transition_threshold, 2, "200m must advance exactly once after faulted 160m");
      assert.equal(threshold.accumulated_progress, 200_000);
    } finally {
      backend.close();
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore cleanup
      }
    }
  });

  test("R26: V1/V2 observation validity stays 15s; V3/V4 keep original deadlines up to 120s", async () => {
    const base = Date.parse("2026-11-06T13:00:00.000Z");
    const sample: Reading = {
      coreStatus: "IDLE",
      rpm: 0,
      meters: 100,
      distanceMm: 100_000,
      work: 400n,
      counterEpoch: "r26-epoch",
      installationId: "r26-wheel",
      observedAt: base,
      received: base,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(base),
    };

    assert.equal(observationValidityLimitMs(sample, EXPERIMENTAL_POLICY_V2), 15_000);
    assert.equal(observationValidityLimitMs(sample, EXPERIMENTAL_POLICY_V1), 15_000);
    assert.equal(observationValidityLimitMs(sample, EXPERIMENTAL_POLICY_V3), 60_000);
    assert.equal(observationValidityLimitMs(sample, EXPERIMENTAL_POLICY_V4), 60_000);
    assert.equal(isObservationValid(sample, base + 15_100, EXPERIMENTAL_POLICY_V2), false);
    assert.equal(isObservationValid(sample, base + 15_100, EXPERIMENTAL_POLICY_V3), true);
    assert.equal(isObservationValid(sample, base + 15_100, EXPERIMENTAL_POLICY_V4), true);

    const nowRef = { ms: base };
    const { backend, server } = createHatcheryHttpServer({
      dbPath: ":memory:",
      policy: EXPERIMENTAL_POLICY_V2,
      now: () => nowRef.ms,
      hardwareProvider: async () => ({
        source: "live",
        reading: {
          ...sample,
          coreStatus: "ACTIVE",
          rpm: 65,
          observedAt: nowRef.ms - 15_100,
          received: nowRef.ms - 15_100,
        },
      }),
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const stale = await fetch(`http://127.0.0.1:${port}/api/hardware/status`);
      assert.equal(stale.status, 503, "V2 server must refuse a 15.1s-old observation");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      backend.close();
    }
  });

  test("R24: Docs catalog rows derive only from real catalogs and policy point arrays", () => {
    const policy = EXPERIMENTAL_POLICY_V3;
    const pal = catalogPointRowsFromPolicy(PALETTES, policy.palettePoints);
    const acc = catalogPointRowsFromPolicy(LED_ACCESSORIES, policy.accessoryPoints);
    const bg = catalogPointRowsFromPolicy(LED_BACKGROUNDS, policy.backgroundPoints);

    assert.deepEqual(
      pal.flatMap((r) => r.names),
      PALETTES.map((p) => p.name),
    );
    assert.deepEqual(
      acc.flatMap((r) => r.names),
      LED_ACCESSORIES.map((a) => a.name),
    );
    assert.ok(acc.some((r) => r.names.includes("Holo lenses")));
    assert.ok(acc.some((r) => r.names.includes("Aurora bloom")));
    assert.ok(!acc.some((r) => r.names.includes("Ribbed collar")));
    assert.ok(!bg.some((r) => r.names.includes("Prism Horizon")));
    assert.ok(bg.some((r) => r.names.includes("Celestial Bloom")));
    assert.equal(
      bg.find((r) => r.points === 8)?.names[0],
      "Celestial Bloom",
    );
  });

  test("R25: family preview is selection-stable before confirm; Demo cannot mutate ranked session", () => {
    assert.equal(stageFamilyIndexForSelection(false, 2, 0), 2);
    assert.equal(stageFamilyIndexForSelection(true, 2, 0), 0);

    assert.equal(playModeAllowsRankedMutation(true, "demo"), false);
    assert.equal(playModeAllowsRankedMutation(true, "ranked"), true);
    assert.equal(playModeAllowsRankedMutation(false, "ranked"), false);

    const rankedRunning = { status: "running" };
    assert.equal(rankedSessionMutationAllowed(true, "demo", rankedRunning), false);
    assert.equal(rankedAbandonOnNewEggAllowed(true, "demo", rankedRunning), false);
    assert.equal(rankedSessionMutationAllowed(true, "ranked", rankedRunning), true);
    assert.equal(rankedAbandonOnNewEggAllowed(true, "ranked", rankedRunning), true);
    assert.equal(rankedSessionMutationAllowed(true, "ranked", { status: "completed" }), false);
  });

  test("R22/A3/A4 scene helpers: fit, reveal coverage, closed interior, region-card aim", async () => {
    const scene = await import("../src/led-scene.ts");
    assert.equal(scene.bodyFitsInsideEgg([10, 10, 10]), true);
    assert.equal(scene.bodyFitsInsideEgg([10, 0, 0]), true);
    assert.equal(scene.bodyFitsInsideEgg([0, 0, 10]), true);
    const center = scene.computeRevealWindow(0, true);
    const upper = scene.computeRevealWindow(-33, true);
    const lower = scene.computeRevealWindow(33, true);
    assert.equal(center.cy, 215);
    assert.equal(upper.cy, 215 - 33);
    assert.equal(lower.cy, 215 + 33);
    assert.equal(scene.interiorVisibleAt(0, center.cx, center.cy, true, 0), true);
    assert.equal(scene.interiorVisibleAt(0, upper.cx, upper.cy, true, -33), true);
    assert.equal(scene.interiorVisibleAt(0, lower.cx, lower.cy, true, 33), true);
    assert.equal(scene.interiorVisibleAt(0, 200, upper.cy + 80, true, -33), false);
    assert.equal(scene.interiorVisibleAt(0, 200, lower.cy - 80, true, 33), false);
    assert.equal(scene.interiorVisibleAt(0, center.cx, center.cy, false, 0), false);
    assert.equal(regionAt(-33), 1);
    assert.equal(regionAt(-36), 0);
    assert.equal(scene.interiorPixelsOpen({ status: "paused", hardwareHealthy: true, effectivePower: 1 }), false);
    assert.equal(regionAt(scene.positionForRegionAim(1)), 1);
    assert.equal(scene.incubationControlsVisible("completed"), false);
  });
});
