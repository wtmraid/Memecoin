import type { StrategySettings } from '../config/strategy.js';
import { applyExits, evaluateExits, type PositionState } from '../strategy/exits.js';
import { PaperPosition } from './paper.js';

/**
 * Walk-forward tuning of the score bar and exit rules from logged signals.
 *
 * - Every live AND shadow signal has its real price path stored, so we can replay
 *   "what if the stop were 20% instead of 30%" or "what if we had alerted at score 60".
 * - No lookahead: settings are chosen on an older window and judged only on the next,
 *   unseen window. A change is recommended only if it wins out-of-sample.
 */

export interface TuneSignal {
  id: string;
  ts: number;
  mode: 'SNIPE' | 'SCALP';
  score: number;
  shadow: boolean;
  entryPrice: number;
  /** First rug-warning time (dev dump, bundle exodus, liquidity pull, sell wall). */
  emergencyTs: number | null;
  path: { ts: number; price: number }[];
}

export interface ExitParams {
  stopLossPct: number;
  tp1Multiple: number;
  tp1SellPct: number;
  trailingStopPct: number;
  timeStopMin: number;
}

export interface Grid {
  stopLossPct: number[];
  tp1Multiple: number[];
  tp1SellPct: number[];
  trailingStopPct: number[];
  timeStopMin: number[];
  minScore: number[];
}

/** Never recommend a change judged on fewer unseen trades than this. */
export const MIN_OOS_TRADES = 20;

export const DEFAULT_GRID: Grid = {
  stopLossPct: [20, 30, 40],
  tp1Multiple: [1.5, 2, 2.5, 3],
  tp1SellPct: [33, 50, 75],
  trailingStopPct: [20, 30, 40],
  timeStopMin: [15, 30, 60],
  minScore: [50, 55, 60, 65, 70, 75, 80, 85],
};

export function withExit(base: StrategySettings, x: ExitParams): StrategySettings {
  return {
    ...base,
    exit: { ...base.exit, ...x, tp2Multiple: Math.max(x.tp1Multiple * 1.5, base.exit.tp2Multiple), tp2SellPct: base.exit.tp2SellPct },
  };
}

/**
 * Replay one signal under settings `s`. Same exit engine and fill model as live.
 * Returns paper P&L %, or null when the entry window was missed (no trade).
 */
export function replay(sig: TuneSignal, s: StrategySettings): number | null {
  const startAt = sig.ts + s.paper.latencyMs;
  const i0 = sig.path.findIndex((p) => p.ts >= startAt);
  if (i0 < 0) return null;
  const entryPx = sig.path[i0]!.price;
  if (entryPx > sig.entryPrice * (1 + s.entry.maxChasePct / 100)) return null;
  const paper = new PaperPosition(s.paper);
  paper.buy(sig.path[i0]!.ts, entryPx);
  let st: PositionState = {
    entryPrice: sig.entryPrice,
    entryTs: sig.ts,
    peakPrice: sig.entryPrice,
    remainingPct: 100,
    tp1Done: false,
    tp2Done: false,
    migrationDone: false,
    devTokensAtEntry: null,
    bundleTokensAtEntry: null,
    belowStopSince: null,
    stopPrice: sig.entryPrice * (1 - s.exit.stopLossPct / 100),
  };
  let last = entryPx;
  for (let i = i0; i < sig.path.length && st.remainingPct > 0; i++) {
    const { ts, price } = sig.path[i]!;
    last = price;
    if (sig.emergencyTs !== null && ts >= sig.emergencyTs) {
      paper.sell(ts, st.remainingPct, price, 'emergency');
      st = { ...st, remainingPct: 0 };
      break;
    }
    const actions = evaluateExits(st, { now: ts, price }, s);
    st = applyExits(st, actions, price, ts);
    for (const a of actions) paper.sell(ts, a.sellPct, price, a.reason);
  }
  return paper.pnlPct(st.remainingPct, last);
}

export interface Candidate {
  exit: ExitParams;
  /** P&L per signal (null = missed), aligned with the signals array. */
  pnl: (number | null)[];
}

export function expandGrid(g: Grid): ExitParams[] {
  const out: ExitParams[] = [];
  for (const stopLossPct of g.stopLossPct)
    for (const tp1Multiple of g.tp1Multiple)
      for (const tp1SellPct of g.tp1SellPct)
        for (const trailingStopPct of g.trailingStopPct)
          for (const timeStopMin of g.timeStopMin) out.push({ stopLossPct, tp1Multiple, tp1SellPct, trailingStopPct, timeStopMin });
  return out;
}

export interface Pick {
  exit: ExitParams;
  minScore: Record<'SNIPE' | 'SCALP', number>;
}

interface Agg {
  n: number;
  mean: number;
  /** mean − standard error: rewards settings that are good AND consistent. */
  lower: number;
}

function agg(xs: number[]): Agg {
  const n = xs.length;
  if (!n) return { n: 0, mean: 0, lower: -Infinity };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean, lower: mean - sd / Math.sqrt(n) };
}

/** P&L of the trades a pick would have taken among `idx`. */
export function picked(signals: TuneSignal[], c: Candidate, idx: number[], minScore: Pick['minScore']): number[] {
  const out: number[] = [];
  for (const i of idx) {
    const s = signals[i]!;
    const v = c.pnl[i];
    if (v !== null && v !== undefined && s.score >= minScore[s.mode]) out.push(v);
  }
  return out;
}

/** Best exit settings + per-mode score bar on the given (training) indices. */
export function choose(
  signals: TuneSignal[],
  cands: Candidate[],
  idx: number[],
  scores: number[],
  minTrades: number,
  fallback: Pick['minScore'] = { SNIPE: scores[0]!, SCALP: scores[0]! },
): { pick: Pick; train: Agg } | null {
  let best: { pick: Pick; train: Agg } | null = null;
  for (const c of cands) {
    const minScore = { ...fallback };
    for (const mode of ['SNIPE', 'SCALP'] as const) {
      // No data for a mode → keep the current bar instead of inventing one.
      let bestS = { s: fallback[mode], lower: -Infinity };
      for (const sc of scores) {
        const xs = idx.filter((i) => signals[i]!.mode === mode && signals[i]!.score >= sc).map((i) => c.pnl[i]).filter((v): v is number => v !== null && v !== undefined);
        const a = agg(xs);
        if (a.n >= Math.max(5, Math.floor(minTrades / 2)) && a.lower > bestS.lower) bestS = { s: sc, lower: a.lower };
      }
      minScore[mode] = bestS.s;
    }
    const a = agg(picked(signals, c, idx, minScore));
    if (a.n >= minTrades && (!best || a.lower > best.train.lower)) best = { pick: { exit: c.exit, minScore }, train: a };
  }
  return best;
}

export interface Fold {
  trainN: number;
  testN: number;
  pick: Pick;
  trainMean: number;
  testMean: number;
  testTrades: number;
  baselineMean: number;
  baselineTrades: number;
}

export interface TuneResult {
  folds: Fold[];
  final: Pick | null;
  recommend: boolean;
  reason: string;
}

/**
 * Expanding-window walk-forward: train on the oldest 50/67/83%, test on the next slice.
 * Recommends the final (all-data) pick only if tuned beats current settings
 * out-of-sample on average AND is profitable out-of-sample in most folds.
 */
export function walkForward(
  signalsIn: TuneSignal[],
  base: StrategySettings,
  current: Pick,
  grid: Grid = DEFAULT_GRID,
  minTrades = 20,
): TuneResult {
  const signals = [...signalsIn].sort((a, b) => a.ts - b.ts);
  const n = signals.length;
  if (n < 60) return { folds: [], final: null, recommend: false, reason: `only ${n} finished signals — need at least 60 before tuning means anything` };

  const exits = expandGrid(grid);
  const currentExit = exits.find((e) => JSON.stringify(e) === JSON.stringify(current.exit));
  const all = currentExit ? exits : [...exits, current.exit];
  const cands: Candidate[] = all.map((exit) => {
    const s = withExit(base, exit);
    return { exit, pnl: signals.map((sig) => replay(sig, s)) };
  });
  const baseCand = cands.find((c) => JSON.stringify(c.exit) === JSON.stringify(current.exit))!;

  const cuts = [0.5, 0.67, 0.83, 1].map((f) => Math.floor(n * f));
  const folds: Fold[] = [];
  for (let k = 0; k < 3; k++) {
    const train = Array.from({ length: cuts[k]! }, (_, i) => i);
    const test = Array.from({ length: cuts[k + 1]! - cuts[k]! }, (_, i) => cuts[k]! + i);
    const ch = choose(signals, cands, train, grid.minScore, minTrades, current.minScore);
    if (!ch) continue;
    const cand = cands.find((c) => c.exit === ch.pick.exit)!;
    const t = agg(picked(signals, cand, test, ch.pick.minScore));
    const b = agg(picked(signals, baseCand, test, current.minScore));
    folds.push({
      trainN: train.length,
      testN: test.length,
      pick: ch.pick,
      trainMean: ch.train.mean,
      testMean: t.mean,
      testTrades: t.n,
      baselineMean: b.mean,
      baselineTrades: b.n,
    });
  }
  const final = choose(signals, cands, signals.map((_, i) => i), grid.minScore, minTrades, current.minScore)?.pick ?? null;
  if (!folds.length || !final) return { folds, final, recommend: false, reason: 'not enough trades per window to compare settings' };
  const avgGain = folds.reduce((a, f) => a + (f.testMean - f.baselineMean), 0) / folds.length;
  const profitable = folds.filter((f) => f.testMean > 0 && f.testTrades > 0).length;
  const oosTrades = folds.reduce((a, f) => a + f.testTrades, 0);
  const recommend = avgGain > 0 && profitable >= Math.ceil(folds.length * 0.66) && oosTrades >= MIN_OOS_TRADES;
  return {
    folds,
    final,
    recommend,
    reason: recommend
      ? `tuned settings beat current by ${avgGain.toFixed(1)} pts/trade on unseen data, profitable in ${profitable}/${folds.length} test windows`
      : oosTrades < MIN_OOS_TRADES && avgGain > 0
        ? `looks better, but only ${oosTrades} unseen trades to judge by (need ${MIN_OOS_TRADES}) — keep current and collect more data`
        : `tuned settings did not reliably beat current on unseen data (avg ${avgGain >= 0 ? '+' : ''}${avgGain.toFixed(1)} pts/trade, profitable in ${profitable}/${folds.length}) — keep current`,
  };
}
