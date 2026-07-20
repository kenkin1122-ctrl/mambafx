# Mamba FX

## Project overview

A Deriv trading dashboard with two parts:

- **Frontend** (`index.html` + JS modules) — chart, signals, drawing tools, Market State Discovery (MSD) system. Designed to be hosted on GitHub Pages.
- **Backend** (`src/index.js`) — Cloudflare Worker that handles Deriv OAuth token exchange (`/api/token`, `/api/accounts`, `/api/otp/:id`). Deployed via Wrangler.

The Replit environment serves these files statically so the frontend (and audit tools) can be previewed in browser. The Cloudflare Worker is deployed separately.

## Running locally on Replit

A static file server (`serve`) hosts all HTML and JS files:

```
npm start   # or use the configured workflow
```

The app is available at the Replit preview URL.

## Key files

| File | Purpose |
|------|---------|
| `index.html` | Main trading dashboard (do not refactor) |
| `src/index.js` | Cloudflare Worker backend |
| `wrangler.jsonc` | Cloudflare Workers config |
| `msd-phase7-audit.html` | MSD Phase 7 read-only sufficiency audit tool |

## MSD system

The Market State Discovery system lives inside `index.html`. Key constants:

- DB: `mfx_msd_states`, Store: `MarketStates`
- `MSD_RAW_HISTORY_VERSION` = `'raw_price_history_v1'`
- `MSD_RAW_HISTORY_WINDOW_LENGTH` = `20`

Phase 6B added prospective raw-history capture. Phase 7 audit (`msd-phase7-audit.html`) is a read-only browser tool that checks whether enough valid prospective data has accumulated.

## User preferences

- Do NOT rewrite, refactor, or alter any existing functionality.
- Only add new code / new features.
- Existing code was built with Claude and is working correctly — treat it as stable.
