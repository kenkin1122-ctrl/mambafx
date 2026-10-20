/**
 * src/bazu/crtTrade3m.js  (pure)
 * Decides whether a mapped CRT signal may be sent to the existing purchase choke point (choke3m.manual).
 * It never buys anything itself. Every refusal carries a reason. Defaults keep trading off.
 * CRT trading is DEMO-ONLY: a real or unknown account always refuses, so real-account behaviour is unchanged.
 * This path does not use crtExecutionAllowed / validation_status; the user-controlled switches replace that requirement.
 */
export const CRT_TRADE_CONFIG = Object.freeze({
  config_version: "crt-trade-1",
  max_signal_age_s: 120,     // seconds since the trigger candle closed
  cooldown_s: 300,           // per market, between CRT orders
  max_open_total: 2,         // open CRT trades across all markets
  max_open_per_market: 1,
  min_score: 0,              // optional performance guard: 0 = OFF
});

const finite = Number.isFinite;

/**
 * ctx: { pkg, nowEpoch, lastPrice, account:{connected,isReal}, running, switches, openCrtTrades:[{market}], lastOrderEpoch:{[symbol]:n}, tradedIds:Set, cfg }
 * Returns { ok:true } or { ok:false, reason }.
 */
export function crtTradeGate(ctx) {
  const { pkg, nowEpoch, lastPrice, account, switches, cfg = CRT_TRADE_CONFIG } = ctx;
  const no = (reason) => ({ ok: false, reason });
  if (!pkg) return no("no signal");
  if (!switches.isEnabled(pkg.symbol)) return no("CRT is switched off for this market");
  if (!switches.isTradeEnabled(pkg.symbol)) return no("crt_trade_enabled is off");
  if (pkg.variant !== "H1+" && !switches.isVariantTradeEnabled(pkg.variant)) return no(`trading is off for the ${pkg.variant} variant`);
  if (!ctx.running) return no("engine is not started");
  if (!account?.connected) return no("no Deriv account connected");
  if (account.isReal !== false) return no("CRT trading is demo-only");
  if (pkg.state !== "TRIGGERED") return no(`state ${pkg.state}, not TRIGGERED`);
  if (pkg.decision !== "CANDIDATE" || !pkg.lifetime?.duration) return no(`decision ${pkg.decision}${pkg.waitReason ? `: ${pkg.waitReason}` : ""}`);
  if (!finite(pkg.triggeredAt) || !finite(nowEpoch)) return no("missing trigger time");
  const age = nowEpoch - pkg.triggeredAt;
  if (age < 0 || age > cfg.max_signal_age_s) return no(`signal is ${Math.round(age)}s old (limit ${cfg.max_signal_age_s}s)`);
  if (ctx.tradedIds?.has(pkg.crtId)) return no("already traded");
  if (cfg.min_score > 0 && !(pkg.score >= cfg.min_score)) return no(`score ${pkg.score} below guard ${cfg.min_score}`);
  if (!finite(lastPrice)) return no("no current price");
  const rise = pkg.direction === "Rise";
  if (rise ? lastPrice <= pkg.invalidation : lastPrice >= pkg.invalidation) return no("price is beyond the invalidation level");
  if (rise ? lastPrice >= pkg.target : lastPrice <= pkg.target) return no("target already reached; no room left");
  const open = ctx.openCrtTrades || [];
  if (open.length >= cfg.max_open_total) return no(`${open.length} CRT trades already open (cap ${cfg.max_open_total})`);
  if (open.filter((t) => t.market === pkg.symbol).length >= cfg.max_open_per_market) return no(`a CRT trade is already open on ${pkg.symbol}`);
  const last = ctx.lastOrderEpoch?.[pkg.symbol];
  if (finite(last) && nowEpoch - last < cfg.cooldown_s) return no(`cooldown: ${Math.round(cfg.cooldown_s - (nowEpoch - last))}s left on ${pkg.symbol}`);
  return { ok: true };
}

/** Live version of the manual checklist: each step is derived from real state. Never changes any switch. */
export function crtChecklist({ switches, account, running, signalCount = 0, tradeLog = [], executedCrtTrades = 0 }) {
  const snap = switches.snapshot();
  const demo = !!account?.connected && account.isReal === false;
  const refused = tradeLog.filter((x) => !x.ok);
  const steps = [
    { id: "default_off", label: "Trading is OFF until you enable it", done: !snap.crt_trade_enabled || executedCrtTrades > 0 || tradeLog.length > 0, hint: "crt_trade_enabled starts OFF on every load" },
    { id: "demo", label: "Demo account connected", done: demo, hint: account?.connected ? "connected account is not demo" : "connect a Demo account" },
    { id: "running", label: "Engine started", done: !!running, hint: "press Start" },
    { id: "signals", label: "CRT signals detected", done: signalCount > 0, hint: "waiting for a scan to find a triggered setup" },
    { id: "trade_on", label: "crt_trade_enabled turned on (demo only)", done: !!snap.crt_trade_enabled, hint: "your decision; the app never enables it" },
    { id: "attempts", label: "Trade attempts logged", done: tradeLog.length > 0, hint: refused[0] ? `last refusal: ${refused[refused.length - 1].reason}` : "none yet" },
    { id: "executed", label: "A CRT trade executed and shows in Performance log", done: executedCrtTrades > 0, hint: "needs a fresh signal inside the age limit" },
  ];
  const next = steps.find((s) => !s.done);
  return { steps, next: next ? next.id : null, complete: !next };
}