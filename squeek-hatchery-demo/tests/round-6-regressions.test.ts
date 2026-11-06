import assert from "node:assert/strict";
import fs from "node:fs";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { HatcheryBackend, MAX_RANKED_STEP_MS } from "../src/backend.ts";
import { createHatcheryHttpServer } from "../src/server.ts";
import {
  DEFAULT_GAME_POLICY,
  EXPERIMENTAL_POLICY_V2,
  EXPERIMENTAL_POLICY_V3,
  EXPERIMENTAL_POLICY_V4,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  PALETTES,
} from "../src/game-policy.ts";
import { LED_PRESENTATION, regionWeights } from "../src/led-renderer.ts";
import {
  bodyFitsInsideEgg,
  computeLampMountLayout,
  computeRevealWindow,
  dotOnSceneGrid,
  incubationBodyPlacement,
  incubationControlsVisible,
  interiorPixelsOpen,
  interiorVisibleAt,
  lampAnchorsMatch,
  masterToStage,
  pointInFamilyEgg,
  positionForRegionAim,
  presentationForStage,
  regionRevealCoverageRatio,
  sampleLedBeamDots,
  shellDotVisibleAt,
  stageCanvasClipPath,
  stageRegionAnchor,
  stageToMaster,
} from "../src/led-scene.ts";
import {
  buildCharacterSnapshot,
  buildLedMetadataJson,
  clearAttemptProgressKeepingEgg,
  collectJsonStrings,
  createClientTelemetryTracker,
  createLedSession,
  isClientReadingFresh,
  levelUpAnnouncementKey,
  lockSessionTraits,
  sanitizePublicCharacterSnapshot,
  shouldApplyRankedSessionResponse,
} from "../src/led-session.ts";
import { measurementDayKey, regionAt, type Reading } from "../src/rules.ts";

const HTTP_ACCOUNT = privateKeyToAccount(
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
);

describe("Round 6 Regressions: scene geometry, no-pause rules, privacy", () => {
  test("A3: max/mixed levels fit incubation envelope; reveal covers >=2/3 of aimed region", () => {
    const cases: [number, number, number][] = [
      [10, 10, 10],
      [10, 0, 0],
      [0, 10, 0],
      [0, 0, 10],
      [10, 10, 0],
      [10, 0, 10],
      [0, 10, 10],
    ];
    for (const levels of cases) {
      assert.equal(
        bodyFitsInsideEgg(levels as [number, number, number]),
        true,
        `levels ${levels.join("/")} must fit inside egg`,
      );
    }

    for (const family of [0, 1, 2] as const) {
      for (const pos of [-70, 0, 70]) {
        const coverage = regionRevealCoverageRatio(pos, true, 36, family);
        assert.ok(
          coverage >= 2 / 3,
          `family ${family} reveal coverage for lamp ${pos} was ${coverage}, expected >= 2/3`,
        );
        const win = computeRevealWindow(pos, true);
        assert.equal(win.open, true);
        assert.equal(interiorVisibleAt(family, win.cx, win.cy, true, pos), true);
        assert.equal(shellDotVisibleAt(family, win.cx, win.cy, true, pos), false);
        assert.equal(interiorVisibleAt(family, win.cx, win.cy, false, pos), false);
        assert.equal(shellDotVisibleAt(family, 8, 8, true, pos), false);
      }
    }
    const anchor = stageRegionAnchor(0);
    assert.equal(shellDotVisibleAt(0, anchor.cx, anchor.cy, false, -70), true);

    const litCanvas = stageCanvasClipPath("running", true, -70);
    assert.equal(litCanvas.visibility, "hidden");
    assert.equal(litCanvas.opacity, "0");
    const closed = stageCanvasClipPath("running", false, 0);
    assert.equal(closed.visibility, "hidden");
    assert.equal(closed.opacity, "0");
    const finished = stageCanvasClipPath("completed", true, 0);
    assert.equal(finished.visibility, "visible");
    assert.equal(finished.clipPath, "none");
    const placement = incubationBodyPlacement();
    assert.equal(presentationForStage("running").scale, placement.scale);
    assert.notEqual(presentationForStage("running").scale, LED_PRESENTATION.scale);
    assert.equal(presentationForStage("completed").scale, LED_PRESENTATION.scale);
    const beam = sampleLedBeamDots(computeLampMountLayout(0), 0, true, 1, 0);
    assert.ok(beam.length > 8);
    for (const dot of beam) assert.equal(dotOnSceneGrid(dot.x, dot.y), true);
    assert.equal(interiorPixelsOpen({ status: "paused", hardwareHealthy: true, effectivePower: 1 }), false);
    assert.equal(interiorPixelsOpen({ status: "egg", hardwareHealthy: true, effectivePower: 1 }), false);
    assert.equal(
      interiorPixelsOpen({ status: "running", hardwareHealthy: false, effectivePower: 1 }),
      false,
    );
  });

  test("R22: opening, shell and beam follow regionWeights inside the egg", () => {
    const compositorMajor = (masterX: number, masterY: number): 0 | 1 | 2 => {
      const weights = regionWeights(masterX, masterY);
      if (weights[0] >= weights[1] && weights[0] >= weights[2]) return 0;
      if (weights[1] >= weights[2]) return 1;
      return 2;
    };
    const retiredHead = { cx: 400, cy: 230, rx: 150, ry: 120 };
    const retiredLower = { cx: 400, cy: 690, rx: 165, ry: 100 };
    const outsideRetired = (
      x: number,
      y: number,
      ellipse: { cx: number; cy: number; rx: number; ry: number },
    ) => ((x - ellipse.cx) / ellipse.rx) ** 2 + ((y - ellipse.cy) / ellipse.ry) ** 2 > 1;
    const aims = [-70, 0, 70] as const;

    for (const family of [0, 1, 2] as const) {
      const tallies = [0, 1, 2].map(() => ({ points: 0, visible: 0, leaked: 0 }));
      const outer = {
        head: { points: 0, visible: 0 },
        lower: { points: 0, visible: 0 },
      };
      let checkedHeadShell = false;
      let checkedLowerShell = false;
      for (let masterY = 8; masterY < 850; masterY += 8) {
        for (let masterX = 12; masterX < 788; masterX += 8) {
          const stage = masterToStage(masterX, masterY);
          if (!pointInFamilyEgg(family, stage.x, stage.y)) continue;
          const master = stageToMaster(stage.x, stage.y);
          const region = compositorMajor(master.x, master.y);
          const row = tallies[region]!;
          row.points += 1;
          let shownForOwn = false;
          for (const aim of aims) {
            const shown = interiorVisibleAt(family, stage.x, stage.y, true, aim);
            if (regionAt(aim) === region) {
              if (shown) {
                row.visible += 1;
                shownForOwn = true;
              }
            } else if (shown) {
              row.leaked += 1;
            }
          }
          if (interiorVisibleAt(family, stage.x, stage.y, false, aims[region]!)) row.leaked += 1;
          if (region === 0 && outsideRetired(master.x, master.y, retiredHead)) {
            outer.head.points += 1;
            if (shownForOwn) outer.head.visible += 1;
            if (shownForOwn && !checkedHeadShell && pointInFamilyEgg(family, stage.x, stage.y, 0.995)) {
              assert.equal(shellDotVisibleAt(family, stage.x, stage.y, true, -70), false);
              assert.equal(shellDotVisibleAt(family, stage.x, stage.y, false, -70), true);
              checkedHeadShell = true;
            }
          }
          if (region === 2 && outsideRetired(master.x, master.y, retiredLower)) {
            outer.lower.points += 1;
            if (shownForOwn) outer.lower.visible += 1;
            if (shownForOwn && !checkedLowerShell && pointInFamilyEgg(family, stage.x, stage.y, 0.995)) {
              assert.equal(shellDotVisibleAt(family, stage.x, stage.y, true, 70), false);
              assert.equal(shellDotVisibleAt(family, stage.x, stage.y, false, 70), true);
              checkedLowerShell = true;
            }
          }
        }
      }
      for (const [region, row] of tallies.entries()) {
        assert.ok(row.points > 20, `family ${family} region ${region} had ${row.points} in-egg samples`);
        const fraction = row.visible / row.points;
        assert.ok(
          fraction >= 2 / 3,
          `family ${family} region ${region} compositor coverage was ${fraction}, expected >= 2/3`,
        );
        assert.equal(row.leaked, 0, `family ${family} region ${region} leaked ${row.leaked} samples`);
      }
      assert.ok(outer.head.points > 0, `family ${family} should include head rows outside the retired ellipse`);
      assert.ok(outer.lower.points > 0, `family ${family} should include lower rows outside the retired ellipse`);
      assert.ok(
        outer.head.visible / outer.head.points >= 2 / 3,
        `family ${family} outer head coverage ${outer.head.visible / outer.head.points}`,
      );
      assert.ok(
        outer.lower.visible / outer.lower.points >= 2 / 3,
        `family ${family} outer lower coverage ${outer.lower.visible / outer.lower.points}`,
      );
      assert.equal(checkedHeadShell, true, `family ${family} outer head shell opening`);
      assert.equal(checkedLowerShell, true, `family ${family} outer lower shell opening`);

      for (const aim of aims) {
        const region = regionAt(aim) as 0 | 1 | 2;
        const dots = sampleLedBeamDots(computeLampMountLayout(aim), aim, true, 1, family);
        let own = 0;
        let other = 0;
        for (const dot of dots) {
          assert.equal(dotOnSceneGrid(dot.x, dot.y), true, `beam dot off the scene lattice at ${dot.x},${dot.y}`);
          if (!pointInFamilyEgg(family, dot.x, dot.y)) continue;
          const master = stageToMaster(dot.x, dot.y);
          if (compositorMajor(master.x, master.y) === region) own += 1;
          else other += 1;
        }
        assert.ok(own > 8, `family ${family} region ${region} beam lit ${own} anatomical dots`);
        assert.equal(other, 0, `family ${family} region ${region} beam leaked ${other} dots`);
      }
      assert.equal(sampleLedBeamDots(computeLampMountLayout(0), 0, false, 1, family).length, 0);
    }
    assert.equal(interiorVisibleAt(0, 8, 8, true, -70), false);
  });

  test("A4: lamp mount/handle share one coordinate; region cards map to aim positions", () => {
    for (const position of [-100, -70, 0, 70, 100]) {
      const layout = computeLampMountLayout(position);
      assert.equal(lampAnchorsMatch(layout), true, `lamp anchors at ${position}`);
    }
    const layout = computeLampMountLayout(-70);
    assert.ok(Math.abs(layout.handleX - layout.sourceX) < 40);
    assert.equal(layout.handleY, layout.sourceY);
    assert.equal(regionAt(positionForRegionAim(0)), 0);
    assert.equal(regionAt(positionForRegionAim(1)), 1);
    assert.equal(regionAt(positionForRegionAim(2)), 2);
    assert.equal(incubationControlsVisible("completed"), false);
    assert.equal(incubationControlsVisible("running"), true);
  });

  test("A6: pause route resets current-rule attempt; restart clears locks; V3 historical pause retained", async () => {
    let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
    const reading = (): Reading => ({
      coreStatus: "ACTIVE",
      rpm: 65,
      meters: 50,
      distanceMm: 50_000,
      work: 200n,
      counterEpoch: "r6-epoch",
      installationId: "r6-wheel",
      observedAt: nowMs,
      received: nowMs,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(nowMs),
    });

    const current = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V4,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({ source: "live", reading: reading() }),
    });
    try {
      const wallet = "0x5555555555555555555555555555555555555555";
      const egg = current.claimRankedEgg(wallet, { familyIndex: 2 });
      await current.startRankedIllumination(wallet, { sessionId: egg.id });
      nowMs += 5_000;
      await current.tickRankedSession(wallet, { sessionId: egg.id });
      const paused = await current.pauseRankedSession(wallet, { sessionId: egg.id });
      assert.equal(paused.session.status, "egg");
      assert.equal(paused.session.lockedTraits, null);
      assert.equal(paused.session.familyIndex, 2);
      assert.equal(paused.session.elapsed, 0);
    } finally {
      current.close();
    }

    const legacy = new HatcheryBackend({
      policy: EXPERIMENTAL_POLICY_V3,
      dbPath: ":memory:",
      now: () => nowMs,
      hardwareProvider: async () => ({ source: "live", reading: reading() }),
    });
    try {
      const wallet = "0x6666666666666666666666666666666666666666";
      const egg = legacy.claimRankedEgg(wallet, { familyIndex: 0 });
      await legacy.startRankedIllumination(wallet, { sessionId: egg.id });
      const paused = await legacy.pauseRankedSession(wallet, { sessionId: egg.id });
      assert.equal(paused.session.status, "paused");
      assert.ok(paused.session.lockedTraits);
    } finally {
      legacy.close();
    }

    const guest = createLedSession({ mode: "guest", familyIndex: 1, policy: DEFAULT_GAME_POLICY });
    lockSessionTraits(
      guest,
      reading(),
      0n,
      DEFAULT_GAME_POLICY,
      new Date(nowMs).toISOString(),
      { paletteIndex: 1, accessoryIndex: 2 },
    );
    guest.elapsed = 12;
    clearAttemptProgressKeepingEgg(guest);
    assert.equal(guest.status, "egg");
    assert.equal(guest.lockedTraits, null);
    assert.equal(guest.familyIndex, 1);
  });

  test("A7: public snapshot/metadata never leak a named player's full wallet; favicon is LED-dot egg", () => {
    const wallet = "0xAbCdEf0123456789AbCdEf0123456789AbCdEf01";
    const session = createLedSession({
      mode: "ranked",
      familyIndex: 0,
      ownerWallet: wallet,
      policy: DEFAULT_GAME_POLICY,
    });
    lockSessionTraits(
      session,
      {
        coreStatus: "IDLE",
        rpm: 0,
        meters: 10,
        distanceMm: 10_000,
        work: 50n,
        counterEpoch: "priv",
        installationId: "priv-wheel",
        observedAt: Date.parse("2026-11-06T13:00:00.000Z"),
        received: Date.parse("2026-11-06T13:00:00.000Z"),
        staleAfterSeconds: 60,
        utcDate: "2026-11-06",
      },
      0n,
      DEFAULT_GAME_POLICY,
      "2026-11-06T13:00:00.000Z",
      { paletteIndex: 0, accessoryIndex: 0 },
    );
    session.elapsed = 60;
    session.status = "completed";
    session.backgroundIndex = 0;
    session.backgroundId = LED_BACKGROUNDS[0]!.id;
    const snap = buildCharacterSnapshot(session, {
      resultId: "res-privacy-1",
      displayName: "Named Hatchling",
      policy: DEFAULT_GAME_POLICY,
    });
    assert.equal(snap.ownerWallet, wallet);
    assert.equal(snap.effectivePlayerName, "Named Hatchling");

    const publicSnap = sanitizePublicCharacterSnapshot(snap);
    assert.equal(publicSnap.ownerWallet, null);
    const meta = JSON.parse(buildLedMetadataJson(snap)) as Record<string, unknown>;
    const strings = collectJsonStrings(meta).join("\n");
    assert.equal(strings.includes(wallet), false);
    assert.equal(strings.includes(wallet.toLowerCase()), false);
    assert.match(strings, /Named Hatchling/);

    const favicon = fs.readFileSync(
      path.resolve(process.cwd(), "public", "favicon.svg"),
      "utf8",
    );
    assert.match(favicon, /circle/i);
    assert.doesNotMatch(favicon, /face|M14\.8 19\.6/i);
    assert.match(favicon, /#2dd4bf|#fbbf24/i);

    assert.equal(PALETTES.length, 10);
    assert.equal(LED_ACCESSORIES.length, 10);
    assert.equal(LED_BACKGROUNDS.length, 10);
  });

  test("R26: V4 keeps a valid observation at 16s and 119s while speed falls back to base warmth", () => {
    const base = Date.parse("2026-11-06T13:00:00.000Z");
    const sample = (coreStatus: "IDLE" | "ACTIVE"): Reading => ({
      coreStatus,
      rpm: coreStatus === "ACTIVE" ? 65 : 0,
      meters: 0,
      distanceMm: 0,
      work: 500n,
      counterEpoch: "probe",
      installationId: "probe",
      observedAt: base,
      received: base,
      staleAfterSeconds: 120,
      utcDate: measurementDayKey(base),
    });
    for (const policy of [EXPERIMENTAL_POLICY_V2, EXPERIMENTAL_POLICY_V3, EXPERIMENTAL_POLICY_V4]) {
      for (const state of ["IDLE", "ACTIVE"] as const) {
        let now = base;
        const tracker = createClientTelemetryTracker({ now: () => now, policy });
        tracker.ingestBackendReading(
          {
            coreStatus: state,
            rpm: state === "ACTIVE" ? 65 : 0,
            meters: 0,
            distanceMm: 0,
            work: "500",
            counterEpoch: "probe",
            installationId: "probe",
            observedAt: base,
            received: base,
            staleAfterSeconds: 120,
            utcDate: measurementDayKey(base),
          },
          "500",
        );
        for (const age of [16_000, 119_000]) {
          now = base + age;
          const result = tracker.checkFreshnessForStep(now);
          const legacy = policy === EXPERIMENTAL_POLICY_V2;
          assert.equal(result.healthy, !legacy, `${policy.version} ${state} @${age}`);
          if (!legacy) {
            assert.equal(result.effectivePower, 0.4);
            assert.equal(result.isSpeedFresh, state === "IDLE");
            assert.equal(isClientReadingFresh(sample(state), now, policy), true);
          } else if (age === 16_000) {
            assert.equal(isClientReadingFresh(sample(state), now, policy), false);
          }
        }
        now = base + 120_001;
        assert.equal(tracker.checkFreshnessForStep(now).healthy, false, `${policy.version} expires at original TTL`);
      }
    }

    let now = base;
    const shorter = createClientTelemetryTracker({ now: () => now, policy: EXPERIMENTAL_POLICY_V4 });
    const payload = {
      coreStatus: "ACTIVE" as const,
      rpm: 65,
      meters: 0,
      distanceMm: 0,
      work: "500",
      counterEpoch: "probe",
      installationId: "probe",
      observedAt: base,
      received: base,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(base),
    };
    shorter.ingestBackendReading(payload, "500");
    now = base + 30_000;
    const repeated = shorter.ingestBackendReading({ ...payload, received: now }, "500");
    assert.equal(repeated.healthy, true);
    assert.equal(repeated.reading?.received, base);
    now = base + 60_001;
    assert.equal(shorter.checkFreshnessForStep(now).healthy, false);
  });

  test("R26: backend V2/V3/V4 honor observation TTL and do not refresh it from a repeated receipt", async () => {
    const base = Date.parse("2026-11-06T13:00:00.000Z");
    const run = async (policy: typeof EXPERIMENTAL_POLICY_V4, expect16s: boolean) => {
      let now = base;
      let received = base;
      const backend = new HatcheryBackend({
        policy,
        dbPath: ":memory:",
        now: () => now,
        autoStartProducer: false,
        hardwareProvider: async () => ({
          source: "live" as const,
          reading: {
            coreStatus: "ACTIVE" as const,
            rpm: 65,
            meters: 1,
            distanceMm: 1000,
            work: 100n,
            counterEpoch: "ttl",
            installationId: "ttl-wheel",
            observedAt: base,
            received,
            staleAfterSeconds: 120,
            utcDate: measurementDayKey(base),
          },
        }),
      });
      try {
        await backend.pollProducerTick();
        now = base + 16_000;
        received = now;
        if (expect16s) {
          const live = await backend.getHardwareTelemetry();
          assert.equal(live.reading.received, base, "a later receipt must not move the original deadline");
          const signal = live.signal;
          assert.ok(signal, "live telemetry must include a signal");
          assert.equal(signal.state, "speed-unavailable");
          now = base + 119_000;
          const still = await backend.getHardwareTelemetry();
          assert.equal(still.reading.observedAt, base);
          now = base + 120_001;
          await assert.rejects(
            () => backend.getHardwareTelemetry(),
            (err: { statusCode?: number }) => err.statusCode === 503,
          );
        } else {
          await assert.rejects(
            () => backend.getHardwareTelemetry(),
            (err: { statusCode?: number }) => err.statusCode === 503,
          );
        }
      } finally {
        backend.close();
      }
    };
    await run(EXPERIMENTAL_POLICY_V2, false);
    await run(EXPERIMENTAL_POLICY_V3, true);
    await run(EXPERIMENTAL_POLICY_V4, true);
  });

  test("R31/R32: heartbeat gap and legacy paused locks cannot grow or keep the old pair", async () => {
    let now = Date.parse("2026-11-06T13:00:00.000Z");
    const reading = () => ({
      coreStatus: "ACTIVE" as const,
      rpm: 65,
      meters: 10,
      distanceMm: 10_000,
      work: 100n,
      counterEpoch: "review-attempt",
      installationId: "review-attempt",
      observedAt: now,
      received: now,
      staleAfterSeconds: 120,
      utcDate: measurementDayKey(now),
    });
    const make = (policy: typeof EXPERIMENTAL_POLICY_V4, dbPath = ":memory:") =>
      new HatcheryBackend({
        policy,
        dbPath,
        now: () => now,
        autoStartProducer: false,
        hardwareProvider: async () => ({ source: "live" as const, reading: reading() }),
      });

    const gap = make(EXPERIMENTAL_POLICY_V4);
    try {
      const wallet = "0x1111111111111111111111111111111111111111";
      const egg = gap.claimRankedEgg(wallet, { familyIndex: 2 });
      await gap.pollProducerTick();
      await gap.startRankedIllumination(wallet, { sessionId: egg.id });
      now += MAX_RANKED_STEP_MS + 1;
      await gap.pollProducerTick();
      const afterGap = await gap.startRankedIllumination(wallet, { sessionId: egg.id });
      assert.equal(afterGap.session.id, egg.id);
      assert.equal(afterGap.session.familyIndex, 2);
      assert.ok(afterGap.session.lockedTraits, "fresh first light must relock before running");
      assert.equal(afterGap.session.status, "running");
      assert.equal(afterGap.session.elapsed, 0);
      now += 1000;
      await gap.pollProducerTick();
      const afterTick = await gap.tickRankedSession(wallet, { sessionId: egg.id });
      assert.ok(afterTick.session.lockedTraits);
      assert.ok(afterTick.session.elapsed > 0 && afterTick.session.elapsed < 5);
      now += MAX_RANKED_STEP_MS + 1;
      await gap.pollProducerTick();
      const aimed = await gap.aimRankedSession(wallet, { sessionId: egg.id, lampPosition: 70 });
      assert.equal(aimed.session.status, "egg");
      assert.equal(aimed.session.lockedTraits, null);
      assert.equal(aimed.session.elapsed, 0);
      assert.equal(aimed.session.familyIndex, 2);

      const coldWallet = "0x4444444444444444444444444444444444444444";
      const coldEgg = gap.claimRankedEgg(coldWallet, { familyIndex: 0 });
      await gap.pollProducerTick();
      await gap.startRankedIllumination(coldWallet, { sessionId: coldEgg.id });
      now += MAX_RANKED_STEP_MS + 1;
      await gap.pollProducerTick();
      const coldTick = await gap.tickRankedSession(coldWallet, { sessionId: coldEgg.id });
      assert.equal(coldTick.session.status, "egg");
      assert.equal(coldTick.session.lockedTraits, null);
      assert.equal(coldTick.session.elapsed, 0);
      assert.equal(coldTick.session.id, coldEgg.id);
    } finally {
      gap.close();
    }

    const dbPath = path.join(os.tmpdir(), `squeek-r32-${Date.now()}.sqlite`);
    const wallet = "0x2222222222222222222222222222222222222222";
    const finishedWallet = "0x3333333333333333333333333333333333333333";
    let oldLockAt = "";
    let eggId = "";
    let finishedId = "";
    let preservedScore = 0;
    let preservedSnapshot = "";
    const legacy = make(EXPERIMENTAL_POLICY_V3, dbPath);
    try {
      const egg = legacy.claimRankedEgg(wallet, { familyIndex: 1 });
      eggId = egg.id;
      await legacy.pollProducerTick();
      const started = await legacy.startRankedIllumination(wallet, { sessionId: egg.id });
      oldLockAt = started.session.lockedTraits?.lockedAt ?? "";
      assert.ok(oldLockAt);
      const paused = await legacy.pauseRankedSession(wallet, { sessionId: egg.id });
      assert.equal(paused.session.status, "paused");
      assert.equal(paused.session.lockedTraits?.lockedAt, oldLockAt);
      const finished = legacy.claimRankedEgg(finishedWallet, { familyIndex: 0 });
      finishedId = finished.id;
      await legacy.pollProducerTick();
      await legacy.startRankedIllumination(finishedWallet, { sessionId: finished.id });
      for (let step = 0; step < 3; step++) {
        now += 20_000;
        await legacy.pollProducerTick();
        await legacy.tickRankedSession(finishedWallet, { sessionId: finished.id });
      }
      const completed = await legacy.completeRankedSession(finishedWallet, { sessionId: finished.id });
      const stored = legacy.db
        .prepare(`SELECT total_score, snapshot_json FROM hatched_results WHERE result_id = ?`)
        .get(completed.resultId) as { total_score: number; snapshot_json: string };
      preservedScore = stored.total_score;
      preservedSnapshot = stored.snapshot_json;
      assert.equal(preservedScore, completed.snapshot.scores.total);
    } finally {
      legacy.close();
    }

    now += 3_600_000;
    const current = make(EXPERIMENTAL_POLICY_V4, dbPath);
    try {
      await current.pollProducerTick();
      const active = await current.getActiveRankedSession(wallet);
      assert.equal(active?.id, eggId);
      assert.equal(active?.familyIndex, 1);
      assert.equal(active?.status, "egg");
      assert.equal(active?.lockedTraits, null);
      assert.equal(active?.elapsed, 0);
      const restarted = await current.startRankedIllumination(wallet, { sessionId: eggId });
      assert.equal(restarted.session.id, eggId);
      assert.equal(restarted.session.familyIndex, 1);
      assert.equal(restarted.session.status, "running");
      assert.equal(restarted.session.elapsed, 0);
      assert.notEqual(restarted.session.lockedTraits?.lockedAt, oldLockAt);
      const policyRow = current.db
        .prepare(`SELECT policy_version, policy_snapshot_json FROM ranked_sessions WHERE session_id = ?`)
        .get(eggId) as { policy_version: string; policy_snapshot_json: string };
      assert.equal(policyRow.policy_version, EXPERIMENTAL_POLICY_V3.version);
      assert.match(policyRow.policy_snapshot_json, /exp-v3-2026-11-06/);
      await assert.rejects(
        () => current.startRankedIllumination(finishedWallet, { sessionId: finishedId }),
        (err: { statusCode?: number }) => err.statusCode === 409,
      );
      const score = current.db
        .prepare(`SELECT total_score, snapshot_json FROM hatched_results WHERE session_id = ?`)
        .get(finishedId) as { total_score: number; snapshot_json: string };
      assert.equal(score.total_score, preservedScore);
      assert.equal(score.snapshot_json, preservedSnapshot);
    } finally {
      current.close();
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
  });

  test("R31/R32: HTTP start after a gap relocks, and a V4 server drops a paused V3 lock", async () => {
    let now = Date.parse("2026-11-06T13:00:00.000Z");
    const dbPath = path.join(os.tmpdir(), `squeek-r32-http-${Date.now()}.sqlite`);
    const reading = () => ({
      coreStatus: "ACTIVE" as const,
      rpm: 65,
      meters: 10,
      distanceMm: 10_000,
      work: 100n,
      counterEpoch: "review-http",
      installationId: "review-http",
      observedAt: now,
      received: now,
      staleAfterSeconds: 120,
      utcDate: measurementDayKey(now),
    });
    const boot = (policy: typeof EXPERIMENTAL_POLICY_V4, file = ":memory:") =>
      createHatcheryHttpServer({
        policy,
        dbPath: file,
        now: () => now,
        autoStartProducer: false,
        hardwareProvider: async () => ({ source: "live" as const, reading: reading() }),
      });
    const listen = async (server: Server) => {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address() as { port: number };
      return `http://127.0.0.1:${address.port}`;
    };
    const close = async (server: Server, backend: { close: () => void }) => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      backend.close();
    };
    async function request<T>(
      origin: string,
      pathname: string,
      init: { method?: string; body?: unknown; cookie?: string } = {},
    ): Promise<{ status: number; data: T; setCookie?: string }> {
      const headers: Record<string, string> = { origin };
      if (init.cookie) headers.cookie = init.cookie;
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const res = await fetch(`${origin}${pathname}`, {
        method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
        headers,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      });
      return {
        status: res.status,
        data: (await res.json().catch(() => ({}))) as T,
        setCookie: res.headers.get("set-cookie") ?? undefined,
      };
    }
    async function signIn(origin: string): Promise<string> {
      const chal = await request<{ challengeId: string; message: string }>(origin, "/api/auth/challenge", {
        method: "POST",
        body: { walletAddress: HTTP_ACCOUNT.address, chainId: 11155111 },
      });
      assert.equal(chal.status, 200);
      const signature = await HTTP_ACCOUNT.signMessage({ message: chal.data.message });
      const ver = await request(origin, "/api/auth/verify", {
        method: "POST",
        body: {
          challengeId: chal.data.challengeId,
          walletAddress: HTTP_ACCOUNT.address,
          signature,
          chainId: 11155111,
        },
      });
      assert.equal(ver.status, 200);
      const cookie = ver.setCookie?.split(";")[0] ?? "";
      assert.match(cookie, /squeek_session=/);
      return cookie;
    }

    const gap = boot(EXPERIMENTAL_POLICY_V4);
    const gapOrigin = await listen(gap.server);
    try {
      const cookie = await signIn(gapOrigin);
      const egg = await request<{ session: { id: string; familyIndex: number } }>(
        gapOrigin,
        "/api/session/egg",
        { cookie, body: { familyIndex: 2 } },
      );
      assert.equal(egg.status, 201);
      await request(gapOrigin, "/api/session/start", {
        cookie,
        body: { sessionId: egg.data.session.id },
      });
      now += MAX_RANKED_STEP_MS + 1;
      await gap.backend.pollProducerTick();
      const afterGap = await request<{
        session: { id: string; status: string; elapsed: number; familyIndex: number; lockedTraits: { lockedAt: string } | null };
      }>(gapOrigin, "/api/session/start", { cookie, body: { sessionId: egg.data.session.id } });
      assert.equal(afterGap.status, 200);
      assert.equal(afterGap.data.session.id, egg.data.session.id);
      assert.equal(afterGap.data.session.familyIndex, 2);
      assert.equal(afterGap.data.session.status, "running");
      assert.equal(afterGap.data.session.elapsed, 0);
      assert.ok(afterGap.data.session.lockedTraits);
      now += 1000;
      await gap.backend.pollProducerTick();
      const ticked = await request<{
        session: { status: string; elapsed: number; lockedTraits: { lockedAt: string } | null };
      }>(gapOrigin, "/api/session/tick", { cookie, body: { sessionId: egg.data.session.id } });
      assert.equal(ticked.status, 200);
      assert.ok(ticked.data.session.lockedTraits);
      assert.ok(ticked.data.session.elapsed > 0 && ticked.data.session.elapsed < 5);
    } finally {
      await close(gap.server, gap.backend);
    }

    let oldLockAt = "";
    let sessionId = "";
    const legacy = boot(EXPERIMENTAL_POLICY_V3, dbPath);
    const legacyOrigin = await listen(legacy.server);
    try {
      const cookie = await signIn(legacyOrigin);
      const egg = await request<{ session: { id: string } }>(legacyOrigin, "/api/session/egg", {
        cookie,
        body: { familyIndex: 1 },
      });
      assert.equal(egg.status, 201);
      sessionId = egg.data.session.id;
      const started = await request<{ session: { lockedTraits: { lockedAt: string } | null } }>(
        legacyOrigin,
        "/api/session/start",
        { cookie, body: { sessionId } },
      );
      oldLockAt = started.data.session.lockedTraits?.lockedAt ?? "";
      const paused = await request<{ session: { status: string; lockedTraits: { lockedAt: string } | null } }>(
        legacyOrigin,
        "/api/session/pause",
        { cookie, body: { sessionId } },
      );
      assert.equal(paused.status, 200);
      assert.equal(paused.data.session.status, "paused");
      assert.equal(paused.data.session.lockedTraits?.lockedAt, oldLockAt);
    } finally {
      await close(legacy.server, legacy.backend);
    }

    now += 3_600_000;
    const current = boot(EXPERIMENTAL_POLICY_V4, dbPath);
    const currentOrigin = await listen(current.server);
    try {
      const cookie = await signIn(currentOrigin);
      const active = await request<{
        session: { id: string; status: string; familyIndex: number; lockedTraits: unknown; elapsed: number } | null;
      }>(currentOrigin, "/api/session/active", { method: "GET", cookie });
      assert.equal(active.status, 200);
      assert.equal(active.data.session?.id, sessionId);
      assert.equal(active.data.session?.status, "egg");
      assert.equal(active.data.session?.familyIndex, 1);
      assert.equal(active.data.session?.lockedTraits, null);
      assert.equal(active.data.session?.elapsed, 0);
      const restarted = await request<{
        session: { status: string; familyIndex: number; elapsed: number; lockedTraits: { lockedAt: string } | null };
      }>(currentOrigin, "/api/session/start", { cookie, body: { sessionId } });
      assert.equal(restarted.status, 200);
      assert.equal(restarted.data.session.status, "running");
      assert.equal(restarted.data.session.familyIndex, 1);
      assert.equal(restarted.data.session.elapsed, 0);
      assert.notEqual(restarted.data.session.lockedTraits?.lockedAt, oldLockAt);
      const policyRow = current.backend.db
        .prepare(`SELECT policy_version FROM ranked_sessions WHERE session_id = ?`)
        .get(sessionId) as { policy_version: string };
      assert.equal(policyRow.policy_version, EXPERIMENTAL_POLICY_V3.version);
    } finally {
      await close(current.server, current.backend);
      try {
        fs.unlinkSync(dbPath);
      } catch {
        // ignore
      }
    }
  });

  test("R33: a reset generation or another egg cannot replay a level-up flash", () => {
    assert.equal(
      shouldApplyRankedSessionResponse({
        requestEpoch: 1,
        currentEpoch: 2,
        expectedSessionId: "sess-a",
        responseSessionId: "sess-a",
      }),
      false,
    );
    assert.equal(
      shouldApplyRankedSessionResponse({
        requestEpoch: 2,
        currentEpoch: 2,
        expectedSessionId: "sess-a",
        responseSessionId: "sess-b",
      }),
      false,
    );
    assert.equal(
      shouldApplyRankedSessionResponse({
        requestEpoch: 2,
        currentEpoch: 2,
        expectedSessionId: "sess-a",
        responseSessionId: "sess-a",
      }),
      true,
    );
    assert.equal(levelUpAnnouncementKey("sess-a", 1, 4), "sess-a:1:4");
    assert.equal(
      levelUpAnnouncementKey("sess-a", 1, 4),
      levelUpAnnouncementKey("sess-a", 1, 4),
    );
  });

  test("R22/R24/R33: play and docs source use the shared scene, real palette art, and one regional pulse", () => {
    const app = fs.readFileSync(path.resolve(process.cwd(), "src", "app.ts"), "utf8");
    const css = fs.readFileSync(path.resolve(process.cwd(), "src", "style.css"), "utf8");
    assert.match(app, /presentationForStage\(/);
    assert.match(app, /shellDotVisibleAt\(/);
    assert.match(app, /egg-pulse-v2\.png/);
    assert.match(app, /egg-relay-v2\.png/);
    assert.match(app, /egg-prism-v2\.png/);
    assert.match(app, /heat-lamp-v2\.png/);
    assert.match(app, /led-docs-palette-preview/);
    assert.match(app, /led-docs-section/);
    assert.match(app, /region-led-pulse/);
    assert.match(app, /shouldApplyRankedSessionResponse/);
    assert.match(app, /levelUpAnnouncementKey/);
    assert.doesNotMatch(app, /buildProceduralEggImageData/);
    assert.doesNotMatch(app, /led-stage-flash/);
    assert.match(css, /\.led-docs-grid\s*\{[^}]*flex-direction:\s*column/);
    assert.match(css, /\.led-docs-catalogs\s*\{[^}]*flex-direction:\s*column/);
    assert.match(css, /led-region-crossfade/);
    assert.match(css, /prefers-reduced-motion/);
    assert.doesNotMatch(css, /scale\(0\.64\)/);
  });
});
