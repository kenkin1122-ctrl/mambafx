# System Architecture — Market State Discovery Laboratory

## Overview

Mamba FX / MSD Laboratory is a **zero-build-step, single-file web application** for live Deriv market tick analysis, automated trading bots, and scientific discovery of statistically significant market states.

The entire front-end is contained in one file (`index.html`, ~36K lines). There is no bundler, no transpiler, no framework. The application is designed to be hosted on GitHub Pages and runs entirely in the browser.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        USER BROWSER                                  │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                     index.html                                │   │
│  │   ┌────────────────┐  ┌──────────────────┐  ┌────────────┐  │   │
│  │   │  Inline CSS    │  │  Inline JS ~32K  │  │  HTML DOM  │  │   │
│  │   │  (~500 lines)  │  │  lines of app    │  │  (~4K ln)  │  │   │
│  │   └────────────────┘  └──────────────────┘  └────────────┘  │   │
│  │                              │                                │   │
│  │   <script type="module" src="mtf/src/index.js">              │   │
│  │         ↓                                                     │   │
│  │   ┌─────────────────────────────────────────┐                │   │
│  │   │     mtf/src/ ES Module Tree             │                │   │
│  │   │  (MTF Structure + Njanja Analysis)      │                │   │
│  │   └─────────────────────────────────────────┘                │   │
│  │                                                               │   │
│  │   ┌──────────────┐  ┌────────────────┐  ┌────────────────┐  │   │
│  │   │  IndexedDB   │  │  localStorage  │  │  sessionStorage│  │   │
│  │   │  (3 DBs)     │  │  (drawings,    │  │  (bot drag     │  │   │
│  │   │              │  │   preferences) │  │   positions)   │  │   │
│  │   └──────────────┘  └────────────────┘  └────────────────┘  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                  │                              │                     │
│          WebSocket (wss://)            HTTPS API calls               │
└──────────────────│──────────────────────────────│────────────────────┘
                   │                              │
    ┌──────────────▼────────────┐    ┌────────────▼───────────────────┐
    │   Deriv Public WebSocket  │    │  Cloudflare Worker Backend     │
    │   wss://ws.binaryws.com   │    │  mambafx-backend.kenkin1122    │
    │   (tick feed, account     │    │  .workers.dev                  │
    │    data, contract trading)│    │  /auth/start  (OAuth PKCE)     │
    │                           │    │  /me/session  (session check)  │
    └───────────────────────────┘    │  /me/accounts (account list)   │
                                     │  /ws/otp      (WS auth token)  │
                                     │  /logout      (session clear)  │
                                     │  KV: SESSION namespace          │
                                     └────────────────────────────────┘

    ┌────────────────────────────────────────────────────────────────┐
    │   Replit / Local: node server.js                               │
    │   Port 5000 — static file server + Phase 8 API                │
    │   GET  /api/phase8/seal   → phase8-engine.js getSeal()        │
    │   POST /api/phase8/run    → phase8-engine.js runCampaign()    │
    └────────────────────────────────────────────────────────────────┘
```

## Front-End Architecture (index.html)

### Page System

The application uses a single-page show/hide pattern. All ~30 pages exist simultaneously in the DOM; `showPage(which)` toggles `display:block/none` and calls each page's init hook if needed.

Pages are organized in navigation rows:
- **Row 1**: Live Tick Feed, Candle Charts, 5-Tick Engine, Trading Grid, Analysis Tool, ML Features
- **Row 2**: Ups/Downs Bot, Digit Tracker, Digits Bot, API Diagnostics
- **Row 3**: MTF Structure, Njanja Analysis, Rise/Fall Autobot, ADX Bot, Aggression Bot, Mamba FX Bot
- **Row 4 (MSD Lab)**: Positive Event Browser, Snapshot Inspector, Feature Distribution, Correlation Matrix, Search/Filter, Experiment Runner, Knowledge Base, Research Validation Suite, Workbench, Phase 8 Campaign

### Inline JavaScript Architecture

The inline JS in `index.html` is organized into major functional sections:

1. **Developer AI Mode** (~lines 3388–4360): Real-time debug state broadcaster
2. **MSD Core** (~lines 4360–12460): All MSD functions, constants, IndexedDB operations
3. **Live Tracker** (~lines 12461–14000): WebSocket tick processing, run detection
4. **Trading Grid** (~lines 14000–18000): Authenticated trading interface
5. **Bot Engines** (~lines 18000–25000): Prediction Bot, Only Ups/Downs Bot, ADX Bot, Aggression Bot, RFA Bot, Mamba FX Bot, DAB Bot
6. **Page routing + session** (~lines 25680–26000): showPage(), session checks, OAuth flow
7. **Indicator Charts** (~lines 26000–28000): Real-time MACD, BB, CCI, CHOP rendering
8. **MTF/Njanja hooks** (~lines 28000–30000): Grid session check
9. **MSD Lab UI** (~lines 30000–33200): Explorer, Snapshot Inspector, Distribution, Correlation, Search, Experiment Runner, Knowledge Base, Validation Suite, Workbench, Phase 8 Campaign UI

### MTF Module System (mtf/src/)

The MTF Structure and Njanja Analysis pages load `mtf/src/index.js` as a native ES module. This module tree is fully independent from the inline JS in `index.html` — it communicates only via `window.mtfPageInit()` and `window.__mtfDebug`.

**Boot sequence** (mtf/src/index.js):
1. Construct Panel instances and register in AppState
2. Wire module init functions (each subscribes to eventBus events)
3. Expose global handlers for inline onclick attributes
4. Connect WebSocket, load drawings from localStorage, start render loop

### Data Persistence

| Store | API | Contents | Scope |
|-------|-----|----------|-------|
| `mfx_msd_events` IndexedDB | `IDBDatabase` | MarketEvent records | Browser |
| `mfx_msd_states` IndexedDB | `IDBDatabase` | Labeled MarketState snapshots | Browser |
| `mfx_msd_experiments` IndexedDB | `IDBDatabase` | Experiment configurations | Browser |
| localStorage | `localStorage` | MTF drawings, user preferences, last market | Browser |
| sessionStorage | `sessionStorage` | Bot panel drag positions | Browser tab |

## Server Architecture (server.js)

A minimal Node.js HTTP server (zero npm production dependencies):

- Serves all static files from the project root
- Exposes `GET /api/phase8/seal` — calls `phase8-engine.js:getSeal()`
- Exposes `POST /api/phase8/run` — calls `phase8-engine.js:runCampaign(states)`
- 50 MB body limit for campaign payloads (large state arrays)
- CORS headers on all responses

## Phase 8 Engine (phase8-engine.js)

The Phase 8 statistical campaign engine runs in a Node.js `vm` context to isolate the MSD function library extracted from `index.html`:

1. **getSeal()**: Extracts lines `[4360, 12460)` from `index.html`, strips non-ASCII, executes in sandboxed vm, freezes the search space definition. Returns a cryptographically-hashed seal JSON.
2. **runCampaign(states)**: Receives MarketState records from the browser, runs `msdRunPhase7bDiscovery()` inside the vm context, returns ranked hypothesis results.

## Authentication Flow

1. User clicks **Login** → browser redirects to `BACKEND_URL/auth/start`
2. Cloudflare Worker initiates Deriv OAuth2 Authorization Code + PKCE
3. Deriv redirects back to Worker callback
4. Worker exchanges code for tokens, stores in KV SESSION store (HttpOnly cookie)
5. Browser calls `/me/session` to confirm authentication
6. Browser calls `/ws/otp` to get a one-time WebSocket token
7. WebSocket connects to `wss://ws.binaryws.com` using the OTP

## Deployment Targets

| Component | Target | Method |
|-----------|--------|--------|
| Front-end | GitHub Pages | `git push` to `main` branch |
| Backend | Cloudflare Workers | `wrangler deploy` |
| Development | Replit (node server.js) | Replit workflow |
