# Market State Discovery Laboratory
### Mamba FX — Scientific Trading Research Platform

A zero-build-step, single-file web application for live Deriv market tick analysis, automated trading bots, and statistical discovery of significant market states.

---

## What This Is

The Market State Discovery (MSD) Laboratory is a scientific platform for:

1. **Live tick monitoring** — Real-time Deriv WebSocket feed with indicator computation (MACD, BB, CCI, Choppiness, ADX, RSI, ATR, Stochastic, EMA, ROC)
2. **Automated bots** — Multiple configurable trading bots with different strategies
3. **Market State capture** — Captures labeled market snapshots into browser IndexedDB at event detection moments
4. **Statistical discovery** — Permutation-based hypothesis testing across 80 Non-Classical feature × lead-time combinations
5. **Phase 8 Campaign** — First official NC discovery protocol: tests whether path-dependent tick features predict 5-tick run outcomes

---

## Quick Start

### Development (Replit / local)

```bash
node server.js
# App available at http://localhost:5000
```

No npm install required. Server uses Node.js built-in modules only.

### Production

- **Frontend**: hosted on GitHub Pages (`https://kenkin1122-ctrl.github.io/mambafx/`)
- **Backend**: Cloudflare Worker (`https://mambafx-backend.kenkin1122.workers.dev`)

---

## Application Structure

All pages are in `index.html` (~36K lines). Navigation uses a single-page show/hide pattern.

### Trading Pages
| Page | Key | Description |
|------|-----|-------------|
| Live Tick Feed | `live` | Real-time V100 1s tick stream with 5-in-a-row run detection |
| Candle Charts | `candles` | Real-time candlestick chart with indicators |
| 5-Tick Engine | `engine` | Pattern-match run prediction engine |
| Trading Grid | `grid` | Authenticated Deriv trading interface |
| Analysis Tool | `analysis` | Technical analysis dashboard |
| Indicator Charts | `charts` | MACD, BB, CCI, Choppiness, ADX indicator charts |
| MTF Structure | `mtf` | Multi-timeframe structure analysis |
| Njanja Analysis | `njanja` | Multi-timeframe dashboard (11 timeframes) |

### Bot Pages
| Page | Key | Description |
|------|-----|-------------|
| Only Ups/Downs Bot | `oubot` | Multi-filter Rise/Fall bot |
| Rise/Fall Autobot | `rfabot` | ADX-pattern Rise/Fall automation |
| ADX Bot | `adxbot` | ADX + DI direction bot |
| Aggression Bot | `aggression` | High-frequency consecutive signal bot |
| Mamba FX Bot | `mfxbot` | Floating panel trading bot |

### MSD Laboratory Pages
| Page | Key | Description |
|------|-----|-------------|
| Positive Event Browser | `msdexplorer` | Browse and inspect captured market events |
| Snapshot Inspector | `msdinspector` | Detailed view of individual state snapshots |
| Feature Distribution | `msddistribution` | Statistical distributions of all features |
| Correlation Matrix | `msdcorrelation` | Feature correlation heatmap |
| Search / Filter | `msdsearch` | Query states by feature ranges |
| Experiment Runner | `msdexperiment` | Run parameterized discovery experiments |
| Knowledge Base | `msdknowledge` | Confirmed hypothesis registry |
| Research Validation Suite | `msdvalidation` | 20-point integrity checklist |
| Workbench | `msdworkbench` | Free-form analysis workspace |
| **Phase 8 Campaign** | `msdphase8` | **Official NC discovery campaign** |

---

## Phase 8 Campaign

The Phase 8 Campaign tests 80 hypotheses (16 Non-Classical features × 5 lead times) using 1,000-permutation Mann-Whitney tests.

### Running a Campaign

1. Open the app and go to **Phase 8 Campaign**
2. Wait for the Pre-flight Checklist to pass (≥20 checks)
3. Accumulate NC-eligible MarketStates (leave Live Tick Feed open)
4. Click **Run Campaign** when the checklist shows readiness
5. Results are ranked by p-value; significant findings are highlighted

### Campaign API (server-side compute)

```bash
# Get frozen search space seal
GET http://localhost:5000/api/phase8/seal

# Run campaign with state array
POST http://localhost:5000/api/phase8/run
Content-Type: application/json
{"states": [...MarketState records from IndexedDB...]}
```

---

## Key Files

| File | Purpose |
|------|---------|
| `index.html` | Entire application frontend |
| `server.js` | Static file server + Phase 8 API |
| `phase8-engine.js` | Node.js Phase 8 discovery engine |
| `mtf/src/index.js` | MTF ES module entry point |
| `src/index.js` | Cloudflare Worker OAuth backend |
| `wrangler.jsonc` | Cloudflare deployment config |

---

## Documentation

| Document | Contents |
|----------|----------|
| `PROJECT_STRUCTURE.md` | Full file tree with descriptions |
| `SYSTEM_ARCHITECTURE.md` | Architecture diagrams, data flow |
| `ENGINE_MAP.md` | All engines, functions, constants |
| `MODULE_DEPENDENCIES.md` | Import graph, dependency tree |
| `DATABASE_SCHEMA.md` | IndexedDB schema, all field definitions |
| `PHASE8_PROTOCOL.md` | Phase 8 campaign protocol, API, statistics |
| `SCIENTIFIC_PIPELINE.md` | End-to-end data → discovery pipeline |
| `DISCOVERY_PIPELINE.md` | Discovery engine internals, experiment system |
| `FEATURE_REGISTRY.md` | All 22 classical + 18 NC features |
| `CLAUDE_HANDOFF.md` | Developer handoff for continued development |
| `BACKEND.md` | Cloudflare Worker backend documentation |
| `RESEARCH_ROADMAP.md` | Future research directions |
| `RESEARCH_DEBT_REGISTER.md` | Outstanding scientific debt items |

---

## Audit & Standalone Tools

| File | Purpose |
|------|---------|
| `msd-phase7-audit.html` | Data sufficiency audit (read-only) |
| `msd-phase7b-discovery.html` | Phase 7B discovery runner |
| `msd-phase7c-verification.html` | Mathematical verification tool |
| `msd-nc-validation.html` | NC feature validation |
| `msd-phase8-campaign.html` | Campaign report viewer |

---

## Architecture Notes

- **No bundler, no transpiler, no framework** — runs directly in any modern browser
- **Zero npm dependencies** in production server code
- **Single-file design** — `index.html` is the application; add features by extending it
- **IndexedDB** stores all scientific data locally in the browser
- **GitHub Pages** compatible — all static assets, no server-side rendering
- **Cloudflare Worker** handles OAuth (session, token exchange) separately
