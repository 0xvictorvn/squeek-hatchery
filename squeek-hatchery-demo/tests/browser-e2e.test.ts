import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { createHatcheryHttpServer } from "../src/server.ts";
import { measurementDayKey } from "../src/rules.ts";
import { EXPERIMENTAL_POLICY_V2 } from "../src/game-policy.ts";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowserExecutable(): string | null {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly pageErrors: string[] = [];

  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      } else if (msg.method === "Runtime.exceptionThrown") {
        const details = msg.params?.exceptionDetails as
          | { text?: string; exception?: { description?: string } }
          | undefined;
        this.pageErrors.push(
          details?.exception?.description ?? details?.text ?? "Unknown page exception",
        );
      }
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const res = await this.send<{
      result: { type: string; value?: T; description?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ??
          res.exceptionDetails.text ??
          "Evaluation failed",
      );
    }
    return res.result.value as T;
  }

  private targetId?: string;
  private cdpPort?: number;

  setTargetInfo(cdpPort: number, targetId: string): void {
    this.cdpPort = cdpPort;
    this.targetId = targetId;
  }

  close(): void {
    this.ws.close();
    if (this.cdpPort && this.targetId) {
      void fetch(`http://127.0.0.1:${this.cdpPort}/json/close/${this.targetId}`).catch(() => {});
    }
  }
}

async function launchHeadlessBrowser(): Promise<{
  proc: ChildProcess;
  cdpPort: number;
  userDataDir: string;
  close: () => Promise<void>;
}> {
  const exe = findBrowserExecutable();
  if (!exe) {
    throw new Error("No headless Chromium/Edge executable found.");
  }
  const userDataDir = path.resolve(
    process.cwd(),
    "cache",
    `chrome-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  );
  fs.mkdirSync(userDataDir, { recursive: true });

  const proc = spawn(
    exe,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const cdpPort = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Timed out waiting for Chrome DevTools port")),
      10000,
    );
    const onData = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const m = text.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timeout);
        resolve(Number(m[1]));
      }
    };
    proc.stderr?.on("data", onData);
    proc.stdout?.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Chrome exited early with code ${code}`));
    });
  });

  return {
    proc,
    cdpPort,
    userDataDir,
    close: async () => {
      proc.kill();
      await new Promise((r) => setTimeout(r, 250));
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup lock on Windows
      }
    },
  };
}

// Test-only harness clock, injected via CDP into the test browser context only (never shipped).
// The browser clock is aligned with the test server clock here; production code never infers skew.
const harnessClockBootstrapScript = (initialMs: number) => `
(() => {
  let lockedNowMs = null;
  let timersManual = false;
  const origDateNow = Date.now.bind(Date);
  const origPerfNow = performance.now.bind(performance);
  let offsetMs = ${initialMs} - origDateNow();
  const origSetInterval = window.setInterval.bind(window);
  const origClearInterval = window.clearInterval.bind(window);
  const intervals = new Map();

  Date.now = () => (lockedNowMs !== null ? lockedNowMs : origDateNow() + offsetMs);
  performance.now = () => (lockedNowMs !== null ? lockedNowMs : origPerfNow() + offsetMs);

  window.setInterval = (fn, delay, ...args) => {
    const numDelay = Number(delay) || 0;
    const id = origSetInterval(() => {
      if (lockedNowMs !== null && timersManual && numDelay === 200) {
        return;
      }
      fn(...args);
    }, delay);
    intervals.set(id, { fn, delay: numDelay, args, acc: 0 });
    return id;
  };

  window.clearInterval = (id) => {
    intervals.delete(id);
    return origClearInterval(id);
  };

  window.__e2eSetClockMs = (ms) => {
    lockedNowMs = ms;
    timersManual = true;
  };
  window.__e2eLockClockMs = (ms) => {
    // Locks the clock to the test server clock but leaves app timers running on real time.
    lockedNowMs = ms;
    timersManual = false;
  };
  window.__e2eAlignClock = (ms) => {
    lockedNowMs = null;
    offsetMs = ms - origDateNow();
  };

  window.__e2eHarnessStepMs = async (totalMs, stepMs = 200) => {
    if (lockedNowMs === null) {
      lockedNowMs = origDateNow() + offsetMs;
    }
    let remaining = totalMs;
    while (remaining > 0) {
      const dt = Math.min(stepMs, remaining);
      lockedNowMs += dt;
      remaining -= dt;
      for (const item of [...intervals.values()]) {
        if (item.delay === 200 || item.delay === 2500) {
          item.acc += dt;
          while (item.acc >= item.delay) {
            item.acc -= item.delay;
            item.fn(...item.args);
          }
        }
      }
      await Promise.resolve();
    }
  };
})();
`;

async function openCdpPage(
  cdpPort: number,
  url: string,
  options: { harnessClockMs?: number; blockedUrls?: string[] } = {},
): Promise<CdpSession> {
  const res = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, {
    method: "PUT",
  });
  const target = (await res.json()) as { id: string; webSocketDebuggerUrl: string };
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
  });
  const session = new CdpSession(ws);
  session.setTargetInfo(cdpPort, target.id);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  if (options.blockedUrls && options.blockedUrls.length > 0) {
    await session.send("Network.enable");
    await session.send("Network.setBlockedURLs", { urls: options.blockedUrls });
  }
  if (options.harnessClockMs !== undefined) {
    await session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: harnessClockBootstrapScript(options.harnessClockMs),
    });
  }
  await session.send("Page.navigate", { url });
  return session;
}

async function reloadCdpPage(session: CdpSession, alignClockMs?: number): Promise<void> {
  await session.eval(`window.__squeekAppMounted = false`);
  await session.send("Page.reload");
  await waitForCondition(session, `window.__squeekAppMounted === true`);
  if (alignClockMs !== undefined) {
    await session.eval(`window.__e2eAlignClock(${alignClockMs})`);
  }
}

async function waitForCondition(
  session: CdpSession,
  predicateExpr: string,
  timeoutMs = 8000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await session.eval<boolean>(`Boolean(${predicateExpr})`).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Timed out waiting for browser condition: ${predicateExpr}`);
}

test("Real-browser E2E: Docs separation, R11 Guest telemetry stall/expiry/replay/recovery, R13 full Guest flow without debug globals, R9 stage reveal, 1600x1600 PNG export, SIWE login, C1 /result/<resultId> deep-link, asset failure/recovery, and responsive viewports", async () => {
  const dayRolloverMs = Date.parse("2026-11-06T12:00:05.000Z");
  let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
  let hardwareMode: "healthy" | "stall" | "replay_older" | "stale" = "healthy";
  let lastHealthyObservedAt = nowMs;

  const { backend, server } = createHatcheryHttpServer({
    policy: EXPERIMENTAL_POLICY_V2,
    dbPath: ":memory:",
    now: () => nowMs,
    hardwareTimeoutMs: 400,
    hardwareProvider: async () => {
      if (hardwareMode === "stall") {
        return await new Promise<never>(() => {
          // Intentionally never settles so backend timeout & client freshness expiry trigger
        });
      }
      if (hardwareMode === "replay_older") {
        const olderMs = lastHealthyObservedAt - 5_000;
        return {
          reading: {
            coreStatus: "ACTIVE",
            rpm: 65,
            meters: 300,
            distanceMm: 300_000,
            work: 400n,
            counterEpoch: "e2e-epoch-1",
            installationId: "wheel-e2e-1",
            observedAt: olderMs,
            received: nowMs,
            staleAfterSeconds: 60,
            utcDate: measurementDayKey(olderMs),
          },
          source: "live",
        };
      }
      if (hardwareMode === "stale") {
        const staleMs = nowMs - 20_000;
        return {
          reading: {
            coreStatus: "ACTIVE",
            rpm: 65,
            meters: 300,
            distanceMm: 300_000,
            work: 400n,
            counterEpoch: "e2e-epoch-1",
            installationId: "wheel-e2e-1",
            observedAt: staleMs,
            received: staleMs,
            staleAfterSeconds: 60,
            utcDate: measurementDayKey(staleMs),
          },
          source: "live",
        };
      }
      lastHealthyObservedAt = nowMs;
      return {
        reading: {
          coreStatus: "ACTIVE",
          rpm: 65,
          meters: 300,
          distanceMm: 300_000,
          work: 400n,
          counterEpoch: "e2e-epoch-1",
          installationId: "wheel-e2e-1",
          observedAt: nowMs,
          received: nowMs,
          staleAfterSeconds: 60,
          utcDate: measurementDayKey(nowMs),
        },
        source: "live",
      };
    },
  });

  // Seed day rollover baseline so 400n work maps to step 4 (Eclipse Mask, index 7)
  backend.ingestHardwareReading(
    {
      coreStatus: "ACTIVE",
      rpm: 65,
      meters: 0,
      distanceMm: 0,
      work: 0n,
      counterEpoch: "e2e-epoch-1",
      installationId: "wheel-e2e-1",
      observedAt: dayRolloverMs,
      received: dayRolloverMs,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(dayRolloverMs),
    },
    "live",
    dayRolloverMs,
  );

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const browser = await launchHeadlessBrowser();
  try {
    const page = await openCdpPage(browser.cdpPort, `${baseUrl}/#play`, {
      harnessClockMs: nowMs,
    });
    await waitForCondition(page, `window.__squeekAppMounted === true`);
    await waitForCondition(page, `document.getElementById("led-stage-canvas") !== null`);
    await waitForCondition(page, `document.getElementById("btn-start-lamp") !== null`);

    // R13 Check: Production app does not expose __squeekDebug or advanceGuestSeconds
    const hasDebugGlobal = await page.eval<boolean>(
      `typeof window.__squeekDebug !== "undefined"`,
    );
    assert.equal(hasDebugGlobal, false);

    // 1. Verify Play vs Docs separation & reload on Docs (C1, C2, C3, C4)
    const initialViews = await page.eval<{
      playHidden: boolean;
      docsHidden: boolean;
      lbEmptyPresent: boolean;
    }>(`({
      playHidden: document.getElementById("view-play").hidden,
      docsHidden: document.getElementById("view-docs").hidden,
      lbEmptyPresent: document.querySelector('[data-testid="leaderboard-empty"]') !== null
    })`);
    assert.equal(initialViews.playHidden, false);
    assert.equal(initialViews.docsHidden, true);
    assert.equal(initialViews.lbEmptyPresent, true);

    // Navigate to #docs
    await page.eval(`document.getElementById("play-to-docs-link").click()`);
    await waitForCondition(page, `document.getElementById("view-docs").hidden === false`);
    const docsViews = await page.eval<{
      playHidden: boolean;
      docsHidden: boolean;
      docsText: string;
    }>(`({
      playHidden: document.getElementById("view-play").hidden,
      docsHidden: document.getElementById("view-docs").hidden,
      docsText: document.getElementById("view-docs").innerText
    })`);
    assert.equal(docsViews.playHidden, true);
    assert.equal(docsViews.docsHidden, false);
    assert.match(docsViews.docsText, /Coat Palette/);
    assert.match(docsViews.docsText, /Cyber Accessory/);
    assert.match(docsViews.docsText, /Total Score/);

    // Reload on #docs -> stays on Docs
    await reloadCdpPage(page);
    await waitForCondition(
      page,
      `document.getElementById("view-docs") !== null && document.getElementById("view-docs").hidden === false`,
    );
    const afterDocsReload = await page.eval<{ playHidden: boolean; docsHidden: boolean }>(`({
      playHidden: document.getElementById("view-play").hidden,
      docsHidden: document.getElementById("view-docs").hidden
    })`);
    assert.equal(afterDocsReload.playHidden, true);
    assert.equal(afterDocsReload.docsHidden, false);

    // Return to #play
    await page.eval(`window.location.hash = "#play"`);
    await waitForCondition(page, `document.getElementById("view-play").hidden === false`);

    // 2. R11 Check: Stalled hardware telemetry expires after 15s and pauses Guest growth,
    // rejects older replay / stale readings after outage, and recovers on fresh sample
    await waitForCondition(
      page,
      `document.getElementById("telemetry-badge").textContent.includes("ACTIVE")`,
    );
    await page.eval(`window.__e2eSetClockMs(${nowMs})`);
    await page.eval(`document.getElementById("btn-start-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-pause-lamp") !== null`, 15000);

    // Advance 2.0s while telemetry is still fresh
    nowMs += 2_000;
    await page.eval(`window.__e2eHarnessStepMs(2000, 200)`);
    const timerAt2s = await page.eval<string>(
      `document.getElementById("timer-readout").textContent`,
    );
    assert.equal(timerAt2s, "2.0s / 60s");

    // Now stall upstream hardware telemetry and advance 14s (total 16s > 15s freshness window)
    hardwareMode = "stall";
    nowMs += 14_000;
    await page.eval(`window.__e2eHarnessStepMs(14000, 200)`);

    // Guest illumination must pause automatically at <= 15.0s and badge must show SIGNAL UNAVAILABLE · PAUSED
    const stateAfterExpiry = await page.eval<{
      badgeText: string;
      sessionStatus: string;
      elapsedSec: number;
      startBtnVisible: boolean;
    }>(`({
      badgeText: document.getElementById("telemetry-badge").textContent,
      sessionStatus: document.getElementById("led-stage-canvas").dataset.sessionStatus,
      elapsedSec: parseFloat(document.getElementById("timer-readout").textContent),
      startBtnVisible: document.getElementById("btn-start-lamp") !== null
    })`);
    assert.match(stateAfterExpiry.badgeText, /SIGNAL UNAVAILABLE/i);
    assert.equal(stateAfterExpiry.sessionStatus, "paused");
    assert.ok(stateAfterExpiry.elapsedSec <= 15.0);
    assert.equal(stateAfterExpiry.startBtnVisible, true);

    // Advancing another 8s while expired must NOT add any Guest growth
    nowMs += 8_000;
    await page.eval(`window.__e2eHarnessStepMs(8000, 200)`);
    const elapsedAfterExtraStall = await page.eval<number>(
      `parseFloat(document.getElementById("timer-readout").textContent)`,
    );
    assert.equal(elapsedAfterExtraStall, stateAfterExpiry.elapsedSec);

    // Older replay sample and stale sample after outage must be rejected
    hardwareMode = "replay_older";
    await new Promise((r) => setTimeout(r, 600));
    const badgeDuringReplay = await page.eval<string>(
      `document.getElementById("telemetry-badge").textContent`,
    );
    assert.match(badgeDuringReplay, /SIGNAL UNAVAILABLE/i);

    hardwareMode = "stale";
    await new Promise((r) => setTimeout(r, 600));
    const badgeDuringStale = await page.eval<string>(
      `document.getElementById("telemetry-badge").textContent`,
    );
    assert.match(badgeDuringStale, /SIGNAL UNAVAILABLE/i);

    // Restore healthy fresh telemetry -> badge recovers to ACTIVE
    hardwareMode = "healthy";
    nowMs += 1_000;
    await waitForCondition(
      page,
      `document.getElementById("telemetry-badge").textContent.includes("ACTIVE")`,
      8000,
    );

    // 3. R13 & R9: Full 60s Guest Mode flow through actual controls and timer (strictly RAM-only)
    await page.eval(`document.getElementById("btn-reset-egg").click()`);
    await waitForCondition(
      page,
      `document.getElementById("timer-readout").textContent === "0.0s / 60s"`,
    );

    const storageBefore = await page.eval<{
      ls: number;
      ss: number;
      idb: number;
      cookie: string;
    }>(`(async () => ({
      ls: localStorage.length,
      ss: sessionStorage.length,
      idb: (await indexedDB.databases()).length,
      cookie: document.cookie
    }))()`);
    assert.deepEqual(storageBefore, { ls: 0, ss: 0, idb: 0, cookie: "" });

    // Select Relay species, test slider aim control
    await page.eval(`document.getElementById("species-btn-relay").click()`);
    const lampBeforeKey = await page.eval<string>(`document.getElementById("lamp").value`);
    await page.eval(`
      const slider = document.getElementById("lamp");
      slider.focus();
      slider.value = "0";
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      slider.dispatchEvent(new Event("change", { bubbles: true }));
    `);
    const lampAfterKey = await page.eval<string>(`document.getElementById("lamp").value`);
    assert.notEqual(lampBeforeKey, lampAfterKey);
    assert.equal(lampAfterKey, "0");

    // Aim back to Head (-70)
    await page.eval(`document.querySelector('[data-aim-region="0"]').click()`);

    // R9 Check in EGG state: accessory === -1, background === -1
    const eggStage = await page.eval<{ accessory: number; background: number }>(`({
      accessory: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      background: Number(document.getElementById("led-stage-canvas").dataset.stageBackground)
    })`);
    assert.equal(eggStage.accessory, -1);
    assert.equal(eggStage.background, -1);

    // Start Guest lamp illumination
    await page.eval(`document.getElementById("btn-start-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-pause-lamp") !== null`, 15000);

    // R2 & R9 Check in RUNNING state: lockedAccessory is 7, but stage still has accessory: -1, background: -1, and no early complete button
    const runningCheck = await page.eval<{
      lockedAcc: number;
      stageAcc: number;
      stageBg: number;
      completeBtnExists: boolean;
    }>(`({
      lockedAcc: Number(document.getElementById("led-stage-canvas").dataset.lockedAccessory),
      stageAcc: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      stageBg: Number(document.getElementById("led-stage-canvas").dataset.stageBackground),
      completeBtnExists: document.getElementById("btn-complete-session") !== null
    })`);
    assert.equal(runningCheck.lockedAcc, 7);
    assert.equal(runningCheck.stageAcc, -1);
    assert.equal(runningCheck.stageBg, -1);
    assert.equal(runningCheck.completeBtnExists, false);

    // R9 Check in PAUSED state: pause lamp, verify stage still hides accessory and background
    await page.eval(`document.getElementById("btn-pause-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-start-lamp") !== null`);
    const pausedStage = await page.eval<{ accessory: number; background: number }>(`({
      accessory: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      background: Number(document.getElementById("led-stage-canvas").dataset.stageBackground)
    })`);
    assert.equal(pausedStage.accessory, -1);
    assert.equal(pausedStage.background, -1);

    // Resume Guest illumination and step through all 3 regions (20s each = 60s total)
    await page.eval(`document.getElementById("btn-start-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-pause-lamp") !== null`, 15000);

    const stepGuestWithFreshTelemetry = async (seconds: number) => {
      let rem = seconds;
      while (rem > 0) {
        const chunk = Math.min(5, rem);
        rem -= chunk;
        nowMs += chunk * 1000;
        await page.eval(`window.__e2eHarnessStepMs(${chunk * 1000}, 200)`);
        // Allow background hardware poll to refresh reading with new nowMs
        await new Promise((r) => setTimeout(r, 120));
      }
    };

    // 20s on Head (region 0)
    await stepGuestWithFreshTelemetry(20);
    assert.equal(
      await page.eval<string>(`document.getElementById("led-stage-canvas").dataset.stageLevels`),
      "10,0,0",
    );

    // Aim at Middle (region 1) and run 20s
    await page.eval(`document.querySelector('[data-aim-region="1"]').click()`);
    await stepGuestWithFreshTelemetry(20);
    assert.equal(
      await page.eval<string>(`document.getElementById("led-stage-canvas").dataset.stageLevels`),
      "10,10,0",
    );

    // Aim at Lower (region 2) and run final 20s -> reaches 60.0s / 60s and shows #btn-complete-session
    await page.eval(`document.querySelector('[data-aim-region="2"]').click()`);
    await stepGuestWithFreshTelemetry(20);

    await waitForCondition(page, `document.getElementById("btn-complete-session") !== null`);
    const beforeGuestCompleteClick = await page.eval<{
      timerText: string;
      stageAcc: number;
      stageBg: number;
      resultHidden: boolean;
    }>(`({
      timerText: document.getElementById("timer-readout").textContent,
      stageAcc: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      stageBg: Number(document.getElementById("led-stage-canvas").dataset.stageBackground),
      resultHidden: document.getElementById("result-panel").hidden
    })`);
    assert.equal(beforeGuestCompleteClick.timerText, "60.0s / 60s");
    assert.equal(beforeGuestCompleteClick.stageAcc, -1);
    assert.equal(beforeGuestCompleteClick.stageBg, -1);
    assert.equal(beforeGuestCompleteClick.resultHidden, true);

    // Click #btn-complete-session to complete character & reveal portrait!
    await page.eval(`document.getElementById("btn-complete-session").click()`);
    await waitForCondition(page, `document.getElementById("result-panel").hidden === false`);

    // R9 Check in COMPLETED state: stage now reveals locked accessory (7) and assigned background (>= 0)
    const completedGuestStage = await page.eval<{ accessory: number; background: number }>(`({
      accessory: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      background: Number(document.getElementById("led-stage-canvas").dataset.stageBackground)
    })`);
    assert.equal(completedGuestStage.accessory, 7);
    assert.ok(completedGuestStage.background >= 0);

    // Verify 1600x1600 canvas dimensions & PNG IHDR header from canvas.toDataURL("image/png")
    const pngInfo = await page.eval<{
      canvasW: number;
      canvasH: number;
      ihdrW: number;
      ihdrH: number;
      nonTransparentPixels: number;
    }>(`(() => {
      const c = document.getElementById("led-stage-canvas");
      const dataUrl = c.toDataURL("image/png");
      const bin = atob(dataUrl.split(",")[1]);
      const view = new DataView(new Uint8Array([...bin].map((ch) => ch.charCodeAt(0))).buffer);
      const ihdrW = view.getUint32(16, false);
      const ihdrH = view.getUint32(20, false);
      const ctx = c.getContext("2d");
      const sample = ctx.getImageData(400, 400, 800, 800).data;
      let nonTransparentPixels = 0;
      for (let i = 3; i < sample.length; i += 4) {
        if (sample[i] > 0) nonTransparentPixels++;
      }
      return {
        canvasW: c.width,
        canvasH: c.height,
        ihdrW,
        ihdrH,
        nonTransparentPixels
      };
    })()`);
    assert.equal(pngInfo.canvasW, 1600);
    assert.equal(pngInfo.canvasH, 1600);
    assert.equal(pngInfo.ihdrW, 1600);
    assert.equal(pngInfo.ihdrH, 1600);
    assert.ok(pngInfo.nonTransparentPixels > 10000);

    // Verify Guest session wrote NOTHING to browser storage or backend DB
    const storageAfterGuest = await page.eval<{
      ls: number;
      ss: number;
      idb: number;
      cookie: string;
    }>(`(async () => ({
      ls: localStorage.length,
      ss: sessionStorage.length,
      idb: (await indexedDB.databases()).length,
      cookie: document.cookie
    }))()`);
    assert.deepEqual(storageAfterGuest, { ls: 0, ss: 0, idb: 0, cookie: "" });
    assert.equal(backend.getWeeklyLeaderboard().entries.length, 0);

    // Reload page: Guest session is discarded from RAM
    await reloadCdpPage(page, nowMs);
    // The server test clock is fixed except for explicit jumps; after every jump the browser harness clock is
    // locked to the same value (timers keep running), so freshness is judged on perfectly synchronized clocks.
    const alignBrowserClock = async () => {
      await page.eval(`window.__e2eLockClockMs(${nowMs})`);
    };
    await alignBrowserClock();
    await waitForCondition(
      page,
      `document.getElementById("btn-open-wallet-sheet") !== null`,
    );
    const afterGuestReload = await page.eval<{
      resultHidden: boolean;
      timerText: string;
      ls: number;
      ss: number;
    }>(`({
      resultHidden: document.getElementById("result-panel").hidden,
      timerText: document.getElementById("timer-readout").textContent,
      ls: localStorage.length,
      ss: sessionStorage.length
    })`);
    assert.equal(afterGuestReload.resultHidden, true);
    assert.equal(afterGuestReload.timerText, "0.0s / 60s");
    assert.equal(afterGuestReload.ls, 0);
    assert.equal(afterGuestReload.ss, 0);

    // 4. Responsive viewports check (320, 390, 768, 1440) -> zero horizontal overflow
    for (const width of [320, 390, 768, 1440]) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: width < 768,
      });
      await new Promise((r) => setTimeout(r, 80));
      const overflow = await page.eval<boolean>(
        `document.documentElement.scrollWidth > window.innerWidth`,
      );
      assert.equal(overflow, false, `Horizontal overflow detected at width ${width}px`);
    }

    // 5. SIWE Login + Ranked 60s Session + Direct /result/<resultId> deep-link (C1/R7) + Display Name Clear (R8)
    const walletAccount = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
    );

    await page.send("Runtime.addBinding", { name: "__e2eSignRequest" });
    await page.eval(`
      window.__rejectSign = false;
      window.__currentAccount = "${walletAccount.address}";
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [window.__currentAccount];
          }
          if (method === "eth_chainId") {
            return "0xaa36a7";
          }
          if (method === "personal_sign") {
            if (window.__rejectSign) {
              const err = new Error("User rejected the request.");
              err.code = 4001;
              throw err;
            }
            window.__lastChallengeToSign = params[0];
            return await window.__waitPersonalSign();
          }
          return null;
        }
      };
    `);

    // First test signature rejection in UI
    await page.eval(`window.__rejectSign = true`);
    await page.eval(`document.getElementById("btn-open-wallet-sheet").click()`);
    await waitForCondition(page, `document.getElementById("sheet-direct-siwe") !== null`);
    await page.eval(`document.getElementById("sheet-direct-siwe").click()`);
    await waitForCondition(
      page,
      `document.getElementById("status-toast").hidden === false && /declined|rejected/i.test(document.getElementById("status-toast").textContent)`,
    );

    // Now allow signing and complete SIWE verification
    await page.eval(`
      window.__rejectSign = false;
      window.__waitPersonalSign = () => new Promise((resolve) => {
        window.__resolvePersonalSign = resolve;
      });
    `);
    await page.eval(`document.getElementById("btn-open-wallet-sheet").click()`);
    await waitForCondition(page, `document.getElementById("sheet-direct-siwe") !== null`);
    void page.eval(`document.getElementById("sheet-direct-siwe").click()`);

    await waitForCondition(page, `typeof window.__lastChallengeToSign === "string"`);
    const challengeMsg = await page.eval<string>(`window.__lastChallengeToSign`);
    const realSig = await walletAccount.signMessage({ message: challengeMsg });
    await page.eval(`window.__resolvePersonalSign(${JSON.stringify(realSig)})`);

    await waitForCondition(
      page,
      `document.getElementById("auth-bar").textContent.includes("Ranked:")`,
    );

    // Set display name "OrbitPilot"
    await page.eval(`
      const inp = document.getElementById("display-name-input");
      inp.value = "OrbitPilot";
      document.getElementById("display-name-form").requestSubmit();
    `);
    await waitForCondition(
      page,
      `document.getElementById("auth-bar").textContent.includes("OrbitPilot")`,
    );

    // Start Ranked illumination (aimed at Head = -70)
    await page.eval(`document.getElementById("btn-start-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-pause-lamp") !== null`, 15000);

    // Verify Ranked R9 during running: accessory === -1, background === -1
    const rankedRunningStage = await page.eval<{ accessory: number; background: number }>(`({
      accessory: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      background: Number(document.getElementById("led-stage-canvas").dataset.stageBackground)
    })`);
    assert.equal(rankedRunningStage.accessory, -1);
    assert.equal(rankedRunningStage.background, -1);

    // R11 Ranked tick error check: when telemetry stalls during Ranked play, /api/session/tick returns 503,
    // client synchronizes UI to paused state without unhandled rejection, and recovers when telemetry returns
    hardwareMode = "stall";
    await waitForCondition(
      page,
      `document.getElementById("led-stage-canvas").dataset.sessionStatus === "paused" && document.getElementById("btn-start-lamp") !== null`,
      6000,
    );
    const rankedPausedByFault = await page.eval<{
      badgeText: string;
      toastText: string;
      elapsedSec: number;
    }>(`({
      badgeText: document.getElementById("telemetry-badge").textContent,
      toastText: document.getElementById("status-toast").textContent,
      elapsedSec: parseFloat(document.getElementById("timer-readout").textContent)
    })`);
    assert.match(rankedPausedByFault.badgeText, /SIGNAL UNAVAILABLE/i);
    assert.ok(rankedPausedByFault.toastText.length > 0);
    assert.equal(rankedPausedByFault.elapsedSec, 0);

    // Restore healthy telemetry and resume Ranked session
    hardwareMode = "healthy";
    nowMs += 1_000;
    await alignBrowserClock();
    await page.eval(`document.getElementById("btn-start-lamp").click()`);
    await waitForCondition(page, `document.getElementById("btn-pause-lamp") !== null`, 15000);

    // Advance 3 x 20s steps across Head (-70), Middle (0), Lower (70) -> auto-completes at 60s!
    nowMs += 20_000;
    await alignBrowserClock();
    await page.eval(`document.querySelector('[data-aim-region="1"]').click()`);
    await waitForCondition(
      page,
      `document.getElementById("led-stage-canvas").dataset.stageLevels === "10,0,0"`,
    );

    nowMs += 20_000;
    await alignBrowserClock();
    await page.eval(`document.querySelector('[data-aim-region="2"]').click()`);
    await waitForCondition(
      page,
      `document.getElementById("led-stage-canvas").dataset.stageLevels === "10,10,0"`,
    );

    nowMs += 20_000;
    await alignBrowserClock();
    await waitForCondition(page, `document.getElementById("result-panel").hidden === false`, 10000);
    await waitForCondition(
      page,
      `document.querySelectorAll(".led-lb-row").length === 1`,
    );

    // Verify Ranked R9 after completion: stage reveals locked accessory (7) and assigned background (>= 0)
    const rankedCompletedStage = await page.eval<{
      accessory: number;
      background: number;
      resultId: string;
      viewLinkHref: string;
    }>(`({
      accessory: Number(document.getElementById("led-stage-canvas").dataset.stageAccessory),
      background: Number(document.getElementById("led-stage-canvas").dataset.stageBackground),
      resultId: document.querySelector(".led-lb-row").dataset.resultId,
      viewLinkHref: document.querySelector(".led-lb-view-link").getAttribute("href")
    })`);
    assert.equal(rankedCompletedStage.accessory, 7);
    assert.ok(rankedCompletedStage.background >= 0);
    const rankedResultId = rankedCompletedStage.resultId;
    assert.ok(rankedResultId && rankedResultId.length > 0);
    assert.equal(rankedCompletedStage.viewLinkHref, `#result/${encodeURIComponent(rankedResultId)}`);

    // C1 & R7 Check 1: Direct browser navigation to /result/not-found mounts the app and renders Not Found state cleanly
    const notFoundPage = await openCdpPage(browser.cdpPort, `${baseUrl}/result/not-found`);
    await waitForCondition(
      notFoundPage,
      `window.__squeekAppMounted === true && document.getElementById("view-nft").hidden === false && document.getElementById("nft-not-found") !== null`,
    );
    assert.equal(
      notFoundPage.pageErrors.length,
      0,
      `Unexpected /result/not-found errors: ${notFoundPage.pageErrors.join("; ")}`,
    );
    notFoundPage.close();

    // C1 & R7 Check 2: Direct browser navigation & reload on /result/<resultId> (and /nft/<resultId> alias)
    const viewerPage = await openCdpPage(
      browser.cdpPort,
      `${baseUrl}/result/${encodeURIComponent(rankedResultId)}`,
    );
    await waitForCondition(
      viewerPage,
      `window.__squeekAppMounted === true && document.getElementById("view-nft").hidden === false && document.getElementById("nft-detail-grid").hidden === false`,
    );
    await reloadCdpPage(viewerPage);
    await waitForCondition(
      viewerPage,
      `document.getElementById("view-nft").hidden === false && document.getElementById("nft-detail-grid").hidden === false`,
    );

    const nftMetaText = await viewerPage.eval<string>(
      `document.getElementById("nft-detail-meta").innerText`,
    );
    assert.match(nftMetaText, /OrbitPilot/);
    assert.match(nftMetaText, new RegExp(walletAccount.address, "i"));

    // Verify /nft/<resultId> compatibility alias also works directly
    const aliasPage = await openCdpPage(
      browser.cdpPort,
      `${baseUrl}/nft/${encodeURIComponent(rankedResultId)}`,
    );
    await waitForCondition(
      aliasPage,
      `window.__squeekAppMounted === true && document.getElementById("view-nft").hidden === false && document.getElementById("nft-detail-grid").hidden === false`,
    );
    aliasPage.close();

    // R8 Check: Clear display name on Play page -> Leaderboard AND Public Result page revert to shortWallet
    await page.eval(`(() => {
      const inp = document.getElementById("display-name-input");
      inp.value = "";
      document.getElementById("display-name-form").requestSubmit();
    })()`);
    await waitForCondition(
      page,
      `!document.getElementById("auth-bar").textContent.includes("OrbitPilot")`,
    );
    await waitForCondition(
      page,
      `!(document.getElementById("full-leaderboard-container") || document.getElementById("play-leaderboard-container"))?.innerText?.includes("OrbitPilot")`,
    );

    await reloadCdpPage(viewerPage);
    await waitForCondition(
      viewerPage,
      `document.getElementById("nft-detail-grid").hidden === false`,
    );
    const nftMetaAfterClear = await viewerPage.eval<string>(
      `document.getElementById("nft-detail-meta").innerText`,
    );
    assert.doesNotMatch(nftMetaAfterClear, /OrbitPilot/);
    assert.match(nftMetaAfterClear, new RegExp(walletAccount.address.slice(0, 6), "i"));

    assert.equal(page.pageErrors.length, 0, `Unexpected page errors: ${page.pageErrors.join("; ")}`);
    assert.equal(
      viewerPage.pageErrors.length,
      0,
      `Unexpected viewer page errors: ${viewerPage.pageErrors.join("; ")}`,
    );

    // 6. Test all 3 families (Pulse, Relay, Prism) on stage
    const rendererMatrix = await page.eval<{
      family0Ok: boolean;
      family1Ok: boolean;
      family2Ok: boolean;
      mixedOk: boolean;
    }>(`(async () => {
      const results = [];
      for (const famBtnId of ["species-btn-pulse", "species-btn-relay", "species-btn-prism"]) {
        document.getElementById("btn-reset-egg").click();
        await new Promise((r) => setTimeout(r, 120));
        document.getElementById(famBtnId).click();
        await new Promise((r) => setTimeout(r, 120));
        const c = document.getElementById("led-stage-canvas");
        const data = c.getContext("2d").getImageData(500, 500, 600, 600).data;
        let lit = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 0) lit++;
        results.push(lit > 5000);
      }
      return {
        family0Ok: results[0],
        family1Ok: results[1],
        family2Ok: results[2],
        mixedOk: results.every(Boolean),
      };
    })()`);
    assert.equal(rendererMatrix.family0Ok, true);
    assert.equal(rendererMatrix.family1Ok, true);
    assert.equal(rendererMatrix.family2Ok, true);
    assert.equal(rendererMatrix.mixedOk, true);

    // 7. Test asset load failure rejection & recovery via CDP Network.setBlockedURLs
    const assetRecoveryPage = await openCdpPage(
      browser.cdpPort,
      `${baseUrl}/result/${encodeURIComponent(rankedResultId)}`,
      { blockedUrls: ["*/lab-assets/*"] },
    );
    await waitForCondition(
      assetRecoveryPage,
      `window.__squeekAppMounted === true && document.getElementById("nft-detail-grid").hidden === false`,
    );

    await assetRecoveryPage.eval(`
      window.__exportedBlobSize = 0;
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        if (blob instanceof Blob) {
          window.__exportedBlobSize = blob.size;
        }
        return origCreateObjectURL(blob);
      };
      document.getElementById("btn-nft-export-png").click();
    `);
    await waitForCondition(
      assetRecoveryPage,
      `document.getElementById("status-toast").hidden === false && /Asset load failure.*canonical 1600x1600 export blocked/i.test(document.getElementById("status-toast").textContent)`,
    );
    assert.equal(await assetRecoveryPage.eval<number>(`window.__exportedBlobSize`), 0);

    // Unblock /lab-assets/* and verify export recovers and produces a real 1600x1600 PNG Blob
    await assetRecoveryPage.send("Network.setBlockedURLs", { urls: [] });
    await assetRecoveryPage.eval(`document.getElementById("btn-nft-export-png").click()`);
    await waitForCondition(assetRecoveryPage, `window.__exportedBlobSize > 10000`);
    assetRecoveryPage.close();

    page.close();
    viewerPage.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    backend.close();
  }
});

