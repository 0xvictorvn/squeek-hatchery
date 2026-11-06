// Production-export checks. Synthetic readings and wallet/proof fixtures exist ONLY here.
// PLAYWRIGHT=/external/playwright/index.mjs PLAYWRIGHT_BROWSERS_PATH=/external/browsers node tests/e2e.mjs
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import assert from "node:assert/strict";
import { startChain, artifact } from "./anvil.ts";
import { hashProof, hashResult } from "../src/nft.ts";
const { chromium, webkit } = await import(
  process.env.PLAYWRIGHT || "playwright"
);
const out = path.resolve("test/scratch/e2e");
await fs.mkdir(out, { recursive: true });
const results = [],
  errors = [],
  localMissing = [];
const c = await startChain(0, 6n);
let useContract = false,
  useProof = false,
  rpcBroken = false,
  rpcWrongChain = false,
  holdReceipts = false,
  proofBad = false,
  proofRequests = 0;
const verifier = await c.deploy("MockHatchVerifier", [c.accounts[5]]);
const setHash = await c.wallet(c.admin).writeContract({
  address: c.address,
  abi: c.abi,
  functionName: "setVerifier",
  args: [verifier],
});
await c.pub.waitForTransactionReceipt({ hash: setHash });
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname === "/rpc") {
      let body = "";
      for await (const b of req) body += b;
      const q = JSON.parse(body);
      res.setHeader("content-type", "application/json");
      if (rpcWrongChain && !Array.isArray(q) && q.method === "eth_chainId") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: q.id, result: "0x1" }));
        return;
      }
      if (rpcBroken) {
        res.writeHead(503);
        res.end("{}");
        return;
      }
      if (
        holdReceipts &&
        (Array.isArray(q)
          ? q.some((x) => x.method === "eth_getTransactionReceipt")
          : q.method === "eth_getTransactionReceipt")
      ) {
        res.end(
          JSON.stringify(
            Array.isArray(q)
              ? q.map((x) => ({ jsonrpc: "2.0", id: x.id, result: null }))
              : { jsonrpc: "2.0", id: q.id, result: null },
          ),
        );
        return;
      }
      const response = await fetch(c.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      res.end(await response.text());
      return;
    }
    if (url.pathname === "/proof") {
      proofRequests++;
      let body = "";
      for await (const b of req) body += b;
      const j = JSON.parse(body);
      if (
        j.protocol !== "squeek-hatch-v3" ||
        j.proxy.toLowerCase() !== c.address.toLowerCase() ||
        j.resultHash !== hashResult(j.result)
      ) {
        res.writeHead(400);
        res.end();
        return;
      }
      const proof = {
        chainId: 11155111n,
        proxy: c.address,
        tokenId: BigInt(j.tokenId),
        owner: j.owner,
        resultHash: j.resultHash,
        nonce: BigInt(proofRequests),
        expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
      };
      const signature = await c
        .wallet(proofBad ? c.accounts[6] : c.accounts[5])
        .signMessage({ message: { raw: hashProof(proof) } });
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ proof, signature }, (_, v) =>
          typeof v === "bigint" ? v.toString() : v,
        ),
      );
      return;
    }
    let file = decodeURIComponent(url.pathname).replace(/^\/preview\//, "");
    if (!file || file === "preview") file = "index.html";
    if (file.includes("..")) {
      res.writeHead(400);
      res.end();
      return;
    }
    if (file === "hatchery.config.json" && useContract) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          chainId: 11155111,
          contractAddress: c.address,
          startBlock: "0",
          rpcUrl: origin + "/rpc",
          proofServiceUrl: useProof ? origin + "/proof" : null,
          explorer: "https://sepolia.etherscan.io",
        }),
      );
      return;
    }
    const data = await fs.readFile(path.resolve("dist", file));
    res.setHeader(
      "content-type",
      types[path.extname(file)] || "application/octet-stream",
    );
    res.end(data);
  } catch (e) {
    res.writeHead(404);
    res.end(String(e));
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const check = async (name, fn) => {
  try {
    await fn();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (e) {
    results.push({ name, passed: false, error: e.stack });
    console.error("FAIL", name, e.message);
    for (const context of browser.contexts())
      for (const page of context.pages()) {
        const debug = await page
          .evaluate(() => ({
            status: document.querySelector("#tx-status")?.textContent,
            claim: document.querySelector("#claim-reason")?.textContent,
            hatch: document.querySelector("#hatch-reason")?.textContent,
            submit: document.querySelector("#submit-reason")?.textContent,
            disabled: document.querySelector("#hatch-submit")?.disabled,
          }))
          .catch(() => null);
        await fs.writeFile(
          out + "/failure-state.json",
          JSON.stringify(debug, null, 2),
        );
        await page.screenshot({ path: out + "/failure.png" }).catch(() => {});
      }
    throw e;
  }
};
async function fixture(width = 390, wallet = false, measurementPeriod = 0, status = "ACTIVE") {
  const context = await browser.newContext({
      viewport: { width, height: 844 },
      acceptDownloads: true,
      reducedMotion: "reduce",
    }),
    page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("response", (r) => {
    if (r.url().startsWith(origin + "/preview/") && r.status() >= 400)
      localMissing.push(r.url());
  });
  let state = {
    mode: "fresh",
    status,
    rpm: 120000,
    work: "1000",
    mm: 250000,
    epoch: "synthetic-qa",
    frozenObserved: null,
    sampleOrigin: null,
    workStep: "0",
    pollTimes: [],
  };
  await page.route("https://api.squeekchain.com/**", async (route) => {
    if (state.mode === "network") {
      await route.abort();
      return;
    }
    const now = await page.evaluate(() => Date.now());
    state.pollTimes.push(now);
    state.sampleOrigin ??= now;
    const sampleIndex = measurementPeriod
      ? Math.floor((now - state.sampleOrigin) / measurementPeriod)
      : 0;
    let observed = state.frozenObserved ?? (measurementPeriod
      ? state.sampleOrigin + sampleIndex * measurementPeriod
      : now);
    if (state.mode === "stale") observed = now - 160000;
    const measurement = {
      provenance: state.mode === "simulated" ? "simulated" : "hardware",
      freshness: "online",
      coreStatus: state.mode === "fault" ? "COUNTER_FAULT" : state.status,
      rpmMilli: state.rpm,
      distanceMm: state.mm,
      cumulativeWorkUnits: (BigInt(state.work) + BigInt(sampleIndex) * BigInt(state.workStep)).toString(),
      counterEpoch: state.epoch,
      observedAt: new Date(observed).toISOString(),
      receivedAt: new Date(measurementPeriod ? observed : now).toISOString(),
      staleAfterSeconds: 15,
    };
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ schemaVersion: 1, measurement }),
    });
  });
  if (wallet)
    await context.addInitScript(
      ({ origin, accounts }) => {
        const handlers = {};
        let authorized = false,
          chain = "0xaa36a7",
          account = accounts[2];
        globalThis.__wallet = {
          rejectConnect: false,
          rejectSend: false,
          holdSend: false,
          requests: [],
          setAccount(a) {
            account = a;
            handlers.accountsChanged?.forEach((fn) => fn([a]));
          },
          setChain(ch) {
            chain = ch;
            handlers.chainChanged?.forEach((fn) => fn(ch));
          },
        };
        const provider = {
          on(event, fn) {
            (handlers[event] ||= []).push(fn);
          },
          removeListener(event, fn) {
            handlers[event] = (handlers[event] || []).filter((x) => x !== fn);
          },
          async request({ method, params = [] }) {
            globalThis.__wallet.requests.push(method);
            if (method === "eth_requestAccounts") {
              if (globalThis.__wallet.rejectConnect)
                throw Object.assign(new Error("User rejected"), { code: 4001 });
              authorized = true;
              return [account];
            }
            if (method === "eth_accounts") return authorized ? [account] : [];
            if (method === "eth_chainId") return chain;
            if (
              method === "wallet_switchEthereumChain" ||
              method === "wallet_addEthereumChain"
            ) {
              chain = params[0].chainId;
              handlers.chainChanged?.forEach((fn) => fn(chain));
              return null;
            }
            if (method === "eth_sendTransaction") {
              if (globalThis.__wallet.rejectSend)
                throw Object.assign(new Error("User rejected"), { code: 4001 });
              if (globalThis.__wallet.holdSend)
                await new Promise((r) => (globalThis.__releaseSend = r));
              params[0].from = account;
            }
            const r = await fetch(origin + "/rpc", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                jsonrpc: "2.0",
                id: Date.now(),
                method,
                params,
              }),
            });
            const j = await r.json();
            if (j.error)
              throw Object.assign(new Error(j.error.message), {
                code: j.error.code,
              });
            return j.result;
          },
        };
        globalThis.ethereum = provider;
        const info = {
          uuid: "6f748582-9e08-49bc-8888-49d7adf1b115",
          name: "QA browser wallet",
          icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          rdns: "test.qa.wallet",
        };
        const announce = () =>
          dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: { info, provider },
            }),
          );
        addEventListener("eip6963:requestProvider", announce);
        announce();
      },
      { origin, accounts: c.accounts },
    );
  await context.addInitScript(() => {
    const getter = Object.getOwnPropertyDescriptor(
      Document.prototype,
      "hidden",
    ).get;
    Object.defineProperty(document, "hidden", {
      get: () => globalThis.__qaHidden ?? getter.call(document),
    });
  });
  await page.clock.install();
  await page.goto(origin + "/preview/");
  await page.waitForFunction(() =>
    document.querySelector("#signal-state")?.textContent === "Fresh hardware reading",
  );
  await pause(40);
  return { context, page, state };
}
async function advance(page, ms) {
  for (let n = 0; n < ms; n += 1000) {
    await page.clock.runFor(Math.min(1000, ms - n));
    await pause(8);
  }
}
async function timeLeft(p) {
  return await p.locator("#timer").textContent();
}
async function hatch(f, name = "Pip") {
  await f.page.click("#get-egg");
  await f.page.waitForSelector("#start:not([hidden])");
  await f.page.click('[data-pos="0"]');
  await f.page.click("#start");
  assert.equal(
    await f.page.locator("#lamp").getAttribute("aria-valuenow"),
    "0",
  );
  assert.equal(
    await f.page.locator("#animal").getAttribute("clip-path"),
    "url(#eggInterior)",
  );
  await advance(f.page, 66000);
  assert.equal(
    await f.page.locator("#animal").getAttribute("clip-path"),
    "none",
  );
  await f.page.waitForSelector("#result:not([hidden])");
  await f.page.fill("#name", name);
  await f.page.click("#review");
}
async function connect(f) {
  await f.page.click("#wallet-slot button");
  await f.page
    .locator("button.row")
    .filter({ hasText: "QA browser wallet" })
    .click();
  await f.page.waitForFunction(() =>
    document.querySelector("#wallet-slot")?.textContent.includes("Disconnect"),
  );
}
async function downloaded(page, selector) {
  const pending = page.waitForEvent("download");
  await page.click(selector);
  const download = await pending;
  return fs.readFile(await download.path(), "utf8");
}
try {
  await check(
    "first screen, static subpath, null contract and no signing on connect",
    async () => {
      const f = await fixture(390, true);
      const p = f.page;
      const b = await p.locator("#get-egg").boundingBox();
      assert.ok(b.y + b.height < 844);
      assert.ok(await p.locator("#stage").isVisible());
      assert.equal(
        await p.title(),
        "Squeek Hatchery: hatch a hamster with light",
      );
      await p.evaluate(() => (__wallet.rejectConnect = true));
      await p.click("#wallet-slot button");
      await p
        .locator("button.row")
        .filter({ hasText: "QA browser wallet" })
        .click();
      await p.waitForFunction(() =>
        document
          .querySelector("#sheet-note")
          .textContent.includes("did not connect"),
      );
      await p.evaluate(() => (__wallet.rejectConnect = false));
      await p
        .locator("button.row")
        .filter({ hasText: "QA browser wallet" })
        .click();
      await p.waitForFunction(() =>
        document
          .querySelector("#wallet-slot")
          .textContent.includes("Disconnect"),
      );
      assert.equal(
        await p.evaluate(
          () =>
            __wallet.requests.filter((x) => /sign|sendTransaction/i.test(x))
              .length,
        ),
        0,
      );
      await p.click("#tab-nft");
      assert.equal(
        await p.locator("#contract-state").textContent(),
        "Contract not deployed",
      );
      assert.ok(
        await p
          .locator("#nft-status")
          .textContent()
          .then((s) => s.includes("unavailable")),
      );
      assert.ok(await p.locator("#claim").isDisabled());
      assert.ok(await p.locator("#nft-hatch").isDisabled());
      await p.click("#tab-demo");
      await p.screenshot({ path: out + "/mobile-first.png" });
      await f.context.close();
    },
  );
  await check(
    "local card transforms once; naming, saved state, coat toggle, SVG/JSON parity and reload",
    async () => {
      const f = await fixture();
      await hatch(f, "W".repeat(30));
      const p = f.page;
      const before = await p.evaluate(() =>
        JSON.parse(localStorage.getItem("squeek-hatchery-v3")),
      );
      assert.equal(before.cards.length, 1);
      assert.equal(before.cards[0].kind, "hamster");
      const id = before.cards[0].id;
      await p.click("#save");
      const svg = await downloaded(p, "#dl-svg"),
        json = JSON.parse(await downloaded(p, "#dl-json"));
      assert.equal(atob(json.image.split(",")[1]), svg);
      assert.ok(
        json.attributes.some(
          (a) => a.trait_type === "Accessory" && a.value === "Stardust Crown",
        ),
      );
      assert.ok(!JSON.stringify(json).includes("Pattern"));
      const canonical = await p.locator("#portrait").getAttribute("src");
      await p.click("#toggle-accessory");
      assert.notEqual(
        await p.locator("#portrait").getAttribute("src"),
        canonical,
      );
      assert.equal(await downloaded(p, "#dl-svg"), svg);
      await p.reload();
      await advance(p, 2000);
      assert.equal(
        await p.locator("#final-name").textContent(),
        "W".repeat(30),
      );
      assert.equal(await p.locator("#portrait").getAttribute("src"), canonical);
      assert.equal(await p.locator(`[data-card-id="${id}"]`).count(), 1);
      for (const width of [320, 390, 768, 1440]) {
        await p.setViewportSize({ width, height: 900 });
        assert.equal(
          await p.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          false,
        );
      }
      await p.setViewportSize({ width: 390, height: 844 });
      await p.locator("#result").scrollIntoViewIfNeeded();
      await p.screenshot({ path: out + "/hamster-result.png" });
      await p.click("#again");
      await p.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards
            .length === 2,
      );
      assert.equal(
        await p.evaluate(
          () =>
            JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards.length,
        ),
        2,
      );
      assert.equal(
        await p.evaluate(
          () =>
            JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0].id,
        ),
        id,
      );
      await f.context.close();
    },
  );
  await check(
    "4s polls of unchanged 10s measurements preserve ACTIVE/IDLE incubation, cadence and exact work",
    async () => {
      for (const [width, status] of [[390, "ACTIVE"], [1440, "IDLE"]]) {
        const f = await fixture(width, false, 10000, status),
          p = f.page;
        f.state.workStep = "50";
        await p.click("#get-egg");
        await p.waitForSelector("#start:not([hidden])");
        const id = await p.evaluate(() => JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0].id);
        await p.click("#start");
        for (let second = 0; second < 40; second++) {
          await advance(p, 1000);
          assert.equal(await p.locator("#signal-state").textContent(), "Fresh hardware reading");
          assert.match(await p.locator("#signal-pill").textContent(), status === "IDLE" ? /Resting/ : /Running/);
        }
        await advance(p, 250);
        const progress = await p.evaluate(() => ({
          session: JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0].session,
          baseline: JSON.parse(localStorage.getItem("squeek-signal-baseline-v3")),
        }));
        assert.ok(progress.session.elapsed >= 36 && progress.session.elapsed <= 40.5, `40s play advanced ${progress.session.elapsed}s`);
        assert.equal(progress.session.workDuring, (BigInt(progress.baseline.work) - 1000n).toString());
        assert.equal(progress.session.accessoryId, 10, "the starting accessory stays locked");
        assert.ok(f.state.pollTimes.length >= 10);
        for (let i = 1; i < f.state.pollTimes.length; i++)
          assert.ok(Math.abs(f.state.pollTimes[i] - f.state.pollTimes[i - 1] - 4000) < 250, "unchanged polls never back off");
        await advance(p, 25000);
        await p.waitForSelector("#result:not([hidden])");
        const cards = await p.evaluate(() => JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards);
        assert.equal(cards.length, 1);
        assert.equal(cards[0].id, id);
        assert.equal(cards[0].kind, "hamster");
        assert.equal(cards[0].session.elapsed, 60);
        await f.context.close();
      }
    },
  );
  await check(
    "an unchanged measurement expires at 15s and a genuinely new one waits 3s to recover",
    async () => {
      const f = await fixture(390, false, 10000),
        p = f.page;
      f.state.frozenObserved = f.state.sampleOrigin;
      await p.click("#get-egg");
      await p.waitForSelector("#start:not([hidden])");
      await p.click("#start");
      await advance(p, 14000);
      assert.equal(await p.locator("#signal-state").textContent(), "Fresh hardware reading");
      await advance(p, 2000);
      assert.equal(await p.locator("#signal-pill").textContent(), "Signal unavailable");
      const stopped = await timeLeft(p);
      await advance(p, 10000);
      assert.equal(await timeLeft(p), stopped);
      assert.match(await p.locator("#signal-state").textContent(), /stale/i);
      f.state.frozenObserved = null;
      await p.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await pause(30);
      await advance(p, 2000);
      assert.equal(await p.locator("#signal-state").textContent(), "Fresh hardware reading");
      assert.equal(await timeLeft(p), stopped);
      await advance(p, 2000);
      assert.notEqual(await timeLeft(p), stopped);
      await f.context.close();
    },
  );
  await check(
    "every interruption pauses, retained baseline rejects replay, recovery waits 3s, reload has no offline growth",
    async () => {
      const f = await fixture(),
        p = f.page;
      await p.click("#get-egg");
      await p.click("#start");
      await advance(p, 5000);
      for (const mode of ["network", "stale", "simulated", "fault"]) {
        f.state.mode = mode;
        await advance(p, 10000);
        const t = await timeLeft(p);
        await advance(p, 10000);
        assert.equal(await timeLeft(p), t, mode);
        f.state.mode = "fresh";
        await p.evaluate(() =>
          document.dispatchEvent(new Event("visibilitychange")),
        );
        await pause(30);
        await advance(p, 5000);
        assert.notEqual(await timeLeft(p), t, mode + " recovery");
      }
      // Restart in a fresh context for exact replay and recovery timing, before the previous egg completes.
      await f.context.close();
      const g = await fixture(),
        q = g.page;
      await q.click("#get-egg");
      await q.click("#start");
      await advance(q, 5000);
      g.state.work = "900";
      await advance(q, 10000);
      const stopped = await timeLeft(q);
      await advance(q, 20000);
      assert.equal(await timeLeft(q), stopped);
      g.state.work = "1001";
      await q.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await pause(30);
      await advance(q, 5000);
      assert.notEqual(await timeLeft(q), stopped);
      await q.evaluate(() => {
        globalThis.__qaHidden = true;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      const hiddenLeft = await timeLeft(q);
      await advance(q, 10000);
      assert.equal(await timeLeft(q), hiddenLeft);
      await q.evaluate(() => {
        globalThis.__qaHidden = false;
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await pause(30);
      await advance(q, 2000);
      assert.equal(await timeLeft(q), hiddenLeft);
      await advance(q, 2000);
      assert.notEqual(await timeLeft(q), hiddenLeft);
      const saved = await q.evaluate(
        () =>
          JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0]
            .session.elapsed,
      );
      await q.reload();
      await advance(q, 20000);
      assert.equal(await q.locator("#start").isVisible(), true);
      const restored = await q.evaluate(
        () =>
          JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0]
            .session.elapsed,
      );
      assert.ok(Math.abs(restored - saved) < 1.2);
      await g.context.close();
    },
  );
  await check(
    "two tabs cannot incubate concurrently or create a duplicate egg",
    async () => {
      const f = await fixture(),
        p = f.page;
      await p.click("#get-egg");
      await p.click("#start");
      await advance(p, 2000);
      const second = await f.context.newPage();
      await second.clock.install();
      await second.route("https://api.squeekchain.com/**", async (route) => {
        const now = await second.evaluate(() => Date.now());
        await route.fulfill({
          json: {
            schemaVersion: 1,
            measurement: {
              provenance: "hardware",
              freshness: "online",
              coreStatus: "IDLE",
              rpmMilli: 0,
              distanceMm: 250000,
              cumulativeWorkUnits: "1000",
              counterEpoch: "synthetic-qa",
              observedAt: new Date(now + 1).toISOString(),
              receivedAt: new Date(now).toISOString(),
              staleAfterSeconds: 15,
            },
          },
        });
      });
      await second.goto(origin + "/preview/");
      await advance(second, 4000);
      await second.click("#start");
      await pause(30);
      assert.ok(
        (await second.locator("#app-note").textContent()).includes(
          "another tab",
        ),
      );
      assert.equal(
        await p.evaluate(
          () =>
            JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards.length,
        ),
        1,
      );
      await f.context.close();
    },
  );
  await check(
    "keyboard lamp, all artwork studies and responsive gallery",
    async () => {
      const f = await fixture(),
        p = f.page;
      await p.click("#get-egg");
      await p.focus("#lamp");
      const previous = await p.locator("#lamp").getAttribute("aria-valuenow");
      await p.keyboard.press("ArrowDown");
      assert.notEqual(
        await p.locator("#lamp").getAttribute("aria-valuenow"),
        previous,
      );
      await p.locator(".qa summary").click();
      await p.clock.runFor(50);
      assert.equal(await p.locator("#qa-art figure").count(), 21);
      await p
        .locator(".qa")
        .screenshot({ path: out + "/art-study-mobile.png" });
      await p.setViewportSize({ width: 1440, height: 1000 });
      await p
        .locator(".qa")
        .screenshot({ path: out + "/art-study-desktop.png" });
      await p.screenshot({ path: out + "/desktop.png" });
      await f.context.close();
    },
  );
  await check(
    "history restoration pauses progress and reacquires the incubation lock on resume",
    async () => {
      const f = await fixture(),
        p = f.page;
      await p.click("#get-egg");
      await p.waitForSelector("#start:not([hidden])");
      await p.click('[data-pos="70"]');
      await p.click("#start");
      assert.equal(
        await p.locator("#lamp").getAttribute("aria-valuenow"),
        "70",
      );
      await advance(p, 5000);
      await p.evaluate(() => {
        dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true }));
        dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      });
      await pause(30);
      const saved = await p.evaluate(
        () =>
          JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0]
            .session.elapsed,
      );
      await advance(p, 10000);
      assert.equal(
        await p.evaluate(
          () =>
            JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0]
              .session.elapsed,
        ),
        saved,
      );
      assert.ok(await p.locator("#start").isVisible());
      await p.click("#start");
      await advance(p, 5000);
      const resumed = await p.evaluate(
        () =>
          JSON.parse(localStorage.getItem("squeek-hatchery-v3")).cards[0]
            .session.elapsed,
      );
      assert.ok(resumed > saved);
      assert.equal(
        await p.locator("#lamp").getAttribute("aria-valuenow"),
        "70",
      );
      await f.context.close();
    },
  );
  useContract = true;
  useProof = false;
  await check(
    "configured contract enables real holdings and claim, wallet rejection and wrong-chain states",
    async () => {
      const f = await fixture(390, true),
        p = f.page;
      await connect(f);
      await p.click("#tab-nft");
      await p.waitForFunction(() =>
        document.querySelector("#nft-status").textContent.includes("0 NFTs"),
      );
      await p.waitForFunction(() => !document.querySelector("#claim").disabled);
      assert.ok(await p.locator("#claim").isEnabled());
      assert.ok(
        (await p.locator("#wallet-facts").textContent()).includes(
          c.accounts[2],
        ),
      );
      await p.evaluate(() => __wallet.setChain("0x1"));
      await p.waitForFunction(() =>
        document.querySelector("#wallet-slot").textContent.includes("Switch"),
      );
      assert.ok(await p.locator("#claim").isDisabled());
      await p.click("#wallet-slot button");
      await p.waitForFunction(() =>
        document
          .querySelector("#wallet-slot")
          .textContent.includes("Disconnect"),
      );
      await p.evaluate(() => (__wallet.rejectSend = true));
      await p.click("#claim");
      await p.waitForFunction(() =>
        document.querySelector("#tx-status").textContent.includes("declined"),
      );
      assert.equal(
        await c.pub.readContract({
          address: c.address,
          abi: c.abi,
          functionName: "totalSupply",
        }),
        0n,
      );
      await p.evaluate(() => (__wallet.rejectSend = false));
      await p.waitForFunction(() => !document.querySelector("#claim").disabled);
      await p.click("#claim");
      await p.waitForFunction(
        () =>
          document
            .querySelector("#tx-status")
            .textContent.includes("Egg claimed"),
        { timeout: 20000 },
      );
      await p.waitForFunction(() =>
        document.querySelector("#nft-status").textContent.includes("1 NFT"),
      );
      await p
        .locator("#nft-holdings button")
        .filter({ hasText: "Select egg" })
        .click();
      await p.waitForFunction(() =>
        document
          .querySelector("#hatch-reason")
          .textContent.includes("proof service"),
      );
      assert.ok(await p.locator("#start").isEnabled());
      assert.ok(await p.locator("#nft-hatch").isDisabled());
      rpcBroken = true;
      await p.click("#refresh-nft");
      await p.waitForFunction(() =>
        document
          .querySelector("#nft-status")
          .textContent.includes("unavailable"),
      );
      rpcBroken = false;
      await p.click("#tab-demo");
      await p.click("#get-egg");
      await p.waitForSelector("#collection .saved");
      assert.ok((await p.locator("#collection .saved").count()) === 1);
      await f.context.close();
    },
  );
  useProof = true;
  await check(
    "complete NFT egg incubation, verifier failure/retry, frozen pending name and receipt/export parity",
    async () => {
      const f = await fixture(1440, true),
        p = f.page;
      await connect(f);
      await p.click("#tab-nft");
      await p.waitForSelector("#nft-holdings button");
      await p
        .locator("#nft-holdings button")
        .filter({ hasText: "Select egg" })
        .click();
      await p.click("#start");
      await advance(p, 66000);
      await p.waitForSelector("#result:not([hidden])");
      await p.fill("#name", "NFT Pip");
      await p.click("#review");
      await p.waitForFunction(
        () => !document.querySelector("#hatch-submit").disabled,
      );
      proofBad = true;
      await p.click("#hatch-submit");
      await p.waitForFunction(
        () => !document.querySelector("#rename").disabled,
      );
      assert.equal(
        await c.pub.readContract({
          address: c.address,
          abi: c.abi,
          functionName: "isHatched",
          args: [1n],
        }),
        false,
      );
      proofBad = false;
      await p.waitForFunction(
        () => !document.querySelector("#hatch-submit").disabled,
      );
      await p.evaluate(() => (__wallet.holdSend = true));
      await p.click("#hatch-submit");
      await p.waitForFunction(() =>
        document
          .querySelector("#tx-status")
          .textContent.includes("Confirm in your wallet"),
      );
      assert.ok(await p.locator("#rename").isDisabled());
      assert.ok(await p.locator("#name").isDisabled());
      assert.ok(await p.locator("#tab-demo").isDisabled());
      holdReceipts = true;
      await p.evaluate(() => __releaseSend());
      await p.waitForFunction(() =>
        document
          .querySelector("#tx-status")
          .textContent.includes("Waiting for a receipt"),
      );
      assert.ok(
        !(await p.locator("#tx-status").textContent()).includes("confirmed"),
      );
      holdReceipts = false;
      await advance(p, 6000); // Drive the normal receipt polling timers under the virtual clock.
      await p.waitForFunction(
        () =>
          document
            .querySelector("#tx-status")
            .textContent.includes("Hamster confirmed"),
        { timeout: 30000 },
      );
      assert.ok(await p.locator("#rename").isHidden());
      const json = JSON.parse(await downloaded(p, "#dl-json")),
        svg = await downloaded(p, "#dl-svg"),
        uri = await c.pub.readContract({
          address: c.address,
          abi: c.abi,
          functionName: "tokenURI",
          args: [1n],
        });
      assert.deepEqual(JSON.parse(atob(uri.split(",")[1])), json);
      assert.equal(atob(json.image.split(",")[1]), svg);
      assert.equal(json.name, "NFT Pip");
      assert.equal(
        await c.pub.readContract({
          address: c.address,
          abi: c.abi,
          functionName: "totalSupply",
        }),
        1n,
      );
      assert.equal(
        await c.pub.readContract({
          address: c.address,
          abi: c.abi,
          functionName: "isHatched",
          args: [1n],
        }),
        true,
      );
      assert.ok(proofRequests >= 2);
      await p.screenshot({ path: out + "/nft-confirmed.png" });
      await f.context.close();
    },
  );
  await check(
    "wallet/account change pauses NFT sessions; disconnected demo survives RPC failure",
    async () => {
      const f = await fixture(390, true),
        p = f.page;
      await connect(f);
      await p.click("#tab-nft");
      await p.evaluate((a) => __wallet.setAccount(a), c.accounts[3]);
      await p.waitForFunction(
        () => document.querySelector("#claim").disabled === false,
      );
      await p.click("#claim");
      await p.waitForFunction(
        () =>
          document
            .querySelector("#tx-status")
            .textContent.includes("Egg claimed"),
        { timeout: 20000 },
      );
      await p.waitForSelector("#nft-holdings button");
      await p
        .locator("#nft-holdings button")
        .filter({ hasText: "Select egg" })
        .click();
      await p.click("#start");
      await advance(p, 4000);
      await p.evaluate((a) => __wallet.setAccount(a), c.accounts[4]);
      await pause(100);
      assert.ok(
        (await p.locator("#app-note").textContent()).includes("Wallet changed"),
      );
      assert.ok(await p.locator("#demo-layout").isHidden());
      await p.click("#tab-demo");
      rpcBroken = true;
      await hatch(f, "Demo survives");
      assert.equal(
        await p.locator("#final-name").textContent(),
        "Demo survives",
      );
      rpcBroken = false;
      await f.context.close();
    },
  );
  await check(
    "ownership transfer during incubation preserves draft and releases mode lock",
    async () => {
      const transfer = await c.wallet(c.accounts[3]).writeContract({
        address: c.address,
        abi: c.abi,
        functionName: "transferFrom",
        args: [c.accounts[3], c.accounts[2], 2n],
      });
      await c.pub.waitForTransactionReceipt({ hash: transfer });
      const f = await fixture(390, true),
        p = f.page;
      await connect(f);
      await p.click("#tab-nft");
      await p.waitForSelector("#nft-holdings button");
      await p
        .locator("#nft-holdings button")
        .filter({ hasText: "Select egg" })
        .click();
      await p.click("#start");
      await advance(p, 4000);
      const away = await c.wallet(c.accounts[2]).writeContract({
        address: c.address,
        abi: c.abi,
        functionName: "transferFrom",
        args: [c.accounts[2], c.accounts[4], 2n],
      });
      await c.pub.waitForTransactionReceipt({ hash: away });
      await advance(p, 7000);
      await p.waitForFunction(() =>
        document
          .querySelector("#app-note")
          .textContent.includes("no longer own"),
      );
      assert.ok(await p.locator("#start").isVisible());
      assert.ok(await p.locator("#start").isDisabled());
      await p.click("#tab-demo");
      assert.ok(await p.locator("#get-egg").isVisible());
      await f.context.close();
    },
  );
  await check(
    "an RPC on the wrong chain never supplies labeled Sepolia holdings",
    async () => {
      rpcWrongChain = true;
      const f = await fixture(390, true),
        p = f.page;
      await connect(f);
      await p.click("#tab-nft");
      await p.waitForFunction(() =>
        document
          .querySelector("#nft-status")
          .textContent.includes("Configured RPC is not Sepolia"),
      );
      assert.ok(await p.locator("#claim").isDisabled());
      assert.ok(
        !(await p.locator("#nft-status").textContent()).includes("0 NFTs"),
      );
      rpcWrongChain = false;
      await p.click("#refresh-nft");
      await p.waitForSelector("#nft-holdings button");
      await f.context.close();
    },
  );
  try {
    const safari = await webkit.launch();
    await safari.close();
    results.push({ name: "WebKit runtime", passed: true });
  } catch (e) {
    results.push({
      name: "WebKit runtime",
      passed: null,
      limitation: e.message.slice(0, 500),
    });
  }
  assert.equal(errors.length, 0, errors.join("\n"));
  assert.equal(localMissing.length, 0, localMissing.join("\n"));
} finally {
  await fs.writeFile(
    out + "/results.json",
    JSON.stringify({ results, errors, localMissing }, null, 2),
  );
  await browser.close();
  await new Promise((r) => server.close(r));
  c.stop();
}
console.log(JSON.stringify(results, null, 2));
