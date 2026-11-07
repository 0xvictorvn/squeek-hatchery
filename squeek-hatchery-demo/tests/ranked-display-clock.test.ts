import assert from "node:assert/strict";
import fs from "node:fs";
import * as nodeModule from "node:module";
import test, { describe } from "node:test";

type DisplayClock = {
  sessionId: string | null;
  generation: number | null;
  acceptedElapsed: number;
  anchorElapsed: number;
  anchorMonoMs: number;
  presented: number;
  advancing: boolean;
  hold: string | null;
};

type AnchorInput = {
  clock: DisplayClock;
  responseGeneration: number;
  liveGeneration: number;
  sessionId: string;
  serverElapsed: number;
  nowMonoMs: number;
  durationSeconds: number;
  advancing: boolean;
  hold?: string | null;
};

type LiveState = {
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
};

type ClockApi = {
  RANKED_DISPLAY_MAX_SECONDS: number;
  createRankedDisplayClock: () => DisplayClock;
  anchorRankedDisplayClock: (input: AnchorInput) => DisplayClock;
  freezeRankedDisplayClock: (
    clock: DisplayClock,
    nowMonoMs: number,
    durationSeconds: number,
    reason: string,
  ) => DisplayClock;
  projectRankedDisplay: (clock: DisplayClock, nowMonoMs: number, durationSeconds: number) => number;
  reconcileRankedDisplayClock: (clock: DisplayClock, live: LiveState) => DisplayClock;
  formatRankedTimerReadout: (seconds: number, durationSeconds: number) => string;
};

async function loadRankedDisplayClock(): Promise<ClockApi> {
  const source = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
  const startMarker = "/* RANKED_DISPLAY_CLOCK_START */";
  const endMarker = "/* RANKED_DISPLAY_CLOCK_END */";
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);
  assert.equal(start >= 0 && end > start, true, "ranked display clock block must stay in src/app.ts");
  assert.equal(source.indexOf(startMarker, start + 1), -1);
  const block = source.slice(start, end);
  assert.equal(block.includes("fetch("), false);
  assert.equal(block.includes("document"), false);
  assert.equal(block.includes(".elapsed ="), false);
  const stripTypeScriptTypes = (
    nodeModule as unknown as {
      stripTypeScriptTypes: (code: string, options: { mode: "strip" }) => string;
    }
  ).stripTypeScriptTypes;
  const stripped = stripTypeScriptTypes(block, { mode: "strip" });
  const imported = (await import(
    `data:text/javascript;base64,${Buffer.from(stripped).toString("base64")}`
  )) as ClockApi;
  assert.equal(typeof imported.anchorRankedDisplayClock, "function");
  assert.equal(typeof imported.reconcileRankedDisplayClock, "function");
  assert.equal(typeof imported.projectRankedDisplay, "function");
  assert.equal(imported.RANKED_DISPLAY_MAX_SECONDS, 60);
  return imported;
}

const api = await loadRankedDisplayClock();

function near(actual: number, expected: number, epsilon = 1e-4): void {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `expected ${expected} ± ${epsilon}, got ${actual}`,
  );
}

function live(overrides: Partial<LiveState> & { nowMonoMs: number }): LiveState {
  return {
    durationSeconds: 60,
    liveGeneration: 1,
    sessionId: "sess-1",
    serverElapsed: 10,
    status: "running",
    telemetryHealthy: true,
    recovering: false,
    route: "play",
    hidden: false,
    ...overrides,
  };
}

function accept(clock: DisplayClock, overrides: Partial<AnchorInput> = {}): DisplayClock {
  return api.anchorRankedDisplayClock({
    clock,
    responseGeneration: 1,
    liveGeneration: 1,
    sessionId: "sess-1",
    serverElapsed: 10,
    nowMonoMs: 0,
    durationSeconds: 60,
    advancing: true,
    ...overrides,
  });
}

function shown(clock: DisplayClock, nowMonoMs: number, durationSeconds = 60): number {
  return api.projectRankedDisplay(clock, nowMonoMs, durationSeconds);
}

describe("Ranked display clock", () => {
  test("a pending heartbeat longer than 4s keeps the readout moving every second", () => {
    const session = {
      elapsed: 10,
      regions: [
        { exposure: 1, dose: 2, continuousLevel: 3, level: 4 },
        { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
        { exposure: 0, dose: 0, continuousLevel: 0, level: 0 },
      ],
      lockedTraits: { paletteName: "Coat", accessoryName: "Hat" },
    };
    const before = structuredClone(session);
    const anchored = accept(api.createRankedDisplayClock(), {
      serverElapsed: session.elapsed,
      nowMonoMs: 1_000,
    });
    const anchoredSnapshot = structuredClone(anchored);
    let clock = api.reconcileRankedDisplayClock(
      anchored,
      live({ nowMonoMs: 2_000, serverElapsed: session.elapsed }),
    );
    assert.deepEqual(anchored, anchoredSnapshot);
    let previous = api.formatRankedTimerReadout(shown(anchored, 1_000), 60);
    assert.equal(previous, "10.0s / 60s");
    let previousSeconds = shown(anchored, 1_000);
    assert.ok(shown(clock, 2_000) > previousSeconds + 0.9);
    previous = api.formatRankedTimerReadout(shown(clock, 2_000), 60);
    previousSeconds = shown(clock, 2_000);
    for (let second = 2; second <= 4; second += 1) {
      const now = 1_000 + second * 1_000;
      clock = api.reconcileRankedDisplayClock(clock, live({ nowMonoMs: now, serverElapsed: session.elapsed }));
      const seconds = shown(clock, now);
      const text = api.formatRankedTimerReadout(seconds, 60);
      assert.notEqual(text, previous, `second ${second} stayed ${text}`);
      assert.match(text, /^\d+\.\ds \/ 60s$/);
      assert.ok(seconds > previousSeconds + 0.9 && seconds < previousSeconds + 1.1, `${previousSeconds} -> ${seconds}`);
      previous = text;
      previousSeconds = seconds;
    }
    const pending = shown(clock, 1_000 + 4_200);
    assert.ok(pending + 1e-4 >= 14.2 && pending < 14.25, `pending readout ${pending}`);
    assert.equal(clock.acceptedElapsed, 10);
    assert.equal(clock.anchorMonoMs, 1_000);
    assert.deepEqual(session, before);
    assert.equal("elapsed" in clock, false);
    assert.equal("regions" in clock, false);
    assert.equal("lockedTraits" in clock, false);
  });

  test("a lower accepted sample does not jump backward, and the next truthful sample moves again", () => {
    let clock = accept(api.createRankedDisplayClock(), { serverElapsed: 10, nowMonoMs: 0 });
    const atFive = shown(clock, 5_000);
    near(atFive, 15);
    const original = clock;
    const beforeLower = structuredClone(original);
    clock = accept(original, { serverElapsed: 12, nowMonoMs: 5_000 });
    assert.deepEqual(original, beforeLower);
    assert.deepEqual(beforeLower, {
      sessionId: "sess-1",
      generation: 1,
      acceptedElapsed: 10,
      anchorElapsed: 10,
      anchorMonoMs: 0,
      presented: 10,
      advancing: true,
      hold: null,
    });
    assert.ok(shown(clock, 5_000) + 1e-6 >= atFive);
    near(shown(clock, 6_000), 16);
    near(shown(clock, 7_000), 17);
    near(shown(clock, 8_000), 18);
    assert.equal(clock.acceptedElapsed, 12);
    assert.equal(clock.anchorElapsed, 15);
    assert.equal(clock.anchorMonoMs, 5_000);

    const corrected = accept(clock, { serverElapsed: 15.4, nowMonoMs: 5_200 });
    assert.ok(shown(corrected, 5_200) + 1e-4 >= 15.4);
    assert.ok(shown(corrected, 6_200) > 16.3);
  });

  test("a late lower sample keeps advancing across the next seconds", () => {
    let clock = accept(api.createRankedDisplayClock(), {
      serverElapsed: 1,
      nowMonoMs: 1_000,
      sessionId: "slow",
    });
    clock = api.reconcileRankedDisplayClock(
      clock,
      live({ nowMonoMs: 5_000, serverElapsed: 1, sessionId: "slow" }),
    );
    near(shown(clock, 5_000), 5);
    clock = accept(clock, { serverElapsed: 1.2, nowMonoMs: 5_000, sessionId: "slow" });
    const samples = [5_000, 6_000, 7_000, 8_000, 9_000].map((t) => shown(clock, t));
    near(samples[0]!, 5);
    for (let i = 1; i < samples.length; i += 1) {
      assert.ok(
        samples[i]! - samples[i - 1]! >= 0.9,
        `display froze from ${samples[i - 1]} to ${samples[i]}`,
      );
    }
    near(samples[1]!, 6);
    near(samples[2]!, 7);
    near(samples[3]!, 8);
    near(samples[4]!, 9);
    assert.equal(clock.acceptedElapsed, 1.2);
    assert.equal(clock.anchorElapsed, 5);
    assert.equal(clock.anchorMonoMs, 5_000);

    let carried = clock;
    let previous = shown(carried, 5_000);
    for (const now of [6_000, 7_000, 8_000, 9_000]) {
      carried = api.reconcileRankedDisplayClock(
        carried,
        live({ nowMonoMs: now, serverElapsed: 1.2, sessionId: "slow" }),
      );
      const display = shown(carried, now);
      assert.ok(display - previous >= 0.9 && display - previous <= 1.1, `${previous} -> ${display}`);
      previous = display;
      assert.equal(carried.acceptedElapsed, 1.2);
      assert.equal(carried.anchorElapsed, 5);
      assert.equal(carried.anchorMonoMs, 5_000);
    }
    near(shown(carried, 9_500), 9.5);

    const nextLate = accept(clock, { serverElapsed: 1.4, nowMonoMs: 6_000, sessionId: "slow" });
    near(shown(nextLate, 6_000), 6);
    near(shown(nextLate, 7_000), 7);
    assert.equal(nextLate.acceptedElapsed, 1.4);
    assert.equal(nextLate.anchorElapsed, 6);
    assert.equal(nextLate.anchorMonoMs, 6_000);
  });

  test("slightly late samples do not compound into seconds of drift", () => {
    let clock = accept(api.createRankedDisplayClock(), { serverElapsed: 0, nowMonoMs: 0 });
    for (let i = 1; i <= 30; i += 1) {
      const now = i * 1_000;
      const before = shown(clock, now);
      clock = accept(clock, { serverElapsed: now / 1_000 - 0.05, nowMonoMs: now });
      const after = shown(clock, now);
      assert.ok(after + 1e-6 >= before - 1e-4, `backward at sample ${i}: ${before} -> ${after}`);
    }
    const end = shown(clock, 30_000);
    assert.ok(end > 29.8 && end < 30.05, `drifted to ${end}`);
  });

  test("an ahead server sample re-anchors forward", () => {
    const clock = accept(api.createRankedDisplayClock(), { serverElapsed: 10, nowMonoMs: 0 });
    const next = accept(clock, { serverElapsed: 12.5, nowMonoMs: 1_000 });
    near(shown(next, 1_000), 12.5);
    near(shown(next, 2_000), 13.5);
  });

  test("the readout caps at 60s and does not keep climbing", () => {
    let clock = accept(api.createRankedDisplayClock(), { serverElapsed: 59, nowMonoMs: 0 });
    clock = api.reconcileRankedDisplayClock(clock, live({ nowMonoMs: 5_000, serverElapsed: 59 }));
    assert.equal(clock.advancing, false);
    assert.equal(shown(clock, 5_000), 60);
    assert.equal(shown(clock, 20_000), 60);
    assert.equal(api.formatRankedTimerReadout(shown(clock, 20_000), 60), "60.0s / 60s");
    const again = api.reconcileRankedDisplayClock(clock, live({ nowMonoMs: 20_000, serverElapsed: 59 }));
    assert.equal(shown(again, 25_000), 60);
    assert.equal(api.formatRankedTimerReadout(59.96, 60), "59.9s / 60s");
    assert.equal(api.formatRankedTimerReadout(60, 60), "60.0s / 60s");
    assert.equal(api.formatRankedTimerReadout(65, 60), "60.0s / 60s");
    assert.equal(api.formatRankedTimerReadout(0, 60), "0.0s / 60s");

    const oversize = accept(api.createRankedDisplayClock(), {
      serverElapsed: 59,
      nowMonoMs: 0,
      durationSeconds: 90,
    });
    assert.equal(shown(oversize, 5_000, 90), 60);
    assert.equal(api.formatRankedTimerReadout(70, 90), "60.0s / 90s");
    const cappedSample = accept(api.createRankedDisplayClock(), { serverElapsed: 90, advancing: true });
    assert.equal(cappedSample.acceptedElapsed, 60);
    assert.equal(cappedSample.presented, 60);
    assert.equal(cappedSample.advancing, false);
  });

  test("completion freezes on the authoritative elapsed", () => {
    const running = accept(api.createRankedDisplayClock(), { serverElapsed: 58, nowMonoMs: 0 });
    const done = api.reconcileRankedDisplayClock(
      running,
      live({ nowMonoMs: 2_000, serverElapsed: 60, status: "completed" }),
    );
    assert.equal(done.advancing, false);
    assert.equal(shown(done, 20_000), 60);
    const later = api.reconcileRankedDisplayClock(
      done,
      live({ nowMonoMs: 20_000, serverElapsed: 60, status: "completed" }),
    );
    assert.equal(shown(later, 25_000), 60);
  });

  test("hidden and non-play freezes drop the away gap and still advance after resume", () => {
    const started = accept(api.createRankedDisplayClock(), { serverElapsed: 10, nowMonoMs: 0 });
    const hidden = api.reconcileRankedDisplayClock(
      started,
      live({ nowMonoMs: 2_000, hidden: true, serverElapsed: 10 }),
    );
    near(hidden.presented, 12);
    assert.equal(hidden.advancing, false);
    assert.equal(hidden.hold, "hidden");
    const stillHidden = api.reconcileRankedDisplayClock(
      hidden,
      live({ nowMonoMs: 20_000, hidden: true, serverElapsed: 10 }),
    );
    near(shown(stillHidden, 20_000), 12);
    const resumed = api.reconcileRankedDisplayClock(
      stillHidden,
      live({ nowMonoMs: 20_000, hidden: false, serverElapsed: 10 }),
    );
    near(shown(resumed, 20_000), 12);
    near(shown(resumed, 21_000), 13);
    assert.ok(shown(resumed, 21_000) < 20);

    const caughtUp = api.reconcileRankedDisplayClock(
      stillHidden,
      live({ nowMonoMs: 20_000, hidden: false, serverElapsed: 16 }),
    );
    near(shown(caughtUp, 20_000), 16);

    const away = api.reconcileRankedDisplayClock(
      started,
      live({ nowMonoMs: 2_000, route: "other", serverElapsed: 10 }),
    );
    assert.equal(away.hold, "non-play");
    const back = api.reconcileRankedDisplayClock(
      away,
      live({ nowMonoMs: 15_000, route: "play", serverElapsed: 10 }),
    );
    near(shown(back, 15_000), 12);
    near(shown(back, 16_000), 13);
  });

  test("stale telemetry, recovery, egg, reset, and interruption stop or clear the clock", () => {
    const started = accept(api.createRankedDisplayClock(), { serverElapsed: 10, nowMonoMs: 0 });
    const stale = api.reconcileRankedDisplayClock(
      started,
      live({ nowMonoMs: 2_000, telemetryHealthy: false }),
    );
    near(stale.presented, 12);
    assert.equal(stale.advancing, false);
    assert.equal(stale.hold, "stale-telemetry");
    const still = api.reconcileRankedDisplayClock(
      stale,
      live({ nowMonoMs: 9_000, telemetryHealthy: true, serverElapsed: 10 }),
    );
    assert.equal(still.advancing, false);
    near(shown(still, 9_000), 12);
    const accepted = accept(still, { serverElapsed: 12.4, nowMonoMs: 9_000 });
    near(shown(accepted, 9_000), 12.4);
    near(shown(accepted, 10_000), 13.4);

    const recovering = api.reconcileRankedDisplayClock(
      started,
      live({ nowMonoMs: 2_500, recovering: true }),
    );
    near(recovering.presented, 12.5);
    assert.equal(recovering.advancing, false);
    const during = api.reconcileRankedDisplayClock(
      recovering,
      live({ nowMonoMs: 10_000, recovering: false, serverElapsed: 10 }),
    );
    assert.equal(during.advancing, false);
    near(shown(during, 10_000), 12.5);

    for (const reason of ["egg", "reset", "interrupted"] as const) {
      const cleared = api.freezeRankedDisplayClock(started, 4_000, 60, reason);
      assert.equal(cleared.generation, null);
      assert.equal(cleared.sessionId, null);
      assert.equal(cleared.presented, 0);
      assert.equal(shown(cleared, 9_000), 0);
    }

    const egged = api.reconcileRankedDisplayClock(
      started,
      live({ nowMonoMs: 4_000, status: "egg", serverElapsed: 0 }),
    );
    assert.equal(egged.generation, null);
    assert.equal(shown(egged, 9_000), 0);
  });

  test("a stale generation cannot resurrect an old clock", () => {
    const old = accept(api.createRankedDisplayClock(), { serverElapsed: 40, nowMonoMs: 0 });
    const cleared = api.createRankedDisplayClock();
    const resurrect = accept(cleared, {
      responseGeneration: 1,
      liveGeneration: 2,
      serverElapsed: 40,
      nowMonoMs: 10_000,
      advancing: true,
    });
    assert.equal(resurrect, cleared);
    assert.equal(shown(resurrect, 10_000), 0);

    const ignored = accept(old, {
      responseGeneration: 1,
      liveGeneration: 2,
      serverElapsed: 0,
      nowMonoMs: 5_000,
      advancing: true,
    });
    assert.equal(ignored, old);
    const stopped = api.reconcileRankedDisplayClock(
      ignored,
      live({ liveGeneration: 2, serverElapsed: 99, nowMonoMs: 5_000 }),
    );
    assert.equal(stopped.advancing, false);
    assert.equal(shown(stopped, 5_000), 40);
    assert.equal(shown(stopped, 9_000), 40);

    const restarted = accept(cleared, {
      responseGeneration: 4,
      liveGeneration: 4,
      serverElapsed: 0,
      nowMonoMs: 0,
    });
    near(shown(restarted, 1_000), 1);
    assert.ok(shown(restarted, 1_000) < 2);

    const bare = api.reconcileRankedDisplayClock(
      api.createRankedDisplayClock(),
      live({ nowMonoMs: 5_000, serverElapsed: 40 }),
    );
    assert.equal(bare.advancing, false);
    assert.equal(bare.generation, null);
    assert.equal(shown(bare, 5_000), 0);
  });

  test("generation 0 is a real anchor, and backward or invalid times do not rewind", () => {
    const clock = accept(api.createRankedDisplayClock(), {
      responseGeneration: 0,
      liveGeneration: 0,
      serverElapsed: 4,
      nowMonoMs: 100,
    });
    assert.equal(clock.generation, 0);
    near(shown(clock, 1_100), 5);
    assert.equal(shown(clock, 50), 4);

    const nan = accept(api.createRankedDisplayClock(), { serverElapsed: Number.NaN, nowMonoMs: 0 });
    assert.equal(shown(nan, 0), 0);
    const negative = accept(api.createRankedDisplayClock(), { serverElapsed: -5, nowMonoMs: 50 });
    assert.equal(shown(negative, 50), 0);
    near(shown(negative, 1_050), 1);
  });
});

describe("Ranked display clock wiring", () => {
  const source = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

  function extractFunction(signature: string): string {
    const start = source.indexOf(signature);
    assert.notEqual(start, -1, `missing ${signature}`);
    const open = source.indexOf("{", start);
    assert.notEqual(open, -1, `missing body ${signature}`);
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error(`unclosed ${signature}`);
  }

  test("the 200ms loop paints timer text while a tick is in flight and does not retune the heartbeat", () => {
    const loopStart = source.indexOf("// ---------- Simulation / Illumination Loop ----------");
    const loopEnd = source.indexOf("// Poll hardware status every 2.5s", loopStart);
    const loop = source.slice(loopStart, loopEnd);
    assert.equal(loop.includes("}, 200);"), true);
    assert.equal(loop.includes("}, 2000);"), false);
    assert.equal(loop.includes("}, 2_000);"), false);
    assert.equal(loop.includes("}, 1000);"), false);
    assert.equal(loop.includes("}, 5000);"), false);
    assert.equal(loop.match(/setInterval\(/g)?.length, 1);
    assert.equal(loop.includes("serverTickInFlight = true"), true);
    assert.equal(loop.includes("!serverTickInFlight"), true);
    assert.equal(loop.includes('"/api/session/tick"'), true);
    assert.equal(loop.includes("syncTelemetryFreshness(nowMs)"), true);
    assert.match(
      loop,
      /renderPlayDynamicSections\(\);\s*\}\s*(?:\/\/[^\n]*\n\s*)?paintRankedDisplayTimer\(\);\s*\}, 200\);/,
    );
    assert.ok(loop.indexOf("paintRankedDisplayTimer()") > loop.indexOf("!serverTickInFlight"));
    assert.equal(source.includes('"/api/session/tick"'), true);
  });

  test("timer paint and anchoring do not mutate session fields or rebuild the play controls", () => {
    const paint = extractFunction("function paintRankedDisplayTimer(");
    assert.equal(paint.includes("renderPlayDynamicSections"), false);
    assert.equal(paint.includes("redrawStageCanvas"), false);
    assert.equal(paint.includes("apiFetch"), false);
    assert.equal(paint.includes(".elapsed ="), false);
    assert.match(paint, /timerEl\.textContent/);

    const apply = extractFunction("function applyAcceptedRankedDisplay(");
    assert.match(apply, /serverElapsed: session\.elapsed/);
    assert.equal(apply.includes(".elapsed ="), false);
    assert.equal(apply.includes(".regions"), false);
    assert.equal(apply.includes("lockedTraits"), false);
    assert.equal(apply.includes("apiFetch"), false);
    assert.match(apply, /responseGeneration !== rankedWriteEpoch/);

    const readout = extractFunction("function readoutForTimer(");
    assert.match(readout, /projectRankedDisplay/);
    assert.match(readout, /sess\.elapsed\.toFixed\(1\)/);
    assert.equal(readout.includes("readyToComplete"), false);
    assert.equal(readout.includes(".elapsed ="), false);

    const sync = extractFunction("function syncRankedDisplayClock(");
    assert.match(sync, /performance\.now\(\)/);
    assert.match(sync, /serverElapsed: rankedSession\.elapsed/);
    assert.equal(sync.includes(".elapsed ="), false);

    assert.match(source, /const readyToHatch = sess\.elapsed \+ 1e-6 >= sessPolicy\.durationSeconds;/);
    assert.match(source, /if \(sess\.elapsed \+ 1e-6 < sessPolicy\.durationSeconds\)/);
    assert.match(source, /if \(res\.data\.readyToComplete && !rankedSnapshot\)/);
    assert.equal(/rankedSession!?\s*\.elapsed\s*=/.test(source), false);
    assert.equal(/rankedSession!?\s*\.regions\s*=/.test(source), false);
    assert.equal(/rankedSession!?\s*\.lockedTraits\s*=/.test(source), false);
    assert.match(extractFunction("function interruptRankedAttempt("), /createRankedDisplayClock\(\)/);
    assert.match(extractFunction("function invalidateRankedWrites("), /createRankedDisplayClock\(\)/);

    const aimStart = source.indexOf("async function handleAimLamp");
    const aimLocal = source.indexOf("sess.lampPosition = clampedPos;", aimStart);
    const aimFetch = source.indexOf('"/api/session/aim"', aimStart);
    assert.ok(aimLocal !== -1 && aimLocal < aimFetch);
    assert.match(source, /void handlePauseIllumination\(\)/);
    assert.equal((source.match(/paintRankedDisplayTimer\(/g) ?? []).length, 3);
    assert.equal((source.match(/syncRankedDisplayClock\(/g) ?? []).length, 5);
    assert.equal((source.match(/applyAcceptedRankedDisplay\(/g) ?? []).length, 7);
  });

  test("a stale tick is ignored before it can repaint or announce, while the heartbeat still sends the desired lamp", () => {
    const tick = source.indexOf('"/api/session/tick"');
    const handler = source.indexOf(".then(async (res)", tick);
    const guard = source.indexOf("ignoreRankedFailure", handler);
    const install = source.indexOf("installRankedSession", handler);
    const ingest = source.indexOf("ingestBackendReading", install);
    const interrupt = source.indexOf("interruptRankedAttempt", handler);
    assert.ok(guard !== -1 && guard < interrupt);
    assert.ok(install !== -1 && install < ingest);
    assert.match(source, /lampPosition: rankedSession\.lampPosition/);
    assert.match(source, /\.\.\.rankedOrderBody\(\)/);
    assert.match(source, /sess\.lampPosition = clampedPos;/);
    assert.equal(source.includes("}, 200);"), true);
  });
});

describe("Ranked response ordering", () => {
  test("an older revision does not roll back a confirmed or in-progress aim", async () => {
    const { createLedSession, createRankedClientCursor, decideRankedSessionInstall, noteRankedDesiredAim, rankedCommandFailureIsCurrent } =
      await import("../src/led-session.ts");
    const older = createLedSession({ id: "sess-order", mode: "ranked", familyIndex: 0 });
    older.lampPosition = 70;
    older.elapsed = 4;
    older.intentOrder = { attemptId: "attempt-1", aimIntent: 1, revision: 4, adopted: true };
    let cursor = createRankedClientCursor();
    const first = decideRankedSessionInstall({
      cursor,
      incoming: older,
      requestEpoch: 1,
      currentEpoch: 1,
      expectedSessionId: null,
    });
    assert.equal(first.apply, true);
    cursor = first.cursor;
    cursor = noteRankedDesiredAim(cursor, 0);
    cursor = { ...cursor, dragging: true };
    const stale = createLedSession({ id: "sess-order", mode: "ranked", familyIndex: 0 });
    stale.lampPosition = 70;
    stale.elapsed = 4.2;
    stale.intentOrder = { attemptId: "attempt-1", aimIntent: 1, revision: 4, adopted: true };
    const rejected = decideRankedSessionInstall({
      cursor,
      incoming: stale,
      requestEpoch: 1,
      currentEpoch: 1,
      expectedSessionId: "sess-order",
    });
    assert.equal(rejected.apply, false);
    assert.equal(rejected.sideEffects, false);
    assert.equal(rejected.cursor.desiredLamp, 0);
    assert.equal(rejected.cursor.confirmedRevision, 4);
    const progress = { ...stale, elapsed: 5, intentOrder: { ...stale.intentOrder!, revision: 6 } };
    const kept = decideRankedSessionInstall({
      cursor,
      incoming: progress,
      requestEpoch: 1,
      currentEpoch: 1,
      expectedSessionId: "sess-order",
    });
    assert.equal(kept.apply, true);
    assert.equal(kept.session?.lampPosition, 0);
    assert.equal(kept.session?.elapsed, 5);
    assert.equal(kept.cursor.dragging, true);
    assert.equal(
      rankedCommandFailureIsCurrent({
        requestEpoch: 1,
        currentEpoch: 1,
        expectedSessionId: "sess-order",
        cursor: kept.cursor,
        capturedAttemptId: "attempt-1",
        capturedRevision: 4,
        capturedSessionId: "sess-order",
      }),
      false,
    );
    const repeated = noteRankedDesiredAim(kept.cursor, 0);
    assert.equal(repeated.desiredIntent, kept.cursor.desiredIntent);
  });
});
