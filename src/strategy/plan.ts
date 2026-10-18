import type { StrategySettings } from '../config/strategy.js';
import type { TokenFacts } from '../filters/facts.js';

export type Mode = 'SNIPE' | 'SCALP';

export interface ModeDecision {
  mode: Mode | null;
  /** Why it qualified, or why not (first blocking reason). */
  reasons: string[];
}

/**
 * SNIPE: young token (< 15 min) whose launch already shows real, distributed demand.
 * We deliberately wait for the first ~minute and a minimum number of unique buyers —
 * the very first seconds are where bundles, snipers and dev dumps happen, and the
 * safety metrics are meaningless before trades exist.
 *
 * SCALP: older token breaking out on 5m volume with buyers in control, but not on a
 * vertical candle (chasing those is how most scalps lose).
 */
export function decideMode(f: TokenFacts, s: StrategySettings): ModeDecision {
  const age = f.ageSec;
  if (age === null) return { mode: null, reasons: ['age unknown'] };
  const m = f.momentum;

  if (age <= s.snipe.maxAgeSec) {
    const why: string[] = [];
    if ((m.uniqueBuyersTotal ?? 0) < s.snipe.minUniqueBuyers) why.push(`${m.uniqueBuyersTotal ?? 0}/${s.snipe.minUniqueBuyers} unique buyers`);
    if (f.onCurve && f.curveProgress !== null) {
      if (f.curveProgress < s.snipe.minCurveProgress) why.push(`curve ${(f.curveProgress * 100).toFixed(0)}% < ${s.snipe.minCurveProgress * 100}%`);
      if (f.curveProgress > s.snipe.maxCurveProgress) why.push(`curve ${(f.curveProgress * 100).toFixed(0)}% — too close to migration`);
    }
    const ratio = m.buys2m !== null && m.sells2m !== null ? m.buys2m / Math.max(1, m.sells2m) : null;
    if (ratio !== null && ratio < s.snipe.minBuySellRatio2m) why.push(`2m buy/sell ${ratio.toFixed(2)} < ${s.snipe.minBuySellRatio2m}`);
    if (why.length) return { mode: null, reasons: why };
    return {
      mode: 'SNIPE',
      reasons: [
        `${m.uniqueBuyersTotal} unique buyers in ${Math.round(age / 60)}m`,
        ...(f.curveProgress !== null ? [`curve ${(f.curveProgress * 100).toFixed(0)}%`] : []),
        ...(ratio !== null ? [`2m buy/sell ${ratio.toFixed(1)}`] : []),
      ],
    };
  }

  if (age >= s.scalp.minAgeSec) {
    const c = s.scalp;
    const why: string[] = [];
    if ((f.liquidityUsd ?? 0) < c.minLiquidityUsd) why.push(`liquidity $${Math.round(f.liquidityUsd ?? 0)} < $${c.minLiquidityUsd}`);
    const v = m.volume5mUsd ?? 0;
    if (v < c.min5mVolumeUsd) why.push(`5m volume $${Math.round(v)} < $${c.min5mVolumeUsd}`);
    const x = m.volumeAvg5mUsd ? v / m.volumeAvg5mUsd : null;
    if (x === null || x < c.volumeBreakoutX) why.push(`no volume breakout (${x === null ? 'n/a' : `${x.toFixed(1)}x`} < ${c.volumeBreakoutX}x)`);
    const ch = m.priceChange5mPct;
    if (ch === null || ch < c.minPriceChange5mPct) why.push(`5m change ${ch?.toFixed(1) ?? 'n/a'}% < ${c.minPriceChange5mPct}%`);
    else if (ch > c.maxPriceChange5mPct) why.push(`5m +${ch.toFixed(0)}% — vertical, don't chase`);
    const r = m.buys5m !== null && m.sells5m !== null ? m.buys5m / Math.max(1, m.sells5m) : null;
    if (r === null || r < c.minBuySellRatio5m) why.push(`5m buy/sell ${r?.toFixed(2) ?? 'n/a'} < ${c.minBuySellRatio5m}`);
    if (why.length) return { mode: null, reasons: why };
    return { mode: 'SCALP', reasons: [`5m volume ${x!.toFixed(1)}x hourly avg`, `+${ch!.toFixed(1)}% (5m)`, `buy/sell ${r!.toFixed(1)}`] };
  }
  return { mode: null, reasons: ['between snipe and scalp windows'] };
}

export interface TradePlan {
  /** Prices in SOL per token (the unit the monitor tracks). */
  entryPrice: number;
  maxEntryPrice: number;
  stopPrice: number;
  tp1Price: number;
  tp2Price: number;
  /** Same levels as market cap in USD when SOL/USD and mcap are known. */
  mcap?: { entry: number; maxEntry: number; stop: number; tp1: number; tp2: number };
  lines: string[];
}

/** Mechanical entry/exit rule set for a signal. A rule, not advice. */
export function buildPlan(entryPrice: number, entryMcapUsd: number | null, s: StrategySettings): TradePlan {
  const e = s.exit;
  const levels = {
    entry: 1,
    maxEntry: 1 + s.entry.maxChasePct / 100,
    stop: 1 - e.stopLossPct / 100,
    tp1: e.tp1Multiple,
    tp2: e.tp2Multiple,
  };
  const mcap = entryMcapUsd
    ? (Object.fromEntries(Object.entries(levels).map(([k, v]) => [k, entryMcapUsd * v])) as TradePlan['mcap'])
    : undefined;
  const at = (k: keyof typeof levels) => (mcap ? `MC ${usd(mcap[k])}` : `${levels[k]}x`);
  return {
    entryPrice,
    maxEntryPrice: entryPrice * levels.maxEntry,
    stopPrice: entryPrice * levels.stop,
    tp1Price: entryPrice * levels.tp1,
    tp2Price: entryPrice * levels.tp2,
    mcap,
    lines: [
      `Entry: now, up to ${at('maxEntry')} (+${s.entry.maxChasePct}%). Above that, don't chase; wait for a pullback.`,
      `Stop-loss: −${e.stopLossPct}% → ${at('stop')}`,
      `TP1: ${e.tp1Multiple}x (${at('tp1')}) → sell ${e.tp1SellPct}% (gets your initial back)`,
      `TP2: ${e.tp2Multiple}x (${at('tp2')}) → sell ${e.tp2SellPct}%`,
      `Rest: trailing stop ${e.trailingStopPct}% below the peak after TP1`,
      `Time stop: not +${e.timeStopMinGainPct}% after ${e.timeStopMin} min → exit`,
      `Emergency exit: dev sells ≥${e.devSellPct}% · bundle wallets dump ≥${e.bundleExodusPct}% · liquidity −${e.liquidityDropPct}% · sell wall`,
    ],
  };
}

export function usd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
