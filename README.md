# Squeek Hatchery

An English-language, unofficial Squeekchain incubation prototype. A real hamster powers a movable lamp; drag the lamp vertically to allocate growth to ears, fur or a short pom tail. The egg stays still and the lamp aims along the local surface normal. Incubate for 60 seconds of valid, visible play, name your creature, save it locally or export SVG/JSON.

## Run

Node 22 or newer. `npm ci`, then `npm run dev`. `npm run build` creates a relative-path static export in `dist/`. `npm test` checks growth, work accounting, data validation, exported images and ERC721 behavior on a local EVM. `npm run compile` emits ABI and bytecode in `artifacts/`.

## Controls and rules

Drag the lamp vertically, use Up/Down/Home/End on the focused lamp, or select Head / Body / Belly. The egg stays fixed. The lamp moves on a vertical rail and changes angle along the normal of the egg's ellipse. Surface lighting is a stylized 2D approximation. Only the illuminated anatomy region grows. Ears stay rounded, body outline becomes fluffy, and the tail stays a short pom. IDLE supplies a labeled 12% maintenance glow; unavailable hardware pauses the session with a three-second recovery countdown.

`src/incubation.js` defines the current rules and renderer; `src/model.js` retains shared validation and the legacy portrait renderer so older saved creatures stay recognizable. Local coat exposure is recorded in 15 soft vertical bands, matching the vertical-only lamp control. More exposure increases color opacity to a cap. Other bands retain their color. New color smoothly replaces the old hue without subtractive paint mixing. Pattern family and layout lock at incubation start, using exact hardware work counters. New positive work reveals the locked pattern only under the lamp. Patterns decorate the front-facing forehead, chest and belly; the eye/nose area stays clear. The short pom tail never becomes a rat-like tail.

### Live appearance schedule

| Input | Appearance rule |
| --- | --- |
| Daily distance | Ordinary color changes every 5 meters; UTC date + distance segment determine hue. |
| 250, 750, 1,250... meters | Pearl passage, lasting 5 meters. |
| 500, 1,000, 1,500... meters | Rainbow passage, lasting 5 meters. |
| Cumulative work | Ordinary spots / patches / stripes rotate every 50 work units. Layout is stable within each bucket. |
| 1,000–1,199; 3,000–3,199... work | Star spots are available for new eggs. |
| 2,000–2,199; 4,000–4,199... work | Swirls are available for new eggs. |

The special pattern window is a **200-work-unit opportunity to start an egg**, not a timer or an expiry on a collected creature. After a window closes, ordinary patterns resume from the current 50-unit bucket. A locked egg never switches pattern mid-session. The UI shows current/next color and pattern, distance/work remaining, and the locked state. Work units are API units, not verified wheel revolutions. All thresholds are provisional art rules; Real cadence should be measured before changing these thresholds.

More light deepens local color. Rainbow and pearl affect only exposed bands; changing the lamp height preserves other bands. Re-exposing a band to another color gradually replaces it. No color picker, saved palette or public simulation controls. A resting hamster preserves the current distance/color within the UTC day; the API daily distance/date reset starts a new day's palette. Counter epoch changes cannot add artificial work to an egg. These mappings do not guarantee unique collectibles or physically accurate genetics.

## NFT implementation and deployment boundary

`contracts/SqueekHatchery.sol` uses OpenZeppelin ERC721URIStorage. Minting is free and nonpayable. Exact metadata with an embedded SVG is stored in the token URI, with no external image host or setter exposed by this contract. Metadata may be large and therefore gas-intensive: this is intended for Sepolia experiments. Caller-provided art is NOT proof of a genuine hardware session. The same wallet cannot mint a given session ID twice; a new ID or wallet can create another token. There is no fixed supply or authenticated session oracle.

No contract has been deployed and no transaction has been sent by this prototype. Until an actual deployed address is configured, the mint button clearly says it is unavailable. For deployment: compile/review/test the contract, deploy it on **Sepolia (11155111)**, verify source, then configure `VITE_HATCHERY_CONTRACT` and rebuild. The wallet pays Sepolia gas only and must confirm its own transaction. Never commit a private key. The UI checks chain ID and contract bytecode, submits `mint`, and waits for a real receipt. Compatible injected Ethereum wallet required. No mainnet payments.

## Project status

This is an editable community prototype. Artwork, lighting and balance remain open to refinement. See VALIDATION.md for completed checks and remaining verification. All UI and documentation are in English.

Collection records are saved only in the current browser. SVG and JSON downloads are portable backups. The prototype supports the latest 30 local companions. No user tracking or backend.
