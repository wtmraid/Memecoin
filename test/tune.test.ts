import { describe, expect, it } from 'vitest';
import { StrategySchema } from '../src/config/strategy.js';
import { choose, DEFAULT_GRID, expandGrid, replay, walkForward, withExit, type Candidate, type TuneSignal } from '../src/backtest/tune.js';

const S = StrategySchema.parse({ paper: { latencyMs: 0 } });
const MIN = 60_000;

/** Price path from (minute, multiple) points, sampled every 5 s with linear interpolation. */
function path(ts0: number, pts: [number, number][]): { ts: number; price: number }[] {
  const out: { ts: number; price: number }[] = [];
  for (let k = 0; k < pts.length - 1; k++) {
    const [m0, p0] = pts[k]!;
    const [m1, p1] = pts[k + 1]!;
    for (let t = m0 * MIN; t < m1 * MIN; t += 5000) out.push({ ts: ts0 + t, price: 1e-7 * (p0 + ((p1 - p0) * (t - m0 * MIN)) / ((m1 - m0) * MIN)) });
  }
  const [mL, pL] = pts[pts.length - 1]!;
  out.push({ ts: ts0 + mL * MIN, price: 1e-7 * pL });
  return out;
}
const sig = (i: number, score: number, pts: [number, number][], emergencyMin: number | null = null): TuneSignal => {
  const ts = i * 3600_000;
  return { id: `s${i}`, ts, mode: 'SNIPE', score, shadow: score < 65, entryPrice: 1e-7, emergencyTs: emergencyMin === null ? null : ts + emergencyMin * MIN, path: path(ts, pts) };
};

describe('replay', () => {
  it('runner: TP1 at 2x then trail captures most of a 4x move', () => {
    const pnl = replay(sig(0, 80, [[0, 1], [5, 2], [10, 4], [20, 2.5]]), S)!;
    expect(pnl).toBeGreaterThan(100);
  });
  it('rug: the emergency exit sells everything at the warning, before the crash', () => {
    const withWarn = replay(sig(0, 80, [[0, 1], [3, 1.3], [4, 0.05]], 3), S)!;
    const noWarn = replay(sig(0, 80, [[0, 1], [3, 1.3], [4, 0.05]]), S)!;
    expect(withWarn).toBeGreaterThan(0);
    expect(withWarn).toBeGreaterThan(noWarn);
  });
  it('missed entry (ran past the chase limit) is not a trade', () => {
    const s = { ...sig(0, 80, [[0, 1], [1, 2]]), path: [{ ts: 0, price: 1.5e-7 }] };
    expect(replay(s, S)).toBeNull();
  });
  it('withExit only changes the exit fields', () => {
    const x = withExit(S, { stopLossPct: 20, tp1Multiple: 3, tp1SellPct: 33, trailingStopPct: 20, timeStopMin: 15 });
    expect(x.exit).toMatchObject({ stopLossPct: 20, tp1Multiple: 3, tp2Multiple: 4.5 });
    expect(x.paper).toEqual(S.paper);
  });
});

describe('choosing settings', () => {
  it('finds the score bar that separates winners from losers', () => {
    // high scores run to 3x, low scores bleed out
    const signals = Array.from({ length: 80 }, (_, i) =>
      i % 2 ? sig(i, 80, [[0, 1], [5, 2.2], [10, 3.2], [30, 2]]) : sig(i, 55, [[0, 1], [10, 0.6], [40, 0.5]]),
    );
    const s = withExit(S, { stopLossPct: 30, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 30 });
    const c: Candidate = { exit: { stopLossPct: 30, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 30 }, pnl: signals.map((x) => replay(x, s)) };
    const r = choose(signals, [c], signals.map((_, i) => i), DEFAULT_GRID.minScore, 20)!;
    expect(r.pick.minScore.SNIPE).toBeGreaterThan(55);
    expect(r.train.mean).toBeGreaterThan(50);
  });

  it('uses only training data (no lookahead)', () => {
    const early = Array.from({ length: 40 }, (_, i) => sig(i, 80, [[0, 1], [10, 0.5]])); // all losers
    const late = Array.from({ length: 40 }, (_, i) => sig(100 + i, 80, [[0, 1], [5, 3]])); // all winners
    const all = [...early, ...late];
    const s = withExit(S, { stopLossPct: 30, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 30 });
    const c: Candidate = { exit: { stopLossPct: 30, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 30 }, pnl: all.map((x) => replay(x, s)) };
    const onEarly = choose(all, [c], early.map((_, i) => i), DEFAULT_GRID.minScore, 20)!;
    expect(onEarly.train.mean).toBeLessThan(0); // it can't see the profitable future
  });
});

describe('walk-forward', () => {
  it('refuses to recommend anything with too little data', () => {
    const r = walkForward([sig(0, 80, [[0, 1], [5, 2]])], S, { exit: { stopLossPct: 30, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 30 }, minScore: { SNIPE: 65, SCALP: 70 } });
    expect(r.recommend).toBe(false);
    expect(r.reason).toMatch(/need at least 60/);
  });

  it('recommends a tighter stop when every loser keeps bleeding, and proves it out-of-sample', () => {
    // Losers fall straight to 0.5x; winners dip −15% then run to 2.5x. Stop −20% beats −40%.
    const signals = Array.from({ length: 120 }, (_, i) =>
      i % 3 === 0 ? sig(i, 75, [[0, 1], [2, 0.85], [8, 2.5], [20, 1.8]]) : sig(i, 75, [[0, 1], [3, 0.78], [6, 0.5], [60, 0.45]]),
    );
    const grid = { ...DEFAULT_GRID, stopLossPct: [20, 40], tp1Multiple: [2], tp1SellPct: [50], trailingStopPct: [30], timeStopMin: [60], minScore: [65] };
    const current = { exit: { stopLossPct: 40, tp1Multiple: 2, tp1SellPct: 50, trailingStopPct: 30, timeStopMin: 60 }, minScore: { SNIPE: 65, SCALP: 70 } };
    const r = walkForward(signals, S, current, grid, 10);
    expect(r.final!.exit.stopLossPct).toBe(20);
    expect(r.folds).toHaveLength(3);
    for (const f of r.folds) expect(f.testMean).toBeGreaterThan(f.baselineMean);
    expect(r.recommend).toBe(true);
  });

  it('grid covers 324 exit combinations by default', () => expect(expandGrid(DEFAULT_GRID)).toHaveLength(324));
});
