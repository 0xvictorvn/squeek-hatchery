# Squeek Hatchery

**Hatch and raise your own hamster.**

A community character-incubation game powered by live Squeekchain hamster activity, with LED-dot artwork, downloadable portraits, wallet-verified saved results, and a weekly leaderboard.

**[Play Squeek Hatchery](https://squeek-hatchery.xyz/)** · [In-game Docs](https://squeek-hatchery.xyz/docs) · [Weekly leaderboard](https://squeek-hatchery.xyz/leaderboard)

The current application is in [`squeek-hatchery-demo/`](squeek-hatchery-demo/). Run the development and build commands from that folder. Earlier root-level prototype files are retained as historical source.

## How to play

1. Choose a **Pulse**, **Relay**, or **Prism** egg. Confirming the egg locks its species.
2. Move the heat lamp beside the stationary egg using pointer, touch, or keyboard controls. Warm **Head**, **Body & Chest**, and **Belly & Tail** to develop those regions.
3. Complete **60 seconds of valid illumination**. Wheel speed affects lamp intensity; a resting wheel still supplies gentle base warmth while its signal remains valid.
4. Reveal the finished hamster, accessory, and background. Export the completed **1600×1600 PNG** and **JSON metadata**.

During incubation the shell reveals the hamster only through the illuminated area; the final accessory and background stay hidden until completion. Coat palette follows wheel distance, and cyber accessory follows wheel effort. Both lock together at first illumination. Rarer traits appear less often.

There is no manual Pause/Resume. Restarting or reconnecting an unfinished attempt keeps the chosen egg, clears unfinished growth and trait locks, and requires fresh illumination. Completed saved results stay completed. **New Egg** returns to species selection.

## Growth and score

| Region | Level | Points |
| --- | --- | --- |
| Head | Lv0–Lv10 | 0–10 |
| Body & Chest | Lv0–Lv10 | 0–10 |
| Belly & Tail | Lv0–Lv10 | 0–10 |

Each integer region level contributes one point. Reaching Lv10 caps that region's growth and points; it does not automatically move the lamp.

**Total = Head + Body & Chest + Belly & Tail + Coat Palette + Cyber Accessory + LED Background**

Regions contribute **0–30 points**. Each trait contributes **1, 2, 4, or 8 points**, giving a completed character **3–54 points** in total.

| Trait | 1 point | 2 points | 4 points | 8 points |
| --- | --- | --- | --- | --- |
| Coat Palette | Apricot, Cocoa, Cloud, Rose | Sage, Lilac, Midnight | Pearl, Aurora | Spectrum |
| Cyber Accessory | Lumen clasp, Aether visor, Petal mitts, Auricle clip | Holo lenses, Bio-link wraps, Companion orbs | Eclipse mask, Prism sanctuary | Aurora bloom |
| LED Background | Mosslight Grove, Peach Cloud Terrace, Amber Mycelium, Rainlit Canopy | Tidalglass Cove, Lavender Conservatory, Moonseed Orchard | Aurora Nexus, Prism Cathedral | Celestial Bloom |

## Guest, Demo, and Ranked play

- **Guest and Demo:** temporary, unranked play in browser memory. Refreshing clears that local play.
- **Ranked:** sign in by signing a SIWE wallet message. The server validates gameplay and saves completed results in SQLite. The current demo allows three saved Ranked plays per wallet per day; unfinished restarts do not consume an extra completed-play allowance.
- **Weekly leaderboard:** the best completed character per wallet competes in the weekly Top 100. Saved characters have public result links.

Wallets are used for authentication and saved Ranked play. **NFT minting is not enabled in this demo.** Included Solidity sources and artifacts are reference/test material; contract deployment fields remain null.

## Run locally

Use **Node.js 24 or newer** and clone the whole repository, including the sibling artwork folder:

```sh
cd squeek-hatchery-demo
npm ci
npm run dev
```

Open the local URL printed by Vite. The development server includes the SQLite API and artwork mount.

## Build and serve

```sh
cd squeek-hatchery-demo
npm ci
npm run build
node --experimental-strip-types src/server.ts
```

The production server serves `dist/`, `/api/*`, and `/lab-assets/*`. It defaults to `127.0.0.1:4173`; configure `HOST` and `PORT` as needed and use an HTTPS reverse proxy for public access. Set `SQUEEK_DB_PATH` to a persistent location outside deployment releases. The default is `cache/hatchery-backend.sqlite`.

Use localhost for development and HTTPS for public play. Publishing source to GitHub does not automatically redeploy the VPS.

## Source and validation

- [`squeek-hatchery-demo/`](squeek-hatchery-demo/): current TypeScript/Vite frontend, Node/SQLite API, tests, and reference contract artifacts.
- [`hamster-trait-lab/assets/`](hamster-trait-lab/assets/): runtime character atlases and LED backgrounds, kept alongside the application.
- Earlier root-level prototype files: historical source, separate from the current application.

`npm run build` includes TypeScript checking. The published application passed the production build and **85 non-browser logic/API tests**. See [the application README](squeek-hatchery-demo/README.md) for its non-browser test command, runtime asset list, and optional browser/contract test prerequisites. No new real-wallet sign-in or browser export check is claimed by that test count.

The LED demo builds on the [upstream v0.2.0 source](https://github.com/identity-md-launches/launch-2854-build-squeek-hatchery-company), pinned in [`UPSTREAM.json`](squeek-hatchery-demo/UPSTREAM.json). Third-party notices remain under [`artifacts/`](squeek-hatchery-demo/artifacts/). The [original prototype README](https://github.com/0xvictorvn/squeek-hatchery/blob/c7511c93dd356628aa3fe453201dae3e1d0a333b/README.md) is available in Git history.
