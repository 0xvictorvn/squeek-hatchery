// Regenerate the share card from the site's own SVG, without external image requests.
// PLAYWRIGHT=/absolute/path/to/playwright/index.mjs node scripts/share-card.mjs
import fs from "node:fs/promises";
import { freshSession } from "../src/rules.ts";
import { portraitSVG } from "../src/art.ts";

const { chromium } = await import(process.env.PLAYWRIGHT || "playwright");
const animal = freshSession("share-card");
// A neutral product illustration, independent of hardware readings or saved players.
animal.regions.forEach((region) => {
  region.growth = 0.65;
});
animal.accessoryId = 5;
animal.endedAt = "illustration";
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Squeek Hatchery share card</title>
    <style>*{box-sizing:border-box}body{margin:0;width:1200px;height:630px;background:#fbf5ec;color:#3b2a24;display:flex;align-items:center;gap:60px;padding:90px;font-family:system-ui,sans-serif}.portrait{width:300px;flex:none}.portrait svg{display:block;width:300px;height:315px;border-radius:24px}.copy{flex:1;min-width:0}h1{font-size:72px;font-weight:400;letter-spacing:-.02em;line-height:1.1;margin:0 0 28px}p{font-size:34px;line-height:1.4;color:#6b564c;margin:0}</style>
    <body><div class="portrait">${portraitSVG(animal)}</div><div class="copy"><h1>Squeek Hatchery</h1><p>Hatch a hamster with light</p><p style="font-size:24px;margin-top:24px">Local demo · NFT minting is not live yet</p></div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  if (
    (await page.locator("svg").count()) !== 1 ||
    (await page.locator("img").count())
  )
    throw new Error("Share illustration must be self-contained SVG");
  await fs.mkdir("public", { recursive: true });
  await page.screenshot({ path: "public/og-image.png" });
  console.log(
    "Created public/og-image.png (1200×630) using the inline hamster portrait.",
  );
} finally {
  await browser.close();
}
