import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHatcheryHttpServer } from "../src/server.ts";
import { EXPERIMENTAL_POLICY_V3 } from "../src/game-policy.ts";
import { measurementDayKey } from "../src/rules.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, "../../docs/antigravity/round-5-screenshots");
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const harnessClockBootstrapScript = (initialMs) => `
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

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findBrowser() {
  for (const p of CHROME_PATHS) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chrome/Edge executable found");
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 1;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}) {
    const id = this.id++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expr) {
    const res = await this.send("Runtime.evaluate", {
      expression: expr,
      awaitPromise: true,
      returnByValue: true,
    });
    return res.result?.value;
  }

  async wait(expr, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.eval(`Boolean(${expr})`).catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Timeout waiting for: ${expr}`);
  }

  async screenshot(filePath) {
    const res = await this.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(filePath, Buffer.from(res.data, "base64"));
    console.log(`Saved screenshot: ${path.basename(filePath)} (${Math.round(res.data.length * 0.75 / 1024)} KB)`);
  }
}

async function main() {
  console.log("Starting server and browser for Round 5 visual acceptance screenshots...");

  let nowMs = Date.parse("2026-11-06T13:00:00.000Z");
  const { backend, server } = createHatcheryHttpServer({
    policy: EXPERIMENTAL_POLICY_V3,
    dbPath: ":memory:",
    now: () => nowMs,
    hardwareProvider: async () => ({
      source: "live",
      reading: {
        coreStatus: "ACTIVE",
        rpm: 65,
        meters: 300,
        distanceMm: 300_000,
        work: 400n,
        counterEpoch: "scr-epoch",
        installationId: "scr-wheel",
        observedAt: nowMs,
        received: nowMs,
        staleAfterSeconds: 60,
        utcDate: measurementDayKey(nowMs),
      },
    }),
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const exe = findBrowser();
  const tmpDir = path.resolve(process.cwd(), "cache", `cdp-scr-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  const chrome = spawn(exe, [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--remote-debugging-port=0",
    `--user-data-dir=${tmpDir}`,
    "about:blank",
  ]);

  const cdpPort = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Chrome port timeout")), 10000);
    const cb = (chunk) => {
      const m = chunk.toString().match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timeout);
        resolve(Number(m[1]));
      }
    };
    chrome.stderr?.on("data", cb);
    chrome.stdout?.on("data", cb);
  });

  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
  const pageTarget = targets.find((t) => t.type === "page") || targets[0];

  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));

  const cdp = new Cdp(ws);
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: harnessClockBootstrapScript(nowMs),
  });
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  try {
    // Navigate to base
    await cdp.send("Page.navigate", { url: `${baseUrl}/` });
    await cdp.wait(`document.getElementById("species-selector-container") !== null`);
    await cdp.wait(`document.getElementById("telemetry-badge")?.textContent?.includes("ACTIVE")`);
    await new Promise((r) => setTimeout(r, 600));

    // 1. Recognizable distinct closed eggs selector
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "01-distinct-closed-eggs.png"));

    // Select pulse egg and confirm claim
    await cdp.eval(`document.getElementById("species-btn-pulse").click()`);
    await new Promise((r) => setTimeout(r, 200));
    await cdp.eval(`document.getElementById("btn-confirm-egg").click()`);
    await new Promise((r) => setTimeout(r, 200));

    // Align clock and click Start Illumination
    await cdp.eval(`window.__e2eSetClockMs && window.__e2eSetClockMs(${nowMs})`);
    await cdp.eval(`document.getElementById("btn-start-lamp").click()`);
    await cdp.wait(`document.getElementById("btn-pause-lamp") !== null`, 10000);

    const stepGuestWithFreshTelemetry = async (seconds) => {
      let rem = seconds;
      while (rem > 0) {
        const chunk = Math.min(5, rem);
        rem -= chunk;
        nowMs += chunk * 1000;
        await cdp.eval(`window.__e2eHarnessStepMs(${chunk * 1000}, 200)`);
        await new Promise((r) => setTimeout(r, 120));
      }
    };

    // Let it incubate for 5 seconds
    await stepGuestWithFreshTelemetry(5);
    await new Promise((r) => setTimeout(r, 400));

    // 2. Stage reveal during incubation (hamster visible only through illuminated shell spot)
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "02-stage-reveal-incubation.png"));

    // Advance remaining 15 seconds at Head (-70) so Head reaches Lv 10 (saturated)
    await stepGuestWithFreshTelemetry(15);
    await cdp.wait(`document.getElementById("led-stage-canvas").dataset.stageLevels?.startsWith("10")`);
    await new Promise((r) => setTimeout(r, 400));

    // 3. Saturated region remains aimable
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "03-saturated-region-aiming.png"));

    // Advance remaining regions (Middle & Lower) to complete 60s illumination
    await cdp.eval(`document.querySelector('[data-aim-region="1"]').click()`);
    await stepGuestWithFreshTelemetry(20);
    await new Promise((r) => setTimeout(r, 400));

    await cdp.eval(`document.querySelector('[data-aim-region="2"]').click()`);
    await stepGuestWithFreshTelemetry(20);
    await new Promise((r) => setTimeout(r, 400));

    // Complete session
    await cdp.wait(`document.getElementById("btn-complete-session") !== null`);
    await cdp.eval(`document.getElementById("btn-complete-session").click()`);
    await cdp.wait(`document.getElementById("result-panel").hidden === false`, 12000);
    await new Promise((r) => setTimeout(r, 800));

    // 4. Completed canonical result (shell removed, accessory & background revealed)
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "04-completed-canonical-result.png"));

    // 5. Leaderboard view with top 3 uncropped portraits
    // Seed 3 entries into the backend DB so Top 3 renders!
    const wallet1 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const wallet2 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const wallet3 = "0xcccccccccccccccccccccccccccccccccccccccc";
    for (const [w, fam] of [[wallet1, 0], [wallet2, 1], [wallet3, 2]]) {
      backend.updatePlayerDisplayName(w, `Runner ${fam + 1}`);
      const egg = backend.claimRankedEgg(w, { familyIndex: fam });
      await backend.startRankedIllumination(w, { sessionId: egg.id });
      nowMs += 20000;
      await backend.aimRankedSession(w, { sessionId: egg.id, lampPosition: -70 });
      nowMs += 20000;
      await backend.aimRankedSession(w, { sessionId: egg.id, lampPosition: 0 });
      nowMs += 20000;
      await backend.aimRankedSession(w, { sessionId: egg.id, lampPosition: 70 });
      await backend.completeRankedSession(w, { sessionId: egg.id });
    }

    await cdp.eval(`location.hash = "#leaderboard"`);
    await cdp.wait(`document.querySelectorAll(".led-top3-card").length === 3`, 10000);
    await new Promise((r) => setTimeout(r, 800));
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "05-top3-leaderboard-portraits.png"));

    // 6. Account popover with remaining daily allowance and display name form
    // Create an authenticated session in SQLite and set cookie
    const rawToken = "scr-session-token-" + Date.now();
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const playerWallet = "0x1111111111111111111111111111111111111111";
    backend.updatePlayerDisplayName(playerWallet, "HamsterMaster");
    backend["db"].prepare(`INSERT INTO auth_sessions (token_hash, wallet_address, checksum_address, chain_id, origin, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      tokenHash,
      playerWallet.toLowerCase(),
      playerWallet,
      11155111,
      baseUrl,
      new Date(nowMs).toISOString(),
      new Date(nowMs + 7 * 86400 * 1000).toISOString(),
    );

    await cdp.send("Network.enable");
    await cdp.send("Network.setCookie", {
      name: "squeek_session",
      value: rawToken,
      domain: "127.0.0.1",
      path: "/",
    });

    await cdp.eval(`location.hash = "#play"`);
    await cdp.send("Page.reload");
    await cdp.wait(`document.getElementById("btn-account-toggle") !== null`, 10000);
    await cdp.eval(`document.getElementById("btn-account-toggle").click()`);
    await cdp.wait(`document.getElementById("account-popover") !== null && document.getElementById("account-popover").hidden === false`);
    await new Promise((r) => setTimeout(r, 400));
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "06-account-popover-allowance.png"));

    // 7. Rewritten concise Docs page
    await cdp.eval(`location.hash = "#docs"`);
    await cdp.wait(`document.getElementById("view-docs").hidden === false`);
    await new Promise((r) => setTimeout(r, 500));
    await cdp.screenshot(path.join(SCREENSHOT_DIR, "07-concise-docs-page.png"));

    console.log("All 7 acceptance screenshots captured successfully!");
  } catch (err) {
    console.error("Step failed inside try:", err);
    throw err;
  } finally {
    try { ws.close(); } catch {}
    try { chrome.kill(); } catch {}
    try { server.close(); } catch {}
    try { backend.close(); } catch {}
    setTimeout(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }, 1000);
  }
}

main().catch((err) => {
  console.error("Screenshot capture failed:", err);
  process.exit(1);
});
