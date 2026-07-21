# Module Dependencies — Market State Discovery Laboratory

## Dependency Graph: mtf/src/ Module Tree

The MTF ES module tree is loaded as `<script type="module" src="mtf/src/index.js">`. All imports use relative paths within the tree. No external npm packages are imported in the browser.

```
mtf/src/index.js (entry point)
├── ./core/AppState.js
│   └── (no imports — singleton)
├── ./core/EventBus.js
│   └── (no imports — singleton)
├── ./core/HistoryManager.js
│   └── ./core/EventBus.js
├── ./core/debugRecorder.js
│   └── ./core/EventBus.js
├── ./core/constants.js
│   └── (no imports — constants only)
│
├── ./charts/Panel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./utils/color.js
├── ./charts/socket.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./charts/Panel.js
├── ./charts/render.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./drawing/render.js
│   └── ./charts/Panel.js
├── ./charts/zoomManager.js
│   ├── ./core/AppState.js
│   └── ./core/EventBus.js
├── ./charts/replayManager.js
│   ├── ./core/AppState.js
│   └── ./core/EventBus.js
├── ./charts/mtfDashboard.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./analysis/structurePatterns.js
│   └── ./analysis/swingPoints.js
│
├── ./drawing/interaction.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./core/HistoryManager.js
│   ├── ./drawing/model.js
│   └── ./drawing/render.js
├── ./drawing/model.js
│   ├── ./core/AppState.js
│   └── ./drawing/objects/factory.js
│       └── ./drawing/objects/*.js (all shape classes)
├── ./drawing/render.js
│   ├── ./core/AppState.js
│   └── ./drawing/renderHelpers.js
├── ./drawing/renderHelpers.js
│   └── ./core/AppState.js
├── ./drawing/candleMarking.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./drawing/ids.js
│
├── ./ui/toolbar.js
│   ├── ./core/AppState.js
│   └── ./core/EventBus.js
├── ./ui/header.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./core/constants.js
├── ./ui/analysisPanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./analysis/patternEngine.js
│   ├── ./analysis/similarity.js
│   └── ./drawing/renderHelpers.js
├── ./ui/decompPanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./drawing/renderHelpers.js
├── ./ui/drawingManager.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./drawing/renderHelpers.js
├── ./ui/propertiesPanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./core/constants.js
├── ./ui/smartIntelligencePanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./analysis/patternEngine.js
│   └── ./analysis/historicalSimilarity.js
├── ./ui/workspacePanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./utils/dom.js
├── ./ui/zonePresets.js
│   ├── ./core/AppState.js
│   └── ./core/EventBus.js
├── ./ui/replayControls.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./utils/color.js
├── ./ui/floatingPanel.js
│   └── ./drawing/renderHelpers.js
├── ./ui/candleCommentaryPanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./ai/candleCommentary.js
├── ./ui/fiveMinCommentaryPanel.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./ai/fiveMinCommentary.js
│
├── ./ai/continuousLearning.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   ├── ./analysis/patternEngine.js
│   └── ./analysis/similarity.js
├── ./ai/candleCommentary.js
│   ├── ./core/AppState.js
│   ├── ./analysis/candlestickPatterns.js
│   ├── ./analysis/structurePatterns.js
│   └── ./ai/narrativeEngine.js
├── ./ai/fiveMinCommentary.js
│   ├── ./core/AppState.js
│   ├── ./analysis/candlestickPatterns.js
│   └── ./ai/narrativeEngine.js
│
├── ./analysis/patternEngine.js
│   ├── ./analysis/statistics.js
│   ├── ./analysis/candleGenome.js
│   └── ./analysis/candlestickPatterns.js
├── ./analysis/similarity.js
│   └── ./analysis/statistics.js
├── ./analysis/historicalSimilarity.js
│   ├── ./analysis/statistics.js
│   └── ./analysis/similarity.js
├── ./analysis/structurePatterns.js
│   ├── ./analysis/swingPoints.js
│   └── ./analysis/swingLabels.js
├── ./analysis/swingPoints.js
│   └── (no imports)
├── ./analysis/swingLabels.js
│   └── ./analysis/swingPoints.js
│
├── ./workspace/storage.js
│   ├── ./core/AppState.js
│   └── ./drawing/model.js
├── ./workspace/workspaceManager.js
│   ├── ./core/AppState.js
│   ├── ./core/EventBus.js
│   └── ./workspace/storage.js
│
└── ./orderflow/proxy.js
    └── ./core/AppState.js
```

## Server-Side Dependencies

### server.js
```
Node.js built-ins only:
  http, fs, path, url
  
Lazy-loaded at first API call:
  ./phase8-engine (require)
```

### phase8-engine.js
```
Node.js built-ins only:
  fs, path, vm, crypto
  
Runtime extraction from:
  ./index.html  (lines [4360, 12460) — MSD function library)
```

## External Dependencies (Runtime, not npm)

| Service | URL | Purpose |
|---------|-----|---------|
| Deriv WebSocket | `wss://ws.binaryws.com/websockets/v3` | Live tick feed, trading |
| Cloudflare Worker | `https://mambafx-backend.kenkin1122.workers.dev` | OAuth session management |

## npm / package.json

There is no `package.json` in this project. Server-side code (`server.js`, `phase8-engine.js`) uses only Node.js built-in modules. No `npm install` is required to run the server.

## Import Resolution Rules

All `mtf/src/` imports use **relative paths** (`./` or `../`). All imports resolve to `.js` files — there are no implicit extensions in the module graph. The module graph has been verified: `ALL IMPORTS RESOLVED OK` (no missing files, no circular dependencies that would cause issues).
