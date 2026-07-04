/**
 * core/constants.js
 * Shared, immutable configuration for the MTF Structure module.
 * Ported verbatim from the working single-file build — values unchanged.
 */

export const APP_ID = 1089;

export const WS_ENDPOINTS = [
  `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`,
  `wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`,
];

export const SYMBOLS = {
  "R_10": "Volatility 10", "R_25": "Volatility 25", "R_50": "Volatility 50", "R_75": "Volatility 75", "R_100": "Volatility 100",
  "1HZ10V": "Volatility 10 (1s)", "1HZ25V": "Volatility 25 (1s)", "1HZ50V": "Volatility 50 (1s)",
  "1HZ75V": "Volatility 75 (1s)", "1HZ100V": "Volatility 100 (1s)",
};

export const HTF_TFS = [
  { key: "1800", g: 1800, label: "30 min" },
  { key: "3600", g: 3600, label: "1 Hour" },
  { key: "7200", g: 7200, label: "2 Hour" },
  { key: "14400", g: 14400, label: "4 Hour" },
  { key: "28800", g: 28800, label: "8 Hour" },
];

export const LTF_TFS = [
  { key: "tick1", g: "tick1", label: "1 Tick Line" },
  { key: "tick10", g: "tick10", label: "10 Tick" },
  { key: "60", g: 60, label: "1 min" },
  { key: "300", g: 300, label: "5 min" },
  { key: "900", g: 900, label: "15 min" },
];

export const CANDLE_COUNT = 200;
export const HANDLE_R = 5;
export const HIT_PX = 7;
export const COLORS = ["#4fb2ff", "#1fdf9b", "#ff4d6a", "#ffc857", "#a78bfa", "#fb923c", "#f472b6", "#94a3b8", "#ffffff"];

/**
 * The 10 simultaneous timeframes for the new Multi-Timeframe Dashboard —
 * distinct from HTF_TFS/LTF_TFS above, which remain unchanged and still
 * drive the existing 2-panel chart view's dropdown pickers. This list is
 * fixed and ordered (fastest to slowest), matching the requested
 * 1m|3m|5m|10m|30m|1h|4h|8h|12h|1d layout exactly. Each entry gets its own
 * live, independently-updating Panel instance — see charts/mtfDashboard.js.
 */
export const MTF_DASHBOARD_TFS = [
  { key: "h12", g: 43200, label: "12h" },
  { key: "h8", g: 28800, label: "8h" },
  { key: "h4", g: 14400, label: "4h" },
  { key: "h2", g: 7200, label: "2h" },
  { key: "h1", g: 3600, label: "1h" },
  { key: "m30", g: 1800, label: "30m" },
  { key: "m15", g: 900, label: "15m" },
  { key: "m10", g: 600, label: "10m" },
  { key: "m5", g: 300, label: "5m" },
  { key: "m1", g: 60, label: "1m" },
];

/** localStorage key prefix for per-symbol drawing persistence (Phase 1: unchanged from v1; Phase 16 will replace with named workspaces). */
export const STORAGE_PREFIX = "mtf_drawings_v2_";

/**
 * Phase 5 metadata vocabulary. These are DATA values, not classes — a
 * Supply zone and a Demand zone are both just a RectangleDrawing with a
 * different `zoneType`, per the explicit "don't create a class per zone
 * type" instruction. The fuller preset list here (Breaker/Mitigation/
 * Opening Range) is what Phase 10's quick-apply buttons will offer; the
 * underlying field support belongs in this phase regardless of when the
 * one-click UI for it lands.
 */
export const ZONE_TYPES = [
  { key: "supply", label: "Supply", color: "#ff4d6a" },
  { key: "demand", label: "Demand", color: "#1fdf9b" },
  { key: "support", label: "Support", color: "#4fb2ff" },
  { key: "resistance", label: "Resistance", color: "#fb7185" },
  { key: "consolidation", label: "Consolidation", color: "#94a3b8" },
  { key: "liquidity", label: "Liquidity Zone", color: "#a78bfa" },
  { key: "fvg", label: "Fair Value Gap", color: "#ffc857" },
  { key: "orderblock", label: "Order Block", color: "#fb923c" },
  { key: "breaker", label: "Breaker Block", color: "#f472b6" },
  { key: "mitigation", label: "Mitigation Block", color: "#2dd4bf" },
  { key: "openingrange", label: "Opening Range", color: "#818cf8" },
];

export const ZONE_STATUSES = [
  { key: "active", label: "Active" },
  { key: "tested", label: "Tested" },
  { key: "mitigated", label: "Mitigated" },
  { key: "broken", label: "Broken" },
];

export const IMPORTANCE_LEVELS = [
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
];
