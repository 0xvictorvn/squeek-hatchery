# Squeek Hatchery — current LED demo

See the [repository README](../README.md) for the current gameplay, complete trait point tables, scoring, setup, and production serving. This is the same application source as the deployed LED character demo.

## Requirements and runtime assets

- Node.js 24+ for `node:sqlite` and native TypeScript stripping.
- Keep sibling `../hamster-trait-lab/assets/` when cloning or moving the project.
- Runtime assets: `families-v2.png`, `pulse-evolution-v1.png`, `relay-evolution-v1.png`, `prism-evolution-v1.png`, `evolution-atlases.json`, and the ten PNG backgrounds in `backgrounds/led/`.
- Vite and the standalone server mount them at `/lab-assets/`. Missing canonical assets block PNG export.

Run `npm ci`, then `npm run dev`. Build with `npm run build`, and serve with `node --experimental-strip-types src/server.ts`. The standalone server accepts `HOST`, `PORT`, and `SQUEEK_DB_PATH`; use a persistent SQLite path for public operation.

## Tests

Run portable logic/API regressions from this directory:

```sh
node --experimental-strip-types --test tests/api-response.test.ts tests/backend-api.test.ts tests/daily-distance.test.ts tests/led-policy-session.test.ts tests/ranked-recovery.test.ts tests/round-2-regressions.test.ts tests/round-3-regressions.test.ts tests/round-4-regressions.test.ts tests/round-5-regressions.test.ts tests/round-6-regressions.test.ts tests/rules.test.ts
```

`npm test` additionally includes browser tests that need the local browser runtime described in their harness. Contract tests require Foundry (`forge`, `anvil`).

The historical `scripts/check-delivery.mjs` tool checks a scoped source/artifact review against Git changes. Without Git, it requires an explicitly supplied SHA-256 baseline manifest (`DELIVERY_BASELINE`). It is not a fresh-clone build command or a substitute for runtime tests.

## Demo boundary and attribution

Wallets authenticate SIWE sessions and save ranked results. NFT minting is deferred; `public/hatchery.config.json` keeps deployment fields null. The current game rules live in `src/game-policy.ts`; server authority and persistent storage live in `src/backend.ts`.

The pinned upstream source is recorded in `UPSTREAM.json`. Third-party license notices remain under `artifacts/`; contract artifacts and their deployment/proof documentation are retained as reference material.
