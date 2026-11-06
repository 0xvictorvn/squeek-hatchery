import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { randomUUID } from "node:crypto";
import { HatcheryBackend } from "../src/backend.ts";
import { createHatcheryHttpServer } from "../src/server.ts";
import * as gamePolicyModule from "../src/game-policy.ts";
import * as ledSessionModule from "../src/led-session.ts";

describe("Round 3 Regressions & Clarifications (R11-R13, C1-C4)", () => {
  test("R11: Stalled hardware telemetry times out on backend, expires on client before Guest growth steps, preserves replay baseline across outage, and ignores late stale responses", async () => {
    // 1. Bounded provider timeout must retain a still-valid cached observation (R18),
    // then reject only after the original observation deadline; explicit recovery works.
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const observed0 = nowMs;
    let providerMode: "live" | "hang" | "recover" = "live";
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
      autoStartProducer: false,
      hardwareTimeoutMs: 120,
      hardwareProvider: async () => {
        if (providerMode === "hang") {
          return new Promise<never>(() => {});
        }
        const rpmMilli = providerMode === "recover" ? 52000 : 65000;
        const work = providerMode === "recover" ? "1100" : "1000";
        const distanceMm = providerMode === "recover" ? 110000 : 100000;
        const at = providerMode === "recover" ? nowMs : observed0;
        return {
          source: "live",
          statusPayload: {
            schemaVersion: 1,
            installationId: "r11-stall-wheel",
            measurement: {
              provenance: "hardware",
              freshness: "online",
              coreStatus: "ACTIVE",
              rpmMilli,
              cumulativeWorkUnits: work,
              distanceMm,
              counterEpoch: "epoch-1",
              observedAt: new Date(at).toISOString(),
              receivedAt: new Date(at).toISOString(),
              staleAfterSeconds: 60,
            },
          },
        };
      },
    } as ConstructorParameters<typeof HatcheryBackend>[0] & { hardwareTimeoutMs?: number });

    try {
      const wallet = "0x1111111111111111111111111111111111111111";
      const egg = backend.claimRankedEgg(wallet, { familyIndex: 0, lampPosition: -70 });
      const started = await backend.startRankedIllumination(wallet, { sessionId: egg.id });
      assert.equal(started.session.status, "running");

      // Transport outage while original observation is still valid: serve cache, do not 503.
      providerMode = "hang";
      nowMs += 2_000;
      const duringOutage = await backend.getHardwareTelemetry();
      assert.equal(duringOutage.reading.observedAt, observed0);
      assert.equal(duringOutage.reading.rpm, 65);

      // Past the original observation deadline (60s TTL under current policy): reject.
      nowMs = observed0 + 61_000;
      await assert.rejects(
        async () => backend.getHardwareTelemetry(),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 503,
      );

      // Explicit producer recovery with a fresh observation.
      providerMode = "recover";
      nowMs += 1_000;
      await backend.pollProducerTick();
      const recovered = await backend.getHardwareTelemetry();
      assert.equal(recovered.reading.rpm, 52);
    } finally {
      backend.close();
    }

    // 2. Client telemetry tracker: expires reading after 15s during stalled request, preserves replay baseline, rejects older replay after outage, and recovers on newer sample
    const createClientTelemetryTracker = (
      ledSessionModule as Record<string, unknown>
    ).createClientTelemetryTracker as
      | ((opts?: { now?: () => number; policy?: unknown }) => {
          ingestStatusPayload: (raw: unknown, requestSeq?: number) => {
            healthy: boolean;
            reading: { rpm: number; observedAt: number; received: number } | null;
            error: string | null;
          };
          recordPollFailure: (message: string, requestSeq?: number) => void;
          checkFreshnessForStep: (nowMs?: number) => {
            healthy: boolean;
            reading: { rpm: number; observedAt: number; received: number } | null;
            error: string | null;
          };
          beginRequest: () => number;
        })
      | undefined;

    assert.equal(
      typeof createClientTelemetryTracker,
      "function",
      "createClientTelemetryTracker must be exported for client freshness & replay gating",
    );

    let clientClock = Date.parse("2026-11-06T13:00:00.000Z");
    const tracker = createClientTelemetryTracker!({
      now: () => clientClock,
      policy: gamePolicyModule.EXPERIMENTAL_POLICY_V2,
    });

    const seq1 = tracker.beginRequest();
    const res1 = tracker.ingestStatusPayload(
      {
        schemaVersion: 1,
        installationId: "r11-client-wheel",
        measurement: {
          provenance: "hardware",
          freshness: "online",
          coreStatus: "ACTIVE",
          rpmMilli: 65000,
          cumulativeWorkUnits: "1000",
          distanceMm: 100000,
          counterEpoch: "1",
          observedAt: new Date(clientClock).toISOString(),
          receivedAt: new Date(clientClock).toISOString(),
          staleAfterSeconds: 60,
        },
      },
      seq1,
    );
    assert.equal(res1.healthy, true);
    assert.equal(res1.reading?.rpm, 65);

    // At +10s (within 15s freshness cap), reading is still fresh
    clientClock += 10_000;
    assert.equal(tracker.checkFreshnessForStep(clientClock).healthy, true);

    // At +15.1s (while subsequent network poll is stalled/pending), checkFreshnessForStep MUST expire and mark healthy = false!
    clientClock += 5_100;
    const expiredCheck = tracker.checkFreshnessForStep(clientClock);
    assert.equal(expiredCheck.healthy, false);
    assert.ok(expiredCheck.error && expiredCheck.error.length > 0);

    // Record a transient poll failure; last accepted replay baseline must STILL be retained!
    const seq2 = tracker.beginRequest();
    tracker.recordPollFailure("Telemetry request timed out", seq2);

    // Attempt to feed an older observedAt (replay) after failure -> must be rejected!
    const seq3 = tracker.beginRequest();
    const replayAttempt = tracker.ingestStatusPayload(
      {
        schemaVersion: 1,
        installationId: "r11-client-wheel",
        measurement: {
          provenance: "hardware",
          freshness: "online",
          coreStatus: "ACTIVE",
          rpmMilli: 65000,
          cumulativeWorkUnits: "1000",
          distanceMm: 100000,
          counterEpoch: "1",
          observedAt: new Date(clientClock - 20_000).toISOString(),
          receivedAt: new Date(clientClock).toISOString(),
          staleAfterSeconds: 60,
        },
      },
      seq3,
    );
    assert.equal(replayAttempt.healthy, false);

    // Attempt equal-observation timestamp with refreshed receivedAt -> must NOT extend freshness!
    const seq4 = tracker.beginRequest();
    const equalObsAttempt = tracker.ingestStatusPayload(
      {
        schemaVersion: 1,
        installationId: "r11-client-wheel",
        measurement: {
          provenance: "hardware",
          freshness: "online",
          coreStatus: "ACTIVE",
          rpmMilli: 65000,
          cumulativeWorkUnits: "1000",
          distanceMm: 100000,
          counterEpoch: "1",
          observedAt: new Date(Date.parse("2026-11-06T13:00:00.000Z")).toISOString(),
          receivedAt: new Date(clientClock).toISOString(),
          staleAfterSeconds: 60,
        },
      },
      seq4,
    );
    assert.equal(equalObsAttempt.healthy, false);

    // Now feed a genuinely fresh hardware reading -> recovers!
    const staleSeq = tracker.beginRequest();
    const freshSeq = tracker.beginRequest();
    const recovered = tracker.ingestStatusPayload(
      {
        schemaVersion: 1,
        installationId: "r11-client-wheel",
        measurement: {
          provenance: "hardware",
          freshness: "online",
          coreStatus: "ACTIVE",
          rpmMilli: 52000,
          cumulativeWorkUnits: "1050",
          distanceMm: 105000,
          counterEpoch: "1",
          observedAt: new Date(clientClock).toISOString(),
          receivedAt: new Date(clientClock).toISOString(),
          staleAfterSeconds: 60,
        },
      },
      freshSeq,
    );
    assert.equal(recovered.healthy, true);
    assert.equal(recovered.reading?.rpm, 52);

    // Late response from staleSeq (older request) must NOT overwrite recovered state
    tracker.recordPollFailure("Late failure from older request", staleSeq);
    assert.equal(tracker.checkFreshnessForStep(clientClock).healthy, true);
    assert.equal(tracker.checkFreshnessForStep(clientClock).reading?.rpm, 52);
  });

  test("R12: Persisted session keeps its original immutable policy across backend restart and policy upgrade", async () => {
    let now = Date.parse("2026-11-06T01:00:00Z");
    const dbFile = path.resolve(process.cwd(), "cache", `r12-policy-${randomUUID()}.sqlite`);
    const wallet = "0x1234567890123456789012345678901234567890";
    const provider = () => ({
      source: "live" as const,
      statusPayload: {
        schemaVersion: 1,
        installationId: "policy-review-device",
        measurement: {
          provenance: "hardware",
          freshness: "online",
          coreStatus: "ACTIVE",
          rpmMilli: 65000,
          cumulativeWorkUnits: "1000",
          distanceMm: 100000,
          counterEpoch: "1",
          observedAt: new Date(now).toISOString(),
          receivedAt: new Date(now).toISOString(),
          staleAfterSeconds: 60,
        },
      },
    });

    const oldBackend = new HatcheryBackend({
      dbPath: dbFile,
      now: () => now,
      hardwareProvider: provider,
      policy: gamePolicyModule.EXPERIMENTAL_POLICY_V1,
    });
    let reopened: HatcheryBackend | null = null;
    try {
      const egg = oldBackend.claimRankedEgg(wallet, { familyIndex: 0, lampPosition: -70 });
      assert.equal(egg.policyVersion, "exp-v1-2026-11-06");
      await oldBackend.startRankedIllumination(wallet, { sessionId: egg.id });
      oldBackend.close();

      const changedPolicy: gamePolicyModule.GamePolicy = {
        ...gamePolicyModule.EXPERIMENTAL_POLICY_V1,
        version: "review-v2-30s",
        durationSeconds: 30,
      };
      reopened = new HatcheryBackend({
        dbPath: dbFile,
        now: () => now,
        hardwareProvider: provider,
        policy: changedPolicy,
      });

      // Advance 20s + 10s = 30s. Because egg was created under 60s v1 policy, completion at 30s MUST be rejected!
      now += 20_000;
      await reopened.tickRankedSession(wallet, { sessionId: egg.id });
      now += 10_000;
      const tick30 = await reopened.tickRankedSession(wallet, { sessionId: egg.id });
      assert.equal(tick30.session.elapsed, 30);
      assert.equal(tick30.session.policyVersion, "exp-v1-2026-11-06");
      assert.equal(tick30.readyToComplete, false);

      await assert.rejects(
        async () => reopened!.completeRankedSession(wallet, { sessionId: egg.id }),
        (err: unknown) => (err as { statusCode?: number }).statusCode === 400,
      );

      // Advance remaining 30s (20s + 10s = 60s total) -> completes under original policy exp-v1-2026-11-06!
      now += 20_000;
      await reopened.tickRankedSession(wallet, { sessionId: egg.id });
      now += 10_000;
      const tick60 = await reopened.tickRankedSession(wallet, { sessionId: egg.id });
      assert.equal(tick60.session.elapsed, 60);
      assert.equal(tick60.readyToComplete, true);

      const result = await reopened.completeRankedSession(wallet, { sessionId: egg.id });
      assert.equal(result.snapshot.policyVersion, "exp-v1-2026-11-06");
      assert.equal(
        reopened.getWeeklyLeaderboard({ policyVersion: "exp-v1-2026-11-06" }).entries.length,
        1,
      );
      assert.equal(reopened.getWeeklyLeaderboard().entries.length, 0);

      // Idempotent completion and public result lookup preserve v1 policy and rank
      const repeat = await reopened.completeRankedSession(wallet, { sessionId: egg.id });
      assert.equal(repeat.idempotent, true);
      assert.equal(repeat.snapshot.policyVersion, "exp-v1-2026-11-06");
      const pub = reopened.getPublicResultById(result.resultId);
      assert.equal(pub.snapshot.policyVersion, "exp-v1-2026-11-06");
      assert.equal(pub.leaderboardRank, 1);
    } finally {
      try {
        oldBackend.close();
      } catch {
        // already closed
      }
      reopened?.close();
      for (const suffix of ["", "-wal", "-shm"]) {
        try {
          if (fs.existsSync(dbFile + suffix)) fs.rmSync(dbFile + suffix, { force: true });
        } catch {
          // ignore
        }
      }
    }
  });

  test("R13: Production app source does not expose advanceGuestSeconds time-advance bypass", () => {
    const appSource = fs.readFileSync(
      path.resolve(process.cwd(), "src", "app.ts"),
      "utf8",
    );
    assert.equal(
      appSource.includes("advanceGuestSeconds"),
      false,
      "src/app.ts must not expose advanceGuestSeconds",
    );
  });

  test("C2: EXPERIMENTAL_POLICY_V2 implements aesthetic backgroundPoints [1,2,2,1,2,1,1,4,4,8] and midpoint probability model [2853,2796,2796,2853,2796,2853,2853,1296,1296,864] / 23256", () => {
    // 1. V1 remains intact
    assert.equal(gamePolicyModule.EXPERIMENTAL_POLICY_V1.version, "exp-v1-2026-11-06");
    assert.deepEqual(
      gamePolicyModule.EXPERIMENTAL_POLICY_V1.backgroundPoints,
      [1, 1, 1, 1, 2, 2, 2, 4, 4, 8],
    );

    // 2. V2 exists and is the default policy
    const v2 = (gamePolicyModule as Record<string, unknown>).EXPERIMENTAL_POLICY_V2 as
      | gamePolicyModule.GamePolicy
      | undefined;
    const defaultPolicy = (gamePolicyModule as Record<string, unknown>).DEFAULT_GAME_POLICY as
      | gamePolicyModule.GamePolicy
      | undefined;
    const deriveBackgroundRarityModel = (
      gamePolicyModule as Record<string, unknown>
    ).deriveBackgroundRarityModel as
      | ((policy?: gamePolicyModule.GamePolicy, profile?: { referenceDistanceMm: number; referenceWorkUnits: number }) => {
          paletteTotalWindows: number;
          accessoryTotalWindows: number;
          paletteTierCounts: Record<1 | 2 | 4 | 8, number>;
          accessoryTierCounts: Record<1 | 2 | 4 | 8, number>;
          tierProbabilities: Record<1 | 2 | 4 | 8, number>;
          backgroundWeights: number[];
          totalWeight: number;
        })
      | undefined;

    assert.ok(v2, "EXPERIMENTAL_POLICY_V2 must be exported");
    assert.ok(defaultPolicy, "DEFAULT_GAME_POLICY must be exported");
    assert.equal(v2.version, "exp-v2-2026-11-06");
    assert.deepEqual(v2.backgroundPoints, [1, 2, 2, 1, 2, 1, 1, 4, 4, 8]);
    assert.equal(typeof deriveBackgroundRarityModel, "function");

    const model = deriveBackgroundRarityModel!(v2);
    assert.equal(model.paletteTotalWindows, 51);
    assert.equal(model.accessoryTotalWindows, 57);
    assert.deepEqual(model.paletteTierCounts, { 1: 25, 2: 18, 4: 6, 8: 2 });
    assert.deepEqual(model.accessoryTierCounts, { 1: 28, 2: 21, 4: 6, 8: 2 });
    assert.deepEqual(
      model.backgroundWeights,
      [2853, 2796, 2796, 2853, 2796, 2853, 2853, 1296, 1296, 864],
    );
    assert.equal(model.totalWeight, 23256);
    assert.deepEqual(
      v2.backgroundWeights,
      [2853, 2796, 2796, 2853, 2796, 2853, 2853, 1296, 1296, 864],
    );

    const probSum =
      model.tierProbabilities[1] +
      model.tierProbabilities[2] +
      model.tierProbabilities[4] +
      model.tierProbabilities[8];
    assert.ok(Math.abs(probSum - 1) < 1e-12);
    assert.ok(Math.abs(model.tierProbabilities[1] - (25 / 51 + 28 / 57) / 2) < 1e-12);
    assert.ok(Math.abs(model.tierProbabilities[2] - (18 / 51 + 21 / 57) / 2) < 1e-12);
    assert.ok(Math.abs(model.tierProbabilities[4] - (6 / 51 + 6 / 57) / 2) < 1e-12);
    assert.ok(Math.abs(model.tierProbabilities[8] - (2 / 51 + 2 / 57) / 2) < 1e-12);

    // Rejects invalid calibration profile inputs
    assert.throws(() =>
      deriveBackgroundRarityModel!(v2, { referenceDistanceMm: -100, referenceWorkUnits: 5694 }),
    );
    assert.throws(() =>
      deriveBackgroundRarityModel!(v2, { referenceDistanceMm: 5000000, referenceWorkUnits: -1 }),
    );
  });

  test("C1: Direct /result/<resultId> route serves index.html, resolves nested /result/assets/* with proper MIME, returns 404 on missing assets, and preserves /nft/<resultId> alias", async () => {
    const { backend, server } = createHatcheryHttpServer({ dbPath: ":memory:" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const htmlRes = await fetch(`${baseUrl}/result/not-found`);
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/i);
      const htmlText = await htmlRes.text();

      const scriptMatch = htmlText.match(/src="\.\/assets\/([^"]+\.js)"/);
      assert.ok(scriptMatch, "Expected relative ./assets/*.js script tag in dist/index.html");
      const jsFile = scriptMatch[1]!;

      const jsRes = await fetch(`${baseUrl}/result/assets/${jsFile}`);
      assert.equal(jsRes.status, 200);
      assert.match(jsRes.headers.get("content-type") ?? "", /javascript/i);

      const missingRes = await fetch(`${baseUrl}/result/assets/does-not-exist.js`);
      assert.equal(missingRes.status, 404);

      const aliasRes = await fetch(`${baseUrl}/nft/not-found`);
      assert.equal(aliasRes.status, 200);
      assert.match(aliasRes.headers.get("content-type") ?? "", /text\/html/i);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      backend.close();
    }
  });
});
