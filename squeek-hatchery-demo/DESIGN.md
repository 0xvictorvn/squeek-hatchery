# Squeek Hatchery design

The existing cozy cream/plum hatchery remains the visual system. The product is a stationary egg under a movable lamp; the warm stage carries the interaction. Demo and NFT modes share that incubator while keeping their collections separate. Implementation is a Vite/TypeScript single page with hash navigation and local SVG art.

## Implemented tokens

Source: `src/style.css:1`.

| Role | Token | Value |
| --- | --- | --- |
| Page / surface | `--color-bg` / `--color-surface` | #fbf5ec / #fffaf3 |
| Main / secondary text | `--color-text` / `--color-text-muted` | #3b2a24 / #6b564c |
| Structure | `--color-border` | #e8d6c0 |
| Primary action / hover | `--color-accent` / `--color-accent-hover` | #a8492a / #8f3c21 |
| Primary label | `--color-accent-text` | #ffffff |
| Incubator / stage text | `--color-stage` / `--color-stage-text` | #33263a / #f6ebe0 |
| Rest / running / unavailable backgrounds | `--color-rest` / `--color-run` / `--color-missing` | #e9f1e4 / #fbe7d3 / #f6dede |
| Focus | `--color-focus` | #3b2a24 |

Lamp color uses the runtime `--lamp` property for beam/bulb lighting only. Fur uses the shared SVG renderer, not a global CSS recolor. Artwork starts with #fff1dc → #f3dfbe → #ddc29e shading, a #b59678 outer edge, muted pink inner ears and #302823 eyes. Local color opacity caps at 0.82; five-neighbor smoothing feathers the same coordinate-based exposure across connected parts. Pearl adds pink/blue sheen; rainbow uses the seven `RAINBOW` stops from `src/rules.ts`. Accessories use harmonious muted cloth, botanical greens, brass and small translucent details.

## Typography

The system stack is `ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, -apple-system, sans-serif`. These are fallbacks; no remote font request or bundled font is required.

The six source sizes are 13, 16, 18, 22, 28 and 36 px via `--text-sm` through `--text-2xl`. Body is 16 px/1.5; compact mobile introduction, notes and preview labels use 13 px. Headings descend from 28 px mobile / 36 px desktop to 22 px h2 and 18 px h3, at line-height 1.15. Weights are 400, 700 and 800. Headings use balanced wrapping, h1 tracking −0.01em; no small tracked capitals are used. Inputs stay 16 px. Timers/counters use tabular numbers, and full addresses, long names and BigInt counters wrap rather than clipping.

## Layout and responsive behavior

Spacing tokens are 4, 8, 12, 16, 24 and 32 px. The shared container is 1,180 px maximum with 16 px inline padding. Header brand sits left, wallet control right; auxiliary nav is shown from 640 px. The exact required introduction and launch status precede mode buttons; the egg's main action sits **above** the stage so it stays on the first 390 px screen.

Below 980 px, the incubator and signal/color/accessory/growth panels form one column. At 980 px the grid becomes `minmax(0,1.25fr) minmax(0,1fr)`; the stage is capped using `100svh - 330px`. The stage retains a 400:420 coordinate system. Below 640 px it is at most 343 px wide and 360 px tall. The final result uses one column on mobile, portrait plus review controls from 980 px. Collections use auto-fill columns with a 150 px minimum; the synthetic study uses 145 px minimum columns.

Shrinkable grid children, `minmax(0,1fr)` preview/stat columns and wrapping keep complete values visible at 320/390/768/1440. Portrait images have intrinsic dimensions, and the QA study is progressively disclosed with a native details/summary control. Dialogs become bottom sheets below 640 px, center above it, and include safe-area padding.

## Surfaces and shapes

Cards have a soft two-layer shadow (`0 1px 2px` at 6% plus `0 6px 18px` at 6%) and no outline border. Inputs/buttons use structural borders and no outer shadow. Radii are 10, 16 and 24 px for small controls, cards/sheets and the stage/portraits; pill buttons use 999 px. The sheet backdrop is 45% dark plum. The stage's active pause message has its own legible plum surface and explicit text.

## Components and states

- `.btn` is 48 px high; `.small` is 44 px. One filled primary action is used for the current task; secondary actions are neutral. Hover changes background/border, press scales to .96, `:focus-visible` draws a 2 px foreground ring with 2 px offset, and disabled states dim to 60%. Reduced motion removes press scaling and effectively eliminates transitions.
- `.mode-tabs` uses real buttons with `aria-pressed`; a selected cream fill/border distinguishes Demo/My NFTs. A running incubation or pending transaction blocks mode changes with a reason. A pagehide releases its incubation lock and pauses the session; a history restore reloads the card and requires Resume to reacquire the lock. Pre-start lamp aim survives loading the latest saved session.
- Stage: a fixed-position egg, soft masked shell window, perpendicular beam, rail and an accessible vertical slider. Pointer/touch dragging, arrows, Home/End, PageUp/PageDown and region shortcut buttons share the same geometry. The lamp uses a 3 px white focus perimeter on the plum stage. Progress is textual and visual; unavailable/rest/running states always have labels.
- Data cards use headings, native definition lists, paired swatches/miniatures and trait meters. Missing previews are visibly hatched and labeled Unavailable. Accessories show current/next and exact remaining work units, never a picker.
- Signal feedback stays at Running or Resting across identical fresh hardware polls; repeated polls add no work or recovery delay. Original observation/receipt timestamps still expire, and unavailable data pauses incubation until the existing three-second recovery completes. This behavior uses `src/rules.ts` and the polling/frame loop in `src/app.ts`; it shares the existing status text and color tokens.
- Collection cards have stable local IDs: one egg card changes to a hamster. Legacy SVGs and external NFT art are displayed through `<img>`, never inserted as HTML. The generated live stage uses only validated numeric state and the site's own renderer.
- Review uses a labeled 16 px input, inline validation, a trait list, save and SVG/JSON downloads. Show coat is explicitly view-only. Canonical art always includes the accessory. Names are locked during checking/proof/signing/receipt states; confirmed results remain frozen.
- My NFTs has unavailable/loading/empty/holdings/error/claim/hatch states, visible disabled reasons, full address/network/Sepolia ETH, paginated ownership reads and receipt-based success. Runtime null config is explicit. These are test integrations; the public site makes no live mint claim.
- The connect sheet lists discovered wallet names/marks, mobile wallet-browser links and Coinbase Smart Wallet. External wallet labels/icons are escaped. Background content is inert, Tab stays inside, Escape/backdrop/Close dismiss, and focus returns to the live header control. Rejection leaves an inline retry message.

## Artwork and reuse

`src/art.ts` owns the sole canonical hamster renderer used by the stage, review, saves, downloads and verifier-bound NFT result. A union silhouette/outer edge removes torso/cheek seams. Before hatch, the stage animal is clipped to the egg interior so the pom and long fur cannot protrude through an opaque shell; hatch removes that clip without changing traits. A pear body supports a large head, attached ears, subtle paws/feet and a small partly hidden pom. Regional curved locks and shading develop independently; there are no new coat-pattern primitives. Portrait export crops the original stage coordinates to `viewBox="60 65 280 294"` at 400×420 for clearer mobile detail.

Accessory IDs/designs live in `src/rules.ts` and `accessoryArt`; IDs 10/11 are the only specials. Keep versioned IDs stable. The crop-aware `accessoryMiniature` makes small pins readable. The synthetic QA disclosure renders 21 labeled studies: three same-color levels, three mixed growth variants, mixed colors, pearl/rainbow and twelve accessories. These are a visual study, not public hardware fallback data.

Reuse the existing `.layout`, `.card`, `.stats`, `.pair`, `.row` and `.btn` primitives for further product surfaces. Keep irreversible-action explanations and disabled reasons beside their controls. Keep new parameters in pure rules and canonical export code; a view toggle must never change stored metadata. Extend the six-size scale and semantic colors only when an actual use case needs it.

Review method: Jakub Krehel's Better Interface (MIT) across accessibility/layout/writing/typography/colors/UI; implemented-design documentation adapted from Paul Bakaus's Impeccable (Apache-2.0). Attribution/licenses are retained under `artifacts/`. Actual rendered coverage, corrections and limitations are recorded in `VALIDATION.md`.
