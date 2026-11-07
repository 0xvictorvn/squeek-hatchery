/**
 * Native lamp input probe for the host to run after copying into the built app:
 *   node --experimental-strip-types tests/lamp-browser.probe.mjs <absolute-output-dir>
 *
 * Local RAM backend and synthetic hardware only. Screenshots and the JSON report
 * go to the given directory, or to an OS temp directory when no directory is given.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHatcheryHttpServer } from "../src/server.ts";
import { measurementDayKey } from "../src/rules.ts";

const SCENE_W = 480;
const SCENE_H = 420;
const RAIL_X = 416;
const STAGE_CY = 215;
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const FAMILIES = [
  { id: "species-btn-pulse", name: "pulse" },
  { id: "species-btn-relay", name: "relay" },
  { id: "species-btn-prism", name: "prism" },
];
const VIEWPORTS = [
  { name: "desktop", width: 1422, height: 920, mobile: false },
  { name: "mobile", width: 390, height: 844, mobile: true },
];

function findBrowserExecutable() {
  for (const candidate of CHROME_PATHS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function aimFromSceneY(sceneY) {
  const raw = Math.max(-100, Math.min(100, sceneY - STAGE_CY));
  const tenth = Math.round(raw * 10) / 10;
  return Math.max(-100, Math.min(100, Math.round(tenth)));
}

function clientFromScene(stage, sceneX, sceneY) {
  return {
    x: stage.wrap.left + (sceneX / SCENE_W) * stage.wrap.width,
    y: stage.wrap.top + (sceneY / SCENE_H) * stage.wrap.height,
  };
}

class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.pageErrors = [];
    this.consoleErrors = [];
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
      }
    });
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
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Evaluation failed",
      );
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

async function openPage(cdpPort, url) {
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
  await session.send("Page.navigate", { url });
  return { session, targetId: target.id };
}

async function waitFor(session, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await session.eval(`Boolean(${predicate})`).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${predicate}`);
}

async function mouse(session, type, x, y, buttons) {
  await session.send("Input.dispatchMouseEvent", {
    type,
    x,
    y,
    button: type === "mouseMoved" && buttons === 0 ? "none" : "left",
    buttons,
    clickCount: type === "mouseMoved" ? 0 : 1,
    pointerType: "mouse",
  });
}

async function pressAt(session, x, y) {
  await mouse(session, "mouseMoved", x, y, 0);
  await mouse(session, "mousePressed", x, y, 1);
}

async function click(session, x, y) {
  await mouse(session, "mouseMoved", x, y, 0);
  await mouse(session, "mousePressed", x, y, 1);
  await mouse(session, "mouseReleased", x, y, 0);
}

async function keyTap(session, keyName, code, vk, modifiers = 0) {
  if (modifiers & 8) {
    await session.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers: 8,
    });
  }
  const event = {
    key: keyName,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers,
  };
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...event });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  if (modifiers & 8) {
    await session.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Shift",
      code: "ShiftLeft",
      windowsVirtualKeyCode: 16,
      nativeVirtualKeyCode: 16,
      modifiers: 0,
    });
  }
}

async function readStage(session) {
  return session.eval(`(() => {
    const wrap = document.getElementById("stage-canvas-wrap");
    const handle = document.getElementById("lamp-handle-elem");
    const hit = document.getElementById("rail-hit");
    const svg = document.getElementById("stage-svg");
    const fx = document.getElementById("led-scene-fx");
    const box = (el) => {
      const rect = el.getBoundingClientRect();
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    return {
      aim: Number(handle.getAttribute("aria-valuenow")),
      slider: Number(document.getElementById("lamp").value),
      hidden: Boolean(handle.hidden),
      focused: document.activeElement ? document.activeElement.id : "",
      viewBox: svg.getAttribute("viewBox"),
      canvasW: fx.width,
      canvasH: fx.height,
      wrap: box(wrap),
      handle: box(handle),
      hit: box(hit),
    };
  })()`);
}

async function shot(session, file) {
  const result = await session.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
}

async function resetProbeEvents(session) {
  await session.eval(`window.__lampProbeEvents = []`);
}

async function heldCaptures(session) {
  return session.eval(`(() => {
    const handle = document.getElementById("lamp-handle-elem");
    const hit = document.getElementById("rail-hit");
    const ids = [...new Set((window.__lampProbeEvents || []).map((event) => event.pointerId))]
      .filter((id) => Number.isInteger(id));
    return ids.filter((id) => {
      try {
        return handle.hasPointerCapture(id) || hit.hasPointerCapture(id);
      } catch {
        return false;
      }
    });
  })()`);
}

async function readProbeEvents(session) {
  const events = await session.eval(`(window.__lampProbeEvents || []).slice()`);
  return Array.isArray(events) ? events.slice(-40) : [];
}

async function describePoint(session, x, y) {
  const px = Number(x);
  const py = Number(y);
  return session.eval(`(() => {
    const x = ${px};
    const y = ${py};
    const el = document.elementFromPoint(x, y);
    const wrap = document.getElementById("stage-canvas-wrap");
    const rect = wrap.getBoundingClientRect();
    return {
      x,
      y,
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      target: el ? {
        id: el.id || "",
        tag: el.tagName,
        className: String(el.className || "").slice(0, 120),
      } : null,
      wrap: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    };
  })()`);
}

async function cancelTouch(session) {
  await session.send("Input.dispatchTouchEvent", { type: "touchCancel", touchPoints: [] });
}

async function finishGesture(session, x, y) {
  const point = { x: Number.isFinite(x) ? x : 1, y: Number.isFinite(y) ? y : 1 };
  let touchCancelError = "";
  try {
    await cancelTouch(session);
  } catch (error) {
    touchCancelError = error instanceof Error ? error.message : String(error);
  }
  try {
    await mouse(session, "mouseReleased", point.x, point.y, 0);
  } catch {
    // The pointer may already be up. A later buttons-0 move still checks cleanup.
  }
  try {
    await mouse(session, "mouseMoved", point.x, point.y, 0);
  } catch {
    // Input dispatch can fail while the viewport is closing.
  }
  try {
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  } catch {
    // Touch emulation may never have been enabled.
  }
  return touchCancelError;
}

function freshReading() {
  const nowMs = Date.now();
  return {
    reading: {
      coreStatus: "ACTIVE",
      rpm: 40,
      meters: 1,
      distanceMm: 1000,
      work: 10n,
      counterEpoch: "lamp-probe-epoch",
      installationId: "lamp-probe-wheel",
      observedAt: nowMs,
      received: nowMs,
      staleAfterSeconds: 60,
      utcDate: measurementDayKey(nowMs),
    },
    source: "live",
  };
}

async function main() {
  const outputDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : fs.mkdtempSync(path.join(os.tmpdir(), "lamp-probe-out-"));
  fs.mkdirSync(outputDir, { recursive: true });
  const cases = [];
  const screenshots = [];
  const record = (id, status, detail, extra = {}) => {
    cases.push({ id, status, detail, ...extra });
  };
  const expectAim = async (session, id, expected, extra = {}) => {
    const stage = await readStage(session);
    const ok = stage.aim === expected && stage.slider === expected;
    record(id, ok ? "pass" : "fail", `aim ${stage.aim} slider ${stage.slider}, expected ${expected}`, {
      aim: stage.aim,
      slider: stage.slider,
      expected,
      ...extra,
    });
    return stage;
  };

  const exe = findBrowserExecutable();
  const reportPath = path.join(outputDir, "lamp-browser-probe.json");
  if (!exe) {
    fs.writeFileSync(
      reportPath,
      JSON.stringify({ ok: false, error: "No installed Chrome or Edge executable found", cases }, null, 2),
    );
    return 1;
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lamp-probe-chrome-"));
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
    if (!address || typeof address === "string") throw new Error("Server did not bind a TCP port");
    browser = await launchBrowser(exe, userDataDir);
    cdpPort = browser.port;
    const opened = await openPage(cdpPort, `http://127.0.0.1:${address.port}/#play`);
    session = opened.session;
    targetId = opened.targetId;
    await waitFor(session, "window.__squeekAppMounted === true");
    await waitFor(session, "document.getElementById('lamp-handle-elem') !== null");
    await session.eval(`(() => {
      window.__lampProbeEvents = [];
      for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
        window.addEventListener(type, (event) => {
          const target = event.target;
          window.__lampProbeEvents.push({
            type: event.type,
            buttons: event.buttons,
            pointerType: event.pointerType,
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            target: target && target.id ? target.id : target ? String(target.className || target.tagName || "").slice(0, 80) : "",
          });
        }, true);
      }
    })()`);

    for (const viewport of VIEWPORTS) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.mobile,
      });
      await session.eval(
        `document.getElementById("stage-canvas-wrap").scrollIntoView({ block: "center", inline: "nearest" })`,
      );
      await session.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      const parked = await readStage(session);
      await finishGesture(
        session,
        (parked.handle.left + parked.handle.right) / 2,
        (parked.handle.top + parked.handle.bottom) / 2,
      );

      for (const family of FAMILIES) {
        await session.eval(
          `document.getElementById(${JSON.stringify(family.id)}).scrollIntoView({ block: "center", inline: "nearest" })`,
        );
        await session.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const button = await session.eval(`(() => {
          const rect = document.getElementById(${JSON.stringify(family.id)}).getBoundingClientRect();
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        await click(session, button.x, button.y);
        const selected = await session.eval(
          `document.getElementById(${JSON.stringify(family.id)}).getAttribute("aria-checked") === "true"`,
        );
        await session.eval(
          `document.getElementById("stage-canvas-wrap").scrollIntoView({ block: "center", inline: "nearest" })`,
        );
        await session.eval(`new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        const stage = await readStage(session);
        const center = {
          x: (stage.handle.left + stage.handle.right) / 2,
          y: (stage.handle.top + stage.handle.bottom) / 2,
        };
        const handleInside =
          stage.handle.width >= 42 &&
          stage.handle.height >= 42 &&
          stage.handle.left >= stage.wrap.left - 1 &&
          stage.handle.right <= stage.wrap.right + 1 &&
          stage.handle.top >= stage.wrap.top - 1 &&
          stage.handle.bottom <= stage.wrap.bottom + 1;
        const hitCovers =
          center.x >= stage.hit.left - 1 &&
          center.x <= stage.hit.right + 1 &&
          center.y >= stage.hit.top - 1 &&
          center.y <= stage.hit.bottom + 1;
        const sceneX = ((center.x - stage.wrap.left) / stage.wrap.width) * SCENE_W;
        const sceneY = ((center.y - stage.wrap.top) / stage.wrap.height) * SCENE_H;
        const mapped =
          Math.abs(sceneX - RAIL_X) < 4 && Math.abs(sceneY - (STAGE_CY + stage.aim)) < 4;
        const shared =
          stage.viewBox === `0 0 ${SCENE_W} ${SCENE_H}` &&
          stage.canvasW === SCENE_W &&
          stage.canvasH === SCENE_H &&
          stage.hidden === false &&
          stage.wrap.width > 80;
        record(
          `${viewport.name}-layout-${family.name}`,
          selected && handleInside && hitCovers && mapped && shared ? "pass" : "fail",
          `selected ${selected} handleInside ${handleInside} hitCovers ${hitCovers} mapped ${mapped} shared ${shared}`,
          {
            aim: stage.aim,
            sceneX,
            sceneY,
            viewBox: stage.viewBox,
            canvas: [stage.canvasW, stage.canvasH],
            handle: stage.handle,
            wrap: stage.wrap,
          },
        );
      }

      const layoutShot = path.join(outputDir, `${viewport.name}-layout.png`);
      await shot(session, layoutShot);
      screenshots.push(layoutShot);

      let stage = await readStage(session);
      const center = clientFromScene(stage, RAIL_X, STAGE_CY);
      await resetProbeEvents(session);
      await click(session, center.x, center.y);
      await expectAim(session, `${viewport.name}-rail-center`, 0);

      stage = await readStage(session);
      const above = clientFromScene(stage, RAIL_X, STAGE_CY - 100);
      const aboveHandle = above.y < (stage.handle.top + stage.handle.bottom) / 2;
      await click(session, above.x, above.y);
      await expectAim(session, `${viewport.name}-rail-above`, -100);
      record(
        `${viewport.name}-rail-above-is-above-handle`,
        aboveHandle ? "pass" : "fail",
        `click y ${above.y} handle center ${(stage.handle.top + stage.handle.bottom) / 2}`,
      );
      const highShot = path.join(outputDir, `${viewport.name}-aim-high.png`);
      await shot(session, highShot);
      screenshots.push(highShot);

      stage = await readStage(session);
      const below = clientFromScene(stage, RAIL_X, STAGE_CY + 100);
      const belowHandle = below.y > (stage.handle.top + stage.handle.bottom) / 2;
      await click(session, below.x, below.y);
      await expectAim(session, `${viewport.name}-rail-below`, 100);
      record(
        `${viewport.name}-rail-below-is-below-handle`,
        belowHandle ? "pass" : "fail",
        `click y ${below.y} handle center ${(stage.handle.top + stage.handle.bottom) / 2}`,
      );
      const lowShot = path.join(outputDir, `${viewport.name}-aim-low.png`);
      await shot(session, lowShot);
      screenshots.push(lowShot);

      stage = await readStage(session);
      const railX = clientFromScene(stage, RAIL_X, STAGE_CY).x;
      const handle = {
        x: (stage.handle.left + stage.handle.right) / 2,
        y: (stage.handle.top + stage.handle.bottom) / 2,
      };
      const aboveOutside = { x: railX, y: stage.wrap.top - 24 };
      await resetProbeEvents(session);
      await pressAt(session, handle.x, handle.y);
      await mouse(session, "mouseMoved", aboveOutside.x, aboveOutside.y, 1);
      await mouse(session, "mouseReleased", aboveOutside.x, aboveOutside.y, 0);
      await expectAim(session, `${viewport.name}-handle-release-above`, -100);
      const capturesHigh = await heldCaptures(session);
      const parkedHigh = (await readStage(session)).aim;
      await mouse(session, "mouseMoved", below.x, below.y, 0);
      const afterHigh = (await readStage(session)).aim;
      record(
        `${viewport.name}-drag-cleanup-after-high`,
        afterHigh === parkedHigh && capturesHigh.length === 0 ? "pass" : "fail",
        `unpressed move aim ${afterHigh}, released aim ${parkedHigh}, captures ${capturesHigh.length}`,
        { release: aboveOutside, outside: aboveOutside.y < stage.wrap.top, captures: capturesHigh },
      );

      stage = await readStage(session);
      const handleNow = {
        x: (stage.handle.left + stage.handle.right) / 2,
        y: (stage.handle.top + stage.handle.bottom) / 2,
      };
      const belowOutside = { x: railX, y: stage.wrap.bottom + 24 };
      await resetProbeEvents(session);
      await pressAt(session, handleNow.x, handleNow.y);
      await mouse(session, "mouseMoved", belowOutside.x, belowOutside.y, 1);
      await mouse(session, "mouseReleased", belowOutside.x, belowOutside.y, 0);
      await expectAim(session, `${viewport.name}-handle-release-below`, 100);
      const capturesLow = await heldCaptures(session);
      const parkedLow = (await readStage(session)).aim;
      await mouse(session, "mouseMoved", above.x, above.y, 0);
      const afterLow = (await readStage(session)).aim;
      record(
        `${viewport.name}-drag-cleanup-after-low`,
        afterLow === parkedLow && capturesLow.length === 0 ? "pass" : "fail",
        `unpressed move aim ${afterLow}, released aim ${parkedLow}, captures ${capturesLow.length}`,
        { release: belowOutside, outside: belowOutside.y > stage.wrap.bottom, captures: capturesLow },
      );

      stage = await readStage(session);
      const stageStart = clientFromScene(stage, 200, STAGE_CY);
      const stageMid = clientFromScene(stage, 200, STAGE_CY - 40);
      const stageExpected = aimFromSceneY(STAGE_CY - 40);
      await resetProbeEvents(session);
      const stagePressHit = await describePoint(session, stageStart.x, stageStart.y);
      await pressAt(session, stageStart.x, stageStart.y);
      await mouse(session, "mouseMoved", stageMid.x, stageMid.y, 1);
      await mouse(session, "mouseReleased", stageMid.x, stageMid.y, 0);
      const stageDragEvents = await readProbeEvents(session);
      const stageDragNow = await readStage(session);
      await expectAim(session, `${viewport.name}-stage-drag`, stageExpected, {
        press: stageStart,
        move: stageMid,
        pressHit: stagePressHit,
        wrap: stageDragNow.wrap,
        scrollX: stagePressHit.scrollX,
        scrollY: stagePressHit.scrollY,
        events: stageDragEvents,
      });
      const stageOutside = { x: stageStart.x, y: stage.wrap.bottom + 40 };
      await resetProbeEvents(session);
      const outsidePressHit = await describePoint(session, stageMid.x, stageMid.y);
      await pressAt(session, stageMid.x, stageMid.y);
      await mouse(session, "mouseMoved", stageOutside.x, stageOutside.y, 1);
      await mouse(session, "mouseReleased", stageOutside.x, stageOutside.y, 0);
      const outsideEvents = await readProbeEvents(session);
      const outsideNow = await readStage(session);
      await expectAim(session, `${viewport.name}-stage-release-outside`, 100, {
        press: stageMid,
        release: stageOutside,
        outside: stageOutside.y > stage.wrap.bottom,
        pressHit: outsidePressHit,
        wrap: outsideNow.wrap,
        scrollX: outsidePressHit.scrollX,
        scrollY: outsidePressHit.scrollY,
        events: outsideEvents,
      });
      const parkedStage = (await readStage(session)).aim;
      await mouse(session, "mouseMoved", stageStart.x, stageStart.y, 0);
      const afterStage = (await readStage(session)).aim;
      record(
        `${viewport.name}-stage-drag-cleanup`,
        afterStage === parkedStage ? "pass" : "fail",
        `unpressed stage move aim ${afterStage}, released aim ${parkedStage}`,
        { release: stageOutside, outside: stageOutside.y > stage.wrap.bottom, aim: afterStage },
      );

      stage = await readStage(session);
      const touchFrom = clientFromScene(stage, 200, STAGE_CY + stage.aim);
      const touchTo = clientFromScene(stage, 200, STAGE_CY + 20);
      let touchCancelError = "";
      try {
        await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
        await resetProbeEvents(session);
        const beforeTouch = (await readStage(session)).aim;
        const touchStartHit = await describePoint(session, touchFrom.x, touchFrom.y);
        await session.send("Input.dispatchTouchEvent", {
          type: "touchStart",
          touchPoints: [{ x: touchFrom.x, y: touchFrom.y, id: 1 }],
        });
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: touchTo.x, y: touchTo.y, id: 1 }],
        });
        const during = (await readStage(session)).aim;
        try {
          await cancelTouch(session);
        } catch (error) {
          touchCancelError = error instanceof Error ? error.message : String(error);
        }
        const events = await readProbeEvents(session);
        const cancelSeen = events.some((event) => event.type === "pointercancel");
        const held = (await readStage(session)).aim;
        await mouse(session, "mouseMoved", touchFrom.x, touchFrom.y, 0);
        const after = (await readStage(session)).aim;
        const touchMoved = during !== beforeTouch;
        const detailBase = {
          beforeTouch,
          during,
          held,
          after,
          touchFrom,
          touchTo,
          touchStartHit,
          events,
          touchCancelError,
        };
        const continued = after !== held;
        const heldLastDrag = held === during;
        if (touchCancelError || !cancelSeen || !touchMoved) {
          record(
            `${viewport.name}-touch-cancel`,
            "unsupported",
            touchCancelError
              ? `valid empty touchCancel was rejected: ${touchCancelError}. Not counted as native cancel evidence.`
              : !cancelSeen
                ? `empty touchCancel was accepted but no pointercancel was observed (${beforeTouch} -> ${during} -> ${held}). Not counted as native cancel evidence.`
                : `pointercancel was observed but the touch did not change the aim (${beforeTouch} -> ${during}). Drag path was not exercised.`,
            detailBase,
          );
          if (continued && (touchMoved || cancelSeen)) {
            record(
              `${viewport.name}-touch-cancel-stuck-drag`,
              "fail",
              `unpressed move kept dragging after touch cancel (${held} -> ${after})`,
              { held, after, touchCancelError },
            );
          }
        } else if (!heldLastDrag) {
          record(
            `${viewport.name}-touch-cancel`,
            "fail",
            `pointercancel committed ${held} instead of the last drag aim ${during}`,
            detailBase,
          );
        } else if (continued) {
          record(
            `${viewport.name}-touch-cancel`,
            "fail",
            `pointercancel held the last drag aim ${held} but unpressed move changed it to ${after}`,
            detailBase,
          );
        } else {
          record(
            `${viewport.name}-touch-cancel`,
            "pass",
            `pointercancel held the last drag aim ${during}; unpressed move stayed ${after}`,
            detailBase,
          );
        }
      } catch (error) {
        record(
          `${viewport.name}-touch-cancel`,
          "unsupported",
          `native touch dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        await finishGesture(session, touchTo.x, touchTo.y);
      }

      stage = await readStage(session);
      const focusAt = clientFromScene(stage, RAIL_X, STAGE_CY);
      await click(session, focusAt.x, focusAt.y);
      const origin = await expectAim(session, `${viewport.name}-key-origin`, 0);
      if (origin.focused !== "lamp-handle-elem") {
        const handleFocus = {
          x: (origin.handle.left + origin.handle.right) / 2,
          y: (origin.handle.top + origin.handle.bottom) / 2,
        };
        await click(session, handleFocus.x, handleFocus.y);
      }
      const focused = (await readStage(session)).focused;
      record(
        `${viewport.name}-key-focus`,
        focused === "lamp-handle-elem" ? "pass" : "fail",
        `active element ${focused || "(none)"}`,
      );
      const keys = [
        { key: "ArrowUp", code: "ArrowUp", vk: 38, modifiers: 0, expected: -5 },
        { key: "ArrowDown", code: "ArrowDown", vk: 40, modifiers: 0, expected: 0 },
        { key: "ArrowLeft", code: "ArrowLeft", vk: 37, modifiers: 0, expected: -5 },
        { key: "ArrowRight", code: "ArrowRight", vk: 39, modifiers: 0, expected: 0 },
        { key: "ArrowDown", code: "ArrowDown", vk: 40, modifiers: 8, expected: 20 },
        { key: "ArrowUp", code: "ArrowUp", vk: 38, modifiers: 8, expected: 0 },
        { key: "PageDown", code: "PageDown", vk: 34, modifiers: 0, expected: 25 },
        { key: "PageUp", code: "PageUp", vk: 33, modifiers: 0, expected: 0 },
        { key: "Home", code: "Home", vk: 36, modifiers: 0, expected: -100 },
        { key: "End", code: "End", vk: 35, modifiers: 0, expected: 100 },
      ];
      for (const step of keys) {
        await keyTap(session, step.key, step.code, step.vk, step.modifiers);
        const label = step.modifiers === 8 ? `shift-${step.key}` : step.key;
        await expectAim(session, `${viewport.name}-key-${label}`, step.expected);
      }
      const keyShot = path.join(outputDir, `${viewport.name}-after-keys.png`);
      await shot(session, keyShot);
      screenshots.push(keyShot);
    }

    try {
      const synthetic = await session.eval(`(() => {
        const sceneW = ${SCENE_W};
        const sceneH = ${SCENE_H};
        const stageCy = ${STAGE_CY};
        const railX = ${RAIL_X};
        const wrap = document.getElementById("stage-canvas-wrap");
        const rail = document.getElementById("rail-hit");
        const rect = wrap.getBoundingClientRect();
        const clientX = (sceneX) => rect.left + (sceneX / sceneW) * rect.width;
        const clientY = (aim) => rect.top + ((stageCy + aim) / sceneH) * rect.height;
        const readAim = () => Number(document.getElementById("lamp-handle-elem").getAttribute("aria-valuenow"));
        const fire = (target, type, x, y, pointerId, buttons) => {
          target.dispatchEvent(new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: "mouse",
            clientX: x,
            clientY: y,
            button: buttons ? 0 : -1,
            buttons,
          }));
        };
        const zeroCancel = (target, type, pointerId) => fire(target, type, 0, 0, pointerId, 0);
        fire(wrap, "pointerdown", clientX(200), clientY(20), 81, 1);
        fire(window, "pointermove", clientX(200), clientY(-40), 81, 1);
        const stageMoved = readAim();
        zeroCancel(window, "pointercancel", 81);
        const stageAfterCancel = readAim();
        fire(window, "pointermove", clientX(200), clientY(90), 81, 0);
        const stageAfterUnpressed = readAim();
        fire(rail, "pointerdown", clientX(railX), clientY(25), 82, 1);
        fire(rail, "pointermove", clientX(railX), clientY(60), 82, 1);
        const railMoved = readAim();
        zeroCancel(rail, "pointercancel", 82);
        const railAfterCancel = readAim();
        fire(rail, "pointermove", clientX(railX), clientY(-80), 82, 0);
        const railAfterUnpressed = readAim();
        fire(rail, "pointerdown", clientX(railX), clientY(10), 83, 1);
        fire(rail, "pointermove", clientX(railX), clientY(-15), 83, 1);
        const lostMoved = readAim();
        zeroCancel(rail, "lostpointercapture", 83);
        const lostAfter = readAim();
        fire(rail, "pointermove", clientX(railX), clientY(70), 83, 0);
        const lostAfterUnpressed = readAim();
        return {
          stageMoved,
          stageAfterCancel,
          stageAfterUnpressed,
          railMoved,
          railAfterCancel,
          railAfterUnpressed,
          lostMoved,
          lostAfter,
          lostAfterUnpressed,
        };
      })()`);
      const stageOk = synthetic.stageMoved === -40
        && synthetic.stageAfterCancel === synthetic.stageMoved
        && synthetic.stageAfterUnpressed === synthetic.stageMoved;
      record(
        "synthetic-stage-cancel-zero",
        stageOk ? "pass" : "fail",
        `synthetic DOM pointercancel at 0,0 kept ${synthetic.stageAfterCancel} after move ${synthetic.stageMoved}; unpressed ${synthetic.stageAfterUnpressed}. Not native input.`,
        { ...synthetic, kind: "synthetic-dom" },
      );
      const railOk = synthetic.railMoved === 60
        && synthetic.railAfterCancel === synthetic.railMoved
        && synthetic.railAfterUnpressed === synthetic.railMoved;
      record(
        "synthetic-rail-cancel-zero",
        railOk ? "pass" : "fail",
        `synthetic DOM pointercancel at 0,0 kept ${synthetic.railAfterCancel} after move ${synthetic.railMoved}; unpressed ${synthetic.railAfterUnpressed}. Not native input.`,
        { kind: "synthetic-dom" },
      );
      const lostOk = synthetic.lostMoved === -15
        && synthetic.lostAfter === synthetic.lostMoved
        && synthetic.lostAfterUnpressed === synthetic.lostMoved;
      record(
        "synthetic-rail-lostcapture-zero",
        lostOk ? "pass" : "fail",
        `synthetic DOM lostpointercapture at 0,0 kept ${synthetic.lostAfter} after move ${synthetic.lostMoved}; unpressed ${synthetic.lostAfterUnpressed}. Not native input.`,
        { kind: "synthetic-dom" },
      );
    } catch (error) {
      record(
        "synthetic-cancel-zero",
        "fail",
        `synthetic DOM cancellation dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
        { kind: "synthetic-dom" },
      );
    }

    const consoleErrors = [...session.consoleErrors, ...session.pageErrors];
    record(
      "console",
      consoleErrors.length === 0 ? "pass" : "fail",
      consoleErrors.length === 0 ? "no page exceptions or console.error" : consoleErrors.slice(0, 8).join(" | "),
      { count: consoleErrors.length },
    );
    const failed = cases.filter((item) => item.status === "fail");
    const report = {
      ok: failed.length === 0,
      chrome: exe,
      outputDir,
      screenshots,
      cases,
      consoleErrors,
      notClaimed: [
        "synthetic-stage-cancel-zero, synthetic-rail-cancel-zero, and synthetic-rail-lostcapture-zero are DOM PointerEvent dispatch, not native input",
        "unsupported touch-cancel is not native pointercancel evidence",
        "portrait _drawCore counting is not instrumented here",
        "1600 export, auth, and cache were not exercised",
      ],
    };
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          ok: false,
          chrome: exe,
          outputDir,
          error: message,
          screenshots,
          cases,
          consoleErrors: session ? [...session.consoleErrors, ...session.pageErrors] : [],
        },
        null,
        2,
      ),
    );
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
    await new Promise((resolve) => setTimeout(resolve, 200));
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
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
