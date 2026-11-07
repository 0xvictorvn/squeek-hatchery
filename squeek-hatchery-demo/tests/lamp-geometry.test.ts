import assert from "node:assert/strict";
import fs from "node:fs";
import test, { describe } from "node:test";
import {
  computeLampMountLayout,
  computeRevealWindow,
  dotOnSceneGrid,
  forEachSceneLed,
  INCUBATION_SCENE,
  interiorVisibleAt,
  lampAnchorsMatch,
  lampArtSampleBounds,
  lampArtStagePoint,
  LAMP_ART_BULB,
  LAMP_ART_PIVOT,
  LAMP_ART_STAGE_WIDTH,
  pointInFamilyEgg,
  positionForSceneRailY,
  sampleLedBeamDots,
  SCENE_LED_GRID,
  sceneRailGeometry,
  sceneRailSpan,
  shellDotVisibleAt,
  stagePointToLampImage,
  stageRegionAnchor,
} from "../src/led-scene.ts";
import { lampGeometry, regionAt, STAGE } from "../src/rules.ts";
import { portraitVisualKey, shouldDrawPortrait } from "../src/ui-render-cache.ts";

const AIMS = [-100, -70, -36, -35, -33, 0, 33, 35, 36, 70, 100] as const;
const ART_ASPECTS = [0.5, 0.75, 1, 1.5] as const;

function wrapAngle(rad: number): number {
  let a = rad % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  else if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function circleHitsEgg(family: 0 | 1 | 2, x: number, y: number, radius: number): boolean {
  if (radius <= 0) return pointInFamilyEgg(family, x, y);
  const samples = 96;
  for (let i = 0; i < samples; i += 1) {
    const angle = (i / samples) * Math.PI * 2;
    if (pointInFamilyEgg(family, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)) {
      return true;
    }
  }
  return false;
}

/** Lower bound on the Euclidean gap from a point outside an egg, in scene units. */
function distanceToEgg(family: 0 | 1 | 2, x: number, y: number): number {
  if (pointInFamilyEgg(family, x, y)) return 0;
  let lo = 0;
  let hi = 280;
  for (let step = 0; step < 18; step += 1) {
    const mid = (lo + hi) / 2;
    if (circleHitsEgg(family, x, y, mid)) hi = mid;
    else lo = mid;
  }
  return lo;
}

function nearestGrid(x: number, y: number): { x: number; y: number } {
  const { step, phaseX, phaseY } = SCENE_LED_GRID;
  return {
    x: phaseX + Math.round((x - phaseX) / step) * step,
    y: phaseY + Math.round((y - phaseY) / step) * step,
  };
}

function inEggKeys(
  dots: readonly { x: number; y: number }[],
  family: 0 | 1 | 2,
): string[] {
  const keys: string[] = [];
  for (const dot of dots) {
    if (!pointInFamilyEgg(family, dot.x, dot.y)) continue;
    keys.push(`${dot.x},${dot.y}`);
  }
  keys.sort();
  return keys;
}

function visibleKeys(family: 0 | 1 | 2, aim: number): string[] {
  const keys: string[] = [];
  forEachSceneLed({ minX: 0, minY: 0, maxX: STAGE.w, maxY: STAGE.h }, (x, y) => {
    if (!interiorVisibleAt(family, x, y, true, aim)) return;
    keys.push(`${x},${y}`);
  });
  keys.sort();
  return keys;
}

function footprintStats(family: 0 | 1 | 2, aim: number): {
  count: number;
  egg: number;
  centroidY: number;
  minY: number;
  maxY: number;
} {
  let count = 0;
  let egg = 0;
  let sumY = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  forEachSceneLed({ minX: 0, minY: 0, maxX: STAGE.w, maxY: STAGE.h }, (x, y) => {
    if (!pointInFamilyEgg(family, x, y)) return;
    egg += 1;
    if (!interiorVisibleAt(family, x, y, true, aim)) return;
    count += 1;
    sumY += y;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  return { count, egg, centroidY: count === 0 ? Number.NaN : sumY / count, minY, maxY };
}

function rayReachesReveal(
  family: 0 | 1 | 2,
  aim: number,
  originX: number,
  originY: number,
  dx: number,
  dy: number,
): boolean {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const rim = SCENE_LED_GRID.step * 4;
  let entry = -1;
  for (let t = 1; t <= 540; t += 2) {
    const x = originX + ux * t;
    const y = originY + uy * t;
    const inside = pointInFamilyEgg(family, x, y);
    if (!inside) {
      if (entry >= 0) return false;
      continue;
    }
    if (entry < 0) entry = t;
    if (interiorVisibleAt(family, x, y, true, aim)) return true;
    if (t > entry + rim) return false;
  }
  return false;
}

/**
 * CSS canvas box at the two review widths. Mirrors shell/card padding in
 * src/style.css so the 44px handle is checked in real pixels, not scene units.
 */
function canvasCss(viewport: number): { width: number; height: number } {
  const root = 16;
  const shellPadX = viewport <= 390 ? 0.4 * root : viewport <= 640 ? 0.55 * root : root;
  const shellInner = Math.min(viewport, 1380) - shellPadX * 2;
  const cardPad = viewport <= 640 ? 0.75 * root : root;
  const gap = root;
  const column = viewport > 980 ? (shellInner - gap) * (1.08 / 2) : shellInner;
  const width = column - cardPad * 2 - 2 - 2;
  const height = width * (INCUBATION_SCENE.height / INCUBATION_SCENE.width);
  return { width, height };
}

describe("lamp spacing and one scene mapping", () => {
  test("rail aim is linear, invertible, and stays off the ellipse-normal extremes", () => {
    const reach = (LAMP_ART_PIVOT.u - LAMP_ART_BULB.u) * LAMP_ART_STAGE_WIDTH;
    for (let i = -1000; i <= 1000; i += 1) {
      const position = i / 10;
      const layout = computeLampMountLayout(position);
      const back = positionForSceneRailY(layout.handleY);
      assert.ok(Math.abs(back - position) <= 0.11, `${position} mapped to ${back}`);
      assert.equal(lampAnchorsMatch(layout), true);
      assert.equal(layout.handleX, layout.railX);
      assert.equal(layout.handleY, STAGE.cy + position);
      assert.equal(layout.sourceX, layout.railX);
      assert.equal(layout.sourceY, layout.handleY);
      assert.ok(Math.abs(layout.bulbX - (layout.railX - reach)) < 1e-6);
      assert.ok(Math.abs(layout.bulbY - layout.handleY) < 1e-6);
      assert.equal(layout.handleSize, INCUBATION_SCENE.handleSize);
    }
    let previous = -Infinity;
    for (let y = 0; y <= INCUBATION_SCENE.height; y += 1) {
      const position = positionForSceneRailY(y);
      assert.ok(position >= previous);
      assert.ok(position >= -100 && position <= 100);
      previous = position;
    }
    assert.equal(positionForSceneRailY(0), -100);
    assert.equal(positionForSceneRailY(INCUBATION_SCENE.height), 100);
    assert.equal(positionForSceneRailY(STAGE.cy), 0);
    assert.equal(positionForSceneRailY(Number.NaN), 0);

    for (const position of [-100, 100] as const) {
      const layout = computeLampMountLayout(position);
      const legacy = lampGeometry(position, layout.railX);
      assert.ok(Math.abs(layout.handleY - legacy.sourceY) > 30);
      assert.ok(layout.handleY > 90);
      assert.ok(layout.handleY < INCUBATION_SCENE.height - 90);
    }
  });

  test("bulb gap and opaque art stay outside every family egg", () => {
    for (const family of [0, 1, 2] as const) {
      for (const position of AIMS) {
        const layout = computeLampMountLayout(position);
        const gap = distanceToEgg(family, layout.bulbX, layout.bulbY);
        assert.ok(
          gap >= INCUBATION_SCENE.minBulbGap,
          `family ${family} aim ${position} bulb gap ${gap}`,
        );
        for (const aspect of ART_ASPECTS) {
          for (let u = 0; u <= 1.001; u += 0.1) {
            for (let v = 0; v <= 1.001; v += 0.1) {
              const point = lampArtStagePoint(Math.min(u, 1), Math.min(v, 1), layout, aspect);
              assert.equal(
                pointInFamilyEgg(family, point.x, point.y),
                false,
                `art overlap family ${family} aim ${position} aspect ${aspect}`,
              );
              assert.ok(point.x >= 1 && point.x <= INCUBATION_SCENE.width - 1);
              assert.ok(point.y >= 1 && point.y <= INCUBATION_SCENE.height - 1);
            }
          }
        }
        const bounds = lampArtSampleBounds(layout);
        assert.ok(bounds.minX >= 0 && bounds.maxX <= INCUBATION_SCENE.width);
        assert.ok(bounds.minY >= 0 && bounds.maxY <= INCUBATION_SCENE.height);
        const corner = lampArtStagePoint(0, 0.5, layout, 1);
        assert.ok(corner.x >= bounds.minX && corner.x <= bounds.maxX);
      }
    }
  });

  test("lamp image mapping round-trips interior pixels and rejects the half-open edge", () => {
    const layout = computeLampMountLayout(-70);
    const interior: ReadonlyArray<readonly [number, number, number]> = [
      [LAMP_ART_BULB.u, LAMP_ART_BULB.v, 0.62],
      [LAMP_ART_PIVOT.u, LAMP_ART_PIVOT.v, 1],
      [0, 0, 0.75],
      [0.5, 0.5, 1.25],
    ];
    for (const [u, v, aspect] of interior) {
      const imageWidth = 240;
      const imageHeight = imageWidth * aspect;
      const stage = lampArtStagePoint(u, v, layout, aspect);
      const image = stagePointToLampImage(stage.x, stage.y, layout, imageWidth, imageHeight);
      assert.ok(image, `missing interior pixel u=${u} v=${v}`);
      assert.ok(Math.abs(image.x / imageWidth - u) < 1e-6);
      assert.ok(Math.abs(image.y / imageHeight - v) < 1e-6);
      assert.ok(image.x >= 0 && image.x < imageWidth);
      assert.ok(image.y >= 0 && image.y < imageHeight);
    }

    const imageWidth = 240;
    const aspect = 1.25;
    const imageHeight = imageWidth * aspect;
    const scale = LAMP_ART_STAGE_WIDTH / imageWidth;
    const far = lampArtStagePoint(1, 1, layout, aspect);
    const farX = lampArtStagePoint(1, 0.5, layout, aspect);
    const farY = lampArtStagePoint(0.5, 1, layout, aspect);
    assert.equal(
      stagePointToLampImage(far.x, far.y, layout, imageWidth, imageHeight),
      null,
      "normalized UV 1,1 is the exclusive pixel edge",
    );
    assert.equal(
      stagePointToLampImage(farX.x, farX.y, layout, imageWidth, imageHeight),
      null,
      "UV u=1 stays outside the half-open width",
    );
    assert.equal(
      stagePointToLampImage(farY.x, farY.y, layout, imageWidth, imageHeight),
      null,
      "UV v=1 stays outside the half-open height",
    );
    const origin = lampArtStagePoint(0, 0.5, layout, aspect);
    const originPixel = stagePointToLampImage(origin.x, origin.y, layout, imageWidth, imageHeight);
    assert.ok(originPixel);
    assert.ok(Math.abs(originPixel.x) < 1e-6);
    const pulledIn = stagePointToLampImage(
      origin.x - scale * 1e-5,
      origin.y,
      layout,
      imageWidth,
      imageHeight,
    );
    assert.ok(pulledIn, "sub-pixel noise just before 0 stays on the first pixel");
    assert.equal(pulledIn.x, 0);
    assert.equal(
      stagePointToLampImage(origin.x - scale * 1.5, origin.y, layout, imageWidth, imageHeight),
      null,
      "a full pixel before the sprite is outside",
    );
    const barelyInside = stagePointToLampImage(
      far.x - scale * 0.5,
      far.y - scale * aspect * 0.5,
      layout,
      imageWidth,
      imageHeight,
    );
    assert.ok(barelyInside);
    assert.ok(barelyInside.x >= 0 && barelyInside.x < imageWidth);
    assert.ok(barelyInside.y >= 0 && barelyInside.y < imageHeight);
    assert.ok(imageWidth - barelyInside.x > 0.25);
    assert.equal(
      stagePointToLampImage(farX.x + scale * 1e-5, farX.y, layout, imageWidth, imageHeight),
      null,
      "a fractional step past the exclusive edge stays outside",
    );
    assert.equal(
      stagePointToLampImage(farX.x + scale * 1e-4, farX.y, layout, imageWidth, imageHeight),
      null,
      "tolerance must not accept a pixel beyond width",
    );
    assert.equal(
      stagePointToLampImage(farX.x + scale * 1.5, farX.y, layout, imageWidth, imageHeight),
      null,
      "a full pixel past the sprite is outside",
    );
    assert.equal(stagePointToLampImage(far.x, far.y, layout, 0, imageHeight), null);

    const tilted = { ...layout, angle: 33 };
    const tiltedStage = lampArtStagePoint(0.25, 0.75, tilted, 0.8);
    const tiltedImage = stagePointToLampImage(tiltedStage.x, tiltedStage.y, tilted, 200, 160);
    assert.ok(tiltedImage);
    assert.ok(Math.abs(tiltedImage.x / 200 - 0.25) < 1e-6);
    assert.ok(Math.abs(tiltedImage.y / 160 - 0.75) < 1e-6);
    const tiltedCorner = lampArtStagePoint(1, 1, tilted, 0.8);
    assert.equal(stagePointToLampImage(tiltedCorner.x, tiltedCorner.y, tilted, 200, 160), null);
    assert.equal(stagePointToLampImage(tiltedStage.x + 500, tiltedStage.y, tilted, 200, 160), null);
  });

  test("handle, rail and hit stay inside the card at 390px and 1422px", () => {
    const span = sceneRailSpan();
    assert.ok(span.y1 > 0 && span.y2 < INCUBATION_SCENE.height);
    assert.equal(span.x, INCUBATION_SCENE.railX);
    for (const viewport of [390, 1422]) {
      const canvas = canvasCss(viewport);
      assert.ok(canvas.width > 200 && canvas.height > 160, `canvas ${viewport}`);
      for (const position of [-100, -70, 0, 70, 100] as const) {
        const layout = computeLampMountLayout(position);
        const hit = sceneRailGeometry(layout);
        const size = layout.handleSize;
        const left = (layout.handleX / INCUBATION_SCENE.width) * canvas.width - size / 2;
        const top = (layout.handleY / INCUBATION_SCENE.height) * canvas.height - size / 2;
        assert.ok(left >= 2, `handle left ${left} @${viewport} ${position}`);
        assert.ok(top >= 2, `handle top ${top} @${viewport} ${position}`);
        assert.ok(left + size <= canvas.width - 2, `handle right @${viewport} ${position}`);
        assert.ok(top + size <= canvas.height - 2, `handle bottom @${viewport} ${position}`);
        const hitLeft = (hit.hitX / INCUBATION_SCENE.width) * canvas.width;
        const hitTop = (hit.hitY / INCUBATION_SCENE.height) * canvas.height;
        const hitRight = ((hit.hitX + hit.hitW) / INCUBATION_SCENE.width) * canvas.width;
        const hitBottom = ((hit.hitY + hit.hitH) / INCUBATION_SCENE.height) * canvas.height;
        assert.ok(hitLeft >= -0.5 && hitTop >= -0.5);
        assert.ok(hitRight <= canvas.width + 0.5 && hitBottom <= canvas.height + 0.5);
        const cx = (layout.handleX / INCUBATION_SCENE.width) * canvas.width;
        const cy = (layout.handleY / INCUBATION_SCENE.height) * canvas.height;
        assert.ok(cx >= hitLeft && cx <= hitRight);
        assert.ok(cy >= hitTop && cy <= hitBottom);
      }
    }
  });

  test("egg, region anchors and aim extrema remain inside the widened card", () => {
    for (const family of [0, 1, 2] as const) {
      let seen = 0;
      forEachSceneLed({ minX: 0, minY: 0, maxX: STAGE.w, maxY: STAGE.h }, (x, y) => {
        if (!pointInFamilyEgg(family, x, y)) return;
        seen += 1;
        assert.ok(x > 8 && x < INCUBATION_SCENE.width - 40);
        assert.ok(y > 8 && y < INCUBATION_SCENE.height - 8);
      });
      assert.ok(seen > 100, `family ${family} egg samples ${seen}`);
    }
    for (const region of [0, 1, 2] as const) {
      const anchor = stageRegionAnchor(region);
      assert.ok(anchor.cx > 0 && anchor.cx < INCUBATION_SCENE.width);
      assert.ok(anchor.cy > 0 && anchor.cy < INCUBATION_SCENE.height);
      for (const family of [0, 1, 2] as const) {
        assert.equal(pointInFamilyEgg(family, anchor.cx, anchor.cy), true);
      }
      const aim = region === 0 ? -70 : region === 1 ? 0 : 70;
      const win = computeRevealWindow(aim, true);
      assert.equal(win.open, true);
      assert.equal(win.region, region);
      assert.equal(win.cy, STAGE.cy + aim);
      assert.equal(interiorVisibleAt(0, win.cx, win.cy, true, aim), true);
      assert.equal(computeRevealWindow(0, false).open, false);
    }
    assert.equal(computeRevealWindow(-33, true).cy, STAGE.cy - 33);
    assert.equal(computeRevealWindow(-36, true).cy, STAGE.cy - 36);
    assert.equal(computeRevealWindow(-33, true).region, regionAt(-33));
    assert.equal(computeRevealWindow(-36, true).region, regionAt(-36));
    assert.equal(regionAt(-33), 1);
    assert.equal(regionAt(-36), 0);
  });
});

describe("beam fits the live reveal", () => {
  test("the opening is the light band, and it slides through ±33", () => {
    for (const family of [0, 1, 2] as const) {
      const center = footprintStats(family, 0);
      assert.ok(center.egg > 100, `family ${family} egg samples`);
      const fraction = center.count / center.egg;
      assert.ok(fraction > 0.18 && fraction < 0.55, `family ${family} center fraction ${fraction}`);
      assert.ok(center.maxY - center.minY > 48, `family ${family} band collapsed`);
      assert.ok(center.maxY - center.minY < 180, `family ${family} band filled the egg`);
      assert.equal(interiorVisibleAt(family, STAGE.cx, STAGE.cy, true, 0), true);
      assert.equal(interiorVisibleAt(family, STAGE.cx, STAGE.cy + 130, true, 0), false);
      assert.equal(shellDotVisibleAt(family, STAGE.cx, STAGE.cy + 130, true, 0), true);
      assert.equal(interiorVisibleAt(family, STAGE.cx, STAGE.cy, false, 0), false);
      const high = footprintStats(family, -100);
      const low = footprintStats(family, 100);
      assert.ok(high.count > center.egg * 0.04, `family ${family} top aim collapsed`);
      assert.ok(low.count > center.egg * 0.04, `family ${family} lower aim collapsed`);
      assert.ok(high.centroidY < center.centroidY && center.centroidY < low.centroidY);
      assert.equal(interiorVisibleAt(family, STAGE.cx, STAGE.cy + 100, true, 100), true);
      assert.equal(interiorVisibleAt(family, STAGE.cx, STAGE.cy, true, 100), false);
      assert.notDeepEqual(visibleKeys(family, 0), visibleKeys(family, 12));
      assert.notDeepEqual(visibleKeys(family, -33), visibleKeys(family, 33));

      let previous = new Set(visibleKeys(family, -100));
      let previousY = footprintStats(family, -100).centroidY;
      for (let aim = -99; aim <= 100; aim += 1) {
        const stats = footprintStats(family, aim);
        const keys = visibleKeys(family, aim);
        const seen = new Set(keys);
        let flipped = 0;
        for (const key of previous) if (!seen.has(key)) flipped += 1;
        for (const key of seen) if (!previous.has(key)) flipped += 1;
        assert.ok(flipped <= 160, `family ${family} aim ${aim} jumped ${flipped} LEDs`);
        assert.ok(stats.centroidY + 0.05 >= previousY, `family ${family} aim ${aim} centroid reversed`);
        assert.ok(
          stats.centroidY - previousY <= 24,
          `family ${family} aim ${aim} centroid jumped ${stats.centroidY - previousY}`,
        );
        previous = seen;
        previousY = stats.centroidY;
      }
      const across = footprintStats(family, -33).centroidY - footprintStats(family, -36).centroidY;
      assert.ok(across >= -0.05 && across < SCENE_LED_GRID.step + 2, `family ${family} ±35 step ${across}`);
      assert.equal(regionAt(-36), 0);
      assert.equal(regionAt(-33), 1);
      assert.notDeepEqual(visibleKeys(family, -70), visibleKeys(family, -20));

      for (const aim of AIMS) {
        const dots = sampleLedBeamDots(computeLampMountLayout(aim), aim, true, 1, family);
        assert.deepEqual(inEggKeys(dots, family), visibleKeys(family, aim), `family ${family} aim ${aim}`);
        for (const dot of dots) {
          assert.equal(dotOnSceneGrid(dot.x, dot.y), true);
          if (!pointInFamilyEgg(family, dot.x, dot.y)) continue;
          assert.equal(interiorVisibleAt(family, dot.x, dot.y, true, aim), true);
          assert.equal(shellDotVisibleAt(family, dot.x, dot.y, true, aim), false);
        }
        assert.equal(sampleLedBeamDots(computeLampMountLayout(aim), aim, false, 1, family).length, 0);
        assert.equal(sampleLedBeamDots(computeLampMountLayout(aim), aim, true, 0, family).length, 0);
        assert.equal(sampleLedBeamDots(computeLampMountLayout(aim), aim, true, -1, family).length, 0);
      }
    }
  });

  test("the beam starts at the bulb and stops on the reveal, not the closed shell", () => {
    for (const family of [0, 1, 2] as const) {
      for (const aim of [-100, -33, 0, 33, 100] as const) {
        const layout = computeLampMountLayout(aim);
        const dots = sampleLedBeamDots(layout, aim, true, 1, family);
        const spots = dots.filter((dot) => pointInFamilyEgg(family, dot.x, dot.y));
        const corridor = dots.filter((dot) => !pointInFamilyEgg(family, dot.x, dot.y));
        assert.ok(spots.length > 8, `family ${family} aim ${aim} spots`);
        assert.ok(corridor.length > 4, `family ${family} aim ${aim} corridor ${corridor.length}`);

        let nearest = Number.POSITIVE_INFINITY;
        for (const dot of corridor) {
          nearest = Math.min(nearest, Math.hypot(dot.x - layout.bulbX, dot.y - layout.bulbY));
        }
        assert.ok(nearest <= SCENE_LED_GRID.step * 1.75, `bulb gap in the beam ${nearest}`);

        let portal = spots[0]!;
        let portalDist = Number.POSITIVE_INFINITY;
        for (const spot of spots) {
          const toX = layout.bulbX - spot.x;
          const toY = layout.bulbY - spot.y;
          const toLen = Math.hypot(toX, toY) || 1;
          const nx = spot.x + (toX / toLen) * SCENE_LED_GRID.step;
          const ny = spot.y + (toY / toLen) * SCENE_LED_GRID.step;
          const facing =
            !pointInFamilyEgg(family, nx, ny) ||
            !interiorVisibleAt(family, nx, ny, true, aim);
          if (!facing) continue;
          const dist = Math.hypot(spot.x - layout.bulbX, spot.y - layout.bulbY);
          if (dist < portalDist) {
            portal = spot;
            portalDist = dist;
          }
        }
        assert.ok(Number.isFinite(portalDist), `family ${family} aim ${aim} has no lamp-facing reveal`);
        const span = portalDist;
        for (let t = SCENE_LED_GRID.step; t < span; t += SCENE_LED_GRID.step) {
          const x = layout.bulbX + ((portal.x - layout.bulbX) * t) / span;
          const y = layout.bulbY + ((portal.y - layout.bulbY) * t) / span;
          if (pointInFamilyEgg(family, x, y)) break;
          let near = false;
          for (const dot of dots) {
            if (Math.hypot(dot.x - x, dot.y - y) <= SCENE_LED_GRID.step * 1.6) {
              near = true;
              break;
            }
          }
          assert.ok(near, `family ${family} aim ${aim} beam hole at ${t.toFixed(1)}`);
        }

        let aimX = 0;
        let aimY = 0;
        for (const spot of spots) {
          aimX += spot.x;
          aimY += spot.y;
        }
        aimX /= spots.length;
        aimY /= spots.length;
        const center = Math.atan2(aimY - layout.bulbY, aimX - layout.bulbX);
        let minRel = Number.POSITIVE_INFINITY;
        let maxRel = Number.NEGATIVE_INFINITY;
        for (const spot of spots) {
          const rel = wrapAngle(Math.atan2(spot.y - layout.bulbY, spot.x - layout.bulbX) - center);
          if (rel < minRel) minRel = rel;
          if (rel > maxRel) maxRel = rel;
        }
        let revealed = 0;
        for (const dot of corridor) {
          const dist = Math.hypot(dot.x - layout.bulbX, dot.y - layout.bulbY);
          const rel = wrapAngle(Math.atan2(dot.y - layout.bulbY, dot.x - layout.bulbX) - center);
          const pad = Math.atan((SCENE_LED_GRID.step * 3) / Math.max(dist, SCENE_LED_GRID.step));
          assert.ok(
            rel >= minRel - pad && rel <= maxRel + pad,
            `family ${family} aim ${aim} corridor left the aperture`,
          );
          if (
            rayReachesReveal(
              family,
              aim,
              layout.bulbX,
              layout.bulbY,
              dot.x - layout.bulbX,
              dot.y - layout.bulbY,
            )
          ) {
            revealed += 1;
          }
        }
        assert.ok(
          revealed / corridor.length >= 0.75,
          `family ${family} aim ${aim} shell rays ${corridor.length - revealed}/${corridor.length}`,
        );

        const above = nearestGrid(layout.bulbX, 12);
        const beyond = nearestGrid(16, layout.bulbY);
        const behind = nearestGrid(layout.railX + 8, layout.bulbY);
        const keys = new Set(dots.map((dot) => `${dot.x},${dot.y}`));
        assert.equal(keys.has(`${above.x},${above.y}`), false);
        assert.equal(pointInFamilyEgg(family, beyond.x, beyond.y), false);
        assert.equal(keys.has(`${beyond.x},${beyond.y}`), false);
        assert.equal(keys.has(`${behind.x},${behind.y}`), false);
      }
    }
  });
});

describe("scene viewport is wired through one definition", () => {
  test("canvas, svg, css and drag inverse share the incubation scene", () => {
    const app = fs.readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const css = fs.readFileSync(new URL("../src/style.css", import.meta.url), "utf8");
    assert.equal(app.includes("positionForRailY"), false);
    assert.match(app, /width="\$\{INCUBATION_SCENE\.width\}" height="\$\{INCUBATION_SCENE\.height\}"/);
    assert.match(app, /viewBox="0 0 \$\{INCUBATION_SCENE\.width\} \$\{INCUBATION_SCENE\.height\}"/);
    assert.match(app, /positionForSceneRailY\(railYFromEvent\(e\)\)/);
    assert.match(app, /positionForSceneRailY\(sceneYFromClientY\(clientY\)\)/);
    assert.match(app, /sceneYFromClientY/);
    assert.match(app, /lampArtSampleBounds\(layout\)/);
    assert.match(app, /sceneRailGeometry\(layout\)/);
    assert.match(app, /setPointerCapture\(e\.pointerId\)/);
    assert.match(app, /handleAimLamp\(-100, true\)/);
    assert.match(app, /handleAimLamp\(100, true\)/);
    assert.match(app, /ArrowUp: -step/);
    assert.match(app, /PageUp: -25/);
    assert.match(app, /for \(const ev of \["pointerup", "pointercancel", "lostpointercapture"\]\)/);
    assert.match(app, /window\.addEventListener\("pointercancel"/);
    assert.match(app, /void handleAimLamp\(railDragAim, true\)/);
    assert.match(app, /void handleAimLamp\(stageDragAim, true\)/);
    assert.match(app, /if \(e\.isTrusted\) \(el as HTMLElement\)\.setPointerCapture\(e\.pointerId\)/);
    assert.match(app, /const drawPortrait = shouldDrawPortrait\(/);
    const redrawStart = app.indexOf("function redrawStageCanvas(");
    const redraw = app.slice(redrawStart, app.indexOf("async function apiFetch<", redrawStart));
    assert.equal(redraw.includes("_drawCore"), false);
    assert.match(redraw, /if \(drawPortrait\) \{\s*stageAdapter\.draw\(state\);/);
    const aimStart = app.indexOf("async function handleAimLamp(");
    const aim = app.slice(aimStart, app.indexOf("function applyAcceptedRankedDisplay(", aimStart));
    assert.equal(aim.includes("_drawCore"), false);
    assert.match(aim, /redrawStageCanvas\(\)/);
    assert.match(app, /id="led-stage-canvas" width="1600" height="1600"/);
    assert.match(
      css,
      new RegExp(`aspect-ratio:\\s*${INCUBATION_SCENE.width}\\s*/\\s*${INCUBATION_SCENE.height}`),
    );
    assert.match(css, /\.led-canvas-wrap\.led-portrait-square\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/);
    assert.doesNotMatch(css, /\.rail-hit\s*\{[^}]*right:\s*0/);
    assert.doesNotMatch(css, /\.lamp-handle\s*\{[^}]*width:\s*32px/);
    assert.doesNotMatch(css, /\.lamp-handle\s*\{[^}]*width:\s*36px/);
  });

  test("an unchanged character is not redrawn when the lamp moves", () => {
    const key = portraitVisualKey({
      family: 1,
      levels: [4, 5, 6],
      palette: 2,
      accessory: 1,
      background: 3,
    });
    assert.equal(
      shouldDrawPortrait({
        previousKey: key,
        nextKey: key,
        routeVisible: true,
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: true,
      }),
      false,
    );
    assert.equal(
      shouldDrawPortrait({
        previousKey: key,
        nextKey: portraitVisualKey({
          family: 1,
          levels: [4, 6, 6],
          palette: 2,
          accessory: 1,
          background: 3,
        }),
        routeVisible: true,
        canvasFullyHidden: true,
        pixelsSampledWhileHidden: true,
      }),
      true,
    );
  });
});
