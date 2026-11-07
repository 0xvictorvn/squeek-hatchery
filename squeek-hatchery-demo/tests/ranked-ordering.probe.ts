/**
 * Isolated Ranked ordering probe. Host command:
 *   node --experimental-strip-types tests/ranked-ordering.probe.ts <absolute-output-dir>
 *
 * Investigation only. It does not change Ranked application code or the 200 ms authority.
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { EXPERIMENTAL_POLICY_V1 } from "../src/game-policy.ts";
import { measurementDayKey, regionAt, type Reading } from "../src/rules.ts";
import { createHatcheryHttpServer } from "../src/server.ts";

const REGION_NAMES = ["head", "middle", "lower"] as const;
const OLD_LAMP = -80;
const NEW_LAMP = 80;
const OLDER_AIM = 10;
const NEWER_AIM = 50;
const TEST_ACCOUNT = privateKeyToAccount(generatePrivateKey());

const proposedDirection = {
  implemented: false,
  authorityIntervalMs: 200,
  points: [
    "Server responses carry a monotonic authoritative state revision. The client rejects an older revision within the same attempt, beside the existing session and epoch guards.",
    "Each aim change gets an attempt-scoped aim-intent sequence. The server ignores a stale aim intent on a heartbeat tick and on an explicit aim. Reset, restart, and recovery rotate that generation so an old request cannot mutate a new attempt.",
    "The client keeps the desired aim separate from the authoritative session mirror while a newer intent is in flight, so a progress response does not undo an in-progress drag.",
    "Ticks keep carrying the in-progress aim. Dropping lampPosition from the heartbeat would wait for pointer release and could change scoring.",
    "Time still accrues on the preceding accepted position before a newly accepted aim. Client timestamps and scores stay non-authoritative.",
    "A stale command must not reset a healthy new attempt. Auth, ownership, CSRF, freshness, the 20s gap, and idempotent completion stay as they are.",
  ],
};

const limitations = [
  "No Ranked application, backend, or client file is modified. The 200 ms heartbeat is unchanged.",
  "The held-request scenario withholds the old tick body until the newer aim response returns. It does not pause between getHardwareTelemetry and the session-row read; those steps are synchronous in the current server.",
  "The in-process scenario shares one producerPromise. It is a different schedule from the HTTP body hold.",
  "The response-feedback scenario sends the old lampPosition on later ticks. It does not hold a browser response. The UI rollback was previously recorded by the host as race.oldTickRevertedAim and is not re-measured here.",
  "Doses are for this RAM database, synthetic clock, and EXPERIMENTAL_POLICY_V1 with a fresh ACTIVE 65 RPM reading.",
  "autoStartProducer is false and hardware comes from the local provider. This probe does not call a production service.",
  "A reproduced overwrite is evidence of current behavior, not a repair.",
];

interface RegionSnapshot {
  name: "head" | "middle" | "lower";
  dose: number;
  exposure: number;
  level: number;
}

interface SessionSnapshot {
  atMs: number;
  id: string;
  status: string;
  lampPosition: number;
  aimedRegion: "head" | "middle" | "lower";
  elapsed: number;
  regions: RegionSnapshot[];
}

interface DoseTriple {
  head: number;
  middle: number;
  lower: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function command(fields: Record<string, string | number>): Record<string, unknown> {
  return fields;
}

function resolveOutputDir(): string {
  const arg = process.argv[2];
  if (!arg) return fs.mkdtempSync(path.join(os.tmpdir(), "ranked-ordering-"));
  if (!path.isAbsolute(arg)) throw new Error("Ranked probe output directory must be an absolute path");
  fs.mkdirSync(arg, { recursive: true });
  return arg;
}

function asSession(value: unknown, step: string, atMs: number): SessionSnapshot {
  if (!value || typeof value !== "object") throw new Error(`${step} missing session`);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || typeof row.status !== "string") throw new Error(`${step} missing session identity`);
  if (typeof row.lampPosition !== "number" || typeof row.elapsed !== "number") throw new Error(`${step} missing lamp or elapsed`);
  if (!Array.isArray(row.regions) || row.regions.length !== 3) throw new Error(`${step} missing regions`);
  const regions = row.regions.map((region, index) => {
    if (!region || typeof region !== "object") throw new Error(`${step} bad region`);
    const item = region as Record<string, unknown>;
    if (typeof item.dose !== "number" || typeof item.exposure !== "number" || typeof item.level !== "number") {
      throw new Error(`${step} bad region fields`);
    }
    const name = REGION_NAMES[index];
    if (!name) throw new Error(`${step} bad region index`);
    return { name, dose: item.dose, exposure: item.exposure, level: item.level };
  });
  const aimed = REGION_NAMES[regionAt(row.lampPosition)];
  if (!aimed) throw new Error(`${step} bad aim region`);
  return {
    atMs,
    id: row.id,
    status: row.status,
    lampPosition: row.lampPosition,
    aimedRegion: aimed,
    elapsed: row.elapsed,
    regions,
  };
}

function dosesOf(session: SessionSnapshot): DoseTriple {
  return {
    head: session.regions[0]?.dose ?? Number.NaN,
    middle: session.regions[1]?.dose ?? Number.NaN,
    lower: session.regions[2]?.dose ?? Number.NaN,
  };
}

function sameDoses(left: DoseTriple, right: DoseTriple): boolean {
  return left.head === right.head && left.middle === right.middle && left.lower === right.lower;
}

function requireRunning(step: string, session: SessionSnapshot): void {
  if (session.status !== "running") throw new Error(`${step} status ${session.status}`);
}

function comparison(input: {
  observedLamp: number;
  hypotheticalLamp: number;
  observedDoses: DoseTriple;
  referenceDoses: DoseTriple;
}) {
  const dosesMatchReference = sameDoses(input.observedDoses, input.referenceDoses);
  const storedAimMatchesIgnoredStaleHypothesis = input.observedLamp === input.hypotheticalLamp;
  let effect = "not observed under this scheduling";
  if (!storedAimMatchesIgnoredStaleHypothesis) {
    effect = "observed in this fixture: stored aim differed from the stale-ignored hypothesis";
  } else if (!dosesMatchReference) {
    effect = "observed in this fixture: doses differed while the stored aim matched the hypothesis";
  }
  return {
    observedLamp: input.observedLamp,
    hypotheticalLampIfStaleCommandIgnored: input.hypotheticalLamp,
    observedDoses: input.observedDoses,
    referenceDoses: input.referenceDoses,
    storedAimMatchesIgnoredStaleHypothesis,
    dosesMatchReference,
    effect,
  };
}

function parseObject(body: Buffer, step: string): Record<string, unknown> {
  const text = body.toString("utf8");
  if (!text) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${step} returned non-JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${step} JSON was not an object`);
  return parsed as Record<string, unknown>;
}

interface HeldPost {
  release: () => void;
  destroy: () => void;
  finished: () => boolean;
  done: Promise<{ status: number; body: Buffer }>;
}

function holdPost(origin: string, pathname: string, cookie: string, payload: unknown): HeldPost {
  const body = Buffer.from(JSON.stringify(payload));
  const url = new URL(origin);
  let settled = false;
  let released = false;
  let resolveDone: (value: { status: number; body: Buffer }) => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
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
        resolveDone({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) });
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
    destroy() {
      req.destroy();
    },
    finished: () => settled,
    done,
  };
}

async function main(): Promise<number> {
  let outputDir: string;
  try {
    outputDir = resolveOutputDir();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const reportPath = path.join(outputDir, "ranked-ordering.json");
  try {
    const report = await runProbe();
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, reportPath, summary: report.summary }, null, 2));
    return report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          ok: false,
          investigationOnly: true,
          productionRankedCodeChanged: false,
          authorityIntervalMs: 200,
          error: message,
          proposedDirection,
          limitations,
        },
        null,
        2,
      ),
    );
    console.error(message);
    return 1;
  }
}

async function runProbe(): Promise<Record<string, unknown>> {
  let nowMs = Date.parse("2026-11-07T13:00:00.000Z");
  const dayRolloverMs = Date.parse("2026-11-07T12:00:05.000Z");
  let releaseGate: (() => void) | null = null;
  let armGate = false;

  const freshReading = (): Reading => ({
    coreStatus: "ACTIVE",
    rpm: 65,
    meters: 300,
    distanceMm: 300_000,
    work: 400n,
    counterEpoch: "ranked-probe-epoch",
    installationId: "ranked-probe-wheel",
    observedAt: nowMs,
    received: nowMs,
    staleAfterSeconds: 60,
    utcDate: measurementDayKey(nowMs),
  });

  const { backend, server } = createHatcheryHttpServer({
    dbPath: ":memory:",
    policy: EXPERIMENTAL_POLICY_V1,
    autoStartProducer: false,
    hardwareTimeoutMs: 15000,
    now: () => nowMs,
    hardwareProvider: async () => {
      if (armGate) {
        armGate = false;
        await new Promise<void>((resolve) => {
          releaseGate = resolve;
        });
      }
      return { reading: freshReading(), source: "live" as const };
    },
  });
  backend.ingestHardwareReading(
    { ...freshReading(), observedAt: dayRolloverMs, received: dayRolloverMs, meters: 0, distanceMm: 0, work: 0n, utcDate: measurementDayKey(dayRolloverMs) },
    "live",
    dayRolloverMs,
  );

  const scenarios: Record<string, unknown> = {};
  let ok = true;
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const releaseProviderGate = () => {
    const release = releaseGate;
    releaseGate = null;
    armGate = false;
    if (release) release();
  };

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("ranked probe server did not bind");
  const origin = `http://127.0.0.1:${address.port}`;

  async function postJson(pathname: string, cookie: string, payload: unknown, expected: number): Promise<Record<string, unknown>> {
    const res = await fetch(`${origin}${pathname}`, {
      method: "POST",
      headers: { origin, cookie, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data: Record<string, unknown> = {};
    if (text) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${pathname} returned non-JSON`);
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${pathname} JSON was not an object`);
      data = parsed as Record<string, unknown>;
    }
    if (res.status !== expected) {
      const message = typeof data.error === "string" ? data.error : "";
      throw new Error(`${pathname} HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return data;
  }

  async function signIn(): Promise<string> {
    const challenge = await postJson(
      "/api/auth/challenge",
      "",
      { walletAddress: TEST_ACCOUNT.address, chainId: 11155111 },
      200,
    );
    if (typeof challenge.message !== "string" || typeof challenge.challengeId !== "string") {
      throw new Error("challenge was missing its message");
    }
    let signature = "";
    try {
      signature = await TEST_ACCOUNT.signMessage({ message: challenge.message });
      const verified = await fetch(`${origin}/api/auth/verify`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          challengeId: challenge.challengeId,
          walletAddress: TEST_ACCOUNT.address,
          signature,
          chainId: 11155111,
        }),
      });
      const setCookie = verified.headers.get("set-cookie") ?? "";
      if (verified.status !== 200 || !setCookie.startsWith("squeek_session=")) {
        throw new Error(`verify HTTP ${verified.status}`);
      }
      return setCookie.split(";")[0] ?? "";
    } finally {
      signature = "";
    }
  }

  async function sessionStep(pathname: string, cookie: string, payload: unknown, step: string): Promise<SessionSnapshot> {
    const data = await postJson(pathname, cookie, payload, 200);
    const session = asSession(data.session, step, nowMs);
    requireRunning(step, session);
    return session;
  }

  async function claimAndStart(cookie: string, lampPosition: number): Promise<SessionSnapshot> {
    const egg = await postJson("/api/session/egg", cookie, { familyId: "pulse", lampPosition }, 201);
    const created = asSession(egg.session, "egg", nowMs);
    const started = await sessionStep("/api/session/start", cookie, { sessionId: created.id }, "start");
    if (started.lampPosition !== lampPosition) throw new Error(`start lamp ${started.lampPosition}`);
    return started;
  }

  async function abandon(cookie: string, sessionId: string): Promise<void> {
    await postJson("/api/session/abandon", cookie, { sessionId }, 200);
  }

  async function withSession<T>(cookie: string, lampPosition: number, run: (started: SessionSnapshot) => Promise<T>): Promise<T> {
    const started = await claimAndStart(cookie, lampPosition);
    try {
      return await run(started);
    } finally {
      await abandon(cookie, started.id);
    }
  }

  async function runScenario(name: string, run: () => Promise<Record<string, unknown>>): Promise<void> {
    try {
      scenarios[name] = { ok: true, ...(await run()) };
    } catch (error) {
      ok = false;
      scenarios[name] = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  try {
    const cookie = await signIn();
    const wallet = TEST_ACCOUNT.address;

    await runScenario("noReorderReference", async () => {
      const trace = await withSession(cookie, OLD_LAMP, async (started) => {
        advance(1000);
        const aimed = await sessionStep("/api/session/aim", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "reference aim");
        advance(200);
        const follow1 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "reference tick 1");
        advance(200);
        const follow2 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "reference tick 2");
        return { started, aimed, follow1, follow2 };
      });
      return {
        clock: "start, +1000ms aim 80, +200ms tick 80, +200ms tick 80",
        ...trace,
        finalLamp: trace.follow2.lampPosition,
        finalDoses: dosesOf(trace.follow2),
      };
    });

    await runScenario("heldOldTickRequest", async () => {
      const trace = await withSession(cookie, OLD_LAMP, async (started) => {
        advance(1000);
        const held = holdPost(origin, "/api/session/tick", cookie, { sessionId: started.id, lampPosition: OLD_LAMP });
        try {
          await delay(50);
          if (held.finished()) throw new Error("held tick finished before its body was released");
          const aimed = await sessionStep("/api/session/aim", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "newer aim");
          held.release();
          const lateRaw = await held.done;
          const lateData = parseObject(lateRaw.body, "late tick");
          if (lateRaw.status !== 200) {
            const message = typeof lateData.error === "string" ? lateData.error : "";
            throw new Error(`late tick HTTP ${lateRaw.status}${message ? `: ${message}` : ""}`);
          }
          const late = asSession(lateData.session, "late tick", nowMs);
          requireRunning("late tick", late);
          advance(200);
          const follow1 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "follow tick 1");
          advance(200);
          const follow2 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "follow tick 2");
          return { started, aimed, late, follow1, follow2 };
        } finally {
          if (!held.finished()) held.destroy();
        }
      });
      const reference = scenarios.noReorderReference as { ok?: boolean; finalDoses?: DoseTriple; finalLamp?: number };
      if (!reference.ok || !reference.finalDoses || typeof reference.finalLamp !== "number") {
        throw new Error("no-reorder reference was not available");
      }
      return {
        description: "Old tick body was released only after the newer aim response. Follow-up ticks still send the newer aim.",
        clock: "start, +1000ms hold tick -80, aim 80, release tick, +200ms tick 80, +200ms tick 80",
        ...trace,
        storedLampAfterLateTick: trace.late.lampPosition,
        finalLamp: trace.follow2.lampPosition,
        finalDoses: dosesOf(trace.follow2),
        versusReference: comparison({
          observedLamp: trace.late.lampPosition,
          hypotheticalLamp: NEW_LAMP,
          observedDoses: dosesOf(trace.follow2),
          referenceDoses: reference.finalDoses,
        }),
      };
    });

    await runScenario("reversedAims", async () => {
      const trace = await withSession(cookie, OLD_LAMP, async (started) => {
        advance(1000);
        const held = holdPost(origin, "/api/session/aim", cookie, { sessionId: started.id, lampPosition: OLDER_AIM });
        try {
          await delay(50);
          if (held.finished()) throw new Error("held older aim finished before its body was released");
          const newer = await sessionStep("/api/session/aim", cookie, { sessionId: started.id, lampPosition: NEWER_AIM }, "newer aim");
          held.release();
          const olderRaw = await held.done;
          const olderData = parseObject(olderRaw.body, "older aim");
          if (olderRaw.status !== 200) {
            const message = typeof olderData.error === "string" ? olderData.error : "";
            throw new Error(`older aim HTTP ${olderRaw.status}${message ? `: ${message}` : ""}`);
          }
          const older = asSession(olderData.session, "older aim", nowMs);
          requireRunning("older aim", older);
          return { started, newer, older };
        } finally {
          if (!held.finished()) held.destroy();
        }
      });
      return {
        description: "Aim 10 was held, aim 50 completed, then aim 10 was released. Hypothetical latest intent is 50.",
        clock: "start at -80, +1000ms hold aim 10, aim 50, release aim 10",
        ...trace,
        storedLamp: trace.older.lampPosition,
        latestIntentWon: trace.older.lampPosition === NEWER_AIM,
        hypotheticalLatestLamp: NEWER_AIM,
        effect:
          trace.older.lampPosition === NEWER_AIM
            ? "not observed under this scheduling"
            : "observed in this fixture: the later-processed older aim is the stored lamp",
      };
    });

    await runScenario("responseFeedbackReference", async () => {
      const trace = await withSession(cookie, OLD_LAMP, async (started) => {
        advance(200);
        const oldTick = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: OLD_LAMP }, "feedback reference tick");
        advance(800);
        const aimed = await sessionStep("/api/session/aim", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "feedback reference aim");
        advance(200);
        const follow1 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "feedback reference follow 1");
        advance(200);
        const follow2 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "feedback reference follow 2");
        return { started, oldTick, aimed, follow1, follow2 };
      });
      return {
        description: "Same clock as the feedback scenario, with follow-up ticks keeping the newer aim.",
        ...trace,
        finalLamp: trace.follow2.lampPosition,
        finalDoses: dosesOf(trace.follow2),
      };
    });

    await runScenario("heldResponseFeedback", async () => {
      const trace = await withSession(cookie, OLD_LAMP, async (started) => {
        advance(200);
        const oldTick = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: OLD_LAMP }, "captured old tick");
        advance(800);
        const aimed = await sessionStep("/api/session/aim", cookie, { sessionId: started.id, lampPosition: NEW_LAMP }, "feedback aim");
        advance(200);
        const follow1 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: oldTick.lampPosition }, "resent old tick 1");
        advance(200);
        const follow2 = await sessionStep("/api/session/tick", cookie, { sessionId: started.id, lampPosition: oldTick.lampPosition }, "resent old tick 2");
        return { started, oldTick, aimed, follow1, follow2 };
      });
      const reference = scenarios.responseFeedbackReference as { ok?: boolean; finalDoses?: DoseTriple };
      if (!reference.ok || !reference.finalDoses) throw new Error("response-feedback reference was not available");
      return {
        description: "The old tick response is not held in a browser. Later ticks send that captured lampPosition, which is what a client does after installing the old response.",
        uiInstallation: "not measured here; prior host browser evidence is race.oldTickRevertedAim=true",
        capturedOldLamp: trace.oldTick.lampPosition,
        ...trace,
        finalLamp: trace.follow2.lampPosition,
        finalDoses: dosesOf(trace.follow2),
        versusKeepingNewerAim: comparison({
          observedLamp: trace.follow2.lampPosition,
          hypotheticalLamp: NEW_LAMP,
          observedDoses: dosesOf(trace.follow2),
          referenceDoses: reference.finalDoses,
        }),
      };
    });

    await runScenario("sharedTelemetryScheduling", async () => {
      const created = backend.claimRankedEgg(wallet, command({ familyId: "pulse", lampPosition: OLD_LAMP }));
      let tickPromise: Promise<unknown> | null = null;
      let aimPromise: Promise<unknown> | null = null;
      try {
        const started = await backend.startRankedIllumination(wallet, command({ sessionId: created.id }));
        const startedSnap = asSession(started.session, "shared start", nowMs);
        requireRunning("shared start", startedSnap);
        if (startedSnap.lampPosition !== OLD_LAMP) throw new Error(`shared start lamp ${startedSnap.lampPosition}`);
        advance(1000);
        armGate = true;
        const order: string[] = [];
        tickPromise = backend
          .tickRankedSession(wallet, command({ sessionId: created.id, lampPosition: OLD_LAMP }))
          .then((result) => {
            order.push("tick");
            return result;
          });
        const gateStart = Date.now();
        while (!releaseGate) {
          if (Date.now() - gateStart > 2000) throw new Error("tick did not reach the hardware provider");
          await delay(5);
        }
        aimPromise = backend
          .aimRankedSession(wallet, command({ sessionId: created.id, lampPosition: NEW_LAMP }))
          .then((result) => {
            order.push("aim");
            return result;
          });
        await delay(20);
        releaseProviderGate();
        const tick = await tickPromise;
        const aim = await aimPromise;
        const tickSnap = asSession((tick as { session: unknown }).session, "shared tick", nowMs);
        const aimSnap = asSession((aim as { session: unknown }).session, "shared aim", nowMs);
        const confirm = await backend.tickRankedSession(wallet, command({ sessionId: created.id }));
        const stored = asSession(confirm.session, "shared confirm", nowMs);
        requireRunning("shared confirm", stored);
        const notes = [
          `Completion order: ${order.join(" then ") || "unavailable"}.`,
          `Tick response lamp ${tickSnap.lampPosition}; aim response lamp ${aimSnap.lampPosition}; stored lamp ${stored.lampPosition}.`,
          stored.lampPosition === NEW_LAMP
            ? "Stored lamp is the newer aim."
            : stored.lampPosition === OLD_LAMP
              ? "Stored lamp is the older tick position."
              : "Stored lamp is neither commanded position.",
        ];
        if (tickSnap.lampPosition !== stored.lampPosition) {
          notes.push("The tick response lamp differs from the stored lamp, so that response body is not a monotonic revision.");
        }
        notes.push("Both calls shared one in-flight telemetry poll. This is not the HTTP body-hold scenario.");
        return {
          order,
          started: startedSnap,
          tick: tickSnap,
          aim: aimSnap,
          stored,
          storedDoses: dosesOf(stored),
          note: notes.join(" "),
        };
      } finally {
        releaseProviderGate();
        await Promise.allSettled([tickPromise ?? Promise.resolve(), aimPromise ?? Promise.resolve()]);
        try {
          backend.abandonRankedSession(wallet, command({ sessionId: created.id }));
        } catch {
          // The scenario error remains the reported failure.
        }
      }
    });
  } finally {
    releaseProviderGate();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    backend.close();
  }

  const held = scenarios.heldOldTickRequest as { ok?: boolean; versusReference?: { effect?: string; observedLamp?: number; dosesMatchReference?: boolean } };
  const reversed = scenarios.reversedAims as { ok?: boolean; storedLamp?: number; effect?: string };
  const feedback = scenarios.heldResponseFeedback as { ok?: boolean; versusKeepingNewerAim?: { effect?: string; observedLamp?: number } };
  const shared = scenarios.sharedTelemetryScheduling as { ok?: boolean; stored?: { lampPosition?: number }; order?: string[] };

  return {
    ok,
    investigationOnly: true,
    productionRankedCodeChanged: false,
    authorityIntervalMs: 200,
    policy: EXPERIMENTAL_POLICY_V1.version,
    summary: {
      heldOldTickRequest: held.ok
        ? { observedLamp: held.versusReference?.observedLamp ?? null, effect: held.versusReference?.effect ?? "", dosesMatchReference: held.versusReference?.dosesMatchReference ?? null }
        : { error: true },
      reversedAims: reversed.ok ? { storedLamp: reversed.storedLamp ?? null, effect: reversed.effect ?? "" } : { error: true },
      heldResponseFeedback: feedback.ok
        ? { observedLamp: feedback.versusKeepingNewerAim?.observedLamp ?? null, effect: feedback.versusKeepingNewerAim?.effect ?? "" }
        : { error: true },
      sharedTelemetryScheduling: shared.ok
        ? { order: shared.order ?? [], storedLamp: shared.stored?.lampPosition ?? null }
        : { error: true },
    },
    scenarios,
    proposedDirection,
    limitations,
  };
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
