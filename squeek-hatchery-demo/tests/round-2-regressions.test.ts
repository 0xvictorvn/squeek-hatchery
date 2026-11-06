import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { HatcheryBackend } from "../src/backend.ts";
import { createHatcheryHttpServer } from "../src/server.ts";
import * as ledSessionModule from "../src/led-session.ts";
import { measurementDayKey, type Reading } from "../src/rules.ts";

const TEST_PK_1 =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const account1 = privateKeyToAccount(TEST_PK_1);

function makeReading(overrides: Partial<Reading> = {}, nowMs = Date.now()): Reading {
  const observedAt = overrides.observedAt ?? nowMs;
  return {
    coreStatus: "ACTIVE",
    rpm: 36,
    meters: 250,
    distanceMm: 250_000,
    work: 250n,
    counterEpoch: "1",
    installationId: "wheel-test-1",
    observedAt,
    received: overrides.received ?? nowMs,
    staleAfterSeconds: 60,
    utcDate: overrides.utcDate ?? measurementDayKey(observedAt),
    ...overrides,
  };
}

function makeV1Payload(
  overrides: Partial<{
    installationId: string;
    provenance: string;
    freshness: string;
    coreStatus: string;
    rpmMilli: number;
    distanceMm: number;
    cumulativeWorkUnits: string;
    counterEpoch: string;
    observedAt: string;
    receivedAt: string;
    staleAfterSeconds: number;
  }> = {},
  nowMs = Date.now(),
) {
  const obsIso = overrides.observedAt ?? new Date(nowMs).toISOString();
  const recIso = overrides.receivedAt ?? new Date(nowMs).toISOString();
  return {
    schemaVersion: 1,
    installationId: overrides.installationId ?? "inst-r2-test",
    measurement: {
      provenance: overrides.provenance ?? "hardware",
      freshness: overrides.freshness ?? "online",
      coreStatus: overrides.coreStatus ?? "ACTIVE",
      rpmMilli: overrides.rpmMilli ?? 36000,
      distanceMm: overrides.distanceMm ?? 250000,
      cumulativeWorkUnits: overrides.cumulativeWorkUnits ?? "250",
      counterEpoch: overrides.counterEpoch ?? "1",
      observedAt: obsIso,
      receivedAt: recIso,
      staleAfterSeconds: overrides.staleAfterSeconds ?? 60,
    },
  };
}

async function signInTestWallet(backend: HatcheryBackend, origin = "http://localhost:4173") {
  const domain = new URL(origin).host;
  const chal = backend.createAuthChallenge({
    walletAddress: account1.address,
    chainId: 11155111,
    origin,
    domain,
  });
  const signature = await account1.signMessage({ message: chal.message });
  return backend.verifyAuthChallenge({
    challengeId: chal.challengeId,
    walletAddress: account1.address,
    signature,
    origin,
    domain,
    chainId: 11155111,
  });
}

describe("Round 2 Regressions (R1-R9)", () => {
  it("R1: fetches https://api.squeekchain.com/v1/status, fails closed when upstream is down/stale, and never invents 42 RPM fallback for Ranked play", async () => {
    let nowMs = Date.parse("2026-11-06T12:05:00.000Z");
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      throw new Error("Simulated upstream network failure");
    }) as typeof fetch;

    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
    });

    try {
      await signInTestWallet(backend);
      const egg = backend.claimRankedEgg(account1.address, { familyId: "pulse" });

      // Attempting to start ranked illumination when upstream is offline must fail closed (503)
      await assert.rejects(
        async () => {
          await backend.startRankedIllumination(account1.address, {
            sessionId: egg.id,
            lampPosition: -70,
          });
        },
        (err: { statusCode?: number; message?: string }) => {
          assert.equal(err.statusCode, 503);
          return true;
        },
      );

      assert.ok(
        requestedUrls.includes("https://api.squeekchain.com/v1/status"),
        `Expected fetch to https://api.squeekchain.com/v1/status, got: ${requestedUrls.join(", ")}`,
      );
      assert.ok(
        !requestedUrls.some((u) => u.includes("api.squeek.online")),
        "Must never fetch legacy api.squeek.online URL",
      );

      // Now provide one valid schemaVersion: 1 reading at t=0, then advance 10 minutes with upstream down
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        requestedUrls.push(String(input));
        return new Response(JSON.stringify(makeV1Payload({}, nowMs)), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;

      const started = await backend.startRankedIllumination(account1.address, {
        sessionId: egg.id,
        lampPosition: -70,
      });
      assert.equal(started.session.status, "running");

      // Advance 10 minutes and make upstream fail; cached telemetry must be rejected as stale
      nowMs += 10 * 60 * 1000;
      globalThis.fetch = (async () => {
        throw new Error("Upstream offline after 10 minutes");
      }) as typeof fetch;

      await assert.rejects(
        async () => {
          await backend.getHardwareTelemetry();
        },
        (err: { statusCode?: number }) => {
          assert.equal(err.statusCode, 503);
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
      backend.close();
    }
  });

  it("R2: Ranked session cannot complete at 0s or <60s; requires full 60s illumination before completion", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        statusPayload: makeV1Payload({}, nowMs),
        source: "live",
      }),
    });

    try {
      await signInTestWallet(backend);
      const egg = backend.claimRankedEgg(account1.address, { familyId: "pulse" });
      await backend.startRankedIllumination(account1.address, {
        sessionId: egg.id,
        lampPosition: -70,
      });

      // Immediate complete at 0s must be rejected with 400
      await assert.rejects(
        async () => {
          await backend.completeRankedSession(account1.address, { sessionId: egg.id });
        },
        (err: { statusCode?: number }) => {
          assert.equal(err.statusCode, 400);
          return true;
        },
      );

      assert.equal(backend.getWeeklyLeaderboard().entries.length, 0);
      const activeAfterReject = await backend.getActiveRankedSession(account1.address);
      assert.ok(activeAfterReject);
      assert.equal(activeAfterReject.backgroundIndex, null);

      // Advance 15 valid 4-second ticks = 60s total
      for (let i = 0; i < 15; i++) {
        nowMs += 4000;
        await backend.tickRankedSession(account1.address, {
          sessionId: egg.id,
          lampPosition: -70,
        });
      }

      const completed = await backend.completeRankedSession(account1.address, {
        sessionId: egg.id,
      });
      assert.equal(completed.idempotent, false);
      assert.equal(completed.snapshot.levels[0], 10);
      assert.equal(backend.getWeeklyLeaderboard().entries.length, 1);
    } finally {
      backend.close();
    }
  });

  it("R3: Long unobserved gap (e.g. 30 minutes) resets current-rule attempts instead of backfilling growth", async () => {
    let nowMs = Date.parse("2026-11-06T14:00:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        statusPayload: makeV1Payload({}, nowMs),
        source: "live",
      }),
    });

    try {
      await signInTestWallet(backend);
      const egg = backend.claimRankedEgg(account1.address, { familyId: "relay" });
      await backend.startRankedIllumination(account1.address, {
        sessionId: egg.id,
        lampPosition: 0,
      });

      // Jump +30 minutes without heartbeats
      nowMs += 30 * 60 * 1000;
      const active = await backend.getActiveRankedSession(account1.address);
      assert.ok(active);
      assert.equal(active.elapsed, 0);
      assert.deepEqual(
        active.regions.map((r) => r.level),
        [0, 0, 0],
      );
      // Current rules: activity gap resets the attempt and clears rare locks (keeps egg/species).
      assert.equal(active.status, "egg");
      assert.equal(active.lockedTraits, null);
      assert.equal(active.familyId, "relay");

      // Attempting to complete after the gap must still fail with 400
      await assert.rejects(
        async () => {
          await backend.completeRankedSession(account1.address, { sessionId: egg.id });
        },
        (err: { statusCode?: number }) => {
          assert.equal(err.statusCode, 400);
          return true;
        },
      );
    } finally {
      backend.close();
    }
  });

  it("R4: Changing lampPosition in tick or start accrues the past step to the previously aimed region first", async () => {
    let nowMs = Date.parse("2026-11-06T15:00:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        statusPayload: makeV1Payload({ rpmMilli: 65000 }, nowMs),
        source: "live",
      }),
    });

    try {
      await signInTestWallet(backend);
      const egg = backend.claimRankedEgg(account1.address, {
        familyId: "prism",
        lampPosition: -70, // Head
      });
      await backend.startRankedIllumination(account1.address, {
        sessionId: egg.id,
        lampPosition: -70,
      });

      // After 4s of aiming at Head (-70), send tick with new lampPosition = 70 (Lower)
      nowMs += 4000;
      const ticked = await backend.tickRankedSession(account1.address, {
        sessionId: egg.id,
        lampPosition: 70,
      });

      assert.equal(
        ticked.session.regions[0].dose,
        4,
        "Past 4s interval must be accrued to Head (region 0), not Lower (region 2)",
      );
      assert.equal(ticked.session.regions[2].dose, 0);
      assert.equal(ticked.session.lampPosition, 70);

      // Next 4s interval should accrue to Lower (region 2)
      nowMs += 4000;
      const ticked2 = await backend.tickRankedSession(account1.address, {
        sessionId: egg.id,
      });
      assert.equal(ticked2.session.regions[0].dose, 4);
      assert.equal(ticked2.session.regions[2].dose, 4);
    } finally {
      backend.close();
    }
  });

  it("R5: Persists daily baseline and schedule state in SQLite across backend restarts and mid-day boots", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "squeek-r5-"));
    const dbPath = path.join(tmpDir, "r5.sqlite");
    let backend1: HatcheryBackend | null = null;
    let backend2: HatcheryBackend | null = null;

    try {
      const tBeforeRollover = Date.parse("2026-11-06T11:59:50.000Z");
      const tAfterRollover = Date.parse("2026-11-06T12:00:10.000Z");
      const tAfterRestart = Date.parse("2026-11-06T12:00:20.000Z");

      backend1 = new HatcheryBackend({
        dbPath,
        now: () => tBeforeRollover,
      });
      const initialMidDay = backend1.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-persist",
            counterEpoch: "1",
            distanceMm: 500_000,
            cumulativeWorkUnits: "1000",
          },
          tBeforeRollover,
        ),
        "live",
        tBeforeRollover,
      );
      assert.equal(
        initialMidDay.dayStartWorkUnits,
        "1000",
        "Cold-start mid-day must anchor dayStartWorkUnits to first observed reading (not 0)",
      );
      assert.equal(initialMidDay.serializedAccessorySchedule.step, "0");

      const beforeRestart = backend1.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-persist",
            counterEpoch: "1",
            distanceMm: 150_000,
            cumulativeWorkUnits: "1250",
          },
          tAfterRollover,
        ),
        "live",
        tAfterRollover,
      );
      assert.equal(beforeRestart.dayStartWorkUnits, "1000");
      assert.equal(beforeRestart.serializedAccessorySchedule.step, "2");
      backend1.close();
      backend1 = null;

      // Restart backend on the same SQLite DB
      backend2 = new HatcheryBackend({
        dbPath,
        now: () => tAfterRestart,
      });
      const afterRestart = backend2.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-persist",
            counterEpoch: "1",
            distanceMm: 160_000,
            cumulativeWorkUnits: "1260",
          },
          tAfterRestart,
        ),
        "live",
        tAfterRestart,
      );
      assert.equal(
        afterRestart.dayStartWorkUnits,
        "1000",
        "dayStartWorkUnits must survive backend restart",
      );
      assert.equal(
        afterRestart.serializedAccessorySchedule.step,
        "2",
        "Accessory schedule step must remain 2 after restart, not jump to 12",
      );
      assert.equal(afterRestart.dailyDistanceMm, 160_000);
    } finally {
      try {
        backend1?.close();
      } catch {
        // ignore
      }
      try {
        backend2?.close();
      } catch {
        // ignore
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("R6: Does not drop valid work or distance deltas when a sample arrives with coreStatus === IDLE", () => {
    const t0 = Date.parse("2026-11-06T12:10:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => t0,
    });

    try {
      const s1 = backend.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-idle-delta",
            coreStatus: "ACTIVE",
            rpmMilli: 32000,
            distanceMm: 87800,
            cumulativeWorkUnits: "100",
          },
          t0,
        ),
        "live",
        t0,
      );
      // Cold start mid-day re-anchors dayStartWorkUnits to first observed reading (100)
      const s2 = backend.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-idle-delta",
            coreStatus: "IDLE",
            rpmMilli: 0,
            distanceMm: 175600,
            cumulativeWorkUnits: "200",
          },
          t0 + 5000,
        ),
        "live",
        t0 + 5000,
      );
      const s3 = backend.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-idle-delta",
            coreStatus: "ACTIVE",
            rpmMilli: 25000,
            distanceMm: 176478,
            cumulativeWorkUnits: "201",
          },
          t0 + 10000,
        ),
        "live",
        t0 + 10000,
      );

      // Total delta from s1 (100 work, 87800mm) to s3 (201 work, 176478mm) is +101 work, +88678mm
      const workGain = BigInt(s3.cumulativeWorkUnits) - BigInt(s1.cumulativeWorkUnits);
      const distGain = s3.scheduleDistanceMm - s1.scheduleDistanceMm;
      assert.equal(workGain, 101n, "Must not lose the +100 work delta reported on the IDLE sample");
      assert.equal(
        distGain,
        88678,
        "Must not lose the +87800mm distance delta reported on the IDLE sample",
      );
      assert.equal(BigInt(s2.cumulativeWorkUnits) - BigInt(s1.cumulativeWorkUnits), 100n);
    } finally {
      backend.close();
    }
  });

  it("R7: Direct /nft/<resultId> route serves index.html while /nft/assets/* serves JS/CSS with proper MIME types and missing assets return 404", async () => {
    const { server, backend } = createHatcheryHttpServer({ dbPath: ":memory:" });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const htmlRes = await fetch(`${baseUrl}/nft/not-found`);
      assert.equal(htmlRes.status, 200);
      assert.match(htmlRes.headers.get("content-type") ?? "", /text\/html/);
      const htmlText = await htmlRes.text();

      const jsMatch = htmlText.match(/src="\.\/assets\/([^"]+\.js)"/);
      if (jsMatch) {
        const assetFile = jsMatch[1];
        const nestedAssetRes = await fetch(`${baseUrl}/nft/assets/${assetFile}`);
        assert.equal(nestedAssetRes.status, 200);
        assert.match(
          nestedAssetRes.headers.get("content-type") ?? "",
          /application\/javascript/,
          "/nft/assets/*.js must serve application/javascript, never text/html",
        );
      }

      const missingAssetRes = await fetch(`${baseUrl}/nft/assets/nonexistent-bundle.js`);
      assert.equal(missingAssetRes.status, 404);
    } finally {
      server.close();
      backend.close();
    }
  });

  it("R8: Clearing display name reverts to shortened wallet address across Profile, Weekly Leaderboard, and Public NFT detail", async () => {
    let nowMs = Date.parse("2026-11-06T16:00:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({
        statusPayload: makeV1Payload({}, nowMs),
        source: "live",
      }),
    });

    try {
      await signInTestWallet(backend);
      backend.updatePlayerDisplayName(account1.address, "Reviewer old name");

      const egg = backend.claimRankedEgg(account1.address, { familyId: "pulse" });
      await backend.startRankedIllumination(account1.address, {
        sessionId: egg.id,
        lampPosition: -70,
      });
      for (let i = 0; i < 15; i++) {
        nowMs += 4000;
        await backend.tickRankedSession(account1.address, { sessionId: egg.id });
      }
      const completed = await backend.completeRankedSession(account1.address, {
        sessionId: egg.id,
      });
      assert.equal(completed.snapshot.effectivePlayerName, "Reviewer old name");

      // Now clear display name
      const clearedProfile = backend.updatePlayerDisplayName(account1.address, "");
      assert.equal(clearedProfile.displayName, null);
      assert.equal(clearedProfile.effectiveName, clearedProfile.shortWallet);

      const board = backend.getWeeklyLeaderboard();
      assert.equal(board.entries[0]?.displayName, null);
      assert.equal(board.entries[0]?.effectiveName, clearedProfile.shortWallet);

      const publicNft = backend.getPublicResultById(completed.resultId);
      assert.equal(publicNft.player.displayName, null);
      assert.equal(publicNft.player.effectiveName, clearedProfile.shortWallet);
      assert.equal(publicNft.snapshot.effectivePlayerName, clearedProfile.shortWallet);
    } finally {
      backend.close();
    }
  });

  it("R9: Stage render state shows only hamster (accessory: -1, background: -1) during egg/running/paused, and reveals accessory + background only when completed", () => {
    const getStageRenderState = (
      ledSessionModule as Record<string, unknown>
    ).getStageRenderStateForSession as
      | ((
          session: ledSessionModule.LedSession,
          completedSnapshot: ledSessionModule.CharacterSnapshot | null,
          fallbackPaletteIndex?: number,
        ) => {
          family: 0 | 1 | 2;
          levels: [number, number, number];
          palette: number;
          accessory: number;
          background: number;
        })
      | undefined;

    assert.equal(
      typeof getStageRenderState,
      "function",
      "getStageRenderStateForSession must be exported from src/led-session.ts",
    );

    const session = ledSessionModule.createLedSession({
      mode: "ranked",
      familyIndex: 1,
    });

    // 1. Egg state
    const eggState = getStageRenderState!(session, null, 3);
    assert.equal(eggState.accessory, -1);
    assert.equal(eggState.background, -1);
    assert.equal(eggState.palette, 3);

    // 2. Running state (even with locked traits!)
    ledSessionModule.lockSessionTraits(session, makeReading(), 0n);
    assert.equal(session.status, "running");
    const runningState = getStageRenderState!(session, null, 3);
    assert.equal(runningState.accessory, -1, "Running state must hide accessory on stage");
    assert.equal(runningState.background, -1, "Running state must hide NFT background on stage");
    assert.equal(runningState.palette, session.lockedTraits!.paletteIndex);

    // 3. Paused state
    session.status = "paused";
    const pausedState = getStageRenderState!(session, null, 3);
    assert.equal(pausedState.accessory, -1, "Paused state must hide accessory on stage");
    assert.equal(pausedState.background, -1, "Paused state must hide NFT background on stage");

    // 4. Completed state
    session.status = "completed";
    session.backgroundIndex = 7;
    session.backgroundId = "bg-7";
    const snapshot = ledSessionModule.buildCharacterSnapshot(session);
    const completedState = getStageRenderState!(session, snapshot, 3);
    assert.equal(completedState.accessory, snapshot.accessoryIndex);
    assert.equal(completedState.background, snapshot.backgroundIndex);
    assert.equal(completedState.palette, snapshot.paletteIndex);
  });

  it("R1 extended: rejects COUNTER_FAULT, simulated provenance, stale freshness, replayed older observedAt, and equal-timestamp freshness extension", () => {
    const t0 = Date.parse("2026-11-06T17:00:00.000Z");
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      now: () => t0,
    });

    try {
      // 1. Valid baseline reading
      const valid = backend.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-strict",
            counterEpoch: "1",
            cumulativeWorkUnits: "500",
            distanceMm: 100_000,
            observedAt: new Date(t0).toISOString(),
            receivedAt: new Date(t0).toISOString(),
          },
          t0,
        ),
        "live",
        t0,
      );
      assert.equal(valid.reading.received, t0);

      // 2. Equal-timestamp receipt at t0 + 5s must NOT extend `received`
      const repeated = backend.ingestHardwareReading(
        makeV1Payload(
          {
            installationId: "inst-strict",
            counterEpoch: "1",
            cumulativeWorkUnits: "500",
            distanceMm: 100_000,
            observedAt: new Date(t0).toISOString(),
            receivedAt: new Date(t0 + 5000).toISOString(),
          },
          t0 + 5000,
        ),
        "live",
        t0 + 5000,
      );
      assert.equal(
        repeated.reading.received,
        t0,
        "Equal-timestamp observation must preserve initial received timestamp",
      );

      // 3. Replayed older observedAt must be rejected (503)
      assert.throws(
        () => {
          backend.ingestHardwareReading(
            makeV1Payload(
              {
                installationId: "inst-strict",
                counterEpoch: "1",
                cumulativeWorkUnits: "510",
                distanceMm: 101_000,
                observedAt: new Date(t0 - 1000).toISOString(),
                receivedAt: new Date(t0 + 6000).toISOString(),
              },
              t0 + 6000,
            ),
            "live",
            t0 + 6000,
          );
        },
        (err: { statusCode?: number; message?: string }) => {
          assert.equal(err.statusCode, 503);
          assert.match(err.message ?? "", /replay/i);
          return true;
        },
      );

      // 4. COUNTER_FAULT must be rejected (503)
      assert.throws(
        () => {
          backend.ingestHardwareReading(
            makeV1Payload(
              {
                installationId: "inst-strict",
                counterEpoch: "1",
                coreStatus: "COUNTER_FAULT",
                observedAt: new Date(t0 + 7000).toISOString(),
                receivedAt: new Date(t0 + 7000).toISOString(),
              },
              t0 + 7000,
            ),
            "live",
            t0 + 7000,
          );
        },
        (err: { statusCode?: number; message?: string }) => {
          assert.equal(err.statusCode, 503);
          assert.match(err.message ?? "", /fault/i);
          return true;
        },
      );

      // 5. provenance: "simulated" must be rejected (503)
      assert.throws(
        () => {
          backend.ingestHardwareReading(
            makeV1Payload(
              {
                installationId: "inst-strict",
                counterEpoch: "1",
                provenance: "simulated",
                observedAt: new Date(t0 + 8000).toISOString(),
                receivedAt: new Date(t0 + 8000).toISOString(),
              },
              t0 + 8000,
            ),
            "live",
            t0 + 8000,
          );
        },
        (err: { statusCode?: number; message?: string }) => {
          assert.equal(err.statusCode, 503);
          assert.match(err.message ?? "", /simulated/i);
          return true;
        },
      );
    } finally {
      backend.close();
    }
  });
});
