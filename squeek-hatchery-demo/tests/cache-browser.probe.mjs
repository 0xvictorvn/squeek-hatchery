/**
 * Browser cache and login-cookie probe. Host command, after build:
 *   node --experimental-strip-types tests/cache-browser.probe.mjs <absolute-output-dir>
 *
 * Measures cold and warm loads with Chrome's cache left enabled. No Fetch interception.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { createHatcheryHttpServer } from "../src/server.ts";
import { measurementDayKey } from "../src/rules.ts";

const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const TEST_ACCOUNT = privateKeyToAccount(generatePrivateKey());
const REQUIRED_KINDS = ["document", "hashed-js", "egg", "lamp", "atlas"];

function findBrowserExecutable() {
  for (const candidate of CHROME_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function resolveOutputDir() {
  const arg = process.argv[2];
  if (!arg) return fs.mkdtempSync(path.join(os.tmpdir(), "squeek-cache-probe-"));
  if (!path.isAbsolute(arg)) throw new Error("cache-browser output directory must be an absolute path");
  fs.mkdirSync(arg, { recursive: true });
  return arg;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function freshReading() {
  const nowMs = Date.now();
  return {
    reading: {
      coreStatus: "ACTIVE",
      rpm: 65,
      meters: 300,
      distanceMm: 300_000,
      work: 400n,
      counterEpoch: "cache-probe-epoch",
      installationId: "cache-probe-wheel",
      observedAt: nowMs,
      received: nowMs,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(nowMs),
    },
    source: "live",
  };
}

function assetKind(url) {
  let pathname = "";
  try {
    pathname = new URL(url).pathname;
  } catch {
    return "";
  }
  if (/\/assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9]+)+$/i.test(pathname)) {
    if (pathname.toLowerCase().endsWith(".css")) return "hashed-css";
    if (pathname.toLowerCase().endsWith(".js")) return "hashed-js";
    return "hashed-other";
  }
  if (/\/art\/egg-/i.test(pathname)) return "egg";
  if (/\/art\/heat-lamp/i.test(pathname)) return "lamp";
  if (/\/lab-assets\/.+\.png$/i.test(pathname)) return "atlas";
  if (pathname === "/" || pathname.endsWith("/docs") || pathname.endsWith("/play") || pathname.endsWith(".html")) {
    return "document";
  }
  return "";
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  return "";
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.pageErrors = [];
    this.consoleErrors = [];
    this.phase = "cold";
    this.net = new Map();
    this.onLoad = null;
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.pageErrors.push(details?.exception?.description ?? details?.text ?? "Unknown page exception");
      } else if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        const text = (message.params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? "")
          .join(" ");
        this.consoleErrors.push(text || "console.error");
      } else if (message.method === "Page.loadEventFired") {
        const notify = this.onLoad;
        this.onLoad = null;
        if (notify) notify();
      } else if (message.method?.startsWith("Network.")) {
        this.noteNetwork(message.method, message.params ?? {});
      }
    });
  }

  noteNetwork(method, params) {
    const requestId = params.requestId;
    if (!requestId) return;
    const existing = this.net.get(requestId);
    if (method === "Network.requestWillBeSent") {
      this.net.set(requestId, {
        phase: this.phase,
        url: params.request?.url ?? existing?.url ?? "",
        method: params.request?.method ?? "GET",
        status: existing?.status ?? 0,
        encodedDataLength: existing?.encodedDataLength ?? null,
        fromDiskCache: existing?.fromDiskCache ?? false,
        fromPrefetchCache: existing?.fromPrefetchCache ?? false,
        fromServiceWorker: existing?.fromServiceWorker ?? false,
        servedFromCache: existing?.servedFromCache ?? false,
        cacheControl: existing?.cacheControl ?? "",
        mimeType: existing?.mimeType ?? "",
        finished: existing?.finished ?? false,
        failed: existing?.failed ?? "",
      });
      return;
    }
    const row = existing ?? {
      phase: this.phase,
      url: params.response?.url ?? "",
      method: "GET",
      status: 0,
      encodedDataLength: null,
      fromDiskCache: false,
      fromPrefetchCache: false,
      fromServiceWorker: false,
      servedFromCache: false,
      cacheControl: "",
      mimeType: "",
      finished: false,
      failed: "",
    };
    if (method === "Network.responseReceived") {
      row.status = params.response?.status ?? row.status;
      row.url = params.response?.url ?? row.url;
      row.fromDiskCache = Boolean(params.response?.fromDiskCache);
      row.fromPrefetchCache = Boolean(params.response?.fromPrefetchCache);
      row.fromServiceWorker = Boolean(params.response?.fromServiceWorker);
      row.mimeType = params.response?.mimeType ?? "";
      row.cacheControl = headerValue(params.response?.headers, "cache-control");
    } else if (method === "Network.loadingFinished") {
      row.encodedDataLength = params.encodedDataLength ?? 0;
      row.finished = true;
    } else if (method === "Network.requestServedFromCache") {
      row.servedFromCache = true;
      row.finished = true;
      if (row.encodedDataLength === null) row.encodedDataLength = 0;
    } else if (method === "Network.loadingFailed") {
      row.failed = params.errorText ?? "failed";
      row.finished = true;
    }
    this.net.set(requestId, row);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed");
    }
    return result.result?.value;
  }

  close(cdpPort, targetId) {
    this.ws.close();
    if (cdpPort && targetId) {
      void fetch(`http://127.0.0.1:${cdpPort}/json/close/${targetId}`).catch(() => {});
    }
  }
}

async function launchBrowser(exe, userDataDir) {
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
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );
  try {
    const port = await new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error("Timed out waiting for Chrome DevTools port"));
      }, 15000);
      const onExit = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Chrome exited early with code ${code}`));
      };
      const onData = (chunk) => {
        const match = String(chunk).match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (!match || settled) return;
        settled = true;
        clearTimeout(timeout);
        proc.removeListener("exit", onExit);
        resolve(Number(match[1]));
      };
      proc.stderr?.on("data", onData);
      proc.stdout?.on("data", onData);
      proc.once("exit", onExit);
    });
    return { proc, port };
  } catch (error) {
    proc.kill();
    throw error;
  }
}

async function openBlank(cdpPort) {
  const response = await fetch(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, { method: "PUT" });
  if (!response.ok) throw new Error(`CDP new tab failed: ${response.status}`);
  const target = await response.json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("WebSocket error")), { once: true });
  });
  const session = new CdpSession(ws);
  await session.send("Page.enable");
  await session.send("Runtime.enable");
  await session.send("DOM.enable");
  await session.send("Network.enable");
  return { session, targetId: target.id };
}

function waitForLoad(session, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    session.onLoad = () => {
      clearTimeout(timer);
      resolve(true);
    };
  });
}

async function waitFor(session, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await session.eval(`Boolean(${predicate})`).catch(() => false);
    if (ok) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}

function copyRow(row) {
  return {
    url: row.url,
    status: row.status,
    encodedDataLength: row.encodedDataLength,
    fromDiskCache: row.fromDiskCache,
    fromPrefetchCache: row.fromPrefetchCache,
    fromServiceWorker: row.fromServiceWorker,
    servedFromCache: row.servedFromCache,
    cacheControl: row.cacheControl,
    mimeType: row.mimeType,
    finished: row.finished,
    failed: row.failed,
    kind: assetKind(row.url),
  };
}

function rowsFor(session, phase, origin) {
  return [...session.net.values()]
    .filter((row) => row.phase === phase && typeof row.url === "string" && row.url.startsWith(origin))
    .map(copyRow);
}

async function collectPerformance(session) {
  const entries = await session.eval(`(() => {
    const rows = [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ];
    return rows.map((entry) => ({
      name: entry.name,
      transferSize: entry.transferSize,
      encodedBodySize: entry.encodedBodySize,
      decodedBodySize: entry.decodedBodySize,
    }));
  })()`);
  return Array.isArray(entries) ? entries : [];
}

function savedByCdp(cold, warm) {
  if (!warm) return false;
  if (warm.status === 304) return true;
  if (warm.servedFromCache || warm.fromDiskCache || warm.fromPrefetchCache) return true;
  return (
    typeof cold.encodedDataLength === "number" &&
    cold.encodedDataLength > 0 &&
    typeof warm.encodedDataLength === "number" &&
    warm.encodedDataLength < cold.encodedDataLength
  );
}

function savedByPerformance(coldEntry, warmEntry) {
  if (!coldEntry || !warmEntry) return false;
  return coldEntry.transferSize > 0 && warmEntry.transferSize === 0 && warmEntry.decodedBodySize > 0;
}

function pickCold(rows) {
  const finished = rows.filter((row) => row.finished || row.status);
  finished.sort((a, b) => (b.encodedDataLength ?? 0) - (a.encodedDataLength ?? 0));
  return finished[0] ?? rows[0] ?? null;
}

function pickWarm(rows, cold) {
  const saved = rows.find((row) => savedByCdp(cold, row));
  if (saved) return saved;
  const finished = rows.filter((row) => row.finished || row.status);
  return finished[finished.length - 1] ?? rows[rows.length - 1] ?? null;
}

function performanceFor(entries, url) {
  const target = url.split("#")[0];
  return entries.find((entry) => entry.name?.split("#")[0] === target) ?? null;
}

function cookieMeta(cookies) {
  const found = (cookies ?? []).find((cookie) => cookie.name === "squeek_session");
  if (!found) return { present: false };
  const remainingSec = typeof found.expires === "number" ? found.expires - Date.now() / 1000 : null;
  return {
    present: typeof found.value === "string" && found.value.length > 0,
    httpOnly: found.httpOnly === true,
    secure: found.secure === true,
    sameSite: found.sameSite ?? "",
    path: found.path ?? "",
    remainingSec: remainingSec === null ? null : Math.round(remainingSec),
  };
}

async function readAuth(session) {
  return session.eval(`(() => ({
    mounted: window.__squeekAppMounted === true,
    ranked: (document.getElementById("auth-bar")?.textContent ?? "").includes("Ranked:"),
    guest: (document.getElementById("auth-bar")?.textContent ?? "").includes("Guest Mode"),
    resetsOnRefresh: (document.getElementById("auth-bar")?.textContent ?? "").includes("Progress resets on refresh"),
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    handle: document.getElementById("lamp-handle-elem") !== null
  }))()`);
}

async function main() {
  const outputDir = resolveOutputDir();
  const reportPath = path.join(outputDir, "cache-browser.json");
  const cases = [];
  const record = (id, ok, detail, extra = {}) => {
    cases.push({ id, status: ok ? "pass" : "fail", detail, ...extra });
  };
  const exe = findBrowserExecutable();
  if (!exe) {
    fs.writeFileSync(reportPath, JSON.stringify({ ok: false, error: "No installed Chrome or Edge executable found", cases }, null, 2));
    return 1;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "squeek-cache-chrome-"));
  const { backend, server } = createHatcheryHttpServer({
    dbPath: ":memory:",
    now: () => Date.now(),
    autoStartProducer: false,
    hardwareTimeoutMs: 1000,
    hardwareProvider: async () => freshReading(),
  });
  let browser = null;
  let session = null;
  let cdpPort = 0;
  let targetId = "";
  let exitCode = 1;
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("cache probe server did not bind");
    const origin = `http://127.0.0.1:${address.port}`;
    browser = await launchBrowser(exe, userDataDir);
    cdpPort = browser.port;
    const opened = await openBlank(cdpPort);
    session = opened.session;
    targetId = opened.targetId;

    session.phase = "cold";
    const coldLoaded = waitForLoad(session);
    await session.send("Page.navigate", { url: `${origin}/#play` });
    const coldLoadEvent = await coldLoaded;
    await waitFor(session, "window.__squeekAppMounted === true");
    const coldWaitStart = Date.now();
    let coldRows = [];
    while (Date.now() - coldWaitStart < 8000) {
      coldRows = rowsFor(session, "cold", origin);
      if (REQUIRED_KINDS.every((kind) => coldRows.some((row) => row.kind === kind && row.finished))) break;
      await delay(50);
    }
    const coldPerformance = await collectPerformance(session);

    session.phase = "warm";
    const warmLoaded = waitForLoad(session);
    await session.send("Page.reload", { ignoreCache: false });
    const warmLoadEvent = await warmLoaded;
    await waitFor(session, "window.__squeekAppMounted === true");
    const warmWaitStart = Date.now();
    let warmRows = [];
    while (Date.now() - warmWaitStart < 8000) {
      warmRows = rowsFor(session, "warm", origin);
      const ready = REQUIRED_KINDS.every((kind) =>
        warmRows.some(
          (row) =>
            row.kind === kind &&
            (row.finished || row.servedFromCache || row.fromDiskCache || row.status === 304),
        ),
      );
      if (ready) break;
      await delay(50);
    }
    const warmPerformance = await collectPerformance(session);

    const coldByUrl = new Map();
    for (const row of coldRows) {
      const key = row.url.split("#")[0];
      const list = coldByUrl.get(key) ?? [];
      list.push(row);
      coldByUrl.set(key, list);
    }
    const warmByUrl = new Map();
    for (const row of warmRows) {
      const key = row.url.split("#")[0];
      const list = warmByUrl.get(key) ?? [];
      list.push(row);
      warmByUrl.set(key, list);
    }

    const representatives = [];
    for (const [url, coldList] of coldByUrl) {
      const kind = assetKind(url);
      if (!kind) continue;
      const cold = pickCold(coldList);
      const warm = pickWarm(warmByUrl.get(url) ?? [], cold);
      const coldPerf = performanceFor(coldPerformance, url);
      const warmPerf = performanceFor(warmPerformance, url);
      representatives.push({
        url,
        kind,
        cold,
        warm,
        coldTransferSize: coldPerf?.transferSize ?? null,
        warmTransferSize: warmPerf?.transferSize ?? null,
        savedByCdp: savedByCdp(cold, warm),
        savedByPerformance: savedByPerformance(coldPerf, warmPerf),
        fromServiceWorker: Boolean(cold?.fromServiceWorker || warm?.fromServiceWorker),
      });
    }

    const mounted = await readAuth(session);
    record("app-mounted", mounted?.mounted === true && mounted?.handle === true, "play view mounted after warm reload", {
      coldLoadEvent,
      warmLoadEvent,
    });
    record(
      "guest-before-login",
      mounted?.ranked === false && mounted?.guest === true && mounted?.resetsOnRefresh === true && mounted?.localStorage === 0 && mounted?.sessionStorage === 0,
      "guest state is visible and storage is empty before login",
      {
        ranked: mounted?.ranked ?? null,
        guest: mounted?.guest ?? null,
        localStorage: mounted?.localStorage ?? null,
        sessionStorage: mounted?.sessionStorage ?? null,
      },
    );

    for (const kind of REQUIRED_KINDS) {
      const rows = representatives.filter((item) => item.kind === kind);
      if (rows.length === 0) {
        record(kind, false, `no ${kind} request on the cold or warm load`, {
          seen: [...new Set(coldRows.map((row) => row.url))].slice(0, 30),
        });
        continue;
      }
      const badCold = rows.filter((item) => item.cold?.status !== 200 || !(item.cold?.encodedDataLength > 0) || item.cold?.fromDiskCache || item.cold?.servedFromCache);
      const unsaved = rows.filter((item) => !item.savedByCdp && !item.savedByPerformance);
      const worker = rows.filter((item) => item.fromServiceWorker);
      record(
        kind,
        badCold.length === 0 && unsaved.length === 0 && worker.length === 0,
        badCold.length || unsaved.length || worker.length
          ? `${kind} cold/warm evidence did not show a full first download and a warm save`
          : `${kind} warm load reused cache or returned 304`,
        {
          assets: rows.map((item) => ({
            url: item.url,
            coldStatus: item.cold?.status ?? 0,
            warmStatus: item.warm?.status ?? 0,
            coldBytes: item.cold?.encodedDataLength ?? null,
            warmBytes: item.warm?.encodedDataLength ?? null,
            coldTransferSize: item.coldTransferSize,
            warmTransferSize: item.warmTransferSize,
            cacheControl: item.cold?.cacheControl ?? "",
            fromDiskCache: item.warm?.fromDiskCache ?? false,
            servedFromCache: item.warm?.servedFromCache ?? false,
            savedByCdp: item.savedByCdp,
            savedByPerformance: item.savedByPerformance,
          })),
        },
      );
    }

    const cssRows = representatives.filter((item) => item.kind === "hashed-css");
    if (cssRows.length === 0) {
      record("hashed-css", true, "this build did not request a separate hashed stylesheet", { present: false });
    } else {
      const ok = cssRows.every((item) => item.savedByCdp || item.savedByPerformance);
      record("hashed-css", ok, ok ? "hashed css warm load saved bytes or returned 304" : "hashed css was downloaded again", {
        assets: cssRows.map((item) => ({ url: item.url, coldBytes: item.cold?.encodedDataLength ?? null, warmBytes: item.warm?.encodedDataLength ?? null })),
      });
    }

    const hashed = representatives.find((item) => item.kind === "hashed-js");
    const egg = representatives.find((item) => item.kind === "egg");
    const atlas = representatives.find((item) => item.kind === "atlas");
    const document = representatives.find((item) => item.kind === "document");
    record(
      "hashed-cache-control",
      Boolean(hashed?.cold?.cacheControl?.includes("immutable") && hashed.cold.cacheControl.includes("max-age=31536000")),
      hashed?.cold?.cacheControl || "no hashed javascript cache-control",
    );
    record(
      "stable-image-cache-control",
      Boolean(egg && atlas && egg.cold?.cacheControl?.includes("must-revalidate") && !egg.cold.cacheControl.includes("immutable") && atlas.cold?.cacheControl?.includes("must-revalidate")),
      `egg ${egg?.cold?.cacheControl || "missing"}; atlas ${atlas?.cold?.cacheControl || "missing"}`,
    );
    record(
      "document-cache-control",
      document?.cold?.cacheControl === "no-cache",
      document?.cold?.cacheControl || "no document cache-control",
    );

    session.phase = "docs";
    const docsLoaded = waitForLoad(session);
    await session.send("Page.navigate", { url: `${origin}/docs` });
    await docsLoaded;
    await waitFor(session, "window.__squeekAppMounted === true");
    const docsAuth = await readAuth(session);
    record("docs-route", docsAuth?.mounted === true && docsAuth?.ranked === false, "docs alias mounted while still a guest");

    session.phase = "return";
    const returnLoaded = waitForLoad(session);
    await session.send("Page.navigate", { url: `${origin}/#play` });
    await returnLoaded;
    await waitFor(session, "window.__squeekAppMounted === true");

    await session.eval(`
      window.__currentAccount = ${JSON.stringify(TEST_ACCOUNT.address)};
      window.__waitPersonalSign = () => new Promise((resolve) => { window.__resolvePersonalSign = resolve; });
      window.ethereum = {
        request: async ({ method, params }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") return [window.__currentAccount];
          if (method === "eth_chainId") return "0xaa36a7";
          if (method === "personal_sign") {
            window.__lastChallengeToSign = params[0];
            return await window.__waitPersonalSign();
          }
          return null;
        }
      };
    `);
    await session.eval(`document.getElementById("btn-open-wallet-sheet").click()`);
    await waitFor(session, `document.getElementById("sheet-direct-siwe") !== null`);
    await session.eval(`document.getElementById("sheet-direct-siwe").click()`);
    await waitFor(session, `typeof window.__lastChallengeToSign === "string"`);
    const challengeMessage = await session.eval(`window.__lastChallengeToSign`);
    let signature = "";
    try {
      signature = await TEST_ACCOUNT.signMessage({ message: challengeMessage });
      await session.eval(`window.__resolvePersonalSign(${JSON.stringify(signature)})`);
    } catch {
      throw new Error("Local SIWE round trip failed before the page reached Ranked");
    } finally {
      signature = "";
    }
    try {
      await waitFor(session, `document.getElementById("auth-bar") && document.getElementById("auth-bar").textContent.includes("Ranked:")`);
    } catch (error) {
      const toast = await session.eval(`document.getElementById("status-toast")?.textContent ?? ""`).catch(() => "");
      throw new Error(`Login did not reach Ranked. ${toast || (error instanceof Error ? error.message : String(error))}`);
    }

    const loggedInCookies = await session.send("Network.getCookies", { urls: [`${origin}/`] });
    const loggedIn = cookieMeta(loggedInCookies.cookies);
    record(
      "cookie-metadata",
      loggedIn.present === true &&
        loggedIn.httpOnly === true &&
        loggedIn.sameSite === "Lax" &&
        loggedIn.path === "/" &&
        loggedIn.secure === false &&
        typeof loggedIn.remainingSec === "number" &&
        loggedIn.remainingSec > 23 * 3600 &&
        loggedIn.remainingSec < 25 * 3600,
      "HttpOnly Lax Path=/ cookie lifetime is about 24h on this HTTP origin",
      loggedIn,
    );

    session.phase = "reload-auth";
    const authLoaded = waitForLoad(session);
    await session.send("Page.reload", { ignoreCache: false });
    await authLoaded;
    await waitFor(session, `document.getElementById("auth-bar") && document.getElementById("auth-bar").textContent.includes("Ranked:")`);
    const reloadedCookies = cookieMeta((await session.send("Network.getCookies", { urls: [`${origin}/`] })).cookies);
    const reloadedAuth = await readAuth(session);
    record(
      "login-survives-reload",
      reloadedAuth?.ranked === true && reloadedCookies.present === true && reloadedCookies.httpOnly === true,
      "reload kept the Ranked session",
      { ranked: reloadedAuth?.ranked ?? null, cookiePresent: reloadedCookies.present },
    );

    await session.eval(`document.getElementById("btn-top-logout").click()`);
    await waitFor(session, `document.getElementById("auth-bar") && !document.getElementById("auth-bar").textContent.includes("Ranked:")`);
    const loggedOut = cookieMeta((await session.send("Network.getCookies", { urls: [`${origin}/`] })).cookies);
    const loggedOutAuth = await readAuth(session);
    record(
      "logout-clears-session",
      loggedOutAuth?.ranked === false && loggedOutAuth?.guest === true && loggedOut.present === false,
      "logout returned to guest and removed the session cookie",
      { ranked: loggedOutAuth?.ranked ?? null, guest: loggedOutAuth?.guest ?? null, cookiePresent: loggedOut.present },
    );

    session.phase = "reload-guest";
    const guestLoaded = waitForLoad(session);
    await session.send("Page.reload", { ignoreCache: false });
    await guestLoaded;
    await waitFor(session, "window.__squeekAppMounted === true");
    const guestAgain = await readAuth(session);
    record(
      "guest-after-logout-reload",
      guestAgain?.ranked === false &&
        guestAgain?.guest === true &&
        guestAgain?.resetsOnRefresh === true &&
        guestAgain?.localStorage === 0 &&
        guestAgain?.sessionStorage === 0,
      "refresh after logout stays a guest without stored progress",
      {
        ranked: guestAgain?.ranked ?? null,
        guest: guestAgain?.guest ?? null,
        localStorage: guestAgain?.localStorage ?? null,
        sessionStorage: guestAgain?.sessionStorage ?? null,
      },
    );

    record(
      "page-exceptions",
      session.pageErrors.length === 0,
      session.pageErrors.length === 0 ? "no uncaught page exceptions" : session.pageErrors.slice(0, 8).join(" | "),
    );
    record(
      "console-errors",
      session.consoleErrors.length === 0,
      session.consoleErrors.length === 0 ? "no console.error" : session.consoleErrors.slice(0, 8).join(" | "),
    );

    const failed = cases.filter((item) => item.status === "fail");
    const report = {
      ok: failed.length === 0,
      assertionSource: "CDP Network plus Performance resource timings",
      cacheDisabled: false,
      fetchIntercepted: false,
      chrome: exe,
      origin,
      outputDir,
      cases,
      representatives,
      consoleErrors: session.consoleErrors,
      pageErrors: session.pageErrors,
      notClaimed: [
        "Caching does not shrink the cold download or the image files",
        "No image compression, service worker, or deployment was performed",
        "HTTPS Secure is covered by the HTTP cookie fixture, not this HTTP browser session",
        "Ranked production code was not changed",
      ],
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          ok: false,
          error: message,
          cases,
          consoleErrors: session ? session.consoleErrors : [],
          pageErrors: session ? session.pageErrors : [],
          cacheDisabled: false,
          fetchIntercepted: false,
        },
        null,
        2,
      ),
    );
    console.error(message);
    exitCode = 1;
  } finally {
    if (session) session.close(cdpPort, targetId);
    if (browser) browser.proc.kill();
    await new Promise((resolve) => server.close(() => resolve()));
    try {
      backend.close();
    } catch {
      // already closed
    }
    await delay(200);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // Windows can keep the profile locked briefly after Chrome exits.
    }
  }
  return exitCode;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
