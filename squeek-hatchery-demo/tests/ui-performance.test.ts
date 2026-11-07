import assert from "node:assert/strict";
import fs from "node:fs";
import test, { describe } from "node:test";
import {
  computeLampMountLayout,
  forEachSceneLed,
  interiorVisibleAt,
  pointInFamilyEgg,
  sampleLedBeamDots,
  shellDotVisibleAt,
} from "../src/led-scene.ts";
import { regionAt } from "../src/rules.ts";
import {
  createScheduledPreviewGallery,
  leaderboardResponseIsCurrent,
  planLeaderboardPortraits,
  portraitVisualKey,
  shouldDrawPortrait,
  shouldResumeAccessoryAnimation,
  stableControlActions,
  syncStableControlHost,
  type StableControlHost,
  type StableControlSpec,
} from "../src/ui-render-cache.ts";

const basePortrait = {
  family: 0,
  levels: [1, 2, 3] as [number, number, number],
  palette: 4,
  accessory: -1,
  background: -1,
};

function key(overrides: Partial<typeof basePortrait> & { staticOnly?: boolean; regionFamilies?: number[] } = {}) {
  return portraitVisualKey({ ...basePortrait, ...overrides });
}

describe("portrait visual identity", () => {
  test("family, levels, palette, accessory, background, region families, and static drawing change the key", () => {
    const original = key();
    assert.notEqual(key({ family: 1 }), original);
    assert.notEqual(key({ levels: [2, 2, 3] }), original);
    assert.notEqual(key({ levels: [1, 3, 3] }), original);
    assert.notEqual(key({ levels: [1, 2, 4] }), original);
    assert.notEqual(key({ palette: 5 }), original);
    assert.notEqual(key({ accessory: 7 }), original);
    assert.notEqual(key({ background: 2 }), original);
    assert.notEqual(key({ regionFamilies: [1, 0, 2] }), original);
    assert.notEqual(key({ staticOnly: true }), original);
    assert.equal(key({ regionFamilies: [-1, -1, -1] }), original);
  });

  test("the same visual inputs keep one key", () => {
    assert.equal(key(), key());
    assert.equal(portraitVisualKey({ ...basePortrait, levels: [1, 2, 3] }), key());
  });
});

describe("stage portrait draw decisions", () => {
  const visible = {
    previousKey: key(),
    nextKey: key(),
    routeVisible: true,
    canvasFullyHidden: false,
    pixelsSampledWhileHidden: false,
  };

  test("the first time pixels are needed still draws", () => {
    assert.equal(shouldDrawPortrait({ ...visible, previousKey: null }), true);
  });

  test("an unchanged visible portrait does not draw again", () => {
    assert.equal(shouldDrawPortrait(visible), false);
  });

  test("a hidden route or a fully hidden unsampled canvas defers the draw, including the first one", () => {
    assert.equal(shouldDrawPortrait({ ...visible, previousKey: null, routeVisible: false }), false);
    assert.equal(
      shouldDrawPortrait({
        ...visible,
        previousKey: null,
        nextKey: key({ family: 2 }),
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: false,
      }),
      false,
    );
  });

  test("a family or level change deferred while hidden draws once the portrait is revealed", () => {
    const hiddenFamily = {
      ...visible,
      previousKey: key(),
      nextKey: key({ family: 2 }),
      canvasFullyHidden: true,
      pixelsSampledWhileHidden: false,
    };
    assert.equal(shouldDrawPortrait(hiddenFamily), false);
    assert.equal(
      shouldDrawPortrait({ ...hiddenFamily, canvasFullyHidden: false, previousKey: key() }),
      true,
    );
    assert.equal(
      shouldDrawPortrait({
        ...visible,
        previousKey: null,
        canvasFullyHidden: false,
      }),
      true,
    );
  });

  test("lit interior sampling draws a changed hidden portrait and skips an unchanged one", () => {
    assert.equal(
      shouldDrawPortrait({
        ...visible,
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: true,
        nextKey: key({ levels: [4, 2, 3] }),
      }),
      true,
    );
    assert.equal(
      shouldDrawPortrait({
        ...visible,
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: true,
      }),
      false,
    );
  });

  test("trait, reset, and completion keys draw when pixels are needed", () => {
    for (const nextKey of [
      key({ palette: 8 }),
      key({ accessory: 3 }),
      key({ background: 1 }),
      key({ levels: [0, 0, 0] }),
      key({ staticOnly: true }),
    ]) {
      assert.equal(shouldDrawPortrait({ ...visible, nextKey }), true);
    }
  });

  test("an unchanged portrait does not draw just to restart a stopped accessory", () => {
    const same = {
      previousKey: visible.previousKey,
      nextKey: visible.nextKey,
      routeVisible: true,
      canvasFullyHidden: false,
      animating: false,
      accessoryAnimates: true,
    };
    assert.equal(shouldDrawPortrait(visible), false);
    assert.equal(shouldResumeAccessoryAnimation(same), true);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, animating: true }), false);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, canvasFullyHidden: true }), false);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, routeVisible: false }), false);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, accessoryAnimates: false }), false);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, previousKey: null }), false);
    const changed = key({ accessory: 8 });
    assert.equal(shouldDrawPortrait({ ...visible, nextKey: changed }), true);
    assert.equal(shouldResumeAccessoryAnimation({ ...same, nextKey: changed }), false);
    assert.equal(
      shouldDrawPortrait({
        ...visible,
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: true,
      }),
      false,
    );
  });
});

describe("scheduled docs previews", () => {
  function manualScheduler() {
    const queued: Array<() => void> = [];
    return {
      schedule(run: () => void) {
        queued.push(run);
        return {
          cancel() {
            const index = queued.indexOf(run);
            if (index >= 0) queued.splice(index, 1);
          },
        };
      },
      flush() {
        queued.shift()?.();
      },
      get size() {
        return queued.length;
      },
    };
  }

  function deferredHost() {
    const prepared: string[] = [];
    const painted: string[] = [];
    const stopped: string[] = [];
    const gates: Array<() => void> = [];
    const scheduler = manualScheduler();
    const gallery = createScheduledPreviewGallery(scheduler.schedule, {
      prepare(preview) {
        prepared.push(preview.id);
        return new Promise<void>((resolve) => {
          gates.push(resolve);
        });
      },
      paint(preview) {
        painted.push(preview.id);
      },
      stop(preview) {
        stopped.push(preview.id);
      },
    });
    return { prepared, painted, stopped, gates, scheduler, gallery };
  }

  async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  test("install does not paint, and one slice prepares only one preview", async () => {
    const { prepared, painted, scheduler, gallery } = deferredHost();
    const previews = [
      { id: "palette:0", visualKey: "p0" },
      { id: "palette:1", visualKey: "p1" },
      { id: "acc:0", visualKey: "a0" },
    ];
    assert.equal(gallery.install(previews), true);
    assert.equal(gallery.install([{ id: "other", visualKey: "x" }]), false);
    assert.equal(prepared.length, 0);
    assert.equal(painted.length, 0);
    gallery.open();
    assert.equal(prepared.length, 0);
    scheduler.flush();
    assert.deepEqual(prepared, ["palette:0"]);
    assert.deepEqual(painted, []);
    scheduler.flush();
    assert.deepEqual(prepared, ["palette:0", "palette:1"]);
    assert.deepEqual(painted, []);
  });

  test("paints resolve one per slice, once each, and a reopen does not paint them again", async () => {
    const { prepared, painted, gates, scheduler, gallery } = deferredHost();
    gallery.install([
      { id: "palette:0", visualKey: "coat-0" },
      { id: "acc:7", visualKey: "wear-7" },
    ]);
    gallery.open();
    scheduler.flush();
    scheduler.flush();
    assert.equal(gates.length, 2);
    gates.shift()?.();
    await settle();
    scheduler.flush();
    assert.deepEqual(painted, ["palette:0"]);
    gates.shift()?.();
    await settle();
    scheduler.flush();
    assert.deepEqual(painted, ["palette:0", "acc:7"]);
    assert.equal(gallery.paintedKey("palette:0"), "coat-0");
    assert.equal(gallery.paintedKey("acc:7"), "wear-7");

    gallery.hide();
    gallery.open();
    while (scheduler.size > 0) scheduler.flush();
    await settle();
    while (scheduler.size > 0) scheduler.flush();
    assert.deepEqual(prepared, ["palette:0", "acc:7"]);
    assert.deepEqual(painted, ["palette:0", "acc:7"]);
  });

  test("hiding pauses queued work and resumes only previews that have not painted", async () => {
    const { prepared, painted, stopped, gates, scheduler, gallery } = deferredHost();
    gallery.install([
      { id: "palette:0", visualKey: "coat-0" },
      { id: "palette:1", visualKey: "coat-1" },
      { id: "acc:0", visualKey: "wear-0" },
    ]);
    gallery.open();
    scheduler.flush();
    assert.deepEqual(prepared, ["palette:0"]);
    gallery.hide();
    assert.equal(scheduler.size, 0);
    scheduler.flush();
    assert.deepEqual(prepared, ["palette:0"]);
    assert.ok(stopped.includes("palette:0"));
    gates.shift()?.();
    await settle();
    assert.deepEqual(painted, []);

    gallery.open();
    const seenPrepared = new Set(prepared);
    for (let turn = 0; turn < 12 && painted.length < 3; turn += 1) {
      while (scheduler.size > 0) scheduler.flush();
      const pending = gates.splice(0, gates.length);
      for (const resolve of pending) resolve();
      await settle();
    }
    assert.deepEqual(painted.slice().sort(), ["acc:0", "palette:0", "palette:1"]);
    assert.equal(seenPrepared.has("palette:0"), true);
    assert.equal(prepared.filter((id) => id === "palette:0").length, 1);
    assert.equal(painted.filter((id) => id === "palette:0").length, 1);
  });
});

describe("leaderboard portrait plan and route races", () => {
  test("identical entries are reused, visual edits redraw, and removed entries dispose", () => {
    const previous = [
      { resultId: "a", visualKey: "same" },
      { resultId: "b", visualKey: "old" },
      { resultId: "c", visualKey: "gone" },
    ];
    const next = [
      { resultId: "a", visualKey: "same" },
      { resultId: "b", visualKey: "new" },
      { resultId: "d", visualKey: "fresh" },
    ];
    assert.deepEqual(planLeaderboardPortraits(previous, next), {
      reuse: ["a"],
      redraw: ["b", "d"],
      dispose: ["c"],
    });
  });

  test("a leaderboard response applies only for the latest request while that route is open", () => {
    assert.equal(leaderboardResponseIsCurrent(2, 2, true), true);
    assert.equal(leaderboardResponseIsCurrent(1, 2, true), false);
    assert.equal(leaderboardResponseIsCurrent(2, 2, false), false);
  });
});

describe("stable controls across ticks", () => {
  const specs: StableControlSpec[] = [
    {
      id: "btn-start-lamp",
      tag: "button",
      present: true,
      text: "Illuminate Demo Egg (Lock Traits)",
      className: "led-btn-primary",
      disabled: false,
    },
    {
      id: "btn-reset-egg",
      tag: "button",
      present: true,
      text: "New Egg Selection",
      className: "led-btn-ghost",
      disabled: false,
    },
    {
      id: "btn-complete-session",
      tag: "button",
      present: false,
      text: "Complete Character & Reveal Portrait",
      className: "led-btn-primary",
      disabled: false,
    },
  ];

  test("a control that stays present is updated in place so a held press keeps the same element", () => {
    const created = stableControlActions([], specs);
    assert.deepEqual(
      created.map((action) => action.op),
      ["create", "create"],
    );
    const elements = new Map<string, { id: string; text: string }>();
    for (const action of created) {
      if (action.op !== "create") continue;
      elements.set(action.spec.id, { id: action.spec.id, text: action.spec.text });
    }
    const held = elements.get("btn-start-lamp");
    const again = stableControlActions([...elements.keys()], specs);
    assert.equal(again.some((action) => action.op === "remove"), false);
    assert.equal(again.some((action) => action.op === "create"), false);
    for (const action of again) {
      if (action.op !== "update") continue;
      const element = elements.get(action.spec.id);
      assert.ok(element);
      element.text = action.spec.text;
    }
    assert.equal(elements.get("btn-start-lamp"), held);
    assert.equal(elements.get("btn-complete-session"), undefined);
  });

  test("a control is removed only when it should disappear, and a later appearance is a new create", () => {
    const running = specs.map((spec) =>
      spec.id === "btn-start-lamp" ? { ...spec, present: false } : spec,
    );
    const actions = stableControlActions(["btn-start-lamp", "btn-reset-egg"], running);
    assert.deepEqual(
      actions.map((action) => action.op + ":" + (action.op === "remove" ? action.id : action.spec.id)),
      ["remove:btn-start-lamp", "update:btn-reset-egg"],
    );
    const returned = stableControlActions(["btn-reset-egg"], specs);
    assert.equal(returned.some((action) => action.op === "create" && action.spec.id === "btn-start-lamp"), true);
    assert.equal(returned.some((action) => action.op === "update" && action.spec.id === "btn-reset-egg"), true);
  });

  test("a tick between pointer down and pointer up does not reparent the pressed control", () => {
    const ordered: StableControlSpec[] = [
      {
        id: "btn-start-lamp",
        tag: "button",
        present: true,
        text: "Illuminate Demo Egg (Lock Traits)",
        className: "led-btn-primary",
        disabled: false,
      },
      {
        id: "btn-complete-session",
        tag: "button",
        present: false,
        text: "Complete Character & Reveal Portrait",
        className: "led-btn-primary",
        disabled: false,
      },
      {
        id: "btn-reset-egg",
        tag: "button",
        present: true,
        text: "New Egg Selection",
        className: "led-btn-ghost",
        disabled: false,
      },
    ];
    const bench = controlBench();
    syncStableControlHost(bench.host, ordered);
    const held = bench.nodes.get("btn-start-lamp");
    assert.ok(held);
    assert.equal(held.connected, true);
    bench.pointerId = held.id;
    bench.activeId = held.id;
    const index = bench.order.indexOf(held.id);
    const before = bench.structural.length;
    syncStableControlHost(
      bench.host,
      ordered.map((spec) =>
        spec.id === "btn-reset-egg" ? { ...spec, className: "led-btn-ghost" } : spec,
      ),
    );
    assert.equal(bench.structural.length, before);
    assert.equal(bench.order[index], held.id);
    assert.equal(bench.nodes.get(held.id), held);
    assert.equal(held.connected, true);
    assert.equal(bench.pointerId, held.id);
    assert.equal(bench.activeId, held.id);

    syncStableControlHost(
      bench.host,
      ordered.map((spec) => (spec.id === "btn-complete-session" ? { ...spec, present: true } : spec)),
    );
    const inserted = bench.structural.slice(before);
    assert.deepEqual(inserted, ["place:btn-complete-session->btn-reset-egg"]);
    assert.equal(bench.nodes.get(held.id), held);
    assert.equal(held.connected, true);
    assert.equal(bench.pointerId, held.id);
    assert.equal(bench.activeId, held.id);
    assert.deepEqual(bench.order, ["btn-start-lamp", "btn-complete-session", "btn-reset-egg"]);
  });
});

interface ControlNode {
  id: string;
  text: string;
  className: string;
  disabled: boolean;
  connected: boolean;
}

function controlBench(): {
  host: StableControlHost;
  structural: string[];
  nodes: Map<string, ControlNode>;
  order: readonly string[];
  pointerId: string | null;
  activeId: string | null;
} {
  const nodes = new Map<string, ControlNode>();
  let order: string[] = [];
  const structural: string[] = [];
  let pointerId: string | null = null;
  let activeId: string | null = null;
  const host: StableControlHost = {
    ids: () => order.slice(),
    create(spec) {
      const previous = nodes.get(spec.id);
      if (previous?.connected) throw new Error(`recreated attached ${spec.id}`);
      nodes.set(spec.id, {
        id: spec.id,
        text: spec.text,
        className: spec.className,
        disabled: spec.disabled,
        connected: false,
      });
    },
    update(id, spec) {
      const node = nodes.get(id);
      if (!node?.connected) throw new Error(`updated detached ${id}`);
      node.text = spec.text;
      node.className = spec.className;
      node.disabled = spec.disabled;
    },
    remove(id) {
      structural.push(`remove:${id}`);
      const node = nodes.get(id);
      if (node) node.connected = false;
      order = order.filter((item) => item !== id);
      if (pointerId === id) pointerId = null;
      if (activeId === id) activeId = null;
    },
    placeNew(id, beforeId) {
      const node = nodes.get(id);
      if (!node) throw new Error(`missing ${id}`);
      if (node.connected) throw new Error(`reparented ${id}`);
      structural.push(`place:${id}->${beforeId ?? "end"}`);
      node.connected = true;
      if (beforeId === null) order.push(id);
      else {
        const at = order.indexOf(beforeId);
        if (at < 0) throw new Error(`missing sibling ${beforeId}`);
        order.splice(at, 0, id);
      }
    },
  };
  return {
    host,
    structural,
    nodes,
    get order() {
      return order.slice();
    },
    get pointerId() {
      return pointerId;
    },
    set pointerId(id: string | null) {
      pointerId = id;
    },
    get activeId() {
      return activeId;
    },
    set activeId(id: string | null) {
      activeId = id;
    },
  };
}

describe("app wiring", () => {
  const source = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");

  function extractFunction(signature: string, text = source): string {
    const start = text.indexOf(signature);
    assert.notEqual(start, -1, `missing ${signature}`);
    const open = text.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
    throw new Error(`unclosed ${signature}`);
  }

  test("docs previews are installed from the docs route and are not part of the startup render", () => {
    const renderAll = extractFunction("function renderAll(");
    assert.equal(renderAll.includes("renderDocsCatalogTables"), false);
    assert.equal(renderAll.includes("syncDocsCatalog"), false);
    const route = extractFunction("function renderRouteVisibility(");
    assert.match(route, /syncDocsCatalog\(false\)/);
    assert.match(route, /syncDocsCatalog\(true\)/);
    const docs = extractFunction("function syncDocsCatalog(");
    assert.match(docs, /createScheduledPreviewGallery|docsGallery\.install/);
    assert.match(docs, /docsGallery\.open\(\)/);
    assert.match(docs, /docsGallery\.hide\(\)/);
    assert.match(source, /levels: \[8, 8, 8\]/);
    assert.match(source, /levels: \[6, 6, 6\]/);
    assert.match(source, /led-docs-palette-preview/);
    assert.match(source, /led-docs-acc-preview/);
    assert.match(source, /staticOnly: true/);
    const boot = source.slice(source.indexOf("// Initial boot sequence"), source.indexOf("__squeekAppMounted"));
    assert.equal(boot.includes("refreshLeaderboard"), false);
    assert.match(boot, /refreshAuthSession\(\)/);
    assert.match(boot, /pollHardwareStatus\(\)/);
  });

  test("stage redraw updates chrome first and draws only when the portrait decision says so", () => {
    const redraw = extractFunction("function redrawStageCanvas(");
    const decideAt = redraw.indexOf("shouldDrawPortrait(");
    const drawAt = redraw.indexOf("stageAdapter.draw(");
    assert.ok(decideAt !== -1 && drawAt !== -1 && decideAt < drawAt);
    assert.match(redraw, /stageCanvas\.style\.clipPath/);
    assert.match(redraw, /stageCanvas\.dataset\.stageFamily/);
    assert.match(redraw, /stageCanvas\.dataset\.stageLevels/);
    assert.match(redraw, /stageCanvas\.dataset\.sessionStatus/);
    assert.match(redraw, /updateLampAndShellVisuals\(\)/);
    assert.match(redraw, /if \(!routeVisible\) \{\s*stageAdapter\.stopAnimation\(\)/);
    assert.match(
      redraw,
      /if \(drawPortrait\) \{\s*stageAdapter\.draw\(state\);\s*stagePortraitKey = nextKey;\s*\} else if \(\s*shouldResumeAccessoryAnimation\(/,
    );
    assert.match(redraw, /stageAdapter\.resumeAccessoryAnimation\(\)/);
    assert.equal(redraw.match(/stageAdapter\.draw\(/g)?.length, 1);
    assert.equal(source.includes("restartStoppedAnimation"), false);
    assert.match(source, /id="led-stage-canvas" width="1600" height="1600"/);
  });

  test("session, mode, and region controls are patched in place and egg selection updates active immediately", () => {
    const play = extractFunction("function renderPlayDynamicSections(");
    assert.equal(play.includes("controlsEl.innerHTML"), false);
    assert.equal(play.includes("regionsList.innerHTML"), false);
    assert.equal(play.includes("modeContainer.innerHTML"), false);
    assert.equal(play.includes("selectorContainer.innerHTML"), false);
    assert.match(play, /syncStableControls\(/);
    assert.match(play, /mountRegionAimCards\(/);
    assert.match(play, /mountModeSelector\(/);
    assert.match(source, /syncStableControlHost\(/);
    const sync = extractFunction("function syncStableControls(");
    assert.match(sync, /syncStableControlHost\(/);
    assert.match(sync, /el\.isConnected\) return/);
    assert.doesNotMatch(sync, /for \(const spec of specs\)/);

    const regions = extractFunction("function mountRegionAimCards(");
    assert.ok(regions.indexOf("aimBound") < regions.indexOf("addEventListener"));
    assert.match(regions, /data-region-card/);
    const modes = extractFunction("function mountModeSelector(");
    assert.ok(modes.indexOf("modeBound") < modes.indexOf("addEventListener"));
    assert.equal(modes.match(/addEventListener\(/g)?.length, 2);

    const select = extractFunction("function handleSelectFamily(");
    assert.match(select, /classList\.toggle\("active", isMatch\)/);
    assert.match(select, /classList\.toggle\("selected", isMatch\)/);
    assert.ok(select.indexOf('toggle("active"') < select.indexOf("redrawStageCanvas("));
    assert.match(source, /id="btn-confirm-egg"/);
  });

  test("leaderboard fetch is gated to its route, portraits follow the reuse plan, and completion still saves", () => {
    const refresh = extractFunction("async function refreshLeaderboard(");
    assert.match(refresh, /if \(currentRoute\.kind !== "leaderboard"\) return;/);
    assert.ok(refresh.indexOf('currentRoute.kind !== "leaderboard"') < refresh.indexOf('"/api/leaderboard?limit=100"'));
    assert.match(refresh, /leaderboardResponseIsCurrent\(/);
    const tables = extractFunction("function renderLeaderboardTables(");
    assert.match(tables, /planLeaderboardPortraits\(/);
    assert.match(tables, /releaseLeaderboardPortrait\(/);
    assert.match(tables, /staticOnly: true/);
    const release = extractFunction("function releaseLeaderboardPortrait(");
    assert.match(release, /adapter\.stopAnimation\(\)/);
    assert.match(release, /adapter\.dispose\(\)/);
    const complete = extractFunction("async function handleCompleteSession(");
    assert.match(complete, /"\/api\/session\/complete"/);
    assert.match(source, /Download 1600×1600 PNG/);
    assert.equal((source.match(/paintRankedDisplayTimer\(/g) ?? []).length, 3);
    assert.equal((source.match(/syncRankedDisplayClock\(/g) ?? []).length, 5);
    assert.equal((source.match(/applyAcceptedRankedDisplay\(/g) ?? []).length, 7);
    const nft = extractFunction("function renderNftView(");
    assert.match(nft, /else if \(\s*shouldResumeAccessoryAnimation\(/);
    assert.match(nft, /nftAdapter\.resumeAccessoryAnimation\(\)/);
    assert.equal(nft.match(/nftAdapter\.drawAsync\(/g)?.length, 1);
    const renderer = fs.readFileSync(new URL("../src/led-renderer.ts", import.meta.url), "utf8");
    const resume = extractFunction("resumeAccessoryAnimation(): boolean", renderer);
    assert.equal(resume.includes("_drawCore"), false);
    assert.match(resume, /_paintWearFrame\(1100\)/);
    assert.match(resume, /_startWearLoop\(\)/);
  });
});

describe("continuous light footprint", () => {
  test("scoring bands stay put while the opening slides with the lamp", () => {
    assert.equal(regionAt(-70), 0);
    assert.equal(regionAt(0), 1);
    assert.equal(regionAt(70), 2);
    assert.equal(regionAt(-36), 0);
    assert.equal(regionAt(-33), 1);
    for (const family of [0, 1, 2] as const) {
      let egg = 0;
      let shown = 0;
      let outside = 0;
      let closed = 0;
      let shellOverBody = 0;
      let sumY = 0;
      let sumLow = 0;
      let lowCount = 0;
      let sumHigh = 0;
      let highCount = 0;
      forEachSceneLed({ minX: 0, minY: 0, maxX: 400, maxY: 420 }, (x, y) => {
        const inEgg = pointInFamilyEgg(family, x, y);
        for (const aim of [-70, 0, 70] as const) {
          const open = interiorVisibleAt(family, x, y, true, aim);
          if (!inEgg && open) outside += 1;
          if (interiorVisibleAt(family, x, y, false, aim)) closed += 1;
          if (open && shellDotVisibleAt(family, x, y, true, aim)) shellOverBody += 1;
        }
        if (!inEgg) return;
        egg += 1;
        if (interiorVisibleAt(family, x, y, true, 0)) {
          shown += 1;
          sumY += y;
        }
        if (interiorVisibleAt(family, x, y, true, -36)) {
          highCount += 1;
          sumHigh += y;
        }
        if (interiorVisibleAt(family, x, y, true, -33)) {
          lowCount += 1;
          sumLow += y;
        }
      });
      const fraction = shown / egg;
      assert.ok(fraction > 0.18 && fraction < 0.55, `family ${family} footprint ${fraction}`);
      assert.equal(outside, 0, `family ${family} reveal left the egg`);
      assert.equal(closed, 0, `family ${family} closed lamp revealed ${closed} samples`);
      assert.equal(shellOverBody, 0, `family ${family} shell covered ${shellOverBody} revealed samples`);
      assert.ok(highCount > 0 && lowCount > 0);
      const step = sumLow / lowCount - sumHigh / highCount;
      assert.ok(step >= -0.05 && step < 8, `family ${family} crossed -35 by ${step}`);

      const dots = sampleLedBeamDots(computeLampMountLayout(0), 0, true, 1, family);
      const lit = new Set(dots.map((dot) => `${dot.x},${dot.y}`));
      let beamMismatch = 0;
      for (const dot of dots) {
        if (!pointInFamilyEgg(family, dot.x, dot.y)) continue;
        if (!interiorVisibleAt(family, dot.x, dot.y, true, 0)) beamMismatch += 1;
        if (shellDotVisibleAt(family, dot.x, dot.y, true, 0)) beamMismatch += 1;
      }
      forEachSceneLed({ minX: 0, minY: 0, maxX: 400, maxY: 420 }, (x, y) => {
        if (!pointInFamilyEgg(family, x, y) || !interiorVisibleAt(family, x, y, true, 0)) return;
        if (!lit.has(`${x},${y}`)) beamMismatch += 1;
        if (shellDotVisibleAt(family, x, y, true, 0)) beamMismatch += 1;
      });
      assert.equal(beamMismatch, 0, `family ${family} shell or beam disagreed with the footprint`);
      assert.equal(sampleLedBeamDots(computeLampMountLayout(0), 0, false, 1, family).length, 0);
      assert.equal(sampleLedBeamDots(computeLampMountLayout(0), 0, true, 0, family).length, 0);
      assert.ok(sumY / shown > sumHigh / highCount);
    }
  });
});
