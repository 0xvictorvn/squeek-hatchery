import {
  FAMILIES,
  LED_ACCESSORIES,
  LED_BACKGROUNDS,
  LED_STAGE_DESCRIPTIONS,
  PALETTES,
} from "./game-policy.ts";

const W = 800;
const H = 860;
const KEYS = [0, 2, 5, 8, 10] as const;

export const LED_FRAME = Object.freeze({
  x: 0,
  y: 30,
  width: 800,
  height: 800,
  exportSize: 1600,
});

export const LED_GRID = Object.freeze({
  step: 6,
  radius: 2.5,
  x: 17,
  y: 9,
});

export const LED_PRESENTATION = Object.freeze({
  scale: 0.83,
  x: 68,
  y: 112.6,
  footY: 760,
});

export interface LedRenderState {
  family: 0 | 1 | 2;
  regionFamilies?: [number, number, number];
  levels: [number, number, number];
  palette: number; // 0..9
  accessory: number; // -1..9
  background: number; // -1..9
}

export interface LedRenderStatus {
  ready: boolean;
  disposed: boolean;
  animating: boolean;
  warning: string | null;
  lastDurationMs: number;
}

const smooth = (a: number, b: number, v: number): number => {
  const t = Math.max(0, Math.min(1, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

const clampNum = (x: number, a: number, b: number): number =>
  Math.max(a, Math.min(b, x));

const hexCache = new Map<string, [number, number, number]>();
function rgb(hex: string): [number, number, number] {
  let cached = hexCache.get(hex);
  if (!cached) {
    const clean = hex.replace("#", "");
    cached = [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
    hexCache.set(hex, cached);
  }
  return cached;
}

const mix = (
  a: readonly [number, number, number] | number[],
  b: readonly [number, number, number] | number[],
  t: number,
): [number, number, number] => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

const toneHex = (hex: string, target: string, t: number): string =>
  "#" +
  rgb(hex)
    .map((v, i) =>
      Math.round(v + (rgb(target)[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");

export function configureLedCanvas(
  canvas: HTMLCanvasElement,
  size: number = LED_FRAME.exportSize,
): CanvasRenderingContext2D {
  canvas.width = size;
  canvas.height = size;
  const g = canvas.getContext("2d")!;
  const scale = size / LED_FRAME.width;
  g.setTransform(
    scale,
    0,
    0,
    scale,
    -LED_FRAME.x * scale,
    -LED_FRAME.y * scale,
  );
  return g;
}

interface BaseFit {
  face: [number, number];
  neck: [number, number];
  flower: [number, number];
  crown: [number, number];
  eyeSpan: number;
  feet: [[number, number], [number, number]];
}

interface HandFit {
  center: [number, number];
  wrist: [number, number];
  angle: number;
  contour: [number, number][];
  minU: number;
  maxU: number;
  minV: number;
  maxV: number;
  rx: number;
  ry: number;
  area: number;
}

interface WearPose {
  hands: [HandFit | null, HandFit | null];
  paws: [[number, number], [number, number]];
  center: number;
  neckY: number;
  neckScale: number;
  headTop: number;
  earTop: number;
  ear: { x: number; y: number; angle: number };
}

interface WearLightCache {
  id: number;
  led: HTMLCanvasElement;
  halo: HTMLCanvasElement;
  points: [number, number, string][];
  cyan: string;
}

// Shared decoded asset caches across adapter lifecycles so we never re-decode large PNGs unnecessarily
let sharedBaseLoaded = false;
let sharedBasePath = "";
let sharedBasePending: Promise<void> | null = null;
let sharedBaseArt: Uint8ClampedArray[] = [];
let sharedBaseFits: BaseFit[] = [];
let sharedBaseTextures: HTMLCanvasElement[] = [];

const sharedStageArt: (Uint8ClampedArray[] | null)[] = [null, null, null];
const sharedStagePaths: string[] = ["", "", ""];
const sharedStagePending: (Promise<void> | null)[] = [null, null, null];
const sharedBaseHipWidths: (Float32Array | null)[] = [null, null, null];

const sharedBgImages = new Map<number, HTMLImageElement>();
const sharedBgPaths = new Map<number, string>();
const sharedBgPending = new Map<number, Promise<HTMLImageElement>>();

async function decodeImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = url;
  await img.decode();
  return img;
}

function defaultFits(): BaseFit[] {
  return [0, 1, 2].map((f) => ({
    face: [400, 336],
    neck: [400, 482],
    flower: [f === 0 ? 529 : 552, f === 0 ? 166 : 153],
    crown: [400, 226],
    eyeSpan: 148,
    feet: [
      [300, 757],
      [500, 757],
    ],
  }));
}

function buildFallbackFamilyArt(family: number): Uint8ClampedArray {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Soft lilac-tinted base silhouette on the exact anatomical coordinates
  g.fillStyle = "#b29cde";
  // Ears
  for (const s of [-1, 1]) {
    g.save();
    g.translate(400, 0);
    g.scale(s, 1);
    g.beginPath();
    if (family === 0) g.ellipse(125, 176, 58, 72, -0.2, 0, Math.PI * 2);
    else if (family === 1) g.ellipse(130, 182, 54, 64, 0.25, 0, Math.PI * 2);
    else g.ellipse(132, 172, 62, 74, -0.35, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#e6a4be";
    g.beginPath();
    g.ellipse(125, 182, 34, 44, -0.15, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  // Head & body
  g.fillStyle = "#b29cde";
  g.beginPath();
  g.ellipse(400, 348, 178, 138, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(400, 600, 174, 172, 0, 0, Math.PI * 2);
  g.fill();
  // Cream belly & muzzle
  g.fillStyle = "#eee3ff";
  g.beginPath();
  g.ellipse(400, 398, 132, 82, 0, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.ellipse(400, 635, 126, 114, 0, 0, Math.PI * 2);
  g.fill();
  // Eyes (at 326, 474, y=336)
  g.fillStyle = "#17172e";
  for (const ex of [326, 474]) {
    g.beginPath();
    g.ellipse(ex, 336, 32, 38, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#ffffff";
    g.beginPath();
    g.ellipse(ex - 9, 322, 10, 12, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "#17172e";
  }
  // Paws & Feet (pink skin)
  g.fillStyle = "#f2a7c0";
  for (const px of [324, 476]) {
    g.beginPath();
    g.ellipse(px, 538, 28, 22, 0, 0, Math.PI * 2);
    g.fill();
  }
  for (const fx of [315, 485]) {
    g.beginPath();
    g.ellipse(fx, 760, 38, 20, 0, 0, Math.PI * 2);
    g.fill();
  }
  return g.getImageData(0, 0, W, H).data;
}

async function ensureBaseLoaded(basePath: string): Promise<void> {
  if (sharedBaseLoaded) {
    if (sharedBasePath === basePath) return;
    await decodeImage(`${basePath}families-v2.png`);
    return;
  }
  if (!sharedBasePending) {
    sharedBasePending = (async () => {
      const image = await decodeImage(`${basePath}families-v2.png`);
      const width = image.width / 3;
      const scratch = document.createElement("canvas");
      scratch.width = W;
      scratch.height = H;
      const s = scratch.getContext("2d", { willReadFrequently: true })!;
      const scans: {
        scan: HTMLCanvasElement;
        left: number;
        top: number;
        boxW: number;
        boxH: number;
      }[] = [];

      for (let f = 0; f < 3; f++) {
        const scan = document.createElement("canvas");
        scan.width = Math.floor(width);
        scan.height = image.height;
        const sg = scan.getContext("2d", { willReadFrequently: true })!;
        sg.drawImage(
          image,
          f * width,
          0,
          width,
          image.height,
          0,
          0,
          width,
          image.height,
        );
        const pixels = sg.getImageData(0, 0, scan.width, scan.height);
        const p = pixels.data;
        let left = scan.width,
          right = 0,
          top = scan.height,
          bottom = 0;
        for (let y = 0; y < scan.height; y++) {
          for (let x = 0; x < scan.width; x++) {
            const k = (y * scan.width + x) * 4;
            if (p[k + 3] > 180) {
              left = Math.min(left, x);
              right = Math.max(right, x);
              top = Math.min(top, y);
              bottom = Math.max(bottom, y);
            }
            p[k + 3] = 255 * smooth(155, 235, p[k + 3]);
          }
        }
        sg.putImageData(pixels, 0, 0);
        if (right <= left || bottom <= top) {
          throw new Error("Character atlas has an empty column");
        }
        scans.push({
          scan,
          left,
          top,
          boxW: right - left + 1,
          boxH: bottom - top + 1,
        });
      }

      const sharedScale = Math.min(
        700 / Math.max(...scans.map((v) => v.boxH)),
        620 / Math.max(...scans.map((v) => v.boxW)),
      );
      const landmarks = [
        { face: [395, 285], neck: [395, 409], flower: [490, 188] },
        { face: [365, 285], neck: [365, 409], flower: [485, 173] },
        { face: [330, 285], neck: [330, 409], flower: [460, 180] },
      ];
      const feet: [number, number][][] = [
        [
          [302, 635],
          [472, 635],
        ],
        [
          [278, 635],
          [448, 635],
        ],
        [
          [244, 635],
          [412, 635],
        ],
      ];

      sharedBaseFits = scans.map((box, f) => {
        const map = ([x, y]: number[]): [number, number] => [
          400 + (x - box.left - box.boxW / 2) * sharedScale,
          780 + (y - box.top - box.boxH) * sharedScale,
        ];
        return {
          face: map(landmarks[f].face),
          neck: map(landmarks[f].neck),
          flower: map(landmarks[f].flower),
          crown: map([landmarks[f].face[0], 219]),
          eyeSpan: 126 * sharedScale,
          feet: [map(feet[f][0]), map(feet[f][1])],
        };
      });

      const art: Uint8ClampedArray[] = [];
      for (const { scan, left, top, boxW, boxH } of scans) {
        const dw = boxW * sharedScale,
          dh = boxH * sharedScale,
          pad = 24;
        s.clearRect(0, 0, W, H);
        s.drawImage(
          scan,
          left - pad,
          top - pad,
          boxW + pad * 2,
          boxH + pad * 2,
          400 - dw / 2 - pad * sharedScale,
          780 - dh - pad * sharedScale,
          dw + pad * 2 * sharedScale,
          dh + pad * 2 * sharedScale,
        );
        art.push(s.getImageData(0, 0, W, H).data);
      }
      sharedBaseArt = art;
      sharedBaseTextures = art.map((data) => {
        const c = document.createElement("canvas");
        c.width = W;
        c.height = H;
        c.getContext("2d")!.putImageData(
          new ImageData(new Uint8ClampedArray(data), W, H),
          0,
          0,
        );
        return c;
      });
      sharedBaseLoaded = true;
      sharedBasePath = basePath;
    })().catch((err) => {
      sharedBasePending = null;
      throw err;
    });
  }
  return sharedBasePending;
}

async function ensureFamilyAtlasLoaded(
  family: number,
  basePath: string,
): Promise<void> {
  if (family < 0 || family > 2) return;
  if (sharedStageArt[family]) {
    if (sharedStagePaths[family] === basePath) return;
    const file = FAMILIES[family].atlasFile;
    await decodeImage(`${basePath}${file}`);
    return;
  }
  if (!sharedStagePending[family]) {
    sharedStagePending[family] = (async () => {
      const file = FAMILIES[family].atlasFile;
      const image = await decodeImage(`${basePath}${file}`);
      const cw = Math.floor(image.width / 3);
      const ch = Math.floor(image.height / 2);
      const frames: Uint8ClampedArray[] = [];
      for (let frame = 0; frame < 5; frame++) {
        const source = document.createElement("canvas");
        source.width = cw;
        source.height = ch;
        const s = source.getContext("2d", { willReadFrequently: true })!;
        s.drawImage(
          image,
          (frame % 3) * cw,
          Math.floor(frame / 3) * ch,
          cw,
          ch,
          0,
          0,
          cw,
          ch,
        );
        const sourcePixels = s.getImageData(0, 0, cw, ch);
        const p = sourcePixels.data;
        let bestY = 0,
          bestCount = 0;
        const dark = (x: number, y: number) => {
          const i = (y * cw + x) * 4;
          return p[i + 3] > 210 && Math.max(p[i], p[i + 1], p[i + 2]) < 105;
        };
        for (let y = Math.floor(ch * 0.31); y < ch * 0.54; y++) {
          let count = 0;
          for (let x = Math.floor(cw * 0.26); x < cw * 0.74; x++) {
            if (dark(x, y)) count++;
          }
          if (count > bestCount) {
            bestCount = count;
            bestY = y;
          }
        }
        const eyes: [number, number][] = [];
        for (const side of [-1, 1]) {
          let sumX = 0,
            sumY = 0,
            count = 0;
          const left = side < 0 ? cw * 0.23 : cw * 0.51;
          const right = side < 0 ? cw * 0.49 : cw * 0.77;
          for (
            let y = Math.max(0, bestY - 13);
            y < Math.min(ch, bestY + 14);
            y++
          ) {
            for (let x = Math.floor(left); x < right; x++) {
              if (dark(x, y)) {
                sumX += x;
                sumY += y;
                count++;
              }
            }
          }
          eyes.push(
            count
              ? [sumX / count, sumY / count]
              : [cw * (side < 0 ? 0.4 : 0.6), ch * 0.4],
          );
        }
        const eyeX = (eyes[0][0] + eyes[1][0]) / 2;
        const eyeY = (eyes[0][1] + eyes[1][1]) / 2;
        const gap = eyes[1][0] - eyes[0][0];
        if (gap < cw * 0.1 || gap > cw * 0.45) {
          throw new Error("Atlas eye alignment could not be read");
        }
        let baseline = 0;
        for (let y = Math.floor(ch * 0.7); y < ch; y++) {
          for (let x = Math.floor(cw * 0.25); x < cw * 0.75; x++) {
            if (p[(y * cw + x) * 4 + 3] > 220) baseline = Math.max(baseline, y);
          }
        }
        const scaleX = 148 / gap;
        const scaleY = 444 / (baseline - eyeY);
        for (let i = 3; i < p.length; i += 4) {
          p[i] = p[i] >= 200 ? 255 : 0;
        }
        s.putImageData(sourcePixels, 0, 0);
        const normalized = document.createElement("canvas");
        normalized.width = W;
        normalized.height = H;
        const n = normalized.getContext("2d", { willReadFrequently: true })!;
        n.drawImage(
          source,
          400 - eyeX * scaleX,
          336 - eyeY * scaleY,
          cw * scaleX,
          ch * scaleY,
        );
        frames.push(n.getImageData(0, 0, W, H).data);
      }
      sharedStageArt[family] = frames;
      sharedStagePaths[family] = basePath;
    })().catch((err) => {
      sharedStagePending[family] = null;
      throw err;
    });
  }
  return sharedStagePending[family]!;
}

async function ensureBackgroundLoaded(
  index: number,
  basePath: string,
): Promise<HTMLImageElement | null> {
  if (index < 0 || index >= LED_BACKGROUNDS.length) return null;
  if (sharedBgImages.has(index)) {
    if (sharedBgPaths.get(index) === basePath) return sharedBgImages.get(index)!;
    const item = LED_BACKGROUNDS[index];
    return decodeImage(`${basePath}${item.file}?v=5`);
  }
  if (!sharedBgPending.has(index)) {
    const p = (async () => {
      const item = LED_BACKGROUNDS[index];
      const img = await decodeImage(`${basePath}${item.file}?v=5`);
      sharedBgImages.set(index, img);
      sharedBgPaths.set(index, basePath);
      return img;
    })().catch((err) => {
      sharedBgPending.delete(index);
      throw err;
    });
    sharedBgPending.set(index, p);
  }
  return sharedBgPending.get(index)!;
}

// ---------- Anatomical Region Weights & Accessory Pose Helpers ----------

export function regionWeights(x: number, y: number): [number, number, number] {
  const body = smooth(425, 478, y);
  const distance = Math.abs(x - 400);
  const front = 1 - smooth(120, 168, distance);
  const rearStart = 535 - 24 * smooth(155, 290, distance);
  const rear = smooth(rearStart, rearStart + 30, y);
  const belly = smooth(542, 580, y);
  let paws = 0;
  for (const center of [330, 470]) {
    paws = Math.max(
      paws,
      1 - smooth(0.85, 1.2, Math.hypot((x - center) / 66, (y - 548) / 48)),
    );
  }
  const lower = (rear * (1 - front) + belly * front) * (1 - paws);
  return [1 - body, body * (1 - lower), body * lower];
}

function convexHull(points: [number, number][]): [number, number][] {
  const sorted = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const lower: [number, number][] = [];
  const upper: [number, number][] = [];
  for (const point of sorted) {
    while (
      lower.length > 1 &&
      cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0
    ) {
      lower.pop();
    }
    lower.push(point);
  }
  for (let i = sorted.length - 1; i >= 0; i--) {
    const point = sorted[i];
    while (
      upper.length > 1 &&
      cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0
    ) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function fitHand(body: Uint8ClampedArray, side: -1 | 1): HandFit | null {
  const left = side < 0 ? 250 : 415;
  const right = side < 0 ? 385 : 550;
  const top = 485;
  const bottom = 594;
  const cw = right - left;
  const ch = bottom - top;
  const skin = new Uint8Array(cw * ch);
  const seen = new Uint8Array(cw * ch);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * W + x) * 4;
      const r = body[i],
        g = body[i + 1],
        b = body[i + 2];
      if (body[i + 3] > 220 && r > 135 && r > g * 1.18 && r > b * 1.1) {
        skin[(y - top) * cw + x - left] = 1;
      }
    }
  }
  let points: [number, number][] = [];
  let best = -Infinity;
  for (let seed = 0; seed < skin.length; seed++) {
    if (!skin[seed] || seen[seed]) continue;
    const queue = [seed];
    const component: [number, number][] = [];
    seen[seed] = 1;
    for (let next = 0; next < queue.length; next++) {
      const k = queue[next];
      const px = k % cw;
      const py = Math.floor(k / cw);
      component.push([left + px, top + py]);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          const ny = py + dy;
          const nk = ny * cw + nx;
          if (
            nx >= 0 &&
            nx < cw &&
            ny >= 0 &&
            ny < ch &&
            skin[nk] &&
            !seen[nk]
          ) {
            seen[nk] = 1;
            queue.push(nk);
          }
        }
      }
    }
    const center = component.reduce<[number, number]>(
      (a, p) => [a[0] + p[0] / component.length, a[1] + p[1] / component.length],
      [0, 0],
    );
    const score =
      component.length -
      4 * Math.hypot(center[0] - (side < 0 ? 324 : 476), center[1] - 538);
    if (score > best) {
      best = score;
      points = component;
    }
  }
  if (points.length < 30) return null;
  const center = points.reduce<[number, number]>(
    (a, p) => [a[0] + p[0] / points.length, a[1] + p[1] / points.length],
    [0, 0],
  );
  const proximal = points
    .slice()
    .sort(
      (a, b) =>
        (b[0] - center[0]) * side * 0.62 -
        (b[1] - center[1]) * 0.785 -
        ((a[0] - center[0]) * side * 0.62 - (a[1] - center[1]) * 0.785),
    )
    .slice(0, Math.max(12, Math.floor(points.length * 0.2)));
  const wrist = proximal.reduce<[number, number]>(
    (a, p) => [a[0] + p[0] / proximal.length, a[1] + p[1] / proximal.length],
    [0, 0],
  );
  const angle = clampNum(
    Math.atan2(wrist[0] - center[0], center[1] - wrist[1]),
    -1.05,
    1.05,
  );
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const local = (p: [number, number]): [number, number] => [
    (p[0] - center[0]) * cos + (p[1] - center[1]) * sin,
    -(p[0] - center[0]) * sin + (p[1] - center[1]) * cos,
  ];
  const contour = convexHull(points).map(local);
  const all = points.map(local);
  const u = all.map((p) => p[0]);
  const v = all.map((p) => p[1]);
  const minU = Math.min(...u),
    maxU = Math.max(...u),
    minV = Math.min(...v),
    maxV = Math.max(...v);
  return {
    center,
    wrist,
    angle,
    contour,
    minU,
    maxU,
    minV,
    maxV,
    rx: (maxU - minU) / 2,
    ry: (maxV - minV) / 2,
    area: points.length,
  };
}

function handPath(h: HandFit): Path2D {
  const p = new Path2D();
  const points = h.contour;
  const last = points[points.length - 1];
  const first = points[0];
  p.moveTo((last[0] + first[0]) / 2, (last[1] + first[1]) / 2);
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    p.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  p.closePath();
  return p;
}

const stageIndex = (n: number): number =>
  KEYS.reduce<number>((found, key, i) => (n >= key ? i : found), 0);

// ---------- Adapter Class ----------

export class LedPortraitAdapter {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  basePath: string;
  private master: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private overlay: HTMLCanvasElement;
  private og: CanvasRenderingContext2D;
  private _backBodyCopy: HTMLCanvasElement | null = null;
  private _backDetailCopy: HTMLCanvasElement | null = null;
  private _wearLayer: HTMLCanvasElement | null = null;
  private _wearLight: WearLightCache | null = null;
  private _wearBase: HTMLCanvasElement | null = null;
  private _wearCanAnimate = false;
  private _wearAnimation = 0;
  private _wearPoseCache = new Map<string, WearPose>();
  private _groundCache = new Map<string, HTMLCanvasElement>();
  private _fallbackArt: Uint8ClampedArray[] | null = null;
  private _disposed = false;
  private _ready = false;
  private _warning: string | null = null;
  private _lastDurationMs = 0;
  private _renderGen = 0;

  constructor(
    canvas: HTMLCanvasElement,
    options: { basePath?: string; size?: number } = {},
  ) {
    this.canvas = canvas;
    this.basePath = options.basePath ?? "/lab-assets/";
    this.ctx = configureLedCanvas(canvas, options.size ?? LED_FRAME.exportSize);
    this.master = document.createElement("canvas");
    this.master.width = W;
    this.master.height = H;
    this.g = this.master.getContext("2d", { willReadFrequently: true })!;
    this.overlay = document.createElement("canvas");
    this.overlay.width = W;
    this.overlay.height = H;
    this.og = this.overlay.getContext("2d", { willReadFrequently: true })!;
  }

  setBasePath(newBasePath: string): void {
    this.basePath = newBasePath;
    this._warning = null;
  }

  get status(): LedRenderStatus {
    return {
      ready: this._ready,
      disposed: this._disposed,
      animating: this._wearAnimation !== 0,
      warning: this._warning,
      lastDurationMs: this._lastDurationMs,
    };
  }

  async load(families: readonly number[] = [0, 1, 2]): Promise<void> {
    if (this._disposed) return;
    this._warning = null;
    try {
      await ensureBaseLoaded(this.basePath);
    } catch {
      this._warning = "Base character atlas unavailable; using procedural LED fallback.";
      this._ensureFallbackArt();
    }
    for (const f of families) {
      try {
        await ensureFamilyAtlasLoaded(f, this.basePath);
      } catch {
        this._warning = `Family evolution atlas (${FAMILIES[f]?.name ?? f}) unavailable; using base silhouette recovery.`;
      }
    }
    this._ready = true;
  }

  private _ensureFallbackArt(): Uint8ClampedArray[] {
    if (!this._fallbackArt) {
      this._fallbackArt = [0, 1, 2].map((f) => buildFallbackFamilyArt(f));
    }
    return this._fallbackArt;
  }

  private _getBaseFits(): BaseFit[] {
    return sharedBaseFits.length === 3 ? sharedBaseFits : defaultFits();
  }

  private _getBaseArt(family: number): Uint8ClampedArray {
    if (sharedBaseArt[family]) return sharedBaseArt[family];
    return this._ensureFallbackArt()[family] ?? this._ensureFallbackArt()[0];
  }

  stagesFor(family: number, level: number): [Uint8ClampedArray, Uint8ClampedArray, number] {
    const famStages = sharedStageArt[family];
    if (!famStages) {
      const base = this._getBaseArt(family);
      return [base, base, 0];
    }
    const idx = stageIndex(level);
    const frame = famStages[idx] ?? famStages[0];
    return [frame, frame, 0];
  }

  private _tint(
    color: [number, number, number],
    paletteTuple: readonly [string, string, string, string],
    index: number,
    x: number,
    y: number,
  ): [number, number, number] {
    if (index === 5) return color;
    const [r, g, b] = color;
    const hi = Math.max(r, g, b);
    const lo = Math.min(r, g, b);
    const sat = (hi - lo) / (hi || 1);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const coat =
      smooth(0.1, 0.38, sat) * smooth(1, 20, b - g) * smooth(0, 15, r - g);
    let pigment = rgb(paletteTuple[1]);
    if (index === 8) {
      pigment = mix(rgb("#a18ce3"), rgb("#8be5cf"), smooth(180, 720, y));
    }
    if (index === 9) {
      const stops = [
        "#ffb3b7",
        "#ffda9c",
        "#e4f4a8",
        "#8ce4c9",
        "#92c6ff",
        "#c9a5f5",
        "#f5b4e8",
      ];
      const t = Math.max(
        0,
        Math.min(5.999, (((y - 90) / 690) * 0.8 + ((x - 120) / 600) * 0.2) * 6),
      );
      const i = t | 0;
      pigment = mix(rgb(stops[i]), rgb(stops[i + 1]), t - i);
    }
    const material = mix(rgb(paletteTuple[2]), pigment, coat);
    const materialLuma =
      0.2126 * material[0] + 0.7152 * material[1] + 0.0722 * material[2];
    const chroma = material.map((v) => v - materialLuma);
    let strength = smooth(0, 28, luma) * (0.6 + 0.4 * coat);
    for (const d of chroma) {
      if (d > 0) strength = Math.min(strength, (255 - luma) / d);
      else if (d < 0) strength = Math.min(strength, luma / -d);
    }
    const recolored: [number, number, number] = [
      luma + chroma[0] * Math.max(0, strength),
      luma + chroma[1] * Math.max(0, strength),
      luma + chroma[2] * Math.max(0, strength),
    ];
    const ovalMask = (cx: number, cy: number, rx: number, ry: number) =>
      1 - smooth(0.8, 1.15, Math.hypot((x - cx) / rx, (y - cy) / ry));
    let skinArea = Math.max(
      ovalMask(400, 376, 22, 19),
      ovalMask(400, 404, 16, 15),
    );
    skinArea = Math.max(
      skinArea,
      (1 - smooth(270, 300, y)) * smooth(75, 110, Math.abs(x - 400)),
    );
    for (const center of [325, 475]) {
      skinArea = Math.max(
        skinArea,
        ovalMask(center, 548, 59, 46),
        ovalMask(center, 763, 57, 33),
      );
    }
    const skin = smooth(24, 62, r - g) * smooth(6, 35, r - b) * skinArea;
    const circuit = smooth(10, 32, g - r) * smooth(15, 40, b - r);
    const dark = 1 - smooth(12, 32, luma);
    let eyes = 0;
    for (const center of [326, 474]) {
      eyes = Math.max(
        eyes,
        1 - smooth(0.9, 1.12, Math.hypot((x - center) / 44, (y - 336) / 39)),
      );
    }
    return mix(recolored, color, Math.max(skin, circuit, dark, eyes));
  }

  private _balanceBaseHips(
    raw: ImageData,
    state: LedRenderState,
    family: number,
  ): void {
    if (state.levels[2] > 1) return;
    if (!sharedBaseHipWidths[family]) {
      const source = this.stagesFor(family, 0)[0];
      const widths = new Float32Array(H);
      const smoothed = new Float32Array(H);
      for (let y = 530; y < 800; y++) {
        let left = 400,
          right = 400;
        for (let x = 50; x < 400; x++) {
          if (source[(y * W + x) * 4 + 3] > 220) {
            left = x;
            break;
          }
        }
        for (let x = 750; x > 400; x--) {
          if (source[(y * W + x) * 4 + 3] > 220) {
            right = x;
            break;
          }
        }
        widths[y] = Math.min(400 - left, right - 400);
      }
      for (let y = 540; y < 790; y++) {
        const neighbours: number[] = [];
        for (let d = -5; d <= 5; d++) neighbours.push(widths[y + d]);
        neighbours.sort((a, b) => a - b);
        smoothed[y] = neighbours[5];
      }
      sharedBaseHipWidths[family] = smoothed;
    }
    const target = sharedBaseHipWidths[family]!;
    const pixels = raw.data;
    for (let y = 540; y < 790; y++) {
      let left = 400,
        right = 400;
      for (let x = 50; x < 400; x++) {
        if (pixels[(y * W + x) * 4 + 3] > 200) {
          left = x;
          break;
        }
      }
      for (let x = 750; x > 400; x--) {
        if (pixels[(y * W + x) * 4 + 3] > 200) {
          right = x;
          break;
        }
      }
      const widest = Math.max(400 - left, right - 400);
      const balanced = Math.min(400 - left, right - 400, target[y]);
      const t = Math.max(0, Math.min(1, (y - 540) / 50));
      const cap = widest + (balanced - widest) * t * t * (3 - 2 * t);
      for (let x = 50; x < 751; x++) {
        if (Math.abs(x - 400) > Math.max(140, cap)) {
          pixels[(y * W + x) * 4 + 3] = 0;
        }
      }
    }
  }

  private _fur(
    g: CanvasRenderingContext2D,
    d: string,
    box: [number, number, number, number],
    color: string,
    family: number,
  ): void {
    const p = new Path2D(d);
    g.save();
    g.clip(p);
    g.fillStyle = color;
    g.fill(p);
    if (sharedBaseTextures[family]) {
      g.globalAlpha = 0.95;
      g.drawImage(sharedBaseTextures[family], 350, 570, 100, 105, ...box);
    }
    g.globalCompositeOperation = "multiply";
    g.globalAlpha = 0.72;
    g.fillStyle = color;
    g.fillRect(...box);
    g.restore();
    g.strokeStyle = toneHex(color, "#46334f", 0.42);
    g.lineWidth = 3.5;
    g.lineJoin = "round";
    g.stroke(p);
  }

  private _evolution(
    g: CanvasRenderingContext2D,
    state: LedRenderState,
    p: readonly [string, string, string, string],
    layer: "back" | "front",
  ): void {
    const [h, m, l] = state.levels;
    const f = (state.regionFamilies ?? [-1, -1, -1]).map((v) =>
      v < 0 ? state.family : v,
    );
    const fits = this._getBaseFits();
    const coat = p[1],
      pearl = p[2],
      cyan = p[3],
      shadow = toneHex(coat, "#312139", 0.65),
      light = toneHex(coat, "#ffffff", 0.4);
    const oval = (
      x: number,
      y: number,
      rx: number,
      ry: number,
      color: string,
    ) => {
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
    };
    const line = (d: string, color: string, width = 6) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.stroke(new Path2D(d));
    };

    g.save();
    if (layer === "back") {
      if (h >= 6) {
        for (const s of [-1, 1]) {
          g.save();
          g.translate(400, 0);
          g.scale(s, 1);
          this._fur(
            g,
            "M168 358 Q226 331 265 358 Q252 387 216 394 L170 390 Z",
            [164, 335, 108, 66],
            h >= 9 ? pearl : light,
            f[0],
          );
          if (h >= 9) {
            this._fur(
              g,
              "M170 393 Q231 379 264 414 Q244 443 186 434 Z",
              [163, 378, 108, 65],
              pearl,
              f[0],
            );
          }
          g.restore();
        }
      }
      if (h >= 9) {
        this._fur(
          g,
          h === 10
            ? "M357 240 Q344 190 362 178 Q379 183 383 204 Q377 161 395 153 Q414 171 413 199 Q433 170 447 181 Q459 206 438 243 Z"
            : "M370 239 Q360 195 377 188 Q394 196 397 214 Q408 185 426 189 Q439 213 425 241 Z",
          [349, 151, 110, 100],
          pearl,
          f[0],
        );
      }
      const shoulderLayers = [2, 4, 7, 9].filter((n) => m >= n).length;
      for (const s of [-1, 1]) {
        for (let j = 0; j < shoulderLayers; j++) {
          g.save();
          g.translate(400, 0);
          g.scale(s, 1);
          const y = 492 + j * 29;
          this._fur(
            g,
            `M139 ${y - 18} Q191 ${y - 44} ${224 + j * 5} ${y - 17} Q${236 + j * 5} ${y + 4} ${209 + j * 3} ${y + 22} Q177 ${y + 28} 147 ${y + 17} Z`,
            [132, y - 48, 117, 83],
            j % 2 ? pearl : light,
            f[1],
          );
          g.restore();
        }
      }
      if (l >= 2) {
        for (const s of [-1, 1]) {
          g.save();
          g.translate(400, 0);
          g.scale(s, 1);
          this._fur(
            g,
            "M159 634 Q208 606 233 636 Q250 672 202 691 L158 682 Z",
            [151, 606, 105, 92],
            l >= 7 ? pearl : light,
            f[2],
          );
          if (l >= 4) {
            this._fur(
              g,
              "M169 675 Q222 648 246 681 Q245 715 194 718 L164 703 Z",
              [156, 646, 104, 83],
              l >= 8 ? pearl : coat,
              f[2],
            );
          }
          g.restore();
        }
      }
      if (l >= 8 && f[2] === 0) {
        this._fur(
          g,
          "M559 665 Q587 625 615 649 Q639 669 616 694 Q589 709 564 693 Z",
          [548, 625, 94, 91],
          pearl,
          f[2],
        );
      }
    } else {
      if (h >= 1) {
        for (const s of [-1, 1]) {
          g.save();
          g.translate(400, 0);
          g.scale(s, 1);
          const k = f[0];
          if (h >= 2) {
            g.save();
            g.globalAlpha = 0.85;
            line(
              k === 0
                ? "M95 235 C44 205 51 119 99 108 C139 96 176 127 178 168"
                : k === 1
                  ? "M112 234 Q73 194 103 137 Q128 109 160 133"
                  : "M98 235 Q65 179 169 121",
              h >= 7 ? pearl : light,
              12,
            );
            g.restore();
          }
          if (h >= 3) {
            line(
              k === 0
                ? "M98 218 Q73 183 94 150 Q110 130 136 143"
                : "M108 218 Q96 182 143 153",
              cyan,
              7,
            );
          }
          if (h >= 4) {
            g.beginPath();
            g.ellipse(126, 176, 20, 32, -0.35, 0, Math.PI * 2);
            const grad = g.createLinearGradient(105, 149, 142, 207);
            grad.addColorStop(0, pearl);
            grad.addColorStop(0.5, coat);
            grad.addColorStop(1, shadow);
            g.fillStyle = grad;
            g.fill();
            g.strokeStyle = light;
            g.lineWidth = 5;
            g.stroke();
          }
          if (h >= 7) {
            line(
              "M104 181 Q119 163 140 170 M106 198 Q125 185 143 190",
              pearl,
              6,
            );
          }
          if (h >= 8) {
            oval(169, 213, 7, 9, cyan);
            oval(159, 235, 6, 8, pearl);
          }
          g.restore();
        }
      }
      if (h >= 5) {
        line("M383 246 L400 231 L417 246 L400 268 Z", pearl, 5);
        if (h >= 8) {
          oval(370, 268, 5, 7, cyan);
          oval(430, 268, 5, 7, cyan);
        }
      }
      if (m >= 1) {
        const count = [1, 5, 8, 10].filter((n) => m >= n).length;
        for (let j = 0; j < count; j++) {
          const y = 472 + j * 19,
            w = 49 + j * 10;
          this._fur(
            g,
            `M${400 - w} ${y} Q371 ${y + 17} 400 ${y + 23} Q429 ${y + 17} ${400 + w} ${y} L${400 + w - 9} ${y + 22} L${422 + j * 3} ${y + 28} L400 ${y + 47} L${378 - j * 3} ${y + 28} L${409 - w} ${y + 22} Z`,
            [334 - j * 9, y - 3, 132 + j * 18, 55],
            pearl,
            f[1],
          );
        }
      }
      if (m >= 6) {
        for (const s of [-1, 1]) {
          line(
            `M${400 + s * 137} 565 Q${400 + s * 160} 583 ${400 + s * 146} 606 Q${400 + s * 139} 615 ${400 + s * 146} 627`,
            cyan,
            7,
          );
          if (m >= 10) {
            oval(400 + s * 142, 560, 8, 10, pearl);
            oval(400 + s * 142, 560, 4, 6, cyan);
          }
        }
      }
      if (l >= 7) {
        for (const [x, y] of fits[f[2]].feet) {
          this._fur(
            g,
            `M${x - 39} ${y - 23} Q${x - 14} ${y - 42} ${x} ${y - 28} Q${x + 24} ${y - 41} ${x + 39} ${y - 22} L${x + 28} ${y - 9} Q${x} ${y - 18} ${x - 28} ${y - 9} Z`,
            [x - 43, y - 43, 86, 40],
            pearl,
            f[2],
          );
        }
      }
      if (l >= 3) {
        for (const [x, y] of fits[f[2]].feet) {
          if (l >= 5) {
            oval(x, y + 1, 9, 7, cyan);
            oval(x - 2, y - 1, 3.2, 2.8, "#f7ffff");
          }
          if (l >= 9) {
            for (const dx of [-15, 0, 15]) {
              oval(
                x + dx,
                y - 13 - (dx === 0 ? 3 : 0),
                4.4,
                5.3,
                l === 10 ? pearl : cyan,
              );
            }
          }
        }
      }
    }
    g.restore();
  }

  private _markings(
    g: CanvasRenderingContext2D,
    state: LedRenderState,
    p: readonly [string, string, string, string],
  ): void {
    const [h, m, l] = state.levels;
    const f = (state.regionFamilies ?? [-1, -1, -1]).map((v) =>
      v < 0 ? state.family : v,
    );
    const ink = toneHex(p[1], "#392044", 0.52);
    const oval = (
      x: number,
      y: number,
      rx: number,
      ry: number,
      color: string,
    ) => {
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
    };
    const line = (d: string, color: string, width = 6) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.stroke(new Path2D(d));
    };

    g.save();
    g.globalCompositeOperation = "multiply";
    g.globalAlpha = 0.73;
    if (m >= 3) {
      g.save();
      g.translate(400, 595);
      const k = f[1];
      const bands = 1 + [6, 8, 10].filter((v) => m >= v).length;
      if (k === 0) {
        oval(0, 0, 8, 8, ink);
        for (let j = 0; j < bands; j++) {
          g.beginPath();
          g.ellipse(0, 0, 21 + j * 14, 17 + j * 10, 0, -1.1, 1.1);
          g.strokeStyle = ink;
          g.lineWidth = 7;
          g.stroke();
          g.beginPath();
          g.ellipse(
            0,
            0,
            21 + j * 14,
            17 + j * 10,
            0,
            Math.PI - 1.1,
            Math.PI + 1.1,
          );
          g.stroke();
        }
      } else if (k === 1) {
        for (let j = 0; j < bands; j++) {
          line(
            `M${-27 - j * 5} ${-26 + j * 18} Q-16 ${-1 + j * 18} 0 ${2 + j * 18} Q16 ${-1 + j * 18} ${27 + j * 5} ${-26 + j * 18}`,
            ink,
            8,
          );
        }
      } else {
        g.fillStyle = ink;
        g.fill(
          new Path2D("M0 -31 Q20 -13 12 8 L0 24 L-12 8 Q-20 -13 0 -31 Z"),
        );
        for (const s of [-1, 1]) {
          g.save();
          g.scale(s, 1);
          if (m >= 6)
            g.fill(new Path2D("M18 -12 Q37 -36 49 -18 Q51 4 24 9 Z"));
          if (m >= 8)
            g.fill(new Path2D("M24 23 Q53 6 59 26 Q52 45 27 40 Z"));
          if (m >= 10) line("M8 53 Q28 57 43 45", ink, 7);
          g.restore();
        }
      }
      g.restore();
    }
    if (h >= 3) {
      for (const s of [-1, 1]) {
        line(
          `M${400 + s * 115} 390 Q${400 + s * 135} 388 ${400 + s * 146} 401`,
          ink,
          6,
        );
        if (h >= 8) {
          line(
            `M${400 + s * 142} 410 Q${400 + s * 160} 406 ${400 + s * 170} 418`,
            ink,
            7,
          );
        }
      }
    }
    if (l >= 1) {
      for (const s of [-1, 1]) {
        const count = 1 + [4, 6, 9].filter((v) => l >= v).length;
        for (let j = 0; j < count; j++) {
          const x = 400 + s * (85 + j * 13);
          const y = 650 + j * 13;
          if (f[2] === 0) oval(x, y, 6.5, 8.5, ink);
          else
            line(
              `M${x - s * 8} ${y - 8} Q${x + s * 12} ${y - 7} ${x + s * 10} ${y + 8}`,
              ink,
              7,
            );
        }
      }
    }
    g.restore();
  }

  private _intermediateDetails(
    g: CanvasRenderingContext2D,
    state: LedRenderState,
    p: readonly [string, string, string, string],
  ): void {
    const [h, m, l] = state.levels;
    const f = (state.regionFamilies ?? [-1, -1, -1]).map((v) =>
      v < 0 ? state.family : v,
    );
    const fits = this._getBaseFits();
    const isKey = (val: number) => (KEYS as readonly number[]).includes(val);
    const pearl = p[2];
    const cyan = p[3];
    const shadow = "#6a507c";
    const line = (d: string, c: string, w = 6) => {
      g.strokeStyle = c;
      g.lineWidth = w;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.stroke(new Path2D(d));
    };
    const oval = (
      x: number,
      y: number,
      rx: number,
      ry: number,
      c: string,
    ) => {
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = c;
      g.fill();
    };

    g.save();
    if (!isKey(h)) {
      for (const s of [-1, 1]) {
        g.save();
        g.translate(400, 0);
        g.scale(s, 1);
        if (h === 1 || h === 3 || h === 4) {
          line(
            f[0] === 0
              ? "M97 224 Q66 186 91 140"
              : "M105 222 Q86 184 143 147",
            h === 1 ? pearl : cyan,
            h === 4 ? 9 : 6,
          );
        }
        if (h === 4 || h === 7) {
          const grad = g.createLinearGradient(110, 151, 145, 202);
          grad.addColorStop(0, pearl);
          grad.addColorStop(0.5, p[1]);
          grad.addColorStop(1, shadow);
          g.beginPath();
          g.ellipse(126, 177, 15, 24, -0.3, 0, Math.PI * 2);
          g.fillStyle = grad;
          g.fill();
          g.strokeStyle = pearl;
          g.lineWidth = 4;
          g.stroke();
        }
        if (h === 3 || h === 6) line("M115 389 Q133 385 145 397", shadow, 6);
        if (h === 6 || h === 7) line("M102 194 Q123 177 143 186", pearl, 7);
        if (h === 9) {
          oval(157, 224, 6, 8, cyan);
          oval(169, 242, 5, 7, pearl);
        }
        g.restore();
      }
      if (h === 9) line("M383 249 L400 235 L417 249 L400 270 Z", pearl, 5);
    }
    if (!isKey(m)) {
      if (m === 1) {
        line("M363 487 Q379 510 400 514 Q421 510 437 487", pearl, 8);
      }
      if (m === 3 || m === 4) {
        g.save();
        g.globalCompositeOperation = "multiply";
        g.globalAlpha = 0.65;
        line(
          m === 3
            ? "M380 502 Q400 520 420 502"
            : "M375 495 Q400 522 425 495 M385 517 Q400 533 415 517",
          shadow,
          6,
        );
        g.restore();
      }
      if (m === 6 || m === 7) {
        line("M372 487 Q383 507 394 509 M428 487 Q417 507 406 509", pearl, 8);
        if (m === 7) {
          for (const s of [-1, 1]) {
            oval(400 + s * 147, 500, 7, 9, pearl);
            oval(400 + s * 147, 500, 3.5, 5, cyan);
          }
        }
      }
      if (m === 9) {
        if (f[1] === 0) {
          g.beginPath();
          g.arc(400, 502, 11, 0, Math.PI * 2);
          g.strokeStyle = cyan;
          g.lineWidth = 5;
          g.stroke();
        } else {
          line("M400 486 L410 502 L400 520 L390 502 Z", pearl, 6);
        }
      }
    }
    if (l === 3 || l === 4) {
      g.save();
      g.globalCompositeOperation = "multiply";
      g.globalAlpha = 0.75;
      line(
        l === 3
          ? "M380 598 Q400 619 420 598"
          : "M371 592 Q400 630 429 592 M383 621 Q400 636 417 621",
        shadow,
        7,
      );
      g.restore();
    }
    if (l === 9) {
      if (f[2] === 0) {
        g.beginPath();
        g.arc(400, 621, 13, 0, Math.PI * 2);
        g.strokeStyle = cyan;
        g.lineWidth = 5;
        g.stroke();
      } else {
        line("M400 602 L411 621 L400 640 L389 621 Z", pearl, 6);
      }
    }
    if (!isKey(l)) {
      for (const [x, y] of fits[f[2]].feet) {
        if (l === 1)
          line(
            `M${x - 20} ${y - 11} Q${x} ${y - 23} ${x + 20} ${y - 11}`,
            pearl,
            5,
          );
        if (l === 3 || l === 4) {
          oval(x, y, 7, 5, cyan);
          if (l === 4) {
            for (const d of [-14, 14]) oval(x + d, y - 12, 4, 5, cyan);
          }
        }
        if (l === 6 || l === 7)
          line(
            `M${x - 28} ${y - 21} Q${x} ${y - 36} ${x + 28} ${y - 21}`,
            pearl,
            8,
          );
        if (l === 7) oval(x, y + 1, 4, 3, pearl);
        if (l === 9) {
          for (const d of [-14, 0, 14])
            oval(x + d, y - 12 - (d === 0 ? 3 : 0), 4, 5, pearl);
        }
      }
    }
    g.restore();
  }

  private _pose(state: LedRenderState): WearPose {
    const f = (state.regionFamilies ?? [-1, -1, -1]).map((v) =>
      v < 0 ? state.family : v,
    );
    const key = f.map((v, i) => `${v}:${stageIndex(state.levels[i])}`).join("/");
    const cached = this._wearPoseCache.get(key);
    if (cached) return cached;
    const head = this.stagesFor(f[0], state.levels[0])[0];
    const body = this.stagesFor(f[1], state.levels[1])[0];
    const hands: [HandFit | null, HandFit | null] = [
      fitHand(body, -1),
      fitHand(body, 1),
    ];
    const paws: [[number, number], [number, number]] = [
      hands[0] ? hands[0].center : [324, 538],
      hands[1] ? hands[1].center : [476, 538],
    ];
    const center = (paws[0][0] + paws[1][0]) / 2;
    const neckY = clampNum((paws[0][1] + paws[1][1]) / 2 - 52, 472, 493);
    const neckScale = clampNum((paws[1][0] - paws[0][0]) / 150, 0.93, 1.08);
    let headTop = 225,
      earTop = 80;
    outer: for (let y = 132; y < 290; y++) {
      for (let x = 397; x <= 403; x++) {
        if (head[(y * W + x) * 4 + 3] > 220) {
          headTop = y;
          break outer;
        }
      }
    }
    outerEar: for (let y = 25; y < 240; y++) {
      for (let x = 135; x < 670; x++) {
        if (head[(y * W + x) * 4 + 3] > 220) {
          earTop = y;
          break outerEar;
        }
      }
    }
    const edgeAt = (y: number): number => {
      for (let x = 711; x > 480; x--) {
        if (head[(clampNum(Math.round(y), 0, H - 1) * W + x) * 4 + 3] > 220) {
          return x;
        }
      }
      return 579;
    };
    const edges: { x: number; y: number }[] = [];
    for (let y = 174; y <= 220; y += 2) edges.push({ x: edgeAt(y), y });
    edges.sort((a, b) => a.x - b.x);
    const earMid = edges[Math.floor(edges.length / 2)];
    const ear = {
      x: earMid.x,
      y: earMid.y,
      angle: clampNum(
        Math.atan2(-(edgeAt(earMid.y + 8) - edgeAt(earMid.y - 8)), 16),
        -0.6,
        0.6,
      ),
    };
    const result: WearPose = {
      hands,
      paws,
      center,
      neckY,
      neckScale,
      headTop,
      earTop,
      ear,
    };
    if (this._wearPoseCache.size > 48) this._wearPoseCache.clear();
    this._wearPoseCache.set(key, result);
    return result;
  }

  private _frameBackpiece(): void {
    if (!this._backBodyCopy) this._backBodyCopy = document.createElement("canvas");
    if (!this._backDetailCopy)
      this._backDetailCopy = document.createElement("canvas");
    for (const [copy, source] of [
      [this._backBodyCopy, this.master],
      [this._backDetailCopy, this.overlay],
    ] as const) {
      if (copy.width !== W) {
        copy.width = W;
        copy.height = H;
      }
      const c = copy.getContext("2d")!;
      c.clearRect(0, 0, W, H);
      c.drawImage(source, 0, 0);
    }
    const { scale, x, y } = LED_PRESENTATION;
    for (const [context, copy] of [
      [this.g, this._backBodyCopy],
      [this.og, this._backDetailCopy],
    ] as const) {
      context.save();
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, W, H);
      context.imageSmoothingQuality = "high";
      context.drawImage(copy, x, y, W * scale, H * scale);
      context.restore();
    }
  }

  private _drawAccessory(
    id: number,
    paletteTuple: readonly [string, string, string, string],
    state: LedRenderState,
  ): void {
    this._wearLight = null;
    this._frameBackpiece();
    if (id < 0 || id >= LED_ACCESSORIES.length) return;
    const p = this._pose(state);
    const t = { cyan: paletteTuple[3], pearl: paletteTuple[2] };
    if (!this._wearLayer) this._wearLayer = document.createElement("canvas");
    if (this._wearLayer.width !== W) {
      this._wearLayer.width = W;
      this._wearLayer.height = H;
    }
    const g = this._wearLayer.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    g.lineCap = "round";
    g.lineJoin = "round";
    g.save();
    g.translate(LED_PRESENTATION.x, LED_PRESENTATION.y);
    g.scale(LED_PRESENTATION.scale, LED_PRESENTATION.scale);

    const shape = (
      d: string,
      fill: string | CanvasGradient,
      stroke?: string,
      width = 3,
    ) => {
      const path = new Path2D(d);
      g.fillStyle = fill;
      g.fill(path);
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = width;
        g.stroke(path);
      }
      return path;
    };
    const line = (d: string, color: string | CanvasGradient, width = 4) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.stroke(new Path2D(d));
    };
    const oval = (
      x: number,
      y: number,
      rx: number,
      ry: number,
      fill: string | CanvasGradient,
      stroke?: string,
      width = 3,
    ) => {
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = width;
        g.stroke();
      }
    };
    const gradient = (
      x: number,
      y: number,
      x2: number,
      y2: number,
      stops: [number, string][],
    ) => {
      const a = g.createLinearGradient(x, y, x2, y2);
      stops.forEach(([s, c]) => a.addColorStop(s, c));
      return a;
    };
    const metal = (x: number, y: number, w: number, h: number) =>
      gradient(x, y, x + w, y + h, [
        [0, "#e2edf5"],
        [0.22, "#a5b6ce"],
        [0.45, "#485771"],
        [0.64, "#9baac1"],
        [1, "#2b364d"],
      ]);
    const ceramic = (x: number, y: number, w: number, h: number) =>
      gradient(x, y, x + w, y + h, [
        [0, "#fff8ff"],
        [0.36, "#ddd4ee"],
        [0.67, "#a99bbb"],
        [1, "#6c617d"],
      ]);
    const shadow = (path: Path2D, dy = 4) => {
      g.save();
      g.translate(0, dy);
      g.shadowColor = "#05081870";
      g.shadowBlur = 5;
      g.fillStyle = "#070c195e";
      g.fill(path);
      g.restore();
    };
    const hideBehindCreature = () => {
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = "destination-out";
      g.drawImage(this.master, 0, 0);
      g.restore();
    };

    const drawLens = () => {
      const d =
        "M278 309 Q318 293 374 303 L389 320 L377 354 Q344 371 299 360 L281 341 Z";
      const path = new Path2D(d);
      g.save();
      g.translate(0, 3);
      g.strokeStyle = "#0b17224a";
      g.lineWidth = 5;
      g.shadowColor = "#08122355";
      g.shadowBlur = 3;
      g.stroke(path);
      g.restore();
      g.fillStyle = gradient(287, 302, 366, 364, [
        [0, "#9bdeef38"],
        [0.35, "#23375220"],
        [0.72, "#102c423d"],
        [1, "#3ea3b72a"],
      ]);
      g.fill(path);
      g.save();
      g.clip(path);
      g.fillStyle = gradient(285, 304, 342, 352, [
        [0, "#ecfaff3d"],
        [0.3, "#c8f1ff12"],
        [0.5, "#a6dcff00"],
        [1, "#a6dcff00"],
      ]);
      g.fillRect(275, 296, 115, 79);
      line("M289 319 L305 306 L319 305", t.pearl, 3.5);
      line("M289 330 L289 342 L300 346", t.cyan, 3.8);
      line("M365 341 L374 337 M366 348 L374 345", t.cyan, 3.2);
      g.restore();
      shape(
        "M276 307 Q320 292 373 301 L383 307 L374 312 Q320 302 280 317 Z",
        metal(277, 297, 104, 20),
        "#213149",
        2.4,
      );
      line("M298 361 Q340 373 376 355", "#a5cbd281", 2.5);
      shape(
        "M262 311 L278 306 L285 317 L280 331 L265 328 Z",
        metal(263, 307, 20, 24),
        "#17253b",
        2.5,
      );
      line("M266 315 L274 313 L277 320", t.cyan, 3.8);
      const arm = gradient(237, 300, 266, 320, [
        [0, "#29304b00"],
        [0.35, "#28364e65"],
        [1, "#b4c9dc"],
      ]);
      line("M238 302 Q252 304 266 318", arm, 6);
    };

    const bloomTips: [number, number][] = [
      [-327, 105],
      [-330, -45],
      [-330, -190],
      [-270, -330],
      [-145, -410],
      [0, -440],
      [145, -410],
      [270, -330],
      [330, -190],
      [330, -45],
      [327, 105],
    ];
    const bloomShape = (length: number) =>
      `M-13 -46 C-31 -88 -42 ${-length * 0.64} -21 ${-length * 0.88} Q-9 ${-length * 0.98} 0 ${-length} Q9 ${-length * 0.98} 21 ${-length * 0.88} C42 ${-length * 0.64} 31 -88 13 -46 Z`;

    const prismOrbit = (
      ctx: CanvasRenderingContext2D,
      tones: { cyan: string; pearl: string },
      emission = false,
    ): [number, number, string][] => {
      const pts: [number, number, string][] = [];
      const angle = -0.12,
        sx = 1.04,
        sy = 0.97;
      const arc = (
        r: number,
        a: number,
        b: number,
        color: string,
        width: number,
      ) => {
        ctx.beginPath();
        ctx.arc(0, 0, r, a, b);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.stroke();
      };
      ctx.save();
      ctx.translate(400, 430);
      ctx.rotate(angle);
      ctx.scale(sx, sy);
      if (!emission) {
        arc(292, 0, Math.PI * 2, "#929ec0", 8);
        arc(292, 0, Math.PI * 2, "#e8eaf7", 4.5);
        for (let j = 0; j < 3; j++) {
          arc(
            313,
            (j * Math.PI * 2) / 3 + 0.15,
            (j * Math.PI * 2) / 3 + 0.88,
            "#bcb0e878",
            1.8,
          );
          arc(
            275,
            (j * Math.PI * 2) / 3 + 0.6,
            (j * Math.PI * 2) / 3 + 1.4,
            "#d4e1f891",
            2,
          );
        }
      }
      for (let j = 0; j < 6; j++) {
        const a = (j * Math.PI) / 3;
        const color = j % 2 ? "#d8b1ff" : tones.cyan;
        arc(292, a + 0.12, a + 0.89, color, emission ? 3.5 : 4);
        ctx.save();
        ctx.rotate(a);
        if (!emission) {
          const crystalPath = new Path2D(
            "M0 -332 C8 -320 12 -306 0 -292 C-12 -306 -8 -320 0 -332 Z",
          );
          const cg = ctx.createLinearGradient(-8, -330, 8, -292);
          cg.addColorStop(0, "#f5f7ff");
          cg.addColorStop(0.36, color);
          cg.addColorStop(0.7, "#bdc9e7");
          cg.addColorStop(1, "#a1a2cd");
          ctx.fillStyle = cg;
          ctx.fill(crystalPath);
          ctx.strokeStyle = "#9b9dc0";
          ctx.lineWidth = 2.4;
          ctx.stroke(crystalPath);
        }
        ctx.strokeStyle = emission ? color : "#f6fcff";
        ctx.lineWidth = emission ? 3.7 : 2.8;
        ctx.stroke(new Path2D("M0 -324 Q4 -312 0 -301"));
        ctx.restore();
        const x = Math.sin(a) * 323 * sx;
        const y = -Math.cos(a) * 323 * sy;
        pts.push([
          400 + Math.cos(angle) * x - Math.sin(angle) * y,
          430 + Math.sin(angle) * x + Math.cos(angle) * y,
          color,
        ]);
        const b = a + Math.PI / 6;
        ctx.beginPath();
        ctx.ellipse(
          Math.sin(b) * 298,
          -Math.cos(b) * 298,
          3.6,
          3.6,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fillStyle = emission ? color : "#eef6ff";
        ctx.fill();
      }
      ctx.restore();
      return pts;
    };

    if (id === 0) {
      // Lumen clasp
      g.save();
      g.translate(p.center, (p.paws[0][1] + p.paws[1][1]) / 2 - 8);
      g.rotate(-0.14);
      const d =
        "M-1 -6 C-39 -5 -49 -25 -28 -30 Q-10 -33 -1 -6 C-16 -39 9 -45 17 -27 Q22 -14 1 -3 C27 -31 46 -17 32 -2 Q20 9 1 1 C31 7 29 30 10 25 Q-2 21 -2 3 C-12 32 -37 23 -29 8 Q-22 -3 -1 -6 Z";
      shadow(new Path2D(d), 3);
      shape(d, ceramic(-44, -38, 88, 73), "#64617c", 3.5);
      line(
        "M-28 -24 Q-15 -21 -6 -8 M9 -28 Q12 -19 4 -9 M29 -13 Q21 -7 12 -5 M16 19 Q8 16 4 8 M-23 13 Q-16 11 -9 4",
        "#f9f0ff",
        4,
      );
      oval(
        0,
        -3,
        14,
        17,
        gradient(-12, -18, 13, 13, [
          [0, "#ecffff"],
          [0.33, t.cyan],
          [0.75, "#9c8bda"],
          [1, "#c1e5fa"],
        ]),
        "#57516f",
        3.5,
      );
      oval(-4, -8, 4, 5, "#f7ffff");
      g.restore();
    } else if (id === 1) {
      // Aether visor
      const visor = new Path2D(
        "M266 310 Q322 288 383 301 Q400 306 417 301 Q478 288 534 310 L522 353 Q491 377 442 367 L415 351 Q400 341 385 351 L358 367 Q309 377 278 353 Z",
      );
      shadow(visor, 5);
      g.fillStyle = gradient(273, 295, 524, 367, [
        [0, "#334861eb"],
        [0.18, "#142640e8"],
        [0.46, "#1b214ce8"],
        [0.7, "#1b3c52e8"],
        [1, "#111a31f0"],
      ]);
      g.fill(visor);
      g.strokeStyle = "#8098b4";
      g.lineWidth = 4;
      g.stroke(visor);
      g.save();
      g.clip(visor);
      g.fillStyle = gradient(285, 291, 480, 357, [
        [0, "#a8f4ff00"],
        [0.18, "#d2efff74"],
        [0.24, "#9bf5fb1c"],
        [0.38, "#8abbff00"],
        [0.6, "#84b5ff00"],
        [0.7, "#b2c3ff3b"],
        [0.8, "#adcbff00"],
        [1, "#adeaff00"],
      ]);
      g.fillRect(263, 287, 274, 88);
      shape("M282 300 L306 296 L344 369 L323 374 Z", "#bbdfff13");
      line(
        "M475 319 L496 315 L505 326 M498 333 L504 334 M479 343 L495 345",
        t.cyan,
        4,
      );
      line("M295 340 L306 337 L316 340", "#d7eeff8c", 3.5);
      g.restore();
      shape(
        "M261 306 Q322 283 383 296 Q400 300 417 296 Q478 283 539 306 L535 316 Q477 296 417 308 Q400 312 383 308 Q323 296 265 316 Z",
        metal(267, 286, 267, 31),
        "#162239",
        3,
      );
      line(
        "M273 307 Q326 291 372 300 M428 300 Q474 291 527 307",
        t.cyan,
        4.5,
      );
      for (const side of [-1, 1]) {
        g.save();
        g.translate(400, 0);
        g.scale(side, 1);
        shape(
          "M129 310 L147 314 L151 338 L136 347 L129 332 Z",
          metal(128, 308, 25, 39),
          "#152239",
          3,
        );
        line("M140 320 L143 333", t.cyan, 4);
        line(
          "M148 319 Q161 312 174 310",
          gradient(148, 311, 174, 314, [
            [0, "#a2bfd7"],
            [1, "#8da6c700"],
          ]),
          6,
        );
        g.restore();
      }
      line("M388 350 Q400 339 412 350", "#c7d7e8", 3.5);
    } else if (id === 2) {
      // Petal mitts
      for (const h of p.hands) {
        if (!h) continue;
        g.save();
        g.translate(...h.center);
        g.rotate(h.angle);
        g.clip(handPath(h));
        const height = h.maxV - h.minV;
        const cut = h.minV + height * 0.69;
        const u = h.minU - 5;
        const v = h.minV - 4;
        const w = h.maxU - h.minU + 10;
        shape(
          `M${u} ${v} H${u + w} V${cut - 3} Q${h.rx * 0.45} ${cut - 6} 0 ${cut + 2} Q${-h.rx * 0.45} ${cut - 6} ${u} ${cut - 3} Z`,
          gradient(u, v, u + w, cut + 4, [
            [0, "#faf0f7"],
            [0.45, "#ddd9ef"],
            [0.72, "#b7c3e1"],
            [1, "#eee4f3"],
          ]),
        );
        line(
          `M${u} ${cut - 3} Q${-h.rx * 0.45} ${cut - 6} 0 ${cut + 2} Q${h.rx * 0.45} ${cut - 6} ${u + w} ${cut - 3}`,
          "#8d83a8",
          2.4,
        );
        const seam = h.minV + height * 0.24;
        line(`M${u} ${seam} Q0 ${seam + 8} ${u + w} ${seam}`, "#fbf8ff", 3.5);
        line(`M-9 ${seam + 8} Q0 ${seam + 15} 9 ${seam + 6}`, t.cyan, 3.2);
        g.restore();
      }
    } else if (id === 3) {
      // Auricle clip
      g.save();
      g.translate(p.ear.x - 9, p.ear.y);
      g.rotate(p.ear.angle);
      g.scale(1.35, 1.35);
      const q = new Path2D(
        "M-10 -23 Q5 -28 12 -13 L13 15 Q8 28 -7 24 L-13 15 L-12 -14 Z",
      );
      shadow(q, 3);
      g.fillStyle = metal(-13, -25, 28, 50);
      g.fill(q);
      g.strokeStyle = "#25354d";
      g.lineWidth = 3.8;
      g.stroke(q);
      shape("M-5 -13 L6 -14 L7 13 L-5 14 Z", "#162a40");
      line("M1 -8 L1 8", t.cyan, 6);
      line(
        "M-11 -17 Q-19 -14 -18 -4 M-11 17 Q-19 14 -18 5",
        "#d8e5f1",
        5,
      );
      g.restore();
    } else if (id === 4) {
      // Holo lenses
      for (const side of [-1, 1]) {
        g.save();
        if (side > 0) {
          g.translate(800, 0);
          g.scale(-1, 1);
        }
        drawLens();
        g.restore();
      }
      line("M383 319 Q400 308 417 319", "#172338", 8);
      line("M386 316 Q400 309 414 316", "#cbdde9", 3.2);
      line(
        "M389 334 Q386 343 391 346 M411 334 Q414 343 409 346",
        "#19263c77",
        3,
      );
    } else if (id === 5) {
      // Bio-link wraps
      for (const h of p.hands) {
        if (!h) continue;
        g.save();
        g.translate(...h.center);
        g.rotate(h.angle);
        g.clip(handPath(h));
        const height = h.maxV - h.minV;
        const top = h.minV + height * 0.18;
        const depth = clampNum(height * 0.24, 10, 16);
        const left = h.minU - 5;
        const right = h.maxU + 5;
        shape(
          `M${left} ${top} Q0 ${top + 7} ${right} ${top} L${right} ${top + depth} Q0 ${top + depth + 7} ${left} ${top + depth} Z`,
          gradient(left, top, right, top + depth + 7, [
            [0, "#f5eafa"],
            [0.4, "#c8cce5"],
            [1, "#9dadd1"],
          ]),
        );
        line(`M${left} ${top + 2} Q0 ${top + 9} ${right} ${top + 2}`, "#f9f6ff", 3);
        line(
          `M${left} ${top + depth - 2} Q0 ${top + depth + 5} ${right} ${top + depth - 2}`,
          t.cyan,
          3.3,
        );
        g.restore();
      }
    } else if (id === 6) {
      // Companion orbs
      const y = (p.paws[0][1] + p.paws[1][1]) / 2 + 65;
      for (const side of [-1, 1]) {
        const x = 400 + side * 292;
        line(
          `M${x - side * 8} ${y - 53} Q${x - side * 45} ${y - 12} ${x - side * 14} ${y + 48}`,
          "#a7def149",
          5,
        );
      }
      for (const side of [-1, 1]) {
        const x = 400 + side * 292;
        oval(x, y, 35, 35, ceramic(x - 30, y - 32, 64, 70), "#23344c", 5);
        oval(x, y, 24, 24, "#13263f", "#849bb7", 4);
        oval(x, y, 14, 14, t.cyan, "#d7f6ff", 4);
        oval(x - 3, y - 4, 5, 5, "#f7ffff");
        line(
          `M${x - 23} ${y - 21} Q${x - 8} ${y - 33} ${x + 9} ${y - 28}`,
          "#fff7ff",
          4,
        );
      }
    } else if (id === 7) {
      // Eclipse mask
      const outer =
        "M238 314 C243 282 260 266 284 265 L281 241 Q292 221 308 239 L342 273 L364 267 L400 237 L436 267 L458 273 L492 239 Q508 221 519 241 L516 265 C540 266 557 282 562 314 L548 351 C532 378 499 388 477 374 L451 359 L429 348 L411 357 L400 346 L389 357 L371 348 L349 359 L323 374 C301 388 268 378 252 351 Z";
      const mask = new Path2D(outer);
      for (const x of [326, 474]) {
        mask.moveTo(x + 51, 336);
        mask.ellipse(x, 336, 51, 43, 0, 0, Math.PI * 2);
      }
      for (const side of [-1, 1]) {
        g.save();
        g.translate(400, 0);
        g.scale(side, 1);
        shape(
          "M132 291 C151 265 172 239 162 204 C191 221 202 248 188 277 L168 315 Z",
          gradient(143, 210, 192, 302, [
            [0, "#fcf2ff"],
            [0.35, "#c6d3ed"],
            [0.65, "#a39bcc"],
            [1, "#e5f7ff"],
          ]),
          "#8585ac",
          2.8,
        );
        line("M171 218 Q188 244 173 271 L157 290", t.cyan, 4);
        line("M180 226 Q197 249 184 274", "#f8ecff", 2.8);
        g.restore();
      }
      shape(
        "M390 248 Q380 219 400 199 Q420 219 410 248 Z",
        gradient(388, 196, 411, 251, [
          [0, "#f8f4ff"],
          [0.45, t.cyan],
          [1, "#a7a0d1"],
        ]),
        "#8683ac",
        2.8,
      );
      g.save();
      g.translate(0, 4);
      g.fillStyle = "#070b1959";
      g.shadowBlur = 5;
      g.shadowColor = "#080c1955";
      g.fill(mask, "evenodd");
      g.restore();
      g.fillStyle = gradient(258, 247, 541, 371, [
        [0, "#fdf4ff"],
        [0.2, "#d4ddef"],
        [0.43, "#f4ddff"],
        [0.62, "#b3afd0"],
        [0.82, "#e6f6ff"],
        [1, "#a9b3cf"],
      ]);
      g.fill(mask, "evenodd");
      g.strokeStyle = "#777b9f";
      g.lineWidth = 2.8;
      g.stroke(mask);
      line(
        "M246 312 Q252 284 279 278 L292 248 L331 281 M554 312 Q548 284 521 278 L508 248 L469 281",
        "#f8f4ff",
        5,
      );
      for (const side of [-1, 1]) {
        g.save();
        g.translate(400, 0);
        g.scale(side, 1);
        shape(
          "M94 281 Q100 258 107 252 Q113 277 135 296 Q126 302 113 291 Z",
          gradient(85, 251, 135, 314, [
            [0, "#e7d4ff"],
            [0.5, t.cyan],
            [1, "#a2a1d8"],
          ]),
          "#8b8db4",
          2.3,
        );
        line("M108 286 L126 300 L130 317", t.cyan, 3.6);
        line("M113 363 L135 349 L142 330", "#dff9ff", 3);
        g.restore();
      }
      shape(
        "M400 249 L415 275 L400 304 L385 275 Z",
        gradient(387, 249, 412, 305, [
          [0, "#fff5ff"],
          [0.3, t.cyan],
          [0.7, "#8b88ed"],
          [1, "#bffbff"],
        ]),
        "#26334e",
        5,
      );
      line("M400 258 L406 275 L400 287", "#f6ffff", 4);
      line("M367 281 L379 268 M433 281 L421 268", "#f0d494", 4);
    } else if (id === 8) {
      // Prism sanctuary
      prismOrbit(g, t, false);
      hideBehindCreature();
    } else if (id === 9) {
      // Aurora bloom
      for (let i = 0; i < bloomTips.length; i++) {
        const [dx, dy] = bloomTips[i];
        const length = Math.hypot(dx, dy);
        g.save();
        g.translate(400, 490);
        g.rotate(Math.atan2(dy, dx) + Math.PI / 2);
        const hue = [t.cyan, "#b68af4", "#f2a0d6"][i % 3];
        shape(
          bloomShape(length),
          gradient(-25, -50, 24, -length, [
            [0, "#493b6b66"],
            [0.32, "#8c77c099"],
            [0.62, hue + "b8"],
            [1, "#e9f7ffe3"],
          ]),
          "#b2b3d88c",
          2.6,
        );
        line(
          `M-12 -73 Q-35 ${-length * 0.58} -14 ${-length * 0.86} Q-7 ${-length * 0.96} -2 ${-length + 10}`,
          "#f6edff",
          3.2,
        );
        line(
          `M5 -91 Q13 ${-length * 0.63} 0 ${-length + 33}`,
          t.cyan,
          3.8,
        );
        oval(0, -length + 29, 4, 5.5, "#f1ffff");
        g.restore();
      }
      hideBehindCreature();
    }

    g.restore();
    this.og.drawImage(this._wearLayer, 0, 0);

    if (id >= 7) {
      this._prepareLight(id, t, prismOrbit, bloomTips, bloomShape);
    }
  }

  private _prepareLight(
    id: number,
    tones: { cyan: string; pearl: string },
    prismOrbit: (
      ctx: CanvasRenderingContext2D,
      t: { cyan: string; pearl: string },
      emission: boolean,
    ) => [number, number, string][],
    bloomTips: [number, number][],
    bloomShape: (length: number) => string,
  ): void {
    const source = document.createElement("canvas");
    source.width = W;
    source.height = H;
    const g = source.getContext("2d", { willReadFrequently: true })!;
    const points: [number, number, string][] = [];
    const t = { ...tones, cyan: "#76efff" };
    g.lineCap = "round";
    g.lineJoin = "round";
    g.translate(LED_PRESENTATION.x, LED_PRESENTATION.y);
    g.scale(LED_PRESENTATION.scale, LED_PRESENTATION.scale);

    const line = (d: string, color: string, width = 4) => {
      g.strokeStyle = color;
      g.lineWidth = width;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.stroke(new Path2D(d));
    };
    const oval = (
      x: number,
      y: number,
      rx: number,
      ry: number,
      fill: string,
    ) => {
      g.beginPath();
      g.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
    };
    const node = (x: number, y: number, color = t.cyan) => {
      oval(x, y, 5, 5, color);
      points.push([x, y, color]);
    };

    if (id === 7) {
      for (const side of [-1, 1]) {
        g.save();
        g.translate(400, 0);
        g.scale(side, 1);
        line("M171 218 Q188 244 173 271 L157 290", t.cyan, 6);
        line("M108 286 L126 300 L130 317", "#d7a0ff", 5.5);
        line("M113 363 L135 349 L142 330", t.cyan, 4.5);
        line("M184 222 C213 248 217 280 197 309", t.cyan, 5.5);
        line("M204 251 Q220 279 209 296", "#d6a0ff", 4);
        line("M181 332 Q166 349 175 362", t.cyan, 4.5);
        g.restore();
        node(400 + side * 175, 235);
        node(400 + side * 202, 286, t.cyan);
        node(400 + side * 179, 349, "#e6b9ff");
      }
      line(
        "M246 312 Q252 284 279 278 L292 248 L331 281 M554 312 Q548 284 521 278 L508 248 L469 281",
        "#e5b0ff",
        4.5,
      );
      line("M400 203 Q388 222 400 242 Q412 222 400 203", t.cyan, 5.5);
      line("M400 258 L406 275 L400 287 L394 275 Z", "#c5faff", 5.5);
      node(400, 206, t.cyan);
      node(400, 275);
    } else if (id === 8) {
      points.push(...prismOrbit(g, t, true));
    } else {
      for (let i = 0; i < bloomTips.length; i++) {
        const [dx, dy] = bloomTips[i];
        const length = Math.hypot(dx, dy);
        const hue = [t.cyan, "#b494ff", "#ff9dda"][i % 3];
        g.save();
        g.translate(400, 490);
        g.rotate(Math.atan2(dy, dx) + Math.PI / 2);
        line(bloomShape(length), hue, 3.4);
        line(`M5 -91 Q13 ${-length * 0.63} 0 ${-length + 33}`, hue, 4);
        line(
          `M-14 ${-length * 0.86} Q-7 ${-length * 0.96} -2 ${-length + 10}`,
          "#d6fcff",
          3.4,
        );
        g.restore();
        const f = (length - 24) / length;
        node(400 + dx * f, 490 + dy * f, hue);
      }
    }

    g.setTransform(1, 0, 0, 1, 0, 0);
    for (const point of points) {
      point[0] = LED_PRESENTATION.x + point[0] * LED_PRESENTATION.scale;
      point[1] = LED_PRESENTATION.y + point[1] * LED_PRESENTATION.scale;
    }

    const protectLight = (ctx: CanvasRenderingContext2D) => {
      if (id > 7) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(this.master, 0, 0);
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(LED_PRESENTATION.x, LED_PRESENTATION.y);
        ctx.scale(LED_PRESENTATION.scale, LED_PRESENTATION.scale);
        ctx.globalCompositeOperation = "destination-out";
        for (const x of [326, 474]) {
          ctx.beginPath();
          ctx.ellipse(x, 336, 44, 36, 0, 0, Math.PI * 2);
          ctx.fillStyle = "#000";
          ctx.fill();
        }
        ctx.restore();
      }
    };

    protectLight(g);
    const pixels = g.getImageData(0, 0, W, H).data;
    const led = document.createElement("canvas");
    led.width = W;
    led.height = H;
    const lg = led.getContext("2d")!;
    for (let y = 9; y < 849; y += 6) {
      for (let x = 17; x < 785; x += 6) {
        let a = 0,
          r = 0,
          green = 0,
          b = 0;
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          const k = ((y + dy) * W + x + dx) * 4;
          const alpha = pixels[k + 3] / 255;
          a += alpha;
          r += pixels[k] * alpha;
          green += pixels[k + 1] * alpha;
          b += pixels[k + 2] * alpha;
        }
        if (a < 0.3) continue;
        lg.fillStyle = `rgba(${Math.round(r / a)},${Math.round(green / a)},${Math.round(b / a)},${Math.min(1, a / 2)})`;
        lg.beginPath();
        lg.arc(x, y, 2.35, 0, Math.PI * 2);
        lg.fill();
      }
    }
    const halo = document.createElement("canvas");
    halo.width = W;
    halo.height = H;
    const hg = halo.getContext("2d")!;
    hg.filter = "blur(20px)";
    hg.globalAlpha = 0.95;
    hg.drawImage(led, 0, 0);
    hg.filter = "blur(7px)";
    hg.globalAlpha = 0.95;
    hg.drawImage(led, 0, 0);
    hg.filter = "none";
    hg.globalAlpha = 1;
    for (const [x, y, color] of points) {
      const radius = id === 8 ? 28 : 34;
      const aura = hg.createRadialGradient(x, y, 1, x, y, radius);
      aura.addColorStop(0, color + "8c");
      aura.addColorStop(0.32, color + "42");
      aura.addColorStop(1, color + "00");
      hg.fillStyle = aura;
      hg.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    }
    protectLight(hg);
    this._wearLight = { id, led, halo, points, cyan: t.cyan };
  }

  private _contactPoints(state: LedRenderState): {
    x: number;
    y: number;
    rx: number;
  }[] {
    const fit = LED_PRESENTATION;
    const family =
      state.regionFamilies && state.regionFamilies[2] >= 0
        ? state.regionFamilies[2]
        : state.family;
    const raw = this.stagesFor(family, state.levels[2])[0];
    return (
      [
        [250, 395],
        [405, 550],
      ] as const
    ).map(([left, right]) => {
      let bottom = 780;
      for (let y = 786; y >= 730; y--) {
        let count = 0;
        for (let x = left; x < right; x++) {
          if (raw[(y * W + x) * 4 + 3] > 220) count++;
        }
        if (count > 6) {
          bottom = y;
          break;
        }
      }
      let total = 0,
        sum = 0,
        min = right as number,
        max = left as number;
      for (let y = bottom - 10; y <= bottom; y++) {
        for (let x = left; x < right; x++) {
          if (raw[(y * W + x) * 4 + 3] > 220) {
            sum += x;
            total++;
            min = Math.min(min, x);
            max = Math.max(max, x);
          }
        }
      }
      return {
        x: fit.x + (total ? sum / total : (left + right) / 2) * fit.scale,
        y: fit.y + bottom * fit.scale + 1,
        rx: Math.max(20, (max - min) * fit.scale * 0.48),
      };
    });
  }

  private _groundedImage(
    state: LedRenderState,
    image: HTMLImageElement,
  ): HTMLCanvasElement {
    const points = this._contactPoints(state);
    const key =
      state.background +
      ":" +
      points
        .map((p) => [p.x.toFixed(1), p.y.toFixed(1), p.rx.toFixed(1)].join(","))
        .join("/");
    const cached = this._groundCache.get(key);
    if (cached) return cached;
    const surface = document.createElement("canvas");
    surface.width = LED_FRAME.width * 2;
    surface.height = LED_FRAME.height * 2;
    const g = surface.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(image, 0, 0, surface.width, surface.height);
    const pixels = g.getImageData(0, 0, surface.width, surface.height).data;
    const center = (points[0].x + points[1].x) / 2;
    const baseline = Math.max(...points.map((p) => p.y));
    g.scale(2, 2);
    g.translate(-LED_FRAME.x, -LED_FRAME.y);
    for (let y = 705; y < 807; y += LED_GRID.step) {
      for (let x = 227; x < 582; x += LED_GRID.step) {
        const contact = Math.max(
          ...points.map((p) =>
            Math.exp(
              -1.5 * ((x - p.x) / p.rx) ** 2 - 1.8 * ((y - p.y) / 6.5) ** 2,
            ),
          ),
        );
        const body = Math.exp(
          -1.6 * ((x - center) / 122) ** 2 - 1.6 * ((y - baseline - 4) / 19) ** 2,
        );
        const shade = Math.max(0.12, 1 - 0.78 * contact - 0.34 * body);
        if (shade > 0.999) continue;
        const i =
          ((y - LED_FRAME.y) * 2 * surface.width + (x - LED_FRAME.x) * 2) * 4;
        const color = [0, 1, 2].map((c) => Math.round(pixels[i + c] * shade));
        g.fillStyle = "#050912";
        g.fillRect(x - 3, y - 3, 6, 6);
        g.fillStyle = `rgb(${color.join(",")})`;
        g.beginPath();
        g.arc(x, y, LED_GRID.radius, 0, Math.PI * 2);
        g.fill();
      }
    }
    if (this._groundCache.size >= 3) {
      const oldestKey = this._groundCache.keys().next().value;
      if (oldestKey !== undefined) this._groundCache.delete(oldestKey);
    }
    this._groundCache.set(key, surface);
    return surface;
  }

  private _composeBackground(state: LedRenderState): void {
    const image =
      state.background >= 0 ? sharedBgImages.get(state.background) : undefined;
    const g = this.ctx;
    g.save();
    g.globalCompositeOperation = "destination-over";
    if (image) {
      g.drawImage(
        this._groundedImage(state, image),
        LED_FRAME.x,
        LED_FRAME.y,
        LED_FRAME.width,
        LED_FRAME.height,
      );
    } else {
      g.fillStyle = "#090e1b";
      g.fillRect(LED_FRAME.x, LED_FRAME.y, LED_FRAME.width, LED_FRAME.height);
    }
    g.restore();
  }

  private _paintWearFrame(time: number): void {
    const light = this._wearLight;
    const base = this._wearBase;
    if (this._disposed || !light || !base) return;
    const g = this.ctx;
    const pulse = 0.82 + 0.18 * Math.sin(time / 1450);
    g.save();
    g.clearRect(LED_FRAME.x, LED_FRAME.y, LED_FRAME.width, LED_FRAME.height);
    g.drawImage(
      base,
      LED_FRAME.x,
      LED_FRAME.y,
      LED_FRAME.width,
      LED_FRAME.height,
    );
    g.globalCompositeOperation = "screen";
    g.globalAlpha = pulse;
    g.drawImage(light.halo, 0, 0);
    g.globalAlpha = 0.78 + 0.2 * pulse;
    g.drawImage(light.led, 0, 0);
    for (let i = 0; i < light.points.length; i++) {
      const [px, py, color] = light.points[i];
      const twinkle = Math.max(0, Math.sin(time / 820 - i * 1.7)) ** 8;
      if (twinkle < 0.03) continue;
      const x = 17 + Math.round((px - 17) / 6) * 6;
      const y = 9 + Math.round((py - 9) / 6) * 6;
      g.globalAlpha = 0.9 * twinkle;
      g.fillStyle = color;
      g.shadowColor = color;
      g.shadowBlur = 12;
      for (const [dx, dy, r] of [
        [0, 0, 2.6],
        [-6, 0, 1.7],
        [6, 0, 1.7],
        [0, -6, 1.7],
        [0, 6, 1.7],
      ]) {
        g.beginPath();
        g.arc(x + dx, y + dy, r, 0, Math.PI * 2);
        g.fill();
      }
    }
    g.shadowBlur = 0;
    g.restore();
  }

  private _startWearLoop(): void {
    let last = 0;
    const tick = (time: number) => {
      if (this._disposed) {
        this._wearAnimation = 0;
        return;
      }
      if (
        (typeof document === "undefined" || !document.hidden) &&
        time - last >= 40
      ) {
        this._paintWearFrame(time);
        last = time;
      }
      this._wearAnimation = requestAnimationFrame(tick);
    };
    this._wearAnimation = requestAnimationFrame(tick);
  }

  private _illuminate(state: LedRenderState, staticOnly = false): void {
    this.stopAnimation();
    this._wearCanAnimate = false;
    const light = this._wearLight;
    if (state.accessory < 7 || !light) {
      this._wearBase = null;
      return;
    }
    if (!this._wearBase) this._wearBase = document.createElement("canvas");
    const base = this._wearBase;
    base.width = this.canvas.width;
    base.height = this.canvas.height;
    base.getContext("2d")!.drawImage(this.canvas, 0, 0);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    this._paintWearFrame(1100);
    if (this._disposed || reduce) return;
    this._wearCanAnimate = true;
    if (staticOnly) return;
    this._startWearLoop();
  }

  private _paintLedDots(state: LedRenderState, staticOnly = false): void {
    const c = this.ctx;
    c.clearRect(0, 0, W, H);
    const p = this.g.getImageData(0, 0, W, H).data;
    const dots: [number, number, number, number, number, number, boolean][] = [];
    const step = LED_GRID.step;
    for (let y = 9; y < 849; y += step) {
      for (let x = 17; x < 785; x += step) {
        let a = 0,
          r = 0,
          g = 0,
          b = 0;
        for (const [dx, dy] of [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ]) {
          const i = ((y + dy) * W + x + dx) * 4;
          const alpha = p[i + 3] / 255;
          a += alpha;
          r += p[i] * alpha;
          g += p[i + 1] * alpha;
          b += p[i + 2] * alpha;
        }
        if (a < 0.75) continue;
        r /= a;
        g /= a;
        b /= a;
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const enhance = (v: number) =>
          Math.max(0, Math.min(255, (lum + (v - lum) * 1.12 - 112) * 1.18 + 126));
        r = enhance(r);
        g = enhance(g);
        b = enhance(b);
        const accent = g > r * 1.13 && b > r * 1.1 && b > 155;
        dots.push([x, y, r, g, b, Math.min(1, a / 4), accent]);
      }
    }
    for (const [x, y, r, g, b, a, accent] of dots) {
      if (accent) {
        c.fillStyle = `rgba(${r},${g},${b},${0.1 * a})`;
        c.beginPath();
        c.arc(x, y, 3.4, 0, Math.PI * 2);
        c.fill();
      }
      c.fillStyle = `rgba(${r},${g},${b},${a})`;
      c.beginPath();
      c.arc(x, y, LED_GRID.radius, 0, Math.PI * 2);
      c.fill();
    }
    this._composeBackground(state);
    this._illuminate(state, staticOnly);
  }

  private _drawCore(state: LedRenderState, staticOnly = false): void {
    if (this._disposed) return;
    const t0 = performance.now();
    const g = this.g;
    const palItem = PALETTES[state.palette] ?? PALETTES[0];
    const pTuple: [string, string, string, string] = [
      palItem.name,
      palItem.coat,
      palItem.cream,
      palItem.accent,
    ];
    const family = (state.regionFamilies ?? [-1, -1, -1]).map((f) =>
      f < 0 ? state.family : f,
    );
    const parts = family.map((f, i) => this.stagesFor(f, state.levels[i]));
    const raw = g.createImageData(W, H);
    const out = raw.data;

    for (let y = 8; y < 850; y++) {
      for (let x = 12; x < 788; x++) {
        const weights = regionWeights(x, y);
        const major =
          weights[0] >= weights[1] && weights[0] >= weights[2]
            ? 0
            : weights[1] >= weights[2]
              ? 1
              : 2;
        const i = (y * W + x) * 4;
        const solid = parts[major][0];
        let r = solid[i],
          green = solid[i + 1],
          b = solid[i + 2];
        const a = solid[i + 3] / 255;
        let total = 0,
          rr = 0,
          gg = 0,
          bb = 0;
        for (let region = 0; region < 3; region++) {
          if (weights[region] < 0.001) continue;
          const source = parts[region][0];
          const weight = (weights[region] * source[i + 3]) / 255;
          if (source[i + 3] < 60) continue;
          total += weight;
          rr += source[i] * weight;
          gg += source[i + 1] * weight;
          bb += source[i + 2] * weight;
        }
        if (total > 0) {
          r = rr / total;
          green = gg / total;
          b = bb / total;
        }
        if (a < 0.02) continue;
        if (state.palette === 5) {
          out[i] = r;
          out[i + 1] = green;
          out[i + 2] = b;
        } else {
          const color = this._tint(
            [r, green, b],
            pTuple,
            state.palette,
            x,
            y,
          );
          out[i] = color[0];
          out[i + 1] = color[1];
          out[i + 2] = color[2];
        }
        out[i + 3] = Math.min(255, a * 255);
      }
    }

    this._balanceBaseHips(raw, state, family[2]);
    const fallback: LedRenderState = {
      ...state,
      levels: state.levels.map((v, i) =>
        sharedStageArt[family[i]] ? 0 : v,
      ) as [number, number, number],
    };

    g.clearRect(0, 0, W, H);
    this.og.clearRect(0, 0, W, H);
    this._evolution(this.og, fallback, pTuple, "back");
    g.drawImage(this.overlay, 0, 0);
    this.og.putImageData(raw, 0, 0);
    g.drawImage(this.overlay, 0, 0);
    if (fallback.levels.some((v) => v > 0)) {
      this._markings(g, fallback, pTuple);
    }
    this.og.clearRect(0, 0, W, H);
    this._evolution(this.og, fallback, pTuple, "front");
    this._intermediateDetails(this.og, state, pTuple);
    this._drawAccessory(state.accessory, pTuple, state);
    g.drawImage(this.overlay, 0, 0);
    this._paintLedDots(state, staticOnly);
    this._lastDurationMs = performance.now() - t0;
  }

  /** Continuous body pixels (before the portrait LED pass) for the incubation scene grid. */
  captureBodyImageData(): ImageData | null {
    try {
      return this.g.getImageData(0, 0, W, H);
    } catch {
      return null;
    }
  }

  /**
   * Synchronous draw using currently cached assets, plus automatic background/atlas
   * fetch and redraw if any requested asset is not yet in cache.
   */
  draw(state: LedRenderState, options: { staticOnly?: boolean } = {}): void {
    if (this._disposed) return;
    const gen = ++this._renderGen;
    const normalized: LedRenderState = {
      family: (clampNum(state.family, 0, 2) as 0 | 1 | 2),
      regionFamilies: state.regionFamilies ?? [-1, -1, -1],
      levels: [
        clampNum(Math.round(state.levels[0]), 0, 10),
        clampNum(Math.round(state.levels[1]), 0, 10),
        clampNum(Math.round(state.levels[2]), 0, 10),
      ],
      palette: clampNum(state.palette, 0, 9),
      accessory: clampNum(state.accessory, -1, 9),
      background: clampNum(state.background, -1, 9),
    };

    this._drawCore(normalized, options.staticOnly ?? false);

    // If family atlas or background image isn't cached yet, load it asynchronously and redraw
    const needsFamily = !sharedStageArt[normalized.family];
    const needsBg =
      normalized.background >= 0 && !sharedBgImages.has(normalized.background);
    if (needsFamily || needsBg) {
      void this._ensureAssetsAndRedraw(
        normalized,
        gen,
        options.staticOnly ?? false,
      );
    }
  }

  private async _ensureAssetsAndRedraw(
    state: LedRenderState,
    gen: number,
    staticOnly: boolean,
  ): Promise<void> {
    let changed = false;
    let hadError = false;
    if (!sharedBaseLoaded || sharedBasePath !== this.basePath) {
      try {
        await ensureBaseLoaded(this.basePath);
        changed = true;
      } catch {
        hadError = true;
        this._warning = "Base character atlas could not load; using fallback.";
      }
    }
    if (!sharedStageArt[state.family] || sharedStagePaths[state.family] !== this.basePath) {
      try {
        await ensureFamilyAtlasLoaded(state.family, this.basePath);
        changed = true;
      } catch {
        hadError = true;
        this._warning = `Evolution atlas for ${FAMILIES[state.family].name} could not load; using base silhouette.`;
      }
    }
    if (
      state.background >= 0 &&
      (!sharedBgImages.has(state.background) ||
        sharedBgPaths.get(state.background) !== this.basePath)
    ) {
      try {
        await ensureBackgroundLoaded(state.background, this.basePath);
        changed = true;
      } catch {
        hadError = true;
        this._warning = `Background "${LED_BACKGROUNDS[state.background]?.name ?? state.background}" could not load; using LED studio backdrop.`;
      }
    }
    if (!hadError) {
      this._warning = null;
    }
    this._ready = true;
    if (changed && !this._disposed && gen === this._renderGen) {
      this._drawCore(state, staticOnly);
    }
  }

  private async _verifyRequiredExportAssets(state: LedRenderState): Promise<void> {
    const family = clampNum(state.family, 0, 2) as 0 | 1 | 2;
    const bgIndex = clampNum(state.background, -1, 9);
    try {
      await ensureBaseLoaded(this.basePath);
      await ensureFamilyAtlasLoaded(family, this.basePath);
      if (bgIndex >= 0) {
        await ensureBackgroundLoaded(bgIndex, this.basePath);
      }
      this._warning = null;
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Required art asset failed to load.";
      this._warning = `Asset load failure (${msg}); canonical 1600x1600 export blocked until assets recover.`;
      throw new Error(this._warning);
    }
  }

  /**
   * Ensures all required assets for `state` (base atlas, family atlas, and background PNG)
   * are loaded before rendering. Ideal for canonical export and tests.
   */
  async drawAsync(
    state: LedRenderState,
    options: { staticOnly?: boolean } = {},
  ): Promise<void> {
    if (this._disposed) return;
    const gen = ++this._renderGen;
    const normalized: LedRenderState = {
      family: (clampNum(state.family, 0, 2) as 0 | 1 | 2),
      regionFamilies: state.regionFamilies ?? [-1, -1, -1],
      levels: [
        clampNum(Math.round(state.levels[0]), 0, 10),
        clampNum(Math.round(state.levels[1]), 0, 10),
        clampNum(Math.round(state.levels[2]), 0, 10),
      ],
      palette: clampNum(state.palette, 0, 9),
      accessory: clampNum(state.accessory, -1, 9),
      background: clampNum(state.background, -1, 9),
    };
    await this._ensureAssetsAndRedraw(
      normalized,
      gen,
      options.staticOnly ?? false,
    );
    if (!this._disposed) {
      this._drawCore(normalized, options.staticOnly ?? false);
    }
  }

  /**
   * Exports a canonical 1600x1600 PNG Blob matching the preview.
   * Rejects if any required art asset failed to load (never exports fallback geometry as official character portrait art).
   */
  async exportPngBlob(state: LedRenderState): Promise<Blob> {
    await this._verifyRequiredExportAssets(state);
    await this.drawAsync(state, { staticOnly: true });
    const out = document.createElement("canvas");
    out.width = LED_FRAME.exportSize;
    out.height = LED_FRAME.exportSize;
    const c = out.getContext("2d")!;
    c.fillStyle = "#090e1b";
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(this.canvas, 0, 0, out.width, out.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      out.toBlob((b) => resolve(b), "image/png"),
    );
    if (!blob) {
      throw new Error("Failed to encode 1600x1600 PNG blob");
    }
    return blob;
  }

  /**
   * Exports a canonical 1600x1600 PNG Data URL matching the preview.
   * Rejects if any required art asset failed to load (never exports fallback geometry as official character portrait art).
   */
  async exportPngDataUrl(state: LedRenderState): Promise<string> {
    await this._verifyRequiredExportAssets(state);
    await this.drawAsync(state, { staticOnly: true });
    const out = document.createElement("canvas");
    out.width = LED_FRAME.exportSize;
    out.height = LED_FRAME.exportSize;
    const c = out.getContext("2d")!;
    c.fillStyle = "#090e1b";
    c.fillRect(0, 0, out.width, out.height);
    c.drawImage(this.canvas, 0, 0, out.width, out.height);
    return out.toDataURL("image/png");
  }

  /**
   * Continue an accessory loop from the stored portrait.
   * Does not rebuild the character.
   */
  resumeAccessoryAnimation(): boolean {
    if (this._disposed || !this._wearCanAnimate || !this._wearLight || !this._wearBase) return false;
    if (
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ) {
      return false;
    }
    if (this._wearAnimation) return true;
    this._paintWearFrame(1100);
    this._startWearLoop();
    return true;
  }

  stopAnimation(): void {
    if (this._wearAnimation) {
      cancelAnimationFrame(this._wearAnimation);
      this._wearAnimation = 0;
    }
  }

  dispose(): void {
    this.stopAnimation();
    this._disposed = true;
    this._renderGen++;
    this._wearLight = null;
    this._wearBase = null;
    this._wearCanAnimate = false;
    this._wearLayer = null;
    this._backBodyCopy = null;
    this._backDetailCopy = null;
    this._wearPoseCache.clear();
    this._groundCache.clear();
  }
}

export { LED_STAGE_DESCRIPTIONS };
