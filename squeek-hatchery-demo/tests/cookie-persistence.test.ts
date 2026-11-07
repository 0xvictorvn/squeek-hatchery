import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { SESSION_COOKIE_NAME, SESSION_TTL_MS } from "../src/backend.ts";
import { EXPERIMENTAL_POLICY_V1 } from "../src/game-policy.ts";
import { measurementDayKey, type Reading } from "../src/rules.ts";
import { createHatcheryHttpServer } from "../src/server.ts";

const WALLET_A = privateKeyToAccount(generatePrivateKey());
const WALLET_B = privateKeyToAccount(generatePrivateKey());

function readingAt(nowMs: number): Reading {
  return {
    coreStatus: "ACTIVE",
    rpm: 65,
    meters: 300,
    distanceMm: 300_000,
    work: 400n,
    counterEpoch: "cookie-fixture-epoch",
    installationId: "cookie-fixture-wheel",
    observedAt: nowMs,
    received: nowMs,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(nowMs),
  };
}

function inspectCookie(setCookie: string) {
  const parts = setCookie.split(";").map((part) => part.trim()).filter(Boolean);
  const pair = parts[0] ?? "";
  const name = pair.split("=")[0] ?? "";
  const flags = new Map<string, string>();
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) flags.set(part.toLowerCase(), "");
    else flags.set(part.slice(0, eq).toLowerCase(), part.slice(eq + 1));
  }
  return {
    pair,
    name,
    httpOnly: flags.has("httponly"),
    secure: flags.has("secure"),
    sameSite: flags.get("samesite") ?? "",
    path: flags.get("path") ?? "",
    maxAge: flags.get("max-age") ?? "",
    domain: flags.get("domain"),
  };
}

test("login cookie keeps the existing 24h HttpOnly contract, Secure on HTTPS, expiry, and logout", async () => {
  assert.equal(SESSION_COOKIE_NAME, "squeek_session");
  assert.equal(SESSION_TTL_MS, 24 * 60 * 60 * 1000);

  let nowMs = Date.parse("2026-11-07T13:00:00.000Z");
  const dayRolloverMs = Date.parse("2026-11-07T12:00:05.000Z");
  const { backend, server } = createHatcheryHttpServer({
    dbPath: ":memory:",
    policy: EXPERIMENTAL_POLICY_V1,
    autoStartProducer: false,
    hardwareTimeoutMs: 1000,
    now: () => nowMs,
    hardwareProvider: async () => ({ reading: readingAt(nowMs), source: "live" }),
  });
  backend.ingestHardwareReading(
    { ...readingAt(dayRolloverMs), meters: 0, distanceMm: 0, work: 0n },
    "live",
    dayRolloverMs,
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("cookie test server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const httpsOrigin = `https://127.0.0.1:${address.port}`;

  async function request(
    pathname: string,
    init: {
      method?: string;
      body?: unknown;
      cookie?: string;
      originHeader?: string;
      extraHeaders?: Record<string, string>;
    } = {},
  ) {
    const headers = new Headers();
    headers.set("origin", init.originHeader ?? origin);
    if (init.cookie) headers.set("cookie", init.cookie);
    for (const [key, value] of Object.entries(init.extraHeaders ?? {})) headers.set(key, value);
    let body: string | undefined;
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.body);
    }
    const res = await fetch(`${origin}${pathname}`, {
      method: init.method ?? (body ? "POST" : "GET"),
      headers,
      body,
    });
    const setCookie = res.headers.get("set-cookie") ?? "";
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (text) {
      try {
        const parsed = JSON.parse(text) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
      } catch {
        data = {};
      }
    }
    return {
      status: res.status,
      data,
      setCookie,
      cacheControl: res.headers.get("cache-control"),
      textLength: text.length,
    };
  }

  async function signIn(account: ReturnType<typeof privateKeyToAccount>, originHeader: string) {
    const challenge = await request("/api/auth/challenge", {
      method: "POST",
      originHeader,
      body: { walletAddress: account.address, chainId: 11155111 },
    });
    if (challenge.status !== 200 || typeof challenge.data.message !== "string" || typeof challenge.data.challengeId !== "string") {
      throw new Error(`challenge HTTP ${challenge.status}`);
    }
    let signature = "";
    try {
      signature = await account.signMessage({ message: challenge.data.message });
      const verified = await request("/api/auth/verify", {
        method: "POST",
        originHeader,
        body: {
          challengeId: challenge.data.challengeId,
          walletAddress: account.address,
          signature,
          chainId: 11155111,
        },
      });
      if (verified.status !== 200 || !verified.setCookie) throw new Error(`verify HTTP ${verified.status}`);
      return { flags: inspectCookie(verified.setCookie), setCookie: verified.setCookie };
    } finally {
      signature = "";
    }
  }

  try {
    const httpLogin = await signIn(WALLET_A, origin);
    assert.equal(httpLogin.flags.name, "squeek_session");
    assert.equal(httpLogin.flags.httpOnly, true);
    assert.equal(httpLogin.flags.sameSite, "Lax");
    assert.equal(httpLogin.flags.path, "/");
    assert.equal(httpLogin.flags.maxAge, "86400");
    assert.equal(httpLogin.flags.secure, false);
    assert.equal(httpLogin.flags.domain, undefined);
    assert.equal(httpLogin.setCookie.includes(","), false);

    const live = await request("/api/auth/session", {
      cookie: httpLogin.flags.pair,
      extraHeaders: {
        "if-none-match": "*",
        "if-modified-since": "Tue, 01 Jan 2036 00:00:00 GMT",
      },
    });
    assert.equal(live.status, 200);
    assert.notEqual(live.status, 304);
    assert.equal(live.cacheControl, "no-store");
    assert.ok(live.textLength > 0);
    assert.equal(live.data.authenticated, true);
    const player = live.data.player as { walletAddress?: string } | null;
    assert.equal(player?.walletAddress, WALLET_A.address);

    nowMs += 23 * 60 * 60 * 1000;
    const withinDay = await request("/api/auth/session", { cookie: httpLogin.flags.pair });
    assert.equal(withinDay.status, 200);
    assert.equal(withinDay.cacheControl, "no-store");
    assert.equal(withinDay.data.authenticated, true);

    nowMs += SESSION_TTL_MS - 23 * 60 * 60 * 1000;
    const atExactExpiry = await request("/api/auth/session", { cookie: httpLogin.flags.pair });
    assert.equal(atExactExpiry.data.authenticated, true);

    nowMs += 1;
    const expired = await request("/api/auth/session", {
      cookie: httpLogin.flags.pair,
      extraHeaders: { "if-none-match": "*" },
    });
    assert.equal(expired.status, 200);
    assert.notEqual(expired.status, 304);
    assert.equal(expired.cacheControl, "no-store");
    assert.equal(expired.data.authenticated, false);
    assert.equal(expired.data.player, null);

    const expiredEgg = await request("/api/session/egg", {
      method: "POST",
      cookie: httpLogin.flags.pair,
      body: { familyId: "pulse" },
      extraHeaders: { "if-none-match": "*" },
    });
    assert.equal(expiredEgg.status, 401);
    assert.notEqual(expiredEgg.status, 304);
    assert.equal(expiredEgg.cacheControl, "no-store");

    const httpsLogin = await signIn(WALLET_B, httpsOrigin);
    assert.equal(httpsLogin.flags.name, "squeek_session");
    assert.equal(httpsLogin.flags.httpOnly, true);
    assert.equal(httpsLogin.flags.sameSite, "Lax");
    assert.equal(httpsLogin.flags.path, "/");
    assert.equal(httpsLogin.flags.maxAge, "86400");
    assert.equal(httpsLogin.flags.secure, true);
    assert.equal(httpsLogin.flags.domain, undefined);
    const httpsSession = await request("/api/auth/session", { cookie: httpsLogin.flags.pair });
    assert.equal(httpsSession.data.authenticated, true);

    const logout = await request("/api/auth/logout", {
      method: "POST",
      originHeader: httpsOrigin,
      cookie: httpsLogin.flags.pair,
      body: {},
    });
    assert.equal(logout.status, 200);
    assert.equal(logout.cacheControl, "no-store");
    assert.equal(logout.data.authenticated, false);
    const clearing = inspectCookie(logout.setCookie);
    assert.equal(clearing.name, "squeek_session");
    assert.equal(clearing.httpOnly, true);
    assert.equal(clearing.sameSite, "Lax");
    assert.equal(clearing.path, "/");
    assert.equal(clearing.maxAge, "0");
    assert.equal(clearing.secure, false);
    assert.equal(clearing.domain, undefined);

    const afterLogout = await request("/api/auth/session", { cookie: httpsLogin.flags.pair });
    assert.equal(afterLogout.status, 200);
    assert.equal(afterLogout.cacheControl, "no-store");
    assert.equal(afterLogout.data.authenticated, false);
    assert.equal(afterLogout.data.player, null);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    backend.close();
  }
});
