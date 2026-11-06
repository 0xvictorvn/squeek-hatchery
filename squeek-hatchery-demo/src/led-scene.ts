/**
 * Incubation-scene geometry, visibility, lamp alignment, and LED-dot presentation helpers.
 * Pure where possible so Node regressions can exercise real layout inputs.
 */
import { LED_GRID, LED_PRESENTATION, regionWeights } from "./led-renderer.ts";
import { STAGE, clamp, lampGeometry, regionAt } from "./rules.ts";

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ScenePresentation {
  scale: number;
  x: number;
  y: number;
  footY: number;
}

export const EGG_SILHOUETTE = Object.freeze({
  cx: STAGE.cx,
  cy: STAGE.cy,
  rx: STAGE.rx,
  ry: STAGE.ry,
});

/**
 * One screen-space LED lattice for egg art, body, lamp, beam and spot.
 * Pitch matches the canonical portrait grid; phase is shared so layers cannot drift.
 */
export const SCENE_LED_GRID = Object.freeze({
  step: LED_GRID.step,
  radius: 2.15,
  phaseX: LED_GRID.x % LED_GRID.step,
  phaseY: LED_GRID.y % LED_GRID.step,
});

/** Approved heat-lamp art: bulb on the left, mounting joint on the right. */
export const LAMP_ART_PIVOT = Object.freeze({ u: 0.84, v: 0.5 });
export const LAMP_ART_BULB = Object.freeze({ u: 0.3, v: 0.5 });
export const LAMP_ART_STAGE_WIDTH = 108;

/** Per-family egg art silhouettes in stage space (pulse / relay pear / prism). */
const FAMILY_EGG = Object.freeze([
  { cx: 200, cy: 215, rx: 116, ry: 150, topTaper: 0.05 },
  { cx: 200, cy: 216, rx: 112, ry: 152, topTaper: 0.16 },
  { cx: 200, cy: 215, rx: 114, ry: 150, topTaper: 0.06 },
] as const);

/**
 * Master-canvas anatomical extremes taken from the portrait renderer pose
 * (ears, crest, shoulders, feet, tail). Lower levels sit inside this envelope.
 */
const BODY_FIT_MARGIN = 0.94;

export interface ScenePoint {
  x: number;
  y: number;
}

function bodyLandmarks(
  family: 0 | 1 | 2,
  levels: [number, number, number],
): ScenePoint[] {
  const [head, middle, lower] = levels;
  const earSpread = (family === 0 ? 200 : family === 1 ? 176 : 184) - (10 - head) * 3;
  const earY = 80 + (10 - head) * 7;
  const shoulder = 140 + (10 - middle) * 5;
  const footY = 800 - (10 - lower) * 2;
  const tailX = lower >= 8 ? 670 - (10 - lower) * 4 : 610;
  return [
    { x: 400 - earSpread, y: earY },
    { x: 400 + earSpread, y: earY },
    { x: 400, y: head >= 10 ? 130 : 170 },
    { x: shoulder, y: 530 },
    { x: 800 - shoulder, y: 530 },
    { x: 315, y: footY },
    { x: 485, y: footY },
    { x: tailX, y: 710 },
  ];
}

function pointInFamilyEggRaw(
  family: 0 | 1 | 2,
  x: number,
  y: number,
  margin: number,
): boolean {
  const egg = FAMILY_EGG[family]!;
  const dx = x - egg.cx;
  const dy = y - egg.cy;
  const taper = dy < 0 ? 1 - egg.topTaper * Math.min(1, -dy / egg.ry) : 1;
  const rx = egg.rx * margin * Math.max(0.2, taper);
  const ry = egg.ry * margin;
  return (dx / rx) ** 2 + (dy / ry) ** 2 <= 1;
}

function largestBodyScale(): number {
  const extremes: ScenePoint[] = [];
  for (const family of [0, 1, 2] as const) {
    extremes.push(...bodyLandmarks(family, [10, 10, 10]));
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of extremes) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  let lo = 0.05;
  let hi = 0.55;
  const fits = (scale: number) => {
    for (const point of extremes) {
      const x = STAGE.cx + (point.x - cx) * scale;
      const y = STAGE.cy + (point.y - cy) * scale;
      for (const family of [0, 1, 2] as const) {
        if (!pointInFamilyEggRaw(family, x, y, BODY_FIT_MARGIN)) return false;
      }
    }
    return true;
  };
  for (let i = 0; i < 28; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo * 0.992;
}

const BODY_PLACEMENT = (() => {
  const extremes: ScenePoint[] = [];
  for (const family of [0, 1, 2] as const) {
    extremes.push(...bodyLandmarks(family, [10, 10, 10]));
  }
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of extremes) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const scale = largestBodyScale();
  const originX = STAGE.cx - cx * scale;
  const originY = STAGE.cy - cy * scale;
  const presentation: ScenePresentation = {
    scale,
    x: originX,
    y: originY,
    footY: originY + 780 * scale,
  };
  return Object.freeze({ scale, originX, originY, cx, cy, presentation });
})();

/** Stable incubation transform. Level changes do not move or rescale the body. */
export function incubationBodyPlacement(): {
  scale: number;
  originX: number;
  originY: number;
  presentation: ScenePresentation;
} {
  return BODY_PLACEMENT;
}

export const INCUBATION_LED_PRESENTATION = BODY_PLACEMENT.presentation;

export function masterToStage(masterX: number, masterY: number): ScenePoint {
  return {
    x: BODY_PLACEMENT.originX + masterX * BODY_PLACEMENT.scale,
    y: BODY_PLACEMENT.originY + masterY * BODY_PLACEMENT.scale,
  };
}

export function stageToMaster(stageX: number, stageY: number): ScenePoint {
  return {
    x: (stageX - BODY_PLACEMENT.originX) / BODY_PLACEMENT.scale,
    y: (stageY - BODY_PLACEMENT.originY) / BODY_PLACEMENT.scale,
  };
}

/**
 * Major region chosen by LedPortraitAdapter._drawCore from regionWeights.
 * Interior, shell, beam and pulse all use this field.
 */
function majorAnatomicalRegion(masterX: number, masterY: number): 0 | 1 | 2 {
  const weights = regionWeights(masterX, masterY);
  if (weights[0] >= weights[1] && weights[0] >= weights[2]) return 0;
  if (weights[1] >= weights[2]) return 1;
  return 2;
}

interface StageRegionFrame {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Aim point and extent of each compositor region where it meets every family egg. */
function deriveStageRegionFrames(): readonly [StageRegionFrame, StageRegionFrame, StageRegionFrame] {
  const bins = [0, 1, 2].map(() => ({
    count: 0,
    sumX: 0,
    sumY: 0,
    minX: Infinity,
    maxX: -Infinity,
    minY: Infinity,
    maxY: -Infinity,
    aimX: STAGE.cx as number,
    aimY: STAGE.cy as number,
    aimD: Infinity,
  }));
  for (let pass = 0; pass < 2; pass++) {
    for (let masterY = 40; masterY <= 840; masterY += 4) {
      for (let masterX = 60; masterX <= 760; masterX += 4) {
        const stage = masterToStage(masterX, masterY);
        let inside = true;
        for (const family of [0, 1, 2] as const) {
          if (!pointInFamilyEggRaw(family, stage.x, stage.y, 0.995)) {
            inside = false;
            break;
          }
        }
        if (!inside) continue;
        const region = majorAnatomicalRegion(masterX, masterY);
        const bin = bins[region]!;
        if (pass === 0) {
          bin.count += 1;
          bin.sumX += stage.x;
          bin.sumY += stage.y;
          if (stage.x < bin.minX) bin.minX = stage.x;
          if (stage.x > bin.maxX) bin.maxX = stage.x;
          if (stage.y < bin.minY) bin.minY = stage.y;
          if (stage.y > bin.maxY) bin.maxY = stage.y;
        } else if (bin.count > 0) {
          const meanX = bin.sumX / bin.count;
          const meanY = bin.sumY / bin.count;
          const distance = (stage.x - meanX) ** 2 + (stage.y - meanY) ** 2;
          if (distance < bin.aimD) {
            bin.aimD = distance;
            bin.aimX = stage.x;
            bin.aimY = stage.y;
          }
        }
      }
    }
  }
  const frames = bins.map((bin) => {
    if (bin.count === 0) return { cx: STAGE.cx, cy: STAGE.cy, rx: 1, ry: 1 };
    return {
      cx: bin.aimX,
      cy: bin.aimY,
      rx: Math.max(bin.aimX - bin.minX, bin.maxX - bin.aimX, 1) + SCENE_LED_GRID.step,
      ry: Math.max(bin.aimY - bin.minY, bin.maxY - bin.aimY, 1) + SCENE_LED_GRID.step,
    };
  });
  return [frames[0]!, frames[1]!, frames[2]!];
}

const STAGE_REGION_FRAMES = Object.freeze(deriveStageRegionFrames());

export function stageRegionAnchor(region: 0 | 1 | 2): StageRegionFrame {
  return STAGE_REGION_FRAMES[region]!;
}

export const REGION_ANCHORS: readonly {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}[] = Object.freeze([stageRegionAnchor(0), stageRegionAnchor(1), stageRegionAnchor(2)]);

export type SceneSessionStatus = "egg" | "running" | "paused" | "completed";

export interface InteriorVisibilityInput {
  status: SceneSessionStatus;
  hardwareHealthy: boolean;
  effectivePower: number;
  interrupted?: boolean;
}

export interface RevealWindow {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  open: boolean;
  region: 0 | 1 | 2;
}

export interface LampMountLayout {
  railX: number;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  angle: number;
  bulbX: number;
  bulbY: number;
  /** Handle/hit target centered on the lamp mount (not a detached rail knob). */
  handleX: number;
  handleY: number;
  handleSize: number;
}

export function pointInFamilyEgg(
  family: 0 | 1 | 2,
  x: number,
  y: number,
  margin = 1,
): boolean {
  return pointInFamilyEggRaw(family, x, y, margin);
}

export function eggContainsPoint(x: number, y: number, egg = EGG_SILHOUETTE): boolean {
  const dx = (x - egg.cx) / egg.rx;
  const dy = (y - egg.cy) / egg.ry;
  return dx * dx + dy * dy <= 1;
}

export function clampPointToEgg(
  x: number,
  y: number,
  egg = EGG_SILHOUETTE,
  inset = 0.92,
): { x: number; y: number } {
  const dx = x - egg.cx;
  const dy = y - egg.cy;
  const nx = dx / (egg.rx * inset);
  const ny = dy / (egg.ry * inset);
  const d2 = nx * nx + ny * ny;
  if (d2 <= 1) return { x, y };
  const s = 1 / Math.sqrt(d2);
  return {
    x: egg.cx + dx * s,
    y: egg.cy + dy * s,
  };
}

export function interiorPixelsOpen(input: InteriorVisibilityInput): boolean {
  if (input.status === "completed") return true;
  if (input.status !== "running") return false;
  if (input.interrupted) return false;
  if (!input.hardwareHealthy) return false;
  return input.effectivePower > 0;
}

export function positionForRegionAim(region: 0 | 1 | 2): number {
  // Matches regionAt bands: Head < -33, Middle [-33,33], Belly > 33
  if (region === 0) return -70;
  if (region === 1) return 0;
  return 70;
}

/**
 * Contact point and extent of the aimed compositor region.
 * Pixel visibility is the regionWeights mask; this frame only aims the beam and level-up pulse.
 */
export function computeRevealWindow(
  lampPosition: number,
  open: boolean,
  _egg = EGG_SILHOUETTE,
): RevealWindow {
  const region = regionAt(lampPosition) as 0 | 1 | 2;
  const anchor = stageRegionAnchor(region);
  if (!open) {
    return { cx: anchor.cx, cy: anchor.cy, rx: 0, ry: 0, open: false, region };
  }
  return {
    cx: anchor.cx,
    cy: anchor.cy,
    rx: anchor.rx,
    ry: anchor.ry,
    open: true,
    region,
  };
}

/**
 * Fraction of this family's in-egg compositor region that the live opening shows.
 * Samples the same master domain as LedPortraitAdapter._drawCore.
 */
export function regionRevealCoverageRatio(
  lampPosition: number,
  open = true,
  samples = 48,
  family: 0 | 1 | 2 = 0,
): number {
  const region = regionAt(lampPosition) as 0 | 1 | 2;
  if (!open) return 0;
  const steps = Math.max(2, Math.floor(samples));
  let regionPts = 0;
  let covered = 0;
  const x0 = 12;
  const x1 = 788;
  const y0 = 8;
  const y1 = 850;
  for (let iy = 0; iy < steps; iy++) {
    const masterY = y0 + ((iy + 0.5) / steps) * (y1 - y0);
    for (let ix = 0; ix < steps; ix++) {
      const masterX = x0 + ((ix + 0.5) / steps) * (x1 - x0);
      if (majorAnatomicalRegion(masterX, masterY) !== region) continue;
      const stage = masterToStage(masterX, masterY);
      if (!pointInFamilyEgg(family, stage.x, stage.y)) continue;
      regionPts += 1;
      if (interiorVisibleAt(family, stage.x, stage.y, true, lampPosition)) covered += 1;
    }
  }
  return regionPts === 0 ? 0 : covered / regionPts;
}

/** Aimed compositor region, and only that region, is visible inside the family egg. */
export function interiorVisibleAt(
  family: 0 | 1 | 2,
  x: number,
  y: number,
  open: boolean,
  lampPosition: number,
): boolean {
  if (!open) return false;
  if (!pointInFamilyEgg(family, x, y)) return false;
  const master = stageToMaster(x, y);
  return majorAnatomicalRegion(master.x, master.y) === (regionAt(lampPosition) as 0 | 1 | 2);
}

/** Shell dots exist only on the silhouette. The reveal opening removes them. */
export function shellDotVisibleAt(
  family: 0 | 1 | 2,
  x: number,
  y: number,
  open: boolean,
  lampPosition: number,
): boolean {
  if (!pointInFamilyEgg(family, x, y, 0.995)) return false;
  if (interiorVisibleAt(family, x, y, open, lampPosition)) return false;
  return true;
}

export function computeLampMountLayout(lampPosition: number, railX = 372): LampMountLayout {
  const g = lampGeometry(lampPosition, railX);
  const rad = (g.angle * Math.PI) / 180;
  const bulbReach = (LAMP_ART_PIVOT.u - LAMP_ART_BULB.u) * LAMP_ART_STAGE_WIDTH;
  return {
    railX,
    sourceX: g.sourceX,
    sourceY: g.sourceY,
    targetX: g.targetX,
    targetY: g.targetY,
    angle: g.angle,
    bulbX: g.sourceX + Math.cos(rad) * bulbReach,
    bulbY: g.sourceY + Math.sin(rad) * bulbReach,
    handleX: g.sourceX,
    handleY: g.sourceY,
    handleSize: 44,
  };
}

/** Mount, drag target and bulb share the rail joint and the aim direction. */
export function lampAnchorsMatch(layout: LampMountLayout): boolean {
  if (Math.abs(layout.sourceX - layout.railX) > 0.51) return false;
  if (Math.abs(layout.handleX - layout.sourceX) > 0.51) return false;
  if (Math.abs(layout.handleY - layout.sourceY) > 0.51) return false;
  const bulbDx = layout.bulbX - layout.sourceX;
  const bulbDy = layout.bulbY - layout.sourceY;
  const targetDx = layout.targetX - layout.sourceX;
  const targetDy = layout.targetY - layout.sourceY;
  if (bulbDx * targetDx + bulbDy * targetDy <= 0) return false;
  const bulbToTarget = Math.hypot(layout.bulbX - layout.targetX, layout.bulbY - layout.targetY);
  const mountToTarget = Math.hypot(targetDx, targetDy);
  return bulbToTarget < mountToTarget;
}

export function stagePointToLampImage(
  stageX: number,
  stageY: number,
  layout: LampMountLayout,
  imageWidth: number,
  imageHeight: number,
): ScenePoint | null {
  if (imageWidth <= 0 || imageHeight <= 0) return null;
  const scale = LAMP_ART_STAGE_WIDTH / imageWidth;
  const angle = (layout.angle * Math.PI) / 180 - Math.PI;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const dx = (stageX - layout.sourceX) / scale;
  const dy = (stageY - layout.sourceY) / scale;
  const localX = dx * cos + dy * sin;
  const localY = -dx * sin + dy * cos;
  const imageX = localX + LAMP_ART_PIVOT.u * imageWidth;
  const imageY = localY + LAMP_ART_PIVOT.v * imageHeight;
  if (imageX < 0 || imageY < 0 || imageX >= imageWidth || imageY >= imageHeight) return null;
  return { x: imageX, y: imageY };
}

export function incubationControlsVisible(status: SceneSessionStatus): boolean {
  return status !== "completed";
}

/**
 * The canonical portrait canvas stays hidden during incubation. Reveal is painted
 * on the shared scene grid, so a stale CSS clip cannot leave interior pixels up.
 */
export function stageCanvasClipPath(
  status: SceneSessionStatus,
  _open: boolean,
  _lampPosition: number,
): { clipPath: string; visibility: "visible" | "hidden"; opacity: string } {
  if (status === "completed") {
    return { clipPath: "none", visibility: "visible", opacity: "1" };
  }
  return {
    clipPath: "ellipse(0% 0% at 50% 50%)",
    visibility: "hidden",
    opacity: "0",
  };
}

/** Mapped stage bounds of this family's anatomical landmarks. */
export function incubationBodyEnvelope(
  levels: [number, number, number],
  _presentation: ScenePresentation = INCUBATION_LED_PRESENTATION,
  family: 0 | 1 | 2 = 0,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = bodyLandmarks(family, levels).map((point) => masterToStage(point.x, point.y));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  return { minX, maxX, minY, maxY };
}

/** Map LED-frame coords (800×800 crop) into stage viewBox units. */
export function ledFrameToStage(x: number, y: number): { x: number; y: number } {
  return {
    x: (x / 800) * STAGE.w,
    y: (y / 800) * STAGE.h,
  };
}

export function bodyFitsInsideEgg(
  levels: [number, number, number],
  family?: 0 | 1 | 2,
): boolean {
  const families: readonly (0 | 1 | 2)[] = family === undefined ? [0, 1, 2] : [family];
  for (const item of families) {
    for (const point of bodyLandmarks(item, levels)) {
      const stage = masterToStage(point.x, point.y);
      if (!pointInFamilyEgg(item, stage.x, stage.y, BODY_FIT_MARGIN)) return false;
    }
  }
  return true;
}

export function presentationForStage(status: SceneSessionStatus): ScenePresentation {
  return status === "completed" ? LED_PRESENTATION : INCUBATION_LED_PRESENTATION;
}

export function dotOnSceneGrid(x: number, y: number, epsilon = 0.02): boolean {
  const sx = (x - SCENE_LED_GRID.phaseX) / SCENE_LED_GRID.step;
  const sy = (y - SCENE_LED_GRID.phaseY) / SCENE_LED_GRID.step;
  return Math.abs(sx - Math.round(sx)) <= epsilon && Math.abs(sy - Math.round(sy)) <= epsilon;
}

export function forEachSceneLed(
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  visit: (x: number, y: number) => void,
): void {
  const { step, phaseX, phaseY } = SCENE_LED_GRID;
  const x0 = phaseX + Math.ceil((bounds.minX - phaseX) / step) * step;
  const y0 = phaseY + Math.ceil((bounds.minY - phaseY) / step) * step;
  for (let y = y0; y <= bounds.maxY + 1e-6; y += step) {
    for (let x = x0; x <= bounds.maxX + 1e-6; x += step) visit(x, y);
  }
}

export function eggArtDestination(family: 0 | 1 | 2): { x: number; y: number; size: number } {
  const egg = FAMILY_EGG[family]!;
  const size = Math.max((egg.rx * 2) / 0.72, (egg.ry * 2) / 0.86);
  return { x: egg.cx - size / 2, y: egg.cy - size / 2, size };
}

/** Sample an ImageData into LED dots matching the hamster grid pitch/radius. */
export function sampleLedDotsFromImageData(
  data: Uint8ClampedArray | RgbaImage,
  width?: number,
  height?: number,
  options: {
    step?: number;
    radius?: number;
    phaseX?: number;
    phaseY?: number;
    minAlpha?: number;
  } = {},
): { x: number; y: number; r: number; g: number; b: number; a: number }[] {
  const pixels = data instanceof Uint8ClampedArray ? data : data.data;
  const w = data instanceof Uint8ClampedArray ? (width ?? 0) : data.width;
  const h = data instanceof Uint8ClampedArray ? (height ?? 0) : data.height;
  const step = options.step ?? LED_GRID.step;
  const phaseX = options.phaseX ?? LED_GRID.x;
  const phaseY = options.phaseY ?? LED_GRID.y;
  const minAlpha = options.minAlpha ?? 0.35;
  const dots: { x: number; y: number; r: number; g: number; b: number; a: number }[] = [];
  for (let y = phaseY; y < h; y += step) {
    for (let x = phaseX; x < w; x += step) {
      let a = 0,
        r = 0,
        g = 0,
        b = 0;
      for (const [dx, dy] of [
        [-1, -1],
        [1, -1],
        [-1, 1],
        [1, 1],
      ] as const) {
        const sx = clamp(x + dx, 0, w - 1);
        const sy = clamp(y + dy, 0, h - 1);
        const i = (sy * w + sx) * 4;
        const alpha = pixels[i + 3]! / 255;
        a += alpha;
        r += pixels[i]! * alpha;
        g += pixels[i + 1]! * alpha;
        b += pixels[i + 2]! * alpha;
      }
      if (a < minAlpha) continue;
      dots.push({
        x,
        y,
        r: r / a,
        g: g / a,
        b: b / a,
        a: Math.min(1, a / 4),
      });
    }
  }
  return dots;
}

/** Warm LED beam and spot on the shared scene lattice. No smooth cone. */
export function sampleLedBeamDots(
  layout: LampMountLayout,
  lampPosition: number,
  open: boolean,
  power: number,
  family: 0 | 1 | 2 = 0,
): { x: number; y: number; r: number; g: number; b: number; a: number }[] {
  if (!open || power <= 0) return [];
  const reveal = computeRevealWindow(lampPosition, true);
  const dots: { x: number; y: number; r: number; g: number; b: number; a: number }[] = [];
  const intensity = 0.35 + 0.55 * clamp(power, 0, 1);
  const x0 = layout.bulbX;
  const y0 = layout.bulbY;
  const x1 = reveal.cx;
  const y1 = reveal.cy;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const egg = FAMILY_EGG[family]!;
  const minX = Math.min(x0, egg.cx - egg.rx) - SCENE_LED_GRID.step;
  const maxX = Math.max(x0, egg.cx + egg.rx) + SCENE_LED_GRID.step;
  const minY = Math.min(y0, egg.cy - egg.ry) - SCENE_LED_GRID.step;
  const maxY = Math.max(y0, egg.cy + egg.ry) + SCENE_LED_GRID.step;

  forEachSceneLed({ minX, minY, maxX, maxY }, (x, y) => {
    const along = ((x - x0) * ux + (y - y0) * uy) / len;
    const lateral = Math.abs((x - x0) * -uy + (y - y0) * ux);
    const half = 4 + clamp(along, 0, 1) * Math.max(reveal.rx, reveal.ry) * 0.55;
    const inCorridor = along >= -0.05 && along <= 1.02 && lateral <= half;
    const inSpot = interiorVisibleAt(family, x, y, true, lampPosition);
    if (pointInFamilyEgg(family, x, y)) {
      if (!inSpot) return;
    } else if (!inCorridor || along > 0.72) {
      return;
    }
    const radial = Math.hypot(
      (x - reveal.cx) / Math.max(reveal.rx, 1),
      (y - reveal.cy) / Math.max(reveal.ry, 1),
    );
    const edge = inSpot ? 1 - 0.22 * clamp(radial, 0, 1) : 1 - lateral / half;
    const a = intensity * clamp(edge, 0, 1) * (inSpot ? 0.72 : 0.48);
    if (a < 0.08) return;
    dots.push({ x, y, r: inSpot ? 253 : 251, g: inSpot ? 224 : 191, b: inSpot ? 71 : 36, a });
  });
  return dots;
}

export function paintLedDots(
  ctx: CanvasRenderingContext2D,
  dots: { x: number; y: number; r: number; g: number; b: number; a: number }[],
  radius: number = LED_GRID.radius,
): void {
  for (const d of dots) {
    ctx.fillStyle = `rgba(${Math.round(d.r)},${Math.round(d.g)},${Math.round(d.b)},${d.a})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Build a soft 3D LED egg from a procedural shell (Node-safe; no DOM ImageData). */
export function buildProceduralEggImageData(
  width: number,
  height: number,
  familyIndex: 0 | 1 | 2,
): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const egg = {
    cx: width * 0.5,
    cy: height * 0.52,
    rx: width * 0.38,
    ry: height * 0.46,
  };
  const accents =
    familyIndex === 0
      ? [34, 211, 238]
      : familyIndex === 1
        ? [52, 211, 153]
        : [167, 139, 250];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - egg.cx) / egg.rx;
      const dy = (y - egg.cy) / egg.ry;
      const d2 = dx * dx + dy * dy;
      if (d2 > 1) continue;
      const z = Math.sqrt(Math.max(0, 1 - d2));
      const light = 0.35 + 0.55 * (0.55 * z + 0.45 * (1 - (dx * 0.4 + dy * 0.35 + 0.2)));
      const shellR = Math.round(245 * light);
      const shellG = Math.round(228 * light);
      const shellB = Math.round(200 * light);
      const crack = Math.abs(Math.sin(dx * 9 + dy * 4)) > 0.92 && z > 0.2;
      const i = (y * width + x) * 4;
      data[i] = crack ? accents[0]! : shellR;
      data[i + 1] = crack ? accents[1]! : shellG;
      data[i + 2] = crack ? accents[2]! : shellB;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

export function buildProceduralLampImageData(width: number, height: number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const cx = width * 0.62;
  const cy = height * 0.5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = (x - cx) / (width * 0.28);
      const dy = (y - cy) / (height * 0.22);
      const bell = dx * dx + dy * dy;
      const arm = Math.abs(y - cy) < height * 0.06 && x > cx && x < width * 0.95;
      const bulb = (x - (cx - width * 0.18)) ** 2 / (width * 0.08) ** 2 + dy * dy < 1;
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      if (bell < 1) {
        const z = Math.sqrt(Math.max(0, 1 - bell));
        r = Math.round(210 + 30 * z);
        g = Math.round(170 + 40 * z);
        b = Math.round(110 + 20 * z);
        a = 255;
      } else if (bulb) {
        r = 251;
        g = 191;
        b = 36;
        a = 255;
      } else if (arm) {
        r = 180;
        g = 140;
        b = 70;
        a = 255;
      }
      if (!a) continue;
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
  return { width, height, data };
}

export function accountPopoverStyle(
  viewportWidth: number,
  anchorRight: number,
  popoverWidth = 290,
  margin = 8,
): { left: string; right: string; width: string; maxWidth: string } {
  const maxW = Math.min(popoverWidth, Math.max(160, viewportWidth - margin * 2));
  // Prefer aligning to the account button's right edge; clamp into the viewport.
  let left = anchorRight - maxW;
  if (left < margin) left = margin;
  if (left + maxW > viewportWidth - margin) left = Math.max(margin, viewportWidth - margin - maxW);
  return {
    left: `${Math.round(left)}px`,
    right: "auto",
    width: `${Math.round(maxW)}px`,
    maxWidth: `calc(100vw - ${margin * 2}px)`,
  };
}

export type StageDrawMode = "incubation" | "portrait";

export function stageDrawModeForStatus(status: SceneSessionStatus): StageDrawMode {
  return status === "completed" ? "portrait" : "incubation";
}
