import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import {
  CHALLENGE_TTL_MS,
  HatcheryBackend,
  SESSION_TTL_MS,
} from "../src/backend.ts";
import { EXPERIMENTAL_POLICY_V1, EXPERIMENTAL_POLICY_V4 } from "../src/game-policy.ts";
import { measurementDayKey, type Reading } from "../src/rules.ts";

const WALLET_A = privateKeyToAccount(generatePrivateKey());
const WALLET_B = privateKeyToAccount(generatePrivateKey());

async function startTestBackendServer(options: {
  dbPath?: string;
  initialTimeMs?: number;
  initialReading?: Partial<Reading>;
} = {}) {
  let nowMs = options.initialTimeMs ?? Date.parse("2026-11-06T13:00:00.000Z");
  let currentReading: Reading = {
    coreStatus: "ACTIVE",
    rpm: 65,
    meters: 300,
    distanceMm: 300_000,
    work: 400n,
    counterEpoch: "epoch-1",
    installationId: "wheel-test-1",
    observedAt: nowMs,
    received: nowMs,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(nowMs),
    ...options.initialReading,
  };

  const hasExistingDb = Boolean(
    options.dbPath && options.dbPath !== ":memory:" && fs.existsSync(options.dbPath),
  );
  const dayRolloverMs = Date.parse("2026-11-06T12:00:05.000Z");
  let bgCounter = 0;
  const backend = new HatcheryBackend({
    dbPath: options.dbPath ?? ":memory:",
    policy: EXPERIMENTAL_POLICY_V1,
    now: () => nowMs,
    csprngInt: (max) => {
      const val = (bgCounter * 233) % max;
      bgCounter++;
      return val;
    },
    hardwareProvider: async () => ({
      reading: {
        ...currentReading,
        observedAt: nowMs,
        received: nowMs,
        utcDate: measurementDayKey(nowMs),
      },
      source: "live",
    }),
  });

  // Seed day-rollover zero baseline if DB has no persisted hardware state yet
  if (!hasExistingDb && nowMs >= dayRolloverMs) {
    backend.ingestHardwareReading(
      {
        coreStatus: "ACTIVE",
        rpm: 65,
        meters: 0,
        distanceMm: 0,
        work: 0n,
        counterEpoch: "epoch-1",
        installationId: "wheel-test-1",
        observedAt: dayRolloverMs,
        received: dayRolloverMs,
        staleAfterSeconds: 60,
        utcDate: measurementDayKey(dayRolloverMs),
      },
      "live",
      dayRolloverMs,
    );
  }

  const server = http.createServer((req, res) => {
    void backend.handleApiRequest(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  const origin = `http://127.0.0.1:${addr.port}`;

  async function request<T = Record<string, unknown>>(
    pathname: string,
    init: {
      method?: string;
      body?: unknown;
      cookie?: string;
      originHeader?: string | null;
      hostHeader?: string;
    } = {},
  ): Promise<{
    status: number;
    data: T;
    setCookie: string | undefined;
  }> {
    const method = init.method ?? (init.body !== undefined ? "POST" : "GET");
    const headers: Record<string, string> = {};
    if (init.originHeader !== null) {
      headers.origin = init.originHeader ?? origin;
    }
    if (init.cookie) {
      headers.cookie = init.cookie;
    }
    if (init.body !== undefined) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${origin}${pathname}`, {
      method,
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const setCookie = res.headers.get("set-cookie") ?? undefined;
    const data = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, data, setCookie };
  }

  async function signInAccount(account: ReturnType<typeof privateKeyToAccount>) {
    const chal = await request<{
      challengeId: string;
      nonce: string;
      message: string;
      chainId: number;
    }>("/api/auth/challenge", {
      method: "POST",
      body: { walletAddress: account.address, chainId: 11155111 },
    });
    assert.equal(chal.status, 200);
    const signature = await account.signMessage({ message: chal.data.message });
    const ver = await request<{
      authenticated: boolean;
      player: { walletAddress: string; effectiveName: string; shortWallet: string };
    }>("/api/auth/verify", {
      method: "POST",
      body: {
        challengeId: chal.data.challengeId,
        walletAddress: account.address,
        signature,
        chainId: 11155111,
      },
    });
    assert.equal(ver.status, 200);
    assert.ok(ver.setCookie);
    assert.match(ver.setCookie, /HttpOnly/i);
    assert.match(ver.setCookie, /SameSite=Lax/i);
    const cookiePair = ver.setCookie.split(";")[0]!;
    return { cookie: cookiePair, player: ver.data.player };
  }

  return {
    backend,
    server,
    origin,
    request,
    signInAccount,
    advanceTimeMs: (deltaMs: number) => {
      nowMs += deltaMs;
    },
    setReading: (patch: Partial<Reading>) => {
      currentReading = { ...currentReading, ...patch };
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      backend.close();
    },
  };
}

test("SIWE challenge-response auth: valid login, invalid sig, replay, parallel verify, expiry, wrong origin/chain, logout", async () => {
  const ctx = await startTestBackendServer();
  try {
    // 0. Missing Origin header on POST is rejected (CSRF protection)
    const noOrigin = await ctx.request("/api/auth/challenge", {
      method: "POST",
      originHeader: null,
      body: { walletAddress: WALLET_A.address },
    });
    assert.equal(noOrigin.status, 403);

    // Cross-origin POST is rejected
    const badOrigin = await ctx.request("/api/auth/challenge", {
      method: "POST",
      originHeader: "http://evil.example.com",
      body: { walletAddress: WALLET_A.address },
    });
    assert.equal(badOrigin.status, 403);

    // 1. Wrong wallet signature rejected
    const chal1 = await ctx.request<{ challengeId: string; message: string }>(
      "/api/auth/challenge",
      {
        method: "POST",
        body: { walletAddress: WALLET_A.address, chainId: 11155111 },
      },
    );
    const wrongSig = await WALLET_B.signMessage({ message: chal1.data.message });
    const badVerify = await ctx.request("/api/auth/verify", {
      method: "POST",
      body: {
        challengeId: chal1.data.challengeId,
        walletAddress: WALLET_A.address,
        signature: wrongSig,
      },
    });
    assert.equal(badVerify.status, 401);

    // 2. Wrong chainId rejected
    const rightSig1 = await WALLET_A.signMessage({ message: chal1.data.message });
    const badChain = await ctx.request("/api/auth/verify", {
      method: "POST",
      body: {
        challengeId: chal1.data.challengeId,
        walletAddress: WALLET_A.address,
        signature: rightSig1,
        chainId: 1,
      },
    });
    assert.equal(badChain.status, 401);

    // 3. Expired challenge rejected
    const chalExp = await ctx.request<{ challengeId: string; message: string }>(
      "/api/auth/challenge",
      {
        method: "POST",
        body: { walletAddress: WALLET_A.address, chainId: 11155111 },
      },
    );
    const expSig = await WALLET_A.signMessage({ message: chalExp.data.message });
    ctx.advanceTimeMs(CHALLENGE_TTL_MS + 1000);
    const expiredRes = await ctx.request("/api/auth/verify", {
      method: "POST",
      body: {
        challengeId: chalExp.data.challengeId,
        walletAddress: WALLET_A.address,
        signature: expSig,
      },
    });
    assert.equal(expiredRes.status, 401);

    // 4. Parallel verify with the same challenge: only one succeeds, replay rejected
    const chalPar = await ctx.request<{ challengeId: string; message: string }>(
      "/api/auth/challenge",
      {
        method: "POST",
        body: { walletAddress: WALLET_A.address, chainId: 11155111 },
      },
    );
    const parSig = await WALLET_A.signMessage({ message: chalPar.data.message });
    const [v1, v2] = await Promise.all([
      ctx.request("/api/auth/verify", {
        method: "POST",
        body: {
          challengeId: chalPar.data.challengeId,
          walletAddress: WALLET_A.address,
          signature: parSig,
        },
      }),
      ctx.request("/api/auth/verify", {
        method: "POST",
        body: {
          challengeId: chalPar.data.challengeId,
          walletAddress: WALLET_A.address,
          signature: parSig,
        },
      }),
    ]);
    const statuses = [v1.status, v2.status].sort();
    assert.deepEqual(statuses, [200, 401]);

    // Sequential replay of used challenge also fails
    const replayRes = await ctx.request("/api/auth/verify", {
      method: "POST",
      body: {
        challengeId: chalPar.data.challengeId,
        walletAddress: WALLET_A.address,
        signature: parSig,
      },
    });
    assert.equal(replayRes.status, 401);

    // 5. Session inspection, session expiry, and logout
    const winnerCookie = (v1.setCookie ?? v2.setCookie)!.split(";")[0]!;
    const sessCheck = await ctx.request<{ authenticated: boolean }>(
      "/api/auth/session",
      { cookie: winnerCookie },
    );
    assert.equal(sessCheck.data.authenticated, true);

    // Logout revokes session
    const logoutRes = await ctx.request("/api/auth/logout", {
      method: "POST",
      cookie: winnerCookie,
      body: {},
    });
    assert.equal(logoutRes.status, 200);
    const afterLogout = await ctx.request<{ authenticated: boolean }>(
      "/api/auth/session",
      { cookie: winnerCookie },
    );
    assert.equal(afterLogout.data.authenticated, false);

    // Sign in again and verify session expiry after TTL
    const { cookie: freshCookie } = await ctx.signInAccount(WALLET_A);
    ctx.advanceTimeMs(SESSION_TTL_MS + 5000);
    const afterExpiry = await ctx.request<{ authenticated: boolean }>(
      "/api/auth/session",
      { cookie: freshCookie },
    );
    assert.equal(afterExpiry.data.authenticated, false);
  } finally {
    await ctx.close();
  }
});

test("Player display name: empty fallback, >30 chars & XSS rejection, and duplicate names across two wallets without collision", async () => {
  const ctx = await startTestBackendServer();
  try {
    const authA = await ctx.signInAccount(WALLET_A);
    const authB = await ctx.signInAccount(WALLET_B);

    // Initially empty display name falls back to shortened wallet
    assert.equal(authA.player.effectiveName, authA.player.shortWallet);

    // Reject >30 chars and XSS characters
    const tooLong = await ctx.request("/api/profile", {
      method: "PUT",
      cookie: authA.cookie,
      body: { displayName: "X".repeat(31) },
    });
    assert.equal(tooLong.status, 400);

    const xssAttempt = await ctx.request("/api/profile", {
      method: "PUT",
      cookie: authA.cookie,
      body: { displayName: "<img src=x onerror=alert(1)>" },
    });
    assert.equal(xssAttempt.status, 400);

    // Wallet A cannot modify Wallet B's profile
    const crossEdit = await ctx.request("/api/profile", {
      method: "PUT",
      cookie: authA.cookie,
      body: { walletAddress: WALLET_B.address, displayName: "Hijack" },
    });
    assert.equal(crossEdit.status, 403);

    // Both Wallet A and Wallet B set the exact same display name "TwinPilot"
    const setA = await ctx.request<{ player: { effectiveName: string; walletAddress: string } }>(
      "/api/profile",
      {
        method: "PUT",
        cookie: authA.cookie,
        body: { displayName: "TwinPilot" },
      },
    );
    const setB = await ctx.request<{ player: { effectiveName: string; walletAddress: string } }>(
      "/api/profile",
      {
        method: "PUT",
        cookie: authB.cookie,
        body: { displayName: "TwinPilot" },
      },
    );
    assert.equal(setA.status, 200);
    assert.equal(setB.status, 200);
    assert.equal(setA.data.player.effectiveName, "TwinPilot");
    assert.equal(setB.data.player.effectiveName, "TwinPilot");
    assert.notEqual(
      setA.data.player.walletAddress.toLowerCase(),
      setB.data.player.walletAddress.toLowerCase(),
    );

    // Clearing Wallet A's display name falls back to Wallet A's short address without affecting Wallet B
    const clearA = await ctx.request<{ player: { effectiveName: string; displayName: string | null } }>(
      "/api/profile",
      {
        method: "PUT",
        cookie: authA.cookie,
        body: { displayName: "   " },
      },
    );
    assert.equal(clearA.status, 200);
    assert.equal(clearA.data.player.displayName, null);
    assert.equal(clearA.data.player.effectiveName, authA.player.shortWallet);

    const checkB = await ctx.request<{ player: { effectiveName: string } }>(
      "/api/auth/session",
      { cookie: authB.cookie },
    );
    assert.equal(checkB.data.player.effectiveName, "TwinPilot");
  } finally {
    await ctx.close();
  }
});

test("Anti-cheat session authority: guest blocked, client-supplied fields rejected, 1 session/wallet, simultaneous lock, idempotent complete", async () => {
  const ctx = await startTestBackendServer();
  try {
    // 0. IDLE wheel reading preserves final spin-down positive delta (R6) while stationary IDLE does not advance
    const snapActive0 = await ctx.backend.getHardwareTelemetry();
    assert.equal(snapActive0.scheduleDistanceMm, 300_000);
    assert.equal(snapActive0.cumulativeWorkUnits, "400");

    ctx.setReading({
      coreStatus: "IDLE",
      rpm: 0,
      distanceMm: 325_000,
      work: 425n,
    });
    ctx.advanceTimeMs(2_000);
    const snapIdleWithDelta = await ctx.backend.getHardwareTelemetry();
    assert.equal(snapIdleWithDelta.scheduleDistanceMm, 325_000);
    assert.equal(snapIdleWithDelta.cumulativeWorkUnits, "425");

    // Stationary IDLE reading (same counters) does not advance schedules
    ctx.advanceTimeMs(2_000);
    const snapIdleStationary = await ctx.backend.getHardwareTelemetry();
    assert.equal(snapIdleStationary.scheduleDistanceMm, 325_000);
    assert.equal(snapIdleStationary.cumulativeWorkUnits, "425");

    // Restore ACTIVE reading (still within step 3 = 300m..399m -> Pearl 7, step 4 = 400..499 units -> Eclipse Mask 7)
    ctx.setReading({
      coreStatus: "ACTIVE",
      rpm: 65,
      distanceMm: 325_000,
      work: 425n,
    });
    ctx.advanceTimeMs(2_000);
    await ctx.backend.getHardwareTelemetry();
    // 1. Unauthenticated guest cannot call ranked session endpoints and writes 0 DB rows
    const guestEgg = await ctx.request("/api/session/egg", {
      method: "POST",
      body: { familyId: "pulse" },
    });
    assert.equal(guestEgg.status, 401);

    const authA = await ctx.signInAccount(WALLET_A);
    const authB = await ctx.signInAccount(WALLET_B);

    // 2. Client-supplied authoritative fields are rejected with 400
    for (const forbiddenPayload of [
      { familyId: "pulse", score: 999 },
      { familyId: "pulse", totalScore: 54 },
      { familyId: "pulse", levels: [10, 10, 10] },
      { familyId: "pulse", elapsed: 60 },
      { familyId: "pulse", rpm: 200 },
      { familyId: "pulse", paletteIndex: 9 },
      { familyId: "pulse", accessoryIndex: 9 },
      { familyId: "pulse", backgroundIndex: 9 },
    ]) {
      const badReq = await ctx.request("/api/session/egg", {
        method: "POST",
        cookie: authA.cookie,
        body: forbiddenPayload,
      });
      assert.equal(badReq.status, 400);
    }

    // 3. Claim ranked egg -> succeeds, and claiming a second parallel egg for the same wallet fails (409)
    const eggRes = await ctx.request<{ session: { id: string; lockedTraits: null } }>(
      "/api/session/egg",
      {
        method: "POST",
        cookie: authA.cookie,
        body: { familyId: "pulse", lampPosition: -70 },
      },
    );
    assert.equal(eggRes.status, 201);
    const sessionId = eggRes.data.session.id;

    const secondEgg = await ctx.request("/api/session/egg", {
      method: "POST",
      cookie: authA.cookie,
      body: { familyId: "relay" },
    });
    assert.equal(secondEgg.status, 409);

    // Cannot complete before starting illumination and locking traits
    const prematureComplete = await ctx.request("/api/session/complete", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId },
    });
    assert.equal(prematureComplete.status, 400);

    // 4. Start illumination at 300m / 400 work units -> locks Pearl (7) & Eclipse mask (7) simultaneously
    const start1 = await ctx.request<{
      session: {
        lockedTraits: { paletteIndex: number; accessoryIndex: number; paletteId: string; accessoryId: string };
      };
    }>("/api/session/start", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId },
    });
    assert.equal(start1.status, 200);
    assert.equal(start1.data.session.lockedTraits.paletteIndex, 7);
    assert.equal(start1.data.session.lockedTraits.accessoryIndex, 7);

    // Wheel advances to 800m / 900 work units, player pauses, aims, and resumes -> locked traits never change!
    ctx.setReading({ distanceMm: 800_000, meters: 800, work: 900n });
    ctx.advanceTimeMs(20_000); // 20s on Head -> Lv10

    const aimMiddle = await ctx.request<{
      session: {
        regions: { level: number }[];
        lockedTraits: { paletteIndex: number; accessoryIndex: number };
      };
    }>("/api/session/aim", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId, lampPosition: 0 },
    });
    assert.equal(aimMiddle.status, 200);
    assert.equal(aimMiddle.data.session.regions[0]!.level, 10);
    assert.equal(aimMiddle.data.session.lockedTraits.paletteIndex, 7);
    assert.equal(aimMiddle.data.session.lockedTraits.accessoryIndex, 7);

    // Wallet B cannot hijack Wallet A's session
    const hijack = await ctx.request("/api/session/pause", {
      method: "POST",
      cookie: authB.cookie,
      body: { sessionId },
    });
    assert.equal(hijack.status, 403);

    // Advance 20s on Middle -> Lv10, then 20s on Lower -> Lv10
    ctx.advanceTimeMs(20_000);
    await ctx.request("/api/session/aim", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId, lampPosition: 70 },
    });
    ctx.advanceTimeMs(20_000);

    // 5. Parallel / repeated completion calls are idempotent and never reroll the server-bound background
    const [comp1, comp2, comp3] = await Promise.all([
      ctx.request<{
        idempotent: boolean;
        resultId: string;
        snapshot: { backgroundIndex: number; scores: { total: number } };
      }>("/api/session/complete", {
        method: "POST",
        cookie: authA.cookie,
        body: { sessionId },
      }),
      ctx.request<{
        idempotent: boolean;
        resultId: string;
        snapshot: { backgroundIndex: number; scores: { total: number } };
      }>("/api/session/complete", {
        method: "POST",
        cookie: authA.cookie,
        body: { sessionId },
      }),
      ctx.request<{
        idempotent: boolean;
        resultId: string;
        snapshot: { backgroundIndex: number; scores: { total: number } };
      }>("/api/session/complete", {
        method: "POST",
        cookie: authA.cookie,
        body: {},
      }),
    ]);

    assert.equal(comp1.status, 200);
    assert.equal(comp2.status, 200);
    assert.equal(comp3.status, 200);
    assert.equal(comp1.data.resultId, comp2.data.resultId);
    assert.equal(comp2.data.resultId, comp3.data.resultId);
    assert.equal(
      comp1.data.snapshot.backgroundIndex,
      comp2.data.snapshot.backgroundIndex,
    );
    assert.equal(
      comp2.data.snapshot.backgroundIndex,
      comp3.data.snapshot.backgroundIndex,
    );
  } finally {
    await ctx.close();
  }
});

test("Weekly Top 100 Leaderboard & Public NFT View: 0, 1, 100, >100 records, tie-breaking, best-per-wallet, and DB restart persistence", async () => {
  const tmpDbPath = path.resolve(
    process.cwd(),
    "cache",
    `test-lb-${Date.now()}.sqlite`,
  );
  if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);

  const ctx = await startTestBackendServer({ dbPath: tmpDbPath });
  let firstResultId = "";
  try {
    // 1. Starts with 0 records (zero fake players)
    const emptyLb = await ctx.request<{ entries: unknown[]; totalQualifiedWallets: number }>(
      "/api/leaderboard",
    );
    assert.equal(emptyLb.status, 200);
    assert.equal(emptyLb.data.entries.length, 0);
    assert.equal(emptyLb.data.totalQualifiedWallets, 0);

    // 2. Wallet A completes 2 runs in the same week -> only the higher-scoring run represents Wallet A
    const authA = await ctx.signInAccount(WALLET_A);

    // Run 1 for Wallet A: full 60s run aimed only at Head (levels [10, 0, 0] -> lower score)
    const eggA1 = await ctx.request<{ session: { id: string } }>("/api/session/egg", {
      method: "POST",
      cookie: authA.cookie,
      body: { familyId: "pulse", lampPosition: -70 },
    });
    await ctx.request("/api/session/start", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA1.data.session.id },
    });
    ctx.advanceTimeMs(20_000);
    await ctx.request("/api/session/tick", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA1.data.session.id },
    });
    ctx.advanceTimeMs(20_000);
    await ctx.request("/api/session/tick", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA1.data.session.id },
    });
    ctx.advanceTimeMs(20_000);
    const compA1 = await ctx.request<{ resultId: string; snapshot: { scores: { total: number } } }>(
      "/api/session/complete",
      {
        method: "POST",
        cookie: authA.cookie,
        body: { sessionId: eggA1.data.session.id },
      },
    );
    assert.equal(compA1.status, 200);

    // 1 record on leaderboard
    const lb1 = await ctx.request<{ entries: { resultId: string; scores: { total: number } }[] }>(
      "/api/leaderboard",
    );
    assert.equal(lb1.data.entries.length, 1);
    assert.equal(lb1.data.entries[0]!.resultId, compA1.data.resultId);

    // Run 2 for Wallet A: full 60s run across all 3 regions (higher score)
    const eggA2 = await ctx.request<{ session: { id: string } }>("/api/session/egg", {
      method: "POST",
      cookie: authA.cookie,
      body: { familyId: "prism", lampPosition: -70 },
    });
    await ctx.request("/api/session/start", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA2.data.session.id },
    });
    ctx.advanceTimeMs(20_000);
    await ctx.request("/api/session/aim", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA2.data.session.id, lampPosition: 0 },
    });
    ctx.advanceTimeMs(20_000);
    await ctx.request("/api/session/aim", {
      method: "POST",
      cookie: authA.cookie,
      body: { sessionId: eggA2.data.session.id, lampPosition: 70 },
    });
    ctx.advanceTimeMs(20_000);
    const compA2 = await ctx.request<{ resultId: string; snapshot: { scores: { total: number } } }>(
      "/api/session/complete",
      {
        method: "POST",
        cookie: authA.cookie,
        body: { sessionId: eggA2.data.session.id },
      },
    );
    assert.equal(compA2.status, 200);
    assert.ok(compA2.data.snapshot.scores.total > compA1.data.snapshot.scores.total);
    firstResultId = compA2.data.resultId;

    const lbAfterA2 = await ctx.request<{
      totalQualifiedWallets: number;
      entries: { resultId: string; scores: { total: number } }[];
    }>("/api/leaderboard");
    assert.equal(lbAfterA2.data.totalQualifiedWallets, 1);
    assert.equal(lbAfterA2.data.entries.length, 1);
    assert.equal(lbAfterA2.data.entries[0]!.resultId, compA2.data.resultId);

    // 3. Seed 104 additional distinct wallets directly via backend API / session completion (total 105 wallets)
    // to verify 100 and >100 Top 100 cap and tie-breaking
    for (let i = 1; i <= 104; i++) {
      const acct = privateKeyToAccount(generatePrivateKey());
      const { cookie } = await ctx.signInAccount(acct);
      const egg = await ctx.request<{ session: { id: string } }>("/api/session/egg", {
        method: "POST",
        cookie,
        body: { familyId: i % 2 === 0 ? "relay" : "pulse", lampPosition: -70 },
      });
      await ctx.request("/api/session/start", {
        method: "POST",
        cookie,
        body: { sessionId: egg.data.session.id },
      });
      ctx.advanceTimeMs(20_000);
      await ctx.request("/api/session/tick", {
        method: "POST",
        cookie,
        body: { sessionId: egg.data.session.id },
      });
      ctx.advanceTimeMs(20_000);
      await ctx.request("/api/session/tick", {
        method: "POST",
        cookie,
        body: { sessionId: egg.data.session.id },
      });
      ctx.advanceTimeMs(20_000);
      await ctx.request("/api/session/complete", {
        method: "POST",
        cookie,
        body: { sessionId: egg.data.session.id },
      });

      if (i === 99) {
        // Exactly 100 wallets qualified
        const lb100 = await ctx.request<{
          totalQualifiedWallets: number;
          entries: { rank: number }[];
        }>("/api/leaderboard");
        assert.equal(lb100.data.totalQualifiedWallets, 100);
        assert.equal(lb100.data.entries.length, 100);
      }
    }

    const lb105 = await ctx.request<{
      totalQualifiedWallets: number;
      entries: { rank: number; resultId: string; scores: { total: number; regionsTotal: number }; completedAt: string }[];
    }>("/api/leaderboard");
    assert.equal(lb105.data.totalQualifiedWallets, 105);
    assert.equal(lb105.data.entries.length, 100); // Strictly capped at Top 100
    assert.equal(lb105.data.entries[0]!.rank, 1);
    assert.equal(lb105.data.entries[0]!.resultId, firstResultId);
    assert.equal(lb105.data.entries[99]!.rank, 100);

    // Verify monotonic ordering across all 100 entries
    for (let i = 1; i < lb105.data.entries.length; i++) {
      const prev = lb105.data.entries[i - 1]!;
      const curr = lb105.data.entries[i]!;
      assert.ok(prev.scores.total >= curr.scores.total);
      if (prev.scores.total === curr.scores.total) {
        assert.ok(prev.scores.regionsTotal >= curr.scores.regionsTotal);
      }
    }

    // Week and policyVersion filtering returns 0 for a different week or policy
    const otherWeekLb = await ctx.request<{ entries: unknown[] }>(
      "/api/leaderboard?weekKey=2099-W01",
    );
    assert.equal(otherWeekLb.data.entries.length, 0);
  } finally {
    await ctx.close();
  }

  // 4. Restart server on the same SQLite database file and verify public NFT view & leaderboard persist
  const restarted = await startTestBackendServer({ dbPath: tmpDbPath });
  try {
    const lbAfterRestart = await restarted.request<{
      totalQualifiedWallets: number;
      entries: { resultId: string }[];
    }>("/api/leaderboard");
    assert.equal(lbAfterRestart.status, 200);
    assert.equal(lbAfterRestart.data.totalQualifiedWallets, 105);
    assert.equal(lbAfterRestart.data.entries.length, 100);

    // Unauthenticated public viewer fetches Rank #1 NFT detail
    const nftDetail = await restarted.request<{
      resultId: string;
      leaderboardRank: number;
      snapshot: { familyId: string; levels: [number, number, number]; scores: { total: number } };
      metadata: { dimensions: { width: number; height: number } };
    }>(`/api/results/${encodeURIComponent(firstResultId)}`);
    assert.equal(nftDetail.status, 200);
    assert.equal(nftDetail.data.resultId, firstResultId);
    assert.equal(nftDetail.data.leaderboardRank, 1);
    assert.deepEqual(nftDetail.data.snapshot.levels, [10, 10, 10]);
    assert.deepEqual(nftDetail.data.metadata.dimensions, { width: 1600, height: 1600 });
  } finally {
    await restarted.close();
    try {
      if (fs.existsSync(tmpDbPath)) fs.unlinkSync(tmpDbPath);
      if (fs.existsSync(`${tmpDbPath}-wal`)) fs.unlinkSync(`${tmpDbPath}-wal`);
      if (fs.existsSync(`${tmpDbPath}-shm`)) fs.unlinkSync(`${tmpDbPath}-shm`);
    } catch {
      // ignore cleanup errors
    }
  }
});

type OrderedRankedSession = {
  id: string;
  status: string;
  lampPosition: number;
  elapsed: number;
  lockedTraits: unknown;
  regions: { dose: number; exposure: number; level: number }[];
  intentOrder?: { attemptId: string; aimIntent: number; revision: number; adopted: boolean };
};

function rankedDoses(session: OrderedRankedSession): [number, number, number] {
  return [session.regions[0]!.dose, session.regions[1]!.dose, session.regions[2]!.dose];
}

test("ordered tick and aim keep the newest lamp and match the no-reorder regional doses", async () => {
  const ctx = await startTestBackendServer({ initialTimeMs: Date.parse("2026-11-07T13:00:00.000Z") });
  try {
    const auth = await ctx.signInAccount(WALLET_A);
    const orderOf = (session: OrderedRankedSession) => {
      assert.ok(session.intentOrder);
      return session.intentOrder;
    };
    const claim = async (lampPosition: number) => {
      const egg = await ctx.request<{ session: OrderedRankedSession }>("/api/session/egg", {
        method: "POST",
        cookie: auth.cookie,
        body: { familyId: "pulse", lampPosition },
      });
      assert.equal(egg.status, 201);
      const started = await ctx.request<{ session: OrderedRankedSession }>("/api/session/start", {
        method: "POST",
        cookie: auth.cookie,
        body: {
          sessionId: egg.data.session.id,
          lampPosition,
          attemptId: orderOf(egg.data.session).attemptId,
          aimIntent: 0,
        },
      });
      assert.equal(started.status, 200);
      assert.equal(started.data.session.lampPosition, lampPosition);
      assert.equal(orderOf(started.data.session).adopted, true);
      return started.data.session;
    };
    const postSession = async (pathname: string, body: Record<string, unknown>, status = 200) => {
      const response = await ctx.request<{ session?: OrderedRankedSession; error?: string }>(pathname, {
        method: "POST",
        cookie: auth.cookie,
        body,
      });
      assert.equal(response.status, status, response.data.error ?? "");
      return response;
    };
    const playControl = async () => {
      const started = await claim(-80);
      const attemptId = orderOf(started).attemptId;
      ctx.advanceTimeMs(1000);
      const middle = await postSession("/api/session/aim", {
        sessionId: started.id,
        lampPosition: 0,
        attemptId,
        aimIntent: 1,
      });
      ctx.advanceTimeMs(1000);
      const lower = await postSession("/api/session/aim", {
        sessionId: started.id,
        lampPosition: 80,
        attemptId,
        aimIntent: 2,
      });
      ctx.advanceTimeMs(1000);
      const done = await postSession("/api/session/tick", {
        sessionId: started.id,
        lampPosition: 80,
        attemptId,
        aimIntent: 2,
      });
      await postSession("/api/session/abandon", { sessionId: started.id });
      return { middle: middle.data.session!, lower: lower.data.session!, done: done.data.session! };
    };
    const control = await playControl();
    assert.ok(control.done.regions[0]!.dose > 0);
    assert.ok(control.done.regions[1]!.dose > 0);
    assert.ok(control.done.regions[2]!.dose > 0);

    const started = await claim(-80);
    const attemptId = orderOf(started).attemptId;
    ctx.advanceTimeMs(1000);
    const heldTick = holdJson(ctx.origin, "/api/session/tick", auth.cookie, {
      sessionId: started.id,
      lampPosition: -80,
      attemptId,
      aimIntent: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(heldTick.finished(), false);
    const middle = await postSession("/api/session/aim", {
      sessionId: started.id,
      lampPosition: 0,
      attemptId,
      aimIntent: 1,
    });
    heldTick.release();
    const late = await heldTick.done;
    assert.equal(late.status, 200);
    const lateSession = late.data.session!;
    assert.equal(lateSession.lampPosition, 0);
    assert.deepEqual(rankedDoses(lateSession), rankedDoses(middle.data.session!));
    ctx.advanceTimeMs(1000);
    const lower = await postSession("/api/session/aim", {
      sessionId: started.id,
      lampPosition: 80,
      attemptId,
      aimIntent: 2,
    });
    ctx.advanceTimeMs(1000);
    const done = await postSession("/api/session/tick", {
      sessionId: started.id,
      lampPosition: 80,
      attemptId,
      aimIntent: 2,
    });
    assert.equal(done.data.session!.lampPosition, 80);
    assert.deepEqual(rankedDoses(done.data.session!), rankedDoses(control.done));
    assert.deepEqual(rankedDoses(lower.data.session!), rankedDoses(control.lower));
    assert.equal(done.data.session!.intentOrder!.aimIntent, 2);
    await postSession("/api/session/abandon", { sessionId: started.id });

    const reversed = await claim(-80);
    const reversedAttempt = orderOf(reversed).attemptId;
    ctx.advanceTimeMs(1000);
    const heldAim = holdJson(ctx.origin, "/api/session/aim", auth.cookie, {
      sessionId: reversed.id,
      lampPosition: 10,
      attemptId: reversedAttempt,
      aimIntent: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const newerAim = await postSession("/api/session/aim", {
      sessionId: reversed.id,
      lampPosition: 50,
      attemptId: reversedAttempt,
      aimIntent: 2,
    });
    heldAim.release();
    const olderAim = await heldAim.done;
    assert.equal(olderAim.status, 200);
    assert.equal(olderAim.data.session!.lampPosition, 50);
    assert.equal(newerAim.data.session!.lampPosition, 50);
    assert.equal(olderAim.data.session!.intentOrder!.aimIntent, 2);

    ctx.advanceTimeMs(200);
    const beforeStale = olderAim.data.session!;
    const staleBeat = await postSession("/api/session/tick", {
      sessionId: reversed.id,
      lampPosition: -80,
      attemptId: reversedAttempt,
      aimIntent: 1,
    });
    assert.equal(staleBeat.data.session!.lampPosition, 50);
    assert.ok(staleBeat.data.session!.elapsed > beforeStale.elapsed);
    assert.equal(staleBeat.data.session!.regions[0]!.dose, beforeStale.regions[0]!.dose);
    assert.equal(staleBeat.data.session!.regions[1]!.dose, beforeStale.regions[1]!.dose);
    assert.ok(staleBeat.data.session!.regions[2]!.dose > beforeStale.regions[2]!.dose);

    const malformed = await postSession(
      "/api/session/aim",
      { sessionId: reversed.id, lampPosition: -80, attemptId: reversedAttempt, aimIntent: 1.5 },
      400,
    );
    assert.match(malformed.data.error ?? "", /malformed/i);
    const half = await postSession(
      "/api/session/tick",
      { sessionId: reversed.id, lampPosition: -80, attemptId: reversedAttempt },
      400,
    );
    assert.match(half.data.error ?? "", /together/i);
    const authoritative = await postSession(
      "/api/session/tick",
      { sessionId: reversed.id, lampPosition: 50, attemptId: reversedAttempt, aimIntent: 2, elapsed: 60, intentOrder: { revision: 999 } },
      400,
    );
    assert.match(authoritative.data.error ?? "", /forbidden/i);
    const unchanged = await ctx.request<{ session: OrderedRankedSession }>("/api/session/active", { cookie: auth.cookie });
    assert.equal(unchanged.data.session.lampPosition, 50);
    assert.equal(unchanged.data.session.elapsed, staleBeat.data.session!.elapsed);

    ctx.advanceTimeMs(200);
    const legacyOverwrite = await postSession("/api/session/tick", {
      sessionId: reversed.id,
      lampPosition: -80,
    });
    assert.equal(legacyOverwrite.data.session!.lampPosition, 50);
    assert.ok(legacyOverwrite.data.session!.elapsed > staleBeat.data.session!.elapsed);
    await postSession("/api/session/abandon", { sessionId: reversed.id });

    const legacy = await ctx.request<{ session: OrderedRankedSession }>("/api/session/egg", {
      method: "POST",
      cookie: auth.cookie,
      body: { familyId: "pulse", lampPosition: -70 },
    });
    assert.equal(legacy.status, 201);
    const stored = ctx.backend.db
      .prepare("SELECT session_json, assigned_background_index FROM ranked_sessions WHERE session_id = ?")
      .get(legacy.data.session.id) as { session_json: string; assigned_background_index: number };
    const stripped = JSON.parse(stored.session_json) as OrderedRankedSession;
    delete stripped.intentOrder;
    ctx.backend.db
      .prepare("UPDATE ranked_sessions SET session_json = ? WHERE session_id = ?")
      .run(JSON.stringify(stripped), legacy.data.session.id);
    const startedLegacy = await postSession("/api/session/start", { sessionId: legacy.data.session.id });
    assert.equal(startedLegacy.data.session!.status, "running");
    assert.equal(startedLegacy.data.session!.intentOrder?.adopted, false);
    ctx.advanceTimeMs(1000);
    const legacyAim = await postSession("/api/session/aim", { sessionId: legacy.data.session.id, lampPosition: 80 });
    assert.equal(legacyAim.data.session!.lampPosition, 80);
    assert.equal(legacyAim.data.session!.intentOrder?.adopted, false);
    const legacyOrder = legacyAim.data.session!.intentOrder!;
    const adoptedResponse = await postSession("/api/session/aim", {
      sessionId: legacy.data.session.id,
      lampPosition: 20,
      attemptId: legacyOrder.attemptId,
      aimIntent: legacyOrder.aimIntent + 1,
    });
    const adopted = adoptedResponse.data.session!;
    assert.equal(adopted.lampPosition, 20);
    assert.equal(adopted.intentOrder?.adopted, true);
    ctx.advanceTimeMs(200);
    const blocked = await postSession("/api/session/tick", { sessionId: legacy.data.session.id, lampPosition: -80 });
    assert.equal(blocked.data.session!.lampPosition, 20);
    assert.ok(blocked.data.session!.elapsed > adopted.elapsed);
    const oldAttempt = adopted.intentOrder!.attemptId;
    const restarted = await postSession("/api/session/restart", { sessionId: legacy.data.session.id });
    assert.equal(restarted.data.session!.status, "egg");
    assert.equal(restarted.data.session!.elapsed, 0);
    assert.notEqual(restarted.data.session!.intentOrder!.attemptId, oldAttempt);
    const staleRestart = await postSession(
      "/api/session/tick",
      { sessionId: legacy.data.session.id, lampPosition: 70, attemptId: oldAttempt, aimIntent: 9 },
      409,
    );
    assert.equal(staleRestart.data.error, "Stale ranked intent.");
    const afterStale = await ctx.request<{ session: OrderedRankedSession }>("/api/session/active", { cookie: auth.cookie });
    assert.equal(afterStale.data.session.status, "egg");
    assert.equal(afterStale.data.session.lampPosition, restarted.data.session!.lampPosition);
    assert.equal(afterStale.data.session.intentOrder!.attemptId, restarted.data.session!.intentOrder!.attemptId);
    await postSession("/api/session/abandon", { sessionId: legacy.data.session.id });

    const gapped = await claim(0);
    const gapAttempt = orderOf(gapped).attemptId;
    ctx.advanceTimeMs(21_000);
    const gap = await postSession("/api/session/tick", {
      sessionId: gapped.id,
      lampPosition: 0,
      attemptId: gapAttempt,
      aimIntent: 0,
    });
    assert.equal(gap.data.session!.status, "paused");
    assert.equal(gap.data.session!.elapsed, 0);
    assert.ok(gap.data.session!.lockedTraits);
    assert.notEqual(gap.data.session!.intentOrder!.attemptId, gapAttempt);
    const gapStale = await postSession(
      "/api/session/aim",
      { sessionId: gapped.id, lampPosition: 80, attemptId: gapAttempt, aimIntent: 4 },
      409,
    );
    assert.equal(gapStale.data.error, "Stale ranked intent.");
    const gapStored = await ctx.request<{ session: OrderedRankedSession }>("/api/session/active", { cookie: auth.cookie });
    assert.equal(gapStored.data.session.status, "paused");
    assert.equal(gapStored.data.session.elapsed, 0);
    assert.ok(gapStored.data.session.lockedTraits);
    assert.equal(gapStored.data.session.lampPosition, gap.data.session!.lampPosition);
    assert.equal(gapStored.data.session.intentOrder!.attemptId, gap.data.session!.intentOrder!.attemptId);
    await postSession("/api/session/abandon", { sessionId: gapped.id });
  } finally {
    await ctx.close();
  }
});

test("a stale telemetry failure does not reset a newer ranked attempt", async () => {
  let now = Date.parse("2026-11-07T13:00:00.000Z");
  const telemetryGate: { resolve?: () => void } = {};
  let mode: "ok" | "wait" | "fault" = "ok";
  const reading = () => ({
    coreStatus: "ACTIVE" as const,
    rpm: 65,
    meters: 300,
    distanceMm: 300_000,
    work: 400n,
    counterEpoch: "order-fence",
    installationId: "order-fence",
    observedAt: now,
    received: now,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(now),
  });
  const backend = new HatcheryBackend({
    dbPath: ":memory:",
    policy: EXPERIMENTAL_POLICY_V4,
    autoStartProducer: false,
    hardwareTimeoutMs: 15000,
    now: () => now,
    hardwareProvider: async () => {
      if (mode === "wait") {
        mode = "ok";
        await new Promise<void>((resolve) => {
          telemetryGate.resolve = resolve;
        });
      } else if (mode === "fault") {
        mode = "ok";
        throw new Error("Hardware reported fault");
      }
      return { reading: reading(), source: "live" as const };
    },
  });
  const day = Date.parse("2026-11-07T12:00:05.000Z");
  backend.ingestHardwareReading(
    { ...reading(), observedAt: day, received: day, meters: 0, distanceMm: 0, work: 0n, utcDate: measurementDayKey(day) },
    "live",
    day,
  );
  try {
    const egg = backend.claimRankedEgg(WALLET_A.address, { familyId: "pulse", lampPosition: -80 });
    const attemptId = egg.intentOrder?.attemptId;
    assert.ok(attemptId);
    await backend.startRankedIllumination(WALLET_A.address, {
      sessionId: egg.id,
      attemptId,
      aimIntent: 0,
      lampPosition: -80,
    });
    now += 1000;
    mode = "wait";
    let pendingError: unknown = null;
    const pending = backend
      .tickRankedSession(WALLET_A.address, { sessionId: egg.id, attemptId, aimIntent: 0, lampPosition: -80 })
      .catch((error: unknown) => {
        pendingError = error;
      });
    const startedAt = Date.now();
    while (!telemetryGate.resolve) {
      if (Date.now() - startedAt > 2000) throw new Error("tick did not reach telemetry");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const restarted = await backend.restartRankedSession(WALLET_A.address, { sessionId: egg.id });
    assert.equal(restarted.session.status, "egg");
    assert.notEqual(restarted.session.intentOrder?.attemptId, attemptId);
    const resume = telemetryGate.resolve;
    telemetryGate.resolve = undefined;
    if (resume) resume();
    await pending;
    assert.match(pendingError instanceof Error ? pendingError.message : "", /Stale ranked intent/);
    const stored = await backend.getActiveRankedSession(WALLET_A.address);
    assert.equal(stored?.status, "egg");
    assert.equal(stored?.elapsed, 0);
    assert.equal(stored?.lockedTraits, null);
    assert.equal(stored?.intentOrder?.attemptId, restarted.session.intentOrder?.attemptId);

    const nextAttempt = stored!.intentOrder!.attemptId;
    await backend.startRankedIllumination(WALLET_A.address, {
      sessionId: egg.id,
      attemptId: nextAttempt,
      aimIntent: 0,
      lampPosition: stored!.lampPosition,
    });
    now += 1000;
    await backend.tickRankedSession(WALLET_A.address, {
      sessionId: egg.id,
      attemptId: nextAttempt,
      aimIntent: 0,
      lampPosition: stored!.lampPosition,
    });
    const healthy = await backend.getActiveRankedSession(WALLET_A.address);
    assert.equal(healthy?.status, "running");
    assert.ok((healthy?.elapsed ?? 0) > 0);
    now += 1000;
    mode = "fault";
    await assert.rejects(
      backend.tickRankedSession(WALLET_A.address, {
        sessionId: egg.id,
        attemptId: nextAttempt,
        aimIntent: 0,
        lampPosition: healthy!.lampPosition,
      }),
      /fault/i,
    );
    const reset = await backend.getActiveRankedSession(WALLET_A.address);
    assert.equal(reset?.status, "egg");
    assert.equal(reset?.elapsed, 0);
    assert.equal(reset?.lockedTraits, null);
    assert.notEqual(reset?.intentOrder?.attemptId, nextAttempt);
  } finally {
    telemetryGate.resolve?.();
    backend.close();
  }
});

test("stale ordered telemetry and a late active read do not rewind the current attempt", async () => {
  const wallet = WALLET_A.address;
  const openBackend = (policy: typeof EXPERIMENTAL_POLICY_V1 | typeof EXPERIMENTAL_POLICY_V4) => {
    let now = Date.parse("2026-11-07T13:00:00.000Z");
    const reading = () => ({
      coreStatus: "ACTIVE" as const,
      rpm: 65,
      meters: 300,
      distanceMm: 300_000,
      work: 400n,
      counterEpoch: "order-fence",
      installationId: "order-fence",
      observedAt: now,
      received: now,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(now),
    });
    const backend = new HatcheryBackend({
      dbPath: ":memory:",
      policy,
      autoStartProducer: false,
      hardwareTimeoutMs: 15000,
      now: () => now,
      hardwareProvider: async () => ({ reading: reading(), source: "live" as const }),
    });
    const day = Date.parse("2026-11-07T12:00:05.000Z");
    backend.ingestHardwareReading(
      { ...reading(), observedAt: day, received: day, meters: 0, distanceMm: 0, work: 0n, utcDate: measurementDayKey(day) },
      "live",
      day,
    );
    return {
      backend,
      raw: () => String(backend.getActiveRankedSessionRow(wallet)?.session_json ?? ""),
    };
  };
  const bootRunning = async (policy: typeof EXPERIMENTAL_POLICY_V4) => {
    const ctx = openBackend(policy);
    try {
      const egg = ctx.backend.claimRankedEgg(wallet, { familyId: "pulse", lampPosition: -80 });
      const attemptId = egg.intentOrder?.attemptId;
      assert.ok(attemptId);
      const first = await ctx.backend.startRankedIllumination(wallet, {
        sessionId: egg.id,
        attemptId,
        aimIntent: 0,
        lampPosition: -80,
      });
      const oldAttemptId = first.session.intentOrder?.attemptId;
      assert.ok(oldAttemptId);
      const reset = await ctx.backend.restartRankedSession(wallet, {
        sessionId: egg.id,
        attemptId: oldAttemptId,
        aimIntent: 0,
      });
      const nextAttempt = reset.session.intentOrder?.attemptId;
      assert.ok(nextAttempt);
      const started = await ctx.backend.startRankedIllumination(wallet, {
        sessionId: egg.id,
        attemptId: nextAttempt,
        aimIntent: 0,
        lampPosition: 80,
      });
      return { ...ctx, sessionId: egg.id, oldAttemptId, started: started.session };
    } catch (error) {
      ctx.backend.close();
      throw error;
    }
  };

  for (const method of ["tickRankedSession", "aimRankedSession", "startRankedIllumination", "completeRankedSession"] as const) {
    const ctx = await bootRunning(EXPERIMENTAL_POLICY_V4);
    try {
      const before = ctx.raw();
      ctx.backend.getHardwareTelemetry = async () => {
        throw new Error("telemetry must not run for a stale attempt");
      };
      const call = ctx.backend[method].bind(ctx.backend) as (
        walletAddress: string,
        body: Record<string, unknown>,
      ) => Promise<unknown>;
      await assert.rejects(
        () => call(wallet, {
          sessionId: ctx.sessionId,
          attemptId: ctx.oldAttemptId,
          aimIntent: 1,
          lampPosition: -80,
        }),
        /Stale ranked intent/,
      );
      assert.equal(ctx.raw(), before);
    } finally {
      ctx.backend.close();
    }
  }

  const lowered = await bootRunning(EXPERIMENTAL_POLICY_V4);
  try {
    const attemptId = lowered.started.intentOrder?.attemptId;
    assert.ok(attemptId);
    await lowered.backend.aimRankedSession(wallet, {
      sessionId: lowered.sessionId,
      attemptId,
      aimIntent: 2,
      lampPosition: 80,
    });
    const before = lowered.raw();
    lowered.backend.getHardwareTelemetry = async () => {
      throw new Error("Synthetic offline telemetry");
    };
    await assert.rejects(
      () => lowered.backend.tickRankedSession(wallet, {
        sessionId: lowered.sessionId,
        attemptId,
        aimIntent: 1,
        lampPosition: -80,
      }),
      /Synthetic offline telemetry/,
    );
    assert.equal(lowered.raw(), before);
  } finally {
    lowered.backend.close();
  }

  const raced = await bootRunning(EXPERIMENTAL_POLICY_V4);
  try {
    const realTelemetry = raced.backend.getHardwareTelemetry.bind(raced.backend);
    const held: { reject?: (error: Error) => void } = {};
    raced.backend.getHardwareTelemetry = () =>
      new Promise((_, reject) => {
        held.reject = reject;
      }) as ReturnType<HatcheryBackend["getHardwareTelemetry"]>;
    const pending = raced.backend.getActiveRankedSession(wallet);
    const rejectHeld = held.reject;
    if (!rejectHeld) throw new Error("active read did not reach telemetry");
    raced.backend.getHardwareTelemetry = realTelemetry;
    const reset = await raced.backend.restartRankedSession(wallet, { sessionId: raced.sessionId });
    const nextAttempt = reset.session.intentOrder?.attemptId;
    assert.ok(nextAttempt);
    await raced.backend.startRankedIllumination(wallet, {
      sessionId: raced.sessionId,
      attemptId: nextAttempt,
      aimIntent: 0,
      lampPosition: 80,
    });
    const before = raced.raw();
    rejectHeld(new Error("Old active read failed"));
    await pending;
    assert.equal(raced.raw(), before);
    assert.equal((JSON.parse(before) as OrderedRankedSession).status, "running");
  } finally {
    raced.backend.close();
  }

  const legacy = openBackend(EXPERIMENTAL_POLICY_V1);
  try {
    const egg = legacy.backend.claimRankedEgg(wallet, { familyId: "pulse", lampPosition: -80 });
    const started = await legacy.backend.startRankedIllumination(wallet, {
      sessionId: egg.id,
      lampPosition: 0,
    });
    assert.equal(started.session.status, "running");
    assert.ok(started.session.lockedTraits);
    legacy.backend.getHardwareTelemetry = async () => {
      throw new Error("Synthetic offline telemetry");
    };
    await assert.rejects(
      () => legacy.backend.tickRankedSession(wallet, { sessionId: egg.id, lampPosition: 0 }),
      /Synthetic offline telemetry/,
    );
    const stored = JSON.parse(legacy.raw()) as OrderedRankedSession;
    assert.equal(stored.status, "paused");
    assert.ok(stored.lockedTraits);
  } finally {
    legacy.backend.close();
  }
});

function holdJson(origin: string, pathname: string, cookie: string, payload: unknown): {
  release: () => void;
  finished: () => boolean;
  done: Promise<{ status: number; data: { session?: OrderedRankedSession; error?: string } }>;
} {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(origin);
  let settled = false;
  let released = false;
  let resolveDone: (value: { status: number; data: { session?: OrderedRankedSession; error?: string } }) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<{ status: number; data: { session?: OrderedRankedSession; error?: string } }>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });
  const req = http.request(
    {
      hostname: url.hostname,
      port: url.port,
      path: pathname,
      method: "POST",
      headers: {
        host: url.host,
        origin,
        cookie,
        "content-type": "application/json",
        "content-length": String(body.length),
        connection: "close",
      },
    },
    (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        settled = true;
        const text = Buffer.concat(chunks).toString("utf8");
        const data = text ? (JSON.parse(text) as { session?: OrderedRankedSession; error?: string }) : {};
        resolveDone({ status: res.statusCode ?? 0, data });
      });
    },
  );
  req.setTimeout(10000, () => req.destroy(new Error(`timed out held ${pathname}`)));
  req.on("error", (error) => {
    settled = true;
    rejectDone(error instanceof Error ? error : new Error(String(error)));
  });
  req.flushHeaders();
  return {
    release() {
      if (released) return;
      released = true;
      req.end(body);
    },
    finished: () => settled,
    done,
  };
}
