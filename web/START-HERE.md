# PLANKTON — editable website and terminal preview

Open a terminal in this extracted folder. Node.js 22.12 or newer is required.

## View the included build

```sh
node serve-preview.mjs
```

Open http://127.0.0.1:4173. The homepage, `/trade` and `/docs` work from the same server. Use `node serve-preview.mjs --port 4176` if the default port is occupied. Keep the terminal running while viewing the site. This is local hosting, not a permanent public deployment.

## Edit and build

This folder is part of the Bun workspace: run `bun install` once at the project root (not inside web/), then use the commands below from the project root. The development build keeps the browser title `LIVE preview`; production metadata remains PLANKTON.

```sh
bun install --frozen-lockfile    # once, at the project root
bun run dev:web
bun run test:web
bun run build:web
```

Open the URL printed by Vite. Changes reload automatically. A stopped preview can be restarted with the same command. The included build is in `dist/`; rebuild it after source changes.

## What is implemented

- Responsive homepage adapted from the preserved Clear Street reference, with PLANKTON's charcoal grid, exact extracted logo, product explanation, weekly roadmap, FAQ and functional navigation.
- Full-viewport desktop terminal with internal panel scrolling, focus/browser full-screen controls, command search, market favorites, chart crosshair/OHLC inspection, zoom/pan/reset, timeframes and position levels.
- Complete local trading workflows: tactile 2x/3x leverage, quote review, long/short simulation, pending-order edits/cancellation, position TP/SL, partial/full/fallback closes, add margin and a detailed isolated-risk panel. Run scenario previews an explicit hypothetical mark and simulates eligible triggers only after confirmation. Counter requests, Tape, Ledger and Rewards remain accessible.
- Searchable product documentation, listing rules, risk explanations, preview privacy and terms.
- GSAP scroll choreography, three chapter films, transparent hero and radial films, and a trader film that plays on hover or keyboard focus. The Studio dashboard moves from the side to centre as you scroll, then holds. All decorative motion has reduced-motion and pause support.
- Local Geist Sans and Geist Mono variable fonts, with light display headings and regular body copy; consistent steel card materials across landing, footer, terminal and supporting surfaces. See `THIRD-PARTY.md` for font/logo attribution, and `docs/media.md` / `docs/video-slots.md` for generated footage and compositing evidence.

## Boundaries

The terminal uses deterministic sample data and React session memory. Reloading resets the demo. No wallet, contracts, price feeds, deposits, signatures, authentication, transaction submission or backend integration is connected. Limit/stop and TP/SL instructions have no live keeper and never run automatically. Only the explicit Run scenario action can simulate eligible fills or protection exits; it rechecks market state, limits, collateral and spread. Scenario data, fees and 5% maintenance are illustrative. No automatic liquidation, elapsed borrow accrual or partial-fill engine is implemented. Market caps and release dates from the source plan are historical/planned, not live verification.

Read `docs/backend-handoff.pdf` and its editable Markdown before integrating a backend. `docs/source-map.md` records the four supplied documents, their contradictions and expansion overrides. Internal launch tactics are not exposed as public instructions.

The four original PDFs are included in `docs/source-documents/` for your developer. Keep that folder outside public hosting. Start backend work from the handoff's source-controlled interfaces and integration sequence; replace the sample model and values with verified server/contract state rather than treating the demo as a production risk engine.

## File map

| File | Purpose |
| --- | --- |
| `src/App.jsx`, `src/styles.css` | Homepage sections, roadmap, navigation and responsive layout |
| `src/usePageMotion.js`, `src/motion.css`, `src/MotionVideo.jsx`, `src/media.css` | Scroll transitions, accessible playback and local films |
| `src/Visuals.jsx` | Editable SVG/HTML scenes and brand treatment |
| `src/Dashboard.jsx`, `src/dashboard.css` | Full-viewport terminal, chart inspection, leverage/risk instruments and explicit demo scenarios |
| `src/MarketRail.jsx`, `src/market-rail.css`, `public/assets/companies/` | Company-logo market tiles and watchlist interactions |
| `src/lib/trading.mjs`, `tests/trading.test.mjs` | Deterministic quote, risk, order-edit and scenario engine; 18 behavior tests |
| `docs/dashboard-research.md` | Official terminal UX references and implementation boundaries |
| `src/Docs.jsx`, `src/docs.css` | Public product guide |
| `src/data/product.js` | Source-mapped product facts, weekly plan and FAQs |
| `public/assets`, `public/fonts` | Website media and typography |
| `reference/` | Recoverable original reference and comparison evidence |
| `TASK-STATE.md`, `docs/qa/` | Cumulative requirements and current verification evidence |

## Continue with Codex

“Read AGENTS.md, TASK-STATE.md, docs/source-map.md and docs/backend-handoff.md. Preserve the current PLANKTON design, canonical logo, grid, complete navigation and user-approved follow-up changes. Work on the requested integration without replacing the frontend. Keep live preview visible, identify simulated versus verified live behavior, and recheck affected routes, responsive views and package.”

The original reference replay can be started with `node reference/server.mjs`. It uses saved reference files and may need network access for uncached original assets. It is comparison material, separate from the production PLANKTON build. Original-source materials and font provenance are documented in THIRD-PARTY.md.
