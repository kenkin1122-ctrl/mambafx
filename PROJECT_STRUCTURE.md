# Project Structure — Market State Discovery Laboratory (Mamba FX)

```
mambafx/
│
├── index.html                  # CORE: entire front-end application (~36,134 lines)
├── server.js                   # Node.js static file server + Phase 8 API (port 5000)
├── phase8-engine.js            # Phase 8 campaign engine (Node.js vm, server-side)
│
├── mtf/                        # ES-module tree — MTF Structure & Njanja Analysis tabs
│   ├── src/
│   │   ├── index.js            # Module entry point (loaded by index.html as type="module")
│   │   ├── core/
│   │   │   ├── AppState.js     # Shared panel/symbol/drawing state singleton
│   │   │   ├── EventBus.js     # Pub/sub event bus
│   │   │   ├── HistoryManager.js  # Undo/redo history
│   │   │   ├── debugRecorder.js   # Developer AI Mode HTTP relay
│   │   │   └── constants.js    # HTF_TFS / LTF_TFS timeframe lists
│   │   │   └── commands/
│   │   │       ├── Command.js         # Command interface
│   │   │       └── DrawingCommands.js # Undo-able drawing operations
│   │   ├── charts/
│   │   │   ├── Panel.js        # Canvas panel abstraction
│   │   │   ├── render.js       # Main render loop (requestAnimationFrame)
│   │   │   ├── socket.js       # Deriv WebSocket feed for MTF candles
│   │   │   ├── zoomManager.js  # Pan/zoom state
│   │   │   ├── replayManager.js
│   │   │   └── mtfDashboard.js # 11-timeframe dashboard grid
│   │   ├── drawing/
│   │   │   ├── model.js        # Drawing object registry
│   │   │   ├── render.js       # Drawing render pass
│   │   │   ├── renderHelpers.js
│   │   │   ├── interaction.js  # Mouse/touch drawing events
│   │   │   ├── candleMarking.js
│   │   │   ├── ids.js          # Drawing ID generator
│   │   │   └── objects/        # Drawing shape implementations
│   │   │       ├── DrawingObject.js    # Base class
│   │   │       ├── factory.js          # Shape factory
│   │   │       ├── BrushDrawing.js
│   │   │       ├── CircleDrawing.js
│   │   │       ├── FibRetracementDrawing.js
│   │   │       ├── HorizontalLineDrawing.js
│   │   │       ├── LineSegmentDrawing.js
│   │   │       ├── RectangleDrawing.js
│   │   │       ├── TextDrawing.js
│   │   │       └── VerticalLineDrawing.js
│   │   ├── ui/
│   │   │   ├── toolbar.js
│   │   │   ├── header.js
│   │   │   ├── analysisPanel.js
│   │   │   ├── decompPanel.js
│   │   │   ├── drawingManager.js
│   │   │   ├── floatingPanel.js
│   │   │   ├── propertiesPanel.js
│   │   │   ├── replayControls.js
│   │   │   ├── smartIntelligencePanel.js
│   │   │   ├── workspacePanel.js
│   │   │   ├── zonePresets.js
│   │   │   ├── candleCommentaryPanel.js
│   │   │   ├── fiveMinCommentaryPanel.js
│   │   │   └── candleCommentaryPanel.js
│   │   ├── ai/
│   │   │   ├── candleCommentary.js
│   │   │   ├── continuousLearning.js
│   │   │   ├── fiveMinCommentary.js
│   │   │   ├── marketIntelligence.js
│   │   │   ├── narrativeEngine.js
│   │   │   ├── probabilityEngine.js
│   │   │   └── ruleEngine.js
│   │   ├── analysis/
│   │   │   ├── candleGenome.js
│   │   │   ├── candlestickPatterns.js
│   │   │   ├── historicalSimilarity.js
│   │   │   ├── patternEngine.js
│   │   │   ├── similarity.js
│   │   │   ├── statistics.js
│   │   │   ├── structurePatterns.js
│   │   │   ├── swingLabels.js
│   │   │   ├── swingPoints.js
│   │   │   └── zonePatterns.js
│   │   ├── orderflow/
│   │   │   └── proxy.js        # Order-flow WebSocket proxy
│   │   ├── utils/
│   │   │   ├── color.js
│   │   │   ├── dom.js          # $(id) helper + escapeHtml
│   │   │   └── geometry.js
│   │   └── workspace/
│   │       ├── learningLog.js
│   │       ├── storage.js      # Drawing autosave/load (localStorage)
│   │       └── workspaceManager.js
│   └── tools/
│       └── mfx-debug-server.js # Dev-only: HTTP relay for Developer AI Mode
│
├── src/
│   └── index.js                # Cloudflare Worker — OAuth backend (deployed via Wrangler)
│
├── callback.html               # Legacy OAuth callback page (no longer used in main flow)
├── msd-nc-validation.html      # Standalone NC feature validation tool
├── msd-phase7-audit.html       # Phase 7 prospective data sufficiency audit tool
├── msd-phase7b-discovery.html  # Phase 7B discovery runner (standalone)
├── msd-phase7c-verification.html # Phase 7C verification runner (standalone)
├── msd-phase8-campaign.html    # Phase 8 campaign report viewer (standalone)
│
├── wrangler.jsonc              # Cloudflare Workers deployment config
├── .replit                     # Replit environment config
├── replit.md                   # Project notes and user preferences
│
├── README.md                   # Project overview
├── BACKEND.md                  # Cloudflare Worker backend documentation
├── RESEARCH_DEBT_REGISTER.md   # Outstanding scientific debt items
├── RESEARCH_ROADMAP.md         # Future research directions
├── MSD_PHASE7A_ARCHITECTURE_AUDIT.md
├── MSD_PHASE7A_ENGINEERING_READINESS.md
├── MSD_PHASE7A_MATHEMATICAL_AUDIT.md
├── MSD_PHASE7A_VALIDATION_AUDIT.md
├── MSD_PHASE7A_VERSIONING_AUDIT.md
├── MSD_PHASE7B_SCIENTIFIC_DESIGN.md
└── MSD_PHASE7_DESIGN_AUDIT.md
```

## Key Size Metrics

| File | Lines | Role |
|------|-------|------|
| `index.html` | ~36,134 | Entire application (HTML + CSS + JS inline) |
| `phase8-engine.js` | 323 | Phase 8 campaign engine |
| `server.js` | 145 | Static server + Phase 8 API |
| `mtf/src/**` | ~3,200 total | MTF/Njanja ES module tree |
| `src/index.js` | ~126 | Cloudflare Worker |

## Technology Stack

- **Runtime**: Browser (no build step, no bundler, no transpiler)
- **Server**: Node.js (stdlib `http` module, zero npm dependencies in production)
- **Module system**: Native ES modules (only for `mtf/src/`)
- **Database**: Browser IndexedDB (3 databases, managed by inline JS in `index.html`)
- **Backend**: Cloudflare Workers (OAuth + session management)
- **Deployment target**: GitHub Pages (frontend) + Cloudflare Workers (backend)
