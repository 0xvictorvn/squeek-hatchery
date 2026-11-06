import assert from "node:assert/strict";
import test from "node:test";
import { HatcheryBackend } from "../src/backend.ts";
import { EXPERIMENTAL_POLICY_V4 } from "../src/game-policy.ts";
import type { LedSession } from "../src/led-session.ts";
import { measurementDayKey } from "../src/rules.ts";

async function loadRecovery() {
  return import("../src/ranked-recovery.ts").catch(() => {
    assert.fail("The authoritative ranked recovery operation is missing.");
  });
}

async function activeFixture() {
  let now = Date.parse("2026-11-06T13:00:00Z");
  const wallet = "0x1111111111111111111111111111111111111111";
  const backend = new HatcheryBackend({
    dbPath: ":memory:", policy: EXPERIMENTAL_POLICY_V4, autoStartProducer: false, now: () => now,
    hardwareProvider: async () => ({ source: "live", reading: {
      coreStatus: "ACTIVE", rpm: 65, meters: 10, distanceMm: 10000, work: 100n,
      observedAt: now, received: now, staleAfterSeconds: 120,
      counterEpoch: "recovery", installationId: "recovery", utcDate: measurementDayKey(now),
    } }),
  });
  const egg = backend.claimRankedEgg(wallet, { familyIndex: 2 });
  await backend.pollProducerTick();
  await backend.startRankedIllumination(wallet, { sessionId: egg.id });
  now += 5000; await backend.pollProducerTick();
  await backend.tickRankedSession(wallet, { sessionId: egg.id });
  const readActive = async () => ({
    session: await backend.getActiveRankedSession(wallet), allowance: backend.getDailyAllowanceDto(wallet),
  });
  const restart = async (sessionId: string) => ({
    ...await backend.restartRankedSession(wallet, { sessionId }), allowance: backend.getDailyAllowanceDto(wallet),
  });
  return { backend, wallet, egg, readActive, restart, advance: async (ms: number) => {
    now += ms; await backend.pollProducerTick();
    return backend.tickRankedSession(wallet, { sessionId: egg.id });
  } };
}

test("reload recovery clears server progress and locks while preserving egg, family and allowance", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture();
  try {
    const result = await restoreRankedAttempt({ readActive: f.readActive, restart: f.restart, resetUnfinished: true, isCurrent: () => true });
    assert.ok(result?.session);
    assert.equal(result.session.id, f.egg.id);
    assert.equal(result.session.familyIndex, 2);
    assert.equal(result.session.status, "egg");
    assert.equal(result.session.elapsed, 0);
    assert.equal(result.session.lockedTraits, null);
    assert.deepEqual(result.session.regions.map(r => [r.level, r.dose, r.exposure]), [[0,0,0],[0,0,0],[0,0,0]]);
    assert.equal(result.allowance?.remaining, 3);
    const stored = await f.backend.getActiveRankedSession(f.wallet);
    assert.equal(stored?.lockedTraits, null);
    assert.equal(stored?.elapsed, 0);
  } finally { f.backend.close(); }
});

test("ordinary refresh retains the valid active attempt", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture();
  try {
    const result = await restoreRankedAttempt({ readActive: f.readActive, restart: f.restart, resetUnfinished: false, isCurrent: () => true });
    assert.equal(result?.session?.status, "running");
    assert.equal(result?.session?.elapsed, 5);
    assert.ok(result?.session?.lockedTraits);
    assert.equal((await f.readActive()).session?.elapsed, 5);
  } finally { f.backend.close(); }
});

test("a completed restore never restarts or changes the stored result", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture();
  try {
    await f.advance(15000); await f.advance(20000); await f.advance(20000);
    const completed = await f.backend.completeRankedSession(f.wallet, { sessionId: f.egg.id });
    const before = JSON.stringify(f.backend.getPublicResultById(completed.resultId));
    const row = f.backend.db.prepare("SELECT session_json FROM ranked_sessions WHERE session_id = ?").get(f.egg.id) as { session_json: string };
    const terminal = JSON.parse(row.session_json) as LedSession;
    const result = await restoreRankedAttempt({
      readActive: async () => ({ session: terminal, allowance: f.backend.getDailyAllowanceDto(f.wallet) }),
      restart: f.restart, resetUnfinished: true, isCurrent: () => true,
    });
    assert.equal(result?.session?.status, "completed");
    assert.equal(result?.session?.elapsed, 60);
    assert.equal(result?.allowance?.remaining, 2);
    assert.equal(JSON.stringify(f.backend.getPublicResultById(completed.resultId)), before);
  } finally { f.backend.close(); }
});

test("failed reset rejects instead of returning the old locked attempt", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture();
  try {
    await assert.rejects(() => restoreRankedAttempt({
      readActive: f.readActive, restart: async () => { throw new Error("offline"); }, resetUnfinished: true, isCurrent: () => true,
    }), /offline/);
    assert.equal((await f.readActive()).session?.elapsed, 5);
  } finally { f.backend.close(); }
});

test("a stale active response cannot reset a newer client generation", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture(); let current = true; let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  try {
    const pending = restoreRankedAttempt({ readActive: async () => { await delayed; return f.readActive(); },
      restart: f.restart, resetUnfinished: true, isCurrent: () => current });
    current = false; release();
    assert.equal(await pending, null);
    assert.equal((await f.readActive()).session?.elapsed, 5);
  } finally { f.backend.close(); }
});

test("a stale reset reply cannot be installed into a newer client generation", async () => {
  const { restoreRankedAttempt } = await loadRecovery();
  const f = await activeFixture(); let current = true;
  try {
    const result = await restoreRankedAttempt({ readActive: f.readActive, restart: async id => {
      const reset = await f.restart(id); current = false; return reset;
    }, resetUnfinished: true, isCurrent: () => current });
    assert.equal(result, null);
    assert.equal((await f.readActive()).session?.elapsed, 0);
  } finally { f.backend.close(); }
});
