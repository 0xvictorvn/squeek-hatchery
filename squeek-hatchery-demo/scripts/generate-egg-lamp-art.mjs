// scripts/generate-egg-lamp-art.mjs
// Deterministic canvas/vector-to-dot generator for Squeek Hatchery Round 5 art assets:
// 1. egg-pulse.png: Rounded LED-dot egg with radar/harmonic ring motifs.
// 2. egg-relay.png: Pear-shaped LED-dot egg with folded ear chevron motifs.
// 3. egg-prism.png: Diamond-crested LED-dot egg with fan facets.
// 4. heat-lamp.png: Warming heat lamp with bulb, reflector shade, and mounting bracket.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const OUT_DIR = path.resolve("public", "art");
fs.mkdirSync(OUT_DIR, { recursive: true });

// --- Pure Node PNG Writer ---
function makePng(width, height, rgbaBuffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // 8 bits per sample
  ihdrData[9] = 6; // RGBA color type
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdrChunk = makeChunk("IHDR", ihdrData);

  const scanlineLen = 1 + width * 4;
  const rawScanlines = Buffer.alloc(scanlineLen * height);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * scanlineLen;
    rawScanlines[rowOffset] = 0; // Filter 0 (None)
    rgbaBuffer.copy(rawScanlines, rowOffset + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });
  const idatChunk = makeChunk("IDAT", compressed);
  const iendChunk = makeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = data.length;
  const buf = Buffer.alloc(4 + 4 + len + 4);
  buf.writeUInt32BE(len, 0);
  buf.write(type, 4, 4, "ascii");
  data.copy(buf, 8);
  const crc = zlib.crc32(buf.subarray(4, 8 + len));
  buf.writeUInt32BE(crc >>> 0, 8 + len);
  return buf;
}

// --- Software Rasterizer for Dot-Matrix Art ---
class DotCanvas {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.buffer = Buffer.alloc(width * height * 4);
  }

  setPixel(x, y, r, g, b, a) {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const idx = (y * this.width + x) * 4;
    const srcA = a / 255;
    const dstA = this.buffer[idx + 3] / 255;
    const outA = srcA + dstA * (1 - srcA);
    if (outA <= 0) return;

    this.buffer[idx] = Math.round((r * srcA + this.buffer[idx] * dstA * (1 - srcA)) / outA);
    this.buffer[idx + 1] = Math.round((g * srcA + this.buffer[idx + 1] * dstA * (1 - srcA)) / outA);
    this.buffer[idx + 2] = Math.round((b * srcA + this.buffer[idx + 2] * dstA * (1 - srcA)) / outA);
    this.buffer[idx + 3] = Math.round(outA * 255);
  }

  drawDot(cx, cy, radius, [r, g, b, a = 255]) {
    const minX = Math.floor(cx - radius - 1);
    const maxX = Math.ceil(cx + radius + 1);
    const minY = Math.floor(cy - radius - 1);
    const maxY = Math.ceil(cy + radius + 1);

    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= radius) {
          const edgeAlpha = Math.min(1, Math.max(0, radius + 0.5 - d));
          this.setPixel(x, y, r, g, b, Math.round(a * edgeAlpha));
        }
      }
    }
  }

  toPngBuffer() {
    return makePng(this.width, this.height, this.buffer);
  }
}

// Helper: Hex color to RGBA tuple
function hexRgb(hex, a = 255) {
  const c = hex.replace("#", "");
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16), a];
}

function mixRgb(c1, c2, t) {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
    Math.round((c1[3] ?? 255) + ((c2[3] ?? 255) - (c1[3] ?? 255)) * t),
  ];
}

const CANVAS_SIZE = 512;
const GRID_STEP = 6;
const DOT_RADIUS = 2.4;

// ==========================================
// 1. EGG PULSE (Radar & Harmonic Rings)
// ==========================================
function generateEggPulse() {
  const canvas = new DotCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const cx = 256;
  const cy = 265;
  const rx = 138;
  const ry = 180;

  for (let gy = 16; gy < CANVAS_SIZE - 16; gy += GRID_STEP) {
    for (let gx = 16; gx < CANVAS_SIZE - 16; gx += GRID_STEP) {
      const dx = gx - cx;
      const dy = gy - cy;
      // Pulse egg shape: rounded, slightly tapered top
      const taper = 1.0 - 0.14 * (dy / ry);
      const effectiveRx = rx * taper;
      const distSq = (dx / effectiveRx) ** 2 + (dy / ry) ** 2;

      if (distSq <= 1.0) {
        const normDist = Math.sqrt(distSq);
        // Base shell cream and amber shading
        let baseColor = mixRgb(hexRgb("#fef7ec"), hexRgb("#e2c39d"), Math.pow(normDist, 1.4));
        if (dx < -20 && dy < -20) {
          // Top-left highlight
          const hl = Math.max(0, 1 - Math.hypot(gx - 200, gy - 190) / 100);
          baseColor = mixRgb(baseColor, hexRgb("#ffffff"), hl * 0.7);
        }

        // Pulse Radar Motifs: Harmonic rings centered at (256, 275)
        const pulseCenterY = 275;
        const pulseDist = Math.hypot(dx, gy - pulseCenterY);
        // Rings at radius 30, 60, 90, 120
        const ringSpacing = 30;
        const ringMod = Math.abs((pulseDist % ringSpacing) - ringSpacing / 2);
        const onRing = ringMod < 3.2 && pulseDist > 15 && pulseDist < 135;

        // Radial harmonic wave spokes (at 45, 135, 225, 315 deg)
        const angle = Math.atan2(gy - pulseCenterY, dx);
        const onSpoke = Math.abs(Math.sin(angle * 4)) > 0.96 && pulseDist > 20 && pulseDist < 125;

        let dotColor = baseColor;
        if (onRing || onSpoke) {
          // Cyan / Emerald harmonic pulse glowing dots
          const glowColor = onRing ? hexRgb("#22d3ee") : hexRgb("#34d399");
          dotColor = mixRgb(baseColor, glowColor, onRing ? 0.85 : 0.7);
        } else if (normDist > 0.92) {
          // Egg contour rim
          dotColor = hexRgb("#7c583f");
        }

        canvas.drawDot(gx, gy, DOT_RADIUS, dotColor);
      }
    }
  }

  const outPath = path.join(OUT_DIR, "egg-pulse.png");
  fs.writeFileSync(outPath, canvas.toPngBuffer());
  console.log(`Saved: ${outPath}`);
}

// ==========================================
// 2. EGG RELAY (Pear-Shaped Chevron Motifs)
// ==========================================
function generateEggRelay() {
  const canvas = new DotCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const cx = 256;
  const cy = 265;
  const rx = 132;
  const ry = 184;

  for (let gy = 16; gy < CANVAS_SIZE - 16; gy += GRID_STEP) {
    for (let gx = 16; gx < CANVAS_SIZE - 16; gx += GRID_STEP) {
      const dx = gx - cx;
      const dy = gy - cy;
      // Relay egg shape: Pear-shaped with folded ear silhouette shoulder contour
      const pearTaper = dy < 0 ? (1.0 - 0.28 * Math.abs(dy / ry)) : (1.0 + 0.08 * (dy / ry));
      // Subtle ear notches at the top shoulders
      const earWaist = dy < -60 && dy > -130 ? 1.0 - 0.08 * Math.cos(((dy + 95) / 35) * Math.PI) : 1.0;
      const effectiveRx = rx * pearTaper * earWaist;
      const distSq = (dx / effectiveRx) ** 2 + (dy / ry) ** 2;

      if (distSq <= 1.0) {
        const normDist = Math.sqrt(distSq);
        // Warm peach & rosewood base
        let baseColor = mixRgb(hexRgb("#fff0e6"), hexRgb("#d9a579"), Math.pow(normDist, 1.3));
        if (dx < -25 && dy < -25) {
          const hl = Math.max(0, 1 - Math.hypot(gx - 200, gy - 190) / 100);
          baseColor = mixRgb(baseColor, hexRgb("#ffffff"), hl * 0.65);
        }

        // Relay Chevron Motifs: 3 stacked chevrons pointing upwards (y = -70, -20, +30)
        let isChevron = false;
        let isNode = false;
        for (const yOffset of [-75, -20, 35, 90]) {
          const chevronApexY = cy + yOffset;
          const expectedY = chevronApexY + Math.abs(dx) * 0.75;
          if (Math.abs(gy - expectedY) < 3.2 && Math.abs(dx) < 70) {
            isChevron = true;
          }
          if (Math.hypot(dx, gy - chevronApexY) < 4.5) {
            isNode = true;
          }
          if (Math.hypot(Math.abs(dx) - 45, gy - (chevronApexY + 45 * 0.75)) < 4.2) {
            isNode = true;
          }
        }

        let dotColor = baseColor;
        if (isNode) {
          dotColor = hexRgb("#f43f5e"); // Bright rose transmission nodes
        } else if (isChevron) {
          dotColor = hexRgb("#6366f1"); // Electric indigo folded chevron lines
        } else if (normDist > 0.92) {
          dotColor = hexRgb("#6b4334"); // Contour
        }

        canvas.drawDot(gx, gy, DOT_RADIUS, dotColor);
      }
    }
  }

  const outPath = path.join(OUT_DIR, "egg-relay.png");
  fs.writeFileSync(outPath, canvas.toPngBuffer());
  console.log(`Saved: ${outPath}`);
}

// ==========================================
// 3. EGG PRISM (Diamond Crest & Fan Facets)
// ==========================================
function generateEggPrism() {
  const canvas = new DotCanvas(CANVAS_SIZE, CANVAS_SIZE);
  const cx = 256;
  const cy = 265;
  const rx = 136;
  const ry = 182;

  for (let gy = 16; gy < CANVAS_SIZE - 16; gy += GRID_STEP) {
    for (let gx = 16; gx < CANVAS_SIZE - 16; gx += GRID_STEP) {
      const dx = gx - cx;
      const dy = gy - cy;
      // Prism egg shape: Diamond-crested faceted contour
      const diamondTaper = 1.0 - 0.22 * (dy / ry);
      const effectiveRx = rx * diamondTaper;
      const distSq = (dx / effectiveRx) ** 2 + (dy / ry) ** 2;

      if (distSq <= 1.0) {
        const normDist = Math.sqrt(distSq);
        // Crystal iridescent base
        let baseColor = mixRgb(hexRgb("#fdf2f8"), hexRgb("#cfb1d1"), Math.pow(normDist, 1.3));

        // Facet angle from diamond crest at (256, 120)
        const crestX = 256;
        const crestY = 120;
        const facetAngle = Math.atan2(gy - crestY, gx - crestX);
        const facetDist = Math.hypot(gx - crestX, gy - crestY);

        // Fan facet sectors: 7 crystal facets radiating downward
        const facetIdx = Math.floor((facetAngle + Math.PI) / (Math.PI / 6));
        const facetColors = [
          hexRgb("#f472b6"), // Rose
          hexRgb("#c084fc"), // Amethyst
          hexRgb("#818cf8"), // Indigo
          hexRgb("#38bdf8"), // Sky
          hexRgb("#34d399"), // Emerald
          hexRgb("#fbbf24"), // Topaz
          hexRgb("#f87171"), // Coral
        ];
        const facetColor = facetColors[Math.abs(facetIdx) % facetColors.length];

        // Facet seam lines
        const seam = Math.abs(((facetAngle + Math.PI) % (Math.PI / 6)) - Math.PI / 12);
        const onSeam = seam > 0.22;

        let dotColor = baseColor;
        if (facetDist < 25) {
          // Diamond crest apex
          dotColor = hexRgb("#ffffff");
        } else if (onSeam && facetDist < 220) {
          // Radiant crystal facet boundary
          dotColor = hexRgb("#ffffff");
        } else if (facetDist < 210) {
          // Shimmering prismatic tint
          dotColor = mixRgb(baseColor, facetColor, 0.45);
        } else if (normDist > 0.92) {
          dotColor = hexRgb("#5e425f"); // Contour
        }

        canvas.drawDot(gx, gy, DOT_RADIUS, dotColor);
      }
    }
  }

  const outPath = path.join(OUT_DIR, "egg-prism.png");
  fs.writeFileSync(outPath, canvas.toPngBuffer());
  console.log(`Saved: ${outPath}`);
}

// ==========================================
// 4. HEAT LAMP (Bulb, Shade, and Bracket)
// ==========================================
function generateHeatLamp() {
  const canvas = new DotCanvas(CANVAS_SIZE, CANVAS_SIZE);

  // Heat lamp geometry facing LEFT (toward the egg):
  // Rail mount: right side (x: 420..470, y: 190..320)
  // Swivel arm: (x: 340..420, y: 240..270)
  // Dome/Cone Shade: (x: 180..340, y: 150..360)
  // Incandescent Warming Bulb: (x: 150..220, y: 225..285)
  // Heat glow rays: radiating leftward from the bulb

  for (let gy = 16; gy < CANVAS_SIZE - 16; gy += GRID_STEP) {
    for (let gx = 16; gx < CANVAS_SIZE - 16; gx += GRID_STEP) {
      let isLamp = false;
      let color = [0, 0, 0, 0];

      // 1. Vertical rail runner & mounting clamp (x: 430..470, y: 180..330)
      if (gx >= 436 && gx <= 466 && gy >= 170 && gy <= 340) {
        isLamp = true;
        const edge = gx === 436 || gx === 466 || gy === 170 || gy === 340;
        color = edge ? hexRgb("#334155") : hexRgb("#64748b");
        if (gy >= 235 && gy <= 275 && gx >= 430) {
          // Clamp tightening knob
          color = hexRgb("#94a3b8");
        }
      }

      // 2. Swivel arm & socket neck (x: 320..436, y: 240..270)
      if (gx >= 320 && gx <= 436 && Math.abs(gy - 256) <= 15) {
        isLamp = true;
        const normY = Math.abs(gy - 256) / 15;
        color = mixRgb(hexRgb("#94a3b8"), hexRgb("#475569"), normY);
        if (gx >= 320 && gx <= 350) {
          // Socket ceramic collar
          color = hexRgb("#e2e8f0");
        }
      }

      // 3. Bell / Dome Reflector Shade (x: 180..330)
      // Cone widening from x = 330 (radius ~22) to x = 200 (radius ~95)
      if (gx >= 195 && gx <= 330) {
        const t = (330 - gx) / 135; // 0 at socket, 1 at opening
        const shadeRadius = 22 + t * 76;
        const dy = Math.abs(gy - 256);
        if (dy <= shadeRadius) {
          isLamp = true;
          const normDist = dy / shadeRadius;
          if (normDist > 0.88) {
            // Shade outer rim/edge
            color = hexRgb("#854d0e"); // Deep bronze
          } else if (gx <= 215) {
            // Shade opening rim highlight
            color = hexRgb("#fef08a");
          } else if (normDist > 0.65) {
            // Shade exterior warm copper finish
            color = mixRgb(hexRgb("#d97706"), hexRgb("#b45309"), normDist);
          } else {
            // Inside reflective bowl lining
            const interiorLight = Math.max(0, 1 - normDist);
            color = mixRgb(hexRgb("#fef08a"), hexRgb("#fde047"), interiorLight);
          }
        }
      }

      // 4. Visible Warming Bulb (spherical bulb at x = 185, y = 256, radius = 30)
      const bulbDist = Math.hypot(gx - 188, gy - 256);
      if (bulbDist <= 30) {
        isLamp = true;
        if (bulbDist < 12) {
          // Intense incandescent glowing core
          color = hexRgb("#ffffff");
        } else if (bulbDist < 22) {
          // Amber warmth
          color = hexRgb("#fef08a");
        } else {
          // Glass surface & golden rim
          color = mixRgb(hexRgb("#f59e0b"), hexRgb("#ea580c"), (bulbDist - 22) / 8);
        }
      }

      // 5. Radiating heat glow dots in front of the bulb (x < 170, y ~ 180..330)
      if (gx < 185 && gx >= 60) {
        const glowDist = Math.hypot(gx - 188, gy - 256);
        const angle = Math.atan2(gy - 256, gx - 188);
        const inBeamCone = Math.abs(angle - Math.PI) < Math.PI / 4.5;
        if (inBeamCone && glowDist < 130 && (gx + gy) % 12 === 0) {
          isLamp = true;
          const fade = 1 - glowDist / 130;
          color = hexRgb("#f59e0b", Math.round(180 * fade));
        }
      }

      if (isLamp) {
        canvas.drawDot(gx, gy, DOT_RADIUS, color);
      }
    }
  }

  const outPath = path.join(OUT_DIR, "heat-lamp.png");
  fs.writeFileSync(outPath, canvas.toPngBuffer());
  console.log(`Saved: ${outPath}`);
}

console.log("Generating Round 5 egg and heat lamp art assets...");
generateEggPulse();
generateEggRelay();
generateEggPrism();
generateHeatLamp();
console.log("Asset generation complete!");
