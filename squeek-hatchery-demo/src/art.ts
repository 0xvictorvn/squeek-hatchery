// One canonical renderer for the stage, local export and verifier-bound NFT result.
import {
  RAINBOW,
  colorAlpha,
  type Session,
  type AccessoryId,
} from "./rules.ts";
const f = (n: number) => String(Math.round(n * 10) / 10);
const hex = (c: readonly number[]) =>
  "#" +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(255, v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("");
const star = (x: number, y: number, r = 4) =>
  `<path transform="translate(${x} ${y}) scale(${f(r / 4)})" d="M0-4l1.2 2.7L4 0 1.2 1.3 0 4-1.2 1.3-4 0-1.2-1.3z"/>`;

/** Twelve distinct, anatomy-anchored designs. No randomized fur marks or picker. */
export function accessoryArt(a: AccessoryId, id: string, ears = 0) {
  const ey = 125 - ears * 8;
  const line = `stroke="#78604e" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"`;
  switch (a) {
    case 0:
      return `<g ${line}><path d="M164 239q36 16 72 0l-11 21-25 20-24-19z" fill="#789b91"/><path d="M168 243q32 11 64 0M191 251l9 19 10-18" fill="none" stroke="#dce5cb"/><path d="M224 245l19 12-20 4-5-11z" fill="#789b91"/></g>`;
    case 1:
      return `<g ${line}><path d="M197 249l-23-12q-8 13 0 26l23-9m6-5 23-12q8 13 0 26l-23-9" fill="#b97576"/><path d="M180 246l13 6m27-6-13 6" fill="none" stroke="#efd7c8"/><rect x="195" y="245" width="10" height="13" rx="4" fill="#deb698"/></g>`;
    case 2:
      return `<g ${line}><path d="M153 240l24 7 17 52-11 31-39-7 3-53zM247 240l-24 7-17 52 11 31 39-7-3-53z" fill="#819383"/><path d="M176 249l-14 29 19 7m43-36 14 29-19 7" fill="none" stroke="#d7ddc2"/><path d="M153 306h24m46 0h24" stroke="#d7ddc2"/><circle cx="216" cy="294" r="2" fill="#e3c48f"/></g>`;
    case 3:
      return `<g ${line}><path d="M154 243q47 26 93 67" fill="none" stroke="#a88159" stroke-width="6"/><path d="M233 287q16-4 25 3l-2 30q-14 8-27-2z" fill="#bd9063"/><path d="M231 290q15 15 26 1l-1 10-13 7-12-7z" fill="#d6b082"/><rect x="241" y="299" width="5" height="8" rx="1" fill="#e5d298"/></g>`;
    case 4:
      return `<g ${line}><path d="M172 240q28 36 56 0" fill="none" stroke="#a88758"/><path d="M193 270q-2 14 7 18 10-4 7-18" fill="#bd8a56"/><path d="M190 270q10-12 20 0z" fill="#846e4c"/><path d="M200 262v-5m-4 21 2 5" fill="none" stroke="#ead2a1"/></g>`;
    case 5:
      return `<g transform="translate(253 ${f(ey)})" ${line}><path d="M-4 2q-8 12-12 9" fill="none" stroke="#74957a"/>${[0, 60, 120, 180, 240, 300].map((r) => `<ellipse transform="rotate(${r})" cx="0" cy="-7" rx="4" ry="7" fill="#fff4df"/>`).join("")}<circle r="4.5" fill="#d8b65f"/></g>`;
    case 6:
      return `<g ${line}><path d="M230 267q-8-24 12-25 8 20-12 25z" fill="#87a282"/><path d="M229 269l11-24m-6 14 8-5m-6 0-2-5" fill="none" stroke="#e1ddaf"/></g>`;
    case 7:
      return `<g fill="none" stroke="#80705a" stroke-width="2.7"><circle cx="172" cy="185" r="18"/><circle cx="228" cy="185" r="18"/><path d="M190 183q10-7 20 0m-56-2-10-5m102 5 10-5"/><path d="M159 177q5-7 11-6m45 6q5-7 11-6" stroke="#fff7e9" stroke-width="1.6" opacity=".7"/></g>`;
    case 8:
      return `<g ${line} transform="rotate(-12 192 128)"><path d="M166 127q-13-14 7-23 25-12 48 0 19 13-1 22z" fill="#8d7b98"/><path d="M169 127q25 8 48 0l-1 8q-23 5-46-1z" fill="#b19aac"/><path d="M195 103q-3-8 4-9" fill="none" stroke-width="3"/></g>`;
    case 9:
      return `<g ${line}><path d="M232 264q-15-7-4-20 17 2 13 15-3 5-9 5z" fill="#d5b274"/><path d="M230 259q-3-7 3-13m-1 19 10 4" fill="none"/><path d="M235 265q6-12 13-5-2 10-13 5z" fill="#a4ab7e"/></g>`;
    case 10:
      return `<g stroke="#ae9054" stroke-width="1.4" stroke-linecap="round"><path d="M170 124q30 10 60 0l-3-8q-28 7-54 0z" fill="#e6cd88"/><path d="M173 116l-3-10m15 13-2-17m17 18V98m15 21 2-17m10 14 3-10" fill="none"/><g fill="#eedaa2">${star(170, 103, 4.3)}${star(184, 99, 4.3)}${star(200, 94, 5)}${star(216, 99, 4.3)}${star(230, 103, 4.3)}</g><g fill="#fff3dd"><circle cx="179" cy="122" r="2.2"/><circle cx="192" cy="124" r="2.2"/><circle cx="207" cy="124" r="2.2"/><circle cx="221" cy="122" r="2.2"/></g></g>`;
    case 11:
      return `<defs><linearGradient id="aw${id}" x1="0" y1="0" x2="1" y2="1">${RAINBOW.map((c, i) => `<stop offset="${f((i / 6) * 100)}%" stop-color="${c}"/>`).join("")}</linearGradient></defs><g ${line}><path d="M232 269q-14-11-8-24 10-1 12 11 0-17 14-17 5 17-14 27z" fill="url(#aw${id})" fill-opacity=".72" stroke="#aa9b91"/><path d="M232 267l-5-17m8 14 12-19m-15 20-8-7m13 2 10-7" fill="none" stroke="#fff6e7" stroke-width="1"/><ellipse cx="233" cy="267" rx="3" ry="4" fill="#e8cf9b"/></g>`;
  }
}
export function accessoryMiniature(a: AccessoryId) {
  const crops = [
    "155 225 95 95",
    "160 220 80 80",
    "130 230 140 105",
    "220 275 48 58",
    "180 250 43 43",
    "229 100 47 47",
    "218 235 37 42",
    "137 150 126 75",
    "151 87 89 62",
    "216 236 40 40",
    "158 83 84 55",
    "213 232 48 48",
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${crops[a]}" width="64" height="64">${accessoryArt(a, "mini" + a)}</svg>`;
}

/** Smooth, directional curved locks grow from the contour; no scaled circles. */
function locks(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  from: number,
  to: number,
  n: number,
  g: number,
) {
  if (g < 0.12) return "";
  let d = "";
  for (let i = 0; i < n; i++) {
    const a = from + ((to - from) * (i + 0.5)) / n;
    const x = cx + Math.cos(a) * rx,
      y = cy + Math.sin(a) * ry;
    const dx = Math.cos(a),
      dy = Math.sin(a),
      len = 3 + Math.pow(g, 1.8) * 21;
    const tx = -dy * 5,
      ty = dx * 5;
    d += `M${f(x - tx)} ${f(y - ty)}C${f(x + dx * len * 0.5 - tx)} ${f(y + dy * len * 0.5 - ty)} ${f(x + dx * len - tx)} ${f(y + dy * len - ty)} ${f(x + dx * len)} ${f(y + dy * len)}S${f(x + dx * len * 0.3 + tx)} ${f(y + dy * len * 0.3 + ty)} ${f(x + tx)} ${f(y + ty)}Z`;
  }
  return `<path d="${d}"/>`;
}
export function animalGroup(s: Session, id: string, showAccessory = true) {
  const [e, m, l] = s.regions.map((r) => r.growth);
  const earY = 127 - e * 8,
    erx = 21 + e * 9,
    ery = 20 + e * 14;
  const body = `<path d="M145 220C123 237 ${f(116 - m * 5)} 271 ${f(122 - l * 9)} 309Q119 335 148 339Q200 350 252 339Q281 335 ${f(278 + l * 9)} 309C${f(284 + m * 5)} 271 277 237 255 220Z"/>`;
  const head = `<path d="M200 123C167 120 136 132 125 163Q115 181 115 195C${f(98 - m * 6)} 207 ${f(108 - m * 6)} 232 135 240Q164 ${f(257 + m * 6)} 200 249Q236 ${f(257 + m * 6)} 265 240C${f(292 + m * 6)} 232 ${f(302 + m * 6)} 207 285 195Q285 181 275 163C264 132 233 120 200 123Z"/>`;
  const ears = `<ellipse cx="146" cy="${f(earY)}" rx="${f(erx)}" ry="${f(ery)}"/><ellipse cx="254" cy="${f(earY)}" rx="${f(erx)}" ry="${f(ery)}"/>`;
  const tufts =
    locks(200, 201, 83, 39, 0, 0.95, 4, m) +
    locks(200, 201, 83, 39, 2.2, 3.14, 4, m) +
    locks(200, 282, 75, 47, 0.1, 1.1, 4, l) +
    locks(200, 282, 75, 47, 2.05, 3.04, 4, l) +
    locks(200, 317, 60, 21, 0.3, 2.8, 7, l) +
    locks(200, 163, 71, 38, 3.8, 5.6, 5, e * 0.7);
  const pom = `<path d="M271 305q21-3 20 10-2 11-20 5z"/>${locks(281, 314, 7, 6, -0.9, 1.2, 3, l * 0.6)}`;
  const paws = `<path d="M153 327q-14 3-15 11 12 10 30 0l1-8M247 327q14 3 15 11-12 10-30 0l-1-8"/>`;
  const silhouette = pom + body + ears + head + tufts + paws;
  const top = s.bands[0].y,
    bot = s.bands.at(-1)!.y;
  const smoothed = s.bands.map((b, i) => {
    const near = [-2, -1, 0, 1, 2].map(
      (k) => s.bands[Math.max(0, Math.min(s.bands.length - 1, i + k))],
    );
    const w = [1, 2, 4, 2, 1];
    return {
      ...b,
      dose: near.reduce((v, b, k) => v + b.dose * w[k], 0) / 10,
      rgb: [0, 1, 2].map(
        (c) => near.reduce((v, b, k) => v + b.rgb[c] * w[k], 0) / 10,
      ),
      rainbow: near.reduce((v, b, k) => v + b.rainbow * w[k], 0) / 10,
      pearl: near.reduce((v, b, k) => v + b.pearl * w[k], 0) / 10,
    };
  });
  const stops = (mode: "rgb" | "rainbow" | "pearl") =>
    smoothed
      .map(
        (b) =>
          `<stop offset="${f(((b.y - top) / (bot - top)) * 100)}%" stop-color="${mode === "rgb" ? hex(b.rgb) : "#fff"}" stop-opacity="${(colorAlpha(b.dose) * (mode === "rgb" ? Math.max(0, 1 - b.rainbow - b.pearl) : b[mode])).toFixed(3)}"/>`,
      )
      .join("");
  const grad = (name: string, content: string) =>
    `<linearGradient id="${name}${id}" gradientUnits="userSpaceOnUse" x1="0" y1="${top}" x2="0" y2="${bot}">${content}</linearGradient>`;
  const special = (key: "rainbow" | "pearl", colors: string[]) =>
    s.bands.some((b) => b[key] > 0.01)
      ? `${grad(key + "mask", stops(key))}<linearGradient id="${key}${id}">${colors.map((c, i) => `<stop offset="${f((i / (colors.length - 1)) * 100)}%" stop-color="${c}"/>`).join("")}</linearGradient><mask id="${key}k${id}"><rect width="400" height="420" fill="url(#${key}mask${id})"/></mask>`
      : "";
  return `<defs><linearGradient id="fur${id}" x1="0" y1="0" x2=".6" y2="1"><stop stop-color="#fff1dc"/><stop offset=".55" stop-color="#f3dfbe"/><stop offset="1" stop-color="#ddc29e"/></linearGradient>${grad("coat", stops("rgb"))}${special("rainbow", RAINBOW)}${special("pearl", ["#fff7eb", "#efc6de", "#c5def2", "#f3d2e2", "#fff7eb"])}<g id="shape${id}">${silhouette}</g><clipPath id="sil${id}">${silhouette}</clipPath><filter id="edge${id}" x="-15%" y="-15%" width="130%" height="130%"><feMorphology in="SourceAlpha" operator="dilate" radius="1.1" result="edgeAlpha"/><feFlood flood-color="#b59678" result="edgeColor"/><feComposite in="edgeColor" in2="edgeAlpha" operator="in" result="outline"/><feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge></filter><radialGradient id="soft${id}"><stop stop-color="#fff8e9" stop-opacity=".6"/><stop offset="1" stop-color="#fff8e9" stop-opacity="0"/></radialGradient></defs>
 <ellipse cx="200" cy="349" rx="87" ry="9" fill="#765744" opacity=".12"/>
 <use href="#shape${id}" filter="url(#edge${id})" fill="url(#fur${id})"/>
 <g clip-path="url(#sil${id})"><ellipse cx="200" cy="286" rx="63" ry="61" fill="url(#soft${id})"/><rect x="65" y="65" width="270" height="295" fill="url(#coat${id})"/>${(["rainbow", "pearl"] as const).map((k) => (s.bands.some((b) => b[k] > 0.01) ? `<rect x="65" y="65" width="270" height="295" fill="url(#${k}${id})" mask="url(#${k}k${id})"/>` : "")).join("")}
 <ellipse cx="200" cy="153" rx="73" ry="33" fill="url(#soft${id})"/>
 <g fill="none" stroke="#b99976" stroke-opacity=".23" stroke-width="2" stroke-linecap="round">${m > 0.2 ? `<path d="M127 215q7 11 13 10m-9-18q7 10 13 10m129-2q-7 11-13 10m9-18q-7 10-13 10M171 250q-6 12-3 19m14-14q-4 13 0 17m21-17q5 13 1 20m15-23q6 12 3 20"/>` : ""}${l > 0.2 ? `<path d="M129 296q5 15 10 18m-7-8q4 18 10 23m129-33q-5 15-10 18m7-8q-4 18-10 23m-83-5q-4 10 0 13m13-12q-3 10 0 15m22-15q3 10 0 15m12-16q4 10 0 13"/>` : ""}</g></g>
 <g fill="#e7b4a2"><ellipse cx="146" cy="${f(earY + 2)}" rx="${f(erx * 0.59)}" ry="${f(ery * 0.61)}"/><ellipse cx="254" cy="${f(earY + 2)}" rx="${f(erx * 0.59)}" ry="${f(ery * 0.61)}"/></g>
 <ellipse cx="200" cy="212" rx="30" ry="21" fill="#fff4df" opacity=".65"/>
 <g fill="#d99591" opacity=".38"><ellipse cx="143" cy="213" rx="13" ry="8"/><ellipse cx="257" cy="213" rx="13" ry="8"/></g>
 <g fill="#302823"><ellipse cx="172" cy="185" rx="9" ry="11"/><ellipse cx="228" cy="185" rx="9" ry="11"/></g><g fill="#fff8ed"><circle cx="175" cy="181" r="3.3"/><circle cx="231" cy="181" r="3.3"/></g>
 <path d="M194 202q6-4 12 0-2 6-6 7-4-1-6-7z" fill="#ce8c85"/><path d="M200 209v4m0 0q-5 5-9 0m9 0q5 5 9 0" fill="none" stroke="#9a7362" stroke-width="1.7" stroke-linecap="round"/>
 <g stroke="#b89b80" stroke-width="1.3" stroke-linecap="round"><path d="M176 207l-21-3m21 8-21 3m69-8 21-3m-21 8 21 3"/><path d="M173 275q-8 11 0 15m54-15q8 11 0 15m-77 47 7 1m86-1-7 1" fill="none"/></g>
 ${s.endedAt && showAccessory ? accessoryArt(s.accessoryId, id, e) : ""}`;
}
export function portraitSVG(s: Session, showAccessory = true) {
  const id = "p" + s.id.replace(/[^a-z0-9]/gi, "").slice(0, 10);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="60 65 280 294" width="400" height="420"><rect width="400" height="420" rx="28" fill="#fbf3e6"/>${animalGroup(s, id, showAccessory).replace(/\n/g, "")}</svg>`;
}
export function shellLayer(targetX: number, targetY: number, open: boolean) {
  return `<defs><radialGradient id="shellfill" cx=".38" cy=".3" r=".8"><stop stop-color="#fff8ec"/><stop offset=".65" stop-color="#f4dcc6"/><stop offset="1" stop-color="#dfbf9f"/></radialGradient><radialGradient id="windowfade"><stop stop-color="#000" stop-opacity="${open ? 1 : 0}"/><stop offset=".65" stop-color="#000" stop-opacity="${open ? 0.9 : 0}"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient><mask id="window"><rect width="400" height="420" fill="#fff"/><ellipse cx="${f(targetX - 78)}" cy="${f(targetY)}" rx="112" ry="54" fill="url(#windowfade)"/></mask></defs><g mask="url(#window)"><ellipse cx="200" cy="215" rx="118" ry="152" fill="url(#shellfill)"/><g fill="#d9bf9c" opacity=".5"><circle cx="150" cy="120" r="5"/><circle cx="246" cy="98" r="3.5"/><circle cx="268" cy="168" r="6"/><circle cx="128" cy="236" r="4"/><circle cx="182" cy="300" r="5.5"/><circle cx="262" cy="282" r="3.5"/></g><ellipse cx="160" cy="130" rx="26" ry="44" fill="#fff" opacity=".3" transform="rotate(-24 160 130)"/></g>`;
}
